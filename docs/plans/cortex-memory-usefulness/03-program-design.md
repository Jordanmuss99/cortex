# Program Design: Cortex Memory You Can Trust

## Scope contract

This design implements the approved Product and Architecture gates without adding a UI, a public MCP tool, a second authentication system, a search service, or an external queue. The existing PostgreSQL corpus, REST route names, MCP tool names, and stdio MCP entry point remain compatible. New lifecycle behavior is centralized in `src/memory/`; all transports and automated writers become adapters.

The live connector baseline observed at `2026-08-28T05:10Z` is useful evidence, not an acceptance target: 1,919 active memories, 47,982 synapses, 157 currently labile memories, no agent ingests in seven days, no reflection-produced memory in about 1,058 hours, five consecutive degraded self-checks, and average synapse strength of 0.172. Dream and background-thread jobs were current, hippocampal and valence coverage were both 100%, and 73 skills had 95 recorded executions. This combination is exactly why corpus size and activity cannot stand in for capture health or task utility.

Migration `010_memory_lifecycle.sql` is assigned here because `009_oauth_authority.sql` is the only checked-in ordered migration at this gate. The implementation must re-check that namespace before its first slice; if another approved initiative has occupied `010`, Gate 3 is reopened rather than silently renumbering files mid-implementation.

The `oauth-token-and-agent-hardening` plan continues to own public identity, agent binding, route/tool allowlisting, private-network topology, and log redaction. This design changes no file under `oauth-gateway/`, exposes no lifecycle route through the hosted allowlist, and treats the OAuth integration suite as a required regression suite.

## Files

The following is the complete intended implementation surface. Planning/status files are excluded from this inventory. If implementation needs another production file, Gate 3 must be amended before that file is changed.

### Create

- `db/migrations/010_memory_lifecycle.sql` — add lifecycle columns, tables, constraints, indexes, telemetry reset, and runtime grants as one ordered additive migration.
- `src/memory/config.ts` — parse and validate the approved memory environment settings once per process.
- `src/memory/types.ts` — define transport-neutral ingest, retrieval, feedback, working-set, health, reconsolidation, operation-run, and evaluation contracts.
- `src/memory/index.ts` — construct one dependency-injected `MemoryServices` bundle for REST, MCP, workers, scripts, and tests.
- `src/memory/ingest.ts` — durably accept idempotent raw events, read status, wait for completion, and derive compatibility keys.
- `src/memory/ingest-worker.ts` — lease, prepare, project, graph-link, retry, and complete accepted ingest events without holding a transaction across provider work.
- `src/memory/retrieval.ts` — generate independent candidate lanes, fuse ranks, persist diagnostics, pack recall context, and mark only delivered items labile.
- `src/memory/feedback.ts` — idempotently record injection/use/citation/correction/harm and task outcomes; update confirmed-use counters once.
- `src/memory/working-set.ts` — enforce bounded active working memory and reconcile explicit journal updates.
- `src/memory/health.ts` — record operational runs and calculate lifecycle, scheduler, utilization, graph-distribution, readiness, and build metrics.
- `src/memory/evaluation.ts` — persist evaluation run/result metadata without copying private case text into PostgreSQL.
- `src/worker.ts` — run the long-lived PostgreSQL-backed ingest worker with heartbeat and graceful drain.
- `src/api/retrievals.ts` — provide the private retrieval-feedback adapter.
- `src/api/working-set.ts` — provide private agent-scoped working-set read/upsert/update adapters.
- `src/api/probes.ts` — provide reusable root `/livez` and `/readyz` probes with deliberately small response bodies for REST and native MCP hosts.
- `src/mcp/http.ts` — host `/mcp` native stateful Streamable HTTP sessions and the shared root probes in one long-lived process.
- `benchmarks/memory-usefulness/types.ts` — validate the private JSONL dataset and define runner/adapter contracts.
- `benchmarks/memory-usefulness/run.ts` — execute paired, seeded conditions under a locked dataset and common budget.
- `benchmarks/memory-usefulness/scoring.ts` — compute task uplift, harm, retrieval/utilization gaps, cluster bootstrap intervals, latency, and cost.
- `benchmarks/memory-usefulness/adjudication.ts` — export condition-blinded primary results, import idempotent human judgments, and finalize only a completely adjudicated comparison group.
- `benchmarks/memory-usefulness/README.md` — document the private dataset format, adjudication workflow, conditions, and release command.
- `scripts/run-memory-integration-tests.mjs` — provision and tear down a guarded disposable pgvector database for lifecycle tests.
- `scripts/run-memory-evaluation.mjs` — provision an isolated pgvector database, run the locked six-condition benchmark, and tear it down without touching the production corpus.
- `scripts/retry-memory-ingest.ts` — operator-only, agent-scoped requeue of one terminal failed event without copying or printing its raw content.
- `scripts/smoke-mcp-http.mjs` — exercise native Streamable HTTP initialize/list/call/delete and session reuse without replacing the stdio smoke test.
- `src/__tests__/memory-ingest.test.ts` — unit-test acceptance, idempotency, leasing, retry, exact reuse, and source replacement.
- `src/__tests__/memory-retrieval.test.ts` — unit-test read-only candidacy, lane fusion, temporal filtering, packing, and delivery.
- `src/__tests__/memory-feedback.test.ts` — unit-test feedback ownership, subsets, unknown states, races, and confirmed-use accounting.
- `src/__tests__/working-memory.test.ts` — unit-test bounds, expiry, reconfirmation, resolution, and boot ordering.
- `src/__tests__/reconsolidation-versioning.test.ts` — unit-test append-only successor creation and rollback behavior.
- `src/__tests__/memory-health.test.ts` — unit-test capture, scheduler, feedback, harm, graph percentile, and readiness warnings.
- `src/__tests__/memory-dream.test.ts` — unit-test confirmed-use scoring, rollout safety, synthesis gating, and telemetry retention.
- `src/__tests__/memory-evaluation.test.ts` — unit-test dataset locking, paired conditions, adjudication rules, and cluster bootstrap scoring.
- `src/__tests__/memory-api.test.ts` — unit-test HTTP status codes, compatibility fields, ownership, and private lifecycle routes.
- `src/__tests__/mcp-http.test.ts` — unit-test Streamable HTTP session creation/reuse/cleanup and metadata-only logging.
- `src/__tests__/reflection-ingest.test.ts` — unit-test stable event keys, multiple facts per source, operation runs, and credential-free fallback behavior.
- `src/__tests__/memory-lifecycle.integration.test.ts` — exercise migration 010 and the full durable lifecycle against disposable PostgreSQL.

### Change

- `src/db/schema.ts` — project migration 010 into Drizzle, including agent-scoped composite relationships.
- `src/db/migrations.ts` — require both migrations 009 and 010 and rename the schema-wide advisory-lock identity.
- `src/index.ts` — construct shared services once, mount the new private routers/probes, and expose one build identity.
- `src/api/ingest.ts` — replace provider/database logic with validation plus `IngestService` calls and `202` handling.
- `src/api/search.ts` — delegate to retrieval while retaining a compatibility `hybridSearch()` wrapper for internal callers.
- `src/api/recall.ts` — delegate candidate generation, token packing, and final delivery to retrieval.
- `src/api/reconsolidate.ts` — return durable event/predecessor/successor IDs and support bounded asynchronous completion.
- `src/api/vitals.ts` — become a thin serializer over the shared health snapshot.
- `src/api/health.ts` — report the shared build identity and stop presenting corpus activity as readiness.
- `src/api/cognition.ts` — exclude expired cognitive artifacts from ordinary reads while preserving explicit historical access.
- `src/api/graph.ts` — show only current-valid same-agent endpoints in ordinary graph views while retaining historical access through provenance queries.
- `src/reconsolidation/index.ts` — replace in-place mutation with event-backed append-only versioning while preserving compatibility exports.
- `src/proprioception/journal.ts` — reconcile active threads, explicit resolutions, and concerns into bounded working items in the journal transaction.
- `src/cognition/background-threads.ts` — upsert a successful strategic `next_action` as a stable expiring open-loop working item.
- `src/metacognition/audit.ts` — mark generated artifacts with metacognition origin and exclude expired inputs from ordinary analysis.
- `src/metacognition/inner-monologue.ts` — mark generated artifacts with metacognition origin and exclude expired entries from ordinary reads.
- `src/metacognition/reasoning.ts` — mark generated artifacts with metacognition origin and exclude expired traces from ordinary reads.
- `src/proprioception/self-check.ts` — consume lifecycle health, make skill-creation age informational, and stop relying on host files in headless mode.
- `src/dream/dream-cycle.ts` — use confirmed use/outcomes, protect unknown-utility memories during rollout, disable synthesis by default, and expire bounded telemetry.
- `src/ingestion/embeddings.ts` — expose normalized vectors with provider/model identity and reject wrong dimensions or non-finite values.
- `src/ingestion/entities.ts` — keep deterministic extraction available when optional LLM enrichment fails and emit only sanitized warning codes.
- `src/ingestion/synapse-formation.ts` — add a replay-safe mode so worker retries cannot inflate graph activation.
- `src/ingestion/surprise-gating.ts` — retain a diagnostic compatibility wrapper but remove priority/resonance mutation and filter comparison inputs to current-valid memory.
- `src/hippocampus/types.ts` — make CA1 novelty a diagnostic result without adjusted priority or resonance fields.
- `src/hippocampus/index.ts` — expose the diagnostic-only hippocampal encoding signature.
- `src/hippocampus/ca1-novelty.ts` — compare only current-valid same-agent nodes and return bounded novelty diagnostics without storage-policy mutation.
- `src/hippocampus/ca3-pattern-completion.ts` — exclude non-current nodes during seed and neighbor expansion so superseded codes cannot consume the bounded graph lane.
- `src/ingestion/ingest-markdown.ts` — turn markdown/corpus ingestion into stable `replace_source` event submission and receipt aggregation.
- `src/ingestion/ingest-telegram.ts` — submit stable source-snapshot events instead of deleting and reinserting nodes.
- `src/ingestion/ingest-limitless.ts` — submit stable source-snapshot events instead of deleting and reinserting nodes.
- `src/perception/screen-observer.ts` — submit timestamp-keyed observation events and return a lifecycle receipt.
- `src/watcher.ts` — consume accepted/indexed receipts and distinguish queued work from completed indexing.
- `src/mcp/server.ts` — export a per-session server factory and route ingest/search/recall/init/journal/reconsolidate/vitals through shared services while preserving stdio.
- `scripts/cortex-memory-gateway.py` — remove semantic/source-time write suppression, await durable acceptance, carry retrieval IDs, and report actual injection.
- `scripts/hooks/cortex-session-start.mjs` — consume working context/retrieval IDs and acknowledge only the memories actually printed into context.
- `scripts/hooks/cortex-user-prompt-submit.mjs` — consume recall IDs and acknowledge only the memories actually emitted to the host.
- `scripts/reflect-cursor.ts` — require configured fallback credentials, remove similarity-as-idempotency, submit stable events, and record durable run success/failure.
- `scripts/reflect-multi.ts` — use the same event/receipt and operational-run rules as the production reflection path.
- `scripts/autoresearch/cortex-roundtrip-evaluator.ts` — wait on accepted events, track retrieval IDs, and emit outcome feedback without treating retrieval as success.
- `scripts/gateway-ab-test.py` — replace the invalid absolute score threshold and keyword-overlap proxy with paired outcome/injection reporting.
- `scripts/cleanup-duplicates.py` — become a non-destructive exact/provenance diagnostic and stop recommending empty-content reconsolidation.
- `scripts/cleanup-junk-entities.ts` — remove the direct projection/edge mutation mode and remain a read-only diagnostic until a lifecycle-backed repair operation is separately designed.
- `scripts/scrub-em-dashes.ts` — remove in-place historical artifact rewriting and become a read-only report; new writes remain sanitized at their existing boundaries.
- `scripts/backfill-hippocampal.ts` — call the diagnostic-only CA1 signature while preserving guarded backfill behavior.
- `scripts/backfill-novelty.ts` — call the diagnostic-only CA1 signature and update novelty only.
- `scripts/verify-novelty-fix.ts` — verify bounded/current novelty without asserting the retired priority/resonance contribution.
- `benchmarks/lib/cortex-client.ts` — refuse non-disposable databases, reset complete benchmark lifecycle state safely, and seed/retrieve through shared services while exposing retrieval evidence IDs.
- `benchmarks/cogbench/client.ts` — enforce the same disposable-database guard and replace direct node writes/candidate labile writes with lifecycle helpers.
- `benchmarks/cogbench/tasks/reconsolidation.ts` — assert predecessor/successor history instead of same-row mutation.
- `benchmarks/cogbench/tasks/cross-agent-transfer.ts` — import transferred memories as provenance-bearing events rather than raw SQL rows.
- `benchmarks/cogbench/README.md` — document lifecycle-aware benchmark semantics and distinguish diagnostics from the product metric.
- `src/__tests__/search.test.ts` — retain compatibility coverage while asserting that candidates do not mutate memory.
- `src/__tests__/drizzle-array-cast.test.ts` — remove candidate-access expectations and retain only delivered/feedback array-write regressions.
- `src/__tests__/screen-observer.test.ts` — assert observation receipts and stable keys instead of direct node IDs.
- `src/__tests__/mcp-import-security.test.ts` — retain import-root protections across the server-factory and async-ingest refactor.
- `src/__tests__/oauth-database.integration.test.ts` — separate OAuth-specific migration assertions from application-required migration 010 without weakening any denial test.
- `.env.example` — document build, worker, retrieval, synthesis, evaluation, provider-timeout, and runtime-database settings without embedding credentials.
- `package.json` — add worker, native MCP, causal evaluation, guarded memory-integration, and operator ingest-retry commands.
- `Dockerfile` — remove Supergateway, expose the native MCP entry point, and retain compiled migration/runtime artifacts.
- `docker-compose.yml` — add the worker, use native `/mcp`, switch the MCP container check from Supergateway `/healthz` to `/livez`, share build identity, and preserve OAuth-owned private/public boundaries.
- `README.md` — document durable acceptance, lifecycle states, worker operation, and current limitations.
- `CONTRIBUTING.md` — document service boundaries, migration-only DDL, and required lifecycle tests.
- `BENCHMARKS.md` — make the causal product metric primary and retrieval-only benchmarks diagnostic.
- `CORTEX_TECHNICAL_REFERENCE.md` — document event provenance, versioning, working memory, retrieval fusion, feedback, and probes.

### Explicitly unchanged

- `oauth-gateway/**` and its public route/tool catalog remain owned by the OAuth-hardening plan.
- Existing benchmark datasets and result JSON files are never rewritten by implementation.
- Legacy memory rows are not given fabricated ingest events or fabricated use evidence.
- `scripts/smoke-mcp.mjs` remains the stdio compatibility smoke; the new HTTP smoke is separate.
- No dashboard, graph UI, or other screen is added.

## Types & signatures

The declarations below are the program contract. Names can change only through an amended Gate 3; implementation bodies are intentionally absent.

### Configuration and dependency boundary

