import fs from "node:fs";
import path from "node:path";
import { Buffer } from "buffer";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  createKeystore,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  mainnet,
  Roles,
  UnshieldedAddress,
  type FacadeState,
  type WalletFacade,
} from "@midnight-ntwrk/wallet-sdk";
import {
  EnrichedWalletEntrySchema,
  mergeEnrichedWalletEntries,
} from "./tx-metadata.js";

export type MidnightNetwork = "preprod" | "mainnet" | string;

export type WalletCacheConfig = {
  id: string;
  legacyId?: string;
  name: string;
  phrase: string;
  addresses?: {
    unshielded?: string;
  };
};

export type WalletSdkSnapshot = {
  walletId: string;
  unshieldedAddress: string;
  completedFullSync?: boolean;
  shieldedState?: string;
  unshieldedState?: string;
  dustState?: string;
  txHistory?: string;
  syncProgress?: SyncProgressFile;
};

export type TransactionHistoryStorageLike = {
  serialize(): Promise<string>;
};

type WalletFacadeTxHistory = Pick<WalletFacade, "getAllFromTxHistory">;

type SyncPartStatus = {
  currentIndex: number;
  highestIndex: number;
};

type SyncProgressFile = {
  completedFullSync: boolean;
  updatedAtMs: number;
  shielded: SyncPartStatus;
  unshielded: SyncPartStatus;
  dust: SyncPartStatus;
  legacyWalletId?: string;
  migratedFrom?: string;
};

type SnapshotFilePlan = {
  path: string;
  value: unknown;
};

type TransactionMetadataEntry = {
  hash?: unknown;
  timestamp?: unknown;
  blockHeight?: unknown;
  blockHash?: unknown;
  contractCalls?: unknown;
};

const cacheFileNames = {
  shieldedState: "shielded-state.json",
  unshieldedState: "unshielded-state.json",
  dustState: "dust-state.json",
  txHistory: "tx-metadata.json",
  syncProgress: "sync-progress.json",
} as const;

export async function migrateWalletCache(syncDir: string, network: MidnightNetwork, wallet: WalletCacheConfig): Promise<void> {
  const newDir = walletCacheDir(syncDir, network, wallet);
  const legacySources = findLegacySnapshotSources(syncDir, wallet);

  for (const sourcePath of legacySources) {
    const legacySnapshot = readJson<WalletSdkSnapshot | null>(sourcePath, null);
    if (!legacySnapshot) continue;
    if (legacySnapshot.walletId !== undefined && !walletLegacyIds(wallet).includes(legacySnapshot.walletId)) continue;

    let writes: SnapshotFilePlan[];
    try {
      const progress = syncProgressFromSnapshot(legacySnapshot, sourcePath);
      writes = snapshotWritePlan(newDir, legacySnapshot, progress).filter((write) => !fs.existsSync(write.path));
    } catch (caught) {
      console.error(`[wallet-cache:${wallet.id}] failed to prepare migration from ${sourcePath}`, caught);
      continue;
    }

    let wroteSuccessfully = true;

    for (const write of writes) {
      try {
        atomicWriteJson(write.path, write.value);
      } catch (caught) {
        wroteSuccessfully = false;
        console.error(`[wallet-cache:${wallet.id}] failed to migrate ${sourcePath} to ${write.path}`, caught);
        break;
      }
    }

    if (wroteSuccessfully && cacheLayoutComplete(newDir)) {
      removeLegacySnapshot(sourcePath);
    }
  }
}

export function readWalletCache(syncDir: string, network: MidnightNetwork, wallet: WalletCacheConfig): WalletSdkSnapshot | null {
  const cacheDir = walletCacheDir(syncDir, network, wallet);
  const shieldedState = readSerializedJsonFile(path.join(cacheDir, cacheFileNames.shieldedState));
  const unshieldedState = readSerializedJsonFile(path.join(cacheDir, cacheFileNames.unshieldedState));
  const dustState = readSerializedJsonFile(path.join(cacheDir, cacheFileNames.dustState));
  const txHistory = readSerializedJsonFile(path.join(cacheDir, cacheFileNames.txHistory));
  const syncProgress = readJson<SyncProgressFile | null>(path.join(cacheDir, cacheFileNames.syncProgress), null);

  if (!shieldedState && !unshieldedState && !dustState && !txHistory && !syncProgress) {
    return null;
  }

  return {
    walletId: wallet.id,
    unshieldedAddress: deriveUnshieldedAddress(wallet.phrase, network),
    completedFullSync: syncProgress?.completedFullSync === true,
    shieldedState,
    unshieldedState,
    dustState,
    txHistory,
    syncProgress: syncProgress ?? undefined,
  };
}

export async function dumpTxHistorySummary(wallet: WalletFacadeTxHistory): Promise<void> {
const txHistoryEntries = await wallet.getAllFromTxHistory()

  console.log(`Timestamp missing from txs: ${txHistoryEntries.filter(entry => !entry.timestamp).map(entry => entry.hash)}`)
  console.log(`Latest tx timestamp ${txHistoryEntries.sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime())[0].timestamp}`)
}

