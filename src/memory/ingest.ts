import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { Sql, TransactionSql } from "postgres";
import type {
  AcceptIngestInput,
  IngestReceipt,
  IngestService,
  IngestStatus,
  MemoryServiceDependencies,
  ProjectionMode,
} from "./types.js";
import {
  IdempotencyConflictError,
  IngestValidationError,
} from "./types.js";

const OMITTED = "__cortex_omitted__";
const MAX_SOURCE_BYTES = 1_024;
const MAX_SOURCE_VERSION_BYTES = 1_024;
const VALID_PROJECTION_MODES = new Set<ProjectionMode>([
  "append",
  "replace_source",
  "reconsolidate",
]);

interface EffectivePriorityInput {
  sourceType: string;
  requestedPriority: 0 | 1 | 2 | 3 | 4;
  allowHighPriority: boolean;
}

export function effectivePriorityFor(input: EffectivePriorityInput): number {
  const policySourceType = input.sourceType.toLocaleLowerCase("en-US");
  if (policySourceType === "observation") {
    return Math.max(input.requestedPriority, 3);
  }
  if (
    !input.allowHighPriority &&
    new Set(["api", "reflection", "session"]).has(policySourceType)
  ) {
    return Math.max(input.requestedPriority, 2);
  }
  return input.requestedPriority;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFC").trim();
}

