#!/usr/bin/env bun
/** Multi-source Cortex reflection with durable, replay-safe acceptance. */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFLECTION_EXTRACTION_PROMPT,
  applySourceTranscriptCheckpoints,
  applySourceTranscriptAttempts,
  buildReflectionWindows,
  emptyReflectionRunSummary,
  mergeReflectionRunSummary,
  normalizeTranscriptAttempts,
  parseJsonlRecords,
  parseReflectionJsonArray,
  reflectionRunFailed,
  reflectionTranscriptVersion,
  resolveTranscriptScanBaseline,
  runReflectionOperation,
  selectPendingTranscriptVersions,
  submitReflectionFacts,
  transcriptCheckpointKey,
  type ReflectionRunSummary,
  type TranscriptAttemptRecord,
  type VersionedTranscriptCandidate,
} from "./reflect-cursor.js";

type SourceName =
  | "claude"
  | "codex"
  | "cursor"
  | "hermes"
  | "opencode"
  | "openclaw";

interface TranscriptEntry {
  id: string;
  role: string;
  content: string;
}

interface TranscriptBundle extends VersionedTranscriptCandidate {
  source: string;
  transcriptPath: string;
  entries: TranscriptEntry[];
  malformedRecords: number;
  inputFailure?: "transcript_read_failed";
}

interface MultiState {
  checkpointVersion: 1 | 2;
  /** Legacy per-source high-water marks retained as fixed scan baselines. */
  sources: Partial<Record<SourceName, number>>;
  /** V2 fixed scan baseline for each independently migrated source. */
  scanBaselines: Partial<Record<SourceName, number>>;
  /** Exact completed transcript/session versions, isolated by source. */
  transcripts: Partial<Record<SourceName, Record<string, string>>>;
  /** Last attempt for incomplete versions, isolated by source for fairness. */
  attempts: Partial<Record<SourceName, Record<string, TranscriptAttemptRecord>>>;
}

const SOURCE_NAMES: readonly SourceName[] = [
  "claude",
  "codex",
  "cursor",
  "hermes",
  "opencode",
  "openclaw",
];
const HOME = homedir();
const CORTEX_DIR = join(HOME, ".cortex");
const STATE_FILE = join(CORTEX_DIR, "reflect-multi-state.json");
const LEGACY_STATE_FILE = join(CORTEX_DIR, "reflect-state.json");
const LOG_FILE = join(CORTEX_DIR, "reflect.log");
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
const CODEX_SESSIONS = join(HOME, ".codex", "sessions");
const CURSOR_PROJECTS = join(HOME, ".cursor", "projects");
const HERMES_DB = join(HOME, "AppData", "Local", "hermes", "state.db");
const OPENCODE_DB = join(HOME, ".local", "share", "opencode", "opencode.db");
const OPENCLAW_DIR = join(HOME, ".openclaw", "agents", "main", "sessions");
const MAX_CHARS = 120_000;
const MIN_CHARS = 400;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordId(candidate: unknown, raw: string, index: number): string {
  const value = typeof candidate === "string" && candidate.trim()
    ? candidate.normalize("NFC").trim()
    : `line:${index}:sha256:${sha256(raw)}`;
  return value.length <= 256 ? value : `record-sha256:${sha256(value)}`;
}

function log(message: string): void {
  const line = `${new Date().toISOString()}  [multi-reflect] ${message}`;
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Durable operation evidence remains authoritative.
  }
  console.log(line);
}

function normalizeVersionMap(value: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (value === undefined) return normalized;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reflection_state_invalid");
  }
  for (const [key, version] of Object.entries(value)) {
    if (typeof version !== "string" || !version) {
      throw new Error("reflection_state_invalid");
    }
    normalized[key] = version;
  }
  return normalized;
}