export async function snapshotFromState(
  network: MidnightNetwork,
  wallet: WalletCacheConfig,
  facade: WalletFacadeTxHistory,
  state: FacadeState
): Promise<WalletSdkSnapshot> {
  const shieldedState = state.shielded.serialize();
  const unshieldedState = state.unshielded.serialize();
  const dustState = state.dust.serialize();

  const txHistoryEntries = await facade.getAllFromTxHistory()
  const txHistory = await serializeTransactionHistoryEntries(txHistoryEntries);

  await dumpTxHistorySummary(facade)

  return {
    walletId: wallet.id,
    unshieldedAddress: deriveUnshieldedAddress(wallet.phrase, network),
    completedFullSync: state.isSynced,
    shieldedState,
    unshieldedState,
    dustState,
    txHistory,
    syncProgress: {
      completedFullSync: state.isSynced,
      updatedAtMs: Date.now(),
      shielded: syncPartFromSerializedState(shieldedState),
      unshielded: syncPartFromSerializedState(unshieldedState),
      dust: syncPartFromSerializedState(dustState),
    },
  };
}

async function serializeTransactionHistoryEntries(entries: Awaited<ReturnType<WalletFacadeTxHistory["getAllFromTxHistory"]>>): Promise<string> {
  const storage = new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
  for (const entry of entries) {
    await storage.upsert(entry);
  }
  return storage.serialize();
}

export function writeWalletCacheSnapshot(syncDir: string, network: MidnightNetwork, wallet: WalletCacheConfig, snapshot: WalletSdkSnapshot): void {
  const cacheDir = walletCacheDir(syncDir, network, wallet);
  for (const write of snapshotWritePlan(cacheDir, snapshot, snapshot.syncProgress ?? syncProgressFromSnapshot(snapshot))) {
    atomicWriteJson(write.path, write.value);
  }
}

export async function writeWalletTxMetadata(
  syncDir: string,
  network: MidnightNetwork,
  wallet: WalletCacheConfig,
  txHistoryStorage: TransactionHistoryStorageLike,
): Promise<void> {
  const cacheDir = walletCacheDir(syncDir, network, wallet);
  const filePath = path.join(cacheDir, cacheFileNames.txHistory);
  const serialized = await txHistoryStorage.serialize();
  atomicWriteJson(filePath, preserveExistingTransactionMetadata(filePath, parseSerializedJson(serialized)));
}

export function walletCacheDir(syncDir: string, network: MidnightNetwork, wallet: WalletCacheConfig): string {
  return path.join(syncDir, safePathSegment(deriveUnshieldedAddress(wallet.phrase, network)));
}

export function deriveUnshieldedAddress(phrase: string, network: MidnightNetwork): string {
  const seed = mnemonicToSeedSync(phrase);
  const hdWallet = HDWallet.fromSeed(seed);

  if (hdWallet.type !== "seedOk") {
    throw new Error("Failed to initialize HD wallet");
  }

  const derivationResult = hdWallet.hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  hdWallet.hdWallet.clear();

  if (derivationResult.type !== "keyDerived") {
    throw new Error("Failed to derive Midnight unshielded key");
  }

  const keystore = createKeystore(derivationResult.key, network);
  const unshieldedAddress = new UnshieldedAddress(Buffer.from(keystore.getAddress(), "hex"));
  return UnshieldedAddress.codec.encode(addressNetwork(network), unshieldedAddress).asString();
}

export function snapshotIndexProgress(snapshot: WalletSdkSnapshot): number {
  return (
    snapshotStateOffset(snapshot.shieldedState) +
    snapshotStateOffset(snapshot.unshieldedState) +
    snapshotStateOffset(snapshot.dustState)
  );
}

function snapshotWritePlan(cacheDir: string, snapshot: WalletSdkSnapshot, progress: SyncProgressFile): SnapshotFilePlan[] {
  const writes: SnapshotFilePlan[] = [];
  addSerializedWrite(writes, path.join(cacheDir, cacheFileNames.shieldedState), snapshot.shieldedState);
  addSerializedWrite(writes, path.join(cacheDir, cacheFileNames.unshieldedState), snapshot.unshieldedState);
  addSerializedWrite(writes, path.join(cacheDir, cacheFileNames.dustState), snapshot.dustState);
  addTxHistoryWrite(writes, path.join(cacheDir, cacheFileNames.txHistory), snapshot.txHistory);
  writes.push({ path: path.join(cacheDir, cacheFileNames.syncProgress), value: progress });
  return writes;
}

function addSerializedWrite(writes: SnapshotFilePlan[], filePath: string, serialized: string | undefined): void {
  if (!serialized) return;
  writes.push({ path: filePath, value: parseSerializedJson(serialized) });
}

function addTxHistoryWrite(writes: SnapshotFilePlan[], filePath: string, serialized: string | undefined): void {
  if (!serialized) return;
  writes.push({ path: filePath, value: preserveExistingTransactionMetadata(filePath, parseSerializedJson(serialized)) });
}

