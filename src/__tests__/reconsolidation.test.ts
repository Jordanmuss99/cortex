import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as schema from "../db/schema.js";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let memoryRow: Record<string, unknown> | null = {};
let insertId = 900;

// Drizzle hands execute() an un-rendered SQL object of nested
// { queryChunks: [...] } structures with scalars interleaved; flatten it into
// (sql text, bound params) so assertions can inspect scope predicates.
function renderQuery(node: unknown, params: unknown[]): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((n) => renderQuery(n, params)).join("");
  if (typeof node === "object" && "queryChunks" in node) {
    return (node as { queryChunks: unknown[] }).queryChunks
      .map((c) => renderQuery(c, params))
      .join("");
  }
  // drizzle chunk wrapper: { value: [literalSqlPieces] }
  if (typeof node === "object" && "value" in node) {
    return renderQuery((node as { value: unknown }).value, params);
  }
  params.push(node);
  return "?";
}

function router(query: unknown): { rows: unknown[]; rowCount: number } {
  const params: unknown[] = [];
  const text = renderQuery(query, params).replace(/\s+/g, " ").trim();
  calls.push({ sql: text, params });
  if (/^SELECT /.test(text) && /WHERE id = \?/.test(text)) {
    if (!memoryRow) return { rows: [], rowCount: 0 };
    // Emulate the SQL's optional agent predicate: when the query is scoped
    // ("AND agent_id = ?" present), only the owning agent's row is returned.
    if (/AND agent_id = \?/.test(text)) {
      const scoped = params[params.length - 1];
      return scoped === memoryRow.agent_id
        ? { rows: [memoryRow], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [memoryRow], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

jest.unstable_mockModule("../db/index.js", () => ({
  schema,
  initDatabase: jest.fn(async () => undefined),
  db: { execute: jest.fn(async (q: unknown) => router(q)) },
}));
jest.unstable_mockModule("../ingestion/embeddings.js", () => ({
  embedTexts: async () => [[0, 1]],
  embedQuery: async () => [0, 1],
  EMBEDDING_DIM: 2,
  EMBEDDING_MODEL: "synthetic",
  EMBEDDING_PROVIDER: "synthetic",
}));
jest.unstable_mockModule("../hippocampus/index.js", () => ({
  hippocampalEncode: async () => ({
    sparseCode: { indices: [1, 2], values: [0.5, 0.5], dim: 4096 },
    noveltyResult: {
      noveltyScore: 0.5,
      resonanceScore: 6,
      adjustedPriority: 1,
      predictedSimilarity: 0.5,
      sparseMismatch: 0.5,
    },
  }),
  dgEncode: () => ({ indices: [], values: [], dim: 4096 }),
  computeNovelty: async () => ({}),
  patternComplete: async () => [],
  sparseOverlap: () => 0,
  sparseJaccard: () => 0,
  DG_CONFIG: {},
}));

let reconsolidate: typeof import("../reconsolidation/index.js").reconsolidate;
let dbMock: Record<string, unknown>;

const baseMemory = {
  id: 7,
  agent_id: 42,
  content: "old belief",
  source: "notes/x.md",
  priority: 2,
  resonance_score: 5,
  last_recalled_at: new Date("2026-11-06T12:00:00Z"),
};

beforeAll(async () => {
  ({ reconsolidate } = await import("../reconsolidation/index.js"));
  dbMock = (await import("../db/index.js")).db as unknown as Record<string, unknown>;
});

beforeEach(() => {
  calls = [];
  memoryRow = { ...baseMemory };
  insertId = 900;
  // Keep wall-clock inside the 1-hour labile window for the default fixture.
  jest.useFakeTimers({ now: Date.parse("2026-11-06T12:30:00Z") });
  // The stub db only emulates execute(); provide the drizzle insert().values().returning()
  // chain the correction-artifact write needs.
  dbMock.insert = () => ({
    values: () => ({ returning: async () => [{ id: ++insertId }] }),
  });
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const sqlFor = (fragment: string) => calls.find((c) => c.sql.includes(fragment));

describe("reconsolidate agent scoping (cross-tenant update boundary)", () => {
  it("pins the lookup to the caller's agent namespace when agentId is provided", async () => {
    const result = await reconsolidate(7, "new belief", "correction", 42);
    expect(result.status).toBe("reconsolidated");
    const query = sqlFor("WHERE id = ?");
    expect(query?.sql).toMatch(/AND agent_id = \?/);
    expect(query?.params).toContain(42);
  });

  it("reports not_found for another agent's memory without any UPDATE", async () => {
    const result = await reconsolidate(7, "new belief", "correction", 99);
    expect(result.status).toBe("not_found");
    expect(sqlFor("UPDATE memory_nodes")).toBeUndefined();
    expect(sqlFor("WHERE id = ?")?.params).toContain(99);
  });

  it("re-applies the owner predicate on the mutating UPDATE", async () => {
    await reconsolidate(7, "new belief", "correction", 42);
    const update = sqlFor("SET content");
    expect(update?.sql).toMatch(/agent_id = \?/);
  });

  it("keeps the legacy unscoped behavior when no agentId is passed", async () => {
    const result = await reconsolidate(7, "new belief", "correction");
    expect(result.status).toBe("reconsolidated");
    expect(sqlFor("WHERE id = ?")?.sql).not.toMatch(/WHERE .*agent_id/);
  });

  it("restabilizes by clearing the labile marker on success", async () => {
    await reconsolidate(7, "new belief", "correction", 42);
    const update = sqlFor("SET content");
    expect(update?.sql).toContain("last_recalled_at = NULL");
    expect(update?.sql).toContain("valid_until = NULL");
  });
});

describe("reconsolidate temporal semantics", () => {
  it("no longer performs the superseded intermediate valid_until=NOW() write", async () => {
    // The old code stamped valid_until = NOW() mid-function and then overwrote it
    // with NULL in the same call — dead work implying a supersession chain that
    // is never persisted. Success must not contain that statement.
    await reconsolidate(7, "new belief", "correction", 42);
    expect(calls.some((c) => /SET valid_until = NOW\(\)/.test(c.sql))).toBe(false);
  });

  it("refuses to update a memory recalled outside the one-hour window", async () => {
    memoryRow = { ...baseMemory, last_recalled_at: new Date("2026-11-06T10:00:00Z") };
    const result = await reconsolidate(7, "new belief", "correction", 42);
    expect(result.status).toBe("window_closed");
    expect(sqlFor("UPDATE memory_nodes")).toBeUndefined();
  });

  it("reports not_labile when the memory was never recalled", async () => {
    memoryRow = { ...baseMemory, last_recalled_at: null };
    const result = await reconsolidate(7, "new belief", "correction", 42);
    expect(result.status).toBe("not_labile");
  });

  it("reports not_found for missing or inactive memories", async () => {
    memoryRow = null;
    const result = await reconsolidate(7, "new belief", "correction", 42);
    expect(result.status).toBe("not_found");
  });
});
