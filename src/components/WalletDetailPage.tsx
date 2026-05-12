import { AssetBalance, SyncPartStatus, WalletConfig, WalletSyncStatus, WalletTransaction } from "../types";
import { DerivedWalletDisplay } from "../walletAddresses";

type WalletDetailPageProps = {
  wallet: WalletConfig;
  displayAddresses: DerivedWalletDisplay["addresses"];
  syncStatus: WalletSyncStatus | null;
  connected: boolean;
  onConnect: () => void;
};

export function WalletDetailPage({
  wallet,
  displayAddresses,
  syncStatus,
  connected,
  onConnect,
}: WalletDetailPageProps) {
  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="breadcrumb">Wallets / {wallet.name}</p>
          <h1>{wallet.name}</h1>
        </div>
        <button type="button" onClick={onConnect} disabled={connected}>
          {connected ? "Connected to DApps" : "Use for DApps"}
        </button>
      </div>
      <div className="address-list">
        <AddressRow label="Unshielded" value={displayAddresses.unshielded.value} error={displayAddresses.unshielded.error} />
        <AddressRow label="Shielded" value={displayAddresses.shielded.value} error={displayAddresses.shielded.error} />
        <AddressRow label="Dust" value={displayAddresses.dust.value} error={displayAddresses.dust.error} />
      </div>
      <div className="sync-panel">
        <h2>Background sync</h2>
        <div className="sync-summary">
          <strong>{syncStatus ? `${syncStatus.percentage}%` : "Pending"}</strong>
          <span>{syncStatus?.active ? "Priority sync" : "Background sync"}</span>
        </div>
        {syncStatus ? (
          <div className="sync-parts">
            <SyncPart label="Shielded" part={syncStatus.shielded} />
            <SyncPart label="Unshielded" part={syncStatus.unshielded} />
            <SyncPart label="Dust" part={syncStatus.dust} />
          </div>
        ) : null}
        {syncStatus?.error ? <p className="sync-error">{syncStatus.error}</p> : null}
      </div>
      <div className="wallet-data-grid">
        <AssetPanel title="Shielded assets" assets={syncStatus?.shieldedAssets ?? []} />
        <AssetPanel title="Unshielded assets" assets={syncStatus?.unshieldedAssets ?? []} />
        <div className="data-panel">
          <h2>Dust balance</h2>
          <p className="balance-value">{syncStatus?.dustBalance ?? "Pending"}</p>
        </div>
      </div>
      <div className="data-panel tx-history-panel">
        <h2>Transaction history</h2>
        <TransactionHistory transactions={syncStatus?.transactionHistory ?? []} />
      </div>
    </section>
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

function SyncPart({ label, part }: { label: string; part: SyncPartStatus }) {
  return (
    <div className="sync-part">
      <span>{label}</span>
      <progress value={part.currentIndex} max={part.highestIndex || 1} />
      <code>
        {part.currentIndex} / {part.highestIndex}
      </code>
    </div>
  );
}

function AssetPanel({ title, assets }: { title: string; assets: AssetBalance[] }) {
  return (
    <div className="data-panel">
      <h2>{title}</h2>
      {assets.length > 0 ? (
        <div className="asset-list">
          {assets.map((asset) => (
            <div key={asset.tokenType} className="asset-row">
              <code>{asset.tokenType}</code>
              <span>{asset.amount}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No assets found</p>
      )}
    </div>
  );
}

function TransactionHistory({ transactions }: { transactions: WalletTransaction[] }) {
  if (transactions.length === 0) {
    return <p className="muted">No transactions found</p>;
  }

  return (
    <div className="tx-list">
      {transactions.map((transaction) => (
        <div key={transaction.hash} className="tx-row">
          <code>{transaction.hash}</code>
          <span>{transaction.status}</span>
          <span>{transaction.timestamp ?? "Unknown time"}</span>
          <span>{transaction.fees ? `${transaction.fees} fees` : "No fee data"}</span>
        </div>
      ))}
    </div>
  );
}
