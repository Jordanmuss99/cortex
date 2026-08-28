#!/usr/bin/env tsx
/**
 * Cortex nightly reflection for Cursor transcripts.
 *
 * Facts are accepted through the public durable-ingest adapter. Exact retries
 * replay by a key made from the canonical transcript path, a real transcript
 * record ID, the extraction prompt version, and normalized fact content.
 */

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
import { Agent, setGlobalDispatcher } from "undici";
import {
  deriveReflectionIngestKey,
  normalizeReflectionFactContent,
} from "../src/memory/ingest.js";
import type { MemoryHealthService } from "../src/memory/types.js";

export const REFLECTION_PROMPT_VERSION = "reflection-extract-v1";

const HOME = homedir();
const CORTEX_DIR = join(HOME, ".cortex");
const STATE_FILE = join(CORTEX_DIR, "reflect-cursor-state.json");
const LOG_FILE = join(CORTEX_DIR, "reflect.log");
const CURSOR_PROJECTS = join(HOME, ".cursor", "projects");
const MAX_CHARS = 120_000;
const MAX_CHARS_LOCAL = 40_000;
const MIN_CHARS = 400;

export const REFLECTION_EXTRACTION_PROMPT = `You are a memory extraction assistant. Given an AI agent session transcript, extract durable, reusable memories as a JSON array. Each transcript record begins with an entry_id. Every result must name the one exact entry_id that most directly supports the fact. Extract self-contained facts, decisions, learnings, corrections, or insights useful in future sessions. Skip greetings, transient status, tool output, and copied file contents. Format: [{"entry_id":"<exact transcript entry_id>","content":"...","type":"decision|learning|correction|insight"}]. Return ONLY the JSON array. A literal [] means the transcript contains no durable memory.

Transcript:
`;

export interface ReflectionEndpoint {
  url: string;
  model: string;
  apiKey: string;
  label: "primary" | "fallback";
  native: boolean;
}

export interface ReflectionOrigin {
  source: string;
  transcriptPath: string;
  transcriptEntryId?: string;
  transcriptEntryIds?: readonly string[];
}

export interface PreparedReflectionFact {
  content: string;
  transcriptEntryId: string;
  idempotencyKey: string;
  payload: {
    agentId: string;
    content: string;
    idempotencyKey: string;
    source: string;
    sourceVersion: string;
    sourceType: "reflection";
    priority: 2;
    semanticTags: ["reflection"];
    requestId: string;
    sessionId: string;
    waitMs: number;
  };
}

export interface ReflectionRunSummary {
  transcripts: number;
  prepared: number;
  durable: number;
  indexed: number;
  queued: number;
  failed: number;
  rejected: number;
  replayed: number;
  submissionFailures: number;
  extractionFailures: number;
}

interface ReflectionExtractionResult {
  ok: boolean;
  items: unknown[];
}

interface ReflectionSubmitOptions {
  agentId: string;
  cortexUrl: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  waitMs?: number;
  dryRun?: boolean;
}

interface CursorRunOptions {
  limit: number;
  sinceMs: number;
  agentId: string;
  cortexUrl: string;
  endpoints: readonly ReflectionEndpoint[];
  checkpoints: Readonly<Record<string, string>>;
  attempts: Readonly<Record<string, TranscriptAttemptRecord>>;
  dryRun: boolean;
  log: (message: string) => void;
}

export interface ReflectionTranscriptEntry {
  id: string;
  text: string;
}

export interface ReflectionTranscriptWindow {
  transcript: string;
  entryIds: string[];
}

export interface ParsedJsonlRecords<T> {
  records: T[];
  malformedRecords: number;
}

export interface VersionedTranscriptCandidate {
  checkpointKey: string;
  version: string;
  orderMs: number;
}

export interface TranscriptAttemptRecord {
  version: string;
  attemptedAtMs: number;
}

export interface CursorState {
  checkpointVersion: 1 | 2;
  /** Legacy high-water mark retained as the fixed scan baseline. */
  lastRunMs: number;
  /** V2 scan baseline; unlike the legacy watermark, zero is meaningful. */
  scanBaselineMs?: number;
  /** Exact content version last completed for each canonical transcript. */
  transcripts: Record<string, string>;
  /** Failed/incomplete versions are retried fairly instead of starving backlog. */
  attempts: Record<string, TranscriptAttemptRecord>;
}

class ReflectionFactValidationError extends Error {
  readonly code = "reflection_fact_invalid";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRecordId(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length <= 256) return normalized;
  return `record-sha256:${sha256(normalized)}`;
}

function correlationId(prefix: string, value: string): string {
  return `${prefix}:${sha256(value)}`;
}

export function reflectionTranscriptVersion(content: string): string {
  return `sha256:${sha256(content)}`;
}

