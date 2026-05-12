import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { Buffer } from "buffer";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { Console, Effect } from "effect";
import {
  DustAddress,
  DustWallet,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  mainnet,
  MidnightBech32m,
  PublicKey,
  Roles,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  ShieldedWallet,
  UnshieldedAddress,
  UnshieldedWallet,
  validateMnemonic,
  WalletFacade,
  createKeystore,
  type FacadeState,
} from "@midnight-ntwrk/wallet-sdk";
import {
  deriveUnshieldedAddress,
  migrateWalletCache,
  readWalletCache,
} from "./wallet-cache.js";
import {
  EnrichedWalletEntrySchema,
  mergeEnrichedWalletEntries,
} from "./tx-metadata.js";

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
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SDK_BATCH_UPDATE_SIZE = 500;
const SDK_BATCH_UPDATE_TIMEOUT_MS = 25;
const SDK_BATCH_UPDATE_SPACING_MS = 0;

type MidnightNetwork = "preprod" | "mainnet" | string;
type WalletFacadeInstance = Awaited<ReturnType<typeof WalletFacade.init>>;
type Timer = ReturnType<typeof setTimeout>;

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

type CachedStatusFile = {
  wallets?: CachedWalletStatus[];
};

type CachedWalletStatus = {
  walletId: string;
  shieldedAssets?: Array<{ tokenType: string; amount: string }>;
  unshieldedAssets?: Array<{ tokenType: string; amount: string }>;
  dustBalance?: string | null;
};

type Runtime = {
  signature: string;
  wallet: WalletConfig;
  facade: WalletFacadeInstance;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  latestState: FacadeState | null;
  subscription: { unsubscribe(): void };
};

type BalanceRequest = {
  tx?: unknown;
  kind?: unknown;
  options?: {
    payFees?: unknown;
    tokenKindsToBalance?: unknown;
  };
};

type SubmitRequest = {
  tx?: unknown;
};

const args = parseArgs(process.argv.slice(2));
const configPath = requiredArg(args, "config");
const cacheDir = requiredArg(args, "cache-dir");
const port = Number(requiredArg(args, "port"));
const token = requiredArg(args, "token");
const syncDir = path.join(cacheDir, "wallet-sync");
const controlPath = path.join(syncDir, "control.json");
const statusPath = path.join(syncDir, "status.json");

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid dapp connector sidecar port: ${port}`);
}

let runtime: Runtime | null = null;
let reloadTimer: Timer | null = null;

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[dapp-connector] listening on 127.0.0.1:${port}`);
});

reloadTimer = setInterval(() => {
  void reloadRuntimeIfNeeded().catch((caught) => {
    console.error("[dapp-connector] failed to reload runtime", caught);
  });
}, CONFIG_POLL_MS);

async function shutdown(code: number): Promise<void> {
  if (reloadTimer !== null) {
    clearInterval(reloadTimer);
    reloadTimer = null;
  }
  await stopRuntime();
  server.close(() => process.exit(code));
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  await Effect.runPromise(handleRequestProgram(request, response));
}