export function normalizeMultiState(value: unknown): MultiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reflection_state_invalid");
  }
  const candidate = value as {
    checkpointVersion?: unknown;
    sources?: unknown;
    scanBaselines?: unknown;
    transcripts?: unknown;
    attempts?: unknown;
  };
  const hasOwn = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(candidate, field);
  const knownSources = new Set<string>(SOURCE_NAMES);
  const validateSourceMap = (sourceMap: unknown): Record<string, unknown> => {
    if (sourceMap === undefined) return {};
    if (!sourceMap || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
      throw new Error("reflection_state_invalid");
    }
    const entries = sourceMap as Record<string, unknown>;
    if (Object.keys(entries).some((source) => !knownSources.has(source))) {
      throw new Error("reflection_state_invalid");
    }
    return entries;
  };
  const checkpointVersion = hasOwn("checkpointVersion") &&
      (candidate.checkpointVersion === 1 || candidate.checkpointVersion === 2)
    ? candidate.checkpointVersion
    : null;
  if (checkpointVersion === null) throw new Error("reflection_state_invalid");
  if (!hasOwn("sources")) throw new Error("reflection_state_invalid");
  if (
    checkpointVersion === 2 &&
    (!hasOwn("scanBaselines") || !hasOwn("transcripts"))
  ) {
    throw new Error("reflection_state_invalid");
  }
  const sources: Partial<Record<SourceName, number>> = {};
  const sourceValues = validateSourceMap(candidate.sources);
  for (const [source, checkpoint] of Object.entries(sourceValues)) {
    if (
      typeof checkpoint !== "number" ||
      !Number.isFinite(checkpoint) ||
      checkpoint < 0
    ) {
      throw new Error("reflection_state_invalid");
    }
    sources[source as SourceName] = checkpoint;
  }
  const scanBaselines: Partial<Record<SourceName, number>> = {};
  const baselineValues = validateSourceMap(candidate.scanBaselines);
  for (const [source, baseline] of Object.entries(baselineValues)) {
    if (
      typeof baseline !== "number" ||
      !Number.isFinite(baseline) ||
      baseline < 0
    ) {
      throw new Error("reflection_state_invalid");
    }
    scanBaselines[source as SourceName] = baseline;
  }
  const transcripts: Partial<Record<SourceName, Record<string, string>>> = {};
  for (const [source, versions] of Object.entries(
    validateSourceMap(candidate.transcripts)
  )) {
    transcripts[source as SourceName] = normalizeVersionMap(versions);
  }
  const attempts: Partial<
    Record<SourceName, Record<string, TranscriptAttemptRecord>>
  > = {};
  for (const [source, sourceAttempts] of Object.entries(
    validateSourceMap(candidate.attempts)
  )) {
    attempts[source as SourceName] = normalizeTranscriptAttempts(sourceAttempts);
  }
  return {
    checkpointVersion,
    sources,
    scanBaselines,
    transcripts,
    attempts,
  };
}

function normalizeLegacyMultiState(value: unknown): MultiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reflection_state_invalid");
  }
  const lastRunMs = (value as { lastRunMs?: unknown }).lastRunMs;
  if (
    typeof lastRunMs !== "number" ||
    !Number.isFinite(lastRunMs) ||
    lastRunMs < 0
  ) {
    throw new Error("reflection_state_invalid");
  }
  return {
    checkpointVersion: 1,
    sources: Object.fromEntries(
      SOURCE_NAMES.map((source) => [source, lastRunMs])
    ) as Record<SourceName, number>,
    scanBaselines: {},
    transcripts: {},
    attempts: {},
  };
}

function loadState(): MultiState {
  const statePath = existsSync(STATE_FILE)
    ? STATE_FILE
    : existsSync(LEGACY_STATE_FILE)
      ? LEGACY_STATE_FILE
      : null;
  if (statePath === null) {
    return {
      checkpointVersion: 2,
      sources: {},
      scanBaselines: {},
      transcripts: {},
      attempts: {},
    };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    return statePath === LEGACY_STATE_FILE
      ? normalizeLegacyMultiState(parsed)
      : normalizeMultiState(parsed);
  } catch {
    throw new Error("reflection_state_invalid");
  }
}

function saveState(state: MultiState): void {
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, STATE_FILE);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original state file and surface the write failure.
    }
    throw error;
  }
}

function argumentValue(args: readonly string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    )
    .join(" ");
}

