import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowDownToLine, ChevronLeft, ChevronRight, SendHorizontal, Wallet } from "lucide-react";
import { MidnightLogo } from "./MidnightLogo";
import { AssetBalance, MidnightNetwork, WalletConfig, WalletSyncStatus, WalletTransaction } from "../types";
import { DerivedWalletDisplay } from "../walletAddresses";

const ASSET_CARD_MIN_WIDTH = 220;
const ASSET_GRID_GAP = 16;
const ASSET_GRID_ROWS = 3;
const TRANSACTIONS_PER_PAGE = 20;
const NIGHT_POLICY_ID = "0000000000000000000000000000000000000000000000000000000000000000";

type WalletDetailPageProps = {
  network: MidnightNetwork;
  wallet: WalletConfig;
  displayAddresses: DerivedWalletDisplay["addresses"];
  syncStatus: WalletSyncStatus | null;
};

type WalletAsset = {
  id: string;
  label: string;
  amount: string;
};

export function WalletDetailPage({ network, wallet, displayAddresses, syncStatus }: WalletDetailPageProps) {
  const [showSendModal, setShowSendModal] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [assetPage, setAssetPage] = useState(1);
  const [transactionPage, setTransactionPage] = useState(1);
  const [assetColumns, setAssetColumns] = useState(3);
  const assetGridRef = useRef<HTMLDivElement | null>(null);

  const assets = useMemo(() => buildWalletAssets(syncStatus), [syncStatus]);
  const sendableAssets = useMemo(() => assets.filter((asset) => asset.id !== "dust"), [assets]);
  const assetsPerPage = Math.max(assetColumns * ASSET_GRID_ROWS, 1);

  const assetPageCount = Math.max(1, Math.ceil(assets.length / assetsPerPage));
  const transactionPageCount = Math.max(1, Math.ceil((syncStatus?.transactionHistory.length ?? 0) / TRANSACTIONS_PER_PAGE));

  useEffect(() => {
    setAssetPage((current) => Math.min(current, assetPageCount));
  }, [assetPageCount]);

  useEffect(() => {
    setTransactionPage((current) => Math.min(current, transactionPageCount));
  }, [transactionPageCount]);

  useEffect(() => {
    const element = assetGridRef.current;
    if (!element) {
      return;
    }

    const updateColumns = () => {
      const width = element.clientWidth;
      const nextColumns = Math.max(1, Math.floor((width + ASSET_GRID_GAP) / (ASSET_CARD_MIN_WIDTH + ASSET_GRID_GAP)));
      setAssetColumns(nextColumns);
    };

    updateColumns();

    const observer = new ResizeObserver(updateColumns);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visibleAssets = assets.slice((assetPage - 1) * assetsPerPage, assetPage * assetsPerPage);
  const visibleTransactions = (syncStatus?.transactionHistory ?? []).slice(
    (transactionPage - 1) * TRANSACTIONS_PER_PAGE,
    transactionPage * TRANSACTIONS_PER_PAGE,
  );

  return (
    <section className="page">
      <div className="page-header wallet-header">
        <div className="page-title-with-icon">
          <Wallet size={24} aria-hidden="true" />
          <h1>{wallet.name}</h1>
        </div>
        <div className="sync-status-chip">{syncStatus?.percentage === 100 ? "Synced" : `Syncing ${syncStatus?.percentage ?? 0}%`}</div>
      </div>

      <section className="wallet-section wallet-actions-section">
        <div className="section-header">
          <h2>Actions</h2>
        </div>
        <div className="wallet-actions">
          <button type="button" className="wallet-action-card wallet-action-receive" onClick={() => setShowReceiveModal(true)}>
            <ArrowDownToLine size={28} aria-hidden="true" />
            <span>Receive</span>
          </button>
          <button type="button" className="wallet-action-card wallet-action-send" onClick={() => setShowSendModal(true)}>
            <SendHorizontal size={28} aria-hidden="true" />
            <span>Send</span>
          </button>
        </div>
      </section>

      <section className="wallet-section">
        <div className="section-header">
          <h2>Assets</h2>
          <PaginationControls page={assetPage} pageCount={assetPageCount} onPageChange={setAssetPage} />
        </div>
        <div ref={assetGridRef} className="asset-grid-measure">
          {visibleAssets.length > 0 ? (
            <div className="asset-card-grid">
            {visibleAssets.map((asset) => (
              <article key={asset.id} className="data-panel asset-card">
                <div className="asset-card-header">
                  <h3 title={asset.label}>{shortenAssetLabel(asset.label)}</h3>
                  <MidnightLogo className="asset-card-logo" />
                </div>
                <p className="balance-value">{formatAssetAmount(asset)}</p>
              </article>
            ))}
            </div>
          ) : (
            <div className="data-panel">
              <p className="muted">No assets found</p>
            </div>
          )}
        </div>
      </section>

      <section className="wallet-section">
        <div className="section-header">
          <h2>History</h2>
          <PaginationControls page={transactionPage} pageCount={transactionPageCount} onPageChange={setTransactionPage} />
        </div>
        <div className="data-panel tx-table-panel">
          <TransactionTable network={network} transactions={visibleTransactions} />
        </div>
      </section>

      {showSendModal ? (
        <SendModal assets={sendableAssets} onClose={() => setShowSendModal(false)} />
      ) : null}

      {showReceiveModal ? (
        <ReceiveModal
          displayAddresses={displayAddresses}
          onClose={() => setShowReceiveModal(false)}
        />
      ) : null}
    </section>
  );
}

function SendModal({ assets, onClose }: { assets: WalletAsset[]; onClose: () => void }) {
  const [network, setNetwork] = useState("Midnight");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [assetId, setAssetId] = useState(assets[0]?.id ?? "");

  useEffect(() => {
    if (!assets.some((asset) => asset.id === assetId)) {
      setAssetId(assets[0]?.id ?? "");
    }
  }, [assetId, assets]);

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal wallet-flow-modal" onSubmit={(event) => event.preventDefault()}>
        <div className="modal-header">
          <h2>Send</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            x
          </button>
        </div>
        <label className="settings-field">
          <span>Network</span>
          <select value={network} onChange={(event) => setNetwork(event.currentTarget.value)}>
            <option value="Midnight">Midnight</option>
          </select>
        </label>
        <label className="settings-field">
          <span>Destination address</span>
          <input value={destination} onChange={(event) => setDestination(event.currentTarget.value)} />
        </label>
        <div className="amount-row">
          <label className="settings-field">
            <span>Amount</span>
            <input value={amount} onChange={(event) => setAmount(event.currentTarget.value)} inputMode="decimal" />
          </label>
          <label className="settings-field">
            <span>Asset</span>
            <select value={assetId} onChange={(event) => setAssetId(event.currentTarget.value)} disabled={assets.length === 0}>
              {assets.length > 0 ? assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>) : <option value="">No sendable assets</option>}
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="submit" disabled>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function ReceiveModal({
  displayAddresses,
  onClose,
}: {
  displayAddresses: DerivedWalletDisplay["addresses"];
  onClose: () => void;
}) {
  const [network, setNetwork] = useState("Midnight");

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wallet-flow-modal">
        <div className="modal-header">
          <h2>Receive</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            x
          </button>
        </div>
        <label className="settings-field">
          <span>Network</span>
          <select value={network} onChange={(event) => setNetwork(event.currentTarget.value)}>
            <option value="Midnight">Midnight</option>
          </select>
        </label>
        <div className="address-list receive-address-list">
          <AddressRow label="Unshielded" value={displayAddresses.unshielded.value} error={displayAddresses.unshielded.error} />
          <AddressRow label="Shielded" value={displayAddresses.shielded.value} error={displayAddresses.shielded.error} />
          <AddressRow label="Dust" value={displayAddresses.dust.value} error={displayAddresses.dust.error} />
        </div>
      </div>
    </div>
  );
}

function AddressRow({ label, value, error }: { label: string; value: string | null; error: string | null }) {
  return (
    <div className="address-row">
      <span>{label}</span>
      <div>
        <code>{value ?? "Unavailable"}</code>
        {error ? <p className="sync-error">Derivation failed: {error}</p> : null}
      </div>
    </div>
  );
}

function PaginationControls({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="pagination-controls">
      <button type="button" className="icon-button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <span>{page} / {pageCount}</span>
      <button type="button" className="icon-button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function TransactionTable({
  network,
  transactions,
}: {
  network: MidnightNetwork;
  transactions: WalletTransaction[];
}) {
  if (transactions.length === 0) {
    return <p className="muted">No transactions found</p>;
  }

  return (
    <div className="tx-table">
      <div className="tx-table-row tx-table-head">
        <span>Transaction</span>
        <span>Network</span>
        <span>Status</span>
        <span>Timestamp</span>
      </div>
      {transactions.map((transaction) => (
        <div key={transaction.hash} className="tx-table-row">
          <a
            className="tx-link"
            href={getExplorerTransactionUrl(network, transaction.hash)}
            onClick={(event) => {
              event.preventDefault();
              void openTransactionInExplorer(network, transaction.hash);
            }}
            title={transaction.hash}
          >
            <code>{shortenHash(transaction.hash)}</code>
          </a>
          <span>Midnight</span>
          <span>{transaction.status}</span>
          <span>{transaction.timestamp ?? "Unknown time"}</span>
        </div>
      ))}
    </div>
  );
}

function buildWalletAssets(syncStatus: WalletSyncStatus | null): WalletAsset[] {
  if (!syncStatus) {
    return [];
  }

  const assets: WalletAsset[] = [];

  if (syncStatus.dustBalance && !isZeroAmount(syncStatus.dustBalance)) {
    assets.push({
      id: "dust",
      label: "DUST",
      amount: syncStatus.dustBalance,
    });
  }

  const unshieldedAssets = syncStatus.unshieldedAssets.map((asset) => toWalletAssetLabel(asset, "unshielded"));
  const shieldedAssets = syncStatus.shieldedAssets.map((asset) => toWalletAssetLabel(asset, "shielded"));

  return [...assets, ...unshieldedAssets, ...shieldedAssets];
}

function toWalletAssetLabel(asset: AssetBalance, scope: "unshielded" | "shielded"): WalletAsset {
  if (scope === "unshielded" && asset.tokenType === NIGHT_POLICY_ID) {
    return {
      id: `unshielded-${asset.tokenType}`,
      label: "Unshielded NIGHT",
      amount: asset.amount,
    };
  }

  return {
    id: `${scope}-${asset.tokenType}`,
    label: asset.tokenType,
    amount: asset.amount,
  };
}

function isZeroAmount(amount: string): boolean {
  return Number(amount) === 0;
}

function shortenAssetLabel(label: string): string {
  if (label === "Unshielded NIGHT" || label === "DUST" || label.length <= 22) {
    return label;
  }

  return `${label.slice(0, 10)}...${label.slice(-8)}`;
}

function formatAssetAmount(asset: WalletAsset): string {
  if (asset.label === "DUST") {
    return formatDecimalAmount(asset.amount, 15);
  }

  if (asset.label === "Unshielded NIGHT") {
    return formatDecimalAmount(asset.amount, 6);
  }

  return asset.amount;
}

function formatDecimalAmount(rawAmount: string, decimals: number): string {
  if (!/^-?\d+$/.test(rawAmount)) {
    return rawAmount;
  }

  const negative = rawAmount.startsWith("-");
  const digits = negative ? rawAmount.slice(1) : rawAmount;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  const formattedWhole = whole.replace(/^0+(?=\d)/, "");
  const value = fractional ? `${formattedWhole}.${fractional}` : formattedWhole;
  return negative ? `-${value}` : value;
}

async function openTransactionInExplorer(network: MidnightNetwork, hash: string): Promise<void> {
  const url = getExplorerTransactionUrl(network, hash);

  if (isTauri()) {
    await invoke("open_external_url", { url });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function getExplorerTransactionUrl(network: MidnightNetwork, hash: string): string {
  const baseUrl =
    network === "mainnet" ? "https://www.midnightexplorer.com/transactions" : "https://preprod.midnightexplorer.com/transactions";
  return `${baseUrl}/${hash}`;
}

function shortenHash(hash: string): string {
  if (hash.length <= 18) {
    return hash;
  }

  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}