```ts
export interface MemoryConfig {
  buildId: string;
  projectionVersion: string;
  retrievalVersion: string;
  ingestWorkerConcurrency: number;
  ingestMaxAttempts: number;
  embeddingTimeoutMs: number;
  retrievalCandidateLimit: number;
  retrievalTelemetryRetentionDays: number;
  synthesisEnabled: boolean;
  ca3Enabled: boolean;
}

export function loadMemoryConfig(env?: NodeJS.ProcessEnv): MemoryConfig;

export interface SynapseFormationOptions {
  replaySafe: boolean;
  ingestEventId?: string;
}

export interface PatternCompletionCandidate {
  memoryId: number;
  activationScore: number;
}

export interface EntityEnrichmentResult {
  entities: string[];
  warnings: string[];
}

export interface SparseCode {
  indices: number[];
  values: number[];
  dim: number;
}

export interface NoveltyResult {
  noveltyScore: number;
  predictedSimilarity: number;
  sparseMismatch: number;
}

export interface HippocampalEncoding {
  sparseCode: SparseCode;
  noveltyResult: NoveltyResult;
}

export interface MemoryServiceDependencies {
  db: typeof db;
  sql: Sql;
  config: MemoryConfig;
  now(): Date;
  newId(): string;
  embedTexts(input: readonly string[]): Promise<EmbeddedBatch>;
  embedQuery(input: string): Promise<EmbeddedVector>;
  enrichEntities(input: string): Promise<EntityEnrichmentResult>;
  formSynapses(agentId: number, memoryIds: readonly number[], options: SynapseFormationOptions): Promise<number>;
  patternComplete(agentId: number, embedding: readonly number[], limit: number): Promise<readonly PatternCompletionCandidate[]>;
}

export interface MemoryServices {
  ingest: IngestService;
  retrieval: RetrievalService;
  feedback: FeedbackService;
  workingSet: WorkingSetService;
  health: MemoryHealthService;
  evaluation: MemoryEvaluationStore;
}

export function createMemoryServices(overrides?: Partial<MemoryServiceDependencies>): MemoryServices;
```

`CORTEX_BUILD_ID` is required in headless production and may fall back to `dev` only outside headless mode. Projection/retrieval versions are code constants changed whenever their persisted semantics change, not operator-selected environment values. Initial defaults and accepted ranges are worker concurrency `4` (`1..32`), attempts per retry cycle `5` (`1..20`), embedding timeout `20,000ms` (`1,000..120,000`), persisted retrieval candidate limit `100` (`50..500`), and non-returned detailed telemetry retention `30d` (`7..365`). Returned/evidence-linked retrieval detail uses a versioned code constant of `365d`; changing that privacy/incident-review balance requires an amended Gate 3 rather than an unreviewed environment toggle. Search/recall result limits are `1..50`. Public recall preserves its existing default `4,000` and MCP-compatible integer range `256..32,000` tokens across REST and MCP; init retains its stricter fixed bound. Invalid configuration fails process startup rather than silently clamping. The production configuration defaults CA3 off; only the private evaluation runner can opt a recorded condition into `enableCA3` during this feature. Promoting graph expansion into ordinary retrieval requires measured incremental lift and an amended configuration contract.

### Persistence shape

Migration 010 creates application-generated UUID primary keys and UTC `TIMESTAMPTZ` lifecycle timestamps. String states use `CHECK` constraints rather than PostgreSQL enums so future additive states do not require type replacement. Every scalar lifecycle reference that can carry user memory includes `agent_id` in a composite foreign key; each referenced agent-owned parent has `UNIQUE (id, agent_id)` in addition to its primary key. The approved derived-source ID array is the sole non-scalar exception and is protected by an insert/update constraint trigger that requires a nonempty unique array of existing current nodes for the event's agent. Application checks are never the only isolation control.

- `memory_ingest_events`: `id`, `agent_id`, `idempotency_key`, immutable `raw_content`, canonical caller-request hash, `content_hash`, `source`, `source_version`, `source_type`, observed/fact-validity timestamps plus whether observation time was caller supplied, requested and effective priority, supplied entity/tag arrays, `projection_mode`, optional `predecessor_memory_id`, optional internal derivation relation/confidence/expiry and same-agent source-memory ID array, `force_new_projection`, bounded request/session metadata, optional opaque transfer receipt/content hash, status, total/cycle attempt counts, manual-retry count, lease/retry fields, bounded sanitized failure code/message and warning-code array, possible-update IDs, projection/synapse counts, accepted/started/projected/indexed/updated timestamps, immutable acceptance build ID, nullable indexed build ID, immutable nullable first-terminal-failure timestamp/build ID, nullable latest-terminal-failure timestamp/build ID plus terminal-failure-transition count, and nullable source-snapshot `snapshot_valid_until`/`replaced_by_event_id`. Fact validity, derivation expiry, and source-snapshot currentness are distinct fields. Unique `(agent_id, idempotency_key)`; a reused caller key with a different request hash is a conflict; content must be nonblank; validity intervals, derivation confidence, priority, and state transitions are constrained. The first terminal-failure pair is set once; later manual retry/failure cycles update only latest evidence and the transition count. Stored/logged failure text is allowlisted or provider-sanitized and never includes raw content, provider bodies, headers, or credentials.
- `memory_nodes`: nullable `ingest_event_id`, nullable `ingest_chunk_index`, nullable legacy-compatible `content_hash`, non-null-for-new-row `projection_fingerprint`, embedding provider/model, nullable `derivation_expires_at`, bounded nullable diagnostic `novelty_score`, versioned `resonance_components`, and a stored generated `search_document` assembled from content, summary, entities, and tags with a GIN index. New rows require projection metadata in service validation, `(ingest_event_id, ingest_chunk_index)` is unique when both are present, and `superseded_by` becomes an agent-scoped composite self-reference. Fact `valid_until` and derivation expiry remain separate; ordinary currentness requires both open, so the earlier boundary wins without destroying either value. New rows begin `status='pending'` and become `active` only in the event's final indexing transaction. Migration 010 drops the misleading `last_accessed_at DEFAULT NOW()`; new projections start with `access_count=0`, `last_accessed_at=NULL`, and `last_recalled_at=NULL`, so creation is not recorded as use or delivery. It also resets legacy resonance to neutral `0.5` with a pending-recalculation version because the old unbounded score incorporated polluted access. Corrected, obsolete-before-activation, or orphaned replaced projections use `status='superseded'` as well as a closed validity interval; ordinary legacy readers that already filter `status='active'` therefore cannot surface pending/history rows accidentally. The legacy `source` field remains descriptive, not authoritative for shared-projection currentness.
- `memory_provenance`: `id`, `agent_id`, `memory_id`, optional `ingest_event_id`, optional `source_memory_id`, relation, and creation time. At least one source is required; self-links and cross-agent links are rejected; the relation tuple is unique. A node reused by several captures has one event-provenance row per capture, so current source support is not inferred from `memory_nodes.source`. Event support is current only when the event is indexed and its source-snapshot validity is open; pending, rejected, failed, or replaced events never keep a node current.
- `working_memory_items`: `id`, `agent_id`, `caller_key`, kind, content, source memory/event, status, display order, importance, confirmation/expiry/resolution timestamps and reason, plus creation/update times. Unique `(agent_id, caller_key)` and checks enforce bounds on values; the service enforces the active-item count under an agent lock.
- `memory_retrievals`: `id`, `agent_id`, nullable request/session IDs, nullable query plus query hash, channel, status/error code, algorithm/build versions, token budget, candidate/returned counts, latency, creation/completion times, and `redacted_at`. Raw query and correlation IDs are cleared after the configured detailed-retention window while aggregate/evidence lineage remains.
- `memory_retrieval_items`: `id`, `agent_id`, retrieval ID, exactly one memory/working-item/cognitive-artifact reference, item content hash, candidate lanes, component rank/score JSON, final score/rank, and returned/injected/used/known-unused/cited/corrected/harmful timestamps. Unique per retrieval/item; evidence timestamps are append-only. If delayed positive use follows a complete-attribution unused observation, both remain auditable and `used` wins the derived state.
- `memory_retrieval_feedback_events`: immutable `id`, `agent_id`, retrieval ID, caller idempotency key, canonical request hash, use-attribution completeness, the five reported retrieval-item ID arrays, and creation time. Unique `(agent_id, retrieval_id, idempotency_key)` makes a multi-item feedback retry atomic and auditable; reusing a key with different feedback is a conflict.
- `memory_task_outcomes`: `id`, `agent_id`, optional retrieval and latest feedback-event IDs, caller task key, status/score/evaluator, correction/repetition/harm observations, latency/token counts, immutable observation build ID, bounded notes, and creation/update times. Unique `(agent_id, caller_task_key)`; `unknown` may advance once to a known result, identical known evidence is a replay, and a conflicting known result is rejected while the original remains unchanged. Score bounds and field/status consistency are constrained. Linked outcome rollups inherit the parent retrieval's build/version pair; unlinked outcomes use their observation build and the reserved `not_applicable` retrieval partition.
- `memory_evaluation_runs`: `id`, comparison-group ID, condition, fingerprint version, execution-instance ID, locked dataset and sampling-manifest hash/version, expected case-descriptor and primary-case ID digests/counts, fixed evaluation-as-of timestamp, model/prompt/seed/budgets, build/retrieval versions, evaluator identity, state, per-arm result-descriptor and primary-ID digests/counts, aggregate JSON, final report hash, interval bounds, and start/completion times. The lowercase SHA-256 comparison-group ID is computed from every condition-independent field including the execution instance and a fixed fingerprint version; a database trigger recomputes it, so two different settings cannot claim the same group even under concurrent direct writes. Unique `(comparison_group_id, condition)` permits exactly one arm per condition. Exact start replay returns the existing run; a changed replay conflicts and a completed/failed run is never reopened. Retries reuse the execution-instance ID; a genuinely fresh attempt generates a new ID and therefore a new group without changing experimental settings.
- `memory_evaluation_results`: `id`, run ID, opaque case/cluster IDs, split/memory-needed flags, setup-event-to-gold-evidence mapping digest, integer rubric score basis points/task status/harm, evidence ID arrays plus use-attribution completeness, latency/tokens, opaque adjudication ID, output/packet/receipt hashes, blinded human adjudication state, opaque human evaluator ID, and creation/update times. Unique `(run_id, case_id)` makes restart recording deterministic: an exact result replay is inert and a conflicting replay fails. Private prompts, raw histories, outputs, tool arguments, rubrics, gold answers, human names/email, and condition labels in adjudication packets are not stored here.
- `memory_operation_runs`: `id`, optional `agent_id`, operation, status, build/worker identity, bounded counters/error code, and started/heartbeat/completed times. It supplies worker readiness and distinguishes a successful zero-output reflection from a missing run.
- `memory_daily_metrics`: `id`, `agent_id`, UTC metric day, build/retrieval versions, content-free capture/index/retrieval/error/empty/returned/injected/used/cited/corrected/item-harm/outcome-harm/outcome/feedback counters, bounded latency/token histogram JSON, rollup watermark, and created/updated times. Unique `(agent_id, metric_day, build_id, retrieval_version)` makes reruns idempotent. No query, content, request/session ID, raw evidence ID, or user identity is copied into a rollup.
- `cognitive_artifacts`: migration 010 adds `origin`, lifecycle `status`, and `expired_at`. Existing rows receive `origin='legacy_unknown'` and remain active. New producers identify `user`, `dream`, `metacognition`, `background`, or `reconsolidation` origin. Only automatically generated dream/metacognition/background artifacts are eligible for age/use expiry; user, reconsolidation/correction, and legacy-unknown artifacts are excluded. Retrieval-item evidence is the authority for whether an artifact was returned or used. Expiry only changes lifecycle state and therefore does not erase an artifact that also informed a later durable ingest event.

Hot-path indexes are explicit: claimable events by `(status, next_attempt_at, lease_expires_at, accepted_at)`; source snapshots by `(agent_id, source, accepted_at)` for `replace_source`; new-node projection fingerprint by agent/current status; working items by `(agent_id, status, expires_at, display_order)`; retrieval headers by `(agent_id, created_at)`; retrieval items by retrieval/final rank and by memory/artifact/returned time; operation runs by `(operation, status, heartbeat_at)`; daily metrics by agent/day/version; evaluation results by run/case/condition; active cognitive artifacts by agent/type/created time; and every foreign-key column. Partial indexes exclude terminal/history rows where the query is only for current/pending data.

Migration 010 also adds `agent_id` to `memory_synapses`, replaces its endpoint constraints with `(memory_a, agent_id)` and `(memory_b, agent_id)` composite foreign keys, and converts the existing hippocampal-code and emotional-valence memory links to `(memory_id, agent_id)` composite foreign keys. Before altering or backfilling, a preflight query rejects any dangling/cross-agent legacy successor, edge, code, or valence row and reports only the offending count; the migration never guesses ownership or deletes the row. Existing procedural source-ID arrays remain legacy data and are not treated as enforceable lineage; new episodic derivation uses normalized `memory_provenance`.

Migration 010 creates a NOLOGIN `cortex_memory_runtime` group role with the required DML/sequence access to Cortex memory/cognition tables, read-only access to `agents(id, external_id)`, no DDL, and no access to OAuth authority/audit tables. Production supplies a separately provisioned login to each memory process through the existing `DATABASE_URL`. The OAuth-owned migration/owner URL remains separate. The integration runner provisions a disposable login and denial-tests the grants; source code and example configuration contain no password.

### Durable ingest

```ts
export type IngestStatus = "accepted" | "processing" | "indexed" | "failed" | "rejected";
export type ProjectionMode = "append" | "replace_source" | "reconsolidate";

export declare class IdempotencyConflictError extends Error {
  readonly code: "idempotency_key_reused";
  readonly resourceType: "ingest" | "retrieval_feedback" | "task_outcome";
  readonly existingId: string;
}

export interface ExternalProvenanceReceipt {
  kind: "authorized_transfer";
  transferReceiptId: string;
  originContentHash: string;
}

export interface DerivedProvenanceInput {
  relation: "derived_from" | "consolidates";
  sourceMemoryIds: readonly [number, ...number[]];
  confidence: number;
  expiresAt: string;
}

export interface AcceptIngestInput {
  agentId: number;
  content: string;
  idempotencyKey?: string;
  source?: string | null;
  sourceVersion?: string | null;
  sourceType: string;
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  requestedPriority: 0 | 1 | 2 | 3 | 4;
  providedEntities?: readonly string[];
  providedSemanticTags?: readonly string[];
  requestId?: string | null;
  sessionId?: string | null;
  projectionMode?: ProjectionMode;
  predecessorMemoryId?: number | null;
  forceNewProjection?: boolean;
  externalProvenance?: ExternalProvenanceReceipt | null;
  derivedProvenance?: DerivedProvenanceInput | null;
}

export interface IngestReceipt {
  eventId: string;
  status: IngestStatus;
  replayed: boolean;
  nodeIds: number[];
  effectivePriorities: number[];
  chunksStored: number;
  synapsesFormed: number;
  totalAttempts: number;
  manualRetryCount: number;
  possibleUpdateOf: number[];
  acceptedAt: string;
  startedAt?: string;
  indexedAt?: string;
  nextAttemptAt?: string;
  failure?: { code: string; retryable: boolean };
  warnings: string[];
}

export interface ClaimedIngestEvent {
  eventId: string;
  agentId: number;
  attempt: number;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  projectionAlreadyCommitted: boolean;
}

export interface IngestService {
  accept(input: AcceptIngestInput): Promise<IngestReceipt>;
  get(agentId: number, eventId: string): Promise<IngestReceipt | null>;
  wait(agentId: number, eventId: string, timeoutMs: number): Promise<IngestReceipt>;
  retryTerminalFailure(agentId: number, eventId: string): Promise<IngestReceipt | null>;
  deriveLegacyKey(input: Omit<AcceptIngestInput, "idempotencyKey">): string;
}

export interface IngestWorker {
  claim(workerId: string): Promise<ClaimedIngestEvent | null>;
  process(claim: ClaimedIngestEvent): Promise<IngestReceipt>;
  run(signal: AbortSignal): Promise<void>;
}

export function createIngestService(deps: MemoryServiceDependencies): IngestService;
export function createIngestWorker(deps: MemoryServiceDependencies): IngestWorker;
```

The derived legacy key and canonical caller-request hash cover the exact caller-supplied payload: agent, content, source, source version/type, priority, normalized supplied tags/entities, projection mode, predecessor, external or derived provenance, and each temporal field represented either by its normalized instant or a literal omitted sentinel. Server-generated defaults are never fed back into that key. Consequently, an omitted `observedAt` is stored as the event's acceptance time plus `observed_at_was_defaulted=true`, yet the same retry under a later clock derives the same key and request hash. Semantic similarity and source-time windows have no part in idempotency. Caller-supplied keys are unique per agent. An exact payload replay returns the original event forever; reusing the key for a different canonical request throws `IdempotencyConflictError` and maps to HTTP `409`/an MCP conflict error instead of silently returning unrelated work.

