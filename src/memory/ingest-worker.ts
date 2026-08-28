import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  HippocampalResultError,
  hippocampalEncode,
  validateHippocampalEncoding,
} from "../hippocampus/index.js";
import {
  EmbeddingProviderError,
  EmbeddingResultError,
  validateEmbeddedBatch,
} from "../ingestion/embeddings.js";
import {
  extractEntitiesSync,
  extractSemanticTags,
} from "../ingestion/entities.js";
import {
  analyzeValence,
  ValenceResultError,
  validateValenceResult,
} from "../valence/index.js";
import { createMemoryHealthService } from "./health.js";
import { createIngestService } from "./ingest.js";
import type {
  ClaimedIngestEvent,
  EmbeddedVector,
  IngestReceipt,
  IngestWorker,
  MemoryServiceDependencies,
  PreparedSynapseBatch,
  ProjectionMode,
} from "./types.js";
import { chunkText } from "../ingestion/chunker.js";

const LEASE_MS = 60_000;
const LEASE_RENEW_MS = 20_000;
const HEARTBEAT_MS = 30_000;
const IDLE_POLL_MS = 100;

export class LeaseLostError extends Error {
  constructor() {
    super("The ingest event lease is no longer owned by this worker");
    this.name = "LeaseLostError";
  }
}

type ProjectionFailureCode =
  | "embedding_provider_unavailable"
  | "embedding_provider_rejected"
  | "embedding_result_invalid"
  | "embedding_batch_mismatch"
  | "embedding_dimension_invalid"
  | "embedding_non_finite"
  | "embedding_zero_norm"
  | "embedding_not_normalized"
  | "hippocampal_result_invalid"
  | "valence_result_invalid"
  | "projection_checkpoint_invalid"
  | "graph_projection_failed"
  | "projection_failed";

const FAILURE_MESSAGES: Readonly<Record<ProjectionFailureCode, string>> = {
  embedding_provider_unavailable: "Embedding provider unavailable",
  embedding_provider_rejected: "Embedding provider rejected the request",
  embedding_result_invalid: "Embedding provider returned invalid data",
  embedding_batch_mismatch: "Embedding provider returned invalid data",
  embedding_dimension_invalid: "Embedding provider returned invalid data",
  embedding_non_finite: "Embedding provider returned invalid data",
  embedding_zero_norm: "Embedding provider returned invalid data",
  embedding_not_normalized: "Embedding provider returned invalid data",
  hippocampal_result_invalid: "Hippocampal projection returned invalid data",
  valence_result_invalid: "Valence projection returned invalid data",
  projection_checkpoint_invalid: "Projection checkpoint is invalid",
  graph_projection_failed: "Graph projection failed",
  projection_failed: "Projection processing failed",
};

class ProjectionProcessingError extends Error {
  constructor(readonly code: ProjectionFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "ProjectionProcessingError";
  }
}

interface EventRow {
  id: string;
  agent_id: number;
  raw_content: string;
  source: string | null;
  source_version: string | null;
  source_type: string;
  observed_at: string | Date;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  effective_priority: number;
  provided_entities: string[] | null;
  provided_semantic_tags: string[] | null;
  accepted_at: string | Date;
  projected_at: string | Date | null;
  projection_count: number;
  projection_mode: ProjectionMode;
  force_new_projection: boolean;
  derivation_relation?: string | null;
  derivation_confidence?: number | string | null;
  derivation_expires_at?: string | Date | null;
  lease_token: string | null;
  status: string;
}

interface ProjectedNodeRow {
  id: number | string;
  status: string;
  projection_fingerprint: string;
}

interface FinalizationClockRow {
  finalized_at: unknown;
}

interface PreparedChunk {
  index: number;
  content: string;
  contentHash: string;
  projectionFingerprint: string;
  embedding: EmbeddedVector;
  entities: string[];
  semanticTags: string[];
  warningCodes: string[];
  sparseCode: {
    indices: number[];
    values: number[];
    dim: number;
  };
  noveltyScore: number;
  possibleUpdateIds: number[];
  valence: ReturnType<typeof analyzeValence>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0)
  );
}

function safeEnrichment(
  result: unknown,
  deterministicEntities: readonly string[]
): { entities: string[]; warnings: string[] } {
  if (!result || typeof result !== "object") {
    return {
      entities: [...deterministicEntities],
      warnings: ["entity_enrichment_degraded"],
    };
  }
  const candidate = result as { entities?: unknown; warnings?: unknown };
  if (
    !Array.isArray(candidate.entities) ||
    candidate.entities.length > 64 ||
    candidate.entities.some(
      (entity) =>
        typeof entity !== "string" ||
        entity !== entity.trim() ||
        entity.length < 1 ||
        entity.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(entity)
    ) ||
    !Array.isArray(candidate.warnings) ||
    candidate.warnings.some(
      (warning) => warning !== "entity_enrichment_degraded"
    )
  ) {
    return {
      entities: [...deterministicEntities],
      warnings: ["entity_enrichment_degraded"],
    };
  }
  return {
    entities: normalizeStrings([
      ...deterministicEntities,
      ...(candidate.entities as string[]),
    ]),
    warnings: normalizeStrings(candidate.warnings as string[]),
  };
}

function projectionError(error: unknown): ProjectionProcessingError {
  if (error instanceof ProjectionProcessingError) return error;
  if (error instanceof EmbeddingProviderError) {
    return new ProjectionProcessingError(error.code);
  }
  if (error instanceof EmbeddingResultError) {
    return new ProjectionProcessingError(error.code);
  }
  if (error instanceof HippocampalResultError) {
    return new ProjectionProcessingError(error.code);
  }
  if (error instanceof ValenceResultError) {
    return new ProjectionProcessingError(error.code);
  }
  return new ProjectionProcessingError("projection_failed");
}

