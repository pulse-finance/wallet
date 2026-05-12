import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BottomBar } from "./components/BottomBar";
import { SettingsPage } from "./components/SettingsPage";
import { SideMenu } from "./components/SideMenu";
import { WalletCreationModal } from "./components/WalletCreationModal";
import { WalletDetailPage } from "./components/WalletDetailPage";
import { AppConfig, AppTab, MidnightNetwork, NetworkEndpoints, WalletConfig, WalletSyncStatus } from "./types";
import { DerivedWalletDisplay, deriveDisplayAddresses, deriveWalletAddresses } from "./walletAddresses";
import "./App.css";

const SYNC_REFRESH_INTERVAL_MS = 2_000;

type DappApprovalRequest = {
  requestId: string;
  identity: string;
  kind: "connect" | "balance";
  walletName: string | null;
  network: MidnightNetwork | null;
  txPreview: string | null;
};

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
  const [dappApprovalRequests, setDappApprovalRequests] = useState<DappApprovalRequest[]>([]);
  const [walletPhrase, setWalletPhrase] = useState("");
  const [walletName, setWalletName] = useState("");

  const networkWallets = useMemo(
    () => config.wallets.filter((wallet) => (wallet.network ?? "preprod") === config.network),
    [config.network, config.wallets],
  );
  const selectedWallet = networkWallets.find((wallet) => wallet.id === selectedWalletId) ?? null;
  const prioritySyncWalletId = activeTab === "wallets" && selectedWallet ? selectedWallet.id : null;
  const displayAddressesByWalletId = useMemo(
    () => new Map<string, DerivedWalletDisplay>(networkWallets.map((wallet) => [wallet.id, deriveDisplayAddresses(wallet, config.network)])),
    [config.network, networkWallets],
  );

  const loadConfig = useCallback(async () => {
    if (!runningInTauri) {
      setError("Run with pnpm tauri dev to use wallet storage and the proof-server sidecar.");
      return;
    }

    try {
      const loadedConfig = await invoke<AppConfig>("get_app_config");
      const normalizedWallets = normalizeWallets(loadedConfig.wallets);
      const nextConfig = walletsChanged(loadedConfig.wallets, normalizedWallets)
        ? await invoke<AppConfig>("replace_wallets", { wallets: normalizedWallets })
        : loadedConfig;
      setConfig(nextConfig);
      setSelectedWalletId((currentWalletId) => {
        const nextNetworkWallets = nextConfig.wallets.filter((wallet) => (wallet.network ?? "preprod") === nextConfig.network);
        if (currentWalletId && nextNetworkWallets.some((wallet) => wallet.id === currentWalletId)) {
          return currentWalletId;
        }
        return nextNetworkWallets[0]?.id ?? null;
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
    if (!runningInTauri) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F11" || event.repeat) {
        return;
      }

      event.preventDefault();
      const currentWindow = getCurrentWindow();
      currentWindow
        .isFullscreen()
        .then((fullscreen) => currentWindow.setFullscreen(!fullscreen))
        .catch((caught) => {
          setError(formatError(caught));
        });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runningInTauri]);

  useEffect(() => {
    if (!runningInTauri) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<DappApprovalRequest>("dapp-approval-request", async (event) => {
      try {
        const currentWindow = getCurrentWindow();
        await currentWindow.show();
        await currentWindow.setFocus();
      } catch (caught) {
        setError(formatError(caught));
      }

      const approved = window.confirm(dappApprovalDialogMessage(event.payload));
      invoke("respond_dapp_approval", { requestId: event.payload.requestId, approved }).catch((caught) => {
        setError(formatError(caught));
        setDappApprovalRequests((current) => [...current, event.payload]);
      });
    })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((caught) => {
        setError(formatError(caught));
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runningInTauri]);

  useEffect(() => {
    if (!runningInTauri || networkWallets.length === 0) {
      setSyncStatuses([]);
      return;
    }

    invoke("set_active_sync_wallet", { walletId: prioritySyncWalletId }).catch((caught) => {
      setError(formatError(caught));
    });
  }, [networkWallets.length, prioritySyncWalletId, runningInTauri]);

  async function handleNetworkChange(network: MidnightNetwork) {
    setConfig((current) => ({ ...current, network }));
    const nextNetworkWallets = config.wallets.filter((wallet) => (wallet.network ?? "preprod") === network);
    setSelectedWalletId(nextNetworkWallets[0]?.id ?? null);

    try {
      const nextConfig = await invoke<AppConfig>("set_network", { network });
      setConfig(nextConfig);
      const persistedNetworkWallets = nextConfig.wallets.filter((wallet) => (wallet.network ?? "preprod") === nextConfig.network);
      setSelectedWalletId((currentWalletId) =>
        currentWalletId && persistedNetworkWallets.some((wallet) => wallet.id === currentWalletId)
          ? currentWalletId
          : persistedNetworkWallets[0]?.id ?? null,
      );
      setError(null);
    } catch (caught) {
      setError(formatError(caught));
      loadConfig();
    }
  }

  async function handleAddWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const addresses = deriveWalletAddresses(walletPhrase, config.network);
      const nextConfig = await invoke<AppConfig>("add_wallet", {
        request: {
          id: addresses.unshielded,
          name: walletName,
          phrase: walletPhrase,
          network: config.network,
          addresses,
        },
      });
      setConfig(nextConfig);
      setWalletName("");
      setWalletPhrase("");
      setShowAddWallet(false);
      setSelectedWalletId(addresses.unshielded);
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

  async function respondToDappApproval(requestId: string, approved: boolean) {
    setDappApprovalRequests((current) => current.filter((request) => request.requestId !== requestId));
    try {
      await invoke("respond_dapp_approval", { requestId, approved });
    } catch (caught) {
      setError(formatError(caught));
    }
  }

  const activeDappApprovalRequest = dappApprovalRequests[0] ?? null;

  return (
    <div className="app-frame">
      <SideMenu
        activeTab={activeTab}
        wallets={networkWallets}
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
          walletCount={networkWallets.length}
          walletName={walletName}
          walletPhrase={walletPhrase}
          onNameChange={setWalletName}
          onPhraseChange={setWalletPhrase}
          onSubmit={handleAddWallet}
          onClose={() => setShowAddWallet(false)}
        />
      ) : null}

      {activeDappApprovalRequest ? (
        <DappApprovalModal
          request={activeDappApprovalRequest}
          onApprove={() => respondToDappApproval(activeDappApprovalRequest.requestId, true)}
          onDeny={() => respondToDappApproval(activeDappApprovalRequest.requestId, false)}
        />
      ) : null}
    </div>
  );
}

function normalizeWallets(wallets: WalletConfig[]): WalletConfig[] {
  const seen = new Set<string>();
  const normalized: WalletConfig[] = [];

  for (const wallet of wallets) {
    const network = wallet.network ?? "preprod";
    let nextWallet = { ...wallet, network };

    try {
      const addresses = deriveWalletAddresses(wallet.phrase, network);
      nextWallet = {
        ...nextWallet,
        id: addresses.unshielded,
        addresses,
      };
    } catch {
      // Keep invalid legacy entries visible so the user can recover or remove them later.
    }

    const key = `${nextWallet.network}:${nextWallet.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(nextWallet);
  }

  return normalized;
}

function walletsChanged(left: WalletConfig[], right: WalletConfig[]): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function DappApprovalModal({
  request,
  onApprove,
  onDeny,
}: {
  request: DappApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const title = request.kind === "balance" ? "Approve transaction balancing" : "Connect dapp";

  return (
    <div className="modal-backdrop">
      <div className="modal dapp-approval-modal">
        <div>
          <p className="eyebrow">DApp Connector</p>
          <h2>{title}</h2>
        </div>
        <dl className="dapp-approval-details">
          <div>
            <dt>Client</dt>
            <dd>{request.identity}</dd>
          </div>
          {request.walletName ? (
            <div>
              <dt>Wallet</dt>
              <dd>{request.walletName}</dd>
            </div>
          ) : null}
          {request.network ? (
            <div>
              <dt>Network</dt>
              <dd>{request.network}</dd>
            </div>
          ) : null}
          {request.txPreview ? (
            <div>
              <dt>Transaction</dt>
              <dd>{request.txPreview}</dd>
            </div>
          ) : null}
        </dl>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onDeny}>
            Deny
          </button>
          <button type="button" onClick={onApprove}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

function dappApprovalDialogMessage(request: DappApprovalRequest) {
  const action = request.kind === "balance" ? "approve transaction balancing" : "connect to your wallet API";
  const details = [`${request.identity} wants to ${action}.`];

  if (request.walletName) {
    details.push(`Wallet: ${request.walletName}`);
  }

  if (request.network) {
    details.push(`Network: ${request.network}`);
  }

  if (request.txPreview) {
    details.push(`Transaction: ${request.txPreview}`);
  }

  details.push("", "Allow this request?");
  return details.join("\n");
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
