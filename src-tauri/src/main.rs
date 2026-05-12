// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command as StdCommand, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const PROOF_SERVER_HOST: &str = "127.0.0.1";
const PROOF_SERVER_PORT: u16 = 6300;
const PROOF_SERVER_URL: &str = "http://localhost:6300";
const PROOF_SERVER_STARTUP_GRACE_SECONDS: u64 = 10;
const WATCHDOG_INTERVAL_SECONDS: u64 = 2;
const DEFAULT_INDEXER_URL: &str = "https://indexer.preprod.midnight.network/api/v4/graphql";
const DEFAULT_INDEXER_WS_URL: &str = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";
const DEFAULT_NODE_URL: &str = "https://rpc.preprod.midnight.network";
const DEFAULT_NODE_WS_URL: &str = "wss://rpc.preprod.midnight.network/ws";

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum MidnightNetwork {
    Preprod,
    Mainnet,
}

impl Default for MidnightNetwork {
    fn default() -> Self {
        Self::Preprod
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct AppConfig {
    network: MidnightNetwork,
    endpoints: NetworkEndpoints,
    wallets: Vec<WalletConfig>,
    connected_wallet_id: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            network: MidnightNetwork::default(),
            endpoints: NetworkEndpoints::default(),
            wallets: Vec::new(),
            connected_wallet_id: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct NetworkEndpoints {
    indexer_url: String,
    indexer_ws_url: String,
    node_url: String,
    node_ws_url: String,
}

impl Default for NetworkEndpoints {
    fn default() -> Self {
        Self {
            indexer_url: DEFAULT_INDEXER_URL.to_string(),
            indexer_ws_url: DEFAULT_INDEXER_WS_URL.to_string(),
            node_url: DEFAULT_NODE_URL.to_string(),
            node_ws_url: DEFAULT_NODE_WS_URL.to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WalletConfig {
    id: String,
    name: String,
    phrase: String,
    addresses: WalletAddresses,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WalletAddresses {
    unshielded: String,
    shielded: String,
    dust: String,
}

#[derive(Debug, Deserialize)]
struct AddWalletRequest {
    name: Option<String>,
    phrase: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEndpointsRequest {
    indexer_url: String,
    indexer_ws_url: String,
    node_url: String,
    node_ws_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofServerStatus {
    url: &'static str,
    online: bool,
    pid: Option<u32>,
    restarts: u64,
    last_error: Option<String>,
}

struct ProofServerSupervisor {
    child: Option<CommandChild>,
    last_started: Option<Instant>,
    last_error: Option<String>,
    restarts: u64,
}

struct WalletSyncSupervisor {
    child: Option<Child>,
    last_error: Option<String>,
    restarts: u64,
}

impl WalletSyncSupervisor {
    fn new() -> Self {
        Self {
            child: None,
            last_error: None,
            restarts: 0,
        }
    }

    fn ensure_running(&mut self, app: &AppHandle) {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return,
                Ok(Some(status)) => {
                    self.last_error = Some(format!("wallet sync sidecar exited with {status}"));
                    self.child = None;
                }
                Err(error) => {
                    self.last_error = Some(error.to_string());
                    self.child = None;
                }
            }
        }

        self.restart(app);
    }

    fn restart(&mut self, app: &AppHandle) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }

        let config_path = match config_path(app) {
            Ok(path) => path,
            Err(error) => {
                self.last_error = Some(error);
                return;
            }
        };
        let cache_dir = match app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())
        {
            Ok(path) => path,
            Err(error) => {
                self.last_error = Some(error);
                return;
            }
        };
        let script_path = wallet_sync_script_path();
        let repo_root = repo_root_path();

        match StdCommand::new("node")
            .arg(&script_path)
            .arg("--config")
            .arg(&config_path)
            .arg("--cache-dir")
            .arg(&cache_dir)
            .current_dir(repo_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                pipe_child_output("wallet-sync", child.stdout.take(), false);
                pipe_child_output("wallet-sync", child.stderr.take(), true);
                self.child = Some(child);
                self.last_error = None;
                self.restarts += 1;
            }
            Err(error) => {
                self.child = None;
                self.last_error = Some(error.to_string());
            }
        }
    }
}

impl ProofServerSupervisor {
    fn new() -> Self {
        Self {
            child: None,
            last_started: None,
            last_error: None,
            restarts: 0,
        }
    }

    fn status(&self) -> ProofServerStatus {
        ProofServerStatus {
            url: PROOF_SERVER_URL,
            online: proof_server_is_online(),
            pid: self.child.as_ref().map(CommandChild::pid),
            restarts: self.restarts,
            last_error: self.last_error.clone(),
        }
    }

    fn ensure_running(&mut self, app: &AppHandle) {
        if proof_server_is_online() {
            self.last_error = None;
            return;
        }

        if self.last_started.is_some_and(|started| {
            started.elapsed() < Duration::from_secs(PROOF_SERVER_STARTUP_GRACE_SECONDS)
        }) {
            return;
        }

        self.restart(app);
    }

    fn restart(&mut self, app: &AppHandle) {
        if let Some(child) = self.child.take() {
            let _ = child.kill();
        }

        let data_dir = match proof_server_data_dir(app) {
            Ok(data_dir) => data_dir,
            Err(error) => {
                self.child = None;
                self.last_started = None;
                self.last_error = Some(error);
                return;
            }
        };

        match app
            .shell()
            .sidecar("midnight-proof-server")
            .and_then(|command| {
                command
                    .args(["--port", "6300", "--verbose"])
                    .current_dir(data_dir)
                    .spawn()
            }) {
            Ok((mut rx, child)) => {
                let pid = child.pid();
                self.child = Some(child);
                self.last_started = Some(Instant::now());
                self.last_error = None;
                self.restarts += 1;

                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            tauri_plugin_shell::process::CommandEvent::Stderr(line)
                            | tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                                let line = String::from_utf8_lossy(&line);
                                println!("[proof-server:{pid}] {}", line.trim_end());
                            }
                            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                                println!("[proof-server:{pid}] terminated: {payload:?}");
                                break;
                            }
                            _ => {}
                        }
                    }
                });
            }
            Err(error) => {
                self.child = None;
                self.last_started = None;
                self.last_error = Some(error.to_string());
            }
        }
    }
}