function preserveExistingTransactionMetadata(filePath: string, nextValue: unknown): unknown {
  if (!Array.isArray(nextValue)) {
    return nextValue;
  }

  const existingValue = readJson<unknown>(filePath, null);
  if (!Array.isArray(existingValue)) {
    return nextValue;
  }

  const existingByHash = new Map<string, TransactionMetadataEntry>();
  for (const existingEntry of existingValue) {
    if (!isTransactionMetadataEntry(existingEntry) || typeof existingEntry.hash !== "string") continue;
    existingByHash.set(existingEntry.hash, existingEntry);
  }

  return nextValue.map((nextEntry) => {
    if (!isTransactionMetadataEntry(nextEntry) || typeof nextEntry.hash !== "string") {
      return nextEntry;
    }

    const existingEntry = existingByHash.get(nextEntry.hash);
    if (!existingEntry) {
      return nextEntry;
    }

    return {
      ...nextEntry,
      timestamp: nextEntry.timestamp ?? existingEntry.timestamp,
      blockHeight: nextEntry.blockHeight ?? existingEntry.blockHeight,
      blockHash: nextEntry.blockHash ?? existingEntry.blockHash,
      contractCalls: nextEntry.contractCalls ?? existingEntry.contractCalls,
    };
  });
}

function isTransactionMetadataEntry(value: unknown): value is TransactionMetadataEntry {
  return typeof value === "object" && value !== null;
}

function findLegacySnapshotSources(syncDir: string, wallet: WalletCacheConfig): string[] {
  const sdkDir = path.join(syncDir, "sdk");
  const sources: string[] = [];
  const preferredAddress = wallet.addresses?.unshielded || wallet.id || "unknown-wallet";
  addUnique(sources, path.join(sdkDir, safePathSegment(preferredAddress), "snapshot.json"));
  addUnique(sources, path.join(sdkDir, `${safePathSegment(wallet.id)}.json`));
  if (wallet.legacyId) {
    addUnique(sources, path.join(sdkDir, `${safePathSegment(wallet.legacyId)}.json`));
  }

  try {
    for (const entry of fs.readdirSync(sdkDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(sdkDir, entry.name, "snapshot.json");
      const snapshot = readJson<{ walletId?: string } | null>(candidate, null);
      if (snapshot?.walletId && walletLegacyIds(wallet).includes(snapshot.walletId)) {
        addUnique(sources, candidate);
      }
    }
  } catch {
    return sources;
  }

  return sources;
}

function syncProgressFromSnapshot(snapshot: WalletSdkSnapshot, migratedFrom?: string): SyncProgressFile {
  return {
    completedFullSync: snapshot.completedFullSync === true,
    updatedAtMs: Date.now(),
    shielded: syncPartFromSerializedState(snapshot.shieldedState),
    unshielded: syncPartFromSerializedState(snapshot.unshieldedState),
    dust: syncPartFromSerializedState(snapshot.dustState),
    legacyWalletId: snapshot.walletId,
    migratedFrom,
  };
}

function syncPartFromSerializedState(serialized: string | null | undefined): SyncPartStatus {
  if (!serialized) return { currentIndex: 0, highestIndex: 0 };

  try {
    const parsed = JSON.parse(serialized) as { offset?: unknown; appliedId?: unknown; highestRelevantWalletIndex?: unknown; highestTransactionId?: unknown; highestIndex?: unknown };
    return {
      currentIndex: Number(parsed.offset ?? parsed.appliedId ?? 0),
      highestIndex: Number(parsed.highestRelevantWalletIndex ?? parsed.highestTransactionId ?? parsed.highestIndex ?? parsed.offset ?? parsed.appliedId ?? 0),
    };
  } catch {
    return { currentIndex: 0, highestIndex: 0 };
  }
}

function snapshotStateOffset(serialized: string | null | undefined): number {
  if (!serialized) return 0;

  try {
    const parsed = JSON.parse(serialized) as { offset?: unknown; appliedId?: unknown };
    return Number(parsed.offset ?? parsed.appliedId ?? 0);
  } catch {
    return 0;
  }
}

function readSerializedJsonFile(filePath: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function cacheLayoutComplete(cacheDir: string): boolean {
  return Object.values(cacheFileNames).every((fileName) => fs.existsSync(path.join(cacheDir, fileName)));
}

function removeLegacySnapshot(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    return;
  }

  try {
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // Non-empty or already removed legacy directories are intentionally left alone.
  }
}

function parseSerializedJson(serialized: string): unknown {
  return JSON.parse(serialized);
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

function addressNetwork(network: MidnightNetwork): string | typeof mainnet {
  return network === "mainnet" ? mainnet : network;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function walletLegacyIds(wallet: WalletCacheConfig): string[] {
  return wallet.legacyId && wallet.legacyId !== wallet.id ? [wallet.id, wallet.legacyId] : [wallet.id];
}
