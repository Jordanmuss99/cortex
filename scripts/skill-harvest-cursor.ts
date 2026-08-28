#!/usr/bin/env tsx
/**
 * Cortex Skill Harvester -- Cursor-only (Node port of skill-harvest.ts)
 * ---------------------------------------------------------------------
 * Extracts repeatable workflows/procedures from Cursor agent transcripts and
 * stores them as procedural memories (skills) via the REST API.
 *
 * Solves the "learning stall": agents never call cortex_skill_store
 * voluntarily, so skill capture must be deterministic. Runs nightly after
 * reflect in the cortex-cron sidecar.
 *
 * Usage:
 *   npx tsx scripts/skill-harvest-cursor.ts [--dry-run] [--limit 20] [--since-hours N]
 *
 * Env (same conventions as reflect-cursor.ts):
 *   CORTEX_REST_URL        default http://127.0.0.1:3100
 *   CORTEX_AGENT_ID        default arlo
 *   OLLAMA_URL             primary LLM endpoint (default local Ollama)
 *   OLLAMA_API_KEY         bearer token for primary (optional for local)
 *   REFLECT_MODEL          default qwen3-coder:30b
 *   REFLECT_FALLBACK_URL   fallback endpoint (default abc-tunnel proxy)
 *   REFLECT_FALLBACK_KEY   bearer token for fallback
 *   REFLECT_FALLBACK_MODEL default glm-5.2a
 *   REFLECT_NUM_CTX        default 65536 (native Ollama context window)
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Agent, setGlobalDispatcher } from "undici";

// See reflect-cursor.ts: raise undici's 300s headersTimeout for slow local models.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }));

const HOME = homedir();
const CORTEX_URL = process.env.CORTEX_REST_URL || "http://127.0.0.1:3100";
const AGENT_ID = process.env.CORTEX_AGENT_ID || "arlo";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://192.168.30.3:11434/v1";
const MODEL = process.env.REFLECT_MODEL || "qwen3-coder:30b";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const FALLBACK_URL = process.env.REFLECT_FALLBACK_URL || "https://rfyj2z2.abc-tunnel.us/v1";
const FALLBACK_MODEL = process.env.REFLECT_FALLBACK_MODEL || "glm-5.2a";
const FALLBACK_KEY = process.env.REFLECT_FALLBACK_KEY || "";
const NUM_CTX = parseInt(process.env.REFLECT_NUM_CTX || "65536", 10);

const CORTEX_DIR = join(HOME, ".cortex");
const STATE_FILE = join(CORTEX_DIR, "skill-harvest-state.json");
const LOG_FILE = join(CORTEX_DIR, "reflect.log");

const CURSOR_PROJECTS = join(HOME, ".cursor", "projects");

const MAX_CHARS = 120_000;
// See reflect-cursor.ts: local CPU prefill of the full slice blows undici's
// 300s headers timeout; cap the local slice so it completes.
const MAX_CHARS_LOCAL = parseInt(process.env.REFLECT_MAX_CHARS_LOCAL || "40000", 10);
const MIN_CHARS = 800; // skills need richer context than episodic reflect

const SKILL_PROMPT = `You are a procedural memory extraction assistant. Given an AI agent's session transcript, identify REPEATABLE WORKFLOWS, PROCEDURES, and PATTERNS that the agent executed -- things that could be reused in future sessions. Focus on:

1. Multi-step procedures the agent performed (build steps, test sequences, deployment flows, debugging workflows)
2. Tool usage patterns that worked (specific CLI commands, API call sequences, configuration steps)
3. Workarounds and fallbacks the agent discovered (when X fails, do Y)
4. Verification patterns (how to check if something works)

NOT episodic facts or decisions (those are captured separately by the reflect script).

Format: [{"name": "short name", "triggerContext": "when to use this (1-2 sentences)", "steps": ["step 1", "step 2", ...], "proceduralType": "workflow|pattern|workaround|verification", "tags": ["..."]}]

Skip trivial content. Only extract things that are genuinely repeatable across sessions. Return ONLY the JSON array.

Transcript:
`;

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string, d: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY = has("--dry-run");
const LIMIT = parseInt(val("--limit", "20"), 10);
const SINCE_HOURS = val("--since-hours", "");

function log(msg: string) {
  const line = `${new Date().toISOString()}  [skill-harvest] ${msg}`;
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
  console.log(line);
}

type State = { lastRunMs: number };
function loadState(): State {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch { return { lastRunMs: 0 } }
}
function saveState(s: State) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch {} }

const startMs = Date.now();
const state = loadState();
const sinceMs = SINCE_HOURS
  ? startMs - parseInt(SINCE_HOURS, 10) * 3_600_000
  : state.lastRunMs || startMs - 26 * 3_600_000;

// ─── LLM extraction (local-first with fallback, same as reflect-cursor) ─────

interface LLMEndpoint { url: string; model: string; apiKey: string; label: string; native: boolean }

const ENDPOINTS: LLMEndpoint[] = [
  { url: OLLAMA_URL, model: MODEL, apiKey: OLLAMA_API_KEY, label: "primary", native: /:11434/.test(OLLAMA_URL) },
  { url: FALLBACK_URL, model: FALLBACK_MODEL, apiKey: FALLBACK_KEY, label: "fallback", native: false },
];

let hadExtractionFailure = false;

function parseJsonArray(out: string, source: string, label: string): any[] {
  // Balanced-bracket scan (greedy regex breaks on reasoning-model prose).
  const starts: number[] = [];
  for (let i = 0; i < out.length; i++) if (out[i] === "[") starts.push(i);
  if (starts.length === 0) { log(`  - ${source}: ${label} returned no JSON array`); return [] }

  for (const start of starts) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < out.length; i++) {
      const ch = out[i];
      if (esc) { esc = false; continue }
      if (ch === "\\") { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue;
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            const items = JSON.parse(out.slice(start, i + 1));
            if (Array.isArray(items) && items.some(x => x && typeof x === "object")) return items;
          } catch { /* try next start */ }
          break;
        }
      }
    }
  }
  log(`  - ${source}: ${label} JSON parse failed`);
  return [];
}