A distinct event with identical content still gets its own immutable event and provenance. It may reuse an event-backed current projection only when a projection fingerprint over normalized chunk content, fact validity, effective priority, normalized final entities/tags, derivation relation/confidence/expiry when present, projection algorithm version, and embedding provider/model also matches. Source/path/version and derived source IDs are deliberately excluded and remain separate provenance. Legacy nodes with unknown provenance are never reused: the new event receives its own projection so a later source replacement cannot accidentally retire unexplained legacy evidence. `replace_source` requires both source and source version; `reconsolidate` requires a current predecessor and always forces a new projection. Valid timestamps must be ISO-8601 instants with `validUntil > validFrom` when both exist. Omitted fact validity remains unknown/open rather than being invented. Reconsolidation sets the successor's `validFrom` and predecessor's end to the atomic commit time. File adapters always supply observed time and a source version derived from canonical path, file metadata, and content hash, so restoring an older file body later creates a new snapshot event instead of replaying its historical event.

`externalProvenance` is internal-only and records an opaque authorized-transfer receipt plus origin content hash; it never contains or references a source agent/memory identifier. `derivedProvenance` is also internal-only: it requires one or more unique current source memories owned by the target agent, confidence in `[0,1]`, and an expiry later than the event's effective validity start. Acceptance stores fact `validUntil` and derivation `expiresAt` separately; projection creates one normalized provenance edge per output/source pair and copies expiry to `derivation_expires_at`. Retrieval requires both fact validity and derivation expiry to remain open, so the earlier boundary controls currentness without overwriting either record. Public REST/MCP adapters reject both internal fields. The target projection is linked to its own target-agent event. Actual transfer authorization remains outside this feature and the hosted MCP surface gains no transfer tool.

The existing priority policy remains centralized at acceptance: machine `api`/`reflection`/`session` captures cannot become P0/P1 unless the already-supported high-priority override is explicitly enabled, and observations are at least P3. Both requested and effective values are auditable; novelty/similarity never changes either one.

The worker uses short leases and `FOR UPDATE SKIP LOCKED`. Provider work occurs outside a database transaction. Before committing prepared results, the worker locks the event and verifies the attempt's random lease token is still current; a worker that lost its lease discards its prepared result. The first transaction inserts `pending` projection rows, codes, valence, and provenance and sets `projected_at`; it does not close a current source/predecessor or expose the nodes. The partial event/chunk uniqueness constraint is the database backstop against duplicate projection. Bounded graph candidates are computed without mutation. One final transaction revalidates the lease and any source/predecessor locks, inserts replay-safe synapses, activates the pending nodes, closes replaced/corrected currentness, and sets `indexed_at`. A crash before finalization resumes from event-linked pending nodes; a crash after commit sees an indexed event, so it cannot insert or strengthen twice. Automatic retries stop when the current cycle reaches its configured ceiling. The operator command calls `retryTerminalFailure()`, increments `manual_retry_count`, resets only the cycle counter/error/next-attempt state, and requeues the same event; total attempts and raw evidence remain intact.

For `replace_source`, acceptance time plus event ID defines a total order within `(agent, source)`; source-version strings are identities, not sortable clocks. The commit takes a transaction-scoped source lock. If a newer snapshot is already indexed, older late work becomes `rejected` with safe code `obsolete_source_snapshot` and cannot change currentness. Otherwise the prepared snapshot links all new/reused projections, closes prior indexed snapshot events through `snapshot_valid_until`, and marks only nodes with no remaining current event provenance as `status='superseded'`; its `valid_until` becomes the earlier of any fact-validity end and replacement time. An unchanged chunk, or a projection supported by another current source, therefore stays current. On the first lifecycle-managed refresh, active legacy rows with the same agent/source are superseded only after the new snapshot commits; they are not treated as shareable because their original support is unknowable. Failed or merely pending newer refreshes leave the last successfully indexed snapshot and all its links current. Exact-reuse decisions are revalidated under the commit lock. For `reconsolidate`, eligibility is checked and recorded at acceptance time, so a correction accepted inside the one-hour labile window does not become invalid merely because the worker queue is slow.

### Provider and enrichment results

```ts
export interface EmbeddedVector {
  values: number[];
  provider: string;
  model: string;
  dimensions: number;
  normalized: true;
}

export interface EmbeddedBatch {
  vectors: EmbeddedVector[];
  provider: string;
  model: string;
}

export async function embedTextsWithMetadata(texts: readonly string[]): Promise<EmbeddedBatch>;
export async function embedQueryWithMetadata(query: string): Promise<EmbeddedVector>;
export async function extractEntitiesWithDiagnostics(text: string): Promise<EntityEnrichmentResult>;
export async function hippocampalEncode(agentId: number, denseEmbedding: readonly number[]): Promise<HippocampalEncoding>;
```

Every accepted vector is finite, exactly 1,024 dimensions, and L2-normalized. Invalid provider results fail the event with a bounded retryable code; they never enter pgvector or exact-dedup logic.

Embedding is required and a failure retries the event. Entity/tag enrichment always runs the deterministic path; optional LLM enrichment may supplement it, but timeout, missing credentials, malformed output, or provider failure falls back to deterministic results and records `entity_enrichment_degraded` without raw provider output. Deterministic hippocampal/valence generation is part of the atomic projection and must pass validation rather than silently lowering coverage.

CA1 novelty remains a bounded `[0,1]` diagnostic over current-valid same-agent neighbors. It can populate `novelty_score` and `possibleUpdateOf`, but it cannot change requested/effective priority, resonance, acceptance, or projection reuse. That removes a second hidden storage-policy path while preserving CogBench novelty diagnostics.

### Retrieval and recall

```ts
export type RetrievalChannel = "search" | "recall" | "init" | "hook" | "gateway" | "evaluation";
export type RetrievalLane = "working" | "lexical" | "vector" | "entity" | "graph" | "artifact";
export type RetrievalItemKind = "memory" | "working_item" | "artifact";

export interface RetrieveInput {
  agentId: number;
  query: string;
  channel: RetrievalChannel;
  requestId?: string | null;
  sessionId?: string | null;
  limit: number;
  tokenBudget?: number;
  enableCA3?: boolean;
}

export interface ComponentRank {
  lane: RetrievalLane;
  rank: number;
  sourceScore?: number;
}

export interface LaneCandidateBase {
  lane: RetrievalLane;
  sourceRank: number;
  sourceScore?: number;
  content: string;
}

export type LaneCandidate = LaneCandidateBase & (
  | { kind: "memory"; memoryId: number; workingItemId?: never; artifactId?: never }
  | { kind: "working_item"; memoryId?: never; workingItemId: string; artifactId?: never }
  | { kind: "artifact"; memoryId?: never; workingItemId?: never; artifactId: number }
);

export interface FusedCandidateBase {
  content: string;
  fusedScore: number;
  componentRanks: ComponentRank[];
}

export type FusedCandidate = FusedCandidateBase & (
  | { kind: "memory"; memoryId: number; workingItemId?: never; artifactId?: never }
  | { kind: "working_item"; memoryId?: never; workingItemId: string; artifactId?: never }
  | { kind: "artifact"; memoryId?: never; workingItemId?: never; artifactId: number }
);

export interface RetrievalProvenance {
  eventId: string;
  source: string | null;
  sourceType: string;
  relation: "captured_from" | "corrects" | "derived_from" | "consolidates";
  confidence: number | null;
  acceptedAt: string;
}

export interface RetrievedItemBase {
  retrievalItemId: string;
  content: string;
  source: string | null;
  priority: number | null;
  currentness: number;
  score: number;
  finalRank: number;
  componentRanks: ComponentRank[];
  reasons: string[];
  provenance: RetrievalProvenance[];
  provenanceTruncated: boolean;
}

export type RetrievedItem = RetrievedItemBase & (
  | { kind: "memory"; memoryId: number; resonance: number | null; workingItemId?: never; artifactId?: never; artifactType?: never; artifactContent?: never }
  | { kind: "working_item"; memoryId?: never; resonance?: never; workingItemId: string; artifactId?: never; artifactType?: never; artifactContent?: never }
  | { kind: "artifact"; memoryId?: never; resonance?: never; workingItemId?: never; artifactId: number; artifactType: string; artifactContent: unknown }
);

export interface PreparedRetrieval {
  retrievalId: string;
  algorithmVersion: string;
  buildId: string;
  candidates: RetrievedItem[];
  elapsedMs: number;
  warnings: string[];
}

export interface RetrievalResponse {
  retrievalId: string;
  algorithmVersion: string;
  buildId: string;
  results: RetrievedItem[];
  candidateCount: number;
  returnedCount: number;
  elapsedMs: number;
  warnings: string[];
}

export interface RecallResponse extends RetrievalResponse {
  context: string;
  tokenBudget: number;
  tokensUsed: number;
}

export interface RestRecallWireResponse {
  query: string;
  agentId: string;
  context: string;
  memories: Array<{ id: number; content: string; source: string | null; score: number }>;
  artifacts: Array<{ id: number; type: string; content: unknown }>;
  tokenCount: number;
  tokenBudget: number;
  retrievalId: string;
  algorithmVersion: string;
  buildId: string;
  results: RetrievedItem[];
  warnings: string[];
}

export type McpRecallWireResult =
  | { retrieval_item_id: string; kind: "memory"; memory_id: number; working_item_id?: never; artifact_id?: never; content: string; score: number; final_rank: number }
  | { retrieval_item_id: string; kind: "working_item"; memory_id?: never; working_item_id: string; artifact_id?: never; content: string; score: number; final_rank: number }
  | { retrieval_item_id: string; kind: "artifact"; memory_id?: never; working_item_id?: never; artifact_id: number; content: string; score: number; final_rank: number };

export interface McpRecallWireData {
  query: string;
  token_budget: number;
  tokens_used: number;
  memories: Array<{
    memory_id: number;
    source: string | null;
    priority: number | null;
    resonance: number | null;
    score: number;
    content: string;
  }>;
  retrieval_id: string;
  algorithm_version: string;
  results: McpRecallWireResult[];
  warnings: string[];
}

export interface InitCompatibilityFields {
  loadedAt: string;
  systemStatus: {
    activeMemories: number;
    synapses: number;
    avgResonance: number;
    lastDreamCycle: string | null;
  };
  activeEntities: Array<{ name: string; mentions: number }>;
  recentArtifacts: Array<{
    retrievalItemId: string;
    artifactId: number;
    artifactType: string;
    content: Readonly<Record<string, unknown>>;
    resonance: number | null;
    createdAt: string;
  }>;
}

export interface InitMemoryContext {
  compatibility: InitCompatibilityFields;
  workingItems: WorkingItem[];
  retrieval: RetrievalResponse;
  context: string;
  tokensUsed: number;
}

export interface RetrievalService {
  prepare(input: RetrieveInput): Promise<PreparedRetrieval>;
  deliver(prepared: PreparedRetrieval, selected: readonly RetrievedItem[]): Promise<RetrievalResponse>;
  search(input: RetrieveInput): Promise<RetrievalResponse>;
  recall(input: RetrieveInput): Promise<RecallResponse>;
  init(agentId: number, sessionId?: string, queryHint?: string): Promise<InitMemoryContext>;
}

export interface RankFusionOptions {
  k: 60;
  weights: Readonly<Record<RetrievalLane, number>>;
}

export declare const RECALL_MEMORY_BUDGET_FRACTION: 0.8;
export declare const RECALL_ARTIFACT_BUDGET_FRACTION: 0.2;
export function fuseCandidateRanks(lanes: ReadonlyMap<RetrievalLane, readonly LaneCandidate[]>, options: RankFusionOptions): FusedCandidate[];
export function packRecallContext(items: readonly RetrievedItem[], tokenBudget: number): { selected: RetrievedItem[]; context: string; tokensUsed: number };
export function createRetrievalService(deps: MemoryServiceDependencies): RetrievalService;
```

Lexical (`websearch_to_tsquery` over the generated GIN document), vector, entity/tag, working-set, and optional graph lanes are queried independently under the same agent/current-valid filters. Recall and init additionally use a bounded active cognitive-artifact lane; ordinary search does not. Recall preserves its existing split by reserving 80% of the requested budget for ranked memory/working items and 20% for at most five recent active artifacts; unused reservation is not silently reallocated during this compatibility phase. Init applies its own stricter bounds described below. CA3 also filters currentness before its bounded seed/neighbor limits so superseded codes cannot crowd out active nodes. Reciprocal-rank fusion uses `k=60`; initial lane weights are working `1.2`, lexical `1.0`, vector `1.0`, entity `0.8`, graph `0.5`, and recall/init-only artifact `0.4`. `fuseCandidateRanks()` returns only fused identity, content, component ranks, and fused score. `prepare()` then loads current metadata/provenance under the same agent lock, applies the bounded reranker, assigns retrieval-item UUIDs, and persists hydrated `RetrievedItem` rows; the pure fusion function is not asked to invent unavailable database fields. A bounded deterministic reranker can change the fused value by at most 20% for currentness, working-set linkage, and explicit importance. Storage priority is a tie-breaker capped at 5%, not a relevance lane. The public `score` is normalized to `[0,1]`; callers never threshold the raw RRF magnitude.

Formatted recall/init context begins with a fixed `CORTEX_EVIDENCE_V1` instruction that the following records are untrusted historical evidence, then emits one JSON object per item using `JSON.stringify` for ID, kind, currentness, bounded provenance, and content. It does not use content-controlled XML/Markdown delimiters. At most five current event sources are returned per item with a truncation flag; legacy rows retain their descriptive source and an empty provenance array. Stored memory is never concatenated into system/tool descriptions or instructions, parsed as a command, or treated as authority merely because it was retrieved. The envelope is part of the prompt version so poisoning regressions are measurable and token accounting includes its full encoded form.

`prepare()` writes retrieval diagnostics but does not mutate a memory node or artifact. `deliver()` atomically marks the selected rows returned and updates `last_recalled_at` only for delivered memory nodes. Search delivers its final limit. Recall prepares a wider bounded set, packs memory/working and artifact items inside their fixed budget partitions, and delivers only packed items. REST maps those delivered rows back to its exact legacy `query`, external `agentId`, `context`, `memories`, `artifacts`, `tokenCount`, and `tokenBudget` fields while appending retrieval metadata; `tokenCount` equals `tokensUsed`. MCP preserves its exact legacy snake-case `query`, `token_budget`, `tokens_used`, and `memories` data shape and appends snake-case retrieval metadata/results; delivered artifacts remain in its human-readable context and new `results` list. Legacy arrays are projections of delivered rows only, so no uninstrumented artifact or memory is exposed. Init's `recentArtifacts` compatibility field likewise contains only artifact items actually delivered through the init retrieval, so their exposure and later feedback are measurable. A provider outage omits the vector lane with a warning; lexical/entity/working retrieval remains available.

### Feedback and outcomes

```ts
export type TaskSuccess = "success" | "partial" | "failure" | "unknown";

export interface RetrievalFeedbackInput {
  agentId: number;
  retrievalId: string;
  idempotencyKey: string;
  injectedItemIds?: readonly string[];
  usedItemIds?: readonly string[];
  citedItemIds?: readonly string[];
  correctedItemIds?: readonly string[];
  harmfulItemIds?: readonly string[];
  useAttributionComplete?: boolean;
  outcome?: {
    taskId: string;
    status: TaskSuccess;
    score?: number;
    evaluatorType: "deterministic" | "human" | "llm_assisted" | "caller";
    correctionObserved?: boolean;
    repetitionObserved?: boolean;
    harmObserved?: boolean;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    notes?: string;
  };
}

export interface RetrievalFeedbackResult {
  retrievalId: string;
  applied: boolean;
  replayed: boolean;
  injectedCount: number;
  usedCount: number;
  knownUnusedCount: number;
  citedCount: number;
  correctedCount: number;
  harmfulCount: number;
  outcomeRecorded: boolean;
}

export interface FeedbackService {
  record(input: RetrievalFeedbackInput): Promise<RetrievalFeedbackResult>;
}

export function createFeedbackService(deps: MemoryServiceDependencies): FeedbackService;
```

