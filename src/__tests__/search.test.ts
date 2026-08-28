import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { jest } from "@jest/globals";
import express from "express";
import {
  createSearchRouter,
  hybridSearch,
  type SearchResult,
} from "../api/search.js";
import type {
  MemoryServices,
  PreparedRetrieval,
  RetrievedItem,
  RetrievalResponse,
  RetrievalService,
} from "../memory/types.js";

const RETRIEVAL_ID = "11111111-1111-4111-8111-111111111111";
const RETRIEVAL_ITEM_ID = "22222222-2222-4222-8222-222222222222";
const PROVENANCE_EVENT_ID = "33333333-3333-4333-8333-333333333333";

function memoryItem(
  overrides: Partial<Extract<RetrievedItem, { kind: "memory" }>> = {}
): Extract<RetrievedItem, { kind: "memory" }> {
  return {
    retrievalItemId: RETRIEVAL_ITEM_ID,
    kind: "memory",
    memoryId: 42,
    content: "The quartz platypus token is QP-2048.",
    source: "/notes/quartz.md",
    priority: 1,
    currentness: 0.93,
    score: 0.82,
    finalRank: 1,
    componentRanks: [
      { lane: "lexical", rank: 1, sourceScore: 0.74 },
      { lane: "vector", rank: 2, sourceScore: 0.68 },
    ],
    reasons: ["lexical_rank:1", "vector_rank:2"],
    provenance: [
      {
        eventId: PROVENANCE_EVENT_ID,
        source: "/notes/quartz.md",
        sourceType: "markdown",
        relation: "captured_from",
        confidence: null,
        acceptedAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    provenanceTruncated: false,
    resonance: 6.25,
    compatibility: {
      sourceType: "markdown",
      entities: ["Quartz Platypus"],
      semanticTags: ["token"],
      createdAt: "2026-08-28T00:00:01.000Z",
      lastRecalledAt: "2026-08-28T01:00:00.000Z",
      validFrom: "2026-08-28T00:00:00.000Z",
      validUntil: null,
      supersededBy: null,
      hybridScore: 0.79,
      scoreBreakdown: {
        cosine: 0.68,
        textMatch: 0.74,
        recency: 0.93,
        resonance: 0.625,
        priorityBoost: 1.04,
        emotionalBoost: 0,
        ca3Activation: 0,
      },
    },
    ...overrides,
  };
}

function preparedWith(
  candidates: RetrievedItem[] = [memoryItem()]
): PreparedRetrieval {
  return {
    retrievalId: RETRIEVAL_ID,
    algorithmVersion: "memory-retrieval-v1",
    buildId: "slice6-test-build",
    candidates,
    elapsedMs: 7,
    warnings: [],
  };
}

function responseWith(results: RetrievedItem[] = [memoryItem()]): RetrievalResponse {
  return {
    retrievalId: RETRIEVAL_ID,
    algorithmVersion: "memory-retrieval-v1",
    buildId: "slice6-test-build",
    results,
    candidateCount: 4,
    returnedCount: results.length,
    elapsedMs: 12,
    warnings: ["vector_lane_degraded"],
  };
}

function servicesWithRetrieval(
  retrieval: Partial<RetrievalService>
): MemoryServices {
  return {
    retrieval,
    ingest: {},
    health: {},
  } as unknown as MemoryServices;
}

function legacyResult(item = memoryItem()): SearchResult {
  return {
    id: item.memoryId,
    content: item.content,
    source: item.source,
    sourceType: item.compatibility.sourceType,
    priority: item.priority,
    resonanceScore: item.resonance,
    entities: item.compatibility.entities,
    semanticTags: item.compatibility.semanticTags,
    createdAt: item.compatibility.createdAt,
    validFrom: item.compatibility.validFrom,
    validUntil: item.compatibility.validUntil,
    supersededBy: item.compatibility.supersededBy,
    score: item.score,
    hybridScore: item.compatibility.hybridScore,
    scoreBreakdown: { ...item.compatibility.scoreBreakdown },
  };
}

async function startSearchServer(
  services: MemoryServices,
  resolveAgentId: (externalId: string) => Promise<number | null>
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/search",
    createSearchRouter(services, { resolveAgentId })
  );
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

describe("hybridSearch compatibility wrapper", () => {
  it("returns legacy candidates but closes the retrieval with no delivered items", async () => {
    const first = memoryItem();
    const second = memoryItem({
      retrievalItemId: "44444444-4444-4444-8444-444444444444",
      memoryId: 43,
      content: "A lower-ranked candidate.",
      finalRank: 2,
    });
    const prepared = preparedWith([first, second]);
    const prepare = jest
      .fn<RetrievalService["prepare"]>()
      .mockResolvedValue(prepared);
    const deliver = jest
      .fn<RetrievalService["deliver"]>()
      .mockResolvedValue(responseWith([]));
    const search = jest.fn<RetrievalService["search"]>();

    const results = await hybridSearch(
      {
        agentId: 7,
        query: "quartz token",
        limit: 1,
        candidateLimit: 50,
        enableCA3: true,
        requestId: "request-1",
        sessionId: "session-1",
      },
      servicesWithRetrieval({ prepare, deliver, search })
    );

    expect(prepare).toHaveBeenCalledWith({
      agentId: 7,
      query: "quartz token",
      channel: "search",
      requestId: "request-1",
      sessionId: "session-1",
      limit: 1,
      enableCA3: true,
    });
    expect(deliver).toHaveBeenCalledWith(prepared, []);
    expect(search).not.toHaveBeenCalled();
    expect(results).toEqual([legacyResult(first)]);
    expect(Object.keys(results[0])).toEqual(Object.keys(legacyResult(first)));
  });
});

describe("REST search adapter", () => {
  it("preserves legacy fields and appends retrieval evidence from the shared service", async () => {
    const item = memoryItem();
    const retrieval = responseWith([item]);
    const search = jest
      .fn<RetrievalService["search"]>()
      .mockResolvedValue(retrieval);
    const resolveAgentId = jest.fn(async (externalId: string) =>
      externalId === "arlo" ? 7 : null
    );
    const server = await startSearchServer(
      servicesWithRetrieval({ search }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-2",
        },
        body: JSON.stringify({
          agentId: "arlo",
          query: "quartz token",
          limit: 3,
          sessionId: "session-2",
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        query: "quartz token",
        agentId: "arlo",
        resultCount: 1,
        results: [
          {
            ...legacyResult(item),
            retrievalItemId: item.retrievalItemId,
            kind: "memory",
            currentness: item.currentness,
            finalRank: item.finalRank,
            componentRanks: item.componentRanks,
            reasons: item.reasons,
            provenance: item.provenance,
            provenanceTruncated: item.provenanceTruncated,
          },
        ],
        retrievalId: RETRIEVAL_ID,
        algorithmVersion: "memory-retrieval-v1",
        buildId: "slice6-test-build",
        candidateCount: 4,
        returnedCount: 1,
        elapsedMs: 12,
        warnings: ["vector_lane_degraded"],
      });
      expect(resolveAgentId).toHaveBeenCalledWith("arlo");
      expect(search).toHaveBeenCalledWith({
        agentId: 7,
        query: "quartz token",
        channel: "search",
        requestId: "request-2",
        sessionId: "session-2",
        limit: 3,
      });
    } finally {
      await server.close();
    }
  });

  it("rejects invalid limits before retrieval", async () => {
    const search = jest.fn<RetrievalService["search"]>();
    const resolveAgentId = jest.fn(async () => 7);
    const server = await startSearchServer(
      servicesWithRetrieval({ search }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "arlo", query: "quartz", limit: 51 }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "limit must be an integer from 1 to 50",
      });
      expect(resolveAgentId).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["oversized ASCII", "x".repeat(8193)],
    ["oversized multibyte", "é".repeat(4097)],
    ["NUL", "quartz\u0000token"],
  ])("rejects an invalid %s query before agent lookup", async (_label, query) => {
    const search = jest.fn<RetrievalService["search"]>();
    const resolveAgentId = jest.fn(async () => 7);
    const server = await startSearchServer(
      servicesWithRetrieval({ search }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "arlo", query }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "query must be at most 8192 UTF-8 bytes and contain no NUL",
      });
      expect(resolveAgentId).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["whitespace", "   "],
    ["multibyte overflow", "😀".repeat(128)],
  ])("rejects an invalid %s session ID before agent lookup", async (_label, sessionId) => {
    const search = jest.fn<RetrievalService["search"]>();
    const resolveAgentId = jest.fn(async () => 7);
    const server = await startSearchServer(
      servicesWithRetrieval({ search }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "arlo", query: "quartz", sessionId }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "sessionId must be 1 to 128 trimmed UTF-8 bytes",
      });
      expect(resolveAgentId).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does not create a missing agent", async () => {
    const search = jest.fn<RetrievalService["search"]>();
    const resolveAgentId = jest.fn(async () => null);
    const server = await startSearchServer(
      servicesWithRetrieval({ search }),
      resolveAgentId
    );

    try {
      const response = await fetch(`${server.baseUrl}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "missing", query: "quartz" }),
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Agent 'missing' not found",
      });
      expect(resolveAgentId).toHaveBeenCalledWith("missing");
      expect(search).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
