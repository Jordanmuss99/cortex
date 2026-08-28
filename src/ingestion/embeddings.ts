/**
 * CORTEX V2 — Embedding Engine
 *
 * Supports two providers:
 *   - "ollama" (default): Local inference via mxbai-embed-large (1024-dim)
 *   - "voyage": VoyageAI API (voyage-3, 1024-dim)
 *
 * Configure via env:
 *   EMBEDDING_PROVIDER=ollama|voyage (default: ollama)
 *   EMBEDDING_MODEL=mxbai-embed-large|voyage-3 (auto-set per provider)
 *   OLLAMA_URL=http://localhost:11434
 *   VOYAGE_API_KEY=pa-...
 */
import "dotenv/config";
import type { EmbeddedBatch, EmbeddedVector } from "../memory/types.js";

export type EmbeddingFailureCode =
  | "embedding_provider_unavailable"
  | "embedding_provider_rejected"
  | "embedding_result_invalid"
  | "embedding_batch_mismatch"
  | "embedding_dimension_invalid"
  | "embedding_non_finite"
  | "embedding_zero_norm"
  | "embedding_not_normalized";

export class EmbeddingResultError extends Error {
  constructor(readonly code: Exclude<EmbeddingFailureCode, "embedding_provider_unavailable" | "embedding_provider_rejected">) {
    super("Embedding provider returned invalid data");
    this.name = "EmbeddingResultError";
  }
}

export class EmbeddingProviderError extends Error {
  constructor(
    readonly code:
      | "embedding_provider_unavailable"
      | "embedding_provider_rejected",
    readonly retryableWithinAttempt: boolean,
    readonly status?: number
  ) {
    super(
      code === "embedding_provider_unavailable"
        ? "Embedding provider unavailable"
        : "Embedding provider rejected the request"
    );
    this.name = "EmbeddingProviderError";
  }
}

function configuredProvider(value: string | undefined): "ollama" | "voyage" {
  const provider = value ?? "ollama";
  if (provider !== "ollama" && provider !== "voyage") {
    throw new Error("EMBEDDING_PROVIDER must be either ollama or voyage");
  }
  return provider;
}

function configuredModel(value: string | undefined, provider: string): string {
  const model = value ?? (provider === "voyage" ? "voyage-3" : "mxbai-embed-large");
  if (
    model !== model.trim() ||
    model.length < 1 ||
    model.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(model)
  ) {
    throw new Error("EMBEDDING_MODEL must be 1 to 128 printable characters");
  }
  return model;
}

function configuredTimeout(value: string | undefined): number {
  if (value === undefined) return 20_000;
  if (!/^\d+$/.test(value)) {
    throw new Error("EMBEDDING_TIMEOUT_MS must be an integer from 1000 to 120000");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("EMBEDDING_TIMEOUT_MS must be an integer from 1000 to 120000");
  }
  return parsed;
}

const EMBEDDING_PROVIDER = configuredProvider(process.env.EMBEDDING_PROVIDER);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "";
const EMBEDDING_MODEL = configuredModel(
  process.env.EMBEDDING_MODEL,
  EMBEDDING_PROVIDER
);
const EMBEDDING_DIM = 1024;
const BATCH_SIZE = 32;
const EMBEDDING_TIMEOUT_MS = configuredTimeout(process.env.EMBEDDING_TIMEOUT_MS);

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry a fetch-bound async call with exponential backoff. Voyage's
 * TLS connections occasionally drop mid-session on long ingest runs
 * (UND_ERR_SOCKET "other side closed"). A single retry with jitter is
 * enough to survive it; three attempts gives us headroom for the
 * rare API 5xx as well.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const safeError =
        err instanceof EmbeddingProviderError || err instanceof EmbeddingResultError
          ? err
          : new EmbeddingProviderError(
              "embedding_provider_unavailable",
              true
            );
      lastErr = safeError;
      const isLast = i === attempts - 1;
      if (
        isLast ||
        safeError instanceof EmbeddingResultError ||
        !safeError.retryableWithinAttempt
      ) {
        break;
      }
      const backoffMs = 500 * Math.pow(2, i) + Math.floor(Math.random() * 250);
      console.error("[embeddings] Provider request retry scheduled", {
        operation: label,
        provider: EMBEDDING_PROVIDER,
        attempt: i + 1,
        attempts,
        retryInMs: backoffMs,
        code: safeError.code,
        status: safeError.status,
      });
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

