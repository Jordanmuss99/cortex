#!/usr/bin/env bun
/**
 * Cortex Skill Harvester -- Procedural Memory Auto-Capture
 * ----------------------------------------------------------
 * Extracts repeatable workflows and procedures from AI agent transcripts
 * and stores them as procedural memories (skills) in Cortex.
 *
 * This solves the "learning stall" problem: agents never call cortex_skill_store
 * or cortex_skill_executed voluntarily, so skills are never captured and
 * proficiency never grows. This script makes skill capture deterministic --
 * it runs nightly alongside the reflect, mining transcripts for workflow
 * patterns and storing them automatically.
 *
 * Sources (same as reflect-multi.ts):
 *   - Claude Code, Codex CLI, Cursor, Hermes, OpenCode, OpenClaw
 *
 * Usage:
 *   bun run skill-harvest.ts [--dry-run] [--limit 20] [--source all|claude|codex|cursor|hermes]
 *
 * Env:
 *   CORTEX_REST_URL     default http://127.0.0.1:3100
 *   CORTEX_AGENT_ID     default arlo
 *   OLLAMA_URL          default http://127.0.0.1:11434/v1
 *   REFLECT_MODEL        default glm-5.2:cloud
 */

import { Database } from "bun:sqlite"
import { readdir, stat, readFile } from "node:fs/promises"
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()
const CORTEX_URL = process.env.CORTEX_REST_URL || "http://127.0.0.1:3100"
const AGENT_ID = process.env.CORTEX_AGENT_ID || "arlo"
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/v1"
const MODEL = process.env.REFLECT_MODEL || "glm-5.2:cloud"

const CORTEX_DIR = join(HOME, ".cortex")
const LOG_FILE = join(CORTEX_DIR, "reflect.log")
const STATE_FILE = join(CORTEX_DIR, "skill-harvest-state.json")

const CLAUDE_PROJECTS = join(HOME, ".claude", "projects")
const CODEX_SESSIONS = join(HOME, ".codex", "sessions")
const CURSOR_PROJECTS = join(HOME, ".cursor", "projects")
const HERMES_DB = join(HOME, "AppData", "Local", "hermes", "state.db")

const MAX_CHARS = 120_000
const MIN_CHARS = 800  // Higher threshold -- skills need richer context

const SKILL_PROMPT = `You are a procedural memory extraction assistant. Given an AI agent's session transcript, identify REPEATABLE WORKFLOWS, PROCEDURES, and PATTERNS that the agent executed -- things that could be reused in future sessions. Focus on:

1. Multi-step procedures the agent performed (build steps, test sequences, deployment flows, debugging workflows)
2. Tool usage patterns that worked (specific CLI commands, API call sequences, configuration steps)
3. Workarounds and fallbacks the agent discovered (when X fails, do Y)
4. Verification patterns (how to check if something works)

NOT episodic facts or decisions (those are captured separately by the reflect script).

Format: [{"name": "short name", "triggerContext": "when to use this (1-2 sentences)", "steps": ["step 1", "step 2", ...], "proceduralType": "workflow|pattern|workaround|verification", "tags": ["..."]}]

Skip trivial content. Only extract things that are genuinely repeatable across sessions. Return ONLY the JSON array.

Transcript:
`

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string, d: string) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const DRY = has("--dry-run")
const LIMIT = parseInt(val("--limit", "20"), 10)
const SINCE_HOURS = val("--since-hours", "")
const ONLY = val("--source", "all")

function log(msg: string) {
  const line = `${new Date().toISOString()}  [skill-harvest] ${msg}`
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
  console.log(line)
}

type State = { lastRunMs: number }
function loadState(): State {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch { return { lastRunMs: 0 } }
}
function saveState(s: State) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch {} }

const startMs = Date.now()
const state = loadState()
const sinceMs = SINCE_HOURS
  ? startMs - parseInt(SINCE_HOURS, 10) * 3_600_000
  : state.lastRunMs || startMs - 26 * 3_600_000

// ─── LLM extraction ─────────────────────────────────────────────────────────

