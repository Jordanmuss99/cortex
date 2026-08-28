import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

const originalEnabled = process.env.CORTEX_LLM_ENTITIES;
process.env.CORTEX_LLM_ENTITIES = "true";

const mockLlmComplete = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule("../lib/llm.js", () => ({
  llmComplete: mockLlmComplete,
}));

const { extractEntitiesWithDiagnostics } = await import(
  "../ingestion/entities.js"
);

beforeEach(() => {
  jest.restoreAllMocks();
  mockLlmComplete.mockReset();
});

afterAll(() => {
  if (originalEnabled === undefined) delete process.env.CORTEX_LLM_ENTITIES;
  else process.env.CORTEX_LLM_ENTITIES = originalEnabled;
});

describe("optional entity enrichment", () => {
  it("supplements deterministic entities with strict bounded LLM output", async () => {
    mockLlmComplete.mockResolvedValue({
      content: '["Acme Corp","Jane Smith"]',
    });

    await expect(
      extractEntitiesWithDiagnostics("Sarah Johnson met the CEO.")
    ).resolves.toEqual({
      entities: ["Acme Corp", "Jane Smith", "Sarah Johnson"],
      warnings: [],
    });
  });

  it.each([
    ["missing credentials", new Error("slice3-private-missing-key")],
    ["timeout", new Error("slice3-private-timeout-body")],
    ["malformed result", { content: "slice3-private-malformed-result" }],
    [
      "prefixed JSON result",
      { content: 'slice3-private-prefix ["Jane Smith"]' },
    ],
  ])("falls back deterministically on %s with one safe warning", async (_name, failure) => {
    const canary = "slice3-private-entity-error-name";
    if (failure instanceof Error) failure.name = canary;
    if (failure instanceof Error) mockLlmComplete.mockRejectedValue(failure);
    else mockLlmComplete.mockResolvedValue(failure);
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      extractEntitiesWithDiagnostics("Sarah Johnson met the CEO.")
    ).resolves.toEqual({
      entities: ["Sarah Johnson"],
      warnings: ["entity_enrichment_degraded"],
    });
    expect(errorLog).toHaveBeenCalledWith(
      "[entities] Optional enrichment degraded",
      { code: "entity_enrichment_degraded" }
    );
    const serializedLogs = JSON.stringify(errorLog.mock.calls);
    expect(serializedLogs).not.toContain(canary);
    expect(serializedLogs).not.toContain("slice3-private");
  });
});