struct AppState {
    config_path: PathBuf,
    config: Mutex<AppConfig>,
    proof_server: Mutex<ProofServerSupervisor>,
    wallet_sync: Mutex<WalletSyncSupervisor>,
}

struct LoadedConfig {
    config: AppConfig,
    should_persist: bool,
}

#[tauri::command]
fn get_app_config(state: State<'_, Arc<AppState>>) -> AppConfig {
    state.config.lock().expect("config mutex poisoned").clone()
}

#[tauri::command]
fn set_network(
    network: MidnightNetwork,
    state: State<'_, Arc<AppState>>,
) -> Result<AppConfig, String> {
    let mut config = state.config.lock().map_err(|error| error.to_string())?;
    config.network = network;
    save_config(&state.config_path, &config)?;
    Ok(config.clone())
}

#[tauri::command]
fn set_network_endpoints(
    request: UpdateEndpointsRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AppConfig, String> {
    let endpoints = NetworkEndpoints {
        indexer_url: required_url("Indexer URL", request.indexer_url)?,
        indexer_ws_url: required_url("Indexer WebSocket URL", request.indexer_ws_url)?,
        node_url: required_url("Node URL", request.node_url)?,
        node_ws_url: required_url("Node WebSocket URL", request.node_ws_url)?,
    };

    let mut config = state.config.lock().map_err(|error| error.to_string())?;
    config.endpoints = endpoints;
    save_config(&state.config_path, &config)?;
    Ok(config.clone())
}

#[tauri::command]
fn add_wallet(
    request: AddWalletRequest,
    state: State<'_, Arc<AppState>>,
) -> Result<AppConfig, String> {
    let phrase = request.phrase.trim().to_string();
    if phrase.is_empty() {
        return Err("Wallet phrase is required".to_string());
    }

    let mut config = state.config.lock().map_err(|error| error.to_string())?;
    let wallet_number = config.wallets.len() + 1;
    let name = request
        .name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("Wallet {wallet_number}"));
    let id = wallet_id(&name, &phrase, wallet_number);
    let addresses = derive_placeholder_addresses(&id);

    config.wallets.push(WalletConfig {
        id: id.clone(),
        name,
        phrase,
        addresses,
    });

    if config.connected_wallet_id.is_none() {
        config.connected_wallet_id = Some(id);
    }

    save_config(&state.config_path, &config)?;
    Ok(config.clone())
}