async function extractMemories(
  transcript: string,
  source: string,
  ollamaUrl: string,
  model: string,
  apiKey: string
): Promise<unknown[] | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 900_000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${ollamaUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "Extract durable memory and return only one JSON array.",
            },
            {
              role: "user",
              content: `${REFLECTION_EXTRACTION_PROMPT}${transcript}\n--- TRANSCRIPT END ---\n`,
            },
          ],
          max_tokens: 4_000,
          temperature: 0.3,
          stream: false,
        }),
      }).finally(() => clearTimeout(timer));
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        const message = choices?.[0]?.message as Record<string, unknown> | undefined;
        const output = typeof message?.content === "string" ? message.content : "";
        const parsed = parseReflectionJsonArray(output);
        if (parsed !== null) return parsed;
        log(`  ! ${source}: malformed extraction output`);
        return null;
      }
      if (response.status === 429 || response.status === 503) {
        log(`  ~ ${source}: extraction temporarily unavailable; retrying`);
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, (attempt + 1) * 5_000)
        );
        continue;
      }
      log(`  ! ${source}: extraction request failed (${response.status})`);
      return null;
    } catch {
      log(`  ! ${source}: extraction endpoint unreachable`);
      return null;
    }
  }
  return null;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function timestampMs(value: string | number, numericScale = 1): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric * numericScale;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fileEntries(
  path: string,
  parse: (value: Record<string, unknown>) => { role: string; content: string; id?: unknown } | null
): Promise<{
  entries: TranscriptEntry[];
  malformedRecords: number;
  version: string;
  inputFailure?: "transcript_read_failed";
}> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      entries: [],
      malformedRecords: 0,
      version: "unavailable",
      inputFailure: "transcript_read_failed",
    };
  }
  const parsed = parseJsonlRecords(raw, (value, line, lineNumber) => {
    const record = parse(value);
    if (!record?.content) return null;
    return {
      id: recordId(record.id, line, lineNumber),
      role: record.role,
      content: record.content,
    };
  });
  return {
    entries: parsed.records,
    malformedRecords: parsed.malformedRecords,
    version: reflectionTranscriptVersion(raw),
  };
}

async function collectClaude(sinceMs: number): Promise<TranscriptBundle[]> {
  if (!existsSync(CLAUDE_PROJECTS)) return [];
  const bundles: TranscriptBundle[] = [];
  for (const project of await readdir(CLAUDE_PROJECTS).catch(() => [] as string[])) {
    for (const file of await readdir(join(CLAUDE_PROJECTS, project)).catch(() => [] as string[])) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(CLAUDE_PROJECTS, project, file);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < sinceMs) continue;
      const parsed = await fileEntries(path, (value) => {
        if (value.type !== "user" && value.type !== "assistant") return null;
        const message = value.message as Record<string, unknown> | undefined;
        return {
          id: value.uuid ?? value.id ?? message?.id,
          role: String(value.type),
          content: messageText(message?.content),
        };
      });
      const canonical = await canonicalPath(path);
      bundles.push({
        source: `claude:${file}`,
        transcriptPath: canonical,
        checkpointKey: transcriptCheckpointKey(canonical),
        version: parsed.version,
        orderMs: info.mtimeMs,
        entries: parsed.entries,
        malformedRecords: parsed.malformedRecords,
        ...(parsed.inputFailure ? { inputFailure: parsed.inputFailure } : {}),
      });
    }
  }
  return bundles;
}