export function normalizeReflectionFactContent(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function adapterKey(namespace: string, components: readonly string[]): string {
  return `${namespace}:v1:${sha256(JSON.stringify(components))}`;
}

/** Stable across gateway restarts; exact response changes remain distinct. */
export function deriveGatewayCaptureKey(
  sessionId: string,
  turnId: string,
  content: string
): string {
  return adapterKey("gateway", [
    "gateway-capture-v1",
    normalizedIdentity(sessionId),
    normalizedIdentity(turnId),
    sha256(content),
  ]);
}

/** Model result order is deliberately absent from reflection identity. */
export function deriveReflectionIngestKey(
  canonicalTranscriptPath: string,
  transcriptEntryId: string,
  promptVersion: string,
  factContent: string
): string {
  const normalizedContent = normalizeReflectionFactContent(factContent);
  return adapterKey("reflection", [
    "reflection-ingest-v1",
    normalizedIdentity(canonicalTranscriptPath),
    normalizedIdentity(transcriptEntryId),
    normalizedIdentity(promptVersion),
    sha256(normalizedContent),
  ]);
}

export function deriveObservationIngestKey(
  capturedAt: string,
  activeApp: string,
  windowTitle: string,
  content: string
): string {
  const parsed = new Date(capturedAt);
  if (!Number.isFinite(parsed.getTime())) {
    throw new IngestValidationError(
      "invalid_time",
      "capturedAt must be an ISO-8601 instant"
    );
  }
  return adapterKey("observation", [
    "screen-observation-v1",
    parsed.toISOString(),
    normalizedIdentity(activeApp),
    normalizedIdentity(windowTitle),
    sha256(content),
  ]);
}

/** Pending projections are internal checkpoints, not indexed legacy records. */
export function indexedProjectionFields(receipt: IngestReceipt): {
  nodeIds: number[];
  effectivePriorities: number[];
  chunksStored: number;
  chunksCreated: number;
  synapsesFormed: number;
} {
  if (receipt.status !== "indexed") {
    return {
      nodeIds: [],
      effectivePriorities: [],
      chunksStored: 0,
      chunksCreated: 0,
      synapsesFormed: 0,
    };
  }
  return {
    nodeIds: [...receipt.nodeIds],
    effectivePriorities: [...receipt.effectivePriorities],
    chunksStored: receipt.chunksStored,
    chunksCreated: receipt.chunksCreated,
    synapsesFormed: receipt.synapsesFormed,
  };
}

function normalizeArray(values: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeOptionalInstant(
  value: string | null | undefined,
  field: string
): string | typeof OMITTED {
  if (value == null) return OMITTED;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new IngestValidationError("invalid_time", `${field} must be an ISO-8601 instant`);
  }
  return parsed.toISOString();
}

function canonicalRequest(input: AcceptIngestInput): string {
  const derived = input.derivedProvenance
    ? {
        relation: input.derivedProvenance.relation,
        sourceMemoryIds: [...input.derivedProvenance.sourceMemoryIds].sort(
          (left, right) => left - right
        ),
        confidence: input.derivedProvenance.confidence,
        expiresAt: normalizeOptionalInstant(
          input.derivedProvenance.expiresAt,
          "derivedProvenance.expiresAt"
        ),
      }
    : null;

  return JSON.stringify({
    agentId: input.agentId,
    content: input.content,
    source: input.source ?? null,
    sourceVersion: input.sourceVersion ?? null,
    sourceType: input.sourceType,
    observedAt: normalizeOptionalInstant(input.observedAt, "observedAt"),
    validFrom: normalizeOptionalInstant(input.validFrom, "validFrom"),
    validUntil: normalizeOptionalInstant(input.validUntil, "validUntil"),
    requestedPriority: input.requestedPriority,
    providedEntities: normalizeArray(input.providedEntities),
    providedSemanticTags: normalizeArray(input.providedSemanticTags),
    requestId: input.requestId ?? null,
    sessionId: input.sessionId ?? null,
    projectionMode: input.projectionMode ?? "append",
    predecessorMemoryId: input.predecessorMemoryId ?? null,
    forceNewProjection: input.forceNewProjection ?? false,
    externalProvenance: input.externalProvenance ?? null,
    derivedProvenance: derived,
  });
}

function validateInput(input: AcceptIngestInput): void {
  if (!Number.isSafeInteger(input.agentId) || input.agentId <= 0) {
    throw new IngestValidationError("invalid_agent", "agentId must be a positive integer");
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new IngestValidationError("invalid_content", "content must not be blank");
  }
  if (
    typeof input.sourceType !== "string" ||
    input.sourceType.trim().length === 0 ||
    input.sourceType !== input.sourceType.trim() ||
    input.sourceType.length > 64
  ) {
    throw new IngestValidationError("invalid_source_type", "sourceType must be 1 to 64 characters");
  }
  if (
    !Number.isInteger(input.requestedPriority) ||
    input.requestedPriority < 0 ||
    input.requestedPriority > 4
  ) {
    throw new IngestValidationError("invalid_priority", "priority must be an integer from 0 to 4");
  }
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey !== input.idempotencyKey.trim() ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 256)
  ) {
    throw new IngestValidationError(
      "invalid_idempotency_key",
      "idempotencyKey must be 1 to 256 trimmed characters"
    );
  }
  if (
    input.projectionMode !== undefined &&
    !VALID_PROJECTION_MODES.has(input.projectionMode)
  ) {
    throw new IngestValidationError("invalid_projection_mode", "projectionMode is invalid");
  }
  const projectionMode = input.projectionMode ?? "append";
  if (projectionMode === "reconsolidate") {
    throw new IngestValidationError(
      "projection_mode_unavailable",
      `${projectionMode} is not available in this release slice`
    );
  }
  if (projectionMode === "replace_source") {
    if (
      typeof input.source !== "string" ||
      input.source !== input.source.trim() ||
      input.source.length === 0
    ) {
      throw new IngestValidationError(
        "replace_source_requires_source",
        "replace_source requires a nonblank trimmed source"
      );
    }
    if (Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES) {
      throw new IngestValidationError(
        "replace_source_source_too_long",
        `replace_source source must be at most ${MAX_SOURCE_BYTES} UTF-8 bytes`
      );
    }
    if (
      typeof input.sourceVersion !== "string" ||
      input.sourceVersion !== input.sourceVersion.trim() ||
      input.sourceVersion.length === 0
    ) {
      throw new IngestValidationError(
        "replace_source_requires_source_version",
        "replace_source requires a nonblank trimmed sourceVersion"
      );
    }
    if (
      Buffer.byteLength(input.sourceVersion, "utf8") >
      MAX_SOURCE_VERSION_BYTES
    ) {
      throw new IngestValidationError(
        "replace_source_source_version_too_long",
        `replace_source sourceVersion must be at most ${MAX_SOURCE_VERSION_BYTES} UTF-8 bytes`
      );
    }
  }
  if (input.externalProvenance || input.derivedProvenance) {
    throw new IngestValidationError(
      "internal_provenance_unavailable",
      "Internal provenance is not available in this release slice"
    );
  }
  if (
    input.predecessorMemoryId !== undefined &&
    input.predecessorMemoryId !== null &&
    (!Number.isSafeInteger(input.predecessorMemoryId) ||
      input.predecessorMemoryId <= 0)
  ) {
    throw new IngestValidationError(
      "invalid_predecessor_memory_id",
      "predecessorMemoryId must be a positive integer"
    );
  }
  if (
    input.forceNewProjection !== undefined &&
    typeof input.forceNewProjection !== "boolean"
  ) {
    throw new IngestValidationError(
      "invalid_forceNewProjection",
      "forceNewProjection must be a boolean"
    );
  }
  for (const [field, value] of [
    ["requestId", input.requestId],
    ["sessionId", input.sessionId],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || value.length > 128)
    ) {
      throw new IngestValidationError(
        `invalid_${field}`,
        `${field} must be a string of at most 128 characters`
      );
    }
  }

  const validFrom = normalizeOptionalInstant(input.validFrom, "validFrom");
  const validUntil = normalizeOptionalInstant(input.validUntil, "validUntil");
  normalizeOptionalInstant(input.observedAt, "observedAt");
  if (
    validFrom !== OMITTED &&
    validUntil !== OMITTED &&
    new Date(validUntil).getTime() <= new Date(validFrom).getTime()
  ) {
    throw new IngestValidationError(
      "invalid_validity_interval",
      "validUntil must be later than validFrom"
    );
  }
}