#[tauri::command]
fn set_connected_wallet(
    wallet_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<AppConfig, String> {
    let mut config = state.config.lock().map_err(|error| error.to_string())?;

    if let Some(wallet_id) = wallet_id.as_deref() {
        let exists = config.wallets.iter().any(|wallet| wallet.id == wallet_id);
        if !exists {
            return Err("Unknown wallet".to_string());
        }
    }

    config.connected_wallet_id = wallet_id;
    save_config(&state.config_path, &config)?;
    Ok(config.clone())
}

#[tauri::command]
fn get_wallet_sync_status(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<serde_json::Value>, String> {
    state
        .wallet_sync
        .lock()
        .map_err(|error| error.to_string())?
        .ensure_running(&app);

    let path = wallet_sync_status_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let status: serde_json::Value =
        serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    Ok(status
        .get("wallets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
fn set_active_sync_wallet(wallet_id: Option<String>, app: AppHandle) -> Result<(), String> {
    let path = wallet_sync_control_path(&app)?;
    let control = serde_json::json!({
        "activeWalletId": wallet_id,
        "updatedAtMs": unix_timestamp_ms()
    });
    atomic_write_json(&path, &control)
}

#[tauri::command]
fn get_proof_server_status(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<ProofServerStatus, String> {
    let mut proof_server = state
        .proof_server
        .lock()
        .map_err(|error| error.to_string())?;
    proof_server.ensure_running(&app);
    Ok(proof_server.status())
}

#[tauri::command]
fn restart_proof_server(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<ProofServerStatus, String> {
    let mut proof_server = state
        .proof_server
        .lock()
        .map_err(|error| error.to_string())?;
    proof_server.restart(&app);
    Ok(proof_server.status())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_config_dir).map_err(|error| error.to_string())?;
    Ok(app_config_dir.join("config.json"))
}

fn proof_server_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("proof-server");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir)
}

fn wallet_sync_status_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(wallet_sync_dir(app)?.join("status.json"))
}

fn wallet_sync_control_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(wallet_sync_dir(app)?.join("control.json"))
}

fn wallet_sync_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("wallet-sync");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir)
}

fn repo_root_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn wallet_sync_script_path() -> PathBuf {
    repo_root_path()
        .join("dist-sidecar")
        .join("wallet-sync-sidecar.mjs")
}

fn pipe_child_output<R>(label: &'static str, pipe: Option<R>, stderr: bool)
where
    R: Read + Send + 'static,
{
    let Some(pipe) = pipe else {
        return;
    };

    thread::spawn(move || {
        let reader = BufReader::new(pipe);
        for line in reader.lines().map_while(Result::ok) {
            if stderr {
                eprintln!("[{label}] {line}");
            } else {
                println!("[{label}] {line}");
            }
        }
    });
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn atomic_write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let contents = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, contents).map_err(|error| error.to_string())?;
    fs::rename(tmp_path, path).map_err(|error| error.to_string())
}

