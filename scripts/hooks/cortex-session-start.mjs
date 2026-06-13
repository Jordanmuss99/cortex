#!/usr/bin/env node
/**
 * Cortex session-start hook.
 *
 * Fetches a compact context block from the running Cortex REST API and prints
 * it to stdout. The host runtime (Claude Code, OpenCode) is expected to wrap
 * the stdout in a system-reminder so the agent boots with relevant memory
 * loaded without having to call `cortex_init` manually.
 *
 * Fails silently on any error (including stack down) and exits 0 so the
 * runtime never treats a missing Cortex as a session-blocking failure.
 *
 * Uses Node's built-in node:http rather than global fetch / undici because
 * undici triggers a libuv assertion on process exit on Windows.
 *
 * Env overrides:
 *   CORTEX_REST_BASE     default: http://127.0.0.1:3100
 *   CORTEX_AGENT_ID      default: arlo
 *   CORTEX_BOOT_QUERY    default: "current active work and recent context"
 *   CORTEX_BOOT_LIMIT    default: 5
 *   CORTEX_BOOT_PREVIEW  default: 300
 */

import http from "node:http";
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const COMPLIANCE_FILE = join(homedir(), ".cortex", "claude-loop-compliance.json");
const COMPLIANCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Previous session's Recall-and-Reconsolidate verdict, written by the
// SessionEnd hook (cortex-session-end.mjs). Returns display lines when the
// verdict is fresh and carries gaps; [] otherwise.
async function loadComplianceLines() {
  try {
    const v = JSON.parse(await readFile(COMPLIANCE_FILE, "utf8"));
    if (!Array.isArray(v.gaps) || v.gaps.length === 0) return [];
    const endedAtMs = Date.parse(v.endedAt || "");
    if (!Number.isFinite(endedAtMs) || Date.now() - endedAtMs > COMPLIANCE_MAX_AGE_MS) return [];
    const vb = v.verbs || {};
    return [
      "## Previous session loop compliance (cortex-session-end hook)",
      `Last recorded session (${v.endedAt}${v.cwd ? `, ${v.cwd}` : ""}) ended with Recall-and-Reconsolidate gaps:`,
      ...v.gaps.map((g) => `- ${g}`),
      `(stats: ${v.cortexCalls ?? 0}/${v.totalToolCalls ?? 0} cortex calls; reads ${vb.reads ?? 0}, ingests ${vb.ingests ?? 0}, reconsolidations ${vb.reconsolidations ?? 0}, skills r/s/x ${vb.skillRetrieve ?? 0}/${vb.skillStore ?? 0}/${vb.skillExecuted ?? 0})`,
      "Correct this pattern THIS session: search before writing, reconsolidate over ingest, retrieve skills before tasks and record executions.",
      "",
    ];
  } catch {
    return [];
  }
}

const BASE  = process.env.CORTEX_REST_BASE  || "http://127.0.0.1:3100";
const AGENT = process.env.CORTEX_AGENT_ID   || "arlo";
const QUERY = process.env.CORTEX_BOOT_QUERY || "current active work and recent context";
const LIMIT = parseInt(process.env.CORTEX_BOOT_LIMIT   || "5",   10);
const PREV  = parseInt(process.env.CORTEX_BOOT_PREVIEW || "300", 10);
const HEALTH_TIMEOUT_MS = 2500;
const QUERY_TIMEOUT_MS  = 15000;

function trunc(s, n) {
  if (!s) return "";
  const cleaned = String(s).replace(/\s+/g, " ").trim();
  return cleaned.length > n ? cleaned.slice(0, n) + "…" : cleaned;
}