async function collectCodex(sinceMs: number): Promise<TranscriptBundle[]> {
  if (!existsSync(CODEX_SESSIONS)) return [];
  const bundles: TranscriptBundle[] = [];
  const years = await readdir(CODEX_SESSIONS).catch(() => [] as string[]);
  for (const year of years) {
    for (const month of await readdir(join(CODEX_SESSIONS, year)).catch(() => [] as string[])) {
      for (const day of await readdir(join(CODEX_SESSIONS, year, month)).catch(() => [] as string[])) {
        for (const file of await readdir(join(CODEX_SESSIONS, year, month, day)).catch(() => [] as string[])) {
          if (!file.endsWith(".jsonl")) continue;
          const path = join(CODEX_SESSIONS, year, month, day, file);
          const info = await stat(path).catch(() => null);
          if (!info || info.mtimeMs < sinceMs) continue;
          const parsed = await fileEntries(path, (value) => {
            const payload = value.payload as Record<string, unknown> | undefined;
            if (value.type !== "response_item" || payload?.type !== "message") return null;
            return {
              id: payload.id ?? value.id,
              role: typeof payload.role === "string" ? payload.role : "unknown",
              content: messageText(payload.content),
            };
          });
          const canonical = await canonicalPath(path);
          bundles.push({
            source: `codex:${file.slice(0, 60)}`,
            transcriptPath: canonical,
            checkpointKey: transcriptCheckpointKey(canonical),
            version: parsed.version,
            orderMs: info.mtimeMs,
            entries: parsed.entries,
            malformedRecords: parsed.malformedRecords,
            ...(parsed.inputFailure ? { inputFailure: parsed.inputFailure } : {}),
          });
        }
      }
    }
  }
  return bundles;
}

async function collectCursor(sinceMs: number): Promise<TranscriptBundle[]> {
  if (!existsSync(CURSOR_PROJECTS)) return [];
  const bundles: TranscriptBundle[] = [];
  for (const project of await readdir(CURSOR_PROJECTS).catch(() => [] as string[])) {
    const directory = join(CURSOR_PROJECTS, project, "agent-transcripts");
    if (!existsSync(directory)) continue;
    for (const session of await readdir(directory).catch(() => [] as string[])) {
      const path = join(directory, session, `${session}.jsonl`);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.mtimeMs < sinceMs) continue;
      const parsed = await fileEntries(path, (value) => {
        const message = value.message as Record<string, unknown> | undefined;
        return {
          id: value.id ?? value.uuid ?? message?.id ?? value.messageId,
          role: typeof value.role === "string" ? value.role : "unknown",
          content: messageText(message?.content),
        };
      });
      const canonical = await canonicalPath(path);
      bundles.push({
        source: `cursor:${session.slice(0, 12)}`,
        transcriptPath: canonical,
        checkpointKey: transcriptCheckpointKey(canonical),
        version: parsed.version,
        orderMs: info.mtimeMs,
        entries: parsed.entries,
        malformedRecords: parsed.malformedRecords,
        ...(parsed.inputFailure ? { inputFailure: parsed.inputFailure } : {}),
      });
    }
  }
  return bundles;
}

async function collectOpenClaw(sinceMs: number): Promise<TranscriptBundle[]> {
  if (!existsSync(OPENCLAW_DIR)) return [];
  const bundles: TranscriptBundle[] = [];
  for (const file of await readdir(OPENCLAW_DIR).catch(() => [] as string[])) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(OPENCLAW_DIR, file);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const parsed = await fileEntries(path, (value) => ({
      id: value.id ?? value.uuid ?? value.message_id,
      role: typeof value.role === "string"
        ? value.role
        : typeof value.type === "string"
          ? value.type
          : "unknown",
      content: messageText(value.content),
    }));
    const canonical = await canonicalPath(path);
    bundles.push({
      source: `openclaw:${file.slice(0, 40)}`,
      transcriptPath: canonical,
      checkpointKey: transcriptCheckpointKey(canonical),
      version: parsed.version,
      orderMs: info.mtimeMs,
      entries: parsed.entries,
      malformedRecords: parsed.malformedRecords,
      ...(parsed.inputFailure ? { inputFailure: parsed.inputFailure } : {}),
    });
  }
  return bundles;
}

