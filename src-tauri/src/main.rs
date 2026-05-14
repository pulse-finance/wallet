// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const PROOF_SERVER_HOST: &str = "127.0.0.1";
const PROOF_SERVER_PORT: u16 = 6300;
const PROOF_SERVER_URL: &str = "http://localhost:6300";
const DAPP_CONNECTOR_PUBLIC_HOST: &str = "127.0.0.1";
const DAPP_CONNECTOR_PUBLIC_PORT: u16 = 6301;
const DAPP_CONNECTOR_MIN_INTERNAL_PORT: u16 = 16000;
const DAPP_CONNECTOR_MAX_INTERNAL_PORT: u16 = 60000;
const DAPP_APPROVAL_TIMEOUT_SECONDS: u64 = 300;
const PROOF_SERVER_STARTUP_GRACE_SECONDS: u64 = 10;
const WATCHDOG_INTERVAL_SECONDS: u64 = 2;
const DEFAULT_INDEXER_URL: &str = "https://indexer.preprod.midnight.network/api/v4/graphql";
const DEFAULT_INDEXER_WS_URL: &str = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";
const DEFAULT_NODE_URL: &str = "https://rpc.preprod.midnight.network";
const DEFAULT_NODE_WS_URL: &str = "wss://rpc.preprod.midnight.network/ws";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            network: MidnightNetwork::default(),
            endpoints: NetworkEndpoints::default(),
            wallets: Vec::new(),
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
    #[serde(default)]
    network: MidnightNetwork,
    addresses: WalletAddresses,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WalletAddresses {
    unshielded: String,
    shielded: String,
    dust: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddWalletRequest {
    id: String,
    name: Option<String>,
    phrase: String,
    network: MidnightNetwork,
    addresses: WalletAddresses,
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

struct DappConnectorSupervisor {
    child: Option<Child>,
    port: Option<u16>,
    token: Option<String>,
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
        let node_path = match node_runtime_path(app) {
            Ok(path) => path,
            Err(error) => {
                self.last_error = Some(error);
                return;
            }
        };
        let script_path = match wallet_sync_script_path(app) {
            Ok(path) => path,
            Err(error) => {
                self.last_error = Some(error);
                return;
            }
        };
        let working_dir = sidecar_working_dir(&script_path);

        match StdCommand::new(&node_path)
            .arg(&script_path)
            .arg("--config")
            .arg(&config_path)
            .arg("--cache-dir")
            .arg(&cache_dir)
            .current_dir(working_dir)
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

impl DappConnectorSupervisor {
    fn new() -> Self {
        Self {
            child: None,
            port: None,
            token: None,
            last_error: None,
            restarts: 0,
        }
    }

    fn ensure_running(&mut self, app: &AppHandle) -> Result<(u16, String), String> {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    if let (Some(port), Some(token)) = (self.port, self.token.clone()) {
                        return Ok((port, token));
                    }
                }
                Ok(Some(status)) => {
                    self.last_error = Some(format!("dapp connector sidecar exited with {status}"));
                    self.child = None;
                    self.port = None;
                    self.token = None;
                }
                Err(error) => {
                    self.last_error = Some(error.to_string());
                    self.child = None;
                    self.port = None;
                    self.token = None;
                }
            }
        }

        self.restart(app)?;
        match (self.port, self.token.clone()) {
            (Some(port), Some(token)) => Ok((port, token)),
            _ => Err(self
                .last_error
                .clone()
                .unwrap_or_else(|| "Failed to start dapp connector sidecar".to_string())),
        }
    }

    fn restart(&mut self, app: &AppHandle) -> Result<(), String> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
        self.port = None;
        self.token = None;

        let config_path = config_path(app)?;
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        let node_path = node_runtime_path(app)?;
        let script_path = dapp_connector_script_path(app)?;
        let working_dir = sidecar_working_dir(&script_path);
        let port = choose_dapp_connector_port()?;
        let token = dapp_connector_token(port);

        match StdCommand::new(&node_path)
            .arg(&script_path)
            .arg("--config")
            .arg(&config_path)
            .arg("--cache-dir")
            .arg(&cache_dir)
            .arg("--port")
            .arg(port.to_string())
            .arg("--token")
            .arg(&token)
            .current_dir(working_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                pipe_child_output("dapp-connector", child.stdout.take(), false);
                pipe_child_output("dapp-connector", child.stderr.take(), true);
                self.child = Some(child);
                self.port = Some(port);
                self.token = Some(token);
                self.last_error = None;
                self.restarts += 1;
                Ok(())
            }
            Err(error) => {
                self.child = None;
                self.last_error = Some(error.to_string());
                Err(error.to_string())
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
    dapp_approvals_path: PathBuf,
    config: Mutex<AppConfig>,
    dapp_approvals: Mutex<HashSet<String>>,
    dapp_approval_waiters: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    dapp_connector: Mutex<DappConnectorSupervisor>,
    active_sync_wallet_id: Mutex<Option<String>>,
    proof_server: Mutex<ProofServerSupervisor>,
    wallet_sync: Mutex<WalletSyncSupervisor>,
}

struct LoadedConfig {
    config: AppConfig,
    should_persist: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DappApprovalRequest {
    request_id: String,
    identity: String,
    kind: String,
    wallet_name: Option<String>,
    network: Option<MidnightNetwork>,
    tx_preview: Option<String>,
}

#[tauri::command]
fn get_app_config(state: State<'_, Arc<AppState>>) -> AppConfig {
    state.config.lock().expect("config mutex poisoned").clone()
}

#[tauri::command]
fn replace_wallets(
    wallets: Vec<WalletConfig>,
    state: State<'_, Arc<AppState>>,
) -> Result<AppConfig, String> {
    let mut config = state.config.lock().map_err(|error| error.to_string())?;
    config.wallets = wallets;
    save_config(&state.config_path, &config)?;
    Ok(config.clone())
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
    let id = request.id.trim().to_string();
    if id.is_empty() {
        return Err("Wallet id is required".to_string());
    }

    let mut config = state.config.lock().map_err(|error| error.to_string())?;
    if config
        .wallets
        .iter()
        .any(|wallet| wallet.network == request.network && wallet.id == id)
    {
        return Err(
            "A wallet with this unshielded address already exists for this network".to_string(),
        );
    }
    let wallet_number = config
        .wallets
        .iter()
        .filter(|wallet| wallet.network == request.network)
        .count()
        + 1;
    let name = request
        .name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("Wallet {wallet_number}"));

    config.wallets.push(WalletConfig {
        id,
        name,
        phrase,
        network: request.network,
        addresses: request.addresses,
    });

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
fn set_active_sync_wallet(
    wallet_id: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let path = wallet_sync_control_path(&app)?;
    let control = serde_json::json!({
        "activeWalletId": wallet_id,
        "updatedAtMs": unix_timestamp_ms()
    });
    atomic_write_json(&path, &control)?;
    *state
        .active_sync_wallet_id
        .lock()
        .map_err(|error| error.to_string())? = wallet_id;
    Ok(())
}

#[tauri::command]
fn respond_dapp_approval(
    request_id: String,
    approved: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let sender = state
        .dapp_approval_waiters
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&request_id);

    if let Some(sender) = sender {
        let _ = sender.send(approved);
    }

    Ok(())
}

#[tauri::command]
fn get_whitelisted_dapps(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    let mut approvals = state
        .dapp_approvals
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    approvals.sort();
    Ok(approvals)
}

#[tauri::command]
fn delete_whitelisted_dapp(
    identity: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let mut approvals = state
        .dapp_approvals
        .lock()
        .map_err(|error| error.to_string())?;
    approvals.remove(&identity);
    save_dapp_approvals(&state.dapp_approvals_path, &approvals)?;

    let mut next_approvals = approvals.iter().cloned().collect::<Vec<_>>();
    next_approvals.sort();
    Ok(next_approvals)
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
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http and https URLs are supported".to_string());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
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

fn dapp_connector_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("dapp-connector");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    Ok(data_dir)
}

fn dapp_approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dapp_connector_dir(app)?.join("approvals.json"))
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

