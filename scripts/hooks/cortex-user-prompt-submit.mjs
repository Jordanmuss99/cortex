#!/usr/bin/env node
/**
 * Cortex UserPromptSubmit hook (Claude Code).
 *
 * Runs on every user prompt; stdout is injected into the model's context.
 * Two jobs (utilization research 2026-06-12):
 *
 *   1. ALWAYS: a 2-line protocol pulse. Boot-loaded instructions decay hard
 *      with context growth (~73% compliance at turn 5 -> ~33% by turn 16),
 *      so the reminder must ride the turn loop, not just session start.
 *   2. THROTTLED: a small task-aware recall against the prompt text via the
 *      Cortex REST API (first prompt of a session, then at most every
 *      10 minutes) - mirrors the OpenCode rest-bridge task-aware recall.
 *
 * Skips trivial prompts (<24 chars) and slash commands. Fails silent and
 * exits 0 in all cases - never blocks or delays the prompt meaningfully.
 *
 * Env overrides:
 *   CORTEX_REST_BASE          default http://127.0.0.1:3100
 *   CORTEX_AGENT_ID           default arlo
 *   CORTEX_PULSE_RECALL_MS    recall throttle window, default 600000 (10 min)
 *   CORTEX_PULSE_BUDGET       recall token budget, default 1200
 */

import http from "node:http";
import { URL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.CORTEX_REST_BASE || "http://127.0.0.1:3100";
const AGENT = process.env.CORTEX_AGENT_ID || "arlo";
const RECALL_THROTTLE_MS = parseInt(process.env.CORTEX_PULSE_RECALL_MS || "600000", 10);
const RECALL_BUDGET = parseInt(process.env.CORTEX_PULSE_BUDGET || "1200", 10);
const RECALL_TIMEOUT_MS = 4000;
const STATE_FILE = join(homedir(), ".cortex", "prompt-hook-state.json");

const PULSE = [
  "<cortex-protocol-pulse>",
  "Cortex: search at task boundaries and before debugging/decisions; write durable facts AT DISCOVERY (reconsolidate over ingest); if unsure what to do next, check cortex_init Open Loops or cortex_search open work BEFORE asking the user. Apply a surfaced skill -> record cortex_skill_executed.",
  "</cortex-protocol-pulse>",
].join("\n");

function postJson(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "POST",
        timeout: timeoutMs,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`status ${res.statusCode}`));
          try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.write(data);
    req.end();
  });
}

async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { return {}; }
}

async function writeState(state) {
  try {
    await mkdir(join(homedir(), ".cortex"), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state), "utf8");
  } catch { /* best-effort */ }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw); } catch { /* no input */ }

  const prompt = String(input.prompt || "").trim();
  // Trivial prompts and slash commands get no injection at all.
  if (prompt.length < 24 || prompt.startsWith("/")) return;

  const out = [PULSE];

  // Throttled task-aware recall.
  const state = await readState();
  const sessionId = String(input.session_id || "");
  const now = Date.now();
  const sessionChanged = sessionId && state.sessionId !== sessionId;
  const stale = !state.lastRecallAt || now - state.lastRecallAt > RECALL_THROTTLE_MS;

  if (sessionChanged || stale) {
    const query = prompt
      .replace(/<([a-z][a-z0-9-]*-hook)>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[a-z][a-z0-9-]*-hook>/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    if (query) {
      try {
        const result = await postJson(
          `${BASE}/api/v1/recall`,
          { agentId: AGENT, query, tokenBudget: RECALL_BUDGET },
          RECALL_TIMEOUT_MS
        );
        if (result && result.context) {
          out.push(
            "",
            "## Cortex recall for this prompt (auto, throttled)",
            result.context,
            "(Use cortex_search for deeper task-specific recall; recalled memories are labile for 1h - reconsolidate, don't duplicate.)"
          );
          await writeState({ sessionId, lastRecallAt: now });
        }
      } catch {
        // REST down or slow: pulse-only this turn, try again next prompt.
        if (sessionChanged) await writeState({ sessionId, lastRecallAt: 0 });
      }
    }
  }

  process.stdout.write(out.join("\n") + "\n");
}

main().catch(() => {}).finally(() => process.exit(0));
