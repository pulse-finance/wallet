import { WalletConfig } from "../types";

type WalletDetailPageProps = {
  wallet: WalletConfig;
  connected: boolean;
  onConnect: () => void;
};

export function WalletDetailPage({ wallet, connected, onConnect }: WalletDetailPageProps) {
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
        <AddressRow label="Unshielded" value={wallet.addresses.unshielded} />
        <AddressRow label="Shielded" value={wallet.addresses.shielded} />
        <AddressRow label="Dust" value={wallet.addresses.dust} />
      </div>
      <div className="sync-panel">
        <h2>Background sync</h2>
        <p>
          Wallet sync will run in the background once the Midnight ledger integration is connected. This view is ready
          to surface sync state per wallet.
        </p>
      </div>
    </section>
  );
}

function AddressRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="address-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}
