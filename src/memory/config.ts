import type { MemoryConfig } from "./types.js";

const PROJECTION_VERSION = "memory-projection-v1";
const RETRIEVAL_VERSION = "memory-retrieval-v1";

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const rawValue = env[name];
  if (rawValue === undefined) return defaultValue;

  const value = rawValue.trim();
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function readBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean
): boolean {
  const rawValue = env[name];
  if (rawValue === undefined) return defaultValue;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

function readBuildId(env: NodeJS.ProcessEnv): string {
  const buildId = env.CORTEX_BUILD_ID?.trim();
  if (!buildId) {
    if (env.CORTEX_HEADLESS === "true") {
      throw new Error("CORTEX_BUILD_ID is required in headless mode");
    }
    return "dev";
  }

  if (
    Buffer.byteLength(buildId, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/.test(buildId)
  ) {
    throw new Error("CORTEX_BUILD_ID must be 1 to 128 printable UTF-8 bytes");
  }

  return buildId;
}

export function loadMemoryConfig(
  env: NodeJS.ProcessEnv = process.env
): MemoryConfig {
  return Object.freeze({
    buildId: readBuildId(env),
    projectionVersion: PROJECTION_VERSION,
    retrievalVersion: RETRIEVAL_VERSION,
    ingestWorkerConcurrency: readInteger(
      env,
      "CORTEX_INGEST_WORKER_CONCURRENCY",
      4,
      1,
      32
    ),
    ingestMaxAttempts: readInteger(
      env,
      "CORTEX_INGEST_MAX_ATTEMPTS",
      5,
      1,
      20
    ),
    embeddingTimeoutMs: readInteger(
      env,
      "EMBEDDING_TIMEOUT_MS",
      20_000,
      1_000,
      120_000
    ),
    retrievalCandidateLimit: readInteger(
      env,
      "CORTEX_RETRIEVAL_CANDIDATE_LIMIT",
      100,
      50,
      500
    ),
    retrievalTelemetryRetentionDays: readInteger(
      env,
      "CORTEX_RETRIEVAL_EVENT_RETENTION_DAYS",
      30,
      7,
      365
    ),
    synthesisEnabled: readBoolean(
      env,
      "CORTEX_SYNTHESIS_ENABLED",
      false
    ),
    // CA3 stays off in ordinary runtime configuration. The private evaluation
    // runner may inject a recorded experimental config in its later slice.
    ca3Enabled: false,
  });
}
