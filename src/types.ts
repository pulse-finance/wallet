export type AppTab = "wallets" | "settings";

export type MidnightNetwork = "preprod" | "mainnet";

export type WalletAddresses = {
  unshielded: string;
  shielded: string;
  dust: string;
};

export type WalletConfig = {
  id: string;
  name: string;
  phrase: string;
  addresses: WalletAddresses;
};

export type AppConfig = {
  network: MidnightNetwork;
  endpoints: NetworkEndpoints;
  wallets: WalletConfig[];
};

export type NetworkEndpoints = {
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  nodeWsUrl: string;
};

export type ProofServerStatus = {
  url: string;
  online: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
};

export type SyncPartStatus = {
  currentIndex: number;
  highestIndex: number;
};

export type WalletSyncStatus = {
  walletId: string;
  percentage: number;
  shielded: SyncPartStatus;
  unshielded: SyncPartStatus;
  dust: SyncPartStatus;
  active: boolean;
  updatedAtMs: number;
  synced: boolean;
  syncing: boolean;
  error: string | null;
  shieldedAssets: AssetBalance[];
  unshieldedAssets: AssetBalance[];
  dustBalance: string | null;
  transactionHistory: WalletTransaction[];
};

export type AssetBalance = {
  tokenType: string;
  amount: string;
};

export type WalletTransaction = {
  hash: string;
  status: string;
  timestamp: string | null;
  fees: string | null;
  identifiers: string[];
};
