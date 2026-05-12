import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { Buffer } from "buffer";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import {
  createKeystore,
  DustWallet,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  validateMnemonic,
  WalletEntrySchema,
  WalletFacade,
  type FacadeState,
  type WalletEntry,
} from "@midnight-ntwrk/wallet-sdk";
import {
  deriveUnshieldedAddress,
  migrateWalletCache,
  readWalletCache,
  snapshotFromState,
  snapshotIndexProgress,
  writeWalletCacheSnapshot,
  type WalletSdkSnapshot,
} from "./wallet-cache.js";

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

const CONFIG_POLL_MS = 2_000;
const STATUS_WRITE_INTERVAL_MS = 1_000;
const COMPLETED_WALLET_RESYNC_INTERVAL_MS = 10_000;
const WALLET_START_STAGGER_MS = 250;
const TX_HISTORY_REFRESH_INTERVAL_MS = 10_000;
const SNAPSHOT_SAVE_DEBOUNCE_MS = 10_000;
const SNAPSHOT_SAVE_INDEX_DELTA = 1_000;
const SDK_BATCH_UPDATE_SIZE = 500;
const SDK_BATCH_UPDATE_TIMEOUT_MS = 25;
const SDK_BATCH_UPDATE_SPACING_MS = 0;

type MidnightNetwork = "preprod" | "mainnet" | string;
type Timer = ReturnType<typeof setTimeout>;
type WalletFacadeInstance = Awaited<ReturnType<typeof WalletFacade.init>>;

type AppConfig = {
  network: MidnightNetwork;
  endpoints: NetworkEndpoints;
  wallets: WalletConfig[];
};

type NetworkEndpoints = {
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  nodeWsUrl: string;
};

type WalletConfig = {
  id: string;
  legacyId?: string;
  name: string;
  phrase: string;
  network?: MidnightNetwork;
  addresses?: Partial<WalletAddresses>;
};

type WalletAddresses = {
  unshielded: string;
  shielded: string;
  dust: string;
};

type ControlFile = {
  activeWalletId: string | null;
};

type SyncPartStatus = {
  currentIndex: number;
  highestIndex: number;
};

type AssetBalance = {
  tokenType: string;
  amount: string;
};

type WalletTransaction = {
  hash: string;
  status: string;
  timestamp: string | null;
  fees: string | null;
  identifiers: string[];
};

type WalletSyncStatus = {
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

type ProgressLike = {
  appliedIndex?: bigint | number;
  appliedId?: bigint | number;
  highestRelevantWalletIndex?: bigint | number;
  highestTransactionId?: bigint | number;
  highestIndex?: bigint | number;
  isConnected?: boolean;
};

type SyncProgressCursor = {
  cursor: string;
  indexProgress: number;
};

type SyncManager = {
  stop(): Promise<void>;
};

type WalletRuntime = {
  hasCompletedFullSync(): boolean;
  stop(): Promise<void>;
};

type StartWalletSyncRequest = {
  config: AppConfig;
  wallet: WalletConfig;
  active: boolean;
  onStatus(status: WalletSyncStatus): void;
};

type SnapshotWriter = {
  shouldSave(state: FacadeState): boolean;
  schedule(snapshot: WalletSdkSnapshot): Promise<void>;
  flush(): Promise<void>;
};

const args = parseArgs(process.argv.slice(2));
const configPath = requiredArg(args, "config");
const cacheDir = requiredArg(args, "cache-dir");
const syncDir = path.join(cacheDir, "wallet-sync");
const statusPath = path.join(syncDir, "status.json");
const controlPath = path.join(syncDir, "control.json");

fs.mkdirSync(syncDir, { recursive: true });
removeStaleRootCacheFiles();

let currentSignature: string | null = null;
let manager: SyncManager | null = null;

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});

await reloadIfNeeded();
setInterval(() => {
  void reloadIfNeeded();
}, CONFIG_POLL_MS);

async function shutdown(code: number): Promise<void> {
  if (manager) {
    await manager.stop();
  }
  process.exit(code);
}

