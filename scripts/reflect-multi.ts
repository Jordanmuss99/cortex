#!/usr/bin/env bun
/**
 * Cortex Nightly Reflect -- Multi-source (Ollama-powered)
 * --------------------------------------------------------
 * Extracts durable memories from ALL AI agent transcripts:
 *   - Claude Code:  ~/.claude/projects/<id>/*.jsonl
 *   - Codex CLI:    ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   - Cursor:       ~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl
 *   - Hermes:       ~/AppData/Local/hermes/state.db (SQLite -- messages table)
 *   - OpenCode:     ~/.local/share/opencode/opencode.db (sqlite, if present)
 *   - OpenClaw:     ~/.openclaw/agents/main/sessions/*.jsonl (if present)
 *
 * Uses the OpenAI-compatible API (Ollama) instead of Claude CLI,
 * so it works even when Claude rate limits are hit.
 *
 * Usage:
 *   bun run reflect-multi.ts [--dry-run] [--limit 40] [--source claude|codex|cursor|hermes|all]
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
const STATE_FILE = join(CORTEX_DIR, "reflect-state.json")
const LOG_FILE = join(CORTEX_DIR, "reflect.log")

// Source directories
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects")
const CODEX_SESSIONS = join(HOME, ".codex", "sessions")
const CURSOR_PROJECTS = join(HOME, ".cursor", "projects")
const HERMES_DB = join(HOME, "AppData", "Local", "hermes", "state.db")
const OPENCODE_DB = join(HOME, ".local", "share", "opencode", "opencode.db")
const OPENCLAW_DIR = join(HOME, ".openclaw", "agents", "main", "sessions")

const MAX_CHARS = 120_000
const MIN_CHARS = 400

const EXTRACT_PROMPT = `You are a memory extraction assistant. Given an AI agent's session transcript, extract durable, reusable memories as a JSON array. Each memory should be a self-contained fact, decision, learning, correction, or insight that would be useful in future sessions. Skip trivial or ephemeral content (greetings, status checks, tool output, file contents). Format: [{"content": "...", "type": "decision|learning|correction|insight", "tags": ["..."]}]. Return ONLY the JSON array, no other text.

Transcript:
`

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const val = (f: string, d: string) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const DRY = has("--dry-run")
const LIMIT = parseInt(val("--limit", "40"), 10)
const SINCE_HOURS = val("--since-hours", "")
const ONLY = val("--source", "all")

function log(msg: string) {
  const line = `${new Date().toISOString()}  [multi-reflect] ${msg}`
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

async function extractMemories(transcript: string, source: string): Promise<any[]> {
  // Retry with backoff for transient Ollama errors
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(`${OLLAMA_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a memory extraction assistant. Return only a JSON array." },
          { role: "user", content: EXTRACT_PROMPT + transcript.slice(0, MAX_CHARS) + "\n--- TRANSCRIPT END ---\n" },
        ],
        max_tokens: 2000,
        temperature: 0.3,
        stream: false,
      }),
    })

    if (resp.ok) {
      const data: any = await resp.json()
      const out = data?.choices?.[0]?.message?.content || ""
      const m = out.match(/\[[\s\S]*\]/)
      if (!m) { log(`  - ${source}: no JSON array returned`); return [] }
      let items: any[]
      try { items = JSON.parse(m[0]) } catch { log(`  - ${source}: JSON parse failed`); return [] }
      if (!Array.isArray(items) || items.length === 0) { log(`  · ${source}: 0 memories`); return [] }
      return items
    }

    // Retry on 429/503 with backoff
    if (resp.status === 429 || resp.status === 503) {
      const wait = (attempt + 1) * 5000
      log(`  ~ ${source}: Ollama ${resp.status}, retry in ${wait}ms (attempt ${attempt + 1}/3)`)
      await new Promise(r => setTimeout(r, wait))
      continue
    }
    log(`  ! ${source}: Ollama HTTP ${resp.status}`)
    return []
  }
  log(`  ! ${source}: Ollama retries exhausted`)
  return []
}

async function ingestMemories(items: any[], source: string): Promise<number> {
  let n = 0
  for (const it of items) {
    const content = typeof it?.content === "string" ? it.content.trim() : ""
    if (content.length < 12) continue
    const tags = ["reflection", ...(it?.type ? [String(it.type)] : []), ...(Array.isArray(it?.tags) ? it.tags.slice(0, 6).map((t: any) => String(t)) : [])]

    if (DRY) {
      log(`    [dry] ${content.slice(0, 80)}`)
      n++
      continue
    }

    // ── Search for an existing memory first (reconsolidate instead of duplicate) ──
    // The server-side dedup gate only catches near-verbatim duplicates (cosine >= 0.88).
    // Semantically similar but differently-worded content passes the gate and creates
    // a near-duplicate. To prevent this, we search first and reconsolidate if we find
    // a close match (cosine >= 0.75 -- lower than the ingest gate, catches paraphrases).
    let reconsolidated = false
    try {
      const searchResp = await fetch(`${CORTEX_URL}/api/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: content.slice(0, 500), agentId: AGENT_ID, limit: 3 }),
      })
      if (searchResp.ok) {
        const searchData: any = await searchResp.json()
        const results = searchData?.results || []
        if (results.length > 0) {
          const top = results[0]
          const score = top?.score || 0
          // If the top result is a strong match, reconsolidate it with the new content
          // (the search marks it labile, so reconsolidation will work)
          // Threshold: 0.65 for individual memory phrases (hybrid scores are much
          // lower for short factual content than for full questions -- typical range
          // for a real match is 0.6-0.8, vs 8-11 for full conversational queries).
          if (score >= 0.65) {
            const memId = top?.id
            // Reconsolidate: merge the new content into the existing memory.
            // Only update if the new content adds information the existing doesn't have.
            // If existing is longer and contains the new content as a substring, skip.
            const existingContent = top?.content || ""
            if (existingContent.includes(content.slice(0, 50))) {
              // New content is already covered by existing -- skip entirely
              log(`    [skip] #${memId} already contains this content (score ${score.toFixed(2)})`)
              n++
              reconsolidated = true
            } else {
              // Merge: append the new content to the existing
              const mergedContent = `${existingContent}\n\n[Updated via reflect] ${content}`
              try {
                const reconResp = await fetch(`${CORTEX_URL}/api/v1/reconsolidate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    agentId: AGENT_ID,
                    memoryId: memId,
                    newContent: mergedContent,
                    reason: `reflect reconsolidation from ${source} (score ${score.toFixed(2)})`,
                  }),
                })
                if (reconResp.ok) {
                  log(`    [recon] #${memId} (score ${score.toFixed(2)})`)
                  n++
                  reconsolidated = true
                } else if (reconResp.status === 409) {
                  // Labile window closed -- the search marked it labile but the
                  // reconsolidate check still failed. Fall through to ingest.
                  log(`    ~ #${memId} labile window closed -- will ingest as new`)
                }
              } catch (e) {
                log(`    ~ recon failed for #${memId}: ${e} -- will ingest instead`)
              }
            }
          }
        }
      }
    } catch (e) {
      // Search failed -- fall through to ingest
    }

    if (reconsolidated) continue

    // ── No close match found -- ingest as new memory ──
    const payload = { agentId: AGENT_ID, content, source, sourceType: "reflection", priority: 2, semanticTags: tags }
    try {
      const resp = await fetch(`${CORTEX_URL}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (resp.ok) {
        const r: any = await resp.json()
        if (r?.skipped) {
          log(`    [skip] dup of #${r.duplicateOf} (sim ${r.similarity?.toFixed(3)})`)
        } else {
          n++
        }
      }
    } catch (e) {
      log(`    ! ingest failed: ${e}`)
    }
  }
  return n
}

// ─── Claude Code transcripts ────────────────────────────────────────────────

async function processClaude(limit: number): Promise<number> {
  if (!existsSync(CLAUDE_PROJECTS)) { log("  claude: projects dir not found"); return 0 }
  let total = 0, processed = 0
  const projectDirs = await readdir(CLAUDE_PROJECTS).catch(() => [] as string[])
  for (const projDir of projectDirs) {
    if (processed >= limit) break
    const projPath = join(CLAUDE_PROJECTS, projDir)
    const files = await readdir(projPath).catch(() => [] as string[])
    for (const file of files) {
      if (processed >= limit) break
      if (!file.endsWith(".jsonl")) continue
      const fullPath = join(projPath, file)
      const s = await stat(fullPath).catch(() => null)
      if (!s || s.mtimeMs < sinceMs) continue
      const raw = await readFile(fullPath, "utf8")
      const lines = raw.split("\n").filter(Boolean)
      const textParts: string[] = []
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          if (obj.type === "user" || obj.type === "assistant") {
            const content = typeof obj.message?.content === "string"
              ? obj.message.content
              : Array.isArray(obj.message?.content)
                ? obj.message.content.map((c: any) => c?.text || "").join(" ")
                : ""
            if (content) textParts.push(`${obj.type}: ${content}`)
          }
        } catch {}
      }
      const transcript = textParts.join("\n\n")
      if (transcript.length < MIN_CHARS) { log(`  · claude:${file}: too short`); continue }
      processed++
      const source = `claude:${file}`
      const items = await extractMemories(transcript, source)
      if (items.length > 0) {
        const ingested = await ingestMemories(items, source)
        total += ingested
        log(`  + ${source}: ${ingested} memories`)
      }
    }
  }
  return total
}

// ─── Codex CLI transcripts ──────────────────────────────────────────────────

async function processCodex(limit: number): Promise<number> {
  if (!existsSync(CODEX_SESSIONS)) { log("  codex: sessions dir not found"); return 0 }
  let total = 0, processed = 0
  // Walk YYYY/MM/DD/rollout-*.jsonl
  const years = await readdir(CODEX_SESSIONS).catch(() => [] as string[])
  for (const year of years) {
    if (processed >= limit) break
    const yearPath = join(CODEX_SESSIONS, year)
    const months = await readdir(yearPath).catch(() => [] as string[])
    for (const month of months) {
      if (processed >= limit) break
      const monthPath = join(yearPath, month)
      const days = await readdir(monthPath).catch(() => [] as string[])
      for (const day of days) {
        if (processed >= limit) break
        const dayPath = join(monthPath, day)
        const files = await readdir(dayPath).catch(() => [] as string[])
        for (const file of files) {
          if (processed >= limit) break
          if (!file.endsWith(".jsonl")) continue
          const fullPath = join(dayPath, file)
          const s = await stat(fullPath).catch(() => null)
          if (!s || s.mtimeMs < sinceMs) continue
          const raw = await readFile(fullPath, "utf8")
          const lines = raw.split("\n").filter(Boolean)
          const textParts: string[] = []
          for (const line of lines) {
            try {
              const obj = JSON.parse(line)
              // Codex format: {type: "response_item", payload: {type: "message", role: "...", content: [...]}}
              if (obj.type === "response_item" && obj.payload?.type === "message") {
                const role = obj.payload.role || "unknown"
                const content = Array.isArray(obj.payload.content)
                  ? obj.payload.content.map((c: any) => c?.text || "").join(" ")
                  : String(obj.payload.content || "")
                if (content) textParts.push(`${role}: ${content}`)
              }
            } catch {}
          }
          const transcript = textParts.join("\n\n")
          if (transcript.length < MIN_CHARS) { log(`  · codex:${file}: too short`); continue }
          processed++
          const source = `codex:${file.slice(0, 60)}`
          const items = await extractMemories(transcript, source)
          if (items.length > 0) {
            const ingested = await ingestMemories(items, source)
            total += ingested
            log(`  + ${source}: ${ingested} memories`)
          }
        }
      }
    }
  }
  return total
}

// ─── Cursor transcripts ─────────────────────────────────────────────────────

async function processCursor(limit: number): Promise<number> {
  if (!existsSync(CURSOR_PROJECTS)) { log("  cursor: projects dir not found"); return 0 }
  let total = 0, processed = 0
  const projectDirs = await readdir(CURSOR_PROJECTS).catch(() => [] as string[])
  for (const projDir of projectDirs) {
    if (processed >= limit) break
    const transcriptsDir = join(CURSOR_PROJECTS, projDir, "agent-transcripts")
    if (!existsSync(transcriptsDir)) continue
    const sessionDirs = await readdir(transcriptsDir).catch(() => [] as string[])
    for (const sessDir of sessionDirs) {
      if (processed >= limit) break
      const sessPath = join(transcriptsDir, sessDir)
      const s = await stat(sessPath).catch(() => null)
      if (!s || !s.isDirectory()) continue
      // Main transcript is <uuid>/<uuid>.jsonl
      const mainFile = join(sessPath, `${sessDir}.jsonl`)
      if (!existsSync(mainFile)) continue
      const fs2 = await stat(mainFile).catch(() => null)
      if (!fs2 || fs2.mtimeMs < sinceMs) continue
      const raw = await readFile(mainFile, "utf8")
      const lines = raw.split("\n").filter(Boolean)
      const textParts: string[] = []
      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          // Cursor format: {role: "user"/"assistant", message: {content: [{type: "text", text: "..."}]}}
          const role = obj.role || "unknown"
          const content = Array.isArray(obj.message?.content)
            ? obj.message.content.map((c: any) => c?.text || "").join(" ")
            : typeof obj.message?.content === "string"
              ? obj.message.content
              : ""
          if (content) textParts.push(`${role}: ${content}`)
        } catch {}
      }
      const transcript = textParts.join("\n\n")
      if (transcript.length < MIN_CHARS) { log(`  · cursor:${sessDir.slice(0,12)}: too short`); continue }
      processed++
      const source = `cursor:${sessDir.slice(0, 12)}`
      const items = await extractMemories(transcript, source)
      if (items.length > 0) {
        const ingested = await ingestMemories(items, source)
        total += ingested
        log(`  + ${source}: ${ingested} memories`)
      }
    }
  }
  return total
}

// ─── Hermes transcripts (SQLite) ────────────────────────────────────────────

async function processHermes(limit: number): Promise<number> {
  if (!existsSync(HERMES_DB)) { log("  hermes: state.db not found"); return 0 }
  let total = 0, processed = 0
  try {
    const db = new Database(HERMES_DB, { readonly: true })
    // Hermes schema: sessions(id, source, started_at, ended_at, title, ...)
    //               messages(id, session_id, role, content, timestamp, ...)
    try {
      const sessions = db.query(
        `SELECT s.id, s.title, s.started_at FROM sessions s
         WHERE s.started_at > ?
         ORDER BY s.started_at DESC LIMIT ?`
      ).all(sinceMs / 1000, limit) as any[]

      for (const session of sessions) {
        if (processed >= limit) break
        const msgs = db.query(
          `SELECT role, content FROM messages WHERE session_id = ? AND active = 1 ORDER BY id`
        ).all(session.id) as any[]

        const textParts = msgs
          .map(m => `${m.role}: ${m.content || ""}`)
          .filter(t => t.length > 10)
        const transcript = textParts.join("\n\n")
        if (transcript.length < MIN_CHARS) { log(`  · hermes:${String(session.id).slice(0,12)}: too short`); continue }
        processed++
        const source = `hermes:${String(session.id).slice(0, 12)}`
        const items = await extractMemories(transcript, source)
        if (items.length > 0) {
          const ingested = await ingestMemories(items, source)
          total += ingested
          log(`  + ${source}: ${ingested} memories`)
        }
      }
    } catch (e) {
      log(`  hermes: query failed: ${e}`)
    }
    db.close()
  } catch (e) {
    log(`  hermes: db open failed: ${e}`)
  }
  return total
}

// ─── OpenCode transcripts (SQLite) ──────────────────────────────────────────

async function processOpenCode(limit: number): Promise<number> {
  if (!existsSync(OPENCODE_DB)) { log("  opencode: db not found"); return 0 }
  let total = 0, processed = 0
  try {
    const db = new Database(OPENCODE_DB, { readonly: true })
    // OpenCode schema: sessions(message), messages(session_id, role, content), parts(message_id, content)
    const sessions = db.query(
      `SELECT s.id, s.updated_at FROM sessions s
       WHERE s.updated_at > ? ORDER BY s.updated_at DESC LIMIT ?`
    ).all(sinceMs, limit) as any[]

    for (const session of sessions) {
      if (processed >= limit) break
      const msgs = db.query(
        `SELECT m.role, p.content FROM messages m
         JOIN parts p ON p.message_id = m.id
         WHERE m.session_id = ? ORDER BY m.id, p.id`
      ).all(session.id) as any[]

      const textParts = msgs.map(m => `${m.role}: ${m.content}`).filter(t => t.length > 10)
      const transcript = textParts.join("\n\n")
      if (transcript.length < MIN_CHARS) { log(`  · opencode:${session.id.slice(0,12)}: too short`); continue }
      processed++
      const source = `opencode:${session.id.slice(0, 12)}`
      const items = await extractMemories(transcript, source)
      if (items.length > 0) {
        const ingested = await ingestMemories(items, source)
        total += ingested
        log(`  + ${source}: ${ingested} memories`)
      }
    }
    db.close()
  } catch (e) {
    log(`  opencode: failed: ${e}`)
  }
  return total
}

// ─── OpenClaw transcripts (JSONL) ────────────────────────────────────────────

async function processOpenClaw(limit: number): Promise<number> {
  if (!existsSync(OPENCLAW_DIR)) { log("  openclaw: sessions dir not found"); return 0 }
  let total = 0, processed = 0
  const files = await readdir(OPENCLAW_DIR).catch(() => [] as string[])
  for (const file of files) {
    if (processed >= limit) break
    if (!file.endsWith(".jsonl")) continue
    const fullPath = join(OPENCLAW_DIR, file)
    const s = await stat(fullPath).catch(() => null)
    if (!s || s.mtimeMs < sinceMs) continue
    const raw = await readFile(fullPath, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    const textParts: string[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        const role = obj.role || obj.type || "unknown"
        const content = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content || "")
        if (content) textParts.push(`${role}: ${content}`)
      } catch {}
    }
    const transcript = textParts.join("\n\n")
    if (transcript.length < MIN_CHARS) { log(`  · openclaw:${file}: too short`); continue }
    processed++
    const source = `openclaw:${file.slice(0, 40)}`
    const items = await extractMemories(transcript, source)
    if (items.length > 0) {
      const ingested = await ingestMemories(items, source)
      total += ingested
      log(`  + ${source}: ${ingested} memories`)
    }
  }
  return total
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`reflect start -- since=${new Date(sinceMs).toISOString()} dry=${DRY} limit=${LIMIT} model=${MODEL}${ONLY !== "all" ? ` source=${ONLY}` : ""}`)

  let total = 0
  const perSourceLimit = ONLY === "all" ? Math.ceil(LIMIT / 4) : LIMIT

  if (ONLY === "all" || ONLY === "claude") total += await processClaude(perSourceLimit)
  if (ONLY === "all" || ONLY === "codex") total += await processCodex(perSourceLimit)
  if (ONLY === "all" || ONLY === "cursor") total += await processCursor(perSourceLimit)
  if (ONLY === "all" || ONLY === "hermes") total += await processHermes(perSourceLimit)
  if (ONLY === "all" || ONLY === "opencode") total += await processOpenCode(perSourceLimit)
  if (ONLY === "all" || ONLY === "openclaw") total += await processOpenClaw(perSourceLimit)

  saveState({ lastRunMs: startMs })
  log(`reflect done -- ${total} memories ingested`)
}

main().catch(e => { log(`FATAL: ${e}`); process.exit(1) })