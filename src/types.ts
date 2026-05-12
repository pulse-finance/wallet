export type AppTab = "wallets" | "dapps";

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
  wallets: WalletConfig[];
  connectedWalletId: string | null;
};

export type ProofServerStatus = {
  url: string;
  online: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
};
