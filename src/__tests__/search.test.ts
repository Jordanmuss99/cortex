import { jest } from "@jest/globals";

const mockDbExecute = jest.fn<(...args: any[]) => any>();
const mockEmbedQuery = jest.fn<(...args: any[]) => any>();
const mockPatternComplete = jest.fn<(...args: any[]) => any>();
const mockMarkLabile = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule("../db/index.js", () => ({
  db: { execute: mockDbExecute },
  schema: {},
  initDatabase: jest.fn(),
}));

jest.unstable_mockModule("../ingestion/embeddings.js", () => ({
  embedQuery: mockEmbedQuery,
  embedTexts: jest.fn(),
}));

jest.unstable_mockModule("../hippocampus/index.js", () => ({
  patternComplete: mockPatternComplete,
  hippocampalEncode: jest.fn(),
  dgEncode: jest.fn(),
  sparseOverlap: jest.fn(),
  sparseJaccard: jest.fn(),
  DG_CONFIG: {},
}));

jest.unstable_mockModule("../reconsolidation/index.js", () => ({
  markLabile: mockMarkLabile,
  reconsolidate: jest.fn(),
  getLabileMemories: jest.fn(),
}));

const { hybridSearch } = await import("../api/search.js");

function makeRow(id: number, hybridScore: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: `memory \${id}`,
    source: "test",
    source_type: "note",
    priority: 2,
    resonance_score: 5,
    entities: null,
    semantic_tags: null,
    created_at: new Date().toISOString(),
    valid_from: null,
    valid_until: null,
    superseded_by: null,
    cosine_sim: 0.5,
    text_match: 0,
    recency: 0.5,
    norm_resonance: 0.5,
    priority_boost: 0.5,
    emotional_boost: 0,
    hybrid_score: hybridScore,
    ...overrides,
  };
}

describe("hybridSearch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbedQuery.mockResolvedValue(new Array(1024).fill(0.1));
  });

  it("returns hybrid-only results when CA3 is disabled", async () => {
    const initialRows = [makeRow(1, 0.6), makeRow(2, 0.5), makeRow(3, 0.4)];
    let call = 0;
    mockDbExecute.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve({ rows: initialRows });
      return Promise.resolve({ rows: [] });
    });
    mockPatternComplete.mockResolvedValue([{ memoryId: 99, activationScore: 100 }]);

    const results = await hybridSearch({ agentId: 1, query: "test", limit: 5, enableCA3: false });

    expect(results.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(results.every((r) => r.scoreBreakdown.ca3Activation === 0)).toBe(true);
    expect(mockDbExecute).toHaveBeenCalledTimes(2); // initial + access update
    expect(mockMarkLabile).not.toHaveBeenCalledWith(expect.arrayContaining([99]));
  });

  it("injects a CA3-only memory into the result set", async () => {
    const initialRows = [makeRow(1, 0.6), makeRow(2, 0.5)];
    const ca3OnlyRows = [makeRow(99, 0.45)];
    let call = 0;
    mockDbExecute.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve({ rows: initialRows });
      if (call === 3) return Promise.resolve({ rows: ca3OnlyRows });
      return Promise.resolve({ rows: [] });
    });
    mockPatternComplete.mockResolvedValue([{ memoryId: 99, activationScore: 50 }]);

    const results = await hybridSearch({ agentId: 1, query: "test", limit: 5, enableCA3: true });

    expect(results.some((r) => r.id === 99)).toBe(true);
    expect(mockDbExecute).toHaveBeenCalledTimes(3); // initial + access update + CA3-only fetch
    expect(mockMarkLabile).toHaveBeenCalledWith(expect.arrayContaining([99]));
  });

  it("normalizes CA3 so a low-hybrid CA3 hit cannot auto-rank #1", async () => {
    const initialRows = [makeRow(1, 0.8), makeRow(2, 0.7)];
    const ca3OnlyRows = [makeRow(99, 0.0)];
    let call = 0;
    mockDbExecute.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve({ rows: initialRows });
      if (call === 3) return Promise.resolve({ rows: ca3OnlyRows });
      return Promise.resolve({ rows: [] });
    });
    mockPatternComplete.mockResolvedValue([{ memoryId: 99, activationScore: 1000 }]);

    const results = await hybridSearch({ agentId: 1, query: "test", limit: 5, enableCA3: true });

    const ids = results.map((r) => r.id);
    expect(ids[0]).toBe(1);
    expect(ids).toContain(99);
    const ca3Row = results.find((r) => r.id === 99)!;
    expect(ca3Row.scoreBreakdown.ca3Activation).toBe(1);
    expect(ca3Row.score).toBeLessThan(results[0].score);
    expect(ca3Row.score).toBe(0.25); // 0.0 hybrid + 1.0 normalized * 0.25 weight
  });

  it("treats a zero CA3 activation set as no-op", async () => {
    const initialRows = [makeRow(1, 0.6)];
    let call = 0;
    mockDbExecute.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve({ rows: initialRows });
      return Promise.resolve({ rows: [] });
    });
    mockPatternComplete.mockResolvedValue([]);

    const results = await hybridSearch({ agentId: 1, query: "test", limit: 5, enableCA3: true });

    expect(results.map((r) => r.id)).toEqual([1]);
    expect(mockDbExecute).toHaveBeenCalledTimes(2); // no CA3-only fetch needed
  });

  it("exposes the base hybrid score and the blended score separately", async () => {
    const initialRows = [makeRow(1, 0.6)];
    mockDbExecute.mockResolvedValueOnce({ rows: initialRows }).mockResolvedValue({ rows: [] });
    mockPatternComplete.mockResolvedValue([]);

    const results = await hybridSearch({ agentId: 1, query: "test", limit: 5 });

    expect(results[0].hybridScore).toBe(0.6);
    expect(results[0].score).toBe(0.6);
  });
});