Every reported ID is the UUID of a returned `memory_retrieval_items` row belonging to the retrieval and agent. This represents memory, working-set, and cognitive-artifact evidence without ambiguous mixed identifier types; responses also retain legacy `memoryId`/`artifactId` fields where applicable. Omitted categories remain unknown. Used/cited/corrected/harmful evidence must already be injected or appear in `injectedItemIds` in the same atomic request; the service never infers the missing stage. `useAttributionComplete=true` is accepted only from an observer that injected the entire enumerated set and can enumerate all used items; injected items outside `usedItemIds` then receive known-unused evidence. An exact feedback retry is a no-op under its key, while a different payload under that key throws `IdempotencyConflictError`. A task outcome is keyed independently by the caller task key: unknown can advance to known, but two different known judgments throw a conflict and leave the original unchanged. The first transition of a memory-backed item to `used` increments `memory_nodes.access_count` and sets `last_accessed_at`; working-item and artifact use remain item telemetry, and concurrent or repeated feedback cannot increment anything twice for the same retrieval. MCP adapters can honestly mark a returned tool result as injected because it enters the tool-result context, but do not claim complete use attribution. Neither REST search nor a gateway marks use merely because it returned or injected content.

### Working memory and journal reconciliation

```ts
export type WorkingItemKind = "current_task" | "open_loop" | "constraint" | "correction" | "preference";
export type WorkingItemStatus = "active" | "resolved" | "expired";

export interface WorkingItem {
  id: string;
  agentId: number;
  callerKey: string;
  kind: WorkingItemKind;
  content: string;
  importance: number;
  displayOrder: number;
  status: WorkingItemStatus;
  sourceMemoryId?: number | null;
  sourceEventId?: string | null;
  lastConfirmedAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  resolutionReason?: string | null;
}

export interface WorkingItemUpsertBase {
  agentId: number;
  callerKey: string;
  content: string;
  importance?: number;
  displayOrder?: number;
  expiresAt?: string;
  sourceEventId?: string | null;
}

export type UpsertWorkingItemInput =
  | (WorkingItemUpsertBase & { kind: "correction"; sourceMemoryId: number })
  | (WorkingItemUpsertBase & { kind: Exclude<WorkingItemKind, "correction">; sourceMemoryId?: number | null });

export interface JournalWorkingUpdate {
  activeThreads: readonly string[];
  concerns: readonly string[];
  resolvedCallerKeys?: readonly string[];
  sessionId?: string | null;
}

export interface WorkingSetService {
  list(agentId: number, limit?: number): Promise<WorkingItem[]>;
  upsert(input: UpsertWorkingItemInput): Promise<WorkingItem>;
  resolve(agentId: number, id: string, reason: string): Promise<WorkingItem | null>;
  expire(agentId: number, id: string, reason: string): Promise<WorkingItem | null>;
  reconfirm(agentId: number, id: string, expiresAt?: string): Promise<WorkingItem | null>;
  reconcileJournal(agentId: number, update: JournalWorkingUpdate): Promise<WorkingItem[]>;
}

export function createWorkingSetService(deps: MemoryServiceDependencies): WorkingSetService;
```

At most 12 active items exist per agent; an upsert beyond the bound expires the lowest-importance, oldest-confirmed non-correction item in the same transaction. Corrections are eviction-last and require an active durable `sourceMemoryId`; if all 12 items are corrections, the oldest-confirmed reminder may expire only after its backing memory is revalidated as current. `cortex_init` displays at most eight within an 800-token working-memory budget, then uses those items plus an optional bounded caller hint as the query for at most 800 more tokens of long-term retrieval; duplicate working items are packed once and the evidence context is capped at 1,600 tokens. Its existing system-status, active-entity, recent-artifact, `top_context`, and `open_loops` response fields remain: `top_context` maps to delivered memory results, `open_loops` maps to working items, and compatibility metadata/artifacts are bounded to 800 additional serialized tokens. With neither active working items nor a hint, it returns no arbitrary long-term “top memories.” Default expiry is 14 days and no caller may set more than 30 days; durable preferences or corrections belong in versioned long-term memory. A successful reconsolidation also upserts a 14-day correction working item keyed by its successor, making the current correction visible at boot without changing long-term retention priority. Journal strings use stable normalized hashes as caller keys. Omission from a later free-form journal never auto-resolves an item; the existing journal tool gains an optional `resolved_thread_keys` field for explicit resolution.

### Reconsolidation

```ts
export type ReconsolidationStatus = "accepted" | "indexed" | "not_found" | "not_labile" | "window_closed" | "predecessor_superseded" | "failed";

export interface ReconsolidateInput {
  agentId: number;
  predecessorMemoryId: number;
  newContent: string;
  reason: string;
  idempotencyKey: string;
  requestId?: string | null;
  sessionId?: string | null;
}

export interface ReconsolidationResult {
  status: ReconsolidationStatus;
  eventId?: string;
  predecessorMemoryId: number;
  successorMemoryId?: number;
  artifactId?: number;
  acceptedAt?: string;
  indexedAt?: string;
  failureCode?: string;
}

export function reconsolidateMemory(services: MemoryServices, input: ReconsolidateInput, waitMs?: number): Promise<ReconsolidationResult>;
export function markDeliveredLabile(agentId: number, retrievalId: string, memoryIds: readonly number[]): Promise<void>;
export function getLabileMemories(agentId: number): Promise<Array<{ id: number; content: string; recalledAt: Date }>>;
```

The old node's content and embedding never change. The successor is first prepared as a non-retrievable pending row with projection metadata and `corrects` provenance. In the final indexing transaction the worker locks and revalidates that the predecessor is still current, activates the successor, then sets predecessor `valid_until`, `superseded_by`, and a cleared labile timestamp. Provider or graph failure leaves the predecessor current and the accepted correction retryable. If another accepted correction won first, the later event becomes `rejected` with `predecessor_superseded`, its never-active pending projection becomes `superseded`, and it creates no current fork; it is not automatically rewritten against content the caller never saw. The existing correction artifact remains for compatibility but points to both immutable node IDs only for the winning correction.

### Health, operations, and probes

```ts
export type OperationName = "ingest_worker" | "reflection";
export type OperationStatus = "running" | "succeeded" | "failed" | "stopped";

export interface MemoryHealthWarning {
  id: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
}

export interface OperationCompletion {
  counters?: Record<string, number>;
  errorCode?: string;
}

export interface OperationRunHandle {
  id: string;
  operation: OperationName;
  agentId?: number;
  buildId: string;
}

export interface LegacyVitalsSeries {
  daily: Array<{ day: string; agentWrites: number; reflections: number; otherWrites: number; total: number; reconsolidations: number; traces: number; journals: number }>;
  diagnostics: Array<{ at: string; health: string; drift: number }>;
  dreams: Array<{ at: string; cycleType: string; hoursAgo: number; resonanceUpdated: number; pruned: number; novelSynapses: number; syntheses: number }>;
}

export interface LegacyVitalsCurrent {
  activeMemories: number;
  synapses: number;
  avgResonance: number | null;
  avgSynapseStrength: number | null;
  orphans: number;
  missingHippocampal: number;
  missingValence: number;
  labileNow: number;
  expiredActive: number;
  emDashRecent: number;
  skillsTotal: number;
  skillExecutions: number;
  dreamHoursAgo: number | null;
  reflectHoursAgo: number | null;
  threadsHoursAgo: number | null;
  journalHoursAgo: number | null;
  agentIngests7d: number;
  reconsolidations7d: number;
  dupPairs: Array<{ a: number; b: number; sim: number }>;
  dupScanTruncated: boolean;
}

export interface MemoryHealthSnapshot {
  generatedAt: string;
  buildId: string;
  thresholds: Readonly<Record<string, number>>;
  series: LegacyVitalsSeries;
  current: LegacyVitalsCurrent;
  capture: {
    accepted24h: number;
    indexed24h: number;
    failed24h: number;
    obsolete24h: number;
    settled24h: number;
    terminalFailureRate: number | null;
    inFlight: number;
    retrying: number;
    retryingRate: number | null;
    deadLetter: number;
    oldestPendingSeconds: number | null;
    p50IndexLagMs: number | null;
    p95IndexLagMs: number | null;
    newProjectionProvenanceCoverage: number | null;
    bySourceType: Array<{ sourceType: string; accepted24h: number; lastAcceptedAt: string | null }>;
  };
  retrieval: {
    total24h: number;
    errors24h: number;
    errorRate: number | null;
    emptyRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    returned: number;
    injected: number;
    used: number;
    knownUnused: number;
    cited: number;
    harmfulItemReports24h: number;
    retrievalsWithItemHarm24h: number;
    feedbackCoverage: number | null;
    useAttributionCoverage: number | null;
  };
  outcomes: {
    linked: number;
    known: number;
    knownHarmAssessments: number;
    harmfulKnown: number;
    coverage: number | null;
    successRate: number | null;
    correctionRate: number | null;
    harmfulRetrievalRate: number | null;
  };
  dailyMetrics: DailyMetricRollup[];
  workingSet: { active: number; stale: number; expiredUnclosed: number };
  graph: { p10: number | null; p50: number | null; p90: number | null; usableThreshold: number; usableEdgeShare: number | null };
  schedulers: { workerHeartbeatAt: string | null; reflectionLastSuccessAt: string | null; dreamLastSuccessAt: string | null };
  warnings: MemoryHealthWarning[];
  okChecks: string[];
}

export interface MemoryHealthService {
  startOperation(operation: OperationName, agentId?: number): Promise<OperationRunHandle>;
  heartbeat(handle: OperationRunHandle, counters?: Record<string, number>): Promise<void>;
  finishOperation(handle: OperationRunHandle, status: Exclude<OperationStatus, "running">, details?: OperationCompletion): Promise<void>;
  snapshot(agentId: number): Promise<MemoryHealthSnapshot>;
  readiness(): Promise<{ ready: boolean; buildId: string; reasons: string[] }>;
  rollupDay(agentId: number, metricDay: string): Promise<DailyMetricRollup[]>;
  expireTelemetry(now?: Date): Promise<{
    dailyRollupsUpserted: number;
    candidateItemsDeleted: number;
    evidenceRetrievalsDeleted: number;
    feedbackEventsDeleted: number;
    taskOutcomesDeleted: number;
    emptyRetrievalsDeleted: number;
    retrievalHeadersRedacted: number;
    artifactsExpired: number;
  }>;
}

export function createMemoryHealthService(deps: MemoryServiceDependencies): MemoryHealthService;

export interface DailyMetricRollup {
  agentId: number;
  metricDay: string;
  buildId: string;
  retrievalVersion: string;
  counters: {
    accepted: number;
    indexed: number;
    ingestFailed: number;
    retrievals: number;
    retrievalErrors: number;
    emptyRetrievals: number;
    returned: number;
    injected: number;
    used: number;
    cited: number;
    corrected: number;
    harmfulItems: number;
    outcomesKnown: number;
    outcomesSuccessful: number;
    outcomesHarmful: number;
    outcomesHarmAssessed: number;
    feedbackLinked: number;
    feedbackAttributionComplete: number;
  };
  retrievalLatencyHistogram: readonly number[];
  tokenHistogram: readonly number[];
  sourceCompleteThrough: string;
}

export interface ConfirmedUtilityEvidence {
  completeUseOpportunities: number;
  usedOrCitedOpportunities: number;
  successfulUsedTasks: number;
  partialUsedTasks: number;
  failedUsedTasks: number;
  correctedRetrievals: number;
  harmfulRetrievals: number;
}

export interface ResonanceComponents {
  version: "memory-v1";
  recency: number;
  confirmedUtility: number | null;
  confirmedUtilityEvidence: ConfirmedUtilityEvidence;
  graphSupport: number;
  explicitImportance: number;
  emotionalSalience: number;
}

export function computeConfirmedUtility(evidence: ConfirmedUtilityEvidence): number | null;
export function computeResonance(components: ResonanceComponents): number;
```

Migration 010 adds `memory_operation_runs` as the durable worker/reflection record required by the approved health flow. Dream freshness continues to come from `dream_cycle_logs`; background-thread freshness comes from `background_threads`; self-check history remains in `self_diagnostics`. Readiness requires migrations 009/010, a database round trip, the same non-empty build ID, and an ingest-worker heartbeat newer than 90 seconds. A provider outage is a vitals warning, not a reason to make indexed memory unreadable.

Capture silence becomes a failure warning only for an operation with an existing schedule/heartbeat contract, such as nightly reflection or the continuous worker. Ad-hoc gateway, hook, REST, and MCP sources expose last-seen/count evidence by source type but remain `unknown` when quiet; vitals never claims a user-driven integration is broken merely because nobody used it.

`failed24h` and daily `ingestFailed` count distinct events by their immutable first-terminal-failure timestamp/build, not retry transitions; `deadLetter` reports events currently terminal, while total/manual retry and latest-terminal-failure fields expose recurrence without rewriting historical daily attribution. `settled24h` is indexed plus obsolete plus first-terminal-failed transitions completed in the window, and `terminalFailureRate` is failed divided by settled. `inFlight` is accepted/processing/retryable events now, and `retryingRate` is retryable in-flight events divided by all in-flight events. `feedbackCoverage` is completed retrievals with any feedback divided by completed retrievals that returned evidence. `useAttributionCoverage` is injected retrievals with complete use attribution divided by injected retrievals; an observed `used` item is still counted positively when attribution is partial, but no unused denominator is inferred. `errorRate` is failed retrieval headers divided by all completed/failed retrieval headers, and `emptyRate` excludes failed retrievals. Explicit positive item-harm reports appear independently as `harmfulItemReports24h` and distinct `retrievalsWithItemHarm24h`; because the feedback contract has no complete harm-assessment flag, their absence is unknown and no item-harm rate is fabricated. Outcome coverage is retrievals with known success/partial/failure divided by outcome-linked retrievals; unknown outcomes stay in coverage but outside success denominators. `harmfulRetrievalRate` is `harmfulKnown / knownHarmAssessments`, where the denominator contains only outcomes with an explicit true or false harm observation. Item-harm reports and harmful outcomes have separate daily counters, and either can trigger a harm warning without being silently converted into the other. Graph percentiles and usable-edge share include only same-agent edges whose two endpoints are active/current; the reported threshold is the exact threshold used by the measured CA3 configuration. Rates return `null`, not zero, when their denominator is absent.

REST retains the existing top-level `thresholds`, `series`, `current`, `warnings`, and `okChecks` fields and adds `buildId`, `capture`, `retrieval`, `outcomes`, a bounded most-recent-90-days `dailyMetrics` window, `workingSet`, `graph`, and `schedulers`. MCP retains its existing snake-case structured fields and adds equivalent lifecycle sections. Its handler invokes `services.health.snapshot()` directly rather than fetching Cortex's REST port, eliminating the current loopback dependency without changing the public tool name.

Each resonance component is clamped to `[0,1]`. Recency uses exponential decay from observation/creation with initial half-lives P0 `365d`, P1 `180d`, P2 `90d`, P3 `30d`, and P4 `7d`. Explicit importance maps P0–P4 to `1.0/0.8/0.5/0.25/0.1`; graph support is the percentile rank of current same-agent weighted degree; emotional salience is the existing bounded decay-resistance value.

Confirmed utility is null until at least one honest observation exists. `computeConfirmedUtility()` builds a bounded evidence multiset using distinct retrieval/task/category keys: each complete-attribution injected opportunity contributes `1` when used/cited and `0` when known unused; each known task outcome associated with a used/cited item contributes `1` for success, `0.5` for partial, or `0` for failure; each explicit item correction and each explicit item-harm report contributes one additional `0`. Missing use attribution, unknown outcomes, and the absence of a correction/harm report contribute nothing. The component is the Beta(1,1)-smoothed mean `(1 + evidenceSum) / (2 + evidenceCount)`. Thus a correction measurably lowers the predecessor's utility without pretending every uncorrected retrieval was correct, and a corrected successor inherits no penalty. Counts are stored beside the result so the component is auditable rather than an opaque score.