export interface ProjectionFingerprintInput {
  content: string;
  validFrom?: string | Date | null;
  validUntil?: string | Date | null;
  effectivePriority: number;
  entities: readonly string[];
  semanticTags: readonly string[];
  derivationRelation?: string | null;
  derivationConfidence?: number | null;
  derivationExpiresAt?: string | Date | null;
  projectionVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
}

/** Exact identity for a reusable projection; source identity stays provenance-only. */
export function projectionFingerprintFor(
  input: ProjectionFingerprintInput
): string {
  return sha256(
    JSON.stringify({
      content: input.content,
      validFrom: input.validFrom
        ? new Date(input.validFrom).toISOString()
        : null,
      validUntil: input.validUntil
        ? new Date(input.validUntil).toISOString()
        : null,
      effectivePriority: Number(input.effectivePriority),
      entities: normalizeStrings(input.entities),
      semanticTags: normalizeStrings(input.semanticTags),
      derivationRelation: input.derivationRelation ?? null,
      derivationConfidence:
        input.derivationConfidence === undefined
          ? null
          : input.derivationConfidence,
      derivationExpiresAt: input.derivationExpiresAt
        ? new Date(input.derivationExpiresAt).toISOString()
        : null,
      projectionVersion: input.projectionVersion,
      embeddingProvider: input.embeddingProvider,
      embeddingModel: input.embeddingModel,
    })
  );
}

function projectionFingerprint(
  deps: MemoryServiceDependencies,
  event: EventRow,
  content: string,
  embedding: EmbeddedVector,
  entities: readonly string[],
  semanticTags: readonly string[]
): string {
  return projectionFingerprintFor({
    content,
    validFrom: event.valid_from,
    validUntil: event.valid_until,
    effectivePriority: Number(event.effective_priority),
    entities,
    semanticTags,
    derivationRelation: event.derivation_relation,
    derivationConfidence:
      event.derivation_confidence == null
        ? null
        : Number(event.derivation_confidence),
    derivationExpiresAt: event.derivation_expires_at,
    projectionVersion: deps.config.projectionVersion,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
  });
}

function remapPreparedSynapses(
  prepared: PreparedSynapseBatch,
  replacements: ReadonlyMap<number, number>
): PreparedSynapseBatch {
  if (replacements.size === 0) return prepared;
  const newNodeIds = prepared.newNodeIds
    .filter((memoryId) => !replacements.has(memoryId))
    .sort((left, right) => left - right);
  const newlyActivated = new Set(newNodeIds);
  const candidates = new Map<
    string,
    PreparedSynapseBatch["candidates"][number]
  >();

  for (const candidate of prepared.candidates) {
    const mappedA = replacements.get(candidate.memoryA) ?? candidate.memoryA;
    const mappedB = replacements.get(candidate.memoryB) ?? candidate.memoryB;
    if (mappedA === mappedB) continue;
    const memoryA = Math.min(mappedA, mappedB);
    const memoryB = Math.max(mappedA, mappedB);
    if (!newlyActivated.has(memoryA) && !newlyActivated.has(memoryB)) continue;
    const key = `${candidate.agentId}:${memoryA}:${memoryB}:${candidate.connectionType}`;
    const current = candidates.get(key);
    const mapped = {
      ...candidate,
      memoryA,
      memoryB,
      connectionStrength: Math.max(
        current?.connectionStrength ?? 0,
        candidate.connectionStrength
      ),
      decayRate: Math.min(
        current?.decayRate ?? candidate.decayRate,
        candidate.decayRate
      ),
    };
    candidates.set(key, mapped);
  }

  return {
    ...prepared,
    newNodeIds,
    candidates: [...candidates.values()].sort((left, right) =>
      left.memoryA - right.memoryA ||
      left.memoryB - right.memoryB ||
      left.connectionType.localeCompare(right.connectionType)
    ),
  };
}

async function prepareProjection(
  deps: MemoryServiceDependencies,
  event: EventRow
): Promise<PreparedChunk[]> {
  const chunks = chunkText(event.raw_content);
  let batch;
  try {
    batch = validateEmbeddedBatch(
      await deps.embedTexts(chunks.map((chunk) => chunk.text)),
      chunks.length
    );
  } catch (error) {
    if (error instanceof EmbeddingProviderError || error instanceof EmbeddingResultError) {
      throw projectionError(error);
    }
    throw new ProjectionProcessingError("embedding_provider_unavailable");
  }

  return Promise.all(
    chunks.map(async (chunk, index) => {
      const embedding = batch.vectors[index];
      const deterministicEntities = extractEntitiesSync(chunk.text);
      let enrichment;
      try {
        enrichment = safeEnrichment(
          await deps.enrichEntities(chunk.text),
          deterministicEntities
        );
      } catch {
        console.error("[cortex-worker] Optional entity enrichment degraded", {
          eventId: event.id,
          code: "entity_enrichment_degraded",
        });
        enrichment = {
          entities: deterministicEntities,
          warnings: ["entity_enrichment_degraded"],
        };
      }
      const entities = normalizeStrings([
        ...(event.provided_entities ?? []),
        ...enrichment.entities,
      ]);
      const semanticTags = normalizeStrings([
        ...(event.provided_semantic_tags ?? []),
        ...extractSemanticTags(chunk.text),
      ]);
      const encoding = await hippocampalEncode(
        Number(event.agent_id),
        embedding.values,
        Number(event.effective_priority),
        deps.now()
      );
      validateHippocampalEncoding(
        encoding,
        Number(event.effective_priority)
      );
      const valence = validateValenceResult(analyzeValence(chunk.text));

      return {
        index: chunk.index,
        content: chunk.text,
        contentHash: sha256(chunk.text),
        projectionFingerprint: projectionFingerprint(
          deps,
          event,
          chunk.text,
          embedding,
          entities,
          semanticTags
        ),
        embedding,
        entities,
        semanticTags,
        warningCodes: enrichment.warnings,
        sparseCode: encoding.sparseCode,
        noveltyScore: encoding.noveltyResult.noveltyScore,
        possibleUpdateIds: encoding.noveltyResult.possibleUpdateIds,
        valence,
      };
    })
  );
}