async function collectHermes(sinceMs: number): Promise<TranscriptBundle[]> {
  if (!existsSync(HERMES_DB)) return [];
  const { Database } = await import("bun:sqlite");
  const database = new Database(HERMES_DB, { readonly: true });
  try {
    const sessions = database
      .query(
        `SELECT s.id, s.started_at FROM sessions s
         WHERE s.started_at > ? ORDER BY s.started_at ASC, s.id ASC`
      )
      .all(sinceMs / 1_000) as Array<{
        id: string | number;
        started_at: string | number;
      }>;
    const path = await canonicalPath(HERMES_DB);
    return sessions.map((session) => {
      const messages = database
        .query(
          `SELECT id, role, content FROM messages
           WHERE session_id = ? AND active = 1 ORDER BY id`
        )
        .all(session.id) as Array<{ id: string | number; role: string; content: string }>;
      const entries = messages.map((message) => ({
        id: recordId(
          `${String(session.id)}:${String(message.id)}`,
          String(message.content),
          Number(message.id) || 0
        ),
        role: message.role,
        content: String(message.content || ""),
      }));
      return {
        source: `hermes:${String(session.id).slice(0, 40)}`,
        transcriptPath: path,
        checkpointKey: transcriptCheckpointKey(path, session.id),
        version: reflectionTranscriptVersion(JSON.stringify(entries)),
        orderMs: timestampMs(session.started_at, 1_000),
        entries,
        malformedRecords: 0,
      };
    });
  } finally {
    database.close();
  }
}

async function collectOpenCode(sinceMs: number): Promise<TranscriptBundle[]> {
  if (!existsSync(OPENCODE_DB)) return [];
  const { Database } = await import("bun:sqlite");
  const database = new Database(OPENCODE_DB, { readonly: true });
  try {
    const sessions = database
      .query(
        `SELECT s.id, s.updated_at FROM sessions s
         WHERE s.updated_at > ? ORDER BY s.updated_at ASC, s.id ASC`
      )
      .all(sinceMs) as Array<{ id: string; updated_at: string | number }>;
    const path = await canonicalPath(OPENCODE_DB);
    return sessions.map((session) => {
      const messages = database
        .query(
          `SELECT m.id AS message_id, p.id AS part_id, m.role, p.content
           FROM messages m JOIN parts p ON p.message_id = m.id
           WHERE m.session_id = ? ORDER BY m.id, p.id`
        )
        .all(session.id) as Array<{
          message_id: string;
          part_id: string;
          role: string;
          content: string;
        }>;
      const entries = messages.map((message) => ({
        id: recordId(
          `${session.id}:${message.message_id}:${message.part_id}`,
          String(message.content),
          0
        ),
        role: message.role,
        content: String(message.content || ""),
      }));
      return {
        source: `opencode:${session.id.slice(0, 40)}`,
        transcriptPath: path,
        checkpointKey: transcriptCheckpointKey(path, session.id),
        version: reflectionTranscriptVersion(JSON.stringify(entries)),
        orderMs: timestampMs(session.updated_at),
        entries,
        malformedRecords: 0,
      };
    });
  } finally {
    database.close();
  }
}

async function collectSource(
  source: SourceName,
  sinceMs: number
): Promise<TranscriptBundle[]> {
  if (source === "claude") return collectClaude(sinceMs);
  if (source === "codex") return collectCodex(sinceMs);
  if (source === "cursor") return collectCursor(sinceMs);
  if (source === "hermes") return collectHermes(sinceMs);
  if (source === "opencode") return collectOpenCode(sinceMs);
  return collectOpenClaw(sinceMs);
}