fn node_runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        return app
            .path()
            .resolve(
                "node/win-x64/node.exe",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|error| error.to_string());
    }

    #[cfg(not(all(windows, not(debug_assertions))))]
    {
        let _ = app;
        Ok(PathBuf::from("node"))
    }
}

fn wallet_sync_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_script_path(app, "wallet-sync.mjs")
}

fn dapp_connector_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    sidecar_script_path(app, "dapp-connector.mjs")
}

fn sidecar_script_path(app: &AppHandle, filename: &str) -> Result<PathBuf, String> {
    #[cfg(not(debug_assertions))]
    {
        return app
            .path()
            .resolve(
                format!("sidecars/{filename}"),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|error| error.to_string());
    }

    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(repo_root_path()
            .join("dist")
            .join("sidecars")
            .join(filename))
    }
}

fn sidecar_working_dir(script_path: &PathBuf) -> PathBuf {
    script_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(repo_root_path)
}

fn choose_dapp_connector_port() -> Result<u16, String> {
    static PORT_COUNTER: AtomicU64 = AtomicU64::new(0);
    let seed = unix_timestamp_ms() as u64 + PORT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let range = u64::from(DAPP_CONNECTOR_MAX_INTERNAL_PORT - DAPP_CONNECTOR_MIN_INTERNAL_PORT);

    for offset in 0..range {
        let port = DAPP_CONNECTOR_MIN_INTERNAL_PORT + ((seed + offset) % range) as u16;
        if TcpListener::bind((DAPP_CONNECTOR_PUBLIC_HOST, port)).is_ok() {
            return Ok(port);
        }
    }

    Err("No available dapp connector sidecar port found".to_string())
}