async function callEndpoint(ep: LLMEndpoint, transcript: string, source: string): Promise<any[] | null> {
  const maxChars = ep.native ? MAX_CHARS_LOCAL : MAX_CHARS;
  const messages = [
    { role: "system", content: "You are a procedural memory extraction assistant. Return only a JSON array." },
    { role: "user", content: SKILL_PROMPT + transcript.slice(0, maxChars) + "\n--- TRANSCRIPT END ---\n" },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (ep.apiKey) headers["Authorization"] = `Bearer ${ep.apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 900_000);
      const url = ep.native
        ? `${ep.url.replace(/\/v1\/?$/, "")}/api/chat`
        : `${ep.url}/chat/completions`;
      const body = ep.native
        ? { model: ep.model, messages, options: { num_ctx: NUM_CTX, temperature: 0.3 }, stream: false }
        : { model: ep.model, messages, max_tokens: 4000, temperature: 0.3, stream: false };
      resp = await fetch(url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body) });
      clearTimeout(timer);
    } catch (e) {
      log(`  ~ ${source}: ${ep.label} unreachable (${(e as Error)?.message || e})`);
      return null;
    }

    if (resp.ok) {
      const data: any = await resp.json();
      const msg = ep.native ? data?.message : data?.choices?.[0]?.message;
      const out = [msg?.content, msg?.reasoning_content, msg?.reasoning]
        .filter((s: any) => typeof s === "string").join("\n");
      return parseJsonArray(out, source, ep.label);
    }

    if (resp.status === 429 || resp.status === 503) {
      const wait = (attempt + 1) * 5000;
      log(`  ~ ${source}: ${ep.label} ${resp.status}, retry in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    log(`  ! ${source}: ${ep.label} HTTP ${resp.status}`);
    return null;
  }
  return null;
}

async function extractSkills(transcript: string, source: string): Promise<any[]> {
  for (const ep of ENDPOINTS) {
    const result = await callEndpoint(ep, transcript, source);
    if (result !== null) {
      if (result.length === 0) log(`  · ${source}: 0 skills (${ep.label})`);
      return result;
    }
  }
  log(`  ! ${source}: all LLM endpoints failed`);
  hadExtractionFailure = true;
  return [];
}

// ─── Store skills via REST (dedup against existing skills first) ────────────