function handleRequestProgram(request: http.IncomingMessage, response: http.ServerResponse): Effect.Effect<void> {
  return Effect.tryPromise({
    try: async () => {
      if (!isAuthorized(request)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/internal/midnight")) {
        writeJson(response, 404, { error: "Not found" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/internal/midnight/configuration") {
        const config = readJson<AppConfig>(configPath, defaultConfig());
        writeJson(response, 200, {
          indexerUri: config.endpoints.indexerUrl,
          indexerWsUri: config.endpoints.indexerWsUrl,
          substrateNodeUri: config.endpoints.nodeUrl,
          proverServerUri: "http://127.0.0.1:6300",
          networkId: config.network,
        });
        return;
      }

      const current = await ensureRuntime();

      if (request.method === "GET" && url.pathname === "/internal/midnight/addresses") {
        writeJson(response, 200, deriveAddresses(current));
        return;
      }

      if (request.method === "GET" && url.pathname === "/internal/midnight/balance") {
        writeJson(response, 200, await readBalances(current));
        return;
      }

      if (request.method === "POST" && url.pathname === "/internal/midnight/balance") {
        const body = await readRequestJson<BalanceRequest>(request);
        const tx = requiredString(body.tx, "tx");
        const kind = parseBalanceKind(body.kind);
        const tokenKindsToBalance = parseTokenKindsToBalance(body.options);
        const balancedTx = await balanceTransaction(current, tx, kind, tokenKindsToBalance);
        writeJson(response, 200, { tx: balancedTx });
        return;
      }

      if (request.method === "POST" && url.pathname === "/internal/midnight/submit") {
        const body = await readRequestJson<SubmitRequest>(request);
        const tx = deserializeFinalizedTransaction(requiredString(body.tx, "tx"));
        await current.facade.waitForSyncedState();
        const txId = await current.facade.submitTransaction(tx);
        writeJson(response, 200, { ok: true, txId: txId ?? null, txHash: String(tx.transactionHash()) });
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    },
    catch: (caught) => caught,
  }).pipe(
    Effect.tapError((error) => Console.log(`[dapp-connector] Error: ${(error as Error).message}`)),
    Effect.catchAll((caught) =>
      Effect.sync(() => {
        const status = caught instanceof HttpError ? caught.status : 500;
        writeJson(response, status, { error: formatError(caught) });
      }),
    ),
  );
}

async function ensureRuntime(): Promise<Runtime> {
  await reloadRuntimeIfNeeded();
  if (!runtime) {
    throw new HttpError(409, "No active wallet selected");
  }
  return runtime;
}

async function reloadRuntimeIfNeeded(): Promise<void> {
  const config = readJson<AppConfig>(configPath, defaultConfig());
  const control = readJson<ControlFile>(controlPath, { activeWalletId: null });
  const wallet = findActiveWallet(config, control);
  if (!wallet) {
    await stopRuntime();
    return;
  }

  const signature = JSON.stringify({
    network: config.network,
    endpoints: config.endpoints,
    walletId: wallet.id,
    phrase: wallet.phrase,
  });

  if (runtime?.signature === signature) {
    return;
  }

  await stopRuntime();
  runtime = await startRuntime(config, wallet, signature);
}

async function startRuntime(config: AppConfig, wallet: WalletConfig, signature: string): Promise<Runtime> {
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

  hdWallet.hdWallet.clear();

  if (derivationResult.type !== "keysDerived") {
    throw new Error(`Failed to derive Midnight keys for ${wallet.name}`);
  }

  const networkId = config.network;
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], networkId);
  const txHistoryStorage = snapshot?.txHistory
    ? InMemoryTransactionHistoryStorage.restore(snapshot.txHistory, EnrichedWalletEntrySchema, mergeEnrichedWalletEntries)
    : new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);

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

  const nextRuntime: Runtime = {
    signature,
    wallet,
    facade,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    latestState: null,
    subscription: { unsubscribe() {} },
  };

  nextRuntime.subscription = facade.state().subscribe({
    next: (state) => {
      nextRuntime.latestState = state;
    },
    error: (caught) => {
      console.error(`[dapp-connector:${wallet.id}] state subscription failed`, caught);
    },
  });

  await facade.start(shieldedSecretKeys, dustSecretKey);
  return nextRuntime;
}

async function stopRuntime(): Promise<void> {
  if (!runtime) return;
  const current = runtime;
  runtime = null;
  current.subscription.unsubscribe();
  await current.facade.stop();
  current.shieldedSecretKeys.clear();
  current.dustSecretKey.clear();
}

function deriveAddresses(current: Runtime) {
  const network = currentNetwork();
  const addressNetwork = network === "mainnet" ? mainnet : network;
  const shieldedAddress = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(current.shieldedSecretKeys.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(current.shieldedSecretKeys.encryptionPublicKey),
  );
  const unshieldedAddress = new UnshieldedAddress(Buffer.from(current.unshieldedKeystore.getAddress(), "hex"));
  const dustAddress = new DustAddress(current.dustSecretKey.publicKey);

  return {
    shieldedAddress: MidnightBech32m.encode(addressNetwork, shieldedAddress).asString(),
    shieldedCoinPublicKey: ShieldedCoinPublicKey.codec
      .encode(addressNetwork, ShieldedCoinPublicKey.fromHexString(current.shieldedSecretKeys.coinPublicKey))
      .asString(),
    shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec
      .encode(addressNetwork, ShieldedEncryptionPublicKey.fromHexString(current.shieldedSecretKeys.encryptionPublicKey))
      .asString(),
    unshieldedAddress: UnshieldedAddress.codec.encode(addressNetwork, unshieldedAddress).asString(),
    dustAddress: DustAddress.codec.encode(addressNetwork, dustAddress).asString(),
  };
}

async function readBalances(current: Runtime) {
  const cached = readJson<CachedStatusFile>(statusPath, {});
  const cachedWallet = cached.wallets?.find((wallet) => wallet.walletId === current.wallet.id);
  if (cachedWallet) {
    const dustCap = current.latestState ? dustCapFromState(current.latestState) : "0";
    return {
      shieldedBalances: assetsToRecord(cachedWallet.shieldedAssets),
      unshieldedBalances: assetsToRecord(cachedWallet.unshieldedAssets),
      dustBalance: {
        balance: cachedWallet.dustBalance ?? "0",
        cap: dustCap,
      },
    };
  }

  const state = current.latestState ?? (await current.facade.waitForSyncedState());
  return {
    shieldedBalances: bigintRecordToStringRecord(state.shielded.balances),
    unshieldedBalances: bigintRecordToStringRecord(state.unshielded.balances),
    dustBalance: {
      balance: String(state.dust.balance(new Date())),
      cap: dustCapFromState(state),
    },
  };
}

function dustCapFromState(state: FacadeState): string {
  return state.dust.totalCoins.reduce((total, coin) => total + coin.maxCap, 0n).toString();
}

async function balanceTransaction(
  current: Runtime,
  tx: string,
  kind: "sealed" | "unsealed" | "auto",
  tokenKindsToBalance: "all" | Array<"dust" | "shielded" | "unshielded">,
): Promise<string> {
  await current.facade.waitForSyncedState();
  const ttl = new Date(Date.now() + DEFAULT_TTL_MS);
  const secrets = {
    shieldedSecretKeys: current.shieldedSecretKeys,
    dustSecretKey: current.dustSecretKey,
  };

  if (kind === "unsealed") {
    return balanceUnboundTransaction(current, tx, secrets, ttl, tokenKindsToBalance);
  }

  if (kind === "sealed") {
    return balanceBoundTransaction(current, tx, secrets, ttl, tokenKindsToBalance);
  }

  try {
    return await balanceUnboundTransaction(current, tx, secrets, ttl, tokenKindsToBalance);
  } catch (unboundError) {
    try {
      return await balanceBoundTransaction(current, tx, secrets, ttl, tokenKindsToBalance);
    } catch {
      throw unboundError;
    }
  }
}

async function balanceUnboundTransaction(
  current: Runtime,
  tx: string,
  secrets: { shieldedSecretKeys: ledger.ZswapSecretKeys; dustSecretKey: ledger.DustSecretKey },
  ttl: Date,
  tokenKindsToBalance: "all" | Array<"dust" | "shielded" | "unshielded">,
): Promise<string> {
  const unboundTx = ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>(
    "signature",
    "proof",
    "pre-binding",
    fromHex(tx),
  );
  const recipe = await current.facade.balanceUnboundTransaction(unboundTx, secrets, { ttl, tokenKindsToBalance });
  const signedRecipe = await current.facade.signRecipe(recipe, (data) => current.unshieldedKeystore.signData(data));
  const finalizedTx = await current.facade.finalizeRecipe(signedRecipe);
  return toHex(finalizedTx.serialize());
}

async function balanceBoundTransaction(
  current: Runtime,
  tx: string,
  secrets: { shieldedSecretKeys: ledger.ZswapSecretKeys; dustSecretKey: ledger.DustSecretKey },
  ttl: Date,
  tokenKindsToBalance: "all" | Array<"dust" | "shielded" | "unshielded">,
): Promise<string> {
  const finalizedTx = deserializeFinalizedTransaction(tx);
  const recipe = await current.facade.balanceFinalizedTransaction(finalizedTx, secrets, { ttl, tokenKindsToBalance });
  const signedRecipe = await current.facade.signRecipe(recipe, (data) => current.unshieldedKeystore.signData(data));
  return toHex((await current.facade.finalizeRecipe(signedRecipe)).serialize());
}

function deserializeFinalizedTransaction(tx: string): ledger.FinalizedTransaction {
  return ledger.Transaction.deserialize<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>("signature", "proof", "binding", fromHex(tx));
}

function fromHex(value: string): Uint8Array {
  const normalized = value.trim();
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
    throw new HttpError(400, "tx must be an even-length hex string");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function parseTokenKindsToBalance(options: BalanceRequest["options"]): "all" | Array<"dust" | "shielded" | "unshielded"> {
  const requested = options?.tokenKindsToBalance;
  if (requested === "all") return "all";
  if (Array.isArray(requested)) {
    const allowed = new Set(["dust", "shielded", "unshielded"]);
    const tokenKinds = requested.filter((value): value is "dust" | "shielded" | "unshielded" => typeof value === "string" && allowed.has(value));
    if (tokenKinds.length > 0) return tokenKinds;
  }
  return options?.payFees === false ? ["shielded", "unshielded"] : "all";
}

function parseBalanceKind(value: unknown): "sealed" | "unsealed" | "auto" {
  if (value === undefined || value === null) return "auto";
  if (value === "sealed" || value === "unsealed" || value === "auto") return value;
  throw new HttpError(400, "kind must be sealed, unsealed, or auto");
}

function findActiveWallet(config: AppConfig, control: ControlFile): WalletConfig | null {
  const wallets = activeNetworkWallets(config);
  return wallets.find((wallet) => wallet.id === control.activeWalletId || wallet.legacyId === control.activeWalletId) ?? wallets[0] ?? null;
}

function currentNetwork(): MidnightNetwork {
  return readJson<AppConfig>(configPath, defaultConfig()).network;
}

function isAuthorized(request: http.IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function assetsToRecord(assets: CachedWalletStatus["shieldedAssets"]): Record<string, string> {
  return Object.fromEntries((assets ?? []).map((asset) => [asset.tokenType, asset.amount]));
}

function bigintRecordToStringRecord(record: Record<string, bigint>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.toString()]));
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readRequestJson<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch (caught) {
        reject(new HttpError(400, `Invalid JSON: ${formatError(caught)}`));
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${label} is required`);
  }
  return value;
}

function parseArgs(values: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) {
      args.set(key, value);
    }
  }
  return args;
}

function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
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

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