fn load_config(path: &PathBuf) -> LoadedConfig {
    match read_config(path) {
        Ok(config) => LoadedConfig {
            config,
            should_persist: false,
        },
        Err(primary_error) if path.exists() => {
            eprintln!(
                "[app-config] failed to read primary config {}: {primary_error}",
                path.display()
            );

            let backup_path = config_backup_path(path);
            match read_config(&backup_path) {
                Ok(config) => {
                    eprintln!(
                        "[app-config] restored config from backup {}",
                        backup_path.display()
                    );
                    LoadedConfig {
                        config,
                        should_persist: true,
                    }
                }
                Err(backup_error) => {
                    eprintln!(
                        "[app-config] failed to read backup config {}: {backup_error}",
                        backup_path.display()
                    );
                    LoadedConfig {
                        config: AppConfig::default(),
                        should_persist: false,
                    }
                }
            }
        }
        Err(_) => LoadedConfig {
            config: AppConfig::default(),
            should_persist: true,
        },
    }
}

fn save_config(path: &PathBuf, config: &AppConfig) -> Result<(), String> {
    if path.exists() {
        fs::copy(path, config_backup_path(path)).map_err(|error| error.to_string())?;
    }

    let contents = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    let tmp_path = config_tmp_path(path);
    fs::write(&tmp_path, contents).map_err(|error| error.to_string())?;
    fs::rename(tmp_path, path).map_err(|error| error.to_string())
}

fn read_config(path: &PathBuf) -> Result<AppConfig, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn config_backup_path(path: &PathBuf) -> PathBuf {
    path.with_extension("json.bak")
}

fn config_tmp_path(path: &PathBuf) -> PathBuf {
    path.with_extension("json.tmp")
}

fn required_url(label: &str, value: String) -> Result<String, String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(trimmed)
}

fn wallet_id(name: &str, phrase: &str, wallet_number: usize) -> String {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    phrase.hash(&mut hasher);
    wallet_number.hash(&mut hasher);
    format!("wallet-{:016x}", hasher.finish())
}

fn derive_placeholder_addresses(wallet_id: &str) -> WalletAddresses {
    WalletAddresses {
        unshielded: format!("mn_unshielded_{}", address_suffix(wallet_id, "unshielded")),
        shielded: format!("mn_shielded_{}", address_suffix(wallet_id, "shielded")),
        dust: format!("mn_dust_{}", address_suffix(wallet_id, "dust")),
    }
}

fn address_suffix(wallet_id: &str, kind: &str) -> String {
    let mut hasher = DefaultHasher::new();
    wallet_id.hash(&mut hasher);
    kind.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn proof_server_is_online() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], PROOF_SERVER_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.write_all(
        format!(
            "GET /version HTTP/1.1\r\nHost: {PROOF_SERVER_HOST}:{PROOF_SERVER_PORT}\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    );

    let mut response = [0; 12];
    stream.read(&mut response).is_ok()
}

fn start_watchdog(app: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(mut proof_server) = state.proof_server.lock() {
                proof_server.ensure_running(&app);
            }

            tokio::time::sleep(Duration::from_secs(WATCHDOG_INTERVAL_SECONDS)).await;
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let config_path = config_path(&app_handle)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let loaded_config = load_config(&config_path);
            if loaded_config.should_persist {
                save_config(&config_path, &loaded_config.config)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            }
            proof_server_data_dir(&app_handle)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;

            let state = Arc::new(AppState {
                config_path,
                config: Mutex::new(loaded_config.config),
                proof_server: Mutex::new(ProofServerSupervisor::new()),
                wallet_sync: Mutex::new(WalletSyncSupervisor::new()),
            });

            app.manage(state.clone());
            start_watchdog(app_handle, state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_wallet,
            get_app_config,
            get_proof_server_status,
            get_wallet_sync_status,
            restart_proof_server,
            set_active_sync_wallet,
            set_connected_wallet,
            set_network_endpoints,
            set_network
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
