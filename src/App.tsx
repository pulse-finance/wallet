import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { DappBrowserPage } from "./components/DappBrowserPage";
import { SettingsPage } from "./components/SettingsPage";
import { SideMenu } from "./components/SideMenu";
import { WalletCreationModal } from "./components/WalletCreationModal";
import { WalletDetailPage } from "./components/WalletDetailPage";
import { WalletOverviewPage } from "./components/WalletOverviewPage";
import { AppConfig, AppTab, MidnightNetwork, NetworkEndpoints, ProofServerStatus, WalletSyncStatus } from "./types";
import { DerivedWalletDisplay, deriveDisplayAddresses } from "./walletAddresses";
import "./App.css";

const NETWORK_LABELS: Record<MidnightNetwork, string> = {
  preprod: "Preprod",
  mainnet: "Mainnet",
};

const HEALTHCHECK_INTERVAL_MS = 2_000;

const emptyConfig: AppConfig = {
  network: "preprod",
  endpoints: {
    indexerUrl: "https://indexer.preprod.midnight.network/api/v4/graphql",
    indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    nodeUrl: "https://rpc.preprod.midnight.network",
    nodeWsUrl: "wss://rpc.preprod.midnight.network/ws",
  },
  wallets: [],
  connectedWalletId: null,
};