The final score is the weighted mean of recency `0.20`, confirmed utility `0.30`, current graph support `0.15`, explicit importance `0.25`, and emotional salience `0.10`; a null utility component is omitted and remaining weights are renormalized, so missing feedback is not treated as failure. The result is clamped to `[0,1]`, stored with its components/version, and never used as an unbounded additive retrieval score or a sole archive decision.

Every counted source fact carries its version at write time; rollup never labels old facts with the process version running the rollup. Acceptance, indexing, and an event's first terminal failure store the build that performed that transition and aggregate under the reserved retrieval-version value `not_applicable`. Retrievals use their persisted build/algorithm version, and their items, feedback, and linked outcomes inherit that exact pair. An unlinked outcome stores its observation build and also uses `not_applicable`. Consequently one UTC day may produce several `DailyMetricRollup` rows, and `rollupDay()` returns/upserts the complete sorted set rather than one guessed row. An event accepted under build A and indexed under build B contributes to the appropriate lifecycle row for each phase; a later retry failure never moves or duplicates its first-failure fact.

Before deleting any telemetry, maintenance upserts `memory_daily_metrics` for every affected closed UTC day/version partition and verifies that every stored `sourceCompleteThrough` covers the deletion boundary. Rollups contain only counters and fixed histogram buckets; they survive indefinitely in this feature. Non-returned candidate detail and empty unlinked retrievals expire after the configured default 30 days. Returned/injected/use/citation/correction/harm feedback, linked task outcomes, and their retrieval headers expire after the versioned 365-day evidence window; raw query/request/session fields are redacted at 30 days even when the evidence row remains. Evaluation results survive separately as opaque case/evidence IDs. A missing, failed, or incomplete partition watermark aborts deletion for the whole batch, so long-term trend lines cannot silently develop holes.

Eligible automatically generated dream/metacognition/background artifacts become `expired` rather than being deleted: never-returned artifacts 30 days after creation, returned-but-never-used artifacts 90 days after creation regardless of repeated delivery, and used artifacts 180 days after their last confirmed use. Candidate appearance does not delay expiry. User, reconsolidation/correction, and legacy-unknown artifacts are exempt. A generated artifact that informed later durable memory still follows this non-destructive lifecycle because no approved artifact-to-memory lineage exists; its immutable ingest event and memory provenance remain available. Ordinary cognition/init queries exclude expired artifacts; explicit historical access remains available.

`/livez` always returns only process liveness. `/readyz` returns `200 {"status":"ok"}` or `503 {"status":"not_ready"}` and logs detailed internal reasons without including them in the public body.

### Evaluation

```ts
export type EvaluationCondition = "memory_off" | "raw_hybrid" | "cortex" | "oracle" | "irrelevant" | "stale_conflict";

export interface EvaluationSetupEvent {
  eventKey: string;
  content: string;
  source: string;
  sourceType: string;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

export interface EvaluationRequest {
  prompt: string;
  taskType: string;
  requiredTool?: string;
}

export type DeterministicCheck =
  | { kind: "contains_all"; values: readonly string[]; caseSensitive?: boolean }
  | { kind: "contains_none"; values: readonly string[]; caseSensitive?: boolean }
  | { kind: "json_equals"; path: readonly string[]; expected: unknown }
  | { kind: "tool_called"; toolName: string; arguments?: Readonly<Record<string, unknown>> };

export interface HumanWrittenRubric {
  version: string;
  criteria: Array<{ id: string; description: string; weightBps: number; deterministicCheck?: DeterministicCheck }>;
  successThresholdBps: number;
}

export interface EvaluationEvidence {
  evidenceId: string;
  content: string;
  validFrom?: string;
  validUntil?: string;
}

export interface EvaluationEvidenceBinding {
  evidenceId: string;
  setupEventKey: string;
  projectedContentSha256: string;
}

export interface EvaluationSamplingManifest {
  manifestVersion: string;
  datasetVersion: string;
  sourcePopulationId: string;
  samplingMethod: string;
  sampledAt: string;
  sampledCaseCount: number;
  sampledCaseDescriptorsSha256: string;
  sampledPrimaryCaseCount: number;
  sampledPrimaryCaseIdsSha256: string;
  normalWorkAttestationId: string;
  reviewerAttestationId: string;
}

export interface EvaluationCase {
  caseId: string;
  clusterId: string;
  split: "development" | "holdout";
  memoryNeeded: boolean;
  setupEvents: readonly EvaluationSetupEvent[];
  request: EvaluationRequest;
  rubric: HumanWrittenRubric;
  oracleEvidence: readonly EvaluationEvidence[];
  evidenceBindings: readonly EvaluationEvidenceBinding[];
  irrelevantEvidence: readonly EvaluationEvidence[];
  staleConflictEvidence: readonly EvaluationEvidence[];
}

export interface EvaluationRunOptions {
  datasetPath: string;
  datasetVersion: string;
  expectedDatasetSha256: string;
  samplingManifestPath: string;
  expectedSamplingManifestSha256: string;
  executionInstanceId: string;
  asOf: string;
  outputDirectory: string;
  conditions: readonly EvaluationCondition[];
  seed: number;
  model: string;
  buildId: string;
  promptVersion: string;
  retrievalVersion: string;
  evaluatorId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface EvaluationRunMetadata {
  comparisonGroupId: string;
  comparisonFingerprintVersion: "evaluation-comparison-v1";
  executionInstanceId: string;
  condition: EvaluationCondition;
  datasetVersion: string;
  datasetSha256: string;
  samplingManifestVersion: string;
  samplingManifestSha256: string;
  expectedCaseCount: number;
  expectedCaseDescriptorsSha256: string;
  expectedPrimaryCaseCount: number;
  expectedPrimaryCaseIdsSha256: string;
  asOf: string;
  seed: number;
  model: string;
  buildId: string;
  promptVersion: string;
  retrievalVersion: string;
  evaluatorId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface EvaluationExecutor {
  execute(testCase: EvaluationCase, condition: EvaluationCondition, context: EvaluationContext): Promise<EvaluationObservation>;
}

export interface EvaluationContext {
  seed: number;
  asOf: string;
  memoryContext: string;
  evidenceIds: readonly string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface EvaluationObservation {
  output: string;
  toolCalls: readonly unknown[];
  retrievedEvidenceIds: readonly string[];
  injectedEvidenceIds: readonly string[];
  usedEvidenceIds: readonly string[];
  useAttributionComplete: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ConditionMetrics {
  cases: number;
  successRate: number | null;
  meanRubricScore: number | null;
  harmRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  meanTokens: number | null;
}

export interface ScoredEvaluationResult {
  caseId: string;
  clusterId: string;
  split: "development" | "holdout";
  memoryNeeded: boolean;
  condition: EvaluationCondition;
  status: TaskSuccess;
  rubricScoreBps: number | null;
  harmful: boolean | null;
}

export interface EvaluationResultEvidence {
  caseId: string;
  clusterId: string;
  split: "development" | "holdout";
  memoryNeeded: boolean;
  condition: EvaluationCondition;
  evidenceBindingDigest: string;
  retrievedEvidenceIds: readonly string[];
  injectedEvidenceIds: readonly string[];
  usedEvidenceIds: readonly string[];
  useAttributionComplete: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export type InitialEvaluationResult = EvaluationResultEvidence & (
  | {
      evaluatorType: "pending_human";
      adjudicationState: "pending";
      status: "unknown";
      rubricScoreBps: null;
      harmful: null;
      adjudicationId: string;
      outputSha256: string;
      adjudicationPacketSha256: null;
    }
  | {
      evaluatorType: "deterministic_diagnostic" | "llm_diagnostic";
      adjudicationState: "not_required";
      status: TaskSuccess;
      rubricScoreBps: number | null;
      harmful: boolean | null;
      adjudicationId?: never;
      outputSha256?: never;
      adjudicationPacketSha256?: never;
    }
);

export interface StoredEvaluationResult extends EvaluationResultEvidence, ScoredEvaluationResult {
  evaluatorType: "pending_human" | "human" | "deterministic_diagnostic" | "llm_diagnostic";
  adjudicationState: "complete" | "pending" | "not_required";
  adjudicationId?: string;
  outputSha256?: string;
  adjudicationPacketSha256?: string | null;
  adjudicationReceiptHash?: string;
  humanEvaluatorId?: string;
}

export interface BlindedAdjudicationItem {
  adjudicationId: string;
  request: EvaluationRequest;
  rubric: HumanWrittenRubric;
  output: string;
  toolCalls: readonly unknown[];
  outputSha256: string;
}

export interface HumanCriterionScore {
  criterionId: string;
  score: 0 | 1 | 2 | 3 | 4;
}

export interface HumanAdjudicationInput {
  adjudicationId: string;
  idempotencyKey: string;
  evaluatorId: string;
  outputSha256: string;
  adjudicationPacketSha256: string;
  criterionScores: readonly HumanCriterionScore[];
  harmful: boolean;
  completedAt: string;
}

export interface AdjudicationBinding {
  runId: string;
  caseId: string;
  adjudicationId: string;
  outputSha256: string;
}

export interface PendingAdjudicationBinding extends AdjudicationBinding {
  adjudicationPacketSha256: string | null;
}

export interface EvaluationRunSnapshot extends EvaluationRunMetadata {
  runId: string;
  state: "running" | "completed" | "failed";
  metrics: ConditionMetrics | null;
  resultSet: EvaluationResultSetIdentity | null;
}

export interface EvaluationResultSetIdentity {
  caseCount: number;
  caseDescriptorsSha256: string;
  primaryCaseCount: number;
  primaryCaseIdsSha256: string;
}

export interface EvaluationComparisonSnapshot {
  comparisonGroupId: string;
  comparisonFingerprintVersion: "evaluation-comparison-v1";
  runs: EvaluationRunSnapshot[];
  results: StoredEvaluationResult[];
}

export interface EvaluationRunStartResult {
  runId: string;
  comparisonGroupId: string;
  applied: boolean;
  replayed: boolean;
}

export interface HumanAdjudicationReceipt {
  adjudicationId: string;
  applied: boolean;
  replayed: boolean;
  status: TaskSuccess;
  rubricScoreBps: number;
  receiptHash: string;
}

export interface HumanScoredEvaluationResult extends ScoredEvaluationResult {
  evaluatorType: "human";
  adjudicationState: "complete";
  rubricScoreBps: number;
  harmful: boolean;
}

export interface EvaluationReport {
  comparisonGroupId: string;
  comparisonFingerprintVersion: "evaluation-comparison-v1";
  executionInstanceId: string;
  datasetVersion: string;
  datasetSha256: string;
  samplingManifestVersion: string;
  samplingManifestSha256: string;
  caseDescriptorsSha256: string;
  primaryCaseIdsSha256: string;
  asOf: string;
  seed: number;
  model: string;
  buildId: string;
  promptVersion: string;
  retrievalVersion: string;
  evaluatorId: string;
  caseCount: number;
  clusterCount: number;
  memoryDependentHoldoutCases: number;
  completePairedHoldoutCases: number;
  humanAdjudicatedPrimaryPairs: number;
  primaryUpliftPoints: number | null;
  confidenceInterval95: [number, number] | null;
  harmRate: number | null;
  retrievalHeadroomPoints: number | null;
  utilizationGapPoints: number | null;
  conditions: Partial<Record<EvaluationCondition, ConditionMetrics>>;
  requiresHumanAdjudication: number;
  gateFailureReasons: string[];
  passesProductGate: boolean;
}

export function loadEvaluationCases(path: string, expectedSha256: string, manifest: EvaluationSamplingManifest): Promise<readonly EvaluationCase[]>;
export function loadSamplingManifest(path: string, expectedSha256: string): Promise<EvaluationSamplingManifest>;
export function computeEvaluationComparisonId(metadata: Omit<EvaluationRunMetadata, "comparisonGroupId" | "condition">): string;
export function scoreHumanRubric(rubric: HumanWrittenRubric, scores: readonly HumanCriterionScore[]): { rubricScoreBps: number; status: "success" | "failure" };
export function runMemoryEvaluation(options: EvaluationRunOptions, executor: EvaluationExecutor, store: MemoryEvaluationStore): Promise<EvaluationReport>;
export function exportBlindedAdjudicationPacket(store: MemoryEvaluationStore, comparisonGroupId: string, privateArtifactDirectory: string, outputPath: string): Promise<{ items: number; packetSha256: string }>;
export function importHumanAdjudications(store: MemoryEvaluationStore, comparisonGroupId: string, inputPath: string, expectedPacketSha256: string): Promise<HumanAdjudicationReceipt[]>;
export function finalizeMemoryEvaluation(store: MemoryEvaluationStore, comparisonGroupId: string): Promise<EvaluationReport>;
export function clusterBootstrapUplift(results: readonly HumanScoredEvaluationResult[], seed: number, samples?: number): { uplift: number; ci95: [number, number] };

export interface MemoryEvaluationStore {
  startRun(metadata: EvaluationRunMetadata): Promise<EvaluationRunStartResult>;
  recordInitialResult(runId: string, result: InitialEvaluationResult): Promise<{ applied: boolean; replayed: boolean }>;
  bindAdjudicationPacket(comparisonGroupId: string, packetSha256: string, bindings: readonly AdjudicationBinding[]): Promise<void>;
  listPendingAdjudications(comparisonGroupId: string): Promise<PendingAdjudicationBinding[]>;
  loadComparisonGroup(comparisonGroupId: string): Promise<EvaluationComparisonSnapshot | null>;
  recordHumanAdjudication(comparisonGroupId: string, input: HumanAdjudicationInput): Promise<HumanAdjudicationReceipt>;
  completeRun(runId: string, metrics: ConditionMetrics, resultSet: EvaluationResultSetIdentity): Promise<void>;
  completeComparisonGroup(comparisonGroupId: string, report: EvaluationReport): Promise<{ applied: boolean; replayed: boolean }>;
  failRun(runId: string, errorCode: string): Promise<void>;
}
```

The runner first verifies the sampling-manifest hash supplied out of band, then verifies the dataset hash and the manifest's locked total/primary case counts, digest of sorted primary case IDs, and digest of sorted `{caseId, clusterId, split, memoryNeeded}` descriptors. The manifest must contain nonblank opaque normal-work and independent-review attestation IDs and describe the population/sampling method; self-declared case flags alone can never satisfy the Product gate. Every oracle evidence ID maps exactly once to an existing setup event and expected projected-content hash. After production ingest, the runner resolves that hash through event provenance; a missing, duplicate, or changed projection aborts scoring instead of falling back to content similarity. Each rubric must contain at least one criterion, nonblank unique criterion IDs, positive integer `weightBps` values summing exactly to `10,000`, and an integer `successThresholdBps` in `0..10,000`; invalid cases abort before a model call.

`asOf` is a required UTC instant recorded on every run and injected as `MemoryServiceDependencies.now()` for setup, currentness, retrieval, and scoring. Condition order is randomized per case from the recorded seed. Model, prompt, budgets, timeout, case setup, tool schema, and clock stay fixed. Whole projects/conversations share a `clusterId` and split; evaluator IDs are opaque stable identifiers, never names or email addresses.

The comparison-group ID is lowercase SHA-256 over RFC 8785 canonical JSON containing, in this contract order, fingerprint version, execution-instance UUID, dataset version/hash, sampling-manifest version/hash, expected total/primary counts and descriptor/primary-ID digests, normalized UTC `asOf`, seed, model, build ID, prompt version, retrieval version, evaluator ID, maximum input/output tokens, and timeout. It excludes condition, paths, state, metrics, and timestamps. `computeEvaluationComparisonId()` and the migration trigger use the same locked test vectors. Before the first model call, the wrapper atomically persists the execution-instance ID and group ID in its restricted run-state file; resume must reuse them, while a fresh command generates a new UUID. The runner supplies one group ID to all six `startRun()` calls, and the trigger rejects a row whose recomputed value differs. Unique group/condition storage makes an exact concurrent start a replay and prevents duplicate arms. A different shared field necessarily produces a different group and cannot be mixed into completion under the original ID.