fn dapp_connector_token(port: u16) -> String {
    let mut hasher = DefaultHasher::new();
    unix_timestamp_ms().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    port.hash(&mut hasher);
    format!("{:016x}{:016x}", hasher.finish(), unix_timestamp_ms())
}

fn load_dapp_approvals(path: &PathBuf) -> HashSet<String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return HashSet::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_dapp_approvals(path: &PathBuf, approvals: &HashSet<String>) -> Result<(), String> {
    atomic_write_json(path, approvals)
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

struct DappHttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct DappHttpResponse {
    status: u16,
    content_type: String,
    body: Vec<u8>,
}

enum MissingContentLength {
    EndAtHeaders,
    ReadToClose,
}

fn start_dapp_connector_server(app: AppHandle, state: Arc<AppState>) {
    thread::spawn(move || {
        let listener =
            match TcpListener::bind((DAPP_CONNECTOR_PUBLIC_HOST, DAPP_CONNECTOR_PUBLIC_PORT)) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("[dapp-connector] failed to bind: {error}");
                    return;
                }
            };

        println!(
            "[dapp-connector] listening on http://{DAPP_CONNECTOR_PUBLIC_HOST}:{DAPP_CONNECTOR_PUBLIC_PORT}"
        );

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    let state = state.clone();
                    thread::spawn(move || handle_dapp_connector_stream(stream, app, state));
                }
                Err(error) => eprintln!("[dapp-connector] connection failed: {error}"),
            }
        }
    });
}