async function safeFetch(
  input: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new EmbeddingProviderError(
      "embedding_provider_unavailable",
      true
    );
  }
}

function httpError(response: Response): EmbeddingProviderError {
  const transient =
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500;
  return new EmbeddingProviderError(
    transient
      ? "embedding_provider_unavailable"
      : "embedding_provider_rejected",
    transient,
    response.status
  );
}

async function discardErrorResponse(response: Response): Promise<never> {
  await response.body?.cancel().catch(() => {});
  throw httpError(response);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new EmbeddingResultError("embedding_result_invalid");
  }
}

function rawEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new EmbeddingResultError("embedding_result_invalid");
  }
  return value as number[];
}

// ─── Ollama Provider ────────────────────────────────────

async function ollamaEmbed(text: string): Promise<number[]> {
  const response = await safeFetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });

  if (!response.ok) {
    await discardErrorResponse(response);
  }

  const data = await safeJson(response);
  if (!data || typeof data !== "object" || !("embedding" in data)) {
    throw new EmbeddingResultError("embedding_result_invalid");
  }
  return rawEmbedding((data as { embedding: unknown }).embedding);
}

// ─── Voyage Provider ────────────────────────────────────

async function voyageEmbedBatch(texts: string[]): Promise<number[][]> {
  if (!VOYAGE_API_KEY) {
    throw new EmbeddingProviderError("embedding_provider_rejected", false);
  }

  return withRetry("voyage batch", async () => {
    const response = await safeFetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
        input_type: "document",
      }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });

    if (!response.ok) {
      await discardErrorResponse(response);
    }

    const payload = await safeJson(response);
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray((payload as { data?: unknown }).data)
    ) {
      throw new EmbeddingResultError("embedding_result_invalid");
    }
    const data = (payload as { data: unknown[] }).data;
    if (data.length !== texts.length) {
      throw new EmbeddingResultError("embedding_batch_mismatch");
    }
    return data.map((item) => {
      if (!item || typeof item !== "object" || !("embedding" in item)) {
        throw new EmbeddingResultError("embedding_result_invalid");
      }
      return rawEmbedding((item as { embedding: unknown }).embedding);
    });
  });
}

async function voyageEmbedQuery(text: string): Promise<number[]> {
  if (!VOYAGE_API_KEY) {
    throw new EmbeddingProviderError("embedding_provider_rejected", false);
  }

  return withRetry("voyage query", async () => {
    const response = await safeFetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: [text],
        input_type: "query",
      }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });

    if (!response.ok) {
      await discardErrorResponse(response);
    }

    const payload = await safeJson(response);
    const data =
      payload && typeof payload === "object"
        ? (payload as { data?: unknown }).data
        : null;
    if (!Array.isArray(data) || data.length !== 1) {
      throw new EmbeddingResultError("embedding_result_invalid");
    }
    const item = data[0];
    if (!item || typeof item !== "object" || !("embedding" in item)) {
      throw new EmbeddingResultError("embedding_result_invalid");
    }
    return rawEmbedding((item as { embedding: unknown }).embedding);
  });
}

// ─── Unified Interface ──────────────────────────────────

