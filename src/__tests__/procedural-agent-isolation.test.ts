import { jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import * as actualSchema from "../db/schema.js";

const selectResults: Array<Array<{ id: number }>> = [];
const insertedValues: Array<Record<string, unknown>> = [];
const shareLocks: string[] = [];
const whereClauses: unknown[] = [];
const mockExecute = jest.fn<(...args: any[]) => any>();
const mockEmbedTexts = jest.fn<(...args: any[]) => any>();
const mockTransaction = jest.fn<(...args: any[]) => any>();

function selectBuilder(rows: Array<{ id: number }>) {
  const builder = {
    from: jest.fn(() => builder),
    where: jest.fn((clause: unknown) => {
      whereClauses.push(clause);
      return builder;
    }),
    for: jest.fn(async (mode: string) => {
      shareLocks.push(mode);
      return rows;
    }),
    then(resolve: (value: Array<{ id: number }>) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return builder;
}

const mockSelect = jest.fn(() => selectBuilder(selectResults.shift() ?? []));
const mockInsert = jest.fn(() => ({
  values(value: Record<string, unknown>) {
    insertedValues.push(value);
    return {
      async returning() {
        return [{ id: 91 }];
      },
    };
  },
}));

const mockDb = {
  select: mockSelect,
  execute: mockExecute,
  insert: mockInsert,
  transaction: mockTransaction,
};

mockTransaction.mockImplementation(async (operation: (transaction: unknown) => Promise<unknown>) =>
  await operation({ select: mockSelect, insert: mockInsert, execute: mockExecute })
);

jest.unstable_mockModule("../db/index.js", () => ({
  db: mockDb,
  schema: actualSchema,
}));

jest.unstable_mockModule("../ingestion/embeddings.js", () => ({
  embedTexts: mockEmbedTexts,
  embedQuery: jest.fn(),
}));

const {
  InvalidSourceMemoryReferencesError,
  ProceduralMemoryNotFoundError,
  assertSourceMemoriesOwnedByAgent,
  normalizeSourceMemoryIds,
  recordExecution,
  refineProcedural,
  storeProcedural,
} = await import("../procedural/index.js");

const validInput = {
  agentId: 7,
  name: "Safe workflow",
  description: "A workflow learned from owned memories",
  proceduralType: "workflow" as const,
  triggerContext: "When isolation matters",
  steps: ["Verify ownership", "Write atomically"],
  domainTags: ["security"],
  sourceMemoryIds: [11, 12, 11],
};

function compiledSql(statement: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(statement as Parameters<PgDialect["sqlToQuery"]>[0]);
}

describe("procedural source-memory ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selectResults.length = 0;
    insertedValues.length = 0;
    shareLocks.length = 0;
    whereClauses.length = 0;
    mockEmbedTexts.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mockTransaction.mockImplementation(async (operation: (transaction: unknown) => Promise<unknown>) =>
      await operation({ select: mockSelect, insert: mockInsert, execute: mockExecute })
    );
  });

  test("source IDs normalize duplicates and reject invalid or more than 100 unique values", () => {
    expect(normalizeSourceMemoryIds(undefined)).toEqual([]);
    expect(normalizeSourceMemoryIds([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
    expect(normalizeSourceMemoryIds(Array.from({ length: 101 }, () => 3))).toEqual([3]);

    for (const ids of [
      [0],
      [-1],
      [1.5],
      [2_147_483_648],
      [Number.MAX_SAFE_INTEGER + 1],
      Array.from({ length: 101 }, (_, index) => index + 1),
    ]) {
      expect(() => normalizeSourceMemoryIds(ids)).toThrow(
        InvalidSourceMemoryReferencesError
      );
    }
  });

  test("mixed foreign and nonexistent source memories fail before embedding or insert", async () => {
    selectResults.push([{ id: 11 }]);

    await expect(storeProcedural(validInput)).rejects.toMatchObject({
      code: "invalid_source_memory_references",
      requestedCount: 2,
      message: "One or more source memory references are invalid",
    });
    expect(mockEmbedTexts).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("foreign and nonexistent source IDs have indistinguishable errors", async () => {
    selectResults.push([], []);
    const errors = [];
    for (const ids of [[444], [555]]) {
      try {
        await assertSourceMemoriesOwnedByAgent(7, ids);
      } catch (error) {
        errors.push({
          name: (error as Error).name,
          message: (error as Error).message,
          code: (error as { code: string }).code,
          requestedCount: (error as { requestedCount: number }).requestedCount,
        });
      }
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual(errors[1]);
    expect(JSON.stringify(errors)).not.toMatch(/444|555/);
  });

  test("owned source memories are rechecked under a write-transaction share lock", async () => {
    selectResults.push([{ id: 11 }, { id: 12 }], [{ id: 11 }, { id: 12 }]);

    await expect(storeProcedural(validInput)).resolves.toBe(91);
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(shareLocks).toEqual(["share"]);
    expect(whereClauses).toHaveLength(2);
    for (const clause of whereClauses.map(compiledSql)) {
      expect(clause.sql).toContain('"memory_nodes"."agent_id" =');
      expect(clause.sql).toContain('"memory_nodes"."id" in');
      expect(clause.params).toEqual(expect.arrayContaining([7, 11, 12]));
    }
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      agentId: 7,
      sourceMemoryIds: [11, 12],
    });
  });

  test("a source ownership race aborts the transaction before insert", async () => {
    selectResults.push([{ id: 11 }, { id: 12 }], [{ id: 11 }]);

    await expect(storeProcedural(validInput)).rejects.toMatchObject({
      code: "invalid_source_memory_references",
      requestedCount: 2,
    });
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1);
    expect(shareLocks).toEqual(["share"]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("execute and refine map cross-agent record IDs to the same not-found result", async () => {
    mockExecute.mockResolvedValue({ rows: [] });

    await expect(recordExecution(7, 701, true)).rejects.toMatchObject({
      name: "ProceduralMemoryNotFoundError",
      code: "procedural_memory_not_found",
    });
    await expect(refineProcedural(7, 702, { description: "foreign" })).rejects.toBeInstanceOf(
      ProceduralMemoryNotFoundError
    );
    expect(mockEmbedTexts).not.toHaveBeenCalled();
    const statements = mockExecute.mock.calls.map(([statement]) => compiledSql(statement));
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toMatch(
      /where id = \$\d+ and agent_id = \$\d+/i
    );
    expect(statements[0].params).toEqual(expect.arrayContaining([701, 7]));
    expect(statements[1].sql).toMatch(
      /where id = \$\d+ and agent_id = \$\d+/i
    );
    expect(statements[1].params).toEqual(expect.arrayContaining([702, 7]));
  });
});
