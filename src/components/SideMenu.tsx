import { AppTab, WalletConfig } from "../types";

type SideMenuProps = {
  activeTab: AppTab;
  wallets: WalletConfig[];
  selectedWalletId: string | null;
  connectedWalletId: string | null;
  onSelectWallets: () => void;
  onSelectWallet: (walletId: string) => void;
  onSelectDapps: () => void;
};

export function SideMenu({
  activeTab,
  wallets,
  selectedWalletId,
  connectedWalletId,
  onSelectWallets,
  onSelectWallet,
  onSelectDapps,
}: SideMenuProps) {
  return (
    <aside className="side-menu">
      <div className="brand">
        <span className="brand-mark">P</span>
        <span>Pulse Wallet</span>
      </div>

      <nav className="main-nav" aria-label="Primary">
        <button type="button" className={activeTab === "wallets" && !selectedWalletId ? "active" : ""} onClick={onSelectWallets}>
          Wallets
        </button>
        <div className="wallet-nav-list">
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              className={activeTab === "wallets" && selectedWalletId === wallet.id ? "nested active" : "nested"}
              onClick={() => onSelectWallet(wallet.id)}
            >
              <span>{wallet.name}</span>
              {connectedWalletId === wallet.id ? <span className="connector-dot" title="Connected wallet" /> : null}
            </button>
          ))}
        </div>
        <button type="button" className={activeTab === "dapps" ? "active" : ""} onClick={onSelectDapps}>
          DApps
        </button>
      </nav>
    </aside>
  );
}
