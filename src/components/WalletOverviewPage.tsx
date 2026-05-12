import { WalletConfig, WalletSyncStatus } from "../types";
import { DerivedWalletDisplay } from "../walletAddresses";

type WalletOverviewPageProps = {
  wallets: WalletConfig[];
  displayAddressesByWalletId: Map<string, DerivedWalletDisplay>;
  syncStatuses: WalletSyncStatus[];
  onAdd: () => void;
  onOpen: (walletId: string) => void;
};

export function WalletOverviewPage({
  wallets,
  displayAddressesByWalletId,
  syncStatuses,
  onAdd,
  onOpen,
}: WalletOverviewPageProps) {
  return (
    <section className="page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Wallets</p>
          <h1>Wallets</h1>
        </div>
        <button type="button" onClick={onAdd}>
          Add wallet
        </button>
      </div>
      <div className="wallet-grid">
        {wallets.map((wallet) => (
          <button key={wallet.id} type="button" className="wallet-card" onClick={() => onOpen(wallet.id)}>
            <span className="wallet-card-top">
              <span className="wallet-avatar">{wallet.name.slice(0, 1).toUpperCase()}</span>
              <SyncBadge syncStatus={syncStatuses.find((status) => status.walletId === wallet.id)} />
            </span>
            <span className="wallet-card-name">{wallet.name}</span>
            <span className="wallet-card-address">
              {displayAddressesByWalletId.get(wallet.id)?.addresses.unshielded.value ??
                displayAddressesByWalletId.get(wallet.id)?.addresses.unshielded.error ??
                "Address unavailable"}
            </span>
          </button>
        ))}
        <button type="button" className="wallet-card add-card" onClick={onAdd}>
          <span className="add-symbol">+</span>
          <span>Add wallet</span>
        </button>
      </div>
    </section>
  );
}

function SyncBadge({ syncStatus }: { syncStatus?: WalletSyncStatus }) {
  return <span className="sync-badge">{syncStatus ? `${syncStatus.percentage}% synced` : "Sync pending"}</span>;
}