function httpRequest(method, urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      timeout: timeoutMs,
      headers: data
        ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
        : {},
    };
    const req = http.request(opts, (res) => {
      let chunks = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { chunks += c; });
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { /* leave null */ }
        resolve({ ok, status: res.statusCode, body: chunks, json: parsed });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

const getJson  = (url, t) => httpRequest("GET",  url, undefined, t);
const postJson = (url, b, t) => httpRequest("POST", url, b,      t);

// Claude Code passes hook JSON on stdin ({ source, cwd, session_id, ... }).
// source is "startup" | "resume" | "clear" | "compact". Reading is
// best-effort: manual runs with no stdin still work.
async function readHookInput() {
  try {
    const raw = await Promise.race([
      (async () => {
        let buf = "";
        for await (const chunk of process.stdin) buf += chunk;
        return buf;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(""), 400)),
    ]);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function gitContext(cwd) {
  const opts = { cwd, encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
  let branch = "";
  let subject = "";
  try { branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim(); } catch { /* not a repo */ }
  try { subject = execSync("git log -1 --pretty=%s", opts).trim(); } catch { /* no history */ }
  return { branch, subject };
}

async function main() {
  const input = await readHookInput();
  const source = String(input.source || "startup");
  const isCompact = source === "compact";

  // Post-compaction reload uses a work-scoped query (branch + last commit),
  // mirroring the OpenCode rest-bridge compaction re-injection - the generic
  // boot query is for cold starts. Compliance feed-forward stays a cold-boot
  // concern; mid-session compaction skips it.
  let query = QUERY;
  if (isCompact && input.cwd) {
    const { branch, subject } = gitContext(String(input.cwd));
    const parts = [branch, subject, "recent decisions findings current task"].filter(Boolean);
    if (parts.length > 1) query = parts.join(" ").slice(0, 400);
  }

  const complianceLines = isCompact ? [] : await loadComplianceLines();
  try {
    const h = await getJson(`${BASE}/api/v1/health`, HEALTH_TIMEOUT_MS);
    if (!h.ok) throw new Error(`health ${h.status}`);

    const [statusRes, searchRes] = await Promise.allSettled([
      getJson(`${BASE}/api/v1/status?agentId=${encodeURIComponent(AGENT)}`, QUERY_TIMEOUT_MS),
      postJson(`${BASE}/api/v1/search`, { agentId: AGENT, query, limit: LIMIT }, QUERY_TIMEOUT_MS),
    ]);

    const status = statusRes.status === "fulfilled" && statusRes.value.ok ? statusRes.value.json : null;
    const search = searchRes.status === "fulfilled" && searchRes.value.ok ? searchRes.value.json : null;

    const out = [];
    out.push(...complianceLines);
    out.push(
      isCompact
        ? "## Cortex session context (auto-reloaded after compaction)"
        : "## Cortex session context (auto-loaded)"
    );
    out.push("");

    if (status?.stats) {
      const s = status.stats;
      out.push(
        `- Active memories: **${s.totalMemories}** · Synapses: **${s.totalSynapses}** · ` +
        `Avg resonance: **${s.avgResonance}**`
      );
      if (s.lastDreamCycle) {
        const dt = s.lastDreamCycle.completed_at || s.lastDreamCycle.started_at;
        out.push(`- Last dream cycle: \`${s.lastDreamCycle.cycle_type}\` @ ${dt}`);
      }
      out.push("");
    }

    if (search?.results?.length) {
      out.push(`### Top ${search.results.length} memories for: "${query}"`);
      out.push("");
      for (const m of search.results) {
        const src = (m.source ? String(m.source).split(/[/\\]/).pop() : null) || "unknown";
        const score = typeof m.score === "number" ? m.score.toFixed(3) : "?";
        out.push(`- **#${m.id}** \`[${src}]\` (score ${score}) — ${trunc(m.content, PREV)}`);
      }
      out.push("");
    } else {
      out.push(`_(no memories matched boot query "${query}" for agent ${AGENT})_`);
      out.push("");
    }

    out.push("---");
    out.push(
      "Cortex MCP is wired in - use the FULL loop, not just ingest: " +
      "(1) `cortex_search`/`cortex_recall` at every task boundary and BEFORE deciding or debugging; recalled memories are labile for 1h. " +
      "(2) If new info updates something recalled, `cortex_reconsolidate` it - ingest REFUSES near-duplicates. " +
      "(3) `cortex_ingest` only for genuinely novel facts, written AT THE MOMENT of discovery (never batched to session end). " +
      "(4) Before a repeatable task, `cortex_skill_retrieve`; after applying a skill, `cortex_skill_executed`; improve with `cortex_skill_refine`. " +
      "(5) Significant decisions: `cortex_reason` with honest confidence. " +
      "(6) End of long turns: `cortex_journal`. " +
      "(7) Unsure what to do next? Re-read cortex_init's Open Loops or `cortex_search` open work BEFORE asking the user. " +
      "(8) CLEAR principal state signals (frustration, fatigue, time pressure): `cortex_assess_state` with their recent messages, adapt to the guidance; skip on sparse signal."
    );

    process.stdout.write(out.join("\n") + "\n");
  } catch (e) {
    // Stack down: still surface the previous session's verdict if any - the
    // compliance feed-forward does not depend on Cortex being reachable.
    if (complianceLines.length) process.stdout.write(complianceLines.join("\n") + "\n");
    process.stderr.write(`[cortex-session-start] skipped: ${e?.message || e}\n`);
  }
  // Explicit clean exit (libuv handles drain naturally with node:http).
  process.exit(0);
}

main();