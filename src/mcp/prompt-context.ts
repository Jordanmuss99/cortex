import { countTokens } from "../ingestion/chunker.js";

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
// When a live session block will be appended, memories yield more room to it.
const MEMORY_SHARE = 0.7;
const MEMORY_SHARE_WITH_SESSION = 0.5;

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
  sessionMarkdown?: string,
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

  // Section 1 — relevant memories. Give live session context room by shrinking the
  // memory share when a session block will be appended.
  const memoryShare = sessionMarkdown ? MEMORY_SHARE_WITH_SESSION : MEMORY_SHARE;
  const memoryBudget = Math.floor(tokenBudget * memoryShare);
  const memLines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = `${i + 1}. [P${r.priority}, r${Number(r.resonance_score).toFixed(1)}, ${dateOf(r.created_at)}] ${snippet(r.content, MEM_SNIPPET_CHARS)}`;
    const t = countTokens(line);
    if (usedTokens + t > memoryBudget) break;
    memLines.push(line);
    usedTokens += t;
  }
  if (memLines.length > 0) {
    const header = "## Relevant memories (scored)";
    parts.push(`${header}\n${memLines.join("\n")}`);
    usedTokens += countTokens(`${header}\n`);
  }

  // Section 1.5 — live session context (AgentBridge), truncated to remaining budget.
  // Always emitted when present (even the offline note) so the Rewriter sees live
  // context or an explicit "host offline" marker rather than silent absence.
  if (sessionMarkdown && sessionMarkdown.trim().length > 0) {
    const header = "## Active session context (AgentBridge)";
    const remain = Math.max(0, tokenBudget - usedTokens);
    let block = sessionMarkdown;
    if (countTokens(block) > remain) {
      const keep = Math.max(0, remain * 4 - header.length);
      block = keep > 0 ? block.slice(0, keep) + " …[truncated]" : block.slice(0, 80);
    }
    parts.push(`${header}\n${block}`);
    usedTokens += countTokens(`${header}\n${block}`);
  }

  // Section 2 — active entities (comma list) if room remains.
  if (topEntities.length > 0) {
    const line = `## Active entities\n${topEntities.join(", ")}`;
    const t = countTokens(line);
    if (usedTokens + t <= tokenBudget) {
      parts.push(line);
      usedTokens += t;
    }
  }

  // Section 3 — constraints from prior sessions (P0/P1 memories only).
  const constraintLines: string[] = [];
  for (const r of rows.filter((x) => x.priority <= 1)) {
    const line = `- [P${r.priority}] ${snippet(r.content, CONSTRAINT_SNIPPET_CHARS)}`;
    const t = countTokens(line);
    if (usedTokens + t > tokenBudget) break;
    constraintLines.push(line);
    usedTokens += t;
  }
  if (constraintLines.length > 0) {
    parts.push(`## Constraints from prior sessions\n${constraintLines.join("\n")}`);
  }

  const body = parts.length > 0 ? parts.join("\n\n") : "No relevant memories found.";
  const footer = `[CORTEX: ${rows.length} nodes, ~${usedTokens} est. tokens, agent=${agentId}]`;
  return `# CORTEX Prompt Context: "${query}"\n\n${body}\n\n---\n${footer}`;
}