/**
 * Generate embeddings for multiple texts.
 * Routes to Ollama or Voyage based on EMBEDDING_PROVIDER env.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (EMBEDDING_PROVIDER === "voyage") {
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await voyageEmbedBatch(batch);
      allEmbeddings.push(...embeddings);
      console.error(
        `[embeddings] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} — ${batch.length} texts (voyage)`
      );
      if (i + BATCH_SIZE < texts.length) await sleep(100);
    }
    return allEmbeddings;
  }

  // Default: Ollama
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await Promise.all(batch.map((t) => ollamaEmbed(t)));
    allEmbeddings.push(...embeddings);
    console.error(
      `[embeddings] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} — ${batch.length} texts (ollama)`
    );
    if (i + BATCH_SIZE < texts.length) await sleep(200);
  }
  return allEmbeddings;
}

/**
 * Embed a single query text.
 * Uses input_type="query" for Voyage (optimized for search retrieval).
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (EMBEDDING_PROVIDER === "voyage") {
    return voyageEmbedQuery(text);
  }
  return ollamaEmbed(text);
}

function validIdentity(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function vectorNorm(values: readonly number[]): number {
  let squaredMagnitude = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (
      !Object.hasOwn(values, index) ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      return Number.NaN;
    }
    squaredMagnitude += value * value;
  }
  return Math.sqrt(squaredMagnitude);
}

function hasOnlyFiniteDenseValues(values: readonly number[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (
      !Object.hasOwn(values, index) ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      return false;
    }
  }
  return true;
}

export function validateEmbeddedVector(
  candidate: EmbeddedVector,
  expectedProvider?: string,
  expectedModel?: string
): EmbeddedVector {
  if (!validIdentity(candidate?.provider, 64) || !validIdentity(candidate?.model, 128)) {
    throw new EmbeddingResultError("embedding_result_invalid");
  }
  if (
    (expectedProvider !== undefined && candidate.provider !== expectedProvider) ||
    (expectedModel !== undefined && candidate.model !== expectedModel)
  ) {
    throw new EmbeddingResultError("embedding_result_invalid");
  }
  if (
    candidate.dimensions !== EMBEDDING_DIM ||
    !Array.isArray(candidate.values) ||
    candidate.values.length !== EMBEDDING_DIM
  ) {
    throw new EmbeddingResultError("embedding_dimension_invalid");
  }
  if (!hasOnlyFiniteDenseValues(candidate.values)) {
    throw new EmbeddingResultError("embedding_non_finite");
  }
  const norm = vectorNorm(candidate.values);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingResultError("embedding_zero_norm");
  }
  if (candidate.normalized !== true || Math.abs(norm - 1) > 1e-4) {
    throw new EmbeddingResultError("embedding_not_normalized");
  }
  return candidate;
}

export function validateEmbeddedBatch(
  candidate: EmbeddedBatch,
  expectedCount: number
): EmbeddedBatch {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    !candidate ||
    typeof candidate !== "object" ||
    !validIdentity(candidate.provider, 64) ||
    !validIdentity(candidate.model, 128) ||
    !Array.isArray(candidate.vectors)
  ) {
    throw new EmbeddingResultError("embedding_result_invalid");
  }
  if (candidate.vectors.length !== expectedCount) {
    throw new EmbeddingResultError("embedding_batch_mismatch");
  }
  for (const item of candidate.vectors) {
    validateEmbeddedVector(item, candidate.provider, candidate.model);
  }
  return candidate;
}

function normalizedVector(values: number[]): EmbeddedVector {
  if (values.length !== EMBEDDING_DIM) {
    throw new EmbeddingResultError("embedding_dimension_invalid");
  }
  if (!hasOnlyFiniteDenseValues(values)) {
    throw new EmbeddingResultError("embedding_non_finite");
  }

  const norm = vectorNorm(values);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingResultError("embedding_zero_norm");
  }

  return validateEmbeddedVector({
    values: values.map((value) => value / norm),
    provider: EMBEDDING_PROVIDER,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIM,
    normalized: true,
  });
}

export async function embedTextsWithMetadata(
  texts: readonly string[]
): Promise<EmbeddedBatch> {
  const vectors = (await embedTexts([...texts])).map(normalizedVector);
  return validateEmbeddedBatch({
    vectors,
    provider: EMBEDDING_PROVIDER,
    model: EMBEDDING_MODEL,
  }, texts.length);
}

export async function embedQueryWithMetadata(
  query: string
): Promise<EmbeddedVector> {
  return normalizedVector(await embedQuery(query));
}

export { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_PROVIDER };
