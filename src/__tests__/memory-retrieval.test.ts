import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import { countTokens } from "../ingestion/chunker.js";
import {
  createRetrievalService,
  fuseCandidateRanks,
  isValidRetrievalQuery,
  SEARCH_RANK_FUSION_OPTIONS,
} from "../memory/retrieval.js";
import type {
  EmbeddedVector,
  LaneCandidate,
  MemoryConfig,
  MemoryServiceDependencies,
  RetrievalLane,
} from "../memory/types.js";

function memoryCandidate(
  lane: RetrievalLane,
  memoryId: number,
  sourceRank: number,
  sourceScore: number
): LaneCandidate {
  return {
    kind: "memory",
    memoryId,
    lane,
    sourceRank,
    sourceScore,
    content: `memory ${memoryId}`,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workingUuid(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function workingRow(index: number, content: string, displayOrder = index) {
  return {
    id: workingUuid(index),
    agent_id: 1,
    caller_key: `working:${index}`,
    kind: "current_task" as const,
    content,
    importance: 0.8,
    display_order: displayOrder,
    status: "active" as const,
    source_memory_id: null,
    source_event_id: null,
    last_confirmed_at: new Date("2026-08-29T09:00:00.000Z"),
    expires_at: new Date("2026-09-05T10:00:00.000Z"),
    resolved_at: null,
    resolution_reason: null,
  };
}

function fakeSql(
  handler: (query: string, values: readonly unknown[]) => unknown[] | Promise<unknown[]>,
  afterBegin?: () => void | Promise<void>
): {
  sql: MemoryServiceDependencies["sql"];
  queries: string[];
  calls: Array<{ query: string; values: readonly unknown[] }>;
} {
  type FakeSql = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>) & {
    array(values: readonly unknown[]): readonly unknown[];
    json(value: unknown): unknown;
    typed(value: unknown, oid: number): unknown;
    begin<T>(callback: (transaction: FakeSql) => Promise<T>): Promise<T>;
  };
  const queries: string[] = [];
  const calls: Array<{ query: string; values: readonly unknown[] }> = [];
  const tag = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const query = strings.join(" ? ").replace(/\s+/g, " ").trim();
    queries.push(query);
    calls.push({ query, values });
    return handler(query, values);
  }) as FakeSql;
  tag.array = (values: readonly unknown[]) => values;
  tag.json = (value: unknown) => value;
  tag.typed = (value: unknown, _oid: number) => value;
  tag.begin = async <T>(
    callback: (transaction: FakeSql) => Promise<T>
  ): Promise<T> => {
    const result = await callback(tag);
    await afterBegin?.();
    return result;
  };
  return {
    sql: tag as unknown as MemoryServiceDependencies["sql"],
    queries,
    calls,
  };
}

const config: MemoryConfig = {
  buildId: "slice6-test",
  projectionVersion: "memory-projection-v1",
  retrievalVersion: "memory-retrieval-v1",
  ingestWorkerConcurrency: 1,
  ingestMaxAttempts: 5,
  embeddingTimeoutMs: 20_000,
  retrievalCandidateLimit: 50,
  retrievalTelemetryRetentionDays: 30,
  synthesisEnabled: false,
  ca3Enabled: false,
};

const unitVector: EmbeddedVector = {
  values: [1, ...new Array(1023).fill(0)],
  provider: "test",
  model: "test-1024",
  dimensions: 1024,
  normalized: true,
};

function dependencies(
  sql: MemoryServiceDependencies["sql"],
  overrides: Partial<MemoryServiceDependencies> = {}
): MemoryServiceDependencies {
  return {
    db: {} as MemoryServiceDependencies["db"],
    sql,
    config,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    newId: () => "00000000-0000-4000-8000-000000000001",
    embedTexts: async () => ({ vectors: [], provider: "test", model: "test-1024" }),
    embedQuery: async () => unitVector,
    enrichEntities: async () => ({ entities: [], warnings: [] }),
    formSynapses: async () => 0,
    discoverSynapses: async (agentId, memoryIds, options) => ({
      agentId,
      newNodeIds: [...memoryIds],
      currentAt: options.currentAt ?? "2026-08-29T10:00:00.000Z",
      candidates: [],
    }),
    insertSynapses: async () => 0,
    patternComplete: async () => [],
    ...overrides,
  };
}