interface IngestReceiptRow {
  id: string;
  status: IngestStatus;
  total_attempts: number;
  cycle_attempts: number;
  manual_retry_count: number;
  possible_update_ids: number[] | null;
  projection_count: number;
  created_projection_count: number;
  synapse_count: number;
  accepted_at: string | Date;
  started_at: string | Date | null;
  indexed_at: string | Date | null;
  next_attempt_at: string | Date | null;
  failure_code: string | null;
  warning_codes: string[] | null;
  node_ids: number[] | null;
  effective_priorities: number[] | null;
}

function instant(value: string | Date): string {
  return new Date(value).toISOString();
}

function receiptFromRow(
  row: IngestReceiptRow,
  replayed: boolean,
  maxAttempts: number
): IngestReceipt {
  const receipt: IngestReceipt = {
    eventId: row.id,
    status: row.status,
    replayed,
    nodeIds: (row.node_ids ?? []).map(Number),
    effectivePriorities: (row.effective_priorities ?? []).map(Number),
    chunksStored: Number(row.projection_count ?? 0),
    chunksCreated: Number(row.created_projection_count ?? 0),
    synapsesFormed: Number(row.synapse_count ?? 0),
    totalAttempts: Number(row.total_attempts ?? 0),
    manualRetryCount: Number(row.manual_retry_count ?? 0),
    possibleUpdateOf: (row.possible_update_ids ?? []).map(Number),
    acceptedAt: instant(row.accepted_at),
    warnings: row.warning_codes ?? [],
  };
  if (row.started_at) receipt.startedAt = instant(row.started_at);
  if (row.indexed_at) receipt.indexedAt = instant(row.indexed_at);
  if (row.next_attempt_at) receipt.nextAttemptAt = instant(row.next_attempt_at);
  if (row.failure_code) {
    receipt.failure = {
      code: row.failure_code,
      retryable:
        row.status === "failed" &&
        row.next_attempt_at !== null &&
        Number(row.cycle_attempts) < maxAttempts,
    };
  }
  return receipt;
}

function acceptedReceipt(
  eventId: string,
  replayed: boolean,
  acceptedAt: string | Date
): IngestReceipt {
  return {
    eventId,
    status: "accepted",
    replayed,
    nodeIds: [],
    effectivePriorities: [],
    chunksStored: 0,
    chunksCreated: 0,
    synapsesFormed: 0,
    totalAttempts: 0,
    manualRetryCount: 0,
    possibleUpdateOf: [],
    acceptedAt: instant(acceptedAt),
    warnings: [],
  };
}

