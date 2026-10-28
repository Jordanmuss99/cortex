#!/usr/bin/env node
/**
 * Offline A/B replay of Cortex recall versions against real OmO session prompts.
 * For each real user prompt, rebuilds the compaction-window branch the model saw at that moment, runs each
 * Cortex version's before_agent_start handler, and reports injection rate, chunks, the share of injected
 * tokens already in context (redundancy), and handler latency (p50/p95/max).
 *
 * Usage: node recall_replay.mjs <session.jsonl> <cwd> <cortexA.js> [cortexB.js ...] [--max 200]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.CORTEX_TELEMETRY = "0"; // never write replay decisions into live runtime telemetry
const argv = process.argv.slice(2);
const maxIdx = argv.indexOf("--max");
const MAX = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 200;
const pos = argv.filter((a, i) => !(a === "--max" || (maxIdx >= 0 && i === maxIdx + 1)));
const [sessionFile, cwd, ...versions] = pos;
if (!sessionFile || !cwd || versions.length === 0) {
  console.error("usage: recall_replay.mjs <session.jsonl> <cwd> <cortexA.js> [cortexB.js ...]");
  process.exit(2);
}

const entries = fs
  .readFileSync(sessionFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const SYNTH = /^\s*(<(system-reminder|task-notification|background)|\[(background|monitor)|command running in background|successfully wrote|eval cell |```|ask: |background terminal|monitor )/i;
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("\n") : "");

// Build prompt points with the branch since last compaction (excluding prior cortex recalls, which a
// version-under-test would have produced itself)
const points = [];
let windowStart = 0;
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  if (e.type === "compaction") windowStart = i;
  if (e.message?.role === "user") {
    const p = textOf(e.message.content).trim();
    if (p.length >= 15 && !SYNTH.test(p)) {
      points.push({ prompt: p, branch: entries.slice(windowStart, i).filter((x) => x.customType !== "cortex-hippocampal-recall") });
    }
  }
}
const sample = points.slice(-MAX);

// One shared redundancy meter (first version exporting the v2.6 helpers) so every version is measured alike
let meter = null;
for (const v of versions) {
  const m = await import(pathToFileURL(path.resolve(v)).href);
  if (m.buildContextTokenSet && m.contextRedundancy) { meter = m; break; }
}

for (const v of versions) {
  const mod = await import(pathToFileURL(path.resolve(v)).href + `?t=${Date.now()}`);
  const handlers = new Map();
  const pi = {
    on: (ev, fn) => handlers.set(ev, fn),
    registerCommand() {},
    registerTool() {},
    getSessionName: () => "",
  };
  mod.default(pi);
  const bas = handlers.get("before_agent_start");
  handlers.get("session_start")?.({}, { cwd });
  let injectedTurns = 0;
  let chunks = 0;
  let tokens = 0;
  let redSum = 0;
  let redN = 0;
  const lat = [];
  for (const pt of sample) {
    const ctx = { cwd, sessionManager: { getBranch: () => pt.branch, getSessionId: () => "replay" } };
    const t0 = performance.now();
    const res = await bas({ prompt: pt.prompt, trigger: "prompt", systemPrompt: "" }, ctx);
    lat.push(performance.now() - t0);
    if (res?.message?.content) {
      injectedTurns++;
      const blocks = res.message.content.split(/\n---\n/);
      chunks += blocks.length;
      tokens += Math.ceil(res.message.content.length / 4);
      if (meter) {
        const set = meter.buildContextTokenSet("", pt.branch);
        for (const b of blocks) {
          redSum += meter.contextRedundancy(b.replace(/^(<cortex-recall>\n)?\[Cortex[^\]]*\]\n?/, ""), set);
          redN++;
        }
      }
    }
  }
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]?.toFixed(1);
  console.log(
    `${path.basename(v)}: prompts=${sample.length} injected=${injectedTurns} (${((100 * injectedTurns) / sample.length).toFixed(1)}%) chunks=${chunks} tokens=${tokens}` +
      (redN ? ` redundancy=${((100 * redSum) / redN).toFixed(1)}%` : "") +
      ` latency p50=${q(0.5)}ms p95=${q(0.95)}ms max=${lat[lat.length - 1]?.toFixed(1)}ms`
  );
}
