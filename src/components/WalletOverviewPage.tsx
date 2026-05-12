import { WalletConfig } from "../types";

type WalletOverviewPageProps = {
  wallets: WalletConfig[];
  onAdd: () => void;
  onOpen: (walletId: string) => void;
};

export function WalletOverviewPage({ wallets, onAdd, onOpen }: WalletOverviewPageProps) {
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
            <span className="wallet-avatar">{wallet.name.slice(0, 1).toUpperCase()}</span>
            <span className="wallet-card-name">{wallet.name}</span>
            <span className="wallet-card-address">{wallet.addresses.unshielded}</span>
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