async function loadReceipt(
  sql: Sql | TransactionSql,
  agentId: number,
  eventId: string,
  replayed: boolean,
  maxAttempts: number
): Promise<IngestReceipt | null> {
  const rows = (await sql`
    SELECT
      event.id,
      event.status,
      event.total_attempts,
      event.cycle_attempts,
      event.manual_retry_count,
      event.possible_update_ids,
      event.projection_count,
      pg_catalog.count(DISTINCT node.id) FILTER (
        WHERE node.ingest_event_id = event.id
      )::integer AS created_projection_count,
      event.synapse_count,
      event.accepted_at,
      event.started_at,
      event.indexed_at,
      event.next_attempt_at,
      event.failure_code,
      event.warning_codes,
      COALESCE(
        ARRAY_AGG(node.id ORDER BY node.id)
          FILTER (WHERE node.id IS NOT NULL),
        '{}'::integer[]
      ) AS node_ids,
      COALESCE(
        ARRAY_AGG(node.priority ORDER BY node.id)
          FILTER (WHERE node.id IS NOT NULL),
        '{}'::integer[]
      ) AS effective_priorities
    FROM public.memory_ingest_events AS event
    LEFT JOIN public.memory_provenance AS provenance
      ON provenance.ingest_event_id = event.id
     AND provenance.agent_id = event.agent_id
     AND provenance.relation = 'captured_from'
    LEFT JOIN public.memory_nodes AS node
      ON node.id = provenance.memory_id
     AND node.agent_id = provenance.agent_id
    WHERE event.agent_id = ${agentId}
      AND event.id = ${eventId}::uuid
    GROUP BY event.id
  `) as unknown as IngestReceiptRow[];
  return rows[0] ? receiptFromRow(rows[0], replayed, maxAttempts) : null;
}