async function reloadIfNeeded(): Promise<void> {
  const config = readJson<AppConfig>(configPath, defaultConfig());
  const control = readJson<ControlFile>(controlPath, { activeWalletId: null });
  const networkWallets = activeNetworkWallets(config);
  const activeWalletId = canonicalActiveWalletId(control.activeWalletId, networkWallets);
  if (activeWalletId !== control.activeWalletId) {
    atomicWriteJson(controlPath, { ...control, activeWalletId, updatedAtMs: Date.now() });
  }
  const signature = JSON.stringify({
    network: config.network,
    endpoints: config.endpoints,
    wallets:
      networkWallets.map((wallet) => ({
        id: wallet.id,
        phrase: wallet.phrase,
        name: wallet.name,
      })) ?? [],
    activeWalletId,
  });

  if (signature === currentSignature) return;
  currentSignature = signature;

  if (manager) {
    await manager.stop();
  }

  manager = startSyncManager(config, activeWalletId);
}

function startSyncManager(config: AppConfig, priorityWalletId: string | null): SyncManager {
  let stopped = false;
  const runtimes = new Map<string, WalletRuntime>();
  const restartingWallets = new Set<string>();
  const statuses = new Map<string, WalletSyncStatus>();
  let statusTimer: Timer | null = null;
  let resyncTimer: Timer | null = null;

  const networkWallets = activeNetworkWallets(config);
  const wallets = [...networkWallets].sort((left, right) => {
    if (left.id === priorityWalletId) return -1;
    if (right.id === priorityWalletId) return 1;
    return 0;
  });

  for (const wallet of networkWallets) {
    statuses.set(wallet.id, pendingStatus(wallet.id, wallet.id === priorityWalletId));
  }
  writeStatuses();

  function publish(status: WalletSyncStatus): void {
    statuses.set(status.walletId, status);
    scheduleStatusWrite();
  }

  function scheduleStatusWrite(): void {
    if (statusTimer !== null) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      writeStatuses();
    }, STATUS_WRITE_INTERVAL_MS);
  }

  function writeStatuses(): void {
    const status = {
      updatedAtMs: Date.now(),
      wallets: networkWallets.map((wallet) => statuses.get(wallet.id) ?? pendingStatus(wallet.id, wallet.id === priorityWalletId)),
    };
    atomicWriteJson(statusPath, status);
  }

  void (async () => {
    for (const wallet of wallets) {
      if (stopped) return;

      await startRuntime(wallet);
      await delay(WALLET_START_STAGGER_MS);
    }
  })();

  resyncTimer = setInterval(() => {
    void resyncCompletedWallets();
  }, COMPLETED_WALLET_RESYNC_INTERVAL_MS);

  async function startRuntime(wallet: WalletConfig): Promise<void> {
    try {
      const runtime = await startWalletSync({
        config,
        wallet,
        active: wallet.id === priorityWalletId,
        onStatus: publish,
      });
      runtimes.set(wallet.id, runtime);
    } catch (caught) {
      const message = formatError(caught);
      publish({ ...pendingStatus(wallet.id, wallet.id === priorityWalletId), error: message, syncing: false });
      console.error(`[wallet-sync:${wallet.id}] ${message}`);
    }
  }

  async function resyncCompletedWallets(): Promise<void> {
    if (stopped) return;

    for (const wallet of wallets) {
      if (stopped) return;

      const runtime = runtimes.get(wallet.id);
      if (!runtime?.hasCompletedFullSync() || restartingWallets.has(wallet.id)) {
        continue;
      }

      restartingWallets.add(wallet.id);
      try {
        await runtime.stop();
        runtimes.delete(wallet.id);
        if (!stopped) {
          await startRuntime(wallet);
        }
      } finally {
        restartingWallets.delete(wallet.id);
      }

      await delay(WALLET_START_STAGGER_MS);
    }
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (statusTimer !== null) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      if (resyncTimer !== null) {
        clearInterval(resyncTimer);
        resyncTimer = null;
      }
      await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.stop()));
      runtimes.clear();
      writeStatuses();
    },
  };
}

