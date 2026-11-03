import { buildPromptContextDigest, PromptContextRow } from "../mcp/prompt-context";

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

  it("honors the token budget: a tiny budget yields no memory section", () => {
    const rows = [row({ content: "x".repeat(2000), priority: 1 })];
    const out = buildPromptContextDigest("q", rows, "arlo", 4); // memoryBudget = floor(4*0.7)=2
    expect(out).toContain("No relevant memories found.");
    expect(out).not.toContain("## Relevant memories (scored)");
  });

  it("empty rows produce a zero-node footer and no sections", () => {
    const out = buildPromptContextDigest("q", [], "arlo", 1200);
    expect(out).toContain("No relevant memories found.");
    expect(out).toContain("[CORTEX: 0 nodes");
    expect(out).not.toContain("## Active entities");
  });

  describe("session section", () => {
    const rows = [row({ content: "memory one", priority: 1, entities: ["e1"] })];

    it("omits the session section when no session markdown is supplied (default path)", () => {
      const out = buildPromptContextDigest("q", rows, "arlo", 1200);
      expect(out).not.toContain("## Active session context (AgentBridge)");
    });

    it("renders live session context when provided", () => {
      const out = buildPromptContextDigest(
        "q",
        rows,
        "arlo",
        2000,
        "Active sessions: 2/2 — FC (claude), W2 (omo)\nFocus: FC (claude) — holds claim",
      );
      expect(out).toContain("## Active session context (AgentBridge)");
      expect(out).toContain("FC (claude)");
    });

    it("always emits the session section even for the offline note on a tiny budget", () => {
      const offline = "[AgentBridge: host offline; rewriting without live session context]";
      const out = buildPromptContextDigest("q", rows, "arlo", 8, offline);
      expect(out).toContain("## Active session context (AgentBridge)");
      // Never a silent gap: the note (or a truncation of it) is present.
      expect(out).toContain("AgentBridge");
    });

    it("truncates an over-budget session block instead of dropping it", () => {
      const big = "word ".repeat(2000);
      const out = buildPromptContextDigest("q", rows, "arlo", 300, big);
      expect(out).toContain("…[truncated]");
      expect(out.length).toBeLessThan(4000);
    });
  });
});