export function transcriptCheckpointKey(
  canonicalPath: string,
  sessionId?: string | number
): string {
  return sessionId === undefined
    ? canonicalPath
    : `${canonicalPath}\u0000session:${String(sessionId)}`;
}

export function parseJsonlRecords<T>(
  raw: string,
  parse: (
    value: Record<string, unknown>,
    rawLine: string,
    lineNumber: number
  ) => T | null
): ParsedJsonlRecords<T> {
  const records: T[] = [];
  let malformedRecords = 0;
  for (const [index, rawLine] of raw.split("\n").entries()) {
    if (!rawLine.trim()) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawLine);
    } catch {
      malformedRecords += 1;
      continue;
    }
    // Valid non-object JSON is irrelevant, not malformed JSONL.
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) continue;
    try {
      const record = parse(
        decoded as Record<string, unknown>,
        rawLine,
        index + 1
      );
      if (record !== null) records.push(record);
    } catch {
      malformedRecords += 1;
    }
  }
  return { records, malformedRecords };
}

function splitWithoutBreakingSurrogatePairs(value: string, maximum: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + maximum);
    if (
      end < value.length &&
      end > offset &&
      /[\uD800-\uDBFF]/.test(value[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(value[end])
    ) {
      end -= 1;
    }
    if (end === offset) end = Math.min(value.length, offset + 2);
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

/**
 * Pack complete records into bounded extraction windows. An individually
 * oversized record is segmented, but every segment repeats the same entry ID
 * so extraction provenance and fact idempotency remain tied to the real record.
 */
export function buildReflectionWindows(
  entries: readonly ReflectionTranscriptEntry[],
  requestedMaxChars: number
): ReflectionTranscriptWindow[] {
  const maxChars = Math.max(
    512,
    Number.isFinite(requestedMaxChars) ? Math.trunc(requestedMaxChars) : MAX_CHARS
  );
  const segments: Array<{ text: string; entryId: string }> = [];
  for (const entry of entries) {
    const marker = `[entry_id=${JSON.stringify(entry.id)}]`;
    if (entry.text.length <= maxChars) {
      segments.push({ text: entry.text, entryId: entry.id });
      continue;
    }
    const body = entry.text.startsWith(marker)
      ? entry.text.slice(marker.length).replace(/^\s+/, "")
      : entry.text;
    // Leave fixed room for the marker and a segment counter. Entry IDs are
    // bounded to 256 characters before this helper is called.
    const contentLimit = Math.max(1, maxChars - marker.length - 64);
    const parts = splitWithoutBreakingSurrogatePairs(body, contentLimit);
    for (const [index, part] of parts.entries()) {
      const text = `${marker} [segment ${index + 1}/${parts.length}] ${part}`;
      if (text.length > maxChars) {
        throw new Error("reflection_window_record_too_large");
      }
      segments.push({ text, entryId: entry.id });
    }
  }

  const windows: ReflectionTranscriptWindow[] = [];
  let parts: string[] = [];
  let entryIds = new Set<string>();
  let length = 0;
  const flush = () => {
    if (parts.length === 0) return;
    windows.push({ transcript: parts.join("\n\n"), entryIds: [...entryIds] });
    parts = [];
    entryIds = new Set<string>();
    length = 0;
  };
  for (const segment of segments) {
    const separatorLength = parts.length === 0 ? 0 : 2;
    if (parts.length > 0 && length + separatorLength + segment.text.length > maxChars) {
      flush();
    }
    parts.push(segment.text);
    entryIds.add(segment.entryId);
    length += (parts.length === 1 ? 0 : 2) + segment.text.length;
  }
  flush();
  return windows;
}

export function selectPendingTranscriptVersions<
  T extends VersionedTranscriptCandidate,
>(
  candidates: readonly T[],
  checkpoints: Readonly<Record<string, string>>,
  limit: number,
  attempts: Readonly<Record<string, TranscriptAttemptRecord>> = {}
): T[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  return candidates
    .filter((candidate) => checkpoints[candidate.checkpointKey] !== candidate.version)
    .sort(
      (left, right) => {
        const leftAttempt = attempts[left.checkpointKey];
        const rightAttempt = attempts[right.checkpointKey];
        const leftAttemptedAt = leftAttempt?.version === left.version
          ? leftAttempt.attemptedAtMs
          : Number.NEGATIVE_INFINITY;
        const rightAttemptedAt = rightAttempt?.version === right.version
          ? rightAttempt.attemptedAtMs
          : Number.NEGATIVE_INFINITY;
        if (leftAttemptedAt !== rightAttemptedAt) {
          return leftAttemptedAt < rightAttemptedAt ? -1 : 1;
        }
        return (
          left.orderMs - right.orderMs ||
          left.checkpointKey.localeCompare(right.checkpointKey)
        );
      }
    )
    .slice(0, limit);
}

export function applyCompletedTranscriptCheckpoints(
  current: Readonly<Record<string, string>>,
  completed: Readonly<Record<string, string>>
): Record<string, string> {
  return { ...current, ...completed };
}

export function applyTranscriptAttempts(
  current: Readonly<Record<string, TranscriptAttemptRecord>>,
  attempted: Readonly<Record<string, TranscriptAttemptRecord>>,
  completed: Readonly<Record<string, string>>
): Record<string, TranscriptAttemptRecord> {
  const updated = { ...current, ...attempted };
  for (const checkpointKey of Object.keys(completed)) delete updated[checkpointKey];
  return updated;
}

export function applySourceTranscriptCheckpoints(
  current: Readonly<Record<string, Readonly<Record<string, string>>>>,
  completed: ReadonlyMap<string, Readonly<Record<string, string>>>
): Record<string, Record<string, string>> {
  const updated = Object.fromEntries(
    Object.entries(current).map(([source, checkpoints]) => [source, { ...checkpoints }])
  );
  for (const [source, checkpoints] of completed) {
    updated[source] = applyCompletedTranscriptCheckpoints(
      updated[source] ?? {},
      checkpoints
    );
  }
  return updated;
}

export function applySourceTranscriptAttempts(
  current: Readonly<
    Record<string, Readonly<Record<string, TranscriptAttemptRecord>>>
  >,
  attempted: ReadonlyMap<
    string,
    Readonly<Record<string, TranscriptAttemptRecord>>
  >,
  completed: ReadonlyMap<string, Readonly<Record<string, string>>>
): Record<string, Record<string, TranscriptAttemptRecord>> {
  const updated = Object.fromEntries(
    Object.entries(current).map(([source, attempts]) => [source, { ...attempts }])
  );
  for (const [source, sourceAttempts] of attempted) {
    updated[source] = applyTranscriptAttempts(
      updated[source] ?? {},
      sourceAttempts,
      completed.get(source) ?? {}
    );
  }
  return updated;
}

export function resolveTranscriptScanBaseline(
  state: Pick<CursorState, "checkpointVersion" | "lastRunMs" | "scanBaselineMs">,
  startMs: number,
  explicitSinceMs?: number
): number {
  if (explicitSinceMs !== undefined) return explicitSinceMs;
  if (state.checkpointVersion === 2 && Number.isFinite(state.scanBaselineMs)) {
    return state.scanBaselineMs!;
  }
  // A scalar legacy high-water may already have leapt over a limited backlog.
  // Ignore it once and enumerate all historical candidates for exact versioning.
  if (state.checkpointVersion === 1 && state.lastRunMs > 0) return 0;
  return startMs - 26 * 3_600_000;
}

export function emptyReflectionRunSummary(): ReflectionRunSummary {
  return {
    transcripts: 0,
    prepared: 0,
    durable: 0,
    indexed: 0,
    queued: 0,
    failed: 0,
    rejected: 0,
    replayed: 0,
    submissionFailures: 0,
    extractionFailures: 0,
  };
}

export function mergeReflectionRunSummary(
  target: ReflectionRunSummary,
  source: ReflectionRunSummary
): ReflectionRunSummary {
  for (const key of Object.keys(target) as Array<keyof ReflectionRunSummary>) {
    target[key] += source[key];
  }
  return target;
}

export function reflectionRunFailed(summary: ReflectionRunSummary): boolean {
  return (
    summary.durable !== summary.prepared ||
    summary.extractionFailures > 0 ||
    summary.submissionFailures > 0 ||
    summary.failed > 0 ||
    summary.rejected > 0
  );
}

export function updateSuccessfulSourceCheckpoints(
  current: Readonly<Record<string, number>>,
  results: ReadonlyMap<string, ReflectionRunSummary>,
  checkpointMs: number
): Record<string, number> {
  const updated = { ...current };
  for (const [source, summary] of results) {
    if (!reflectionRunFailed(summary)) updated[source] = checkpointMs;
  }
  return updated;
}

export function buildReflectionEndpoints(
  env: NodeJS.ProcessEnv = process.env
): ReflectionEndpoint[] {
  const primaryUrl = (env.OLLAMA_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
  const endpoints: ReflectionEndpoint[] = [
    {
      url: primaryUrl,
      model: env.REFLECT_MODEL || "qwen3-coder:30b",
      apiKey: env.OLLAMA_API_KEY || "",
      label: "primary",
      native: /:11434(?:\/|$)/.test(primaryUrl),
    },
  ];
  const fallbackUrl = env.REFLECT_FALLBACK_URL?.trim();
  const fallbackModel = env.REFLECT_FALLBACK_MODEL?.trim();
  const fallbackKey = env.REFLECT_FALLBACK_KEY?.trim();
  if (fallbackUrl && fallbackModel && fallbackKey) {
    endpoints.push({
      url: fallbackUrl.replace(/\/$/, ""),
      model: fallbackModel,
      apiKey: fallbackKey,
      label: "fallback",
      native: false,
    });
  }
  return endpoints;
}

function positiveWindowLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(512, parsed) : fallback;
}

export function reflectionWindowLimit(
  endpoints: readonly ReflectionEndpoint[],
  env: NodeJS.ProcessEnv = process.env
): number {
  const limits = endpoints.map((endpoint) =>
    endpoint.native
      ? positiveWindowLimit(env.REFLECT_MAX_CHARS_LOCAL, MAX_CHARS_LOCAL)
      : MAX_CHARS
  );
  return limits.length > 0 ? Math.min(...limits) : MAX_CHARS;
}

export function parseReflectionJsonArray(output: string): unknown[] | null {
  const starts: number[] = [];
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === "[") starts.push(index);
  }
  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "[") depth += 1;
      if (character !== "]") continue;
      depth -= 1;
      if (depth !== 0) continue;
      try {
        const parsed: unknown = JSON.parse(output.slice(start, index + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Try the next balanced array.
      }
      break;
    }
  }
  return null;
}