Execution leaves every memory-dependent holdout `cortex` and `memory_off` result in `pending_human`, even when deterministic checks can suggest a score. A private local adjudication packet contains the request, prewritten rubric, output/tool calls, opaque adjudication ID, and output hash, but no condition label, retrieval trace, memory context, or paired result. Human imports validate the packet/output hashes and require exactly one integer `0..4` score for every rubric criterion, with no duplicate, missing, or extra criterion ID. The integer aggregate is `round_half_up(sum(weightBps * score) / 4)` and therefore lies in `0..10,000`; there is no intermediate floating-point or pass/fail rounding. `rubricScoreBps >= successThresholdBps` is `success`, and a lower score is `failure`. Invalid input rejects the whole adjudication and leaves it pending. `ConditionMetrics.meanRubricScore` is the arithmetic mean of completed `rubricScoreBps / 10,000` values and never drives per-case success. Imports are idempotent under their key. The first complete judgment wins: an identical later import is a replay, while any conflicting later judgment is rejected regardless of idempotency key and leaves the original unchanged. Only the opaque evaluator ID is retained. Deterministic and LLM-assisted scores remain diagnostics for all conditions and may help triage, but they never satisfy a primary judgment.

The execution path can call only `recordInitialResult()`: the type system prevents it from writing `evaluatorType="human"` or `adjudicationState="complete"`, and store validation requires every memory-dependent holdout Cortex/memory-off row to use the pending-human variant. Each initial row carries the locked evidence-binding digest; primary pending rows also carry an opaque adjudication ID and output hash. Packet export fsyncs and atomically renames the private packet before one store transaction binds its hash to every included pending row. After restart, export/import/finalization use the store's read methods, revalidate all three hashes, and never reconstruct a binding from private text. Unique run/case storage makes exact execution replay inert and rejects a changed result before it can inflate pairing or bootstrap counts.

Case memory always uses the guarded disposable database. The narrow `MemoryEvaluationStore` uses the normal Cortex result database through a repository whose statements target only the approved evaluation tables and whose methods accept only the redacted types above: no request, output, tool arguments, history, context, rubric text, gold text, or case memory. Those private fields live only in the restricted output directory and condition-blinded packet. Once execution rows and packet hashes are durably recorded, the case database is torn down; human import/finalization can resume later without rerunning the model or retaining synthetic memory in Cortex.

Primary task completion is binary under the integer threshold above, while a timeout, missing output, hash mismatch, or pending/invalid adjudication leaves the case incomplete. The scorer never drops incomplete cases. On arm completion, the store recomputes sorted result descriptors and primary IDs from its redacted rows and requires both digests/counts to equal the locked run metadata. Finalization recomputes the group ID, requires exactly one completed non-null-metrics run for each of the six conditions, requires every arm's result-set identity to equal the locked manifest identity, and cross-checks `clusterId`, split, and `memoryNeeded` for each opaque case across arms. It derives report metadata from those self-validating rows and rejects any report metadata/hash mismatch. An identical completed report is an inert replay; a changed report conflicts and completed/failed runs are never reopened. A fresh execution after either terminal state must use a new execution-instance UUID. `passesProductGate` is true only when the sampling manifest and all six execution conditions are valid, `memoryDependentHoldoutCases >= 200`, `completePairedHoldoutCases === memoryDependentHoldoutCases`, `humanAdjudicatedPrimaryPairs === memoryDependentHoldoutCases`, Cortex-minus-memory-off success uplift is at least `15.0` percentage points, and a cluster-bootstrap 95% interval is present. Production scoring uses 10,000 seeded cluster resamples by default; the interval is mandatory output but has no unapproved lower-bound threshold. Synthetic CI smoke cases always report `passesProductGate=false`.

### REST and MCP adapters

```ts
export function createIngestRouter(services?: MemoryServices): Router;
export function createSearchRouter(services?: MemoryServices): Router;
export function createRecallRouter(services?: MemoryServices): Router;
export function createReconsolidateRouter(services?: MemoryServices): Router;
export function createRetrievalFeedbackRouter(services?: MemoryServices): Router;
export function createWorkingSetRouter(services?: MemoryServices): Router;
export function createVitalsRouter(services?: MemoryServices): Router;
export function createHealthRouter(services?: MemoryServices): Router;
export function createProbeRouter(services?: MemoryServices): Router;

export interface CortexMcpServerOptions {
  services?: MemoryServices;
  transport: "stdio" | "streamable_http";
}

export function createCortexMcpServer(options: CortexMcpServerOptions): McpServer;
export function runStdioMcpServer(options?: Omit<CortexMcpServerOptions, "transport">): Promise<void>;

export interface McpHttpOptions {
  services: MemoryServices;
  port: number;
  sessionTtlMs: number;
  maxSessions: number;
  requestBodyLimitBytes: number;
}

export interface HttpMcpRuntime {
  close(): Promise<void>;
  activeSessionCount(): number;
}

export function createCortexMcpHttpApp(options: McpHttpOptions): Express;
export function startCortexMcpHttpServer(options: McpHttpOptions): Promise<HttpMcpRuntime>;
```

The HTTP process calls `initDatabase()` and creates one `MemoryServices` bundle once. Each MCP session gets its own `McpServer` and `StreamableHTTPServerTransport`, but all sessions share the process, connection pool, and immutable configuration. POST/GET/DELETE reuse the SDK session ID. The production entry point validates and sets a one-hour idle TTL, a 256-session cap, and a 1 MiB body limit; tests may inject smaller values. New initialization returns a bounded `503` when full, while existing sessions remain usable and idle cleanup continues. Logs contain method, response status, elapsed time, build ID, and a one-way session hash only; query text, memory content, authorization headers, raw session IDs, and tool arguments are excluded.

`cortex_ingest` waits up to 20 seconds for indexing, then honestly returns either `indexed` with legacy node/count fields or `accepted/processing` with an event ID. REST returns `202` after durable acceptance unless an explicitly bounded wait finishes first. Existing response fields remain during rollout, but `skipped` is no longer produced for source recency or semantic similarity.

## Call stack

### 1. Migration-first startup

1. The OAuth-owned one-shot migration service runs historical Build 1–8 setup, then `runCheckedInMigrations()` under the schema advisory lock.
2. Migration 009 is checksum-verified; migration 010 is applied and ledgered in the same per-file transaction.
3. Migration 010 creates all approved lifecycle/feedback/operation/daily-metric tables and indexes, adds nullable projection and cognitive-artifact lifecycle columns, clears historically candidate-inflated `access_count`, `last_accessed_at`, and `last_recalled_at`, and grants DML without DDL to the `cortex_memory_runtime` group role; deployment separately provisions its login member.
4. REST, worker, native MCP, and cron processes call `initDatabase()`; none runs DDL.
5. REST/MCP expose the same `CORTEX_BUILD_ID`. Worker writes its operation row and begins a heartbeat before readiness can succeed.
6. `/livez` can succeed before dependencies; `/readyz` succeeds only after database, checksums, build ID, and worker heartbeat are current.

### 2. REST durable capture

1. `POST /api/v1/ingest` validates the external agent, body size, priority policy, and optional idempotency key.
2. `IngestService.accept()` canonicalizes the exact payload and opens a short transaction.
3. The transaction inserts the immutable event or locks/returns the existing `(agent_id, idempotency_key)` event.
4. The event commits before embedding, entity extraction, hippocampal encoding, graph formation, or any network call.
5. With no wait preference, the adapter returns `202` plus the event ID and accepted status. After a bounded wait it returns `200` only for indexed, `202` for accepted/processing or retryable failure (including `nextAttemptAt`), `422` for rejected, and `503` for terminal failure; every non-validation response retains the event ID for status or operator recovery.
6. `GET /api/v1/ingest/:eventId` resolves the caller's bound agent before returning status; an event owned by another agent is indistinguishable from not found.

### 3. Worker projection and retry

1. `src/worker.ts` heartbeats, fills no more than configured concurrency, and calls `claim()`.
2. `claim()` takes one eligible accepted/retryable or processing-with-expired-lease row with `FOR UPDATE SKIP LOCKED`, increments attempts, writes a random lease token, and commits.
3. If `projected_at` is absent, the processor chunks raw content, embeds/normalizes, extracts deterministic metadata, computes valence/novelty, and discovers exact or possible-update matches outside a transaction.
4. After re-locking the event and verifying its lease token, a short transaction either records an exact active projection link or inserts pending nodes/codes/valence/provenance, then sets `projected_at`. No prior source or predecessor changes yet.
5. The worker computes a bounded graph-link set without mutation. A final transaction revalidates the lease, takes any required agent/source/predecessor lock, rejects obsolete/conflicting work, inserts replay-safe links, activates pending nodes, closes replaced source-snapshot events, supersedes only projections with no remaining current provenance, performs predecessor/successor versioning, and sets `indexed_at`.
6. Completion records synapse count and clears the lease/error. Failure stores only a bounded error code/message, exponential `next_attempt_at`, and retryable status; reaching the attempt ceiling produces the dead-letter health condition without deleting raw or pending evidence, and no pending node is retrievable.
7. An operator can requeue one terminal event by agent/event ID. The command shows metadata/status only, resets its cycle counter under lock, and leaves total attempts, content, key, and provenance unchanged.
8. Shutdown stops new claims, drains in-flight work, marks the operation stopped, and closes the shared database pool.

### 4. MCP capture and file ingestion

1. The MCP adapter resolves the agent and calls the same `accept()` used by REST; it contains no chunk/embed/write implementation.
2. `cortex_ingest` waits up to 20 seconds. It returns indexed legacy fields if available or a durable accepted event ID if not.
3. `cortex_ingest_file` validates the configured import root, reads content, derives a file content/version key, submits `replace_source`, and returns the receipt.
4. Corpus ingestion submits one event per file, bounds concurrency, and reports accepted/indexed/failed counts without presenting accepted work as already indexed.
5. Watcher, Telegram, Limitless, observation, reflection, gateway, and benchmark paths use the same acceptance contract.

Adapter keys are deterministic from stable origin identity plus exact content: gateway/session capture uses origin session/turn ID and content hash; reflection uses canonical transcript path, transcript-entry ID, extraction/prompt version, and normalized fact content hash (not model output order); file import uses canonical path and source version; observation uses host capture timestamp/window and content hash; evaluation uses dataset hash, case, condition, and setup-event key. A restart reproduces a key, while a genuinely distinct fact or source version cannot collide merely because it arrived nearby in time.

### 5. Search

1. REST/MCP resolves the agent and calls `RetrievalService.search()` with channel/request/session metadata.
2. `prepare()` records the retrieval header, loads the bounded working set, and independently queries lexical, entity/tag, vector, and optional CA3/graph lanes under current-valid agent filters.
3. Provider failure removes only the vector lane and adds a warning. Candidate generation never updates access, recall, resonance, or graph state.
4. `fuseCandidateRanks()` produces deterministic identity/rank/score-only fused candidates. The service hydrates current metadata/provenance, applies bounded reranking, assigns retrieval-item IDs, then persists at most the configured diagnostic candidate limit.
5. `deliver()` marks only the final limit as returned and labile and returns a retrieval ID, normalized score, component ranks, reasons, algorithm/build version, and latency.
6. MCP also retrieves matching procedural skills through the existing procedural service; those results remain separately typed and measured by their existing execution feedback.

### 6. Recall and session boot

1. Recall calls `prepare()` with a wider but bounded candidate request, including at most five recent active artifacts in the instrumented artifact lane.
2. `packRecallContext()` applies the compatible 80% memory/working and 20% artifact partitions, considers complete items by final rank inside each partition, skips an item that cannot fit and continues to later items, and never truncates stored content silently. If no complete item fits, it returns an empty context with a warning rather than claiming partial evidence was delivered.
3. `deliver()` records only packed items, then the adapter formats context, projects the exact legacy REST/MCP fields, and returns exact delivered retrieval-item IDs in the appended metadata.
4. `cortex_init` first loads at most eight active working items/800 tokens, combines their text with an optional bounded context hint, then performs an `init` retrieval for at most 800 more tokens. Its separate bounded compatibility section uses the init-only active-artifact lane and returns retrieval-item IDs for every artifact exposed. With no working item or hint it skips arbitrary long-term memory retrieval.
5. Fresh reconsolidations are represented as expiring correction working items. Old P0/P1 items remain protected in storage but have no automatic boot privilege; resolved, expired, invalid, and superseded content is excluded.
6. MCP marks the tool-result memories injected. Session-start and user-prompt hooks post injection feedback only after writing the context to stdout; telemetry failure never suppresses useful context.

### 7. Journal and working-set lifecycle

1. `cortex_journal` inserts the historical state log as today.
2. In the same service call, exact normalized active-thread/concern keys upsert or reconfirm working items.
3. Optional `resolved_thread_keys` explicitly resolve named items. Missing strings do nothing.
4. A successful strategic background-thread run upserts/reconfirms `background:strategic` with its next action and a seven-day expiry; an explicitly empty successful result resolves that key, while a failed/missing run leaves the prior item untouched until expiry.
5. Bound enforcement expires the least valuable eligible item before a thirteenth active item can commit.
6. Working-set GET/POST/PATCH routes call explicit resolve, expire, or reconfirm operations, enforce the bound agent, and stay private by remaining absent from the hosted OAuth allowlist.

### 8. Feedback and task outcomes

1. A gateway/hook/evaluator posts a retrieval ID, agent, feedback key, and only evidence it can actually observe.
2. The service locks the retrieval and validates every retrieval-item UUID against its returned rows and agent.
3. Timestamps transition from null once; an exact retry is idempotent and a reused key with different feedback is rejected as a conflict.
4. First confirmed use per retrieval increments a backing memory node once; working-item and cognitive-artifact use remain item telemetry. Returned/injected alone never changes a node counter.
5. A task outcome is stored with its evaluator type. `unknown` stays outside success/failure denominators.
6. Health and evaluation aggregate returned-to-injected, injected-to-used, correction, harm, and success without filling missing stages optimistically.

### 9. Reconsolidation

1. The adapter locks and verifies a current predecessor belonging to the agent and actually delivered within one hour.
2. It accepts a `reconsolidate` event with predecessor/reason in immutable metadata while the window is open.
3. Inline processing attempts to claim the event and waits up to 20 seconds; the background worker is the crash/retry fallback.
4. Provider work prepares a pending successor before current-state mutation. The final transaction locks and revalidates the still-current predecessor, inserts graph links/artifact, activates the successor, sets the predecessor to `status='superseded'`, closes its validity interval, links `superseded_by`, clears labile state, and marks the event indexed. A competing correction that lost this compare-and-lock supersedes its never-active pending node and becomes `predecessor_superseded` without creating a fork.
5. The same service operation upserts a 14-day correction working item keyed by the successor. Ordinary retrieval immediately excludes the predecessor after commit, while historical/provenance queries can still reconstruct both versions.
6. Failure before commit leaves the predecessor current and the correction event retryable; no half-expired row or correction working item is possible.

### 10. Dream, retention, and health

1. Dream reads complete use opportunities, confirmed use/citation, known outcomes, explicit item corrections/harm, age, explicit importance, valence, and current graph evidence; candidate appearances have no input. It writes the versioned bounded evidence counts, component record, and 0–1 resonance value, with unknown utility omitted and weights renormalized.
2. Until both 30 days have elapsed after migration 010 and an agent has at least 100 feedback-linked retrievals, utility-based archive decisions are disabled. After the guard, unknown utility still never counts as non-use: only P3/P4 projections with at least ten complete-attribution injected observations across at least three distinct tasks, zero confirmed use/citation/success association, and no correction/preference protection are eligible for utility-based archive. P0/P1 are never auto-archived; P2 requires explicit expiry, supersession, or operator action. The process changes status to `archived` and never physically deletes a memory node or raw event.
3. Synthesis is skipped unless `CORTEX_SYNTHESIS_ENABLED=true`. Experimental synthesis calls internal durable acceptance with same-agent source memory IDs, relation, bounded confidence, and expiry; final projection creates normalized provenance edges before the derived node becomes active.
4. Maintenance upserts and verifies content-free daily rollups before deleting detail. It removes non-returned candidates/empty unlinked retrievals after the configured default 30 days, redacts raw correlation/query fields at 30 days, and removes returned/evidence-linked retrieval, feedback, and live-outcome detail after the versioned 365-day window. Opaque evaluation results, raw ingest events, provenance, and daily rollups are not deleted by this feature.
5. The same maintenance pass marks eligible generated cognitive artifacts expired under the 30/90/180-day never-returned/returned-unused/last-used rules. User, reconsolidation/correction, and legacy-unknown origins are ineligible; generated artifacts remain eligible even after informing durable memory because expiry is non-destructive and no artifact-to-memory lineage field was approved.
6. Vitals queries lifecycle tables, daily metrics, operation runs, dream logs, background threads, self diagnostics, and graph distributions. It exposes retrieval error count/rate, warns on durable failure modes, and labels insufficient evidence as unknown.
7. Self-check includes those warnings but does not degrade merely because no skill was recently created.