async function loadClaimedEvent(
  deps: MemoryServiceDependencies,
  claim: ClaimedIngestEvent
): Promise<EventRow> {
  const rows = (await deps.sql`
    SELECT
      id,
      agent_id,
      raw_content,
      source,
      source_version,
      source_type,
      observed_at,
      valid_from,
      valid_until,
      effective_priority,
      provided_entities,
      provided_semantic_tags,
      accepted_at,
      projected_at,
      projection_count,
      projection_mode,
      force_new_projection,
      lease_token,
      status
    FROM public.memory_ingest_events
    WHERE id = ${claim.eventId}::uuid
      AND agent_id = ${claim.agentId}
      AND lease_token = ${claim.leaseToken}::uuid
      AND status = 'processing'
  `) as unknown as EventRow[];
  if (!rows[0]) throw new LeaseLostError();
  return rows[0];
}

async function renewClaimLease(
  deps: MemoryServiceDependencies,
  claim: ClaimedIngestEvent
): Promise<void> {
  const leaseExpiresAt = new Date(deps.now().getTime() + LEASE_MS).toISOString();
  const rows = await deps.sql`
    UPDATE public.memory_ingest_events
    SET lease_expires_at = ${leaseExpiresAt},
        updated_at = ${deps.now().toISOString()}
    WHERE id = ${claim.eventId}::uuid
      AND agent_id = ${claim.agentId}
      AND status = 'processing'
      AND lease_token = ${claim.leaseToken}::uuid
    RETURNING id
  `;
  if (!rows[0]) throw new LeaseLostError();
}

async function withLeaseRenewal<T>(
  deps: MemoryServiceDependencies,
  claim: ClaimedIngestEvent,
  operation: () => Promise<T>
): Promise<T> {
  let renewalFailure: unknown = null;
  let renewalChain = Promise.resolve();
  const timer = setInterval(() => {
    renewalChain = renewalChain
      .then(() => renewClaimLease(deps, claim))
      .catch((error) => {
        renewalFailure ??= error;
      });
  }, LEASE_RENEW_MS);
  timer.unref();
  try {
    const result = await operation();
    await renewalChain;
    if (renewalFailure) throw renewalFailure;
    await renewClaimLease(deps, claim);
    return result;
  } finally {
    clearInterval(timer);
    await renewalChain;
  }
}

