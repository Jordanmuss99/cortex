import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { jest } from "@jest/globals";
import express from "express";
import { createIngestRouter } from "../api/ingest.js";
import {
  createIngestService,
  effectivePriorityFor,
  indexedProjectionFields,
} from "../memory/ingest.js";
import { projectionFingerprintFor } from "../memory/ingest-worker.js";
import type {
  AcceptIngestInput,
  IngestReceipt,
  IngestService,
  MemoryServices,
} from "../memory/types.js";
import {
  ingestCorpus,
  readStableFileSnapshot,
  submitFileSnapshot,
} from "../ingestion/ingest-markdown.js";
import { ingestTelegramFileReceipt } from "../ingestion/ingest-telegram.js";
import { ingestLimitlessFileReceipt } from "../ingestion/ingest-limitless.js";
import { formatWatcherReceipt, ingestWatchedFile } from "../watcher.js";

const acceptedReceipt: IngestReceipt = {
  eventId: "5e1f3b2a-0b89-4f79-9ed6-1a55b445d08a",
  status: "accepted",
  replayed: false,
  nodeIds: [],
  effectivePriorities: [],
  chunksStored: 0,
  chunksCreated: 0,
  synapsesFormed: 0,
  totalAttempts: 0,
  manualRetryCount: 0,
  possibleUpdateOf: [],
  acceptedAt: "2026-08-28T00:00:00.000Z",
  warnings: [],
};

function servicesWithIngest(ingest: Record<string, unknown>): MemoryServices {
  return {
    ingest,
    health: {},
  } as unknown as MemoryServices;
}