async function processSource(
  sourceName: SourceName,
  sinceMs: number,
  limit: number,
  options: {
    agentId: string;
    cortexUrl: string;
    ollamaUrl: string;
    model: string;
    apiKey: string;
    checkpoints: Readonly<Record<string, string>>;
    attempts: Readonly<Record<string, TranscriptAttemptRecord>>;
    dryRun: boolean;
  }
): Promise<{
  summary: ReflectionRunSummary;
  completed: Record<string, string>;
  attempted: Record<string, TranscriptAttemptRecord>;
}> {
  const summary = emptyReflectionRunSummary();
  const completed: Record<string, string> = {};
  const attempted: Record<string, TranscriptAttemptRecord> = {};
  const collected = await collectSource(sourceName, sinceMs);
  const bundles = selectPendingTranscriptVersions(
    collected,
    options.checkpoints,
    limit,
    options.attempts
  );
  for (const bundle of bundles) {
    attempted[bundle.checkpointKey] = {
      version: bundle.version,
      attemptedAtMs: Date.now(),
    };
    summary.transcripts += 1;
    if (bundle.inputFailure) {
      summary.extractionFailures += 1;
      log(`  ! ${bundle.source}: ${bundle.inputFailure}; retained for retry`);
      continue;
    }
    if (bundle.malformedRecords > 0) {
      summary.extractionFailures += 1;
      log(
        `  ! ${bundle.source}: malformed_jsonl (${bundle.malformedRecords} record(s)); retained for retry`
      );
      continue;
    }
    const reflectionEntries = bundle.entries.map((entry) => ({
      id: entry.id,
      text: `[entry_id=${JSON.stringify(entry.id)}] ${entry.role}: ${entry.content}`,
    }));
    const transcript = reflectionEntries.map((entry) => entry.text).join("\n\n");
    if (transcript.length < MIN_CHARS) {
      completed[bundle.checkpointKey] = bundle.version;
      continue;
    }
    const windows = buildReflectionWindows(reflectionEntries, MAX_CHARS);
    let transcriptFailed = false;
    for (const [windowIndex, window] of windows.entries()) {
      const windowSource = `${bundle.source}:window-${windowIndex + 1}-of-${windows.length}`;
      const items = await extractMemories(
        window.transcript,
        windowSource,
        options.ollamaUrl,
        options.model,
        options.apiKey
      );
      if (items === null) {
        summary.extractionFailures += 1;
        transcriptFailed = true;
        break;
      }
      if (items.length === 0) {
        log(`  · ${windowSource}: successful zero-output reflection`);
      }
      try {
        const submitted = await submitReflectionFacts(
          items,
          {
            source: bundle.source,
            transcriptPath: bundle.transcriptPath,
            transcriptEntryIds: window.entryIds,
          },
          {
            agentId: options.agentId,
            cortexUrl: options.cortexUrl,
            dryRun: options.dryRun,
            log,
          }
        );
        mergeReflectionRunSummary(summary, submitted);
        log(
          `  + ${windowSource}: ${submitted.indexed} indexed, ${submitted.queued} queued, ${submitted.failed + submitted.rejected + submitted.submissionFailures} failed`
        );
        if (!options.dryRun && reflectionRunFailed(submitted)) {
          transcriptFailed = true;
          break;
        }
      } catch {
        summary.extractionFailures += 1;
        transcriptFailed = true;
        log(`  ! ${windowSource}: reflection_fact_invalid`);
        break;
      }
    }
    if (!transcriptFailed) {
      completed[bundle.checkpointKey] = bundle.version;
    }
  }
  return { summary, completed, attempted };
}