describe("fuseCandidateRanks", () => {
  it("is invariant to raw source-score scale", () => {
    const original = new Map<RetrievalLane, readonly LaneCandidate[]>([
      [
        "lexical",
        [
          memoryCandidate("lexical", 1, 1, 0.01),
          memoryCandidate("lexical", 2, 2, 0.009),
        ],
      ],
      [
        "vector",
        [
          memoryCandidate("vector", 2, 1, 0.9),
          memoryCandidate("vector", 1, 2, 0.8),
        ],
      ],
    ]);
    const rescaled = new Map<RetrievalLane, readonly LaneCandidate[]>([
      [
        "lexical",
        [
          memoryCandidate("lexical", 1, 1, 10_000),
          memoryCandidate("lexical", 2, 2, -40_000),
        ],
      ],
      [
        "vector",
        [
          memoryCandidate("vector", 2, 1, 9_000_000),
          memoryCandidate("vector", 1, 2, 8_000_000),
        ],
      ],
    ]);

    expect(
      fuseCandidateRanks(original).map((item) => ({
        id: item.kind === "memory" ? item.memoryId : -1,
        score: item.fusedScore,
      }))
    ).toEqual(
      fuseCandidateRanks(rescaled).map((item) => ({
        id: item.kind === "memory" ? item.memoryId : -1,
        score: item.fusedScore,
      }))
    );
  });

  it("uses the approved k and lane weights exactly", () => {
    const fused = fuseCandidateRanks(
      new Map<RetrievalLane, readonly LaneCandidate[]>([
        ["lexical", [memoryCandidate("lexical", 7, 1, 100)]],
        ["entity", [memoryCandidate("entity", 7, 2, 1)]],
        ["graph", [memoryCandidate("graph", 7, 3, 999)]],
      ]),
      SEARCH_RANK_FUSION_OPTIONS
    );

    expect(fused).toHaveLength(1);
    expect(fused[0].fusedScore).toBeCloseTo(
      1 / 61 + 0.8 / 62 + 0.5 / 63,
      12
    );
  });

  it("uses the approved 1.2 working-lane weight", () => {
    const candidate: LaneCandidate = {
      kind: "working_item",
      workingItemId: workingUuid(1),
      lane: "working",
      sourceRank: 1,
      sourceScore: 0.8,
      content: "Finish the current task",
    };

    const [fused] = fuseCandidateRanks(
      new Map<RetrievalLane, readonly LaneCandidate[]>([
        ["working", [candidate]],
      ]),
      SEARCH_RANK_FUSION_OPTIONS
    );

    expect(fused.fusedScore).toBeCloseTo(1.2 / 61, 12);
  });

  it("deduplicates a lane at its best rank and breaks numeric memory ties", () => {
    const fused = fuseCandidateRanks(
      new Map<RetrievalLane, readonly LaneCandidate[]>([
        [
          "lexical",
          [
            memoryCandidate("lexical", 10, 1, 4),
            memoryCandidate("lexical", 2, 1, 4),
            memoryCandidate("lexical", 2, 9, 999),
          ],
        ],
      ])
    );

    expect(
      fused.map((item) => (item.kind === "memory" ? item.memoryId : -1))
    ).toEqual([2, 10]);
    expect(fused[0].componentRanks).toEqual([
      { lane: "lexical", rank: 1, sourceScore: 4 },
    ]);
  });
});