export function createIngestWorker(
  deps: MemoryServiceDependencies
): IngestWorker {
  const ingest = createIngestService(deps);
  const health = createMemoryHealthService(deps);

  const worker: IngestWorker = {
    async claim(workerId: string): Promise<ClaimedIngestEvent | null> {
      const now = deps.now();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      const nowIso = now.toISOString();
      const leaseExpiresAtIso = leaseExpiresAt.toISOString();
      const leaseToken = deps.newId();

      return deps.sql.begin(async (transaction) => {
        await transaction`
          UPDATE public.memory_ingest_events
          SET status = 'failed',
              next_attempt_at = NULL,
              failure_code = 'lease_expired',
              failure_message = 'Worker lease expired at the attempt ceiling',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              first_terminal_failure_at = COALESCE(
                first_terminal_failure_at,
                ${nowIso}
              ),
              first_terminal_failure_build_id = COALESCE(
                first_terminal_failure_build_id,
                ${deps.config.buildId}
              ),
              latest_terminal_failure_at = GREATEST(
                COALESCE(latest_terminal_failure_at, ${nowIso}),
                ${nowIso}
              ),
              latest_terminal_failure_build_id = CASE
                WHEN latest_terminal_failure_at IS NULL
                  OR ${nowIso}::timestamptz >= latest_terminal_failure_at
                  THEN ${deps.config.buildId}
                ELSE latest_terminal_failure_build_id
              END,
              terminal_failure_transition_count =
                terminal_failure_transition_count + 1,
              updated_at = ${nowIso}
          WHERE status = 'processing'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ${nowIso}
            AND cycle_attempts >= ${deps.config.ingestMaxAttempts}
        `;
        await transaction`
          UPDATE public.memory_ingest_events
          SET next_attempt_at = NULL,
              first_terminal_failure_at = COALESCE(
                first_terminal_failure_at,
                ${nowIso}
              ),
              first_terminal_failure_build_id = COALESCE(
                first_terminal_failure_build_id,
                ${deps.config.buildId}
              ),
              latest_terminal_failure_at = GREATEST(
                COALESCE(latest_terminal_failure_at, ${nowIso}),
                ${nowIso}
              ),
              latest_terminal_failure_build_id = CASE
                WHEN latest_terminal_failure_at IS NULL
                  OR ${nowIso}::timestamptz >= latest_terminal_failure_at
                  THEN ${deps.config.buildId}
                ELSE latest_terminal_failure_build_id
              END,
              terminal_failure_transition_count =
                terminal_failure_transition_count + 1,
              updated_at = ${nowIso}
          WHERE status = 'failed'
            AND next_attempt_at IS NOT NULL
            AND cycle_attempts >= ${deps.config.ingestMaxAttempts}
        `;
        const rows = await transaction`
          SELECT id, agent_id, cycle_attempts, projected_at
          FROM public.memory_ingest_events
          WHERE (
              status = 'accepted'
              OR (
                status = 'failed'
                AND next_attempt_at IS NOT NULL
                AND next_attempt_at <= ${nowIso}
                AND cycle_attempts < ${deps.config.ingestMaxAttempts}
              )
              OR (
                status = 'processing'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ${nowIso}
                AND cycle_attempts < ${deps.config.ingestMaxAttempts}
              )
            )
          ORDER BY accepted_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
        if (!rows[0]) return null;

        const eventId = String(rows[0].id);
        const attempt = Number(rows[0].cycle_attempts) + 1;
        await transaction`
          UPDATE public.memory_ingest_events
          SET status = 'processing',
              total_attempts = total_attempts + 1,
              cycle_attempts = cycle_attempts + 1,
              lease_owner = ${workerId},
              lease_token = ${leaseToken}::uuid,
              lease_expires_at = ${leaseExpiresAtIso},
              next_attempt_at = NULL,
              failure_code = NULL,
              failure_message = NULL,
              started_at = COALESCE(started_at, ${nowIso}),
              updated_at = ${nowIso}
          WHERE id = ${eventId}::uuid
        `;

        return {
          eventId,
          agentId: Number(rows[0].agent_id),
          attempt,
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt: leaseExpiresAtIso,
          projectionAlreadyCommitted: rows[0].projected_at !== null,
        };
      });
    },

    async process(claim: ClaimedIngestEvent): Promise<IngestReceipt> {
      try {
        const event = await loadClaimedEvent(deps, claim);
        let prepared: PreparedChunk[] = [];

        if (!event.projected_at) {
          prepared = await withLeaseRenewal(deps, claim, () =>
            prepareProjection(deps, event)
          );
          const projectedAt = deps.now();
          const projectedAtIso = projectedAt.toISOString();
          await deps.sql.begin(async (transaction) => {
            const locked = await transaction`
              SELECT projected_at
              FROM public.memory_ingest_events
              WHERE id = ${claim.eventId}::uuid
                AND agent_id = ${claim.agentId}
                AND status = 'processing'
                AND lease_token = ${claim.leaseToken}::uuid
              FOR UPDATE
            `;
            if (!locked[0]) throw new LeaseLostError();
            if (locked[0].projected_at !== null) return;

            const warningCodes = new Set<string>();
            const possibleUpdateIds = new Set<number>();
            for (const chunk of prepared) {
              chunk.warningCodes.forEach((warning) => warningCodes.add(warning));
              chunk.possibleUpdateIds.forEach((memoryId) =>
                possibleUpdateIds.add(memoryId)
              );
              const inserted = await transaction`
                INSERT INTO public.memory_nodes (
                  agent_id,
                  content,
                  source,
                  source_type,
                  chunk_index,
                  embedding,
                  entities,
                  semantic_tags,
                  priority,
                  resonance_score,
                  access_count,
                  last_accessed_at,
                  status,
                  valid_from,
                  valid_until,
                  novelty_score,
                  last_recalled_at,
                  ingest_event_id,
                  ingest_chunk_index,
                  content_hash,
                  projection_fingerprint,
                  embedding_provider,
                  embedding_model,
                  created_at,
                  updated_at
                ) VALUES (
                  ${claim.agentId},
                  ${chunk.content},
                  ${event.source},
                  ${event.source_type},
                  ${chunk.index},
                  ${`[${chunk.embedding.values.join(",")}]`}::public.vector,
                  ${transaction.array(chunk.entities)},
                  ${transaction.array(chunk.semanticTags)},
                  ${Number(event.effective_priority)},
                  0.5,
                  0,
                  NULL,
                  'pending',
                  ${event.valid_from
                    ? new Date(event.valid_from).toISOString()
                    : null},
                  ${event.valid_until
                    ? new Date(event.valid_until).toISOString()
                    : null},
                  ${chunk.noveltyScore},
                  NULL,
                  ${claim.eventId}::uuid,
                  ${chunk.index},
                  ${chunk.contentHash},
                  ${chunk.projectionFingerprint},
                  ${chunk.embedding.provider},
                  ${chunk.embedding.model},
                  ${projectedAtIso},
                  ${projectedAtIso}
                )
                RETURNING id
              `;
              const memoryId = Number(inserted[0].id);
              await transaction`
                INSERT INTO public.hippocampal_codes (
                  memory_id,
                  agent_id,
                  sparse_indices,
                  sparse_values,
                  sparse_dim,
                  novelty_score,
                  created_at
                ) VALUES (
                  ${memoryId},
                  ${claim.agentId},
                  ${transaction.array(chunk.sparseCode.indices)}::integer[],
                  ${transaction.array(chunk.sparseCode.values)}::real[],
                  ${chunk.sparseCode.dim},
                  ${chunk.noveltyScore},
                  ${projectedAtIso}
                )
              `;
              const { vector, salience } = chunk.valence;
              await transaction`
                INSERT INTO public.emotional_valence (
                  memory_id,
                  agent_id,
                  valence,
                  arousal,
                  dominance,
                  certainty,
                  relevance,
                  urgency,
                  intensity,
                  decay_resistance,
                  recall_boost,
                  dominant_dimension,
                  created_at
                ) VALUES (
                  ${memoryId},
                  ${claim.agentId},
                  ${vector.valence},
                  ${vector.arousal},
                  ${vector.dominance},
                  ${vector.certainty},
                  ${vector.relevance},
                  ${vector.urgency},
                  ${salience.intensity},
                  ${salience.decayResistance},
                  ${salience.recallBoost},
                  ${salience.dominantDimension},
                  ${projectedAtIso}
                )
              `;
              await transaction`
                INSERT INTO public.memory_provenance (
                  id,
                  agent_id,
                  memory_id,
                  ingest_event_id,
                  relation,
                  created_at
                ) VALUES (
                  ${deps.newId()}::uuid,
                  ${claim.agentId},
                  ${memoryId},
                  ${claim.eventId}::uuid,
                  'captured_from',
                  ${projectedAtIso}
                )
              `;
            }

            await transaction`
              UPDATE public.memory_ingest_events
              SET projected_at = ${projectedAtIso},
                  projection_count = ${prepared.length},
                  warning_codes = ${transaction.array([...warningCodes])},
                  possible_update_ids = ${transaction.array(
                    [...possibleUpdateIds].sort((left, right) => left - right)
                  )}::integer[],
                  updated_at = ${projectedAtIso}
              WHERE id = ${claim.eventId}::uuid
                AND lease_token = ${claim.leaseToken}::uuid
            `;
          });
        }

        await renewClaimLease(deps, claim);
        const graphAtIso = deps.now().toISOString();
        const checkpoint = await deps.sql`
          SELECT projected_at, projection_count
          FROM public.memory_ingest_events
          WHERE id = ${claim.eventId}::uuid
            AND agent_id = ${claim.agentId}
            AND status = 'processing'
            AND lease_token = ${claim.leaseToken}::uuid
        `;
        if (!checkpoint[0]) throw new LeaseLostError();
        if (checkpoint[0].projected_at === null) {
          throw new ProjectionProcessingError(
            "projection_checkpoint_invalid"
          );
        }
        const checkpointNodes = await deps.sql`
          SELECT id, status
          FROM public.memory_nodes
          WHERE ingest_event_id = ${claim.eventId}::uuid
            AND agent_id = ${claim.agentId}
          ORDER BY ingest_chunk_index ASC, id ASC
        `;
        if (
          checkpointNodes.length !== Number(checkpoint[0].projection_count) ||
          checkpointNodes.length === 0 ||
          checkpointNodes.some((node) => node.status !== "pending")
        ) {
          throw new ProjectionProcessingError(
            "projection_checkpoint_invalid"
          );
        }
        const memoryIds = checkpointNodes.map((node) => Number(node.id));
        let preparedSynapses: PreparedSynapseBatch;
        try {
          preparedSynapses = await withLeaseRenewal(deps, claim, () =>
            deps.discoverSynapses(claim.agentId, memoryIds, {
              sql: deps.sql,
              currentAt: graphAtIso,
            })
          );
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          throw new ProjectionProcessingError("graph_projection_failed");
        }

        const obsolete = await deps.sql.begin(async (transaction) => {
          const locked = await transaction`
            SELECT projected_at, projection_count, accepted_at
            FROM public.memory_ingest_events
            WHERE id = ${claim.eventId}::uuid
              AND agent_id = ${claim.agentId}
              AND status = 'processing'
              AND lease_token = ${claim.leaseToken}::uuid
            FOR UPDATE
          `;
          if (!locked[0]) throw new LeaseLostError();
          if (locked[0].projected_at === null) {
            throw new ProjectionProcessingError(
              "projection_checkpoint_invalid"
            );
          }

          const acceptedAtIso = new Date(
            locked[0].accepted_at as string | Date
          ).toISOString();
          let finalizationClock: FinalizationClockRow[];
          if (event.projection_mode === "replace_source") {
            await transaction`
              SELECT pg_catalog.pg_advisory_xact_lock(
                ${claim.agentId},
                pg_catalog.hashtext(${`source:${event.source}`})
              )
            `;
            finalizationClock = (await transaction`
              SELECT GREATEST(
                pg_catalog.transaction_timestamp(),
                ${acceptedAtIso}::timestamptz,
                COALESCE(
                  pg_catalog.max(prior.indexed_at),
                  '-infinity'::timestamptz
                )
              )::text AS finalized_at
              FROM public.memory_ingest_events AS prior
              WHERE prior.agent_id = ${claim.agentId}
                AND prior.source = ${event.source}
                AND prior.projection_mode = 'replace_source'
                AND prior.status = 'indexed'
                AND prior.indexed_at IS NOT NULL
            `) as unknown as FinalizationClockRow[];
          } else {
            finalizationClock = (await transaction`
              SELECT GREATEST(
                pg_catalog.transaction_timestamp(),
                ${acceptedAtIso}::timestamptz
              )::text AS finalized_at
            `) as unknown as FinalizationClockRow[];
          }
          if (typeof finalizationClock[0]?.finalized_at !== "string") {
            throw new ProjectionProcessingError(
              "projection_checkpoint_invalid"
            );
          }
          const indexedAtIso = finalizationClock[0].finalized_at;

          if (event.projection_mode === "replace_source") {
            const newer = await transaction`
              SELECT id
              FROM public.memory_ingest_events
              WHERE agent_id = ${claim.agentId}
                AND source = ${event.source}
                AND projection_mode = 'replace_source'
                AND status = 'indexed'
                AND (
                  accepted_at > ${acceptedAtIso}
                  OR (
                    accepted_at = ${acceptedAtIso}
                    AND id > ${claim.eventId}::uuid
                  )
                )
              ORDER BY accepted_at DESC, id DESC
              LIMIT 1
            `;
            if (newer[0]) {
              await transaction`
                UPDATE public.memory_nodes
                SET status = 'superseded',
                    valid_until = CASE
                      WHEN valid_until IS NULL
                        OR valid_until > ${indexedAtIso}::timestamptz
                        THEN ${indexedAtIso}::timestamptz
                      ELSE valid_until
                    END,
                    updated_at = ${indexedAtIso}
                WHERE ingest_event_id = ${claim.eventId}::uuid
                  AND agent_id = ${claim.agentId}
                  AND status = 'pending'
              `;
              const rejected = await transaction`
                UPDATE public.memory_ingest_events
                SET status = 'rejected',
                    synapse_count = 0,
                    lease_owner = NULL,
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    next_attempt_at = NULL,
                    failure_code = 'obsolete_source_snapshot',
                    failure_message = 'A newer source snapshot is already indexed',
                    updated_at = ${indexedAtIso}
                WHERE id = ${claim.eventId}::uuid
                  AND agent_id = ${claim.agentId}
                  AND status = 'processing'
                  AND lease_token = ${claim.leaseToken}::uuid
                RETURNING id
              `;
              if (!rejected[0]) throw new LeaseLostError();
              return true;
            }
          }

          const projectedNodesBeforeLock = (await transaction`
            SELECT id, status, projection_fingerprint
            FROM public.memory_nodes
            WHERE ingest_event_id = ${claim.eventId}::uuid
              AND agent_id = ${claim.agentId}
            ORDER BY ingest_chunk_index ASC, id ASC
          `) as unknown as ProjectedNodeRow[];
          if (
            projectedNodesBeforeLock.length !==
              Number(locked[0].projection_count) ||
            projectedNodesBeforeLock.length === 0 ||
            projectedNodesBeforeLock.some((node) => node.status !== "pending") ||
            projectedNodesBeforeLock.some(
              (node, index) => Number(node.id) !== memoryIds[index]
            )
          ) {
            throw new ProjectionProcessingError(
              "projection_checkpoint_invalid"
            );
          }

          const retirementFingerprints =
            event.projection_mode === "replace_source"
              ? await transaction`
                  SELECT DISTINCT node.projection_fingerprint
                  FROM public.memory_nodes AS node
                  JOIN public.memory_provenance AS provenance
                    ON provenance.agent_id = node.agent_id
                   AND provenance.memory_id = node.id
                   AND provenance.relation = 'captured_from'
                  JOIN public.memory_ingest_events AS prior
                    ON prior.agent_id = provenance.agent_id
                   AND prior.id = provenance.ingest_event_id
                  WHERE node.agent_id = ${claim.agentId}
                    AND node.projection_fingerprint IS NOT NULL
                    AND prior.source = ${event.source}
                    AND prior.projection_mode = 'replace_source'
                    AND prior.status = 'indexed'
                    AND prior.snapshot_valid_until IS NULL
                    AND (
                      prior.accepted_at < ${acceptedAtIso}
                      OR (
                        prior.accepted_at = ${acceptedAtIso}
                        AND prior.id < ${claim.eventId}::uuid
                      )
                    )
                `
              : [];
          const fingerprints = [
            ...new Set([
              ...projectedNodesBeforeLock.map((node) =>
                String(node.projection_fingerprint)
              ),
              ...retirementFingerprints.map((row) =>
                String(row.projection_fingerprint)
              ),
            ]),
          ].sort();
          for (const fingerprint of fingerprints) {
            await transaction`
              SELECT pg_catalog.pg_advisory_xact_lock(
                ${claim.agentId},
                pg_catalog.hashtext(${`projection:${fingerprint}`})
              )
            `;
          }

          const projectedNodes = (await transaction`
            SELECT id, status, projection_fingerprint
            FROM public.memory_nodes
            WHERE ingest_event_id = ${claim.eventId}::uuid
              AND agent_id = ${claim.agentId}
            ORDER BY ingest_chunk_index ASC, id ASC
            FOR UPDATE
          `) as unknown as ProjectedNodeRow[];
          if (
            projectedNodes.length !== Number(locked[0].projection_count) ||
            projectedNodes.length === 0 ||
            projectedNodes.some((node) => node.status !== "pending") ||
            projectedNodes.some(
              (node, index) => Number(node.id) !== memoryIds[index]
            )
          ) {
            throw new ProjectionProcessingError(
              "projection_checkpoint_invalid"
            );
          }

          const replacements = new Map<number, number>();
          const selectedCandidates: number[] = [];
          if (!event.force_new_projection) {
            for (const node of projectedNodes) {
              const candidate = await transaction`
                SELECT candidate.id
                FROM public.memory_nodes AS candidate
                WHERE candidate.agent_id = ${claim.agentId}
                  AND candidate.id <> ${Number(node.id)}
                  AND candidate.status = 'active'
                  AND candidate.projection_fingerprint = ${node.projection_fingerprint}
                  AND (
                    candidate.valid_from IS NULL
                    OR candidate.valid_from <= ${indexedAtIso}::timestamptz
                  )
                  AND (
                    candidate.valid_until IS NULL
                    OR candidate.valid_until > ${indexedAtIso}::timestamptz
                  )
                  AND (
                    candidate.derivation_expires_at IS NULL
                    OR candidate.derivation_expires_at > ${indexedAtIso}::timestamptz
                  )
                  AND NOT (
                    candidate.id = ANY(
                      ${transaction.array(selectedCandidates)}::integer[]
                    )
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM public.memory_provenance AS support
                    JOIN public.memory_ingest_events AS support_event
                      ON support_event.agent_id = support.agent_id
                     AND support_event.id = support.ingest_event_id
                    WHERE support.agent_id = candidate.agent_id
                      AND support.memory_id = candidate.id
                      AND support.relation = 'captured_from'
                      AND support_event.status = 'indexed'
                      AND support_event.snapshot_valid_until IS NULL
                  )
                ORDER BY candidate.id ASC
                FOR UPDATE OF candidate
                LIMIT 1
              `;
              if (!candidate[0]) continue;
              const pendingId = Number(node.id);
              const candidateId = Number(candidate[0].id);
              replacements.set(pendingId, candidateId);
              selectedCandidates.push(candidateId);
              await transaction`
                INSERT INTO public.memory_provenance (
                  id,
                  agent_id,
                  memory_id,
                  ingest_event_id,
                  relation,
                  created_at
                ) VALUES (
                  ${deps.newId()}::uuid,
                  ${claim.agentId},
                  ${candidateId},
                  ${claim.eventId}::uuid,
                  'captured_from',
                  ${indexedAtIso}
                )
              `;
            }
          }

          if (replacements.size > 0) {
            await transaction`
              DELETE FROM public.memory_nodes
              WHERE agent_id = ${claim.agentId}
                AND status = 'pending'
                AND id = ANY(
                  ${transaction.array([...replacements.keys()])}::integer[]
                )
            `;
          }

          const linked = await transaction`
            SELECT pg_catalog.count(DISTINCT memory_id)::integer AS count
            FROM public.memory_provenance
            WHERE agent_id = ${claim.agentId}
              AND ingest_event_id = ${claim.eventId}::uuid
              AND relation = 'captured_from'
          `;
          if (Number(linked[0]?.count) !== Number(locked[0].projection_count)) {
            throw new ProjectionProcessingError(
              "projection_checkpoint_invalid"
            );
          }

          const finalSynapses = remapPreparedSynapses(
            preparedSynapses,
            replacements
          );
          let synapseCount: number;
          try {
            synapseCount = await deps.insertSynapses(finalSynapses, {
              replaySafe: true,
              sql: transaction as unknown as typeof deps.sql,
            });
          } catch (error) {
            if (error instanceof LeaseLostError) throw error;
            throw new ProjectionProcessingError("graph_projection_failed");
          }
          if (!Number.isSafeInteger(synapseCount) || synapseCount < 0) {
            throw new ProjectionProcessingError("graph_projection_failed");
          }

          const activated = await transaction`
            UPDATE public.memory_nodes
            SET status = 'active',
                updated_at = ${indexedAtIso}
            WHERE agent_id = ${claim.agentId}
              AND id = ANY(
                ${transaction.array(finalSynapses.newNodeIds)}::integer[]
              )
              AND status = 'pending'
            RETURNING id
          `;
          if (activated.length !== finalSynapses.newNodeIds.length) {
            throw new ProjectionProcessingError(
              "projection_checkpoint_invalid"
            );
          }
          const indexed = await transaction`
            UPDATE public.memory_ingest_events
            SET status = 'indexed',
                indexed_at = ${indexedAtIso},
                indexed_build_id = ${deps.config.buildId},
                synapse_count = ${synapseCount},
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = NULL,
                failure_code = NULL,
                failure_message = NULL,
                updated_at = ${indexedAtIso}
            WHERE id = ${claim.eventId}::uuid
              AND lease_token = ${claim.leaseToken}::uuid
            RETURNING id
          `;
          if (!indexed[0]) throw new LeaseLostError();

          if (event.projection_mode === "replace_source") {
            await transaction`
              SELECT node.id
              FROM public.memory_nodes AS node
              WHERE node.agent_id = ${claim.agentId}
                AND node.status = 'active'
                AND (
                  (
                    node.ingest_event_id IS NULL
                    AND node.source = ${event.source}
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM public.memory_provenance AS provenance
                    JOIN public.memory_ingest_events AS prior
                      ON prior.agent_id = provenance.agent_id
                     AND prior.id = provenance.ingest_event_id
                    WHERE provenance.agent_id = node.agent_id
                      AND provenance.memory_id = node.id
                      AND provenance.relation = 'captured_from'
                      AND prior.source = ${event.source}
                      AND prior.projection_mode = 'replace_source'
                      AND prior.status = 'indexed'
                      AND prior.snapshot_valid_until IS NULL
                      AND prior.id <> ${claim.eventId}::uuid
                  )
                )
              ORDER BY node.id ASC
              FOR UPDATE OF node
            `;
            await transaction`
              UPDATE public.memory_ingest_events AS prior
              SET snapshot_valid_until = ${indexedAtIso},
                  replaced_by_event_id = ${claim.eventId}::uuid,
                  updated_at = ${indexedAtIso}
              WHERE prior.agent_id = ${claim.agentId}
                AND prior.source = ${event.source}
                AND prior.projection_mode = 'replace_source'
                AND prior.status = 'indexed'
                AND prior.snapshot_valid_until IS NULL
                AND prior.id <> ${claim.eventId}::uuid
                AND (
                  prior.accepted_at < ${acceptedAtIso}
                  OR (
                    prior.accepted_at = ${acceptedAtIso}
                    AND prior.id < ${claim.eventId}::uuid
                  )
                )
            `;
            await transaction`
              UPDATE public.memory_nodes AS node
              SET status = 'superseded',
                  valid_until = CASE
                    WHEN node.valid_until IS NULL
                      OR node.valid_until > ${indexedAtIso}::timestamptz
                      THEN ${indexedAtIso}::timestamptz
                    ELSE node.valid_until
                  END,
                  updated_at = ${indexedAtIso}
              WHERE node.agent_id = ${claim.agentId}
                AND node.status = 'active'
                AND (
                  (
                    node.ingest_event_id IS NULL
                    AND node.source = ${event.source}
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM public.memory_provenance AS closed_support
                    JOIN public.memory_ingest_events AS closed_event
                      ON closed_event.agent_id = closed_support.agent_id
                     AND closed_event.id = closed_support.ingest_event_id
                    WHERE closed_support.agent_id = node.agent_id
                      AND closed_support.memory_id = node.id
                      AND closed_support.relation = 'captured_from'
                      AND closed_event.replaced_by_event_id = ${claim.eventId}::uuid
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.memory_provenance AS current_support
                  JOIN public.memory_ingest_events AS current_event
                    ON current_event.agent_id = current_support.agent_id
                   AND current_event.id = current_support.ingest_event_id
                  WHERE current_support.agent_id = node.agent_id
                    AND current_support.memory_id = node.id
                    AND current_support.relation = 'captured_from'
                    AND current_event.status = 'indexed'
                    AND current_event.snapshot_valid_until IS NULL
                )
            `;
          }
          return false;
        });

        const receipt = await ingest.get(claim.agentId, claim.eventId);
        if (!receipt) {
          throw new Error(
            obsolete
              ? "Rejected ingest event disappeared"
              : "Indexed ingest event disappeared"
          );
        }
        return receipt;
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        const safeError = projectionError(error);
        const failedAt = deps.now();
        const failedAtIso = failedAt.toISOString();
        const retryable = claim.attempt < deps.config.ingestMaxAttempts;
        const retryDelayMs = Math.min(60_000 * 2 ** (claim.attempt - 1), 900_000);
        console.error("[cortex-worker] Projection attempt failed", {
          eventId: claim.eventId,
          code: safeError.code,
          retryable,
        });
        const failed = await deps.sql`
          UPDATE public.memory_ingest_events
          SET status = 'failed',
              next_attempt_at = ${retryable
                ? new Date(failedAt.getTime() + retryDelayMs).toISOString()
                : null},
              failure_code = ${safeError.code},
              failure_message = ${safeError.message},
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              first_terminal_failure_at = CASE
                WHEN ${!retryable}
                  THEN COALESCE(first_terminal_failure_at, ${failedAtIso})
                ELSE first_terminal_failure_at
              END,
              first_terminal_failure_build_id = CASE
                WHEN ${!retryable}
                  THEN COALESCE(
                    first_terminal_failure_build_id,
                    ${deps.config.buildId}
                  )
                ELSE first_terminal_failure_build_id
              END,
              latest_terminal_failure_at = CASE
                WHEN ${!retryable} THEN GREATEST(
                  COALESCE(latest_terminal_failure_at, ${failedAtIso}),
                  ${failedAtIso}
                )
                ELSE latest_terminal_failure_at
              END,
              latest_terminal_failure_build_id = CASE
                WHEN ${!retryable}
                  AND (
                    latest_terminal_failure_at IS NULL
                    OR ${failedAtIso}::timestamptz >= latest_terminal_failure_at
                  )
                  THEN ${deps.config.buildId}
                ELSE latest_terminal_failure_build_id
              END,
              terminal_failure_transition_count =
                terminal_failure_transition_count
                + CASE WHEN ${!retryable} THEN 1 ELSE 0 END,
              updated_at = ${failedAtIso}
          WHERE id = ${claim.eventId}::uuid
            AND agent_id = ${claim.agentId}
            AND status = 'processing'
            AND lease_token = ${claim.leaseToken}::uuid
          RETURNING id
        `;
        if (!failed[0]) throw new LeaseLostError();
        const receipt = await ingest.get(claim.agentId, claim.eventId);
        if (!receipt) throw safeError;
        return receipt;
      }
    },

    async run(signal: AbortSignal): Promise<void> {
      const operation = await health.startOperation("ingest_worker");
      const counters = { claimed: 0, indexed: 0, failed: 0, leaseLost: 0 };
      let heartbeatFailure: unknown = null;
      let heartbeatChain = Promise.resolve();
      const queueHeartbeat = (): Promise<void> => {
        heartbeatChain = heartbeatChain
          .then(() => health.heartbeat(operation, counters))
          .catch((error) => {
            heartbeatFailure ??= error;
          });
        return heartbeatChain;
      };
      const heartbeatTimer = setInterval(() => {
        void queueHeartbeat();
      }, HEARTBEAT_MS);
      heartbeatTimer.unref();
      let failed = false;
      try {
        while (!signal.aborted) {
          if (heartbeatFailure) throw heartbeatFailure;
          const claims: ClaimedIngestEvent[] = [];
          for (
            let index = 0;
            index < deps.config.ingestWorkerConcurrency;
            index += 1
          ) {
            const claim = await worker.claim(operation.id);
            if (!claim) break;
            claims.push(claim);
          }

          if (claims.length === 0) {
            try {
              await delay(IDLE_POLL_MS, undefined, { signal });
            } catch (error) {
              if (!signal.aborted) throw error;
            }
            continue;
          }

          counters.claimed += claims.length;
          const settlements = await Promise.allSettled(
            claims.map((claim) => worker.process(claim))
          );
          const receipts: IngestReceipt[] = [];
          for (const settlement of settlements) {
            if (settlement.status === "fulfilled") {
              receipts.push(settlement.value);
              continue;
            }
            if (settlement.reason instanceof LeaseLostError) {
              counters.leaseLost += 1;
              continue;
            }
            throw settlement.reason;
          }
          counters.indexed += receipts.filter(
            (receipt) => receipt.status === "indexed"
          ).length;
          counters.failed += receipts.filter(
            (receipt) => receipt.status === "failed"
          ).length;
          await queueHeartbeat();
          if (heartbeatFailure) throw heartbeatFailure;
        }
        if (heartbeatFailure) throw heartbeatFailure;
      } catch (error) {
        failed = true;
        await health.finishOperation(operation, "failed", {
          counters,
          errorCode: "worker_loop_failed",
        });
        throw error;
      } finally {
        clearInterval(heartbeatTimer);
        await heartbeatChain;
        if (!failed) {
          await health.finishOperation(operation, "stopped", { counters });
        }
      }
    },
  };

  return Object.freeze(worker);
}