async function resolveRuntimeAgentId(externalId: string): Promise<number> {
  const { sqlClient } = await import("../src/db/index.js");
  const rows = await sqlClient`
    SELECT id FROM public.agents WHERE external_id = ${externalId} LIMIT 1
  `;
  if (rows.length !== 1) throw new Error("reflection_agent_not_found");
  return Number(rows[0].id);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  mkdirSync(CORTEX_DIR, { recursive: true });
  const dryRun = argv.includes("--dry-run");
  const limit = Number.parseInt(argumentValue(argv, "--limit", "40"), 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("invalid_reflection_limit");
  }
  const selectedValue = argumentValue(argv, "--source", "all");
  const selected = selectedValue === "all"
    ? [...SOURCE_NAMES]
    : SOURCE_NAMES.filter((name) => name === selectedValue);
  if (selected.length === 0) throw new Error("invalid_reflection_source");
  const sinceHours = argumentValue(argv, "--since-hours", "");
  const parsedSinceHours = sinceHours ? Number.parseInt(sinceHours, 10) : null;
  if (parsedSinceHours !== null && (!Number.isInteger(parsedSinceHours) || parsedSinceHours < 0)) {
    throw new Error("invalid_reflection_since_hours");
  }
  const startMs = Date.now();
  const state = loadState();
  const agentId = process.env.CORTEX_AGENT_ID || "arlo";
  const cortexUrl = process.env.CORTEX_REST_URL || "http://127.0.0.1:3100";
  const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
  const model = process.env.REFLECT_MODEL || "glm-5.2:cloud";
  const apiKey = process.env.OLLAMA_API_KEY || "";
  const perSourceLimit = selected.length > 1 ? Math.ceil(limit / selected.length) : limit;
  const perSource = new Map<SourceName, ReflectionRunSummary>();
  const completedBySource = new Map<SourceName, Record<string, string>>();
  const attemptedBySource = new Map<
    SourceName,
    Record<string, TranscriptAttemptRecord>
  >();
  const sourceBaselines = new Map<SourceName, number>();

  log(
    `reflect start -- dry=${dryRun} limit=${limit} model=${model} sources=${selected.join(",")}`
  );
  const run = async (): Promise<ReflectionRunSummary> => {
    const total = emptyReflectionRunSummary();
    for (const source of selected) {
      const sourceHasV2Baseline = Number.isFinite(state.scanBaselines[source]);
      const sinceMs = resolveTranscriptScanBaseline(
        {
          checkpointVersion: sourceHasV2Baseline
            ? 2
            : state.sources[source]
              ? 1
              : 2,
          lastRunMs: state.sources[source] ?? 0,
          ...(sourceHasV2Baseline
            ? { scanBaselineMs: state.scanBaselines[source] }
            : {}),
        },
        startMs,
        parsedSinceHours !== null
          ? startMs - parsedSinceHours * 3_600_000
          : undefined
      );
      sourceBaselines.set(source, sinceMs);
      try {
        const result = await processSource(source, sinceMs, perSourceLimit, {
          agentId,
          cortexUrl,
          ollamaUrl,
          model,
          apiKey,
          checkpoints: state.transcripts[source] ?? {},
          attempts: state.attempts[source] ?? {},
          dryRun,
        });
        perSource.set(source, result.summary);
        completedBySource.set(source, result.completed);
        attemptedBySource.set(source, result.attempted);
        mergeReflectionRunSummary(total, result.summary);
      } catch {
        const result = emptyReflectionRunSummary();
        result.extractionFailures = 1;
        perSource.set(source, result);
        mergeReflectionRunSummary(total, result);
        log(`  ! ${source}: source processing failed`);
      }
    }
    return total;
  };

  let closeDatabase: () => Promise<void> = async () => undefined;
  try {
    const summary = dryRun
      ? await run()
      : await (async () => {
          const databaseModule = await import("../src/db/index.js");
          const memoryModule = await import("../src/memory/index.js");
          await databaseModule.initDatabase();
          closeDatabase = databaseModule.closeDatabaseConnection;
          return runReflectionOperation(
            memoryModule.createMemoryServices().health,
            await resolveRuntimeAgentId(agentId),
            run
          );
        })();
    if (!dryRun) {
      for (const [source, baseline] of sourceBaselines) {
        // Freeze each source's v2 scan baseline. Exact session versions carry
        // progress without allowing a limited run to leap over backlog.
        state.sources[source] = baseline;
        state.scanBaselines[source] = baseline;
      }
      state.checkpointVersion = 2;
      state.transcripts = applySourceTranscriptCheckpoints(
        state.transcripts as Record<string, Readonly<Record<string, string>>>,
        completedBySource
      ) as Partial<Record<SourceName, Record<string, string>>>;
      state.attempts = applySourceTranscriptAttempts(
        state.attempts as Record<
          string,
          Readonly<Record<string, TranscriptAttemptRecord>>
        >,
        attemptedBySource,
        completedBySource
      ) as Partial<
        Record<SourceName, Record<string, TranscriptAttemptRecord>>
      >;
      saveState(state);
    }
    log(
      `reflect done -- ${summary.indexed} indexed, ${summary.queued} durably queued, ${summary.failed + summary.rejected + summary.submissionFailures} failed, ${summary.extractionFailures} extraction failures`
    );
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(`FATAL: ${(error as Error)?.message || "reflection_run_failed"}`);
    process.exitCode = 1;
  });
}