describe("RetrievalService Slice 6 lifecycle", () => {
  it("persists candidates without cognition mutation and delivers only selected rows", async () => {
    const ids = [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    let itemIds: string[] = [];
    let completed = false;
    let delayedDelivery = false;
    const { sql, queries, calls } = fakeSql(async (query) => {
      if (query.includes("WITH lexical_query")) {
        return [
          { id: 1, content: "Cortex remembers Ron", source_score: 0.9 },
          { id: 2, content: "Another memory", source_score: 0.8 },
        ];
      }
      if (query.includes("node.embedding <=>")) {
        return [
          { id: 2, content: "Another memory", source_score: 0.95 },
          { id: 1, content: "Cortex remembers Ron", source_score: 0.7 },
        ];
      }
      if (query.includes("CROSS JOIN LATERAL") && query.includes("stored.term")) {
        return [{ id: 1, content: "Cortex remembers Ron", source_score: 2 }];
      }
      if (query.includes("node.resonance_score") && query.includes("FOR SHARE OF node")) {
        return [
          {
            id: 1,
            content: "Cortex remembers Ron",
            source: "session-a",
            source_type: "session",
            priority: 0,
            resonance_score: 0.5,
            entities: ["Ron"],
            semantic_tags: ["technical"],
            created_at: new Date("2026-08-20T00:00:00.000Z"),
            last_recalled_at: null,
            valid_from: null,
            valid_until: null,
            superseded_by: null,
          },
          {
            id: 2,
            content: "Another memory",
            source: null,
            source_type: "api",
            priority: 4,
            resonance_score: 0.5,
            entities: [],
            semantic_tags: [],
            created_at: new Date("2026-08-20T00:00:00.000Z"),
            last_recalled_at: null,
            valid_from: null,
            valid_until: null,
            superseded_by: null,
          },
        ];
      }
      if (query.includes("current_support.event_id")) return [];
      if (query.startsWith("SELECT agent_id")) {
        if (!completed && !delayedDelivery) {
          delayedDelivery = true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return [
          {
            agent_id: 1,
            algorithm_version: "memory-retrieval-v1",
            build_id: "slice6-test",
            candidate_count: 2,
            returned_count: completed ? 2 : 0,
            status: completed ? "completed" : "running",
            created_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      if (
        query.includes("FROM public.memory_retrieval_items AS item") &&
        query.includes("FOR UPDATE OF item, node")
      ) {
        return [
          {
            retrieval_item_id: itemIds[0],
            memory_id: 1,
            content_hash: sha256("Cortex remembers Ron"),
            content: "Cortex remembers Ron",
            final_rank: 1,
          },
          {
            retrieval_item_id: itemIds[1],
            memory_id: 2,
            content_hash: sha256("Another memory"),
            content: "Another memory",
            final_rank: 2,
          },
        ];
      }
      if (
        query.startsWith("UPDATE public.memory_retrieval_items") &&
        query.includes("RETURNING")
      ) {
        return [
          { id: itemIds[0], memory_id: 1 },
          { id: itemIds[1], memory_id: 2 },
        ];
      }
      if (
        query.includes("FROM public.memory_retrieval_items") &&
        query.includes("returned_at IS NOT NULL")
      ) {
        return [
          {
            id: itemIds[0],
            memory_id: 1,
            content_hash: sha256("Cortex remembers Ron"),
            final_rank: 1,
          },
          {
            id: itemIds[1],
            memory_id: 2,
            content_hash: sha256("Another memory"),
            final_rank: 2,
          },
        ];
      }
      if (
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
      ) {
        completed = true;
      }
      return [];
    });
    const patternComplete = jest.fn(async () => []);
    const deps = dependencies(sql, {
      newId: jest.fn(() => ids.shift()!),
      patternComplete,
    });
    const service = createRetrievalService(deps);

    const prepared = await service.prepare({
      agentId: 1,
      query: "Cortex Ron technical",
      channel: "search",
      limit: 1,
      enableCA3: true,
    });
    itemIds = prepared.candidates.map((candidate) => candidate.retrievalItemId);

    expect(prepared.candidates).toHaveLength(2);
    expect(prepared.candidates.every((item) => item.score >= 0 && item.score <= 1)).toBe(true);
    for (const candidate of prepared.candidates) {
      if (candidate.kind !== "memory") continue;
      expect(candidate.score).toBeLessThanOrEqual(
        candidate.compatibility.hybridScore
      );
      expect(candidate.score).toBeGreaterThanOrEqual(
        candidate.compatibility.hybridScore * 0.95
      );
    }
    expect(patternComplete).toHaveBeenCalledWith(
      1,
      unitVector.values,
      50,
      "2026-08-29T10:00:00.000Z"
    );
    const beforeDelivery = queries.join("\n");
    expect(beforeDelivery).not.toMatch(/UPDATE public\.memory_nodes/);
    expect(beforeDelivery).not.toMatch(/access_count|last_accessed_at|activation_count/);
    for (const query of queries.filter(
      (text) =>
        text.includes("WITH lexical_query") ||
        text.includes("node.embedding <=>") ||
        text.includes("stored.term") ||
        text.includes("FOR SHARE OF node")
    )) {
      expect(query).toContain("node.agent_id");
      expect(query).toContain("node.derivation_expires_at");
      expect(query).toContain("support_event.snapshot_valid_until >");
    }

    const originalComponentRank = prepared.candidates[0].componentRanks[0].rank;
    prepared.candidates[0].componentRanks[0].rank = originalComponentRank + 1;
    await expect(
      service.deliver(prepared, [prepared.candidates[0]])
    ).rejects.toThrow("mutated before delivery");
    prepared.candidates[0].componentRanks[0].rank = originalComponentRank;

    const delivered = await service.deliver(prepared, [
      prepared.candidates[1],
      prepared.candidates[0],
    ]);

    expect(delivered.results.map((item) => item.retrievalItemId)).toEqual(itemIds);
    expect(delivered.returnedCount).toBe(2);
    expect(delivered.elapsedMs).toBeGreaterThanOrEqual(20);
    const completionCall = calls.find(
      ({ query }) =>
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
    );
    expect(completionCall?.values).toContain(delivered.elapsedMs);
    delivered.results[0].reasons.push("caller-owned response mutation");
    const replayed = await service.deliver(prepared, [
      prepared.candidates[1],
      prepared.candidates[0],
    ]);
    expect(replayed.results.map((item) => item.retrievalItemId)).toEqual(itemIds);
    expect(replayed.results[0].reasons).not.toContain(
      "caller-owned response mutation"
    );

    prepared.candidates[0].content = "tampered after preparation";
    await expect(
      service.deliver(prepared, [prepared.candidates[1], prepared.candidates[0]])
    ).rejects.toThrow("mutated before delivery");
    const nodeUpdates = queries.filter((query) =>
      query.startsWith("UPDATE public.memory_nodes")
    );
    expect(nodeUpdates).toHaveLength(1);
    expect(nodeUpdates[0]).toContain("SET last_recalled_at");
    expect(nodeUpdates[0]).toContain("last_recalled_at <");
    expect(nodeUpdates[0]).not.toMatch(
      /access_count|last_accessed_at|resonance_score|activation_count/
    );
    const deliveryLock = queries.find(
      (query) =>
        query.includes("FROM public.memory_retrieval_items AS item") &&
        query.includes("FOR UPDATE OF item, node")
    );
    expect(deliveryLock).toContain("ORDER BY node.id ASC, item.id ASC");
  });

  it.each(["embedding", "query"] as const)(
    "keeps lexical/entity retrieval available when vector %s fails",
    async (outage) => {
      const ids = [
        "00000000-0000-4000-8000-000000000020",
        "00000000-0000-4000-8000-000000000021",
      ];
      const { sql, queries } = fakeSql(async (query) => {
        if (query.includes("WITH lexical_query")) {
          return [
            { id: 3, content: "Ron owns the decision", source_score: 0.5 },
          ];
        }
        if (query.includes("stored.term")) {
          return [{ id: 3, content: "Ron owns the decision", source_score: 1 }];
        }
        if (query.includes("node.embedding <=>") && outage === "query") {
          throw new Error("vector SQL failure must remain lane-local");
        }
        if (query.includes("node.resonance_score")) {
          return [
            {
              id: 3,
              content: "Ron owns the decision",
              source: null,
              source_type: "api",
              priority: 2,
              resonance_score: 0.5,
              entities: ["Ron"],
              semantic_tags: ["decision"],
              created_at: new Date("2026-08-20T00:00:00.000Z"),
              last_recalled_at: null,
              valid_from: null,
              valid_until: null,
              superseded_by: null,
            },
          ];
        }
        return [];
      });
      const patternComplete = jest.fn(async () => []);
      const service = createRetrievalService(
        dependencies(sql, {
          newId: jest.fn(() => ids.shift()!),
          embedQuery:
            outage === "embedding"
              ? jest.fn(async () => {
                  throw new Error("provider body must not escape");
                })
              : jest.fn(async () => unitVector),
          patternComplete,
        })
      );

      const prepared = await service.prepare({
        agentId: 1,
        query: "Ron decision",
        channel: "search",
        limit: 1,
        enableCA3: false,
      });

      expect(prepared.candidates).toHaveLength(1);
      expect(prepared.warnings).toEqual(["vector_lane_unavailable"]);
      expect(patternComplete).not.toHaveBeenCalled();
      expect(
        queries.some((query) => query.includes("node.embedding <=>"))
      ).toBe(outage === "query");
    }
  );

  it("rechecks currentness at one delivery instant and timestamps completion there", async () => {
    const ids = [
      "00000000-0000-4000-8000-000000000030",
      "00000000-0000-4000-8000-000000000031",
    ];
    let clock = "2026-08-29T10:00:00.000Z";
    let itemId = "";
    let completed = false;
    let loseCommitAcknowledgement = true;
    const { sql, queries, calls } = fakeSql(async (query, values) => {
      if (query.includes("WITH lexical_query")) {
        return [{ id: 4, content: "Short-lived memory", source_score: 1 }];
      }
      if (query.includes("node.resonance_score")) {
        return [
          {
            id: 4,
            content: "Short-lived memory",
            source: null,
            source_type: "api",
            priority: 4,
            resonance_score: 0.5,
            entities: [],
            semantic_tags: [],
            created_at: new Date("2026-08-20T00:00:00.000Z"),
            last_recalled_at: null,
            valid_from: null,
            valid_until: new Date("2026-08-29T10:01:00.000Z"),
            superseded_by: null,
          },
        ];
      }
      if (query.includes("current_support.event_id")) return [];
      if (query.startsWith("SELECT agent_id")) {
        return [
          {
            agent_id: 1,
            algorithm_version: "memory-retrieval-v1",
            build_id: "slice6-test",
            candidate_count: 1,
            returned_count: 0,
            status: completed ? "completed" : "running",
            created_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      if (
        query.includes("FROM public.memory_retrieval_items AS item") &&
        query.includes("FOR UPDATE OF item, node")
      ) {
        expect(values).toContain("2026-08-29T10:02:00.000Z");
        return [];
      }
      if (
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
      ) {
        completed = true;
      }
      return [];
    }, () => {
      if (completed && loseCommitAcknowledgement) {
        loseCommitAcknowledgement = false;
        throw new Error("simulated lost COMMIT acknowledgement");
      }
    });
    const service = createRetrievalService(
      dependencies(sql, {
        now: () => new Date(clock),
        newId: jest.fn(() => ids.shift()!),
      })
    );
    const prepared = await service.prepare({
      agentId: 1,
      query: "short lived",
      channel: "search",
      limit: 1,
    });
    itemId = prepared.candidates[0].retrievalItemId;
    expect(itemId).toBe("00000000-0000-4000-8000-000000000031");

    clock = "2026-08-29T10:02:00.000Z";
    await expect(
      service.deliver(prepared, [prepared.candidates[0]])
    ).rejects.toThrow("simulated lost COMMIT acknowledgement");
    expect(
      queries.some((query) => query.startsWith("UPDATE public.memory_nodes"))
    ).toBe(false);
    const completion = calls.find(
      ({ query }) =>
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
    );
    expect(completion?.values).toContain("2026-08-29T10:02:00.000Z");

    const replayed = await service.deliver(prepared, [prepared.candidates[0]]);
    expect(replayed.results).toEqual([]);
    expect(replayed.warnings).toContain("candidate_invalidated_before_delivery");
  });

  it("replays hash invalidation exactly but rejects changed or tampered selection", async () => {
    const ids = [
      "00000000-0000-4000-8000-000000000032",
      "00000000-0000-4000-8000-000000000033",
      "00000000-0000-4000-8000-000000000034",
    ];
    let itemIds: string[] = [];
    let completed = false;
    const { sql } = fakeSql(async (query) => {
      if (query.includes("WITH lexical_query")) {
        return [
          { id: 5, content: "Original content", source_score: 1 },
          { id: 6, content: "Unselected content", source_score: 0.5 },
        ];
      }
      if (query.includes("node.resonance_score")) {
        return [
          {
            id: 5,
            content: "Original content",
            source: null,
            source_type: "api",
            priority: 4,
            resonance_score: 0.5,
            entities: [],
            semantic_tags: [],
            created_at: new Date("2026-08-20T00:00:00.000Z"),
            last_recalled_at: null,
            valid_from: null,
            valid_until: null,
            superseded_by: null,
          },
          {
            id: 6,
            content: "Unselected content",
            source: null,
            source_type: "api",
            priority: 4,
            resonance_score: 0.5,
            entities: [],
            semantic_tags: [],
            created_at: new Date("2026-08-20T00:00:00.000Z"),
            last_recalled_at: null,
            valid_from: null,
            valid_until: null,
            superseded_by: null,
          },
        ];
      }
      if (query.includes("current_support.event_id")) return [];
      if (query.startsWith("SELECT agent_id")) {
        return [
          {
            agent_id: 1,
            algorithm_version: "memory-retrieval-v1",
            build_id: "slice6-test",
            candidate_count: 2,
            returned_count: 0,
            status: completed ? "completed" : "running",
            created_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      if (
        query.includes("FROM public.memory_retrieval_items AS item") &&
        query.includes("FOR UPDATE OF item, node")
      ) {
        return [
          {
            retrieval_item_id: itemIds[0],
            memory_id: 5,
            content_hash: sha256("Original content"),
            content: "Changed after preparation",
            final_rank: 1,
          },
        ];
      }
      if (
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
      ) {
        completed = true;
      }
      return [];
    });
    const service = createRetrievalService(
      dependencies(sql, {
        newId: jest.fn(() => ids.shift()!),
      })
    );
    const prepared = await service.prepare({
      agentId: 1,
      query: "hash invalidation",
      channel: "search",
      limit: 1,
    });
    itemIds = prepared.candidates.map((candidate) => candidate.retrievalItemId);

    const delivered = await service.deliver(prepared, [prepared.candidates[0]]);
    expect(delivered.results).toEqual([]);
    expect(delivered.warnings).toContain("candidate_invalidated_before_delivery");

    const replayed = await service.deliver(prepared, [prepared.candidates[0]]);
    expect(replayed.results).toEqual([]);
    expect(replayed.warnings).toEqual(delivered.warnings);

    await expect(
      service.deliver(prepared, [prepared.candidates[0], prepared.candidates[1]])
    ).rejects.toThrow("cannot be changed");

    prepared.candidates[0].content = "tampered retry content";
    await expect(
      service.deliver(prepared, [prepared.candidates[0]])
    ).rejects.toThrow("mutated before delivery");
  });

  it("caps persisted broad-fusion telemetry at the configured candidate limit", async () => {
    const laneRows = Array.from({ length: 75 }, (_, index) => ({
      id: index + 1,
      content: `memory ${index + 1}`,
      source_score: 75 - index,
    }));
    const hydratedRows = laneRows.map((row) => ({
      id: row.id,
      content: row.content,
      source: null,
      source_type: "api",
      priority: 4,
      resonance_score: 0.5,
      entities: [],
      semantic_tags: [],
      created_at: new Date("2026-08-20T00:00:00.000Z"),
      last_recalled_at: null,
      valid_from: null,
      valid_until: null,
      superseded_by: null,
    }));
    let idCounter = 40;
    const { sql, calls } = fakeSql(async (query) => {
      if (query.includes("WITH lexical_query")) return laneRows;
      if (query.includes("node.embedding <=>")) return laneRows;
      if (query.includes("node.resonance_score")) return hydratedRows;
      return [];
    });
    const service = createRetrievalService(
      dependencies(sql, {
        newId: () =>
          `00000000-0000-4000-8000-${String(idCounter++).padStart(12, "0")}`,
      })
    );

    const prepared = await service.prepare({
      agentId: 1,
      query: "broad query",
      channel: "search",
      limit: 1,
    });

    expect(prepared.candidates).toHaveLength(config.retrievalCandidateLimit);
    expect(prepared.candidates.at(-1)?.finalRank).toBe(
      config.retrievalCandidateLimit
    );
    const itemInsert = calls.find(({ query }) =>
      query.startsWith("INSERT INTO public.memory_retrieval_items")
    );
    expect(
      itemInsert?.values.some(
        (value) => {
          if (typeof value !== "string") return false;
          const parsed = JSON.parse(value) as unknown;
          return Array.isArray(parsed) && parsed.length === config.retrievalCandidateLimit;
        }
      )
    ).toBe(true);
  });

  it("records a real failure instant when a required lane fails", async () => {
    const instants = [
      "2026-08-29T10:00:00.000Z",
      "2026-08-29T10:00:05.000Z",
    ];
    const { sql, calls } = fakeSql(async (query) => {
      if (query.includes("WITH lexical_query")) {
        throw new Error("lexical lane unavailable");
      }
      return [];
    });
    const service = createRetrievalService(
      dependencies(sql, {
        now: () => new Date(instants.shift()!),
      })
    );

    await expect(
      service.prepare({
        agentId: 1,
        query: "required lane failure",
        channel: "search",
        limit: 1,
      })
    ).rejects.toThrow("lexical lane unavailable");

    const failedUpdate = calls.find(
      ({ query }) =>
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'failed'")
    );
    expect(failedUpdate?.query).toContain("completed_at = GREATEST");
    expect(failedUpdate?.values).toContain("2026-08-29T10:00:05.000Z");
  });

  it.each([
    ["oversized ASCII", "x".repeat(8193)],
    ["oversized multibyte", "é".repeat(4097)],
    ["NUL", "valid prefix\u0000suffix"],
  ])("rejects an invalid %s query before writing a retrieval header", async (_label, query) => {
    const { sql, queries } = fakeSql(async () => []);
    const service = createRetrievalService(dependencies(sql));

    await expect(
      service.prepare({
        agentId: 1,
        query,
        channel: "search",
        limit: 1,
      })
    ).rejects.toThrow();
    expect(queries).toEqual([]);
  });

  it("accepts exact ASCII and multibyte query-byte boundaries", () => {
    expect(isValidRetrievalQuery("x".repeat(8192))).toBe(true);
    expect(isValidRetrievalQuery("é".repeat(4096))).toBe(true);
    expect(isValidRetrievalQuery("😀".repeat(2048))).toBe(true);
    expect(isValidRetrievalQuery("😀".repeat(2048) + "x")).toBe(false);
    expect(isValidRetrievalQuery("   ")).toBe(false);
  });

  it.each([
    ["requestId", { requestId: "request\u0000id" }],
    ["sessionId", { sessionId: "session\u0000id" }],
  ])("rejects a NUL-bearing %s before writing telemetry", async (_field, metadata) => {
    const { sql, queries } = fakeSql(async () => []);
    const service = createRetrievalService(dependencies(sql));

    await expect(
      service.prepare({
        agentId: 1,
        query: "valid query",
        channel: "search",
        limit: 1,
        ...metadata,
      })
    ).rejects.toThrow("contain no NUL");
    expect(queries).toEqual([]);
  });
});

describe("RetrievalService Slice 7 working retrieval", () => {
  it("keeps ordinary search memory-only until its adapters support working evidence", async () => {
    const { sql, queries } = fakeSql(async (query) => {
      if (query.includes("public.working_memory_items")) {
        throw new Error("search must not start the working lane");
      }
      return [];
    });
    const service = createRetrievalService(dependencies(sql));

    const prepared = await service.prepare({
      agentId: 1,
      query: "ordinary search",
      channel: "search",
      limit: 5,
    });

    expect(prepared.candidates).toEqual([]);
    expect(
      queries.some((query) => query.includes("public.working_memory_items"))
    ).toBe(false);
    expect(
      queries.some((query) =>
        query.startsWith("INSERT INTO public.memory_retrieval_items")
      )
    ).toBe(false);
  });

  it("persists, delivers, and replays one-reference mixed evidence with working reserved first", async () => {
    const working = workingRow(1, "Ship the Slice 7 working-context path", 0);
    const memories = [
      {
        id: 1,
        content: "Long-term context one",
        source_score: 1,
      },
      {
        id: 2,
        content: "Long-term context two",
        source_score: 0.9,
      },
    ];
    type Persisted = {
      id: string;
      memoryId: number | null;
      workingItemId: string | null;
      contentHash: string;
      finalRank: number;
    };
    let persisted: Persisted[] = [];
    let completed = false;
    let idCounter = 500;
    const { sql, queries } = fakeSql(async (query, values) => {
      if (query.includes("item.importance::double precision AS source_score")) {
        return [
          {
            id: working.id,
            content: working.content,
            source_score: working.importance,
          },
        ];
      }
      if (query.includes("WITH lexical_query")) return memories;
      if (query.includes("node.embedding <=>")) return memories;
      if (query.includes("stored.term")) return [];
      if (query.includes("node.resonance_score") && query.includes("FOR SHARE OF node")) {
        return memories.map((row) => ({
          ...row,
          source: null,
          source_type: "api",
          priority: 4,
          resonance_score: 0.5,
          entities: [],
          semantic_tags: [],
          created_at: new Date("2026-08-20T00:00:00.000Z"),
          last_recalled_at: null,
          valid_from: null,
          valid_until: null,
          superseded_by: null,
        }));
      }
      if (
        query.includes("item.source_event_id::text AS source_event_id") &&
        query.includes("FOR SHARE OF item")
      ) {
        return [working];
      }
      if (query.includes("current_support.event_id")) return [];
      if (query.startsWith("INSERT INTO public.memory_retrieval_items")) {
        const serialized = values.find(
          (value) => typeof value === "string" && value.startsWith("[")
        );
        persisted = JSON.parse(String(serialized)) as Persisted[];
        return [];
      }
      if (query.startsWith("SELECT agent_id")) {
        return [
          {
            agent_id: 1,
            algorithm_version: "memory-retrieval-v1",
            build_id: "slice6-test",
            candidate_count: persisted.length,
            returned_count: completed ? persisted.length : 0,
            latency_ms: completed ? 1 : null,
            status: completed ? "completed" : "running",
            created_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      if (query.includes("FOR UPDATE OF item, node")) {
        return persisted.flatMap((entry) =>
          entry.memoryId === null
            ? []
            : [
                {
                  retrieval_item_id: entry.id,
                  memory_id: entry.memoryId,
                  working_item_id: null,
                  content_hash: entry.contentHash,
                  content: memories.find((row) => row.id === entry.memoryId)!
                    .content,
                  final_rank: entry.finalRank,
                },
              ]
        );
      }
      if (query.includes("FOR UPDATE OF item, working_item")) {
        return persisted.flatMap((entry) =>
          entry.workingItemId === null
            ? []
            : [
                {
                  retrieval_item_id: entry.id,
                  memory_id: null,
                  working_item_id: entry.workingItemId,
                  content_hash: entry.contentHash,
                  content: working.content,
                  final_rank: entry.finalRank,
                },
              ]
        );
      }
      if (
        query.startsWith("UPDATE public.memory_retrieval_items") &&
        query.includes("RETURNING")
      ) {
        return persisted.map((entry) => ({
          id: entry.id,
          memory_id: entry.memoryId,
          working_item_id: entry.workingItemId,
        }));
      }
      if (
        query.includes("FROM public.memory_retrieval_items") &&
        query.includes("returned_at IS NOT NULL")
      ) {
        return persisted.map((entry) => ({
          id: entry.id,
          memory_id: entry.memoryId,
          working_item_id: entry.workingItemId,
          content_hash: entry.contentHash,
          final_rank: entry.finalRank,
        }));
      }
      if (
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
      ) {
        completed = true;
      }
      return [];
    });
    const service = createRetrievalService(
      dependencies(sql, {
        config: { ...config, retrievalCandidateLimit: 2 },
        newId: () =>
          `00000000-0000-4000-8000-${String(idCounter++).padStart(12, "0")}`,
      })
    );

    const prepared = await service.prepare({
      agentId: 1,
      query: "current task context",
      channel: "init",
      limit: 2,
      tokenBudget: 800,
      enableCA3: false,
    });

    expect(prepared.candidates).toHaveLength(2);
    expect(prepared.candidates[0]).toMatchObject({
      kind: "working_item",
      workingItemId: working.id,
      finalRank: 1,
      score: 1,
    });
    expect(prepared.candidates[1].kind).toBe("memory");
    expect(persisted).toHaveLength(2);
    expect(
      persisted.every(
        (entry) =>
          Number(entry.memoryId !== null) +
            Number(entry.workingItemId !== null) ===
          1
      )
    ).toBe(true);

    const delivered = await service.deliver(prepared, prepared.candidates);
    expect(delivered.results.map((item) => item.kind)).toEqual([
      "working_item",
      "memory",
    ]);
    const replayed = await service.deliver(prepared, prepared.candidates);
    expect(replayed.results).toEqual(delivered.results);

    const workingQueries = queries.filter((query) =>
      query.includes("public.working_memory_items")
    );
    expect(workingQueries.length).toBeGreaterThanOrEqual(3);
    for (const query of workingQueries.filter((query) => query.includes("SELECT"))) {
      expect(query).toContain("item.agent_id");
      expect(query).toContain("item.status = 'active'");
      expect(query).toContain("item.expires_at >");
    }
    expect(
      queries.filter((query) => query.startsWith("UPDATE public.memory_nodes"))
    ).toHaveLength(1);
    expect(
      queries.some((query) =>
        query.startsWith("UPDATE public.working_memory_items")
      )
    ).toBe(false);
  });

  it("init scans all twelve active items, skips oversized entries, and emits eight delivered records", async () => {
    const oversized = Array.from({ length: 4 }, (_, index) =>
      workingRow(index + 1, `oversized-${index} ${"word ".repeat(1_300)}`)
    );
    const fitting = Array.from({ length: 8 }, (_, index) =>
      workingRow(index + 5, `fitting working item ${index + 5}`)
    );
    const allWorking = [...oversized, ...fitting];
    type Persisted = {
      id: string;
      memoryId: number | null;
      workingItemId: string | null;
      contentHash: string;
      finalRank: number;
    };
    let persisted: Persisted[] = [];
    let completed = false;
    let idCounter = 700;
    const { sql, calls } = fakeSql(async (query, values) => {
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.startsWith("SELECT id FROM public.agents")) return [{ id: 1 }];
      if (query.startsWith("SELECT item.*")) return allWorking;
      if (query.includes("item.importance::double precision AS source_score")) {
        return allWorking.map((item) => ({
          id: item.id,
          content: item.content,
          source_score: item.importance,
        }));
      }
      if (query.includes("WITH lexical_query")) return [];
      if (query.includes("node.embedding <=>")) return [];
      if (query.includes("stored.term")) return [];
      if (
        query.includes("item.source_event_id::text AS source_event_id") &&
        query.includes("FOR SHARE OF item")
      ) {
        return fitting;
      }
      if (query.startsWith("INSERT INTO public.memory_retrieval_items")) {
        const serialized = values.find(
          (value) => typeof value === "string" && value.startsWith("[")
        );
        persisted = JSON.parse(String(serialized)) as Persisted[];
        return [];
      }
      if (query.startsWith("SELECT agent_id")) {
        return [
          {
            agent_id: 1,
            algorithm_version: "memory-retrieval-v1",
            build_id: "slice6-test",
            candidate_count: persisted.length,
            returned_count: completed ? persisted.length : 0,
            latency_ms: completed ? 1 : null,
            status: completed ? "completed" : "running",
            created_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      if (query.includes("FOR UPDATE OF item, working_item")) {
        return persisted.map((entry) => {
          const item = fitting.find(
            (candidate) => candidate.id === entry.workingItemId
          )!;
          return {
            retrieval_item_id: entry.id,
            memory_id: null,
            working_item_id: entry.workingItemId,
            content_hash: entry.contentHash,
            content: item.content,
            final_rank: entry.finalRank,
          };
        });
      }
      if (
        query.startsWith("UPDATE public.memory_retrieval_items") &&
        query.includes("RETURNING")
      ) {
        return persisted.map((entry) => ({
          id: entry.id,
          memory_id: null,
          working_item_id: entry.workingItemId,
        }));
      }
      if (
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
      ) {
        completed = true;
      }
      return [];
    });
    const embedQuery = jest.fn(async (_query: string) => unitVector);
    const service = createRetrievalService(
      dependencies(sql, {
        embedQuery,
        newId: () =>
          `00000000-0000-4000-8000-${String(idCounter++).padStart(12, "0")}`,
      })
    );

    const result = await service.init(1, "session-7", "hint-tail");

    expect(result.workingItems.map((item) => item.id)).toEqual(
      fitting.map((item) => item.id)
    );
    expect(result.retrieval.results).toHaveLength(8);
    expect(result.retrieval.results.every((item) => item.kind === "working_item")).toBe(true);
    expect(result.workingTokensUsed).toBeLessThanOrEqual(800);
    expect(result.retrievalTokensUsed).toBe(0);
    expect(result.tokensUsed).toBe(countTokens(result.context));
    expect(result.tokensUsed).toBeLessThanOrEqual(1_600);
    const records = result.context.split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(8);
    expect(new Set(records.map((record) => record.workingItemId)).size).toBe(8);
    expect(
      records.every((record) =>
        result.retrieval.results.some(
          (item) => item.retrievalItemId === record.retrievalItemId
        )
      )
    ).toBe(true);
    expect(result.context).not.toContain("oversized-");
    expect(persisted.every((entry) => entry.memoryId === null)).toBe(true);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    const derivedQuery = embedQuery.mock.calls[0][0];
    expect(derivedQuery.indexOf(fitting[0].content)).toBeLessThan(
      derivedQuery.indexOf("hint-tail")
    );
    const listCall = calls.find(({ query }) => query.startsWith("SELECT item.*"));
    expect(listCall?.values).toContain(12);
  });

  it("init without a working item or hint completes empty without provider retrieval", async () => {
    let completed = false;
    const { sql, queries } = fakeSql(async (query) => {
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.startsWith("SELECT id FROM public.agents")) return [{ id: 1 }];
      if (query.startsWith("SELECT item.*")) return [];
      if (query.includes("item.importance::double precision AS source_score")) {
        return [];
      }
      if (query.startsWith("SELECT agent_id")) {
        return [
          {
            agent_id: 1,
            algorithm_version: "memory-retrieval-v1",
            build_id: "slice6-test",
            candidate_count: 0,
            returned_count: 0,
            latency_ms: completed ? 1 : null,
            status: completed ? "completed" : "running",
            created_at: new Date("2026-08-29T10:00:00.000Z"),
          },
        ];
      }
      if (
        query.startsWith("UPDATE public.memory_retrievals") &&
        query.includes("SET status = 'completed'")
      ) {
        completed = true;
      }
      return [];
    });
    const embedQuery = jest.fn(async () => {
      throw new Error("init must not make an arbitrary provider request");
    });
    const service = createRetrievalService(dependencies(sql, { embedQuery }));

    const result = await service.init(1);

    expect(result.workingItems).toEqual([]);
    expect(result.retrieval.results).toEqual([]);
    expect(result.context).toBe("");
    expect(result.tokensUsed).toBe(0);
    expect(result.workingTokensUsed).toBe(0);
    expect(result.retrievalTokensUsed).toBe(0);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(queries.some((query) => query.includes("WITH lexical_query"))).toBe(
      false
    );
    expect(queries.some((query) => query.includes("node.embedding <=>"))).toBe(
      false
    );
  });
});