export function createIngestService(
  deps: MemoryServiceDependencies
): IngestService {
  const deriveLegacyKey = (
    input: Omit<AcceptIngestInput, "idempotencyKey">
  ): string => `legacy:${sha256(canonicalRequest(input))}`;

  return Object.freeze({
    deriveLegacyKey,

    async accept(input: AcceptIngestInput): Promise<IngestReceipt> {
      validateInput(input);
      const canonical = canonicalRequest(input);
      const requestHash = sha256(canonical);
      const idempotencyKey = input.idempotencyKey ?? deriveLegacyKey(input);
      const eventId = deps.newId();
      const acceptedAt = deps.now();
      const acceptedAtIso = acceptedAt.toISOString();
      const observedAt =
        input.observedAt == null
          ? acceptedAtIso
          : new Date(input.observedAt).toISOString();
      const observedAtWasDefaulted = input.observedAt == null;
      const validFrom =
        input.validFrom == null ? null : new Date(input.validFrom).toISOString();
      const validUntil =
        input.validUntil == null ? null : new Date(input.validUntil).toISOString();
      const effectivePriority = effectivePriorityFor({
        sourceType: input.sourceType,
        requestedPriority: input.requestedPriority,
        allowHighPriority:
          process.env.CORTEX_ALLOW_HIGH_PRIORITY_INGEST === "true",
      });
      const entities = normalizeArray(input.providedEntities);
      const tags = normalizeArray(input.providedSemanticTags);

      const accepted = await deps.sql.begin(async (transaction) => {
        const inserted = await transaction`
          INSERT INTO public.memory_ingest_events (
            id,
            agent_id,
            idempotency_key,
            raw_content,
            request_hash,
            content_hash,
            source,
            source_version,
            source_type,
            observed_at,
            observed_at_was_defaulted,
            valid_from,
            valid_until,
            requested_priority,
            effective_priority,
            provided_entities,
            provided_semantic_tags,
            projection_mode,
            predecessor_memory_id,
            force_new_projection,
            request_id,
            session_id,
            status,
            acceptance_build_id,
            accepted_at,
            updated_at
          ) VALUES (
            ${eventId}::uuid,
            ${input.agentId},
            ${idempotencyKey},
            ${input.content},
            ${requestHash},
            ${sha256(input.content)},
            ${input.source ?? null},
            ${input.sourceVersion ?? null},
            ${input.sourceType},
            ${observedAt},
            ${observedAtWasDefaulted},
            ${validFrom},
            ${validUntil},
            ${input.requestedPriority},
            ${effectivePriority},
            ${transaction.array(entities)},
            ${transaction.array(tags)},
            ${input.projectionMode ?? "append"},
            ${input.predecessorMemoryId ?? null},
            ${input.forceNewProjection ?? false},
            ${input.requestId ?? null},
            ${input.sessionId ?? null},
            'accepted',
            ${deps.config.buildId},
            ${acceptedAtIso},
            ${acceptedAtIso}
          )
          ON CONFLICT (agent_id, idempotency_key) DO NOTHING
          RETURNING id, request_hash
        `;
        if (inserted.length > 0) {
          return {
            id: String(inserted[0].id),
            replayed: false,
            acceptedAt: acceptedAtIso,
          };
        }

        const existing = await transaction`
          SELECT id, request_hash, accepted_at
          FROM public.memory_ingest_events
          WHERE agent_id = ${input.agentId}
            AND idempotency_key = ${idempotencyKey}
          FOR UPDATE
        `;
        if (existing.length !== 1) {
          throw new Error("Idempotent ingest row was not readable after conflict");
        }
        if (String(existing[0].request_hash).trim() !== requestHash) {
          throw new IdempotencyConflictError(String(existing[0].id));
        }
        return {
          id: String(existing[0].id),
          replayed: true,
          acceptedAt: existing[0].accepted_at as string | Date,
        };
      });

      const fallback = acceptedReceipt(
        accepted.id,
        accepted.replayed,
        accepted.acceptedAt
      );
      if (!accepted.replayed) return fallback;

      try {
        return (
          (await loadReceipt(
            deps.sql,
            input.agentId,
            accepted.id,
            true,
            deps.config.ingestMaxAttempts
          )) ?? fallback
        );
      } catch {
        console.error("[ingest] Replay receipt refresh failed", {
          eventId: accepted.id,
          code: "receipt_refresh_failed",
        });
        return fallback;
      }
    },

    async get(agentId: number, eventId: string): Promise<IngestReceipt | null> {
      return loadReceipt(
        deps.sql,
        agentId,
        eventId,
        false,
        deps.config.ingestMaxAttempts
      );
    },

    async wait(
      agentId: number,
      eventId: string,
      timeoutMs: number
    ): Promise<IngestReceipt> {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      let receipt = await loadReceipt(
        deps.sql,
        agentId,
        eventId,
        false,
        deps.config.ingestMaxAttempts
      );
      if (!receipt) {
        throw new IngestValidationError("event_not_found", "Ingest event not found");
      }
      while (
        new Set<IngestStatus>(["accepted", "processing"]).has(receipt.status) &&
        performance.now() < deadline
      ) {
        await delay(Math.min(50, Math.max(1, deadline - performance.now())));
        receipt =
          (await loadReceipt(
            deps.sql,
            agentId,
            eventId,
            false,
            deps.config.ingestMaxAttempts
          )) ?? receipt;
      }
      return receipt;
    },

    async retryTerminalFailure(
      agentId: number,
      eventId: string
    ): Promise<IngestReceipt | null> {
      const now = deps.now();
      const nowIso = now.toISOString();
      return deps.sql.begin(async (transaction) => {
        const rows = await transaction`
          UPDATE public.memory_ingest_events
          SET status = 'accepted',
              cycle_attempts = 0,
              manual_retry_count = manual_retry_count + 1,
              next_attempt_at = NULL,
              failure_code = NULL,
              failure_message = NULL,
              updated_at = ${nowIso}
          WHERE id = ${eventId}::uuid
            AND agent_id = ${agentId}
            AND status = 'failed'
            AND next_attempt_at IS NULL
          RETURNING id
        `;
        if (rows.length === 0) return null;
        return loadReceipt(
          transaction,
          agentId,
          eventId,
          false,
          deps.config.ingestMaxAttempts
        );
      });
    },
  });
}