### 11. Native Streamable HTTP MCP

1. `src/mcp/http.ts` initializes schema/services once and starts one Express process on port 8000 with `/mcp`, `/livez`, and `/readyz`; Compose uses liveness for restart health while deployment can use readiness for traffic.
2. An initialize POST creates one transport and one `McpServer` from the factory; the SDK assigns the session ID.
3. Later POST/GET/DELETE requests look up that transport. They never spawn a child, create a pool, or run migrations.
4. Session close/delete removes both transport and server. A sweeper closes idle sessions after one hour.
5. SIGTERM stops accepting sessions, closes transports, drains requests, and closes the database pool.
6. The stdio main remains available for local clients and exits on stdin close as it does today.

### 12. Causal evaluation

1. The wrapper retains the normal Cortex connection only for the redacted evaluation repository, provisions a randomly named loopback-only disposable pgvector database for all case memory, applies the real baseline plus migrations 009/010 there, injects only the disposable URL into case services, and installs cleanup handlers. Case services refuse an unguarded or non-disposable identity; repository statements are allowlisted to `memory_evaluation_runs/results`.
2. The runner verifies the separately locked sampling manifest, its normal-work/reviewer attestation IDs, and its expected total/primary counts plus case-descriptor/primary-ID digests; it then verifies private JSONL bytes before parsing, validates all evidence bindings, and refuses mixed project/conversation splits.
3. The wrapper atomically writes or resumes a restricted execution-instance UUID, computes the self-validating comparison-group fingerprint from it and the fixed evaluation-as-of/model/prompt/seed/budget/build/retrieval/dataset/manifest metadata, then creates exactly one replay-safe recorded run per condition under that ID.
4. For each case/condition it provisions a distinct agent identity, injects the same fixed clock, and randomizes condition order from the seed; no condition can observe another condition's state.
5. Every condition exposes identical tool schemas, prompt framing, and context budget. `memory_off` uses a no-memory adapter that returns an empty evidence envelope; `raw_hybrid` uses the same lexical/vector budget without Cortex projections; `cortex` uses production services; oracle/irrelevant/stale-conflict inject their locked evidence. Outputs do not reveal condition labels to the model or human adjudicator.
6. The executor records retrieved, injected, and demonstrably used evidence plus whether attribution is complete, latency, and tokens. It never infers use from retrieval or computes an unused set from partial attribution.
7. Setup ingest resolves every locked gold binding from setup-event key plus projected-content hash to concrete provenance-backed retrieval evidence; any missing/ambiguous mapping aborts the comparison group.
8. After all condition executions, deterministic/LLM checks are saved as diagnostics only. The runner writes private condition-blinded adjudication packets for every Cortex and memory-off memory-dependent holdout result, persists only their hashes/redacted pending rows through `MemoryEvaluationStore`, and tears down the case database.
9. Human judgments are imported idempotently by adjudication/output hash. A run can stop and resume at this boundary without rerunning model calls; changed, incomplete, or invalid 0–4 rubric judgments are rejected atomically.
10. Finalization first requires exactly one completed run for every condition, each with the locked result-set counts/digests and matching per-case descriptors, then reports every incomplete primary case and never drops one side. It proceeds to Product scoring only when all primary pairs are human-scored, clusters by whole project/conversation, computes paired Cortex-minus-off uplift and its mandatory 95% cluster bootstrap interval, and reports headroom/harm/utilization/efficiency. Non-memory controls are reported separately.
11. Product pass additionally requires all six conditions, every memory-dependent holdout pair complete, at least 200 such human-adjudicated pairs, and uplift of at least 15.0 points. The final redacted report is written through the evaluation repository and to the configured output directory; no case database remains by this phase.

## Test plan

Tests are named before implementation. Unit tests use injected clocks/IDs/providers. Database integration tests require `CORTEX_MEMORY_TEST_DISPOSABLE=1`, a loopback `cortex_test` database, and a unique Compose project; otherwise they refuse to run.

### Migration and startup

- `applies migration 010 once and records its checksum` — rerun has exactly one ledger row for 010, exactly two required ordered rows for 009/010 overall, and no data/schema drift.
- `rejects changed or missing migration 010 at runtime` — REST, worker, MCP, and cron fail closed without running DDL.
- `migration 010 preserves legacy memories without fabricated provenance` — all old rows remain queryable with nullable event IDs.
- `migration 010 clears candidate-inflated use labile and resonance telemetry` — content/priority/version history remains untouched while unreliable derivatives reset and resonance becomes neutral pending recomputation.
- `new projection starts with no use or delivery timestamp` — insertion cannot masquerade as confirmed use or open a reconsolidation window.
- `agent-scoped composite constraints reject cross-agent event provenance and retrieval items` — database constraints defend service bugs.
- `migration refuses dangling or cross-agent successor graph code or valence links` — ownership corruption is surfaced by count and never silently reassigned or deleted.
- `graph code and valence inserts require matching memory ownership` — post-migration scalar cognition links are protected by composite foreign keys.
- `evaluation comparison id is self-validating and condition unique` — database writes with a mismatched canonical fingerprint or a second arm for the same group/condition are rejected.
- `oauth migration tests remain pinned to OAuth invariants while application readiness requires 009 and 010` — the parallel security plan is neither weakened nor made order-dependent.
- `runtime role can perform lifecycle DML but cannot run DDL or read OAuth secrets` — least privilege is denial-tested.
- `readyz requires checksum database build and recent worker heartbeat` — each missing dependency returns only `not_ready` publicly.
- `livez succeeds during database outage` — liveness does not leak or conflate readiness.

### Durable ingest

- `accept commits before any provider call` — an embedding spy has not run when the receipt is returned.
- `same agent and idempotency key returns the original event and result` — concurrent retries create one event/projection.
- `same idempotency key with a different canonical request is a conflict` — REST returns 409, MCP returns a typed error, and the original event is unchanged.
- `same source with distinct payloads accepts every event` — twenty captures inside ten minutes all become durable.
- `fact validity survives durable acceptance and projection` — observed/valid timestamps are immutable event evidence and drive current filtering.
- `invalid temporal interval is rejected before event creation` — malformed or reversed timestamps cannot poison currentness.
- `derived legacy key includes the exact canonical payload` — only exact repeats collapse; priority/tags/source/content differences do not.
- `legacy key with omitted observed time survives an advancing clock` — the omitted sentinel stays stable while the first event retains its acceptance-time observation and a retry returns that event.
- `semantic neighbor is accepted and flagged rather than discarded` — raw event and projection survive with `possibleUpdateOf` metadata.
- `exact content from a second source keeps a second event and provenance` — projection reuse loses no source evidence.
- `exact content from a second agent never reuses a projection` — deduplication, possible-update hints, and provenance are agent-scoped before lookup.
- `same content with different projection metadata is not reused` — priority, normalized tags/entities, algorithm, or embedding identity cannot be silently inherited from another event.
- `legacy projection is not reused without provenance` — a later managed source refresh cannot retire unexplained historical evidence.
- `provider failure leaves accepted raw content retryable` — no node exists, failure is bounded, and retry later indexes it.
- `provider failure telemetry excludes content headers and credentials` — only the safe error code and sanitized bounded message persist or log.
- `invalid dimension NaN and infinity never enter pgvector` — each becomes a retryable provider-result error.
- `embedding batch count and zero norm are validated` — missing, extra, or non-normalizable vectors cannot misalign chunks.
- `optional entity provider failure indexes deterministic metadata` — capture completes with a safe degradation warning instead of stalling or logging provider output.
- `worker leases prevent double processing and recover after expiry` — two workers yield one projection and a crashed lease can resume.
- `worker that loses its lease cannot commit prepared provider output` — lease-token verification rejects stale work before mutation.
- `crash after projection resumes graph phase without duplicate nodes or activation inflation` — `projected_at` is the checkpoint.
- `pending projection is invisible until final indexing commit` — search cannot return a node while its event still reports processing.
- `graph failure leaves prior source or predecessor current` — partial projection never creates an availability gap or half-correction.
- `replace source prepares fully before closing previous snapshot` — failed refresh leaves old nodes current; success atomically changes currentness.
- `replace source preserves a projection supported by another current event` — closing one source snapshot cannot retire shared evidence.
- `unchanged chunk in a new source version remains current without duplication` — the new event gains provenance and the reused node is not superseded.
- `older source snapshot completing after newer indexed snapshot is obsolete` — source serialization prevents late work or manual retry from restoring stale state.
- `newer failed snapshot does not evict older indexed snapshot` — acceptance order alone never closes the last good source version.
- `file restored to an older byte-identical body creates a new snapshot event` — source version prevents replay of a historical event and superseded projections are not reused as current.
- `worker attempt ceiling surfaces dead letter without deleting event` — status/health are honest and content remains recoverable.
- `operator retry requeues the same terminal event under agent scope` — cycle attempts reset while total attempts, raw content, event ID, and idempotency key remain unchanged.
- `manual retry failure cannot rewrite daily failure history` — a first failure under build A/day one remains the sole `ingestFailed` fact after a retry fails under build B/day two, while latest-failure build/time and transition count expose the recurrence.
- `operator retry refuses active indexed foreign or missing events` — repair cannot fork completed work or disclose another agent's event.
- `priority policy is independent of novelty similarity` — requested/verified importance is not silently demoted by near-neighbor score.
- `CA1 novelty is current-scoped and diagnostic only` — expired/history rows cannot shape it and its result cannot mutate priority, resonance, acceptance, or reuse.
- `machine and observation priority floors remain centralized` — REST, MCP, worker, gateway, and importers cannot disagree on effective priority.
- `derived ingest requires current same-agent sources confidence and expiry` — empty/foreign/missing sources, out-of-range confidence, and nonfuture expiry fail before event creation.
- `derived projection preserves fact validity and derivation expiry` — every output/source pair is linked, both boundaries remain auditable, and retrieval stops at whichever boundary occurs first.
- `public adapters reject internal derivation and transfer inputs` — callers cannot mint trusted lineage through REST or MCP.

### Retrieval and delivery

- `candidate generation does not mutate memory nodes or graph` — access, labile, resonance, and activation values are byte-for-byte unchanged.
- `only final search results become returned and labile` — the larger diagnostic candidate set remains untouched.
- `only packed recall items become returned and labile` — over-budget candidates do not enter the window.
- `oversized candidate does not block later fitting evidence` — token packing preserves complete lower-ranked items before any explicit truncation fallback.
- `lexical lane matches terms without requiring the whole query substring` — PostgreSQL FTS fixes the current all-or-nothing `ILIKE` behavior.
- `lexical and vector inputs remain parameterized` — quotes/operators/adversarial text cannot become SQL or change agent/current filters.
- `RRF ranks are invariant to raw lane score scale` — rescaling cosine/BM25 values preserves lane-order fusion.
- `rank fusion returns only computable fused candidate fields` — UUIDs, currentness, provenance, and reasons appear only after scoped hydration.
- `temporal and status filters apply before every lane` — expired, archived, deleted, and superseded items never return.
- `agent scope applies before every lane and graph expansion` — no cross-agent candidate can enter diagnostics.
- `working current task outranks stale protected storage at boot` — P0 retains storage protection but not query dominance.
- `storage priority changes fused score by no more than five percent` — relevance and currentness remain separate.
- `vector outage returns lexical entity and working results with warning` — existing memory stays usable.
- `CA3 off is deterministic and CA3 on adds only valid scoped candidates` — graph is an optional measured lane.
- `superseded CA3 codes and graph neighbors cannot consume the lane limit` — currentness is enforced before seed/expansion bounds, not only after fusion.
- `public relevance score stays within zero and one` — gateways never depend on raw RRF magnitude.
- `retrieval telemetry is bounded at configured candidate limit` — a broad query cannot create unbounded rows.
- `shared projection returns bounded current provenance` — callers can see supporting sources without mistaking the legacy source column for complete lineage.
- `retrieved instructions remain labelled untrusted evidence` — memory text cannot alter system/tool instructions through context formatting.
- `quotes newlines tags and fence text stay inside JSON evidence strings` — adversarial stored content cannot terminate or reshape the envelope.
- `init artifacts are returned as artifact retrieval items` — every compatibility artifact has a retrieval-item ID, inactive artifacts are excluded, and candidacy changes no artifact state.
- `recall artifacts are delivered and budgeted as retrieval items` — both the legacy artifact projection and appended result refer only to rows marked returned inside the compatible 20% partition.

### Feedback and utilization

- `feedback rejects an item not returned by this retrieval` — candidate, foreign, and fabricated IDs fail.
- `use correction citation and harm require injection evidence` — callers cannot skip funnel stages or make a merely returned candidate look utilized.
- `feedback rejects another agent retrieval without revealing it` — ownership is fail-closed.
- `missing feedback remains unknown` — it is absent from used/unused/success denominators.
- `complete use attribution marks only injected remainder unused` — partial observers cannot manufacture negative evidence.
- `later confirmed use outranks earlier known-unused evidence` — delayed attribution is auditable and increments the node only once.
- `feedback key replay is a no-op` — all stage counts and outcomes remain single.
- `feedback key reused with a different payload is a conflict` — changed evidence or outcome cannot be silently discarded.
- `concurrent first-use feedback increments access once` — database locking/conditional update handles races.
- `returned and injected do not increment confirmed use` — access changes only on `used`.
- `working-item use is recorded without a memory-node update` — the funnel covers boot context without corrupting long-term counters.
- `artifact use is recorded without a memory-node update` — compatibility evidence participates in utilization and expiry without fabricating long-term-memory access.
- `harm correction citation and use may be reported independently` — no category is inferred from another.
- `outcome unknown is stored but excluded from success rate` — lack of observability cannot improve metrics.
- `unknown outcome may advance to known but conflicting known outcomes fail` — delayed evidence is supported without last-write-wins metric corruption.
- `gateway and hooks mark only context actually emitted as injected` — skipped/throttled results remain returned but not injected.
- `MCP tool result marks returned memories injected but not used` — transport delivery is represented honestly.

### Working memory and init

- `working set cannot commit a thirteenth active item` — deterministic eviction applies in the same transaction.
- `correction item is not evicted before lower-importance task item` — safety ordering is enforced.
- `thirteenth correction expires only the oldest durable reminder` — the hard bound holds while every correction remains preserved in current long-term memory.
- `expired and resolved items never appear at init` — status and time filters precede ordering.
- `journal exact thread reconfirms instead of duplicating` — normalized stable keys update freshness.
- `journal omission does not resolve an item` — free-form incompleteness cannot silently close work.
- `explicit journal resolution closes only named agent-owned keys` — resolution is deliberate and scoped.
- `working-set PATCH expires an agent-owned item explicitly` — expire is distinct from resolve/reconfirm, foreign IDs remain not found, and the item disappears from init.
- `strategic next action reconciles through one stable working key` — successful updates replace/reconfirm it, failures do not erase it, and explicit empty success resolves it.
- `init working portion uses at most eight items and eight hundred tokens` — current loops cannot crowd out the retrieval half.
- `init caps combined working and retrieved context at sixteen hundred tokens` — derived-query recall cannot make boot unbounded.
- `init without working context or hint returns no arbitrary top memories` — storage priority cannot masquerade as current relevance.
- `init derives retrieval from working text and optional context hint` — long-term context is relevant to the present task rather than globally popular.
- `init packs a working item only once` — the working lane and explicit working section cannot duplicate context or telemetry.
- `init preserves bounded legacy structured fields` — system status, entities, artifacts, top context, and open loops remain available while new retrieval IDs are additive.
- `old P0 memory cannot monopolize init without query/working relevance` — retention and current attention are separated.