fn handle_dapp_connector_stream(mut stream: TcpStream, app: AppHandle, state: Arc<AppState>) {
    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_public_json_response(
                &mut stream,
                400,
                "Bad Request",
                None,
                &serde_json::json!({ "error": error }),
            );
            return;
        }
    };

    let origin = request.headers.get("origin").cloned();
    if request.method == "OPTIONS" {
        let _ = write_public_response(
            &mut stream,
            204,
            "No Content",
            origin.as_deref(),
            "text/plain",
            &[],
        );
        return;
    }

    let response = match handle_dapp_connector_request(&app, &state, &request) {
        Ok(response) => response,
        Err((status, message)) => DappHttpResponse {
            status,
            content_type: "application/json".to_string(),
            body: serde_json::to_vec(&serde_json::json!({ "error": message })).unwrap_or_default(),
        },
    };

    let reason = http_reason(response.status);
    let _ = write_public_response(
        &mut stream,
        response.status,
        reason,
        origin.as_deref(),
        &response.content_type,
        &response.body,
    );
}

fn handle_dapp_connector_request(
    app: &AppHandle,
    state: &Arc<AppState>,
    request: &DappHttpRequest,
) -> Result<DappHttpResponse, (u16, String)> {
    if !request.path.starts_with("/midnight") {
        return Err((404, "Not found".to_string()));
    }

    if !matches!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/midnight/configuration")
            | ("GET", "/midnight/addresses")
            | ("GET", "/midnight/balance")
            | ("POST", "/midnight/balance")
            | ("POST", "/midnight/submit")
    ) {
        return Err((404, "Not found".to_string()));
    }

    let identity = dapp_request_identity(request);
    ensure_dapp_identity_approved(app, state, &identity)?;

    if request.method == "POST" && request.path == "/midnight/balance" {
        let (wallet_name, network) = active_wallet_context(state);
        let approved = request_dapp_approval(
            app,
            state,
            DappApprovalRequest {
                request_id: next_approval_request_id(),
                identity,
                kind: "balance".to_string(),
                wallet_name,
                network,
                tx_preview: tx_preview(&request.body),
            },
        )?;
        if !approved {
            return Err((403, "Request denied".to_string()));
        }
    }

    let (port, token) = state
        .dapp_connector
        .lock()
        .map_err(|error| (503, error.to_string()))?
        .ensure_running(app)
        .map_err(|error| (503, error))?;

    forward_to_dapp_sidecar(port, &token, request).map_err(|error| (503, error))
}

fn ensure_dapp_identity_approved(
    app: &AppHandle,
    state: &Arc<AppState>,
    identity: &str,
) -> Result<(), (u16, String)> {
    if state
        .dapp_approvals
        .lock()
        .map_err(|error| (500, error.to_string()))?
        .contains(identity)
    {
        return Ok(());
    }

    let (wallet_name, network) = active_wallet_context(state);
    let approved = request_dapp_approval(
        app,
        state,
        DappApprovalRequest {
            request_id: next_approval_request_id(),
            identity: identity.to_string(),
            kind: "connect".to_string(),
            wallet_name,
            network,
            tx_preview: None,
        },
    )?;

    if !approved {
        return Err((403, "Request denied".to_string()));
    }

    let mut approvals = state
        .dapp_approvals
        .lock()
        .map_err(|error| (500, error.to_string()))?;
    approvals.insert(identity.to_string());
    save_dapp_approvals(&state.dapp_approvals_path, &approvals).map_err(|error| (500, error))?;
    Ok(())
}

fn request_dapp_approval(
    app: &AppHandle,
    state: &Arc<AppState>,
    request: DappApprovalRequest,
) -> Result<bool, (u16, String)> {
    let request_id = request.request_id.clone();
    let (sender, receiver) = mpsc::channel();
    state
        .dapp_approval_waiters
        .lock()
        .map_err(|error| (500, error.to_string()))?
        .insert(request_id.clone(), sender);

    if let Err(error) = app.emit("dapp-approval-request", request) {
        let _ = state
            .dapp_approval_waiters
            .lock()
            .map_err(|lock_error| (500, lock_error.to_string()))?
            .remove(&request_id);
        return Err((500, error.to_string()));
    }

    match receiver.recv_timeout(Duration::from_secs(DAPP_APPROVAL_TIMEOUT_SECONDS)) {
        Ok(approved) => Ok(approved),
        Err(_) => {
            let _ = state
                .dapp_approval_waiters
                .lock()
                .map_err(|error| (500, error.to_string()))?
                .remove(&request_id);
            Err((403, "Request timed out".to_string()))
        }
    }
}