export function prepareReflectionFacts(
  items: readonly unknown[],
  origin: ReflectionOrigin,
  agentId: string,
  waitMs = 20_000
): PreparedReflectionFact[] {
  const allowedEntryIds = new Set(
    (origin.transcriptEntryIds ??
      (origin.transcriptEntryId ? [origin.transcriptEntryId] : []))
      .map((value) => boundedRecordId(value))
  );
  if (allowedEntryIds.size === 0) {
    throw new ReflectionFactValidationError(
      "Reflection origin must contain at least one transcript record ID"
    );
  }
  const fallbackEntryId = origin.transcriptEntryId
    ? boundedRecordId(origin.transcriptEntryId)
    : null;
  const prepared = new Map<string, PreparedReflectionFact>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ReflectionFactValidationError(
        "Every reflection result must be an object"
      );
    }
    const value = item as Record<string, unknown>;
    if (typeof value.content !== "string") {
      throw new ReflectionFactValidationError(
        "Every reflection fact must contain text content"
      );
    }
    const content = normalizeReflectionFactContent(value.content);
    if (content.length < 12) {
      throw new ReflectionFactValidationError(
        "Every reflection fact must contain durable content"
      );
    }
    const suppliedEntryId =
      typeof value.entry_id === "string"
        ? value.entry_id
        : typeof value.entryId === "string"
          ? value.entryId
          : fallbackEntryId;
    if (!suppliedEntryId) {
      throw new ReflectionFactValidationError(
        "Every reflection fact must retain a transcript record ID"
      );
    }
    const transcriptEntryId = boundedRecordId(suppliedEntryId);
    if (!allowedEntryIds.has(transcriptEntryId)) {
      throw new ReflectionFactValidationError(
        "Reflection fact referenced an unknown transcript record ID"
      );
    }
    const idempotencyKey = deriveReflectionIngestKey(
      origin.transcriptPath,
      transcriptEntryId,
      REFLECTION_PROMPT_VERSION,
      content
    );
    if (prepared.has(idempotencyKey)) continue;
    prepared.set(idempotencyKey, {
      content,
      transcriptEntryId,
      idempotencyKey,
      payload: {
        agentId,
        content,
        idempotencyKey,
        source: origin.source,
        sourceVersion: REFLECTION_PROMPT_VERSION,
        sourceType: "reflection",
        priority: 2,
        semanticTags: ["reflection"],
        requestId: correlationId(
          "reflection-record",
          `${origin.transcriptPath}\u0000${transcriptEntryId}`
        ),
        sessionId: correlationId("reflection-transcript", origin.transcriptPath),
        waitMs: Math.max(0, Math.min(20_000, Math.trunc(waitMs))),
      },
    });
  }
  return [...prepared.values()];
}