async function extractSkills(transcript: string, source: string): Promise<any[]> {
  const resp = await fetch(`${OLLAMA_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a procedural memory extraction assistant. Return only a JSON array." },
        { role: "user", content: SKILL_PROMPT + transcript.slice(0, MAX_CHARS) + "\n--- TRANSCRIPT END ---\n" },
      ],
      max_tokens: 3000,
      temperature: 0.3,
      stream: false,
    }),
  })

  if (!resp.ok) {
    log(`  ! ${source}: Ollama HTTP ${resp.status}`)
    return []
  }

  const data: any = await resp.json()
  const out = data?.choices?.[0]?.message?.content || ""
  const m = out.match(/\[[\s\S]*\]/)
  if (!m) { log(`  - ${source}: no JSON array returned`); return [] }

  let items: any[]
  try { items = JSON.parse(m[0]) } catch { log(`  - ${source}: JSON parse failed`); return [] }
  if (!Array.isArray(items) || items.length === 0) { log(`  · ${source}: 0 skills`); return [] }
  return items
}

// ─── Store skills in Cortex via REST ─────────────────────────────────────────

async function storeSkills(items: any[], source: string): Promise<number> {
  let n = 0
  for (const it of items) {
    const name = typeof it?.name === "string" ? it.name.trim() : ""
    const trigger = typeof it?.triggerContext === "string" ? it.triggerContext.trim() : ""
    const steps = Array.isArray(it?.steps) ? it.steps.map((s: any) => String(s)) : []
    const pType = typeof it?.proceduralType === "string" ? it.proceduralType : "workflow"
    const tags = Array.isArray(it?.tags) ? it.tags.slice(0, 6).map((t: any) => String(t)) : []

    if (name.length < 5 || trigger.length < 10 || steps.length === 0) continue

    // Build a description from the first step (the REST endpoint requires it)
    const description = steps.join("; ").slice(0, 200)

    if (DRY) {
      log(`    [dry] "${name}" (${pType}, ${steps.length} steps)`)
      n++
      continue
    }

    // POST to the procedural REST endpoint
    try {
      const resp = await fetch(`${CORTEX_URL}/api/v1/procedural`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: AGENT_ID,
          name,
          description,
          triggerContext: trigger,
          steps,
          proceduralType: pType,
          domainTags: ["harvested", ...tags],
          sourceMemoryIds: [],
        }),
      })
      if (resp.ok) {
        const r: any = await resp.json()
        if (r?.id) {
          n++
          log(`    + skill #${r.id} "${name}"`)
        }
      } else {
        log(`    ! store failed: HTTP ${resp.status}`)
      }
    } catch (e) {
      log(`    ! store failed: ${e}`)
    }
  }
  return n
}

// ─── Transcript readers (shared with reflect-multi) ─────────────────────────

async function readTranscriptLines(fullPath: string): Promise<string[]> {
  const raw = await readFile(fullPath, "utf8")
  return raw.split("\n").filter(Boolean)
}

function extractClaudeText(lines: string[]): string {
  const parts: string[] = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === "user" || obj.type === "assistant") {
        const content = typeof obj.message?.content === "string"
          ? obj.message.content
          : Array.isArray(obj.message?.content)
            ? obj.message.content.map((c: any) => c?.text || "").join(" ")
            : ""
        if (content) parts.push(`${obj.type}: ${content}`)
      }
    } catch {}
  }
  return parts.join("\n\n")
}

function extractCodexText(lines: string[]): string {
  const parts: string[] = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.type === "response_item" && obj.payload?.type === "message") {
        const role = obj.payload.role || "unknown"
        const content = Array.isArray(obj.payload.content)
          ? obj.payload.content.map((c: any) => c?.text || "").join(" ")
          : String(obj.payload.content || "")
        if (content) parts.push(`${role}: ${content}`)
      }
    } catch {}
  }
  return parts.join("\n\n")
}

function extractCursorText(lines: string[]): string {
  const parts: string[] = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      const role = obj.role || "unknown"
      const content = Array.isArray(obj.message?.content)
        ? obj.message.content.map((c: any) => c?.text || "").join(" ")
        : typeof obj.message?.content === "string" ? obj.message.content : ""
      if (content) parts.push(`${role}: ${content}`)
    } catch {}
  }
  return parts.join("\n\n")
}

// ─── Source processors ──────────────────────────────────────────────────────

async function processClaude(limit: number): Promise<number> {
  if (!existsSync(CLAUDE_PROJECTS)) { log("  claude: not found"); return 0 }
  let total = 0, processed = 0
  const dirs = await readdir(CLAUDE_PROJECTS).catch(() => [] as string[])
  for (const projDir of dirs) {
    if (processed >= limit) break
    const projPath = join(CLAUDE_PROJECTS, projDir)
    const files = await readdir(projPath).catch(() => [] as string[])
    for (const file of files) {
      if (processed >= limit) break
      if (!file.endsWith(".jsonl")) continue
      const fullPath = join(projPath, file)
      const s = await stat(fullPath).catch(() => null)
      if (!s || s.mtimeMs < sinceMs) continue
      const lines = await readTranscriptLines(fullPath)
      const transcript = extractClaudeText(lines)
      if (transcript.length < MIN_CHARS) continue
      processed++
      const source = `claude:${file}`
      const items = await extractSkills(transcript, source)
      if (items.length > 0) {
        const stored = await storeSkills(items, source)
        total += stored
        log(`  + ${source}: ${stored} skills`)
      }
    }
  }
  return total
}