async function startIngestServer(
  services: MemoryServices,
  resolveAgentId: (externalId: string) => Promise<number | null>
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ingest", createIngestRouter(services, { resolveAgentId }));
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

describe("durable ingest adapter", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns 202 with lifecycle and legacy fields after durable acceptance", async () => {
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const resolveAgentId = jest.fn(async (externalId: string) =>
      externalId === "arlo" ? 7 : null
    );
    const server = await startIngestServer(
      servicesWithIngest({ accept }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          content: "The quartz platypus token is QP-2048.",
          sourceType: "api",
          priority: 0,
          idempotencyKey: "slice-2-adapter",
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        agentId: "arlo",
        ...acceptedReceipt,
      });
      expect(accept).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 7,
          content: "The quartz platypus token is QP-2048.",
          sourceType: "api",
          requestedPriority: 0,
          idempotencyKey: "slice-2-adapter",
        })
      );
    } finally {
      await server.close();
    }
  });

  it("returns an agent-scoped status and hides missing or foreign events", async () => {
    const indexedReceipt: IngestReceipt = {
      ...acceptedReceipt,
      status: "indexed",
      nodeIds: [41],
      effectivePriorities: [2],
      chunksStored: 1,
      totalAttempts: 1,
      startedAt: "2026-08-28T00:00:01.000Z",
      indexedAt: "2026-08-28T00:00:02.000Z",
    };
    const get = jest
      .fn<(agentId: number, eventId: string) => Promise<IngestReceipt | null>>()
      .mockResolvedValueOnce(indexedReceipt)
      .mockResolvedValueOnce(null);
    const server = await startIngestServer(
      servicesWithIngest({ get }),
      async () => 7
    );

    try {
      const found = await fetch(
        `${server.baseUrl}/api/v1/ingest/${acceptedReceipt.eventId}?agentId=arlo`
      );
      expect(found.status).toBe(200);
      expect(await found.json()).toEqual({ agentId: "arlo", ...indexedReceipt });
      expect(get).toHaveBeenNthCalledWith(1, 7, acceptedReceipt.eventId);

      const hidden = await fetch(
        `${server.baseUrl}/api/v1/ingest/${acceptedReceipt.eventId}?agentId=other`
      );
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ error: "Ingest event not found" });
    } finally {
      await server.close();
    }
  });

  it("rejects internal provenance fields before durable acceptance", async () => {
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const resolveAgentId = jest.fn(async () => 7);
    const server = await startIngestServer(
      servicesWithIngest({ accept }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          content: "untrusted lineage",
          externalProvenance: {
            kind: "authorized_transfer",
            transferReceiptId: "forged",
            originContentHash: "0".repeat(64),
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(accept).not.toHaveBeenCalled();
      expect(resolveAgentId).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["waitMs", { waitMs: "100" }],
    ["forceNewProjection", { forceNewProjection: "false" }],
    ["predecessorMemoryId", { predecessorMemoryId: "not-a-memory" }],
    ["projectionMode", { projectionMode: null }],
    ["sourceType", { sourceType: " api " }],
    ["sourceType", { sourceType: null }],
    ["priority", { priority: null }],
    ["requestId", { requestId: "r".repeat(129) }],
  ])(
    "rejects malformed %s before durable acceptance",
    async (_field, invalidField) => {
      const accept = jest.fn(async () => acceptedReceipt);
      const server = await startIngestServer(
        servicesWithIngest({ accept }),
        async () => 7
      );

      try {
        const response = await fetch(`${server.baseUrl}/api/v1/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "arlo",
            content: "This invalid request must never be committed.",
            ...invalidField,
          }),
        });

        expect(response.status).toBe(400);
        expect(accept).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    }
  );

  it("preserves replay identity across a bounded wait", async () => {
    const accept = jest.fn(async () => ({ ...acceptedReceipt, replayed: true }));
    const wait = jest.fn(async () => ({
      ...acceptedReceipt,
      status: "indexed" as const,
      replayed: false,
      nodeIds: [41],
      effectivePriorities: [2],
      chunksStored: 1,
      totalAttempts: 1,
      indexedAt: "2026-08-28T00:00:02.000Z",
    }));
    const server = await startIngestServer(
      servicesWithIngest({ accept, wait }),
      async () => 7
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          content: "A replay may finish while the caller waits.",
          idempotencyKey: "slice-2-wait-replay",
          waitMs: 100,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        eventId: acceptedReceipt.eventId,
        status: "indexed",
        replayed: true,
      });
    } finally {
      await server.close();
    }
  });

  it("returns the durable receipt when the optional wait lookup fails", async () => {
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const wait = jest.fn(async () => {
      throw new Error("temporary status lookup failure");
    });
    const waitLog = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const server = await startIngestServer(
      servicesWithIngest({ accept, wait }),
      async () => 7
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          content: "The acceptance survives a failed optional wait.",
          idempotencyKey: "slice-2-wait-fallback",
          waitMs: 100,
        }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        eventId: acceptedReceipt.eventId,
        status: "accepted",
      });
      expect(waitLog).toHaveBeenCalledWith(
        "[ingest] Optional status wait failed after durable acceptance",
        expect.objectContaining({ eventId: acceptedReceipt.eventId })
      );
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      "retryable",
      {
        ...acceptedReceipt,
        status: "failed" as const,
        totalAttempts: 1,
        nextAttemptAt: "2026-08-28T00:01:00.000Z",
        failure: {
          code: "embedding_provider_unavailable",
          retryable: true,
        },
      },
      202,
    ],
    [
      "terminal",
      {
        ...acceptedReceipt,
        status: "failed" as const,
        totalAttempts: 5,
        failure: {
          code: "embedding_provider_unavailable",
          retryable: false,
        },
      },
      503,
    ],
  ])(
    "maps a waited %s failure to the public lifecycle status",
    async (_kind, waitedReceipt, expectedStatus) => {
      const accept = jest.fn(async () => acceptedReceipt);
      const wait = jest.fn(async () => waitedReceipt);
      const server = await startIngestServer(
        servicesWithIngest({ accept, wait }),
        async () => 7
      );

      try {
        const response = await fetch(`${server.baseUrl}/api/v1/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "arlo",
            content: "Wait for a safe failure receipt.",
            idempotencyKey: `slice3-wait-${_kind}`,
            waitMs: 100,
          }),
        });

        expect(response.status).toBe(expectedStatus);
        expect(await response.json()).toEqual({
          agentId: "arlo",
          ...waitedReceipt,
          replayed: false,
        });
      } finally {
        await server.close();
      }
    }
  );
});

describe("truthful projection compatibility fields", () => {
  it("hides partial projection state until the durable event is indexed", () => {
    const processing: IngestReceipt = {
      ...acceptedReceipt,
      status: "processing",
      nodeIds: [41],
      effectivePriorities: [2],
      chunksStored: 1,
      chunksCreated: 1,
      synapsesFormed: 3,
      startedAt: "2026-08-28T00:00:01.000Z",
    };

    expect(indexedProjectionFields(processing)).toEqual({
      nodeIds: [],
      effectivePriorities: [],
      chunksStored: 0,
      chunksCreated: 0,
      synapsesFormed: 0,
    });
    expect(
      indexedProjectionFields({
        ...processing,
        status: "indexed",
        indexedAt: "2026-08-28T00:00:02.000Z",
      })
    ).toEqual({
      nodeIds: [41],
      effectivePriorities: [2],
      chunksStored: 1,
      chunksCreated: 1,
      synapsesFormed: 3,
    });
  });
});

describe("durable ingest policy", () => {
  it("fingerprints every projection-defining field but normalizes entity and tag order", () => {
    const base = {
      content: "Exact projected fact.",
      validFrom: "2026-08-29T01:00:00.000Z",
      validUntil: "2026-08-30T01:00:00.000Z",
      effectivePriority: 1,
      entities: ["Beta", "Alpha", "Alpha"],
      semanticTags: ["memory", "current"],
      derivationRelation: "derived_from",
      derivationConfidence: 0.8,
      derivationExpiresAt: "2026-08-31T01:00:00.000Z",
      projectionVersion: "projection-v1",
      embeddingProvider: "provider-a",
      embeddingModel: "model-a",
    };
    const fingerprint = projectionFingerprintFor(base);

    expect(
      projectionFingerprintFor({
        ...base,
        entities: [" Alpha ", "Beta"],
        semanticTags: ["current", "memory", "memory"],
        validFrom: "2026-08-29T11:00:00.000+10:00",
      })
    ).toBe(fingerprint);

    const variants = [
      { validFrom: "2026-08-29T01:00:01.000Z" },
      { validUntil: "2026-08-30T01:00:01.000Z" },
      { effectivePriority: 2 },
      { entities: ["Alpha", "Gamma"] },
      { semanticTags: ["memory", "historical"] },
      { derivationRelation: "consolidates" },
      { derivationConfidence: 0.9 },
      { derivationExpiresAt: "2026-09-01T01:00:00.000Z" },
      { projectionVersion: "projection-v2" },
      { embeddingProvider: "provider-b" },
      { embeddingModel: "model-b" },
    ];
    for (const variant of variants) {
      expect(projectionFingerprintFor({ ...base, ...variant })).not.toBe(
        fingerprint
      );
    }
  });

  it("accepts replace_source only with a source and source version", async () => {
    const transaction = Object.assign(
      jest.fn(async (strings: TemplateStringsArray) => {
        const statement = strings.join(" ");
        if (statement.includes("INSERT INTO public.memory_ingest_events")) {
          return [{ id: acceptedReceipt.eventId, request_hash: "unused" }];
        }
        throw new Error(`Unexpected transaction statement: ${statement}`);
      }),
      { array: (values: readonly unknown[]) => values }
    );
    const rootSql = Object.assign(jest.fn(), {
      begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    });
    const service = createIngestService({
      sql: rootSql,
      config: { buildId: "slice4", ingestMaxAttempts: 5 },
      now: () => new Date(acceptedReceipt.acceptedAt),
      newId: () => acceptedReceipt.eventId,
    } as never);
    const snapshot: AcceptIngestInput = {
      agentId: 7,
      content: "A complete source snapshot.",
      source: "/workspace/MEMORY.md",
      sourceVersion: "version-2",
      sourceType: "markdown",
      requestedPriority: 1,
      projectionMode: "replace_source",
      idempotencyKey: "slice4-source-version-2",
    };

    await expect(service.accept(snapshot)).resolves.toMatchObject({
      eventId: acceptedReceipt.eventId,
      status: "accepted",
    });
    await expect(
      service.accept({ ...snapshot, source: null })
    ).rejects.toMatchObject({ code: "replace_source_requires_source" });
    await expect(
      service.accept({ ...snapshot, sourceVersion: null })
    ).rejects.toMatchObject({ code: "replace_source_requires_source_version" });
    await expect(
      service.accept({
        ...snapshot,
        source: "é".repeat(512),
        idempotencyKey: "slice4-source-byte-boundary",
      })
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      service.accept({ ...snapshot, source: "é".repeat(513) })
    ).rejects.toMatchObject({ code: "replace_source_source_too_long" });
    await expect(
      service.accept({ ...snapshot, sourceVersion: "é".repeat(513) })
    ).rejects.toMatchObject({
      code: "replace_source_source_version_too_long",
    });
  });

  it("keeps priority independent of novelty while enforcing source floors", () => {
    expect(
      effectivePriorityFor({
        sourceType: "api",
        requestedPriority: 0,
        allowHighPriority: false,
      })
    ).toBe(2);
    expect(
      effectivePriorityFor({
        sourceType: "observation",
        requestedPriority: 1,
        allowHighPriority: true,
      })
    ).toBe(3);
    expect(
      effectivePriorityFor({
        sourceType: "manual",
        requestedPriority: 0,
        allowHighPriority: false,
      })
    ).toBe(0);
    expect(
      effectivePriorityFor({
        sourceType: "API",
        requestedPriority: 0,
        allowHighPriority: false,
      })
    ).toBe(2);
    expect(
      effectivePriorityFor({
        sourceType: "Observation",
        requestedPriority: 1,
        allowHighPriority: true,
      })
    ).toBe(3);
  });

  it("derives a stable legacy key when observed time is omitted", () => {
    const input: Omit<AcceptIngestInput, "idempotencyKey"> = {
      agentId: 7,
      content: "stable exact payload",
      source: "adapter",
      sourceType: "api",
      requestedPriority: 2,
    };
    let now = new Date("2026-08-28T00:00:00.000Z");
    const service = createIngestService({
      now: () => now,
    } as never);

    const first = service.deriveLegacyKey(input);
    now = new Date("2026-08-29T00:00:00.000Z");
    expect(service.deriveLegacyKey(input)).toBe(first);
  });

  it.each([false, true])(
    "returns a durable receipt without depending on a post-commit read (replayed=%s)",
    async (replayed) => {
      let requestHash = "";
      const transaction = Object.assign(
        jest.fn(async (strings: TemplateStringsArray) => {
          const statement = strings.join(" ");
          if (statement.includes("INSERT INTO public.memory_ingest_events")) {
            return replayed
              ? []
              : [{ id: acceptedReceipt.eventId, request_hash: "unused" }];
          }
          if (statement.includes("SELECT id, request_hash")) {
            return [
              {
                id: acceptedReceipt.eventId,
                request_hash: requestHash,
                accepted_at: acceptedReceipt.acceptedAt,
              },
            ];
          }
          throw new Error(`Unexpected transaction statement: ${statement}`);
        }),
        { array: (values: readonly unknown[]) => values }
      );
      const rootSql = Object.assign(
        jest.fn(async () => {
          throw new Error("post-commit receipt read unavailable");
        }),
        {
          begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
            callback(transaction),
        }
      );
      const service = createIngestService({
        sql: rootSql,
        config: { buildId: "slice2", ingestMaxAttempts: 5 },
        now: () => new Date(acceptedReceipt.acceptedAt),
        newId: () => acceptedReceipt.eventId,
      } as never);
      const input: AcceptIngestInput = {
        agentId: 7,
        content: "The committed event is its own acceptance receipt.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice-2-post-commit",
      };
      const { idempotencyKey: _idempotencyKey, ...legacyInput } = input;
      requestHash = service
        .deriveLegacyKey(legacyInput)
        .slice("legacy:".length);
      const receipt = await service.accept(input);
      expect(receipt).toMatchObject({
        eventId: acceptedReceipt.eventId,
        status: "accepted",
        replayed,
      });
      if (!replayed) expect(rootSql).not.toHaveBeenCalled();
    }
  );
});