### Versioned reconsolidation

- `reconsolidation requires actual delivery inside the one-hour window` — candidacy alone is insufficient.
- `accepted correction remains eligible when processing starts after the window` — acceptance captures valid intent.
- `successful correction creates a successor and never changes predecessor content` — both embeddings/content hashes remain auditable.
- `successor and predecessor transition atomically` — the predecessor becomes superseded with a closed validity interval, so no legacy or temporal reader exposes both as current or leaves neither current.
- `provider failure leaves predecessor current and correction retryable` — no crash residue exists.
- `retry after committed projection returns the same successor` — event idempotency prevents version forks.
- `concurrent distinct corrections create only one successor` — predecessor locking makes the loser `predecessor_superseded` instead of forking history.
- `ordinary search excludes predecessor while provenance reconstructs the chain` — currentness and audit both work.
- `successful correction appears in the bounded working set` — the next boot sees the change without globally boosting its storage priority.
- `legacy response includes prior memory id while new fields expose both ids` — clients receive a migration path.

### Health and dream

- `capture silence is based on expected operation runs and events not corpus age` — a populated store can still warn.
- `quiet ad-hoc source remains unknown rather than failed` — absence of user activity is not misdiagnosed as capture loss.
- `successful zero-output reflection proves scheduler execution` — no new memory is not automatically a failed job.
- `failed and missing reflection runs are distinguishable` — remediation is specific.
- `graph average cannot hide a collapsed lower tail or unusable edge share` — p10/p50/p90 and threshold share drive severity.
- `vitals preserves legacy current and time-series fields` — REST and MCP consumers gain lifecycle evidence without losing their existing contract.
- `MCP vitals does not depend on a loopback REST fetch` — the shared health service works when only the native MCP host is running.
- `learning age is informational rather than global degradation` — lack of a new skill alone cannot create five degraded self-checks.
- `oldest pending event and p95 index lag warn before silent loss` — accepted-but-unavailable work is visible.
- `capture failure and retry rates use explicit denominators` — settled and in-flight populations are reported, and absent populations return null rather than a reassuring zero.
- `new projection provenance coverage stays complete` — legacy unknowns are separated and every lifecycle-managed node must trace to an event.
- `obsolete source snapshots do not count as indexing failures` — intentionally superseded late work is visible separately without a false outage warning.
- `feedback coverage gates utilization claims` — low coverage displays unknown/insufficient evidence.
- `coverage denominators distinguish feedback attribution and outcomes` — a zero rate cannot be manufactured from missing observations.
- `harm rate is calculated only from known outcomes` — missing data is not safe data.
- `item harm without an outcome remains visible` — explicit harmful item and affected-retrieval counts appear in vitals/daily metrics while the outcome harm rate stays null.
- `several harmful items in one retrieval keep item and retrieval counts distinct` — positive harm evidence is neither dropped nor double-counted as an outcome.
- `dream ignores candidates and returned-only rows` — only confirmed use/correction/outcome affect utility.
- `explicit correction lowers only the corrected predecessor utility` — the correction adds one auditable zero observation and the successor inherits none of it.
- `resonance is bounded decomposable and neutral to unknown utility` — every component is inspectable, the score stays within zero and one, and missing feedback is not a penalty.
- `resonance alone cannot archive or dominate retrieval` — maintenance scoring cannot recreate the current hidden global-priority behavior.
- `rollout guard prevents zeroed legacy counters from causing mass pruning` — unknown utility protects history.
- `utility archive requires repeated complete-attribution non-use` — ten observations across three tasks protect against one noisy caller.
- `P0 and P1 are never auto-archived and no row is physically deleted` — retention protection and raw recoverability remain hard constraints.
- `synthesis is off by default and enabled synthesis has provenance and expiry` — generated memory follows normal rules.
- `30 day telemetry expiry deletes only non-returned detail` — raw events/provenance and returned/use/harm/outcome evidence survive until their separate 365-day boundary.
- `telemetry expiry redacts retained retrieval headers` — old raw queries and request/session IDs disappear while hashes and outcome lineage survive.
- `retrieval failures appear in vitals and daily metrics` — error count/rate uses failed headers while empty rate excludes failures.
- `daily metric rollup is content free retry safe and required before deletion` — rerun updates the complete day/version partition set, contains no query/content/IDs, and any missing or failed watermark aborts the whole expiry batch.
- `daily rollup preserves source-stage versions across deployment` — acceptance under build A and indexing under build B land in separate `not_applicable` lifecycle rows while R1/R2 retrieval facts keep their persisted version rows; a later rollup process cannot relabel them.
- `365 day evidence expiry preserves aggregates and evaluation results` — live retrieval/feedback/outcome detail expires only after rollup while opaque evaluation rows survive.
- `unused generated artifacts expire without physical deletion` — dream/metacognition/background origins follow 30/90/180-day rules while user, correction, and legacy-unknown artifacts remain active.
- `generated artifact expiry does not erase promoted durable memory` — an eligible artifact can expire after informing a capture while that memory's ingest event/provenance remains current and auditable.

### REST and MCP compatibility

- `ingest returns 202 only after event commit` — killing the API immediately still leaves retriable content.
- `bounded ingest wait returns 200 indexed or 202 processing truthfully` — no accepted work is labelled stored.
- `ingest status lookup is agent scoped` — another agent receives not found.
- `public ingest adapters reject internal external-provenance fields` — callers cannot mint transfer receipts through REST or MCP.
- `REST recall keeps exact legacy keys and types while adding retrieval metadata` — `query`, external `agentId`, `context`, `memories`, `artifacts`, `tokenCount`, and `tokenBudget` retain their wire shapes and every projected item was delivered.
- `MCP recall keeps exact legacy data keys and types while adding retrieval metadata` — snake-case `query`, `token_budget`, `tokens_used`, and `memories` remain schema-compatible and artifact context comes only from delivered artifact rows.
- `MCP recall accepts the existing 256 through 32000 token range` — 256, 8,001, and 32,000 pass validation while 255 and 32,001 fail; the default remains 4,000.
- `private lifecycle routes are absent from the hosted OAuth allowlist` — direct raw-service tests pass, gateway tests deny.
- `public MCP tool names are unchanged` — the tool list matches the pre-feature catalog.
- `stdio MCP still exits on stdin close` — desktop/local clients remain compatible.
- `native MCP reuses one process and pool across repeated requests` — no per-session child or migration notice appears.
- `native MCP exposes the shared liveness and readiness contracts` — replacing Supergateway does not leave the container health check pointed at a missing route.
- `two MCP sessions isolate protocol state while sharing immutable services` — session IDs do not cross-deliver.
- `MCP session and body bounds fail closed` — excess initialization or oversized requests cannot grow the host without limit or evict active sessions.
- `POST GET DELETE and idle timeout close transports correctly` — SDK lifecycle is complete.
- `unknown or malformed session id never creates a session` — only a valid initialize request allocates protocol state.
- `MCP logs never contain content query arguments authorization or raw session id` — metadata-only logging is enforced.
- `native MCP warm p95 stays below five hundred milliseconds excluding provider work` — the current process-spawn tax is removed.

### Integrations and evaluation

- `gateway awaits durable capture before considering a turn captured` — process interruption cannot erase an acknowledged write.
- `reflection retry reuses event keys but a distinct extracted fact is not source-suppressed` — job restart is safe and complete.
- `reflection without configured fallback credentials sends no fallback request` — there is no source-code credential or accidental unauthenticated provider call, and the operation failure is recorded safely.
- `file watcher reports queued versus indexed accurately` — operator logs do not overstate availability.
- `screen observation stable key replays one capture but preserves later captures` — timestamps/content define separate events.
- `CogBench reconsolidation asserts immutable versions` — the old benchmark cannot reward destructive updates.
- `cross-agent transfer creates a target-scoped event with opaque receipt provenance` — no raw SQL bypass or cross-agent foreign key/source identifier remains.
- `legacy diagnostic benchmark client refuses live databases and resets complete lifecycle state` — LoCoMo/LongMemEval/CogBench cannot delete projections while leaving event/provenance rows or pollute production metrics.
- `locked dataset hash mismatch aborts before a model call` — results cannot mix dataset versions.
- `sampling manifest hash counts and case digests are mandatory` — missing attestation IDs, changed descriptor/primary membership, incorrect counts, or a synthetic self-declared case file cannot satisfy the Product gate.
- `evaluation clock is fixed across all conditions and persisted` — temporal currentness is identical on rerun regardless of wall-clock date.
- `gold evidence binds exactly to setup event and projected content hash` — missing, duplicate, or changed mappings abort instead of using heuristic text matching.
- `comparison fingerprint is canonical condition independent and field sensitive` — locked vectors match application/database SHA-256; condition does not change the ID while every shared setting does.
- `comparison start is one replay-safe run per condition` — concurrent exact starts return one run, duplicate conditions do not inflate arms, and completed/failed runs never reopen.
- `execution instance separates a fresh run from a retry` — resume reuses the persisted UUID/group, while a new UUID permits an independent identical-settings run after failure or completion.
- `comparison finalization requires six matching completed arms` — missing, running, failed, duplicate, or metadata-mismatched conditions cannot produce a completed report.
- `comparison finalization rejects a case omitted from every arm` — each arm's result counts and descriptor/primary-ID digests must match the locked sampling manifest, so 200 favorable leftovers cannot hide a missing case.
- `comparison finalization rejects cross-arm case metadata drift` — cluster, split, and memory-needed labels for an opaque case must agree before pairing or bootstrap.
- `comparison report completion is immutable` — identical completion replays while a changed report hash or metadata conflicts.
- `evaluation result replay is unique per run and case` — exact restart replay is inert while changed evidence, scores, hashes, or condition data conflicts before aggregation.
- `evaluation case services refuse an unguarded or production database` — synthetic histories cannot contaminate live memory or health metrics; only the redacted repository may use the normal result store.
- `evaluation repository cannot persist private case material` — its statements target only evaluation tables and its accepted records contain no prompt/output/context/rubric/tool arguments or gold text.
- `each case and condition receives an isolated agent` — memory state cannot leak across experimental arms.
- `evaluation teardown runs after success failure or interruption` — disposable case data does not accumulate.
- `condition order is seeded and model prompt token timeout budgets are identical` — causal comparison is reproducible.
- `all conditions expose identical tool schemas and hide labels` — tool availability or condition leakage cannot explain the measured uplift.
- `whole cluster is assigned to one split` — project/conversation leakage is rejected.
- `cluster bootstrap resamples clusters rather than individual questions` — confidence is not inflated by correlated cases.
- `primary metric uses only complete paired memory-dependent holdout cases` — controls, development cases, unknown scores, and one-sided failures cannot dilute or inflate uplift.
- `one incomplete primary pair rejects the entire product report` — complete-pair count must equal the locked memory-dependent holdout count even when more than 200 favorable pairs remain.
- `primary results remain pending until blinded human import` — deterministic and LLM diagnostics cannot make Cortex or memory-off results gate-eligible.
- `human adjudication import is blinded hash-bound and final` — condition/context is absent, an identical replay is inert, changed output or any conflicting later judgment is rejected, and resume requires no model rerun.
- `human rubric aggregation is exact and threshold stable` — unequal basis-point weights use the locked 0–4 formula, half-basis-point rounding is half-up once, and equality with the integer threshold succeeds.
- `invalid human rubric or judgment remains incomplete` — empty/duplicate criteria, nonpositive or nonsumming weights, out-of-range thresholds/scores, and missing/extra/duplicate criterion IDs reject atomically.
- `adjudication resume loads durable redacted bindings` — adjudication ID, evidence-binding digest, output hash, and packet hash survive restart and finalization reads only the stored comparison snapshot.
- `execution result writer cannot mint human completion` — initial-write types accept pending or diagnostic states only; the human transition exists solely on the import method.
- `primary initial result cannot use a diagnostic variant` — store validation requires pending-human for memory-dependent holdout Cortex/off rows even if a caller constructs the union dynamically.
- `memory off raw hybrid Cortex oracle irrelevant and stale conflict all run through one executor contract` — condition-specific harness drift is prevented.
- `retrieved but unused evidence appears in the utilization gap` — retrieval quality cannot masquerade as task value.
- `stale memory harm is compared against memory off` — a system that sometimes helps but often misleads cannot pass silently.
- `full product report refuses fewer than two hundred memory-dependent holdout cases` — the approved sample floor cannot be satisfied by controls or incomplete pairs.
- `product threshold fails at 14.9 points and passes at 15.0` — the exact approved boundary is regression-tested with all other requirements met.
- `product report without a 95 percent interval cannot pass` — point uplift alone is insufficient.
- `junk entity cleanup has no mutation mode` — the diagnostic cannot update projection entities or delete lifecycle-managed graph edges.
- `em dash scrub has no mutation mode` — historical artifact bytes and retrieval hashes cannot be rewritten by a cleanup script.
- `all unit typecheck build OAuth integration and memory integration suites pass together` — this feature cannot regress the parallel security rollout.

## Least confident decisions

1. **Asynchronous compatibility.** Durable `202` is the correct truth model, but some unknown clients may assume `200` means immediate searchability. The 20-second MCP wait and legacy result fields reduce the break, yet client inventory remains a rollout prerequisite.
2. **Initial working-set and context bounds.** Twelve active items, eight boot items, an 800-token working-memory budget, an 800-token long-term-retrieval budget, a 1,600-token evidence cap, an 800-token compatibility-metadata budget, 14-day default expiry, and 30-day maximum are reasoned starting points rather than measured optima. They must be tuned through task outcomes, not expanded because users notice one missing item.
3. **Initial retrieval and resonance weights.** RRF is substantially safer than combining raw cosine, substring, recency, and resonance scales, but the proposed lane weights, 20% rerank cap, resonance component weights, and priority half-lives are hypotheses. The evaluation must report retrieval and maintenance ablations, including CA3 off/on, before they become permanent.
4. **Raw-event retention.** Keeping immutable raw events indefinitely is the safest anti-loss first release but duplicates sensitive content and grows storage. A deletion/encryption/export policy needs a separately reviewed privacy design before automatic raw-event deletion is allowed.
5. **Observed use.** MCP can prove returned/injected and the evaluation can prove use, but ordinary live callers often cannot. Cortex must tolerate low use-feedback coverage and say `unknown`; it should not invent a utilization percentage to make the dashboard look complete.
6. **File snapshot replacement.** Closing all prior current chunks only after a new snapshot commits prevents stale files and failed-refresh loss, but chunk-to-chunk lineage is coarse when a document is heavily reorganized. Event/source provenance remains exact even when individual predecessor mapping is not.
7. **Telemetry reset and dream guard.** Resetting polluted access/labile fields is more honest than carrying false history, but requiring both 30 elapsed days and 100 feedback-linked retrievals before utility-based pruning is conservative and may temporarily slow useful pruning. That is preferable to destroying legacy memory on unknown evidence.
8. **Human-adjudication capacity.** Two primary outputs for every memory-dependent holdout task means at least 400 blinded human judgments before a 200-case Product result can pass. That is operationally expensive, but deterministic or model-only shortcuts would contradict the approved human-scored metric; the resumable packet/import boundary is the mitigation.
9. **Migration number under concurrent work.** `010` is correct today, but the OAuth plan explicitly permits post-freeze corrections at 010 or higher. The implementation must coordinate before the first migration commit; after production application, the checksum and number are immutable.
10. **Private evaluation set readiness.** The harness can be built and verified with synthetic smoke cases, but Cortex cannot claim the Product-gate uplift until the team supplies, locks, and human-adjudicates at least 200 representative holdout tasks.
