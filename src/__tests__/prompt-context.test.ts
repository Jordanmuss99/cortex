import { buildPromptContextDigest, PromptContextRow } from "../mcp/prompt-context";
import { countTokens } from "../ingestion/chunker";

function row(over: Partial<PromptContextRow>): PromptContextRow {
  return {
    content: "some memory content",
    priority: 2,
    resonance_score: 5,
    entities: [],
    created_at: "2026-10-01T12:00:00Z",
    ...over,
  };
}

describe("buildPromptContextDigest", () => {
  it("renders header, memory + entity sections and footer for populated rows", () => {
    const rows = [
      row({ content: "DECISION_7: use hybrid scoring", priority: 1, entities: ["cortex_search", "compaction_eval.py"] }),
      row({ content: "convention about token budgets", priority: 2, entities: ["cortex_recall"] }),
    ];
    const out = buildPromptContextDigest("refactor evaluator", rows, "arlo", 1200);
    expect(out).toContain('# CORTEX Prompt Context: "refactor evaluator"');
    expect(out).toContain("## Relevant memories (scored)");
    expect(out).toContain("## Active entities");
    expect(out).toContain("compaction_eval.py");
    expect(out).toContain("[CORTEX: 2 nodes");
    expect(out).toContain("agent=arlo]");
  });

  it("aggregates entities most-mentioned-first", () => {
    const rows = [
      row({ entities: ["shared", "rareA"] }),
      row({ entities: ["shared"] }),
      row({ entities: ["shared", "rareB"] }),
    ];
    const out = buildPromptContextDigest("q", rows, "arlo", 2000);
    const entitiesLine = (out.split("## Active entities\n")[1] || "").split("\n")[0];
    expect(entitiesLine.indexOf("shared")).toBeLessThan(entitiesLine.indexOf("rareA"));
  });

  it("lists only P0/P1 memories under constraints", () => {
    const rows = [
      row({ content: "hard invariant", priority: 0 }),
      row({ content: "important choice", priority: 1 }),
      row({ content: "weak note", priority: 2 }),
    ];
    const out = buildPromptContextDigest("q", rows, "arlo", 4000);
    const constraints = out.split("## Constraints from prior sessions\n")[1] || "";
    expect(constraints).toContain("[P0] hard invariant");
    expect(constraints).toContain("[P1] important choice");
    expect(constraints).not.toContain("weak note");
  });

  it.each([0, 4, 17, 1200])("bounds the whole digest to %i tokens including Unicode framing", budget => {
    const rows = [row({ content: "x".repeat(2000), priority: 1 })];
    const out = buildPromptContextDigest("\u4e16\u754c".repeat(2000), rows, "arlo", budget);
    expect(countTokens(out)).toBeLessThanOrEqual(budget);
  });

  it("empty rows produce a zero-node footer and no sections", () => {
    const out = buildPromptContextDigest("q", [], "arlo", 1200);
    expect(out).toContain("No relevant memories found.");
    expect(out).toContain("[CORTEX: 0 nodes");
    expect(out).not.toContain("## Active entities");
  });

});