describe("durable source snapshot adapters", () => {
  let temporaryDirectory = "";

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "cortex-slice4-"));
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("derives stable file identity and creates a fresh version when old bytes return", async () => {
    const filePath = join(temporaryDirectory, "MEMORY.md");
    const firstTime = new Date("2026-08-29T01:00:00.000Z");
    writeFileSync(filePath, "Snapshot A", "utf8");
    utimesSync(filePath, firstTime, firstTime);
    const first = readStableFileSnapshot(filePath);
    const retry = readStableFileSnapshot(filePath);
    expect(retry).toEqual(first);

    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const ingest = { accept } as unknown as IngestService;
    await submitFileSnapshot(
      { agentId: 7, sourcePath: filePath },
      { ingest, waitMs: 0 }
    );
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Snapshot A",
        source: first.canonicalPath,
        sourceVersion: first.sourceVersion,
        observedAt: first.observedAt,
        idempotencyKey: first.idempotencyKey,
        sourceType: "markdown",
        requestedPriority: 0,
        projectionMode: "replace_source",
      })
    );

    const secondTime = new Date("2026-08-29T01:01:00.000Z");
    writeFileSync(filePath, "Snapshot B", "utf8");
    utimesSync(filePath, secondTime, secondTime);
    const second = readStableFileSnapshot(filePath);
    const restoredTime = new Date("2026-08-29T01:02:00.000Z");
    writeFileSync(filePath, "Snapshot A", "utf8");
    utimesSync(filePath, restoredTime, restoredTime);
    const restored = readStableFileSnapshot(filePath);

    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(restored.contentHash).toBe(first.contentHash);
    expect(restored.sourceVersion).not.toBe(first.sourceVersion);
    expect(restored.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("preserves file replay identity when indexing finishes during the wait", async () => {
    const filePath = join(temporaryDirectory, "MEMORY.md");
    writeFileSync(filePath, "A replayed source snapshot.", "utf8");
    const accept = jest.fn(async () => ({
      ...acceptedReceipt,
      replayed: true,
    }));
    const wait = jest.fn(async () => ({
      ...acceptedReceipt,
      status: "indexed" as const,
      replayed: false,
      nodeIds: [71],
      chunksStored: 1,
      indexedAt: "2026-08-29T01:02:04.000Z",
    }));

    await expect(
      submitFileSnapshot(
        { agentId: 7, sourcePath: filePath },
        { ingest: { accept, wait } as unknown as IngestService, waitMs: 100 }
      )
    ).resolves.toMatchObject({ status: "indexed", replayed: true });
  });

  it("rejects bytes from a pathname that is atomically replaced during the read", () => {
    const filePath = join(temporaryDirectory, "MEMORY.md");
    const replacementPath = join(temporaryDirectory, "replacement.md");
    writeFileSync(filePath, "Snapshot A", "utf8");
    writeFileSync(replacementPath, "Snapshot B", "utf8");

    expect(() =>
      readStableFileSnapshot(filePath, {
        beforePathRevalidation: () => renameSync(replacementPath, filePath),
      })
    ).toThrow(
      expect.objectContaining({ code: "file_changed_during_read" })
    );
  });

  it("routes Telegram and Limitless files through one replace_source event each", async () => {
    const telegram = join(temporaryDirectory, "telegram.md");
    const limitless = join(temporaryDirectory, "limitless.md");
    writeFileSync(telegram, "Telegram conversation", "utf8");
    writeFileSync(limitless, "Limitless transcript", "utf8");
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const ingest = { accept } as unknown as IngestService;

    await ingestTelegramFileReceipt(7, telegram, { ingest, waitMs: 0 });
    await ingestLimitlessFileReceipt(7, limitless, { ingest, waitMs: 0 });

    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept.mock.calls[0][0]).toMatchObject({
      sourceType: "telegram",
      requestedPriority: 3,
      projectionMode: "replace_source",
    });
    expect(accept.mock.calls[1][0]).toMatchObject({
      sourceType: "limitless",
      requestedPriority: 3,
      projectionMode: "replace_source",
    });
  });

  it("refuses an empty snapshot before acceptance so it cannot evict the last good version", async () => {
    const filePath = join(temporaryDirectory, "empty.md");
    writeFileSync(filePath, " \n", "utf8");
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);

    await expect(
      submitFileSnapshot(
        { agentId: 7, sourcePath: filePath },
        { ingest: { accept } as unknown as IngestService, waitMs: 0 }
      )
    ).rejects.toMatchObject({ code: "empty_source_snapshot" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("enforces the root before reading and bounds every source snapshot", async () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), "cortex-slice4-read-root-"));
    const outsideFile = join(outsideDirectory, "outside.md");
    const linkedFile = join(temporaryDirectory, "linked.md");
    const oversizedFile = join(temporaryDirectory, "oversized.md");
    writeFileSync(outsideFile, "outside bytes", "utf8");
    symlinkSync(outsideFile, linkedFile);
    writeFileSync(oversizedFile, "too large", "utf8");
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const ingest = { accept } as unknown as IngestService;

    try {
      await expect(
        submitFileSnapshot(
          { agentId: 7, sourcePath: linkedFile },
          { ingest, waitMs: 0, allowedRoot: temporaryDirectory, maxBytes: 1 }
        )
      ).rejects.toMatchObject({ code: "source_outside_allowed_root" });
      await expect(
        submitFileSnapshot(
          { agentId: 7, sourcePath: oversizedFile },
          { ingest, waitMs: 0, allowedRoot: temporaryDirectory, maxBytes: 1 }
        )
      ).rejects.toMatchObject({ code: "source_snapshot_too_large" });
      expect(accept).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  it("bounds corpus submission and counts queued work separately from indexed chunks", async () => {
    const memoryDirectory = join(temporaryDirectory, "memory");
    mkdirSync(memoryDirectory);
    writeFileSync(join(temporaryDirectory, "MEMORY.md"), "queued root", "utf8");
    writeFileSync(join(memoryDirectory, "first.md"), "queued child", "utf8");
    writeFileSync(join(memoryDirectory, "second.md"), "indexed child", "utf8");
    writeFileSync(join(memoryDirectory, "third.md"), "reused indexed child", "utf8");
    const previousWorkspace = process.env.CORTEX_WORKSPACE;
    const previousHeadless = process.env.CORTEX_HEADLESS;
    process.env.CORTEX_WORKSPACE = temporaryDirectory;
    process.env.CORTEX_HEADLESS = "false";
    let inFlight = 0;
    let maximumInFlight = 0;
    const accept = jest.fn(async (input: AcceptIngestInput) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
      if (input.content.includes("reused")) {
        return {
          ...acceptedReceipt,
          eventId: "6e1f3b2a-0b89-4f79-9ed6-1a55b445d08a",
          status: "indexed" as const,
          chunksStored: 2,
          chunksCreated: 0,
          synapsesFormed: 0,
        };
      }
      return input.content.includes("indexed")
        ? {
            ...acceptedReceipt,
            status: "indexed" as const,
            chunksStored: 2,
            chunksCreated: 2,
            synapsesFormed: 3,
          }
        : acceptedReceipt;
    });
    try {
      const result = await ingestCorpus(7, {
        ingest: { accept } as unknown as IngestService,
        waitMs: 0,
        concurrency: 2,
      });
      expect(maximumInFlight).toBe(2);
      expect(result).toMatchObject({
        discovered: 4,
        submitted: 4,
        queued: 2,
        indexed: 2,
        chunksIndexed: 4,
        chunksStored: 4,
        memoriesCreated: 2,
        synapsesCreated: 3,
        filesProcessed: 4,
        filesFailed: 0,
      });
    } finally {
      if (previousWorkspace === undefined) delete process.env.CORTEX_WORKSPACE;
      else process.env.CORTEX_WORKSPACE = previousWorkspace;
      if (previousHeadless === undefined) delete process.env.CORTEX_HEADLESS;
      else process.env.CORTEX_HEADLESS = previousHeadless;
    }
  });

  it("accepts the whole corpus before beginning one bounded wait phase", async () => {
    const memoryDirectory = join(temporaryDirectory, "memory");
    mkdirSync(memoryDirectory);
    writeFileSync(join(memoryDirectory, "first.md"), "first", "utf8");
    writeFileSync(join(memoryDirectory, "second.md"), "second", "utf8");
    writeFileSync(join(memoryDirectory, "third.md"), "third", "utf8");
    const previousWorkspace = process.env.CORTEX_WORKSPACE;
    const previousHeadless = process.env.CORTEX_HEADLESS;
    process.env.CORTEX_WORKSPACE = temporaryDirectory;
    process.env.CORTEX_HEADLESS = "false";
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    const wait = jest.fn(async () => {
      expect(accept).toHaveBeenCalledTimes(3);
      throw new Error("worker unavailable");
    });
    try {
      const result = await ingestCorpus(7, {
        ingest: { accept, wait } as unknown as IngestService,
        waitMs: 10,
        concurrency: 2,
      });
      expect(result).toMatchObject({ submitted: 3, queued: 3 });
      expect(wait).toHaveBeenCalled();
    } finally {
      if (previousWorkspace === undefined) delete process.env.CORTEX_WORKSPACE;
      else process.env.CORTEX_WORKSPACE = previousWorkspace;
      if (previousHeadless === undefined) delete process.env.CORTEX_HEADLESS;
      else process.env.CORTEX_HEADLESS = previousHeadless;
    }
  });

  it("preserves replay counts when corpus events settle during polling", async () => {
    const memoryDirectory = join(temporaryDirectory, "memory");
    mkdirSync(memoryDirectory);
    writeFileSync(join(memoryDirectory, "replayed.md"), "replayed", "utf8");
    const previousWorkspace = process.env.CORTEX_WORKSPACE;
    const previousHeadless = process.env.CORTEX_HEADLESS;
    process.env.CORTEX_WORKSPACE = temporaryDirectory;
    process.env.CORTEX_HEADLESS = "false";
    const accept = jest.fn(async () => ({ ...acceptedReceipt, replayed: true }));
    const wait = jest.fn(async () => ({
      ...acceptedReceipt,
      status: "indexed" as const,
      replayed: false,
      nodeIds: [72],
      chunksStored: 1,
      indexedAt: "2026-08-29T01:02:04.000Z",
    }));
    try {
      await expect(
        ingestCorpus(7, {
          ingest: { accept, wait } as unknown as IngestService,
          waitMs: 100,
          concurrency: 1,
        })
      ).resolves.toMatchObject({ indexed: 1, replayed: 1 });
    } finally {
      if (previousWorkspace === undefined) delete process.env.CORTEX_WORKSPACE;
      else process.env.CORTEX_WORKSPACE = previousWorkspace;
      if (previousHeadless === undefined) delete process.env.CORTEX_HEADLESS;
      else process.env.CORTEX_HEADLESS = previousHeadless;
    }
  });

  it("does not follow corpus symlinks outside the hosted workspace", async () => {
    const memoryDirectory = join(temporaryDirectory, "memory");
    const outsideDirectory = mkdtempSync(join(tmpdir(), "cortex-slice4-outside-"));
    mkdirSync(memoryDirectory);
    writeFileSync(join(memoryDirectory, "safe.md"), "safe", "utf8");
    writeFileSync(join(outsideDirectory, "secret.md"), "secret", "utf8");
    symlinkSync(
      join(outsideDirectory, "secret.md"),
      join(memoryDirectory, "linked.md")
    );
    symlinkSync(outsideDirectory, join(memoryDirectory, "linked-directory"));
    const previousWorkspace = process.env.CORTEX_WORKSPACE;
    const previousHeadless = process.env.CORTEX_HEADLESS;
    const previousImportRoot = process.env.CORTEX_IMPORT_ROOT;
    process.env.CORTEX_WORKSPACE = temporaryDirectory;
    process.env.CORTEX_IMPORT_ROOT = temporaryDirectory;
    process.env.CORTEX_HEADLESS = "true";
    const accept = jest.fn(async (_input: AcceptIngestInput) => acceptedReceipt);
    try {
      const result = await ingestCorpus(7, {
        ingest: { accept } as unknown as IngestService,
        concurrency: 2,
      });
      expect(result).toMatchObject({ discovered: 1, submitted: 1 });
      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept.mock.calls[0][0]).toMatchObject({ content: "safe" });
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
      if (previousWorkspace === undefined) delete process.env.CORTEX_WORKSPACE;
      else process.env.CORTEX_WORKSPACE = previousWorkspace;
      if (previousHeadless === undefined) delete process.env.CORTEX_HEADLESS;
      else process.env.CORTEX_HEADLESS = previousHeadless;
      if (previousImportRoot === undefined) delete process.env.CORTEX_IMPORT_ROOT;
      else process.env.CORTEX_IMPORT_ROOT = previousImportRoot;
    }
  });

  it("returns the real watcher adapter receipt for queued and indexed snapshots", async () => {
    const filePath = join(temporaryDirectory, "memory.md");
    writeFileSync(filePath, "watched", "utf8");
    const accept = jest
      .fn<(input: AcceptIngestInput) => Promise<IngestReceipt>>()
      .mockResolvedValueOnce(acceptedReceipt)
      .mockResolvedValueOnce({
        ...acceptedReceipt,
        status: "indexed",
        chunksStored: 1,
      });
    const dependencies = {
      ingest: { accept } as unknown as IngestService,
      waitMs: 0,
      allowedRoot: temporaryDirectory,
    };

    await expect(
      ingestWatchedFile(7, filePath, dependencies)
    ).resolves.toMatchObject({ status: "accepted", eventId: acceptedReceipt.eventId });
    await expect(
      ingestWatchedFile(7, filePath, dependencies)
    ).resolves.toMatchObject({ status: "indexed", chunksStored: 1 });
    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept.mock.calls[0][0]).toMatchObject({
      projectionMode: "replace_source",
      sourceType: "markdown",
    });
  });

  it("reports watcher queue, index, failure, and obsolete states truthfully", () => {
    const receipt = (overrides: Partial<IngestReceipt>): IngestReceipt => ({
      ...acceptedReceipt,
      ...overrides,
    });
    expect(formatWatcherReceipt("memory.md", receipt({}))).toContain(
      "Durably queued"
    );
    expect(
      formatWatcherReceipt(
        "memory.md",
        receipt({ status: "indexed", chunksStored: 2 })
      )
    ).toContain("Indexed");
    expect(
      formatWatcherReceipt(
        "memory.md",
        receipt({
          status: "failed",
          failure: { code: "projection_failed", retryable: true },
        })
      )
    ).toContain("Durably queued");
    expect(
      formatWatcherReceipt(
        "memory.md",
        receipt({
          status: "failed",
          failure: { code: "projection_failed", retryable: false },
        })
      )
    ).toContain("Failed");
    expect(
      formatWatcherReceipt(
        "memory.md",
        receipt({
          status: "rejected",
          failure: { code: "obsolete_source_snapshot", retryable: false },
        })
      )
    ).toContain("Superseded by a newer snapshot");
  });
});
