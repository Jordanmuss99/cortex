import { countTokens } from "../ingestion/chunker.js";
import { decode, encode } from "gpt-tokenizer";

/**
 * Pure digest builder for the cortex_prompt_context tool.
 *
 * Deliberately side-effect free (no DB, no embeddings) so the token-budget / section
 * logic can be unit-tested and reused. The MCP tool in server.ts does the hybrid
 * retrieval (runHybridSearch) and hands the scored rows to this function.
 */

// Minimal structural view of a hybrid-search row (only the fields we format).
// server.ts's HybridRow satisfies this via structural typing.
export type PromptContextRow = {
  content: string;
  priority: number;
  resonance_score: number;
  entities: string[] | null;
  created_at: string;
};

const MAX_ENTITIES = 15;
const MEM_SNIPPET_CHARS = 200;
const CONSTRAINT_SNIPPET_CHARS = 160;
// Memories get this share of the budget; entities + constraints compete for the rest.
const MEMORY_SHARE = 0.7;

function dateOf(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
}

function snippet(s: string, n: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, n);
}

export function buildPromptContextDigest(
  query: string,
  rows: PromptContextRow[],
  agentId: string,
  tokenBudget: number,
): string {
  // Aggregate entities across the matched memories (most-mentioned first).
  const entityCounts = new Map<string, number>();
  for (const r of rows) {
    for (const e of r.entities || []) entityCounts.set(e, (entityCounts.get(e) || 0) + 1);
  }
  const topEntities = [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTITIES)
    .map(([e]) => e);

  let usedTokens = 0;
  const parts: string[] = [];

  // Section 1 — relevant stored memories. The header rides on the first numbered
  // line so it is included in the per-line fit check and the usedTokens tally.
  const memoryBudget = Math.floor(tokenBudget * MEMORY_SHARE);
  const memLines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prefix = memLines.length === 0 ? "## Relevant memories (scored)\n" : "";
    const line = `${prefix}${i + 1}. [P${r.priority}, r${Number(r.resonance_score).toFixed(1)}, ${dateOf(r.created_at)}] ${snippet(r.content, MEM_SNIPPET_CHARS)}`;
    const t = countTokens(line);
    if (usedTokens + t > memoryBudget) break;
    memLines.push(line);
    usedTokens += t;
  }
  if (memLines.length > 0) {
    parts.push(memLines.join("\n"));
  }

  // Section 2 — active entities (comma list) if room remains. The header is part
  // of the same counted line, so the fit check below includes it.
  if (topEntities.length > 0) {
    const line = `## Active entities\n${topEntities.join(", ")}`;
    const t = countTokens(line);
    if (usedTokens + t <= tokenBudget) {
      parts.push(line);
      usedTokens += t;
    }
  }

  // Section 3 — constraints from prior sessions (P0/P1 memories only). The header
  // rides on the first bullet so it is counted in the fit check like the other
  // sections; the trailing hard slice still guarantees the overall budget.
  const constraintLines: string[] = [];
  for (const r of rows.filter((x) => x.priority <= 1)) {
    const prefix = constraintLines.length === 0 ? "## Constraints from prior sessions\n" : "";
    const line = `${prefix}- [P${r.priority}] ${snippet(r.content, CONSTRAINT_SNIPPET_CHARS)}`;
    const t = countTokens(line);
    if (usedTokens + t > tokenBudget) break;
    constraintLines.push(line);
    usedTokens += t;
  }
  if (constraintLines.length > 0) {
    parts.push(constraintLines.join("\n"));
  }

  const body = parts.length > 0 ? parts.join("\n\n") : "No relevant memories found.";
  const footer = `[CORTEX: ${rows.length} nodes, ~${usedTokens} est. tokens, agent=${agentId}]`;
  const displayQuery = Array.from(query).slice(0, 200).join("");
  const output = `# CORTEX Prompt Context: "${displayQuery}"\n\n${body}\n\n---\n${footer}`;
  return decode(encode(output, { allowedSpecial: "all" }).slice(0, tokenBudget));
}
