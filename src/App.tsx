import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { BottomBar } from "./components/BottomBar";
import { SettingsPage } from "./components/SettingsPage";
import { SideMenu } from "./components/SideMenu";
import { WalletCreationModal } from "./components/WalletCreationModal";
import { WalletDetailPage } from "./components/WalletDetailPage";
import { AppConfig, AppTab, MidnightNetwork, NetworkEndpoints, WalletSyncStatus } from "./types";
import { DerivedWalletDisplay, deriveDisplayAddresses } from "./walletAddresses";
import "./App.css";

const SYNC_REFRESH_INTERVAL_MS = 2_000;

const emptyConfig: AppConfig = {
  network: "preprod",
  endpoints: {
    indexerUrl: "https://indexer.preprod.midnight.network/api/v4/graphql",
    indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    nodeUrl: "https://rpc.preprod.midnight.network",
    nodeWsUrl: "wss://rpc.preprod.midnight.network/ws",
  },
  wallets: [],
};

function App() {
  const runningInTauri = useMemo(() => isTauri(), []);
  const [activeTab, setActiveTab] = useState<AppTab>("wallets");
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [syncStatuses, setSyncStatuses] = useState<WalletSyncStatus[]>([]);
  const [, setError] = useState<string | null>(null);
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [walletPhrase, setWalletPhrase] = useState("");
  const [walletName, setWalletName] = useState("");

  const selectedWallet = config.wallets.find((wallet) => wallet.id === selectedWalletId) ?? null;
  const prioritySyncWalletId = activeTab === "wallets" && selectedWallet ? selectedWallet.id : null;
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
      setSelectedWalletId((currentWalletId) => {
        if (currentWalletId && nextConfig.wallets.some((wallet) => wallet.id === currentWalletId)) {
          return currentWalletId;
        }
        return nextConfig.wallets[0]?.id ?? null;
      });
      setError(null);
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
    refreshSyncStatus();
    const interval = window.setInterval(() => {
      refreshSyncStatus();
    }, SYNC_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadConfig, refreshSyncStatus]);

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

  async function handleEndpointSave(endpoints: NetworkEndpoints) {
    try {
      setConfig(await invoke<AppConfig>("set_network_endpoints", { request: endpoints }));
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
    }
  }

  return (
    <div className="app-frame">
      <SideMenu
        activeTab={activeTab}
        wallets={config.wallets}
        selectedWalletId={selectedWalletId}
        onAddWallet={() => setShowAddWallet(true)}
        onSelectWallet={(walletId) => {
          setActiveTab("wallets");
          setSelectedWalletId(walletId);
        }}
        onSelectSettings={() => setActiveTab("settings")}
      />

      <main className="workspace">
        {activeTab === "wallets" && selectedWallet ? (
          <WalletDetailPage
            network={config.network}
            wallet={selectedWallet}
            displayAddresses={
              displayAddressesByWalletId.get(selectedWallet.id)?.addresses ?? {
                unshielded: { value: null, error: "Wallet not found" },
                shielded: { value: null, error: "Wallet not found" },
                dust: { value: null, error: "Wallet not found" },
              }
            }
            syncStatus={syncStatuses.find((syncStatus) => syncStatus.walletId === selectedWallet.id) ?? null}
          />
        ) : null}

        {activeTab === "wallets" && !selectedWallet ? <EmptyWalletPage /> : null}

        {activeTab === "settings" ? <SettingsPage endpoints={config.endpoints} onSave={handleEndpointSave} /> : null}
      </main>

      <BottomBar network={config.network} onNetworkChange={handleNetworkChange} />

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

function EmptyWalletPage() {
  return (
    <section className="page empty-state">
      <p className="eyebrow">Wallets</p>
      <h1>No wallets yet</h1>
    </section>
  );
}

function formatError(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}

export default App;
