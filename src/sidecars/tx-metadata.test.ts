import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk";
import {
  enrichTransactionMetadata,
  EnrichedWalletEntrySchema,
  mergeEnrichedWalletEntries,
  type EnrichedWalletEntry,
} from "./tx-metadata.js";

test("enriched wallet entry schema preserves metadata through restore and serialize", async () => {
  const serialized = JSON.stringify([
    entry({
      blockHeight: 123,
      blockHash: "abc",
      contractCalls: [{ address: "contract", circuitName: "transfer" }],
    }),
  ]);

  const storage = InMemoryTransactionHistoryStorage.restore(serialized, EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
  const restored = JSON.parse(await storage.serialize()) as EnrichedWalletEntry[];

  assert.equal(restored[0].blockHeight, 123);
  assert.equal(restored[0].blockHash, "abc");
  assert.deepEqual(restored[0].contractCalls, [{ address: "contract", circuitName: "transfer" }]);
});

test("complete transaction metadata skips indexer fetches", async () => {
  let requests = 0;
  const fetchMock = mockFetch(() => {
    requests += 1;
    return { data: { transactions: [] } };
  });

  try {
    const storage = new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
    await storage.upsert(
      entry({
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        blockHeight: 1,
        blockHash: "block",
        contractCalls: [],
      }),
    );

    const updated = await enrichTransactionMetadata("wallet", { indexerUrl: fetchMock.url }, storage);
    assert.equal(updated, false);
    assert.equal(requests, 0);
  } finally {
    fetchMock.dispose();
  }
});

test("incomplete transaction metadata is fetched and merged", async () => {
  const fetchMock = mockFetch(() => ({
    data: {
      transactions: [
        {
          hash: "tx",
          block: {
            timestamp: 1_776_000_000,
            height: 55,
            hash: "block-hash",
          },
          contractActions: [
            {
              __typename: "ContractCall",
              address: "contract-address",
              entryPoint: "mint",
            },
          ],
        },
      ],
    },
  }));

  try {
    const storage = new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
    await storage.upsert(entry({ unshielded: { id: 10, createdUtxos: [], spentUtxos: [] } }));

    const updated = await enrichTransactionMetadata("wallet", { indexerUrl: fetchMock.url }, storage);
    const restored = JSON.parse(await storage.serialize()) as EnrichedWalletEntry[];

    assert.equal(updated, true);
    assert.equal(restored[0].blockHeight, 55);
    assert.equal(restored[0].blockHash, "block-hash");
    assert.deepEqual(restored[0].contractCalls, [{ address: "contract-address", circuitName: "mint" }]);
    assert.deepEqual(restored[0].unshielded, { id: 10, createdUtxos: [], spentUtxos: [] });
    assert.equal(restored[0].timestamp, "2026-04-12T13:20:00.000Z");
  } finally {
    fetchMock.dispose();
  }
});

test("enrichment flushes after updated batches", async () => {
  let flushes = 0;
  const fetchMock = mockFetch((body) => {
    const parsed = body as { variables?: { transactionHash?: string } };
    return {
      data: {
        transactions: [
          {
            hash: parsed.variables?.transactionHash,
            block: {
              timestamp: 1_776_000_000,
              height: 55,
              hash: "block-hash",
            },
            contractActions: [],
          },
        ],
      },
    };
  });

  try {
    const storage = new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
    for (let index = 0; index < 9; index += 1) {
      await storage.upsert(entry({ hash: `tx-${index}` }));
    }

    await enrichTransactionMetadata("wallet", { indexerUrl: fetchMock.url }, storage, {
      async onUpdate() {
        flushes += 1;
      },
    });

    assert.equal(flushes, 2);
  } finally {
    fetchMock.dispose();
  }
});

test("transactions without contract calls are marked with an empty list", async () => {
  const fetchMock = mockFetch(() => ({
    data: {
      transactions: [
        {
          hash: "tx",
          block: {
            timestamp: 1_776_000_000,
            height: 55,
            hash: "block-hash",
          },
          contractActions: [],
        },
      ],
    },
  }));

  try {
    const storage = new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
    await storage.upsert(entry());

    await enrichTransactionMetadata("wallet", { indexerUrl: fetchMock.url }, storage);
    const restored = JSON.parse(await storage.serialize()) as EnrichedWalletEntry[];

    assert.deepEqual(restored[0].contractCalls, []);
  } finally {
    fetchMock.dispose();
  }
});

test("indexer failures leave metadata unchanged", async () => {
  const fetchMock = mockFetch(() => ({ errors: [{ message: "failed" }] }));

  try {
    const storage = new InMemoryTransactionHistoryStorage(EnrichedWalletEntrySchema, mergeEnrichedWalletEntries);
    await storage.upsert(entry());

    const updated = await enrichTransactionMetadata("wallet", { indexerUrl: fetchMock.url }, storage);
    const restored = JSON.parse(await storage.serialize()) as EnrichedWalletEntry[];

    assert.equal(updated, false);
    assert.equal(restored[0].blockHeight, undefined);
    assert.equal(restored[0].blockHash, undefined);
    assert.equal(restored[0].contractCalls, undefined);
  } finally {
    fetchMock.dispose();
  }
});

function entry(extra: Partial<EnrichedWalletEntry> = {}): EnrichedWalletEntry {
  return {
    hash: "tx",
    protocolVersion: 1,
    status: "SUCCESS",
    identifiers: [],
    fees: null,
    ...extra,
  };
}

function mockFetch(handler: (body: unknown) => unknown): { url: string; dispose(): void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const payload = handler(body);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  };

  return {
    url: "http://indexer.test/graphql",
    dispose() {
      globalThis.fetch = originalFetch;
    },
  };
}