async function startWalletSync({ config, wallet, active, onStatus }: StartWalletSyncRequest): Promise<WalletRuntime> {
  if (!validateMnemonic(wallet.phrase)) {
    throw new Error(`${wallet.name} has an invalid wallet phrase`);
  }

  await migrateWalletCache(syncDir, config.network, wallet);
  const snapshot = readWalletCache(syncDir, config.network, wallet);
  const seed = mnemonicToSeedSync(wallet.phrase);
  const hdWallet = HDWallet.fromSeed(seed);

  if (hdWallet.type !== "seedOk") {
    throw new Error(`Failed to initialize HD wallet for ${wallet.name}`);
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);

  if (derivationResult.type !== "keysDerived") {
    throw new Error(`Failed to derive Midnight keys for ${wallet.name}`);
  }

  hdWallet.hdWallet.clear();

  const networkId = config.network;
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], networkId);
  const txHistoryStorage = snapshot?.txHistory
    ? InMemoryTransactionHistoryStorage.restore(snapshot.txHistory, WalletEntrySchema, mergeWalletEntries)
    : new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);

  const sdkConfig = {
    networkId,
    costParameters: {
      feeBlocksMargin: 5,
    },
    relayURL: new URL(config.endpoints.nodeWsUrl),
    provingServerUrl: new URL("http://localhost:6300"),
    indexerClientConnection: {
      indexerHttpUrl: config.endpoints.indexerUrl,
      indexerWsUrl: config.endpoints.indexerWsUrl,
    },
    batchUpdates: {
      size: SDK_BATCH_UPDATE_SIZE,
      timeout: SDK_BATCH_UPDATE_TIMEOUT_MS,
      spacing: SDK_BATCH_UPDATE_SPACING_MS,
    },
    txHistoryStorage,
  };

  const facade = await WalletFacade.init({
    configuration: sdkConfig,
    shielded: (configuration) =>
      snapshot?.shieldedState
        ? ShieldedWallet(configuration).restore(snapshot.shieldedState)
        : ShieldedWallet(configuration).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (configuration) =>
      snapshot?.unshieldedState
        ? UnshieldedWallet(configuration).restore(snapshot.unshieldedState)
        : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (configuration) =>
      snapshot?.dustState
        ? DustWallet(configuration).restore(snapshot.dustState)
        : DustWallet(configuration).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  const snapshotSaver = createSyncProgressSnapshotSaver(config, wallet);
  const statusPublisher = createStatusPublisher(wallet.id, active, facade);
  let completedFullSync = snapshot?.completedFullSync === true;
  const subscription = facade.state().subscribe({
    next: (state: FacadeState) => {
      void (async () => {
        const status = await statusPublisher.statusFromState(state);
        if (status.synced) {
          completedFullSync = true;
        }
        if (statusPublisher.shouldPublish(status)) {
          onStatus(status);
        }
        if (snapshotSaver.shouldSave(state)) {
          await snapshotSaver.schedule(await snapshotFromState(config.network, wallet, state, txHistoryStorage));
        }
      })();
    },
    error: (caught: unknown) => {
      onStatus({ ...pendingStatus(wallet.id, active), error: formatError(caught), syncing: false });
    },
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);

  return {
    hasCompletedFullSync(): boolean {
      return completedFullSync;
    },
    async stop(): Promise<void> {
      subscription.unsubscribe();
      await snapshotSaver.flush();
      await facade.stop();
    },
  };
}

async function statusFromFacadeState(
  walletId: string,
  active: boolean,
  state: FacadeState,
  transactionHistory: WalletTransaction[],
): Promise<WalletSyncStatus> {
  const shielded = syncPart(state.shielded.progress as ProgressLike);
  const unshielded = syncPart(state.unshielded.progress as ProgressLike);
  const dust = syncPart(state.dust.progress as ProgressLike);
  const percentage = syncPercentage([shielded, unshielded, dust]);

  return {
    walletId,
    percentage,
    shielded,
    unshielded,
    dust,
    active,
    updatedAtMs: Date.now(),
    synced: state.isSynced,
    syncing: !state.isSynced,
    error: null,
    shieldedAssets: balancesToAssets(state.shielded.balances as Record<string, unknown>),
    unshieldedAssets: balancesToAssets(state.unshielded.balances as Record<string, unknown>),
    dustBalance: stringifyAmount(state.dust.balance(new Date())),
    transactionHistory,
  };
}

function createStatusPublisher(walletId: string, active: boolean, facade: WalletFacadeInstance) {
  let lastPublishedAt = 0;
  let lastPublishedCursor: string | null = null;
  let lastHistoryRefreshAt = 0;
  let transactionHistory: WalletTransaction[] = [];

  return {
    async statusFromState(state: FacadeState): Promise<WalletSyncStatus> {
      const now = Date.now();
      if (state.isSynced || now - lastHistoryRefreshAt >= TX_HISTORY_REFRESH_INTERVAL_MS) {
        transactionHistory = (await facade.getAllFromTxHistory()).map(toWalletTransaction);
        lastHistoryRefreshAt = now;
      }

      return statusFromFacadeState(walletId, active, state, transactionHistory);
    },
    shouldPublish(status: WalletSyncStatus): boolean {
      const now = Date.now();
      const cursor = statusCursor(status);
      if (status.synced || status.error || cursor !== lastPublishedCursor || now - lastPublishedAt >= STATUS_WRITE_INTERVAL_MS) {
        lastPublishedAt = now;
        lastPublishedCursor = cursor;
        return true;
      }

      return false;
    },
  };
}

function createSyncProgressSnapshotSaver(config: AppConfig, wallet: WalletConfig): SnapshotWriter {
  let pendingSnapshot: WalletSdkSnapshot | null = null;
  let saveTimer: Timer | null = null;
  let lastSavedAt = 0;
  let lastSavedIndex = 0;
  let saveChain = Promise.resolve();
  let lastScheduledCursor: string | null = null;
  let syncedCheckpointScheduled = false;
  const walletId = wallet.id;

  function save(snapshot: WalletSdkSnapshot, indexProgress: number): Promise<void> {
    lastSavedAt = Date.now();
    lastSavedIndex = Math.max(lastSavedIndex, indexProgress);
    saveChain = saveChain
      .then(async () => {
        writeWalletCacheSnapshot(syncDir, config.network, wallet, snapshot);
      })
      .catch((caught: unknown) => {
        console.error(`[wallet-sync:${walletId}] failed to save sync checkpoint`, caught);
      });
    return saveChain;
  }

  return {
    shouldSave(state: FacadeState): boolean {
      const progress = syncProgressCursor(state);
      if (state.isSynced && !syncedCheckpointScheduled) {
        syncedCheckpointScheduled = true;
        return true;
      }

      if (!progress || progress.cursor === lastScheduledCursor) {
        return false;
      }

      lastScheduledCursor = progress.cursor;
      return true;
    },
    async schedule(snapshot: WalletSdkSnapshot): Promise<void> {
      pendingSnapshot = snapshot;
      const elapsed = Date.now() - lastSavedAt;
      const indexProgress = snapshotIndexProgress(snapshot);
      const indexDelta = indexProgress - lastSavedIndex;

      if (elapsed >= SNAPSHOT_SAVE_DEBOUNCE_MS || indexDelta >= SNAPSHOT_SAVE_INDEX_DELTA) {
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        const snapshotToSave = pendingSnapshot;
        pendingSnapshot = null;
        await save(snapshotToSave, indexProgress);
        return;
      }

      if (saveTimer === null) {
        saveTimer = setTimeout(() => {
          saveTimer = null;
          if (!pendingSnapshot) return;
          const snapshotToSave = pendingSnapshot;
          pendingSnapshot = null;
          void save(snapshotToSave, snapshotIndexProgress(snapshotToSave));
        }, SNAPSHOT_SAVE_DEBOUNCE_MS - elapsed);
      }
    },
    async flush(): Promise<void> {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (pendingSnapshot) {
        const snapshotToSave = pendingSnapshot;
        pendingSnapshot = null;
        await save(snapshotToSave, snapshotIndexProgress(snapshotToSave));
      }
      await saveChain;
    },
  };
}

function syncPart(progress: ProgressLike): SyncPartStatus {
  return {
    currentIndex: Number(progress.appliedIndex ?? progress.appliedId ?? 0n),
    highestIndex: Number(progress.highestRelevantWalletIndex ?? progress.highestTransactionId ?? progress.highestIndex ?? 0n),
  };
}

function syncProgressCursor(state: FacadeState): SyncProgressCursor | null {
  const shielded = syncPart(state.shielded.progress as ProgressLike);
  const unshielded = syncPart(state.unshielded.progress as ProgressLike);
  const dust = syncPart(state.dust.progress as ProgressLike);

  if (
    !isConnectedProgress(state.shielded.progress as ProgressLike) ||
    !isConnectedProgress(state.unshielded.progress as ProgressLike) ||
    !isConnectedProgress(state.dust.progress as ProgressLike)
  ) {
    return null;
  }

  const cursor = [
    shielded.currentIndex,
    shielded.highestIndex,
    unshielded.currentIndex,
    unshielded.highestIndex,
    dust.currentIndex,
    dust.highestIndex,
  ].join(":");

  return {
    cursor,
    indexProgress: shielded.currentIndex + unshielded.currentIndex + dust.currentIndex,
  };
}

function isConnectedProgress(progress: ProgressLike): boolean {
  return progress?.isConnected === true;
}

function statusCursor(status: WalletSyncStatus): string {
  return [
    status.percentage,
    status.synced,
    status.shielded.currentIndex,
    status.shielded.highestIndex,
    status.unshielded.currentIndex,
    status.unshielded.highestIndex,
    status.dust.currentIndex,
    status.dust.highestIndex,
    status.shieldedAssets.length,
    status.unshieldedAssets.length,
    status.transactionHistory.length,
  ].join(":");
}

function syncPercentage(parts: SyncPartStatus[]): number {
  const current = parts.reduce((sum, part) => sum + part.currentIndex, 0);
  const highest = parts.reduce((sum, part) => sum + part.highestIndex, 0);
  if (highest === 0) return 0;
  return Math.min(100, Math.floor((current / highest) * 100));
}

function balancesToAssets(balances: Record<string, unknown>): AssetBalance[] {
  return Object.entries(balances).map(([tokenType, amount]) => ({
    tokenType,
    amount: stringifyAmount(amount),
  }));
}

function toWalletTransaction(entry: WalletEntry): WalletTransaction {
  return {
    hash: String(entry.hash),
    status: String(entry.status),
    timestamp: entry.timestamp instanceof Date ? entry.timestamp.toISOString() : entry.timestamp ? String(entry.timestamp) : null,
    fees: entry.fees === undefined || entry.fees === null ? null : stringifyAmount(entry.fees),
    identifiers: Array.isArray(entry.identifiers) ? entry.identifiers.map(String) : [],
  };
}

function pendingStatus(walletId: string, active: boolean): WalletSyncStatus {
  return {
    walletId,
    percentage: 0,
    shielded: { currentIndex: 0, highestIndex: 0 },
    unshielded: { currentIndex: 0, highestIndex: 0 },
    dust: { currentIndex: 0, highestIndex: 0 },
    active,
    updatedAtMs: Date.now(),
    synced: false,
    syncing: true,
    error: null,
    shieldedAssets: [],
    unshieldedAssets: [],
    dustBalance: null,
    transactionHistory: [],
  };
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function stringifyAmount(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function defaultConfig(): AppConfig {
  return {
    network: "preprod",
    endpoints: {
      indexerUrl: "https://indexer.preprod.midnight.network/api/v4/graphql",
      indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
      nodeUrl: "https://rpc.preprod.midnight.network",
      nodeWsUrl: "wss://rpc.preprod.midnight.network/ws",
    },
    wallets: [],
  };
}

function activeNetworkWallets(config: AppConfig): WalletConfig[] {
  return (config.wallets ?? [])
    .filter((wallet) => (wallet.network ?? "preprod") === config.network)
    .map((wallet) => canonicalWalletConfig(wallet, config.network));
}

function canonicalWalletConfig(wallet: WalletConfig, network: MidnightNetwork): WalletConfig {
  try {
    const unshieldedAddress = deriveUnshieldedAddress(wallet.phrase, network);
    return {
      ...wallet,
      id: unshieldedAddress,
      legacyId: wallet.id === unshieldedAddress ? wallet.legacyId : wallet.id,
      addresses: {
        ...wallet.addresses,
        unshielded: unshieldedAddress,
      },
    };
  } catch {
    return wallet;
  }
}

function canonicalActiveWalletId(walletId: string | null, wallets: WalletConfig[]): string | null {
  if (!walletId) return null;
  return wallets.find((wallet) => wallet.id === walletId || wallet.legacyId === walletId)?.id ?? walletId;
}

function removeStaleRootCacheFiles(): void {
  for (const fileName of ["checkpoint.json", "checkpoints.json"]) {
    try {
      fs.rmSync(path.join(syncDir, fileName), { force: true });
    } catch {
      // Stale root checkpoints are best-effort cleanup only.
    }
  }
}

function parseArgs(rawArgs: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (let index = 0; index < rawArgs.length; index += 2) {
    parsed[rawArgs[index].replace(/^--/, "")] = rawArgs[index + 1];
  }
  return parsed;
}

function requiredArg(args: Record<string, string | undefined>, name: string): string {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}