async function storeSkills(items: any[], source: string): Promise<number> {
  let n = 0;
  for (const it of items) {
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    const trigger = typeof it?.triggerContext === "string" ? it.triggerContext.trim() : "";
    const steps = Array.isArray(it?.steps) ? it.steps.map((s: any) => String(s)) : [];
    const pType = typeof it?.proceduralType === "string" ? it.proceduralType : "workflow";
    const tags = Array.isArray(it?.tags) ? it.tags.slice(0, 6).map((t: any) => String(t)) : [];

    if (name.length < 5 || trigger.length < 10 || steps.length === 0) continue;

    if (DRY) {
      log(`    [dry] "${name}" (${pType}, ${steps.length} steps)`);
      n++;
      continue;
    }

    // Dedup: retrieve existing skills matching this name/trigger; skip if a
    // close match exists (skill-refine is the update path, not re-store).
    try {
      const dupResp = await fetch(`${CORTEX_URL}/api/v1/procedural/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: AGENT_ID, context: `${name} ${trigger}`.slice(0, 300), limit: 1 }),
      });
      if (dupResp.ok) {
        const d: any = await dupResp.json();
        const top = d?.results?.[0] || d?.skills?.[0];
        const topName = (top?.name || "").toLowerCase();
        if (topName && (topName === name.toLowerCase() ||
            (top?.similarity !== undefined && Number(top.similarity) >= 0.85))) {
          log(`    [skip] near-duplicate of skill "${top.name}"`);
          continue;
        }
      }
    } catch { /* dedup is best-effort */ }

    try {
      const resp = await fetch(`${CORTEX_URL}/api/v1/procedural`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: AGENT_ID,
          name,
          description: steps.join("; ").slice(0, 200),
          triggerContext: trigger,
          steps,
          proceduralType: pType,
          domainTags: ["harvested", ...tags],
          sourceMemoryIds: [],
        }),
      });
      if (resp.ok) {
        const r: any = await resp.json();
        if (r?.id) {
          n++;
          log(`    + skill #${r.id} "${name}"`);
        }
      } else {
        log(`    ! store failed: HTTP ${resp.status}`);
      }
    } catch (e) {
      log(`    ! store failed: ${e}`);
    }
  }
  return n;
}

// ─── Cursor transcript processing (same walk as reflect-cursor) ─────────────

async function processCursor(limit: number): Promise<number> {
  if (!existsSync(CURSOR_PROJECTS)) { log("  cursor: projects dir not found"); return 0 }
  let total = 0, processed = 0;
  const projectDirs = await readdir(CURSOR_PROJECTS).catch(() => [] as string[]);
  for (const projDir of projectDirs) {
    if (processed >= limit) break;
    const transcriptsDir = join(CURSOR_PROJECTS, projDir, "agent-transcripts");
    if (!existsSync(transcriptsDir)) continue;
    const sessionDirs = await readdir(transcriptsDir).catch(() => [] as string[]);
    for (const sessDir of sessionDirs) {
      if (processed >= limit) break;
      const sessPath = join(transcriptsDir, sessDir);
      const s = await stat(sessPath).catch(() => null);
      if (!s || !s.isDirectory()) continue;
      const mainFile = join(sessPath, `${sessDir}.jsonl`);
      if (!existsSync(mainFile)) continue;
      const fs2 = await stat(mainFile).catch(() => null);
      if (!fs2 || fs2.mtimeMs < sinceMs) continue;
      const raw = await readFile(mainFile, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const textParts: string[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const role = obj.role || "unknown";
          const content = Array.isArray(obj.message?.content)
            ? obj.message.content.map((c: any) => c?.text || "").join(" ")
            : typeof obj.message?.content === "string"
              ? obj.message.content
              : "";
          if (content) textParts.push(`${role}: ${content}`);
        } catch {}
      }
      const transcript = textParts.join("\n\n");
      if (transcript.length < MIN_CHARS) continue;
      processed++;
      const source = `cursor:${sessDir.slice(0, 12)}`;
      const items = await extractSkills(transcript, source);
      if (items.length > 0) {
        const stored = await storeSkills(items, source);
        total += stored;
        log(`  + ${source}: ${stored} skills`);
      }
    }
  }
  return total;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`skill-harvest start -- since=${new Date(sinceMs).toISOString()} dry=${DRY} limit=${LIMIT} model=${MODEL}`);

  const total = await processCursor(LIMIT);

  if (hadExtractionFailure) {
    log(`skill-harvest done -- ${total} skills stored (extraction failures: state NOT advanced)`);
  } else {
    saveState({ lastRunMs: startMs });
    log(`skill-harvest done -- ${total} skills stored`);
  }
}

main().catch(e => { log(`FATAL: ${e}`); process.exit(1) });