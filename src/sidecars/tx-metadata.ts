import { Schema } from "effect";
import {
  mergeWalletEntries,
  WalletEntrySchema,
  type WalletEntry,
} from "@midnight-ntwrk/wallet-sdk";

export type ContractCallMetadata = {
  address: string;
  circuitName: string;
};

export type EnrichedWalletEntry = WalletEntry & {
  blockHeight?: number;
  blockHash?: string;
  contractCalls?: ReadonlyArray<ContractCallMetadata>;
};

type TransactionHistoryStorageWithMetadata = {
  getAll(): Promise<readonly EnrichedWalletEntry[]>;
  upsert(entry: EnrichedWalletEntry): Promise<void>;
  serialize(): Promise<string>;
};

type MetadataEndpoints = {
  indexerUrl: string;
};

type EnrichmentOptions = {
  onUpdate?(): Promise<void>;
};

type IndexerMetadata = {
  timestamp?: Date;
  blockHeight?: number;
  blockHash?: string;
  contractCalls?: ContractCallMetadata[];
};

type TransactionMetadataResponse = {
  data?: {
    transactions?: Array<{
      hash?: string;
      block?: {
        timestamp?: number | string | null;
        height?: number | null;
        hash?: string | null;
      } | null;
      contractActions?: Array<{
        __typename?: string;
        address?: string | null;
        entryPoint?: string | null;
      } | null> | null;
    } | null> | null;
  };
  errors?: Array<{ message?: string }>;
};

const METADATA_FETCH_CONCURRENCY = 8;

const ContractCallMetadataSchema = Schema.Struct({
  address: Schema.String,
  circuitName: Schema.String,
});

const WalletEntryMetadataSchema = Schema.Struct({
  blockHeight: Schema.optional(Schema.Number),
  blockHash: Schema.optional(Schema.String),
  contractCalls: Schema.optional(Schema.Array(ContractCallMetadataSchema)),
});

export const EnrichedWalletEntrySchema = Schema.extend(WalletEntrySchema, WalletEntryMetadataSchema);

export function mergeEnrichedWalletEntries(existing: EnrichedWalletEntry, incoming: EnrichedWalletEntry): EnrichedWalletEntry {
  return mergeWalletEntries(existing, incoming) as EnrichedWalletEntry;
}

export async function enrichTransactionMetadata(
  walletId: string,
  endpoints: MetadataEndpoints,
  txHistoryStorage: TransactionHistoryStorageWithMetadata,
  options: EnrichmentOptions = {},
): Promise<boolean> {
  const entries = await txHistoryStorage.getAll();
  const incompleteEntries = entries.filter((entry) => !hasCompleteTransactionMetadata(entry));

  if (incompleteEntries.length === 0) {
    return false;
  }

  let updated = false;
  for (let index = 0; index < incompleteEntries.length; index += METADATA_FETCH_CONCURRENCY) {
    const batch = incompleteEntries.slice(index, index + METADATA_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (entry) => enrichTransactionEntry(walletId, endpoints, txHistoryStorage, entry)));
    const batchUpdated = results.some(Boolean);
    if (batchUpdated) {
      updated = true;
      await options.onUpdate?.();
    }
  }

  return updated;
}

async function enrichTransactionEntry(
  walletId: string,
  endpoints: MetadataEndpoints,
  txHistoryStorage: TransactionHistoryStorageWithMetadata,
  entry: EnrichedWalletEntry,
): Promise<boolean> {
  try {
    const metadata = await fetchTransactionMetadata(endpoints.indexerUrl, entry.hash);
    if (!metadata) return false;

    const enrichedEntry: EnrichedWalletEntry = {
      ...entry,
      timestamp: entry.timestamp ?? metadata.timestamp,
      blockHeight: entry.blockHeight ?? metadata.blockHeight,
      blockHash: entry.blockHash ?? metadata.blockHash,
      contractCalls: entry.contractCalls ?? metadata.contractCalls,
    };

    if (hasMetadataUpdate(entry, enrichedEntry)) {
      await txHistoryStorage.upsert(enrichedEntry);
      return true;
    }
  } catch (caught) {
    console.error(`[wallet-sync:${walletId}] failed to enrich tx metadata for ${entry.hash}`, caught);
  }
  return false;
}

function hasCompleteTransactionMetadata(entry: EnrichedWalletEntry): boolean {
  return (
    entry.timestamp !== undefined &&
    entry.blockHeight !== undefined &&
    entry.blockHash !== undefined &&
    entry.contractCalls !== undefined
  );
}

function hasMetadataUpdate(before: EnrichedWalletEntry, after: EnrichedWalletEntry): boolean {
  return (
    before.timestamp !== after.timestamp ||
    before.blockHeight !== after.blockHeight ||
    before.blockHash !== after.blockHash ||
    before.contractCalls !== after.contractCalls
  );
}

async function fetchTransactionMetadata(indexerUrl: string, hash: string): Promise<IndexerMetadata | null> {
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: `
        query TransactionMetadata($transactionHash: HexEncoded!) {
          transactions(offset: { hash: $transactionHash }) {
            hash
            block {
              timestamp
              height
              hash
            }
            contractActions {
              __typename
              address
              ... on ContractCall {
                entryPoint
              }
            }
          }
        }
      `,
      variables: {
        transactionHash: hash,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Indexer metadata request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TransactionMetadataResponse;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; "));
  }

  const transaction = payload.data?.transactions?.find((candidate) => candidate?.hash === hash);
  if (!transaction?.block) {
    return null;
  }

  return {
    timestamp: parseIndexerTimestamp(transaction.block.timestamp),
    blockHeight: typeof transaction.block.height === "number" ? transaction.block.height : undefined,
    blockHash: transaction.block.hash ?? undefined,
    contractCalls: (transaction.contractActions ?? [])
      .filter((action): action is NonNullable<NonNullable<typeof transaction.contractActions>[number]> => action?.__typename === "ContractCall")
      .map((action) => ({
        address: action.address ?? "",
        circuitName: action.entryPoint ?? "",
      })),
  };
}

function parseIndexerTimestamp(value: number | string | null | undefined): Date | undefined {
  if (typeof value === "number") {
    return new Date(normalizeUnixTimestampMs(value));
  }

  if (typeof value === "string") {
    const numericValue = Number(value);
    const date = Number.isFinite(numericValue) ? new Date(normalizeUnixTimestampMs(numericValue)) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

function normalizeUnixTimestampMs(value: number): number {
  return value > 10_000_000_000 ? value : value * 1_000;
}