function App() {
  const runningInTauri = useMemo(() => isTauri(), []);
  const [activeTab, setActiveTab] = useState<AppTab>("wallets");
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [status, setStatus] = useState<ProofServerStatus | null>(null);
  const [syncStatuses, setSyncStatuses] = useState<WalletSyncStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [walletPhrase, setWalletPhrase] = useState("");
  const [walletName, setWalletName] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [browserKey, setBrowserKey] = useState(0);

  const selectedWallet = config.wallets.find((wallet) => wallet.id === selectedWalletId) ?? null;
  const connectedWallet = config.wallets.find((wallet) => wallet.id === config.connectedWalletId) ?? null;
  const prioritySyncWalletId =
    activeTab === "wallets" && selectedWallet ? selectedWallet.id : activeTab === "dapps" ? config.connectedWalletId : null;
  const displayAddressesByWalletId = useMemo(
    () => new Map<string, DerivedWalletDisplay>(config.wallets.map((wallet) => [wallet.id, deriveDisplayAddresses(wallet, config.network)])),
    [config.network, config.wallets],
  );

  const loadConfig = useCallback(async () => {
    if (!runningInTauri) {
      setError("Run with pnpm tauri dev to use wallet storage and the proof-server sidecar.");
      return;
    }

    try {
      const nextConfig = await invoke<AppConfig>("get_app_config");
      setConfig(nextConfig);
      if (selectedWalletId && !nextConfig.wallets.some((wallet) => wallet.id === selectedWalletId)) {
        setSelectedWalletId(null);
      }
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
    }
  }, [runningInTauri, selectedWalletId]);

  const refreshStatus = useCallback(async () => {
    if (!runningInTauri) {
      return;
    }

    try {
      setStatus(await invoke<ProofServerStatus>("get_proof_server_status"));
    } catch (caught) {
      setError(formatError(caught));
    }
  }, [runningInTauri]);

  const refreshSyncStatus = useCallback(async () => {
    if (!runningInTauri) {
      return;
    }

    try {
      setSyncStatuses(await invoke<WalletSyncStatus[]>("get_wallet_sync_status"));
    } catch (caught) {
      setError(formatError(caught));
    }
  }, [runningInTauri]);

  useEffect(() => {
    loadConfig();
    refreshStatus();
    refreshSyncStatus();
    const interval = window.setInterval(() => {
      refreshStatus();
      refreshSyncStatus();
    }, HEALTHCHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadConfig, refreshStatus, refreshSyncStatus]);

  useEffect(() => {
    if (!runningInTauri || config.wallets.length === 0) {
      setSyncStatuses([]);
      return;
    }

    invoke("set_active_sync_wallet", { walletId: prioritySyncWalletId }).catch((caught) => {
      setError(formatError(caught));
    });
  }, [config.wallets.length, prioritySyncWalletId, runningInTauri]);

  async function handleNetworkChange(network: MidnightNetwork) {
    setConfig((current) => ({ ...current, network }));

    try {
      setConfig(await invoke<AppConfig>("set_network", { network }));
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
      loadConfig();
    }
  }

  async function handleAddWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const nextConfig = await invoke<AppConfig>("add_wallet", {
        request: {
          name: walletName,
          phrase: walletPhrase,
        },
      });
      setConfig(nextConfig);
      setWalletName("");
      setWalletPhrase("");
      setShowAddWallet(false);
      setSelectedWalletId(nextConfig.wallets[nextConfig.wallets.length - 1]?.id ?? null);
      setActiveTab("wallets");
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
    }
  }

  async function handleConnectedWallet(walletId: string | null) {
    try {
      setConfig(await invoke<AppConfig>("set_connected_wallet", { walletId }));
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
    }
  }

  async function handleEndpointSave(endpoints: NetworkEndpoints) {
    try {
      setConfig(await invoke<AppConfig>("set_network_endpoints", { request: endpoints }));
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
    }
  }

  function navigateTo(rawUrl: string) {
    const nextUrl = normalizeUrl(rawUrl);
    setLoadedUrl(nextUrl);
    setUrlInput(nextUrl);
    setBrowserKey((key) => key + 1);

    const nextHistory = history.slice(0, historyIndex + 1);
    nextHistory.push(nextUrl);
    setHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
  }

  function goBack() {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    setLoadedUrl(history[nextIndex]);
    setUrlInput(history[nextIndex]);
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setLoadedUrl(history[nextIndex]);
    setUrlInput(history[nextIndex]);
  }

  function refreshBrowser() {
    setBrowserKey((key) => key + 1);
  }

  return (
    <div className="app-frame">
      <SideMenu
        activeTab={activeTab}
        wallets={config.wallets}
        selectedWalletId={selectedWalletId}
        connectedWalletId={config.connectedWalletId}
        onSelectWallets={() => {
          setActiveTab("wallets");
          setSelectedWalletId(null);
        }}
        onSelectWallet={(walletId) => {
          setActiveTab("wallets");
          setSelectedWalletId(walletId);
        }}
        onSelectDapps={() => setActiveTab("dapps")}
        onSelectSettings={() => setActiveTab("settings")}
      />

      <main className="workspace">
        {activeTab === "wallets" && !selectedWallet ? (
          <WalletOverviewPage
            wallets={config.wallets}
            displayAddressesByWalletId={displayAddressesByWalletId}
            syncStatuses={syncStatuses}
            onAdd={() => setShowAddWallet(true)}
            onOpen={setSelectedWalletId}
          />
        ) : null}

        {activeTab === "wallets" && selectedWallet ? (
          <WalletDetailPage
            wallet={selectedWallet}
            displayAddresses={
              displayAddressesByWalletId.get(selectedWallet.id)?.addresses ?? {
                unshielded: { value: null, error: "Wallet not found" },
                shielded: { value: null, error: "Wallet not found" },
                dust: { value: null, error: "Wallet not found" },
              }
            }
            syncStatus={syncStatuses.find((syncStatus) => syncStatus.walletId === selectedWallet.id) ?? null}
            connected={config.connectedWalletId === selectedWallet.id}
            onConnect={() => handleConnectedWallet(selectedWallet.id)}
          />
        ) : null}

        {activeTab === "dapps" ? (
          <DappBrowserPage
            connectedWallet={connectedWallet}
            urlInput={urlInput}
            loadedUrl={loadedUrl}
            browserKey={browserKey}
            canGoBack={historyIndex > 0}
            canGoForward={historyIndex >= 0 && historyIndex < history.length - 1}
            onUrlInput={setUrlInput}
            onNavigate={navigateTo}
            onBack={goBack}
            onForward={goForward}
            onRefresh={refreshBrowser}
          />
        ) : null}

        {activeTab === "settings" ? <SettingsPage endpoints={config.endpoints} onSave={handleEndpointSave} /> : null}
      </main>

      <footer className="bottom-bar">
        <div className="network-control">
          <label htmlFor="network">Network</label>
          <select
            id="network"
            value={config.network}
            onChange={(event) => handleNetworkChange(event.currentTarget.value as MidnightNetwork)}
          >
            <option value="preprod">{NETWORK_LABELS.preprod}</option>
            <option value="mainnet">{NETWORK_LABELS.mainnet}</option>
          </select>
        </div>
        <div className="proof-status">
          <span className={status?.online ? "traffic-light online" : "traffic-light offline"} />
          <span>{status?.online ? "Proof server online" : "Proof server offline"}</span>
          <span className="muted">{status?.url ?? "http://localhost:6300"}</span>
        </div>
        {error ? <div className="bottom-error">{error}</div> : null}
      </footer>

      {showAddWallet ? (
        <WalletCreationModal
          walletCount={config.wallets.length}
          walletName={walletName}
          walletPhrase={walletPhrase}
          onNameChange={setWalletName}
          onPhraseChange={setWalletPhrase}
          onSubmit={handleAddWallet}
          onClose={() => setShowAddWallet(false)}
        />
      ) : null}
    </div>
  );
}

function normalizeUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return "about:blank";
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function formatError(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}

export default App;