async function processCodex(limit: number): Promise<number> {
  if (!existsSync(CODEX_SESSIONS)) { log("  codex: not found"); return 0 }
  let total = 0, processed = 0
  const years = await readdir(CODEX_SESSIONS).catch(() => [] as string[])
  for (const year of years) {
    if (processed >= limit) break
    const months = await readdir(join(CODEX_SESSIONS, year)).catch(() => [] as string[])
    for (const month of months) {
      if (processed >= limit) break
      const days = await readdir(join(CODEX_SESSIONS, year, month)).catch(() => [] as string[])
      for (const day of days) {
        if (processed >= limit) break
        const dayPath = join(CODEX_SESSIONS, year, month, day)
        const files = await readdir(dayPath).catch(() => [] as string[])
        for (const file of files) {
          if (processed >= limit) break
          if (!file.endsWith(".jsonl")) continue
          const fullPath = join(dayPath, file)
          const s = await stat(fullPath).catch(() => null)
          if (!s || s.mtimeMs < sinceMs) continue
          const lines = await readTranscriptLines(fullPath)
          const transcript = extractCodexText(lines)
          if (transcript.length < MIN_CHARS) continue
          processed++
          const source = `codex:${file.slice(0, 50)}`
          const items = await extractSkills(transcript, source)
          if (items.length > 0) {
            const stored = await storeSkills(items, source)
            total += stored
            log(`  + ${source}: ${stored} skills`)
          }
        }
      }
    }
  }
  return total
}

async function processCursor(limit: number): Promise<number> {
  if (!existsSync(CURSOR_PROJECTS)) { log("  cursor: not found"); return 0 }
  let total = 0, processed = 0
  const dirs = await readdir(CURSOR_PROJECTS).catch(() => [] as string[])
  for (const projDir of dirs) {
    if (processed >= limit) break
    const transcriptsDir = join(CURSOR_PROJECTS, projDir, "agent-transcripts")
    if (!existsSync(transcriptsDir)) continue
    const sessionDirs = await readdir(transcriptsDir).catch(() => [] as string[])
    for (const sessDir of sessionDirs) {
      if (processed >= limit) break
      const mainFile = join(transcriptsDir, sessDir, `${sessDir}.jsonl`)
      if (!existsSync(mainFile)) continue
      const s = await stat(mainFile).catch(() => null)
      if (!s || s.mtimeMs < sinceMs) continue
      const lines = await readTranscriptLines(mainFile)
      const transcript = extractCursorText(lines)
      if (transcript.length < MIN_CHARS) continue
      processed++
      const source = `cursor:${sessDir.slice(0, 12)}`
      const items = await extractSkills(transcript, source)
      if (items.length > 0) {
        const stored = await storeSkills(items, source)
        total += stored
        log(`  + ${source}: ${stored} skills`)
      }
    }
  }
  return total
}

async function processHermes(limit: number): Promise<number> {
  if (!existsSync(HERMES_DB)) { log("  hermes: not found"); return 0 }
  let total = 0, processed = 0
  try {
    const db = new Database(HERMES_DB, { readonly: true })
    const sessions = db.query(
      `SELECT s.id, s.started_at FROM sessions s
       WHERE s.started_at > ? ORDER BY s.started_at DESC LIMIT ?`
    ).all(sinceMs / 1000, limit) as any[]

    for (const session of sessions) {
      if (processed >= limit) break
      const msgs = db.query(
        `SELECT role, content FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`
      ).all(session.id) as any[]
      const transcript = msgs.map(m => `${m.role}: ${m.content || ""}`).filter(t => t.length > 10).join("\n\n")
      if (transcript.length < MIN_CHARS) continue
      processed++
      const source = `hermes:${String(session.id).slice(0, 12)}`
      const items = await extractSkills(transcript, source)
      if (items.length > 0) {
        const stored = await storeSkills(items, source)
        total += stored
        log(`  + ${source}: ${stored} skills`)
      }
    }
    db.close()
  } catch (e) { log(`  hermes: failed: ${e}`) }
  return total
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`skill-harvest start -- since=${new Date(sinceMs).toISOString()} dry=${DRY} limit=${LIMIT} model=${MODEL}${ONLY !== "all" ? ` source=${ONLY}` : ""}`)
  let total = 0
  const perSourceLimit = ONLY === "all" ? Math.ceil(LIMIT / 4) : LIMIT
  if (ONLY === "all" || ONLY === "claude") total += await processClaude(perSourceLimit)
  if (ONLY === "all" || ONLY === "codex") total += await processCodex(perSourceLimit)
  if (ONLY === "all" || ONLY === "cursor") total += await processCursor(perSourceLimit)
  if (ONLY === "all" || ONLY === "hermes") total += await processHermes(perSourceLimit)
  saveState({ lastRunMs: startMs })
  log(`skill-harvest done -- ${total} skills stored`)
}

main().catch(e => { log(`FATAL: ${e}`); process.exit(1) })