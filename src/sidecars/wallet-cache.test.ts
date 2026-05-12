import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  migrateWalletCache,
  readWalletCache,
  walletCacheDir,
  writeWalletCacheSnapshot,
  type WalletCacheConfig,
} from "./wallet-cache.js";

const wallet: WalletCacheConfig = {
  id: "wallet-one",
  name: "Wallet One",
  phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  addresses: {
    unshielded: "legacy-config-address",
  },
};

test("migrates legacy snapshot.json into split cache files and removes legacy source", async () => {
  const syncDir = tempSyncDir();
  const legacyPath = path.join(syncDir, "sdk", "legacy-config-address", "snapshot.json");
  writeJson(legacyPath, legacySnapshot());

  await migrateWalletCache(syncDir, "preprod", wallet);

  const cacheDir = walletCacheDir(syncDir, "preprod", wallet);
  assert.deepEqual(readJson(path.join(cacheDir, "shielded-state.json")), { offset: 11, highestIndex: 20 });
  assert.deepEqual(readJson(path.join(cacheDir, "unshielded-state.json")), { appliedId: 7, highestTransactionId: 9 });
  assert.deepEqual(readJson(path.join(cacheDir, "dust-state.json")), { offset: 3 });
  assert.deepEqual(readJson(path.join(cacheDir, "tx-metadata.json")), { entries: [{ hash: "abc" }] });
  assert.equal(readJson<{ completedFullSync: boolean }>(path.join(cacheDir, "sync-progress.json")).completedFullSync, true);
  assert.equal(fs.existsSync(legacyPath), false);

  const restored = readWalletCache(syncDir, "preprod", wallet);
  assert.equal(restored?.shieldedState, JSON.stringify({ offset: 11, highestIndex: 20 }));
  assert.equal(restored?.txHistory, JSON.stringify({ entries: [{ hash: "abc" }] }));
});

test("migrates legacy wallet-id json into split cache files", async () => {
  const syncDir = tempSyncDir();
  const legacyPath = path.join(syncDir, "sdk", "wallet-one.json");
  writeJson(legacyPath, legacySnapshot());

  await migrateWalletCache(syncDir, "preprod", wallet);

  const cacheDir = walletCacheDir(syncDir, "preprod", wallet);
  assert.deepEqual(readJson(path.join(cacheDir, "dust-state.json")), { offset: 3 });
  assert.equal(fs.existsSync(legacyPath), false);
});

test("does not overwrite existing split cache files during migration", async () => {
  const syncDir = tempSyncDir();
  const legacyPath = path.join(syncDir, "sdk", "legacy-config-address", "snapshot.json");
  const cacheDir = walletCacheDir(syncDir, "preprod", wallet);
  writeWalletCacheSnapshot(syncDir, "preprod", wallet, {
    walletId: wallet.id,
    unshieldedAddress: "existing",
    completedFullSync: false,
    shieldedState: JSON.stringify({ offset: 99 }),
    unshieldedState: JSON.stringify({ appliedId: 98 }),
    dustState: JSON.stringify({ offset: 97 }),
    txHistory: JSON.stringify({ entries: [] }),
  });
  writeJson(legacyPath, legacySnapshot());

  await migrateWalletCache(syncDir, "preprod", wallet);

  assert.deepEqual(readJson(path.join(cacheDir, "shielded-state.json")), { offset: 99 });
  assert.deepEqual(readJson(path.join(cacheDir, "unshielded-state.json")), { appliedId: 98 });
  assert.equal(fs.existsSync(legacyPath), false);
});

test("keeps legacy source when split writes cannot be prepared", async () => {
  const syncDir = tempSyncDir();
  const legacyPath = path.join(syncDir, "sdk", "legacy-config-address", "snapshot.json");
  writeJson(legacyPath, {
    ...legacySnapshot(),
    shieldedState: "{not-json",
  });

  await migrateWalletCache(syncDir, "preprod", wallet);

  assert.equal(fs.existsSync(legacyPath), true);
});

function legacySnapshot() {
  return {
    walletId: wallet.id,
    unshieldedAddress: "legacy-config-address",
    completedFullSync: true,
    shieldedState: JSON.stringify({ offset: 11, highestIndex: 20 }),
    unshieldedState: JSON.stringify({ appliedId: 7, highestTransactionId: 9 }),
    dustState: JSON.stringify({ offset: 3 }),
    txHistory: JSON.stringify({ entries: [{ hash: "abc" }] }),
  };
}

function tempSyncDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wallet-cache-test-"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJson<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