fn dapp_request_identity(request: &DappHttpRequest) -> String {
    request
        .headers
        .get("origin")
        .cloned()
        .unwrap_or_else(|| "Unknown Origin".to_string())
}

fn active_wallet_context(state: &Arc<AppState>) -> (Option<String>, Option<MidnightNetwork>) {
    let Ok(config) = state.config.lock() else {
        return (None, None);
    };
    let active_wallet_id = state
        .active_sync_wallet_id
        .lock()
        .ok()
        .and_then(|wallet_id| wallet_id.clone());
    let wallet_name = active_wallet_id
        .as_deref()
        .and_then(|wallet_id| {
            config
                .wallets
                .iter()
                .find(|wallet| wallet.network == config.network && wallet.id == wallet_id)
        })
        .or_else(|| {
            config
                .wallets
                .iter()
                .find(|wallet| wallet.network == config.network)
        })
        .map(|wallet| wallet.name.clone());
    (wallet_name, Some(config.network))
}

fn next_approval_request_id() -> String {
    static APPROVAL_COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "dapp-approval-{}-{}",
        unix_timestamp_ms(),
        APPROVAL_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn tx_preview(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let tx = value.get("tx")?.as_str()?;
    if tx.len() <= 24 {
        return Some(tx.to_string());
    }
    Some(format!("{}...{}", &tx[..12], &tx[tx.len() - 12..]))
}

fn forward_to_dapp_sidecar(
    port: u16,
    token: &str,
    request: &DappHttpRequest,
) -> Result<DappHttpResponse, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let started = Instant::now();
    let mut stream = loop {
        match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            Ok(stream) => break stream,
            Err(error) if started.elapsed() < Duration::from_secs(5) => {
                thread::sleep(Duration::from_millis(100));
                if error.kind() == std::io::ErrorKind::TimedOut {
                    continue;
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(120)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let internal_path = format!("/internal{}", request.path);
    let request_head = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        request.method,
        internal_path,
        port,
        token,
        request.body.len()
    );
    stream
        .write_all(request_head.as_bytes())
        .and_then(|_| stream.write_all(&request.body))
        .map_err(|error| error.to_string())?;
    read_http_response(&mut stream)
}

fn read_http_request(stream: &mut TcpStream) -> Result<DappHttpRequest, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let raw = read_http_message(stream, MissingContentLength::EndAtHeaders)?;
    let header_end = find_header_end(&raw).ok_or_else(|| "Malformed HTTP request".to_string())?;
    let headers_text = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = headers_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing method".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Missing path".to_string())?
        .to_string();
    let headers = parse_http_headers(lines);
    let body = raw[(header_end + 4)..].to_vec();
    Ok(DappHttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn read_http_response(stream: &mut TcpStream) -> Result<DappHttpResponse, String> {
    let raw = read_http_message(stream, MissingContentLength::ReadToClose)?;
    let header_end = find_header_end(&raw).ok_or_else(|| "Malformed HTTP response".to_string())?;
    let headers_text = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = headers_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "Missing status line".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Missing response status".to_string())?;
    let headers = parse_http_headers(lines);
    let content_type = headers
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| "application/json".to_string());
    let body = raw[(header_end + 4)..].to_vec();
    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        decode_chunked_body(&body)?
    } else {
        body
    };

    Ok(DappHttpResponse {
        status,
        content_type,
        body,
    })
}

