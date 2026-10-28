#!/usr/bin/env node
/**
 * OmO extension usage audit: are our systems actually used, and do they make a difference?
 *
 * Reads OmO session logs (~/.omo/agent/sessions/** /*.jsonl, read-only) and reports, per project:
 *   Cortex recall   - turns with an injection, chunks/turn, score spread, source mix, and a
 *                     UTILISATION rate: share of injected chunks whose distinctive tokens or source
 *                     filename show up in the assistant's reply/tool calls for that turn, against a
 *                     PLACEBO rate computed the same way for a random never-injected chunk from the
 *                     same project (counterfactual control, so lexical coincidence is not counted).
 *   Prompt cache    - cacheRead / (cacheRead + cacheWrite + input) hit ratio, cost, keepalive count.
 *   token-optimizer - duplicate folds and spills seen in tool results.
 *   project-guard   - blocked tool calls.
 *   omo built-ins   - kibitzer recalls, memory notices, reflection launches.
 *
 * Usage:
 *   node usage_audit.mjs [--days 7] [--json] [--project lucid-salk]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DAYS = Number(argVal("--days", "7"));
const ONLY = argVal("--project", "");
const AS_JSON = args.includes("--json");
const HOME = os.homedir();
const SESS_ROOT = path.join(HOME, ".omo", "agent", "sessions");
const CORTEX = path.join(HOME, ".omo", "agent", "extensions", "cortex-memory.js");
const sinceMs = Date.now() - DAYS * 86400000;

const STOP = new Set(
  "about after again against because before being between could doing during should their there these those through under until where which while would always never other using without within".split(
    " "
  )
);

function distinctiveTokens(text, exclude) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9_.\-]+/)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 6 || STOP.has(t) || /^\d+$/.test(t) || exclude.has(t)) continue;
    out.add(t);
  }
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!p) return "";
      if (p.type === "text") return p.text || "";
      if (p.type === "toolCall" || p.type === "tool_use") return JSON.stringify(p.arguments || p.input || {});
      return "";
    })
    .join("\n");
}

function projectKey(dirName) {
  const d = dirName.toLowerCase();
  if (d.includes("lucid-salk")) return "lucid-salk";
  if (d.includes("simsonline")) return "simsonline";
  if (d.includes("tarkov")) return "tarkov";
  if (d.includes("7dtd")) return "7dtd";
  return dirName.replace(/^-+|-+$/g, "").slice(-40);
}

function parseRecallChunks(content) {
  const chunks = [];
  const re = /\[Cortex #(\d+) \| ([^|]+?) \| score=([\d.]+) dg=([\d.]+)\]\n([\s\S]*?)(?=\n---\n\[Cortex #|\n<\/cortex-recall>|$)/g;
  for (const m of String(content).matchAll(re)) {
    chunks.push({ id: Number(m[1]), source: m[2].trim(), score: Number(m[3]), dg: Number(m[4]), body: m[5] });
  }
  return chunks;
}

function usedBy(chunk, prompt, reply, seenBefore) {
  // Novel-token attribution: a chunk token counts only if the reply introduces it for the first time in the
  // session (absent from the prompt, all prior session text, and this turn's tool results).
  const promptToks = distinctiveTokens(prompt, new Set());
  const toks = distinctiveTokens(chunk.body, promptToks);
  const replyToks = distinctiveTokens(reply, promptToks);
  const stem = path.basename(String(chunk.source).split("#")[0]).replace(/\.md$/i, "").toLowerCase();
  const stemHit = stem.length >= 6 && reply.toLowerCase().includes(stem) && !seenBefore.has(stem) && !prompt.toLowerCase().includes(stem);
  let hits = 0;
  for (const t of toks) if (replyToks.has(t) && !seenBefore.has(t)) hits++;
  return { used: stemHit || hits >= 2, hits, stemHit, pool: toks.size };
}

// Placebo pools: real Cortex chunks per project (never-injected controls)
const cortexMod = await import(pathToFileURL(CORTEX).href);
const placeboGraphs = {};
function placeboFor(proj) {
  if (placeboGraphs[proj] !== undefined) return placeboGraphs[proj];
  const cwd =
    proj === "lucid-salk"
      ? path.join(HOME, "Documents", "antigravity", "lucid-salk", "deadlock-ai")
      : proj === "simsonline"
      ? path.join(HOME, "Workspace", "Games", "SimsOnline")
      : null;
  if (!cwd) return (placeboGraphs[proj] = null);
  const g = new cortexMod.CortexLocalGraph();
  placeboGraphs[proj] = g.ensureIndexed(cwd) ? g : null;
  return placeboGraphs[proj];
}

let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const report = {};
const bucket = (p) =>
  (report[p] ??= {
    sessions: 0,
    realUserTurns: 0,
    recallTurns: 0,
    chunks: 0,
    used: 0,
    placeboUsed: 0,
    placeboN: 0,
    scores: [],
    sources: {},
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    cost: 0,
    assistantMsgs: 0,
    keepalive: 0,
    dupFolds: 0,
    spills: 0,
    guardBlocks: 0,
    kibitzerRecalls: 0,
    memoryNotices: 0,
    reflectionLaunches: 0,
    redundancySum: 0,
    redundancyN: 0,
    examplesUsed: [],
    examplesUnused: [],
  });

const SYNTHETIC_PROMPT =
  /^\s*(<(system-reminder|task-notification|background)|\[(background|monitor)|command running in background|successfully wrote|eval cell |```|ask: |background terminal|monitor )/i;

for (const dir of fs.existsSync(SESS_ROOT) ? fs.readdirSync(SESS_ROOT) : []) {
  const full = path.join(SESS_ROOT, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  const proj = projectKey(dir);
  if (ONLY && !proj.includes(ONLY)) continue;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith(".jsonl") || f.startsWith(".")) continue;
    const fp = path.join(full, f);
    if (fs.statSync(fp).mtimeMs < sinceMs) continue;
    const b = bucket(proj);
    b.sessions++;
    const entries = [];
    for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // partial line
      }
    }
    let pendingRecall = null;
    const seenBefore = new Set(); // distinctive tokens already present earlier in this session
    const absorb = (txt) => {
      for (const t of distinctiveTokens(txt, new Set())) seenBefore.add(t);
      for (const raw of String(txt || "").toLowerCase().split(/[^a-z0-9_\-]+/)) if (raw.length >= 6) seenBefore.add(raw);
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const ts = Date.parse(e.timestamp || e.message?.timestamp || 0) || 0;
      if (ts && ts < sinceMs) continue;
      if (e.type === "compaction") seenBefore.clear(); // context the model sees restarts at compaction
      if (e.type === "custom" && e.customType === "cache-keepalive") b.keepalive++;
      if (e.type === "custom_message" && e.customType === "omo-kibitzer:recall") b.kibitzerRecalls++;
      if (e.type === "custom_message" && e.customType === "omo-memory:notice") b.memoryNotices++;
      if (e.type === "custom" && e.customType === "senpi-memory.reflection-launched") b.reflectionLaunches++;
      if (e.type === "custom_message" && e.customType === "cortex-hippocampal-recall") {
        pendingRecall = parseRecallChunks(e.content);
        continue;
      }
      if (e.type === "custom_message" && typeof e.content === "string") absorb(e.content);
      const m = e.message;
      if (!m) continue;
      if (m.role === "toolResult") {
        const t = textOf(m.content);
        if (t.includes("[token-optimizer: exact duplicate")) b.dupFolds++;
        if (/\[token-optimizer:[^\]]*(spill|full output)/i.test(t)) b.spills++;
        if (m.isError && /blocked|sealed|project-guard|git_guard|engine_readonly/i.test(t.slice(0, 400))) b.guardBlocks++;
      }
      if (m.role === "assistant") {
        b.assistantMsgs++;
        const u = m.usage || {};
        b.cacheRead += u.cacheRead || 0;
        b.cacheWrite += u.cacheWrite || 0;
        b.input += u.input || 0;
        b.output += u.output || 0;
        b.cost += u.cost?.total || 0;
      }
      if (m.role === "user") {
        const prompt = textOf(m.content);
        if (prompt.trim().length < 15 || SYNTHETIC_PROMPT.test(prompt)) {
          pendingRecall = null;
          absorb(prompt);
          continue;
        }
        b.realUserTurns++;
        // Collect the assistant's reply for this turn (until next real user message); tool results seen
        // inside the turn are folded into the "already known" set so tool-sourced terms are not credited.
        let reply = "";
        const turnSeen = new Set(seenBefore);
        for (let j = i + 1; j < entries.length; j++) {
          const m2 = entries[j].message;
          if (m2?.role === "user") break;
          if (m2?.role === "assistant") reply += "\n" + textOf(m2.content);
          if (m2?.role === "toolResult") {
            const tt = textOf(m2.content);
            for (const raw of tt.toLowerCase().split(/[^a-z0-9_\-]+/)) if (raw.length >= 6) turnSeen.add(raw);
          }
        }
        if (pendingRecall && pendingRecall.length) {
          b.recallTurns++;
          for (const c of pendingRecall) {
            b.chunks++;
            b.scores.push(c.score);
            const top = String(c.source).split("/")[0];
            b.sources[top] = (b.sources[top] || 0) + 1;
            const r = usedBy(c, prompt, reply, turnSeen);
            const ct = distinctiveTokens(c.body, new Set());
            let red = 0; for (const t of ct) if (seenBefore.has(t)) red++;
            if (ct.size) { b.redundancySum += red / ct.size; b.redundancyN++; }
            if (r.used) b.used++;
            const ex = { score: c.score, source: c.source, hits: r.hits, stem: r.stemHit, prompt: prompt.slice(0, 90) };
            if (r.used && b.examplesUsed.length < 3) b.examplesUsed.push(ex);
            if (!r.used && b.examplesUnused.length < 3) b.examplesUnused.push(ex);
            // Placebo: random never-injected chunk scored against the same prompt/reply
            const g = placeboFor(proj);
            if (g && g.nodes.length) {
              const injected = new Set(pendingRecall.map((x) => x.id));
              let pick = null;
              for (let k = 0; k < 10 && !pick; k++) {
                const n = g.nodes[Math.floor(rnd() * g.nodes.length)];
                if (!injected.has(n.id)) pick = n;
              }
              if (pick) {
                b.placeboN++;
                if (usedBy({ body: pick.content, source: pick.source }, prompt, reply, turnSeen).used) b.placeboUsed++;
              }
            }
          }
        }
        pendingRecall = null;
        absorb(prompt);
        absorb(reply);
        for (const t of turnSeen) seenBefore.add(t);
      }
    }
  }
}

const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const out = {};
for (const [p, b] of Object.entries(report)) {
  const s = [...b.scores].sort((x, y) => x - y);
  const totalIn = b.cacheRead + b.cacheWrite + b.input;
  out[p] = {
    sessions: b.sessions,
    realUserTurns: b.realUserTurns,
    cortex: {
      recallTurns: b.recallTurns,
      recallRate: pct(b.recallTurns, b.realUserTurns),
      chunks: b.chunks,
      chunksPerRecall: b.recallTurns ? +(b.chunks / b.recallTurns).toFixed(2) : 0,
      scoreP10_P50_P90: s.length ? [s[Math.floor(s.length * 0.1)], s[Math.floor(s.length * 0.5)], s[Math.floor(s.length * 0.9)]] : [],
      utilisation: pct(b.used, b.chunks),
      placeboUtilisation: pct(b.placeboUsed, b.placeboN),
      liftOverPlacebo:
        b.placeboN && b.chunks
          ? +((b.used / b.chunks) / Math.max(1e-9, b.placeboUsed / b.placeboN)).toFixed(2)
          : null,
      contextRedundancy: b.redundancyN ? `${((100 * b.redundancySum) / b.redundancyN).toFixed(1)}%` : "n/a",
      sources: b.sources,
      examplesUsed: b.examplesUsed,
      examplesUnused: b.examplesUnused,
    },
    promptCache: {
      assistantMsgs: b.assistantMsgs,
      hitRatio: pct(b.cacheRead, totalIn),
      cacheReadM: +(b.cacheRead / 1e6).toFixed(2),
      cacheWriteM: +(b.cacheWrite / 1e6).toFixed(2),
      uncachedInputM: +(b.input / 1e6).toFixed(2),
      costUsd: +b.cost.toFixed(2),
      keepalivePings: b.keepalive,
    },
    tokenOptimizer: { duplicateFolds: b.dupFolds, spills: b.spills },
    projectGuard: { blocks: b.guardBlocks },
    omoBuiltins: { kibitzerRecalls: b.kibitzerRecalls, memoryNotices: b.memoryNotices, reflectionLaunches: b.reflectionLaunches },
  };
}

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const [p, r] of Object.entries(out)) {
    if (!r.realUserTurns && !r.promptCache.assistantMsgs) continue;
    console.log(`\n== ${p} (${r.sessions} sessions, ${r.realUserTurns} real user turns, last ${DAYS}d) ==`);
    console.log(
      `Cortex: ${r.cortex.recallTurns} recall turns (${r.cortex.recallRate}), ${r.cortex.chunks} chunks, ${r.cortex.chunksPerRecall}/turn, score p10/50/90=${r.cortex.scoreP10_P50_P90.join("/")}`
    );
    console.log(
      `        utilisation ${r.cortex.utilisation} vs placebo ${r.cortex.placeboUtilisation} (lift x${r.cortex.liftOverPlacebo}) | already-in-context ${r.cortex.contextRedundancy} | sources ${JSON.stringify(r.cortex.sources)}`
    );
    console.log(
      `Cache:  hit ${r.promptCache.hitRatio} | read ${r.promptCache.cacheReadM}M write ${r.promptCache.cacheWriteM}M uncached ${r.promptCache.uncachedInputM}M | $${r.promptCache.costUsd} | keepalive ${r.promptCache.keepalivePings}`
    );
    console.log(
      `TokOpt: ${r.tokenOptimizer.duplicateFolds} dup folds, ${r.tokenOptimizer.spills} spills | Guard: ${r.projectGuard.blocks} blocks | omo: kibitzer ${r.omoBuiltins.kibitzerRecalls}, notices ${r.omoBuiltins.memoryNotices}, reflections ${r.omoBuiltins.reflectionLaunches}`
    );
  }
}
