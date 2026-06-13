#!/usr/bin/env node
/**
 * Cortex session-end hook (Claude Code SessionEnd).
 *
 * Mirror of the OpenCode cortex-session-bootstrap.ts feed-forward: parses the
 * session transcript, counts cortex tool usage by verb, computes
 * Recall-and-Reconsolidate loop gaps, and writes a verdict to
 * ~/.cortex/claude-loop-compliance.json. The SessionStart hook
 * (cortex-session-start.mjs) reads that verdict at the NEXT session's boot and
 * injects the gaps so the agent sees its own report card.
 *
 * Input: Claude Code hook JSON on stdin ({ transcript_path, cwd, ... }).
 * Fails silently and exits 0 in all cases - never blocks session teardown.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const NON_TRIVIAL_TOOL_THRESHOLD = 5;
const NON_TRIVIAL_DURATION_MS = 5 * 60 * 1000;

function classify(verbs, toolName) {
  if (!/^mcp__cortex__/i.test(toolName)) return false;
  const n = toolName.toLowerCase();
  if (n.includes("reconsolidate")) verbs.reconsolidations++;
  else if (n.includes("skill_retrieve")) verbs.skillRetrieve++;
  else if (n.includes("skill_store")) verbs.skillStore++;
  else if (n.includes("skill_executed")) verbs.skillExecuted++;
  else if (n.includes("ingest")) verbs.ingests++;
  else if (n.includes("reason")) verbs.reason++;
  else if (n.includes("search") || n.includes("recall") || n.includes("init")) verbs.reads++;
  return true;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw); } catch { /* no input - nothing to do */ }
  const transcriptPath = input.transcript_path;
  if (!transcriptPath) return;

  let transcript;
  try { transcript = await readFile(transcriptPath, "utf-8"); } catch { return; }

  const verbs = { reads: 0, ingests: 0, reconsolidations: 0, skillRetrieve: 0, skillStore: 0, skillExecuted: 0, reason: 0 };
  let totalToolCalls = 0;
  let cortexCalls = 0;
  let firstTs = null;
  let lastTs = null;

  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.timestamp) {
      const t = Date.parse(entry.timestamp);
      if (Number.isFinite(t)) { if (firstTs === null) firstTs = t; lastTs = t; }
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block?.name !== "string") continue;
      totalToolCalls++;
      if (classify(verbs, block.name)) cortexCalls++;
    }
  }

  const durationMs = firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : 0;
  const isNonTrivial = totalToolCalls > NON_TRIVIAL_TOOL_THRESHOLD || durationMs > NON_TRIVIAL_DURATION_MS;
  if (!isNonTrivial) return; // a drive-by must not clobber a meaningful verdict

  const gaps = [];
  if (cortexCalls === 0) {
    gaps.push(`NO-CORTEX: ${totalToolCalls} tool calls over ${Math.round(durationMs / 1000)}s with zero cortex usage - prior context never consulted, nothing captured.`);
  }
  if (verbs.ingests > 0 && verbs.reads === 0) {
    gaps.push(`WRITE-WITHOUT-READ: ${verbs.ingests} ingest(s) with zero search/recall - prior context was never consulted.`);
  }
  if (verbs.ingests >= 3 && verbs.reconsolidations === 0) {
    gaps.push(`INGEST-HEAVY: ${verbs.ingests} ingests, 0 reconsolidations - were any of those really updates to existing memories?`);
  }
  if (verbs.skillStore > 0 && verbs.skillRetrieve === 0) {
    gaps.push(`SKILL VARIANT RISK: stored ${verbs.skillStore} skill(s) without checking cortex_skill_retrieve first - may duplicate an existing skill (use cortex_skill_refine).`);
  }
  if (verbs.skillRetrieve > 0 && verbs.skillExecuted === 0) {
    gaps.push(`SKILL-NOT-RECORDED: retrieved ${verbs.skillRetrieve} skill lookup(s) but recorded 0 executions - call cortex_skill_executed(procedural_id, success) after applying a skill; proficiency cannot grow otherwise.`);
  }

  const outDir = join(homedir(), ".cortex");
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "claude-loop-compliance.json"),
      JSON.stringify({ endedAt: new Date().toISOString(), cwd: input.cwd || null, durationMs, totalToolCalls, cortexCalls, verbs, gaps }, null, 2),
      "utf-8",
    );
  } catch { /* best-effort */ }
}

main().catch(() => {}).finally(() => process.exit(0));
