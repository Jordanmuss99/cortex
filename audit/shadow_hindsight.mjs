#!/usr/bin/env node
/**
 * Shadow-mode hindsight audit for the OmO cortex-memory.js extension.
 *
 * In shadow mode (CORTEX_SHADOW, default on) the extension makes every recall decision and logs it to
 * ~/.omo/memory/agents/<agent>/runtime/cortex-telemetry.jsonl, but injects nothing. This script asks, for
 * every logged would-inject decision: did the model, without seeing the chunk, go on to need its content?
 *
 * Rule (fixed before running; see shadow-hindsight.md):
 *   rare tokens of a chunk = its distinctive tokens (>= 6 chars, not a stopword, not numeric) that are absent
 *                            from the prompt and from all prior session context since the last compaction.
 *   USED                   = at least MIN_HITS (3) rare tokens appear in the following assistant text or tool
 *                            call inputs. Two windows: "turn" (until the next real user prompt) and "session"
 *                            (until session end or the next compaction).
 *   PLACEBO                = PLACEBO_DRAWS random chunks from the same agent's current index (never one the
 *                            decision would have injected, never a supermemory/ snapshot chunk), scored with
 *                            the same rule on the same prompt, prior context and following window.
 *
 * Chunk content is resolved from the agent's CURRENT index by exact source string (telemetry stores id and
 * source, not content). A chunk whose source no longer exists is reported as unresolved, never guessed.
 *
 * Read-only: reads telemetry, OmO session logs and memory notes. Writes nothing (telemetry disabled).
 * Usage: node shadow_hindsight.mjs [--json] [--since 2026-10-31] [--draws 20] [--min-hits 3] [--details]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.CORTEX_TELEMETRY = "0";

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const AS_JSON = args.includes("--json");
const DETAILS = args.includes("--details");
const SINCE_MS = Date.parse(argVal("--since", "1970-01-01"));
const PLACEBO_DRAWS = Number(argVal("--draws", "20"));
const MIN_HITS = Number(argVal("--min-hits", "3"));
const MATCH_WINDOW_MS = 10 * 60 * 1000;

const HOME = os.homedir();
const AGENTS_ROOT = path.join(HOME, ".omo", "memory", "agents");
const SESS_ROOT = path.join(HOME, ".omo", "agent", "sessions");
const CORTEX = path.join(HOME, ".omo", "agent", "extensions", "cortex-memory.js");

const STOP = new Set(
  "about after again against because before being between could doing during should their there these those through under until where which while would always never other using without within".split(
    " "
  )
);

function distinctiveTokens(text) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9_.\-]+/)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 6 || STOP.has(t) || /^\d+$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

function textOf(content, { toolInputs = true } = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!p) return "";
      if (p.type === "text") return p.text || "";
      if (toolInputs && (p.type === "toolCall" || p.type === "tool_use")) return JSON.stringify(p.arguments || p.input || {});
      return "";
    })
    .join("\n");
}

const SYNTHETIC_PROMPT =
  /^\s*(<(system-reminder|task-notification|background)|\[(background|monitor)|command running in background|successfully wrote|eval cell |```|ask: |background terminal|monitor )/i;

// Deterministic LCG (same constants as usage_audit.mjs) so placebo draws are reproducible.
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// One-sided exact binomial tail P(X >= k | n, p).
function binomTailGE(k, n, p) {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let logC = 0;
  let total = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) total += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, total);
}

// ── 1. Telemetry: every would-inject shadow decision ──
const decisions = [];
const perAgentAll = {};
for (const agent of fs.existsSync(AGENTS_ROOT) ? fs.readdirSync(AGENTS_ROOT) : []) {
  const f = path.join(AGENTS_ROOT, agent, "runtime", "cortex-telemetry.jsonl");
  if (!fs.existsSync(f)) continue;
  const s = (perAgentAll[agent] = { shadowDecisions: 0, liveDecisions: 0, wouldInject: 0, wouldInjectTokens: 0 });
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if ((Date.parse(r.at) || 0) < SINCE_MS) continue;
    if (r.shadow !== true) {
      s.liveDecisions++;
      continue;
    }
    s.shadowDecisions++;
    if (Array.isArray(r.injected) && r.injected.length) {
      s.wouldInject++;
      s.wouldInjectTokens += r.tokens || 0;
      decisions.push({ agent, ...r });
    }
  }
}

// ── 2. Session index: sessionId -> jsonl path ──
const sessionFiles = new Map();
for (const dir of fs.existsSync(SESS_ROOT) ? fs.readdirSync(SESS_ROOT) : []) {
  const full = path.join(SESS_ROOT, dir);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(full)) {
    const m = f.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (m) sessionFiles.set(m[1].toLowerCase(), path.join(full, f));
  }
}
const sessionCache = new Map();
function loadSession(id) {
  if (sessionCache.has(id)) return sessionCache.get(id);
  const fp = sessionFiles.get(String(id || "").toLowerCase());
  let entries = null;
  if (fp) {
    entries = [];
    for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // partial line
      }
    }
  }
  sessionCache.set(id, entries);
  return entries;
}

const isRealUser = (e) => {
  const m = e?.message;
  if (m?.role !== "user") return false;
  const t = textOf(m.content);
  return t.trim().length >= 15 && !SYNTHETIC_PROMPT.test(t);
};
const tsOf = (e) => Date.parse(e?.timestamp || e?.message?.timestamp || 0) || 0;

// ── 3. Agent graphs (current index) ──
const cortexMod = await import(pathToFileURL(CORTEX).href);
const graphs = new Map();
function graphFor(agent) {
  if (graphs.has(agent)) return graphs.get(agent);
  const g = new cortexMod.CortexLocalGraph(path.join(AGENTS_ROOT, agent));
  const ok = g.ensureIndexed(process.cwd());
  const bySource = new Map();
  if (ok) for (const n of g.nodes) if (!bySource.has(n.source)) bySource.set(n.source, n);
  const pool = ok ? g.nodes.filter((n) => !String(n.source).startsWith("supermemory/")) : [];
  const v = { ok, bySource, pool };
  graphs.set(agent, v);
  return v;
}

function scoreChunk(content, promptToks, priorToks, windowToks) {
  const rare = [];
  for (const t of distinctiveTokens(content)) if (!promptToks.has(t) && !priorToks.has(t)) rare.push(t);
  const hits = rare.filter((t) => windowToks.has(t));
  return { rare: rare.length, hits: hits.length, used: hits.length >= MIN_HITS, hitTokens: hits.slice(0, 8) };
}

// ── 4. Score each decision ──
const rows = [];
for (const d of decisions) {
  const row = {
    agent: d.agent,
    at: d.at,
    session: d.session,
    promptChars: d.promptChars,
    tokens: d.tokens || 0,
    status: "ok",
    chunks: [],
  };
  rows.push(row);
  const entries = loadSession(d.session);
  if (!entries) {
    row.status = "session-log-missing";
    continue;
  }
  // Match the prompt: the real user entry nearest to the decision time within the window.
  const atMs = Date.parse(d.at);
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < entries.length; i++) {
    if (!isRealUser(entries[i])) continue;
    const delta = Math.abs(tsOf(entries[i]) - atMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  if (best < 0 || bestDelta > MATCH_WINDOW_MS) {
    row.status = "prompt-unmatched";
    row.matchDeltaMs = best < 0 ? null : bestDelta;
    continue;
  }
  row.matchDeltaMs = bestDelta;
  const prompt = textOf(entries[best].message.content);
  row.matchedPromptChars = prompt.length;
  const promptToks = distinctiveTokens(prompt);

  // Prior context: everything the model could see before this prompt, reset at compaction.
  let prior = "";
  for (let i = 0; i < best; i++) {
    const e = entries[i];
    if (e.type === "compaction") {
      prior = typeof e.summary === "string" ? e.summary : "";
      continue;
    }
    if (e.type === "custom_message" && typeof e.content === "string") prior += "\n" + e.content;
    if (e.message) prior += "\n" + textOf(e.message.content);
  }
  const priorToks = distinctiveTokens(prior);

  // Following windows: assistant text + tool-call inputs only (tool RESULTS excluded, per the rule).
  let turnText = "";
  let sessText = "";
  let inTurn = true;
  for (let j = best + 1; j < entries.length; j++) {
    const e = entries[j];
    if (e.type === "compaction") break;
    if (isRealUser(e)) inTurn = false;
    if (e.message?.role === "assistant") {
      const t = textOf(e.message.content, { toolInputs: true });
      if (inTurn) turnText += "\n" + t;
      sessText += "\n" + t;
    }
  }
  const turnToks = distinctiveTokens(turnText);
  const sessToks = distinctiveTokens(sessText);
  row.turnChars = turnText.length;

  const g = graphFor(d.agent);
  const injectedSources = new Set(d.injected.map((c) => c.source));
  for (const c of d.injected) {
    const node = g.bySource.get(c.source);
    const ch = { source: c.source, score: c.score };
    row.chunks.push(ch);
    if (!node) {
      ch.status = "unresolved";
      continue;
    }
    ch.status = "ok";
    ch.turn = scoreChunk(node.content, promptToks, priorToks, turnToks);
    ch.session = scoreChunk(node.content, promptToks, priorToks, sessToks);
    // Placebo draws on the same prompt / prior / windows.
    ch.placebo = { draws: 0, turnUsed: 0, sessionUsed: 0 };
    for (let k = 0; k < PLACEBO_DRAWS && g.pool.length > 1; k++) {
      let pick = null;
      for (let tries = 0; tries < 20 && !pick; tries++) {
        const n = g.pool[Math.floor(rnd() * g.pool.length)];
        if (!injectedSources.has(n.source)) pick = n;
      }
      if (!pick) continue;
      ch.placebo.draws++;
      if (scoreChunk(pick.content, promptToks, priorToks, turnToks).used) ch.placebo.turnUsed++;
      if (scoreChunk(pick.content, promptToks, priorToks, sessToks).used) ch.placebo.sessionUsed++;
    }
  }
}

// ── 5. Aggregate ──
function aggregate(filter) {
  const a = {
    wouldInjectDecisions: 0,
    scorableDecisions: 0,
    tokens: 0,
    chunks: 0,
    chunksResolved: 0,
    chunksScorable: 0, // >= MIN_HITS rare tokens, i.e. could possibly count as used
    turnUsed: 0,
    sessionUsed: 0,
    decisionsTurnUsed: 0,
    decisionsSessionUsed: 0,
    placeboDraws: 0,
    placeboTurnUsed: 0,
    placeboSessionUsed: 0,
    statuses: {},
  };
  for (const r of rows.filter(filter)) {
    a.wouldInjectDecisions++;
    a.tokens += r.tokens;
    a.statuses[r.status] = (a.statuses[r.status] || 0) + 1;
    if (r.status !== "ok") continue;
    a.scorableDecisions++;
    let dt = false;
    let ds = false;
    for (const c of r.chunks) {
      a.chunks++;
      if (c.status !== "ok") continue;
      a.chunksResolved++;
      if (c.turn.rare >= MIN_HITS) a.chunksScorable++;
      if (c.turn.used) (a.turnUsed++, (dt = true));
      if (c.session.used) (a.sessionUsed++, (ds = true));
      a.placeboDraws += c.placebo.draws;
      a.placeboTurnUsed += c.placebo.turnUsed;
      a.placeboSessionUsed += c.placebo.sessionUsed;
    }
    if (dt) a.decisionsTurnUsed++;
    if (ds) a.decisionsSessionUsed++;
  }
  const rate = (x, n) => (n ? x / n : null);
  a.turnUsedRate = rate(a.turnUsed, a.chunksResolved);
  a.sessionUsedRate = rate(a.sessionUsed, a.chunksResolved);
  a.placeboTurnRate = rate(a.placeboTurnUsed, a.placeboDraws);
  a.placeboSessionRate = rate(a.placeboSessionUsed, a.placeboDraws);
  a.pTurnVsPlacebo = a.chunksResolved && a.placeboTurnRate !== null ? binomTailGE(a.turnUsed, a.chunksResolved, a.placeboTurnRate) : null;
  a.pSessionVsPlacebo =
    a.chunksResolved && a.placeboSessionRate !== null ? binomTailGE(a.sessionUsed, a.chunksResolved, a.placeboSessionRate) : null;
  return a;
}

const perAgent = {};
for (const agent of Object.keys(perAgentAll)) {
  const s = perAgentAll[agent];
  perAgent[agent] = {
    ...s,
    wouldInjectRate: s.shadowDecisions ? s.wouldInject / s.shadowDecisions : null,
    hindsight: aggregate((r) => r.agent === agent),
  };
}
const totals = Object.values(perAgentAll).reduce(
  (t, s) => ({
    shadowDecisions: t.shadowDecisions + s.shadowDecisions,
    liveDecisions: t.liveDecisions + s.liveDecisions,
    wouldInject: t.wouldInject + s.wouldInject,
    wouldInjectTokens: t.wouldInjectTokens + s.wouldInjectTokens,
  }),
  { shadowDecisions: 0, liveDecisions: 0, wouldInject: 0, wouldInjectTokens: 0 }
);
const overall = {
  ...totals,
  wouldInjectRate: totals.shadowDecisions ? totals.wouldInject / totals.shadowDecisions : null,
  hindsight: aggregate(() => true),
};

const result = {
  generatedAt: new Date().toISOString(),
  rule: { minHits: MIN_HITS, placeboDraws: PLACEBO_DRAWS, matchWindowMs: MATCH_WINDOW_MS, since: argVal("--since", "all") },
  overall,
  perAgent,
  ...(DETAILS ? { decisions: rows } : {}),
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const pc = (x) => (x === null || x === undefined ? "n/a" : `${(100 * x).toFixed(1)}%`);
  const line = (name, s) => {
    const h = s.hindsight;
    console.log(
      `${name.padEnd(28)} shadow ${String(s.shadowDecisions).padStart(4)} | would-inject ${String(s.wouldInject).padStart(3)} (${pc(
        s.wouldInjectRate
      )}) ${s.wouldInjectTokens} tok | chunks ${h.chunksResolved}/${h.chunks} resolved | used turn ${h.turnUsed} (${pc(
        h.turnUsedRate
      )}) vs placebo ${pc(h.placeboTurnRate)} | used session ${h.sessionUsed} (${pc(h.sessionUsedRate)}) vs placebo ${pc(
        h.placeboSessionRate
      )} | statuses ${JSON.stringify(h.statuses)}`
    );
  };
  for (const [a, s] of Object.entries(perAgent)) line(a, s);
  line("OVERALL", overall);
  console.log(
    `p(turn >= observed | placebo) = ${overall.hindsight.pTurnVsPlacebo?.toExponential(2)}; p(session >= observed | placebo) = ${overall.hindsight.pSessionVsPlacebo?.toExponential(2)}`
  );
}