function receiptStatus(value: unknown):
  | "accepted"
  | "processing"
  | "indexed"
  | "failed"
  | "rejected"
  | null {
  return new Set(["accepted", "processing", "indexed", "failed", "rejected"]).has(
    String(value)
  )
    ? (value as "accepted" | "processing" | "indexed" | "failed" | "rejected")
    : null;
}

export async function submitReflectionFacts(
  items: readonly unknown[],
  origin: ReflectionOrigin,
  options: ReflectionSubmitOptions
): Promise<ReflectionRunSummary> {
  const summary = emptyReflectionRunSummary();
  const prepared = prepareReflectionFacts(
    items,
    origin,
    options.agentId,
    options.waitMs
  );
  summary.prepared = prepared.length;
  const writeLog = options.log ?? (() => undefined);
  if (options.dryRun) {
    writeLog(`    [dry] ${prepared.length} reflection fact(s) prepared`);
    return summary;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const fact of prepared) {
    try {
      const response = await fetchImpl(`${options.cortexUrl}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fact.payload),
      });
      const body = (await response.json()) as Record<string, unknown>;
      const status = receiptStatus(body.status);
      const eventId = typeof body.eventId === "string" ? body.eventId : null;
      if (!status || !eventId) {
        throw new Error("invalid_lifecycle_receipt");
      }
      summary.durable += 1;
      if (body.replayed === true) summary.replayed += 1;
      if (status === "indexed") {
        summary.indexed += 1;
        writeLog(`    [indexed] event ${eventId}`);
      } else if (
        status === "accepted" ||
        status === "processing" ||
        (status === "failed" &&
          typeof body.failure === "object" &&
          body.failure !== null &&
          (body.failure as { retryable?: unknown }).retryable === true)
      ) {
        summary.queued += 1;
        writeLog(`    [durably queued] event ${eventId} (${status})`);
      } else if (status === "rejected") {
        summary.rejected += 1;
        writeLog(`    [rejected] event ${eventId}`);
      } else {
        summary.failed += 1;
        writeLog(`    [failed] event ${eventId}`);
      }
    } catch {
      summary.submissionFailures += 1;
      writeLog("    [failed] durable acceptance unavailable");
    }
  }
  return summary;
}

function operationErrorCode(summary: ReflectionRunSummary): string | undefined {
  if (summary.extractionFailures > 0) return "reflection_extraction_failed";
  if (summary.submissionFailures > 0) return "reflection_acceptance_failed";
  if (summary.failed > 0 || summary.rejected > 0) {
    return "reflection_ingest_failed";
  }
  return undefined;
}

export async function runReflectionOperation(
  health: MemoryHealthService,
  agentId: number,
  run: () => Promise<ReflectionRunSummary>
): Promise<ReflectionRunSummary> {
  const handle = await health.startOperation("reflection", agentId);
  const heartbeat = setInterval(() => {
    void health.heartbeat(handle).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
    const summary = await run();
    const errorCode = operationErrorCode(summary);
    await health.finishOperation(
      handle,
      errorCode ? "failed" : "succeeded",
      {
        counters: { ...summary },
        ...(errorCode ? { errorCode } : {}),
      }
    );
    return summary;
  } catch (error) {
    await health.finishOperation(handle, "failed", {
      errorCode: "reflection_run_failed",
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function defaultLog(message: string): void {
  const line = `${new Date().toISOString()}  [reflect-cursor] ${message}`;
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Logging must not hide the durable operation outcome.
  }
  console.log(line);
}

async function callEndpoint(
  endpoint: ReflectionEndpoint,
  transcript: string,
  source: string,
  writeLog: (message: string) => void
): Promise<unknown[] | null> {
  const messages = [
    {
      role: "system",
      content: "Extract durable memory and return only one JSON array.",
    },
    {
      role: "user",
      content: `${REFLECTION_EXTRACTION_PROMPT}${transcript}\n--- TRANSCRIPT END ---\n`,
    },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 900_000);
      const url = endpoint.native
        ? `${endpoint.url.replace(/\/v1\/?$/, "")}/api/chat`
        : `${endpoint.url}/chat/completions`;
      const body = endpoint.native
        ? {
            model: endpoint.model,
            messages,
            options: {
              num_ctx: Number.parseInt(process.env.REFLECT_NUM_CTX || "65536", 10),
              temperature: 0.3,
            },
            stream: false,
          }
        : {
            model: endpoint.model,
            messages,
            max_tokens: 4_000,
            temperature: 0.3,
            stream: false,
          };
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      }).finally(() => clearTimeout(timer));
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        const nativeMessage = data.message as Record<string, unknown> | undefined;
        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        const compatibleMessage = choices?.[0]?.message as
          | Record<string, unknown>
          | undefined;
        const message = endpoint.native ? nativeMessage : compatibleMessage;
        const output = [message?.content, message?.reasoning_content, message?.reasoning]
          .filter((part): part is string => typeof part === "string")
          .join("\n");
        const parsed = parseReflectionJsonArray(output);
        if (parsed !== null) return parsed;
        writeLog(`  ! ${source}: ${endpoint.label} returned malformed extraction output`);
        return null;
      }
      if (response.status === 429 || response.status === 503) {
        const waitMs = (attempt + 1) * 5_000;
        writeLog(`  ~ ${source}: ${endpoint.label} temporarily unavailable; retrying`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
        continue;
      }
      writeLog(`  ! ${source}: ${endpoint.label} request failed (${response.status})`);
      return null;
    } catch {
      writeLog(`  ~ ${source}: ${endpoint.label} unreachable`);
      return null;
    }
  }
  return null;
}

async function extractMemories(
  transcript: string,
  source: string,
  endpoints: readonly ReflectionEndpoint[],
  writeLog: (message: string) => void
): Promise<ReflectionExtractionResult> {
  for (const endpoint of endpoints) {
    const items = await callEndpoint(endpoint, transcript, source, writeLog);
    if (items !== null) {
      if (items.length === 0) {
        writeLog(`  · ${source}: successful zero-output reflection`);
      }
      return { ok: true, items };
    }
  }
  writeLog(`  ! ${source}: every configured extraction endpoint failed`);
  return { ok: false, items: [] };
}

function cursorTranscriptValue(
  value: Record<string, unknown>,
  rawLine: string,
  lineNumber: number
): ReflectionTranscriptEntry | null {
  const message = value.message as Record<string, unknown> | undefined;
  const rawContent = message?.content;
  const content = Array.isArray(rawContent)
    ? rawContent
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : ""
        )
        .join(" ")
    : typeof rawContent === "string"
      ? rawContent
      : "";
  if (!content) return null;
  const explicitId = [value.id, value.uuid, message?.id, value.messageId]
    .find((candidate) => typeof candidate === "string" && candidate.trim());
  const id = boundedRecordId(
    typeof explicitId === "string"
      ? explicitId
      : `line:${lineNumber}:sha256:${sha256(rawLine)}`
  );
  const role = typeof value.role === "string" ? value.role : "unknown";
  return {
    id,
    text: `[entry_id=${JSON.stringify(id)}] ${role}: ${content}`,
  };
}

export function cursorTranscriptEntry(
  rawLine: string,
  lineNumber: number
): ReflectionTranscriptEntry | null {
  try {
    const value = JSON.parse(rawLine) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return cursorTranscriptValue(
      value as Record<string, unknown>,
      rawLine,
      lineNumber
    );
  } catch {
    return null;
  }
}

export function parseCursorTranscript(
  raw: string
): ParsedJsonlRecords<ReflectionTranscriptEntry> {
  return parseJsonlRecords(raw, cursorTranscriptValue);
}

async function processCursor(
  options: CursorRunOptions
): Promise<{
  summary: ReflectionRunSummary;
  completed: Record<string, string>;
  attempted: Record<string, TranscriptAttemptRecord>;
}> {
  const total = emptyReflectionRunSummary();
  const completed: Record<string, string> = {};
  const attempted: Record<string, TranscriptAttemptRecord> = {};
  if (!existsSync(CURSOR_PROJECTS)) {
    options.log("  cursor: projects dir not found");
    return { summary: total, completed, attempted };
  }
  const candidates: Array<
    VersionedTranscriptCandidate & {
      canonicalPath: string;
      raw: string;
      sessionDirectory: string;
    }
  > = [];
  const projectDirectories = await readdir(CURSOR_PROJECTS).catch(() => [] as string[]);
  for (const projectDirectory of projectDirectories) {
    const transcriptsDirectory = join(
      CURSOR_PROJECTS,
      projectDirectory,
      "agent-transcripts"
    );
    if (!existsSync(transcriptsDirectory)) continue;
    const sessionDirectories = await readdir(transcriptsDirectory).catch(
      () => [] as string[]
    );
    for (const sessionDirectory of sessionDirectories) {
      const sessionPath = join(transcriptsDirectory, sessionDirectory);
      const directoryStat = await stat(sessionPath).catch(() => null);
      if (!directoryStat?.isDirectory()) continue;
      const transcriptPath = join(sessionPath, `${sessionDirectory}.jsonl`);
      if (!existsSync(transcriptPath)) continue;
      const fileStat = await stat(transcriptPath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs < options.sinceMs) continue;
      let raw: string;
      try {
        raw = await readFile(transcriptPath, "utf8");
      } catch {
        total.transcripts += 1;
        total.extractionFailures += 1;
        options.log(
          `  ! cursor:${sessionDirectory.slice(0, 12)}: transcript_read_failed; retained for retry`
        );
        continue;
      }
      const canonicalPath = await realpath(transcriptPath).catch(() =>
        resolve(transcriptPath)
      );
      candidates.push({
        checkpointKey: transcriptCheckpointKey(canonicalPath),
        canonicalPath,
        version: reflectionTranscriptVersion(raw),
        orderMs: fileStat.mtimeMs,
        raw,
        sessionDirectory,
      });
    }
  }

  const pending = selectPendingTranscriptVersions(
    candidates,
    options.checkpoints,
    options.limit,
    options.attempts
  );
  const maxChars = reflectionWindowLimit(options.endpoints);
  for (const candidate of pending) {
    attempted[candidate.checkpointKey] = {
      version: candidate.version,
      attemptedAtMs: Date.now(),
    };
    total.transcripts += 1;
    const source = `cursor:${candidate.sessionDirectory.slice(0, 12)}`;
    const parsed = parseCursorTranscript(candidate.raw);
    if (parsed.malformedRecords > 0) {
      total.extractionFailures += 1;
      options.log(
        `  ! ${source}: malformed_jsonl (${parsed.malformedRecords} record(s)); retained for retry`
      );
      continue;
    }
    const entries = parsed.records;
    const transcript = entries.map((entry) => entry.text).join("\n\n");
    if (transcript.length < MIN_CHARS) {
      options.log(`  · ${source}: too short`);
      completed[candidate.checkpointKey] = candidate.version;
      continue;
    }

    const windows = buildReflectionWindows(entries, maxChars);
    let transcriptFailed = false;
    for (const [windowIndex, window] of windows.entries()) {
      const windowSource = `${source}:window-${windowIndex + 1}-of-${windows.length}`;
      const extraction = await extractMemories(
        window.transcript,
        windowSource,
        options.endpoints,
        options.log
      );
      if (!extraction.ok) {
        total.extractionFailures += 1;
        transcriptFailed = true;
        break;
      }
      try {
        const submitted = await submitReflectionFacts(
          extraction.items,
          {
            source,
            transcriptPath: candidate.canonicalPath,
            transcriptEntryIds: window.entryIds,
          },
          {
            agentId: options.agentId,
            cortexUrl: options.cortexUrl,
            dryRun: options.dryRun,
            log: options.log,
          }
        );
        mergeReflectionRunSummary(total, submitted);
        options.log(
          `  + ${windowSource}: ${submitted.indexed} indexed, ${submitted.queued} queued, ${submitted.failed + submitted.rejected + submitted.submissionFailures} failed`
        );
        if (!options.dryRun && reflectionRunFailed(submitted)) {
          transcriptFailed = true;
          break;
        }
      } catch (error) {
        total.extractionFailures += 1;
        transcriptFailed = true;
        options.log(
          `  ! ${windowSource}: ${error instanceof ReflectionFactValidationError ? error.code : "reflection_fact_invalid"}`
        );
        break;
      }
    }
    if (!transcriptFailed) {
      completed[candidate.checkpointKey] = candidate.version;
    }
  }
  return { summary: total, completed, attempted };
}

export function normalizeTranscriptAttempts(
  value: unknown
): Record<string, TranscriptAttemptRecord> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reflection_state_invalid");
  }
  const attempts: Record<string, TranscriptAttemptRecord> = {};
  for (const [key, attempt] of Object.entries(value)) {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
      throw new Error("reflection_state_invalid");
    }
    const record = attempt as { version?: unknown; attemptedAtMs?: unknown };
    if (
      typeof record.version !== "string" ||
      !record.version ||
      typeof record.attemptedAtMs !== "number" ||
      !Number.isFinite(record.attemptedAtMs) ||
      record.attemptedAtMs < 0
    ) {
      throw new Error("reflection_state_invalid");
    }
    attempts[key] = {
      version: record.version,
      attemptedAtMs: record.attemptedAtMs,
    };
  }
  return attempts;
}

export function normalizeCursorState(value: unknown): CursorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reflection_state_invalid");
  }
  const candidate = value as {
    checkpointVersion?: unknown;
    lastRunMs?: unknown;
    scanBaselineMs?: unknown;
    transcripts?: unknown;
    attempts?: unknown;
  };
  const hasOwn = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(candidate, field);
  const hasTranscripts = hasOwn("transcripts");
  const transcripts: Record<string, string> = {};
  if (hasTranscripts) {
    if (
      !candidate.transcripts ||
      typeof candidate.transcripts !== "object" ||
      Array.isArray(candidate.transcripts)
    ) {
      throw new Error("reflection_state_invalid");
    }
    for (const [key, version] of Object.entries(candidate.transcripts)) {
      if (typeof version !== "string" || !version) {
        throw new Error("reflection_state_invalid");
      }
      transcripts[key] = version;
    }
  }
  const checkpointVersion = !hasOwn("checkpointVersion")
    ? 1
    : candidate.checkpointVersion === 1 || candidate.checkpointVersion === 2
      ? candidate.checkpointVersion
      : null;
  const lastRunMs =
    hasOwn("lastRunMs") &&
      typeof candidate.lastRunMs === "number" &&
      Number.isFinite(candidate.lastRunMs) &&
      candidate.lastRunMs >= 0
      ? candidate.lastRunMs
      : null;
  if (checkpointVersion === null || lastRunMs === null) {
    throw new Error("reflection_state_invalid");
  }
  let scanBaselineMs: number | undefined;
  if (checkpointVersion === 2) {
    if (
      !hasTranscripts ||
      typeof candidate.scanBaselineMs !== "number" ||
      !Number.isFinite(candidate.scanBaselineMs) ||
      candidate.scanBaselineMs < 0
    ) {
      throw new Error("reflection_state_invalid");
    }
    scanBaselineMs = candidate.scanBaselineMs;
  } else if (candidate.scanBaselineMs !== undefined) {
    throw new Error("reflection_state_invalid");
  }
  return {
    checkpointVersion,
    lastRunMs,
    ...(scanBaselineMs !== undefined ? { scanBaselineMs } : {}),
    transcripts,
    attempts: normalizeTranscriptAttempts(candidate.attempts),
  };
}

function loadState(): CursorState {
  if (!existsSync(STATE_FILE)) {
    return {
      checkpointVersion: 2,
      lastRunMs: 0,
      transcripts: {},
      attempts: {},
    };
  }
  try {
    return normalizeCursorState(JSON.parse(readFileSync(STATE_FILE, "utf8")));
  } catch {
    throw new Error("reflection_state_invalid");
  }
}

function saveState(state: CursorState): void {
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

async function resolveRuntimeAgentId(externalId: string): Promise<number> {
  const { sqlClient } = await import("../src/db/index.js");
  const rows = await sqlClient`
    SELECT id
    FROM public.agents
    WHERE external_id = ${externalId}
    LIMIT 1
  `;
  if (rows.length !== 1) throw new Error("reflection_agent_not_found");
  return Number(rows[0].id);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  mkdirSync(CORTEX_DIR, { recursive: true });
  setGlobalDispatcher(
    new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 })
  );
  const dryRun = argv.includes("--dry-run");
  const limit = Number.parseInt(argumentValue(argv, "--limit", "40"), 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("invalid_reflection_limit");
  }
  const sinceHours = argumentValue(argv, "--since-hours", "");
  const startMs = Date.now();
  const state = loadState();
  const parsedSinceHours = sinceHours ? Number.parseInt(sinceHours, 10) : null;
  if (parsedSinceHours !== null && (!Number.isInteger(parsedSinceHours) || parsedSinceHours < 0)) {
    throw new Error("invalid_reflection_since_hours");
  }
  const explicitSinceMs = parsedSinceHours !== null
    ? startMs - parsedSinceHours * 3_600_000
    : undefined;
  const sinceMs = resolveTranscriptScanBaseline(
    state,
    startMs,
    explicitSinceMs
  );
  const agentId = process.env.CORTEX_AGENT_ID || "arlo";
  const cortexUrl = process.env.CORTEX_REST_URL || "http://127.0.0.1:3100";
  const endpoints = buildReflectionEndpoints();
  defaultLog(
    `reflect start -- since=${new Date(sinceMs).toISOString()} dry=${dryRun} limit=${limit} model=${endpoints[0].model}`
  );

  let closeDatabase: () => Promise<void> = async () => undefined;
  let completed: Record<string, string> = {};
  let attempted: Record<string, TranscriptAttemptRecord> = {};
  try {
    const run = async () => {
      const result = await processCursor({
        limit,
        sinceMs,
        agentId,
        cortexUrl,
        endpoints,
        checkpoints: state.transcripts,
        attempts: state.attempts,
        dryRun,
        log: defaultLog,
      });
      completed = result.completed;
      attempted = result.attempted;
      return result.summary;
    };
    const summary = dryRun
      ? await run()
      : await (async () => {
          const databaseModule = await import("../src/db/index.js");
          const memoryModule = await import("../src/memory/index.js");
          await databaseModule.initDatabase();
          closeDatabase = databaseModule.closeDatabaseConnection;
          const numericAgentId = await resolveRuntimeAgentId(agentId);
          return runReflectionOperation(
            memoryModule.createMemoryServices().health,
            numericAgentId,
            run
          );
        })();

    if (!dryRun) {
      saveState({
        checkpointVersion: 2,
        // Retain the legacy field for older readers, but v2 uses the exact
        // scan baseline plus content-version checkpoints.
        lastRunMs: sinceMs,
        scanBaselineMs: sinceMs,
        transcripts: applyCompletedTranscriptCheckpoints(
          state.transcripts,
          completed
        ),
        attempts: applyTranscriptAttempts(
          state.attempts,
          attempted,
          completed
        ),
      });
    }
    defaultLog(
      `reflect done -- ${summary.indexed} indexed, ${summary.queued} durably queued, ${summary.failed + summary.rejected + summary.submissionFailures} failed, ${summary.extractionFailures} extraction failures${reflectionRunFailed(summary) ? "; failed transcripts retained for retry" : ""}`
    );
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    defaultLog(`FATAL: ${(error as Error)?.message || "reflection_run_failed"}`);
    process.exitCode = 1;
  });
}