fn read_http_message(
    stream: &mut TcpStream,
    missing_content_length: MissingContentLength,
) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        raw.extend_from_slice(&buffer[..count]);
        if let Some(header_end) = find_header_end(&raw) {
            let headers_text = String::from_utf8_lossy(&raw[..header_end]);
            let headers = parse_http_headers(headers_text.split("\r\n").skip(1));
            if let Some(content_length) = headers
                .get("content-length")
                .and_then(|value| value.parse::<usize>().ok())
            {
                if raw.len() >= header_end + 4 + content_length {
                    raw.truncate(header_end + 4 + content_length);
                    break;
                }
            } else if matches!(missing_content_length, MissingContentLength::EndAtHeaders) {
                raw.truncate(header_end + 4);
                break;
            }
        }
    }
    Ok(raw)
}

fn decode_chunked_body(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    let mut index = 0;

    loop {
        let line_end = raw[index..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|position| index + position)
            .ok_or_else(|| "Malformed chunked response".to_string())?;
        let size_text = String::from_utf8_lossy(&raw[index..line_end]);
        let size_hex = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|error| format!("Invalid chunk size: {error}"))?;
        index = line_end + 2;

        if size == 0 {
            return Ok(decoded);
        }

        let chunk_end = index + size;
        if raw.len() < chunk_end + 2 || &raw[chunk_end..chunk_end + 2] != b"\r\n" {
            return Err("Malformed chunked response".to_string());
        }

        decoded.extend_from_slice(&raw[index..chunk_end]);
        index = chunk_end + 2;
    }
}

fn parse_http_headers<'a>(lines: impl Iterator<Item = &'a str>) -> HashMap<String, String> {
    lines
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect()
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn write_public_json_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    origin: Option<&str>,
    body: &serde_json::Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(body).map_err(|error| error.to_string())?;
    write_public_response(stream, status, reason, origin, "application/json", &body)
}

fn write_public_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    origin: Option<&str>,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let allow_origin = origin.unwrap_or("*");
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n",
        status,
        reason,
        content_type,
        body.len(),
        allow_origin
    );
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| error.to_string())
}

fn http_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn read_response_from_server(response: &'static [u8]) -> DappHttpResponse {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("test listener address");

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test connection");
            stream.write_all(response).expect("write test response");
        });

        let mut stream = TcpStream::connect(address).expect("connect to test listener");
        read_http_response(&mut stream).expect("read test response")
    }

    #[test]
    fn reads_content_length_response_body() {
        let response = read_response_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
        );

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json");
        assert_eq!(response.body, br#"{"ok":true}"#);
    }

    #[test]
    fn reads_close_delimited_response_body() {
        let response = read_response_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}",
        );

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json");
        assert_eq!(response.body, br#"{"ok":true}"#);
    }

    #[test]
    fn decodes_chunked_response_body() {
        let response = read_response_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"ok\r\n7\r\n\":true}\r\n0\r\n\r\n",
        );

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/json");
        assert_eq!(response.body, br#"{"ok":true}"#);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            let dapp_approvals_path = dapp_approvals_path(&app_handle)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let dapp_approvals = load_dapp_approvals(&dapp_approvals_path);

            let state = Arc::new(AppState {
                config_path,
                dapp_approvals_path,
                config: Mutex::new(loaded_config.config),
                dapp_approvals: Mutex::new(dapp_approvals),
                dapp_approval_waiters: Mutex::new(HashMap::new()),
                dapp_connector: Mutex::new(DappConnectorSupervisor::new()),
                active_sync_wallet_id: Mutex::new(None),
                proof_server: Mutex::new(ProofServerSupervisor::new()),
                wallet_sync: Mutex::new(WalletSyncSupervisor::new()),
            });

            app.manage(state.clone());
            start_dapp_connector_server(app_handle.clone(), state.clone());
            start_watchdog(app_handle, state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_wallet,
            get_app_config,
            get_proof_server_status,
            get_whitelisted_dapps,
            get_wallet_sync_status,
            open_external_url,
            restart_proof_server,
            replace_wallets,
            respond_dapp_approval,
            delete_whitelisted_dapp,
            set_active_sync_wallet,
            set_network_endpoints,
            set_network
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
