# Architecture: Cortex Memory You Can Trust

## Fit

This is an incremental replacement of Cortex's memory lifecycle, not a database or product rewrite. PostgreSQL, pgvector, the current memory corpus, temporal validity, procedural memories, reconsolidation, REST routes, and the existing MCP tool names remain. New writes and reads move behind shared application services so REST, MCP, hooks, gateways, cron jobs, and benchmarks cannot quietly implement different rules.

The architecture separates four signals that are currently conflated:

- retention importance: whether a memory should be preserved;
- query relevance: whether it matches this request;
- currentness: whether it is valid and useful now;
- demonstrated utility: whether delivered memory contributed to a successful outcome.

`priority`, candidate appearance, and raw access counts will no longer stand in for all four.

The change touches these existing areas:

- REST ingest, search, recall, reconsolidation, health, and vitals become thin adapters over shared memory services.
- The MCP server delegates its existing ingest/search/recall/init/reconsolidate/vitals tools to the same services. The public MCP tool catalog does not gain new tools, preserving compatibility with the separately approved OAuth-hardening rollout.
- Automatic capture gateways, session hooks, reflection, file ingestion, and benchmarks supply stable idempotency keys and consume durable ingest acknowledgements.
- The current `memory_nodes` corpus remains queryable. Existing rows are treated as legacy projections; no fabricated raw history is backfilled.
- Reconsolidation becomes append-only versioning: the corrected memory is a successor node and the previous node remains as historical evidence.
- `cortex_init` reads a deliberately small current working set instead of allowing protected but stale memories to dominate session boot.
- Search uses PostgreSQL lexical search, pgvector semantic search, entity/tag matches, temporal validity, and the working set. Results are fused by rank rather than by incomparable raw score scales. CA3 graph expansion remains optional and must demonstrate incremental lift.
- Dream processing uses confirmed-use and correction evidence rather than candidate access. Automatic synthesis is disabled by default until derived memories demonstrate value; enabled synthesis must enter the normal provenance, retrieval, expiry, and evaluation lifecycle.
- Vitals and self-check read durable capture, retrieval, use, worker, scheduler, and graph-distribution evidence rather than inferring health from corpus size or skill creation age.
- A private causal evaluation runner executes the approved memory-on versus memory-off product metric and records reproducible run metadata.
- The MCP container becomes a long-lived native Streamable HTTP service. It does not launch one child process per client session and does not run migrations.
- Ordered, checked-in migrations are applied by the existing one-shot migration runner. Runtime services verify readiness and never mutate schema at startup.

The approved `oauth-token-and-agent-hardening` plan remains authoritative for public identity, agent isolation, route/tool allowlisting, revocation, private networking, and public log redaction. This initiative depends on that rollout and does not create a second authentication design. Its new internal REST routes remain on the private service network unless that security plan is explicitly amended and re-approved.

There is no new UI.

## Endpoints

- `POST /api/v1/ingest` — existing route; durably records the raw event and idempotency key before provider work. It returns `202 Accepted` with an ingest event ID once capture is safe, or a completed result when bounded synchronous waiting finishes first. Exact retries return the original event/result. A matching source alone never causes a skip.
- `GET /api/v1/ingest/:eventId` — internal status/result lookup for accepted, processing, indexed, failed, or rejected ingest events. Ownership is always agent-scoped.
- `POST /api/v1/search` — existing route; returns a retrieval ID, ranked results, component ranks, and algorithm version. Candidate generation is read-only; only the final delivered memories enter the labile window.
- `POST /api/v1/recall` — existing route; returns a retrieval ID and token-budgeted context selected from valid memory and the current working set. The response identifies exactly which memories were delivered.
- `POST /api/v1/retrievals/:retrievalId/feedback` — private integration route used by gateways, hooks, and the evaluation runner to record which delivered memories were injected, used, cited, harmful, or followed by a correction, plus the task outcome when known. Missing feedback remains unknown rather than being counted as success or use.
- `GET /api/v1/working-set` — private agent-scoped read of active, unresolved, unexpired working items.
- `POST /api/v1/working-set` — private idempotent upsert of a current task, open loop, constraint, correction, or preference.
- `PATCH /api/v1/working-set/:id` — private resolve, expire, or reconfirm operation. Existing `cortex_journal` writes through this path internally, so the MCP catalog does not need another tool.
- `POST /api/v1/reconsolidate` — existing route; creates a successor memory, closes the predecessor's validity window, links both versions, and returns both IDs. It never overwrites the historical content.
- `GET /api/v1/reconsolidate/labile` — existing route; lists only memories actually delivered during the recall window, not pre-ranking candidates.
- `GET /api/v1/vitals` — existing route; adds capture durability/lag, indexing failures, retrieval latency, delivered/injected/used counts, feedback coverage, correction rate, memory-induced harm, working-set freshness, graph strength percentiles, usable-edge share, scheduler freshness, and runtime build identity.
- `GET /livez` — process liveness with no dependency or memory details.
- `GET /readyz` — readiness for the required checked-in migration level, database access, ingest worker ownership, and runtime build identity. Provider degradation is reported by vitals without making already-indexed memory unreadable.

Existing MCP tools retain their names and agent-facing purpose. Their structured responses gain stable ingest/retrieval IDs and explicit lifecycle status. `cortex_init` uses the new working-set and retrieval flow; `cortex_journal` maintains working items; `cortex_ingest` may return safely accepted while indexing continues. No new hosted MCP tool is introduced in this feature.

## Data

All new lifecycle primary keys are application-generated UUIDs. Lifecycle timestamps use `TIMESTAMPTZ` in UTC. New data is installed by the next ordered checked-in migration after the migrations already active in the OAuth-hardening branch; the exact migration number is assigned at Gate 3 to avoid conflicting with concurrent work.

### `memory_ingest_events`

- Immutable accepted capture: agent, idempotency key, raw content, content hash, source and source version/type, observation and fact-validity times, projection mode, requested priority, optional bounded derivation confidence and same-agent source-memory IDs for experimental synthesis, request/session metadata, status, attempt count, bounded failure code, and accepted/started/indexed timestamps.
- Unique `(agent_id, idempotency_key)` makes retry handling deterministic. When a legacy caller supplies no key, the service derives a stable exact-payload key; semantic similarity never masquerades as idempotency.
- Main queries: find-or-create an accepted event; claim pending/retryable work with `FOR UPDATE SKIP LOCKED`; return status/result; calculate accepted-to-indexed durability and lag; surface repeated failures.
- Provider failure leaves the accepted raw event retryable. No embedding, entity, model, or network failure can erase an acknowledged capture.

### `memory_nodes` changes

- Add nullable `ingest_event_id` for provenance. Legacy rows remain valid with null provenance.
- Add an exact content hash for each projected chunk so exact duplicate diagnostics do not depend on embeddings.
- Add the embedding provider/model identity used to create each vector.
- Add a generated lexical-search document with a GIN index over content, summary, entities, and semantic tags.
- Continue using `valid_from`, `valid_until`, and `superseded_by`, but enforce the rule that corrections create a successor instead of mutating historical content.
- `access_count` and `last_accessed_at` become confirmed-use derivatives. Candidate, returned, and injected events are stored separately and do not inflate them.
- Main queries: current valid lexical and vector candidates; exact content hashes for true duplicate diagnostics; successor/predecessor traversal; current-memory projection for existing APIs.

### `memory_provenance`

- Normalized links from a memory node to its ingest event and any source memories, with relation such as `captured_from`, `corrects`, `derived_from`, or `consolidates`.
- Main queries: explain why a memory exists; reconstruct a correction/derivation chain; prevent cross-agent lineage; evaluate whether derived memories are ever useful.

### `working_memory_items`

- Agent-scoped current task, open loop, constraint, correction, or preference with content, optional source memory/event, status, display order, importance, last-confirmed time, expiry, and resolution metadata.
- Active working memory is explicitly bounded. Old P0/P1 storage priority does not automatically place an item here.
- Main queries: active unexpired items for boot; idempotent upsert by agent and caller key; resolve/expire; freshness and stale-open-loop health checks.

### `memory_retrievals`

- One row per search/recall/init operation: agent, request/session identifier, query, channel, algorithm/build version, token budget, candidate/returned counts, latency, and timestamp.
- Main queries: p50/p95 latency, error and empty-result rates, retrieval frequency by integration, feedback coverage, and reproducible evaluation traces.

### `memory_retrieval_items`

- One row per bounded candidate retained for diagnostics: retrieval, exactly one memory, working-item, or cognitive-artifact reference, candidate source, component ranks/scores, final rank, and flags/timestamps for returned, injected, used, cited, corrected, or harmful.
- Candidate rows never mutate the memory. A unique retrieval/item key prevents double-counting feedback.
- Detailed candidates have bounded retention; daily aggregates survive longer. Returned, used, harmful, and evaluation-linked rows are retained long enough to support the product metric and incident review.
- Main queries: retrieval precision and utilization gap, memories repeatedly returned but unused, stale-memory harm, score-component analysis, and evidence supporting an answer.

### `memory_retrieval_feedback_events`

- Immutable, agent-scoped receipt for one feedback call: retrieval, caller idempotency key, canonical request hash, use-attribution completeness, reported retrieval-item IDs by stage, and timestamp.
- Unique `(agent_id, retrieval_id, idempotency_key)` makes multi-item feedback atomic and retry-safe. Reusing a key with a different payload is a conflict; every reported item must belong to the retrieval and agent.
- Main queries: audit delayed or conflicting attribution, make confirmed-use counters exactly-once, and distinguish missing feedback from observed non-use.

### `memory_task_outcomes`

- Optional outcome attached to a retrieval or task: caller-defined task ID, success status/score, evaluator type, correction/repetition signal, harm flag, latency, token counts, and bounded notes.
- Unknown outcomes stay null and are excluded from success-rate claims.
- Main queries: task-success uplift, memory-induced harm, correction rate, and live-versus-evaluation separation.

### `memory_evaluation_runs` and `memory_evaluation_results`

- Run metadata: locked dataset and sampling-manifest hash/version, fixed evaluation-as-of time, condition (`memory_off`, `raw_hybrid`, `cortex`, `oracle`, `irrelevant`, or `stale_conflict`), model identity, seed, build and retrieval versions, start/completion state, aggregate metrics, and confidence interval. The signed or independently reviewed sampling manifest attests that primary cases are real memory-dependent tasks sampled from normal work rather than synthetic or handpicked examples.
- Per-case result: opaque case ID, memory-needed label, explicit setup-event/chunk-to-gold-evidence mapping, rubric score, task success, harmful-memory flag, retrieved/injected/used evidence IDs, latency, tokens, blinded human-adjudication state, and evaluator identity.
- Private task text and gold answers stay in the configured private dataset location; the database stores opaque IDs and results, not another copy of the private corpus.
- Main queries: approved 15-point uplift, headroom against oracle, performance against the raw hybrid baseline, harm rate, and regressions between builds.

### `memory_operation_runs`

- Durable scheduler/worker execution evidence: optional agent, operation, build/worker identity, state, bounded counters/error code, and start/heartbeat/completion times. It records successful zero-output work as well as failure.
- Main queries: active worker ownership, last successful reflection, missing-versus-failed scheduled work, and stale-heartbeat readiness.

### `memory_daily_metrics`

- Content-free per-agent/day/build/retrieval-version rollups of capture, indexing, retrieval, error, empty-result, delivery, injection, use, citation, correction, harm, outcome, latency, token, and feedback-coverage counters/distributions.
- Unique `(agent_id, metric_day, build_id, retrieval_version)` supports retry-safe rollup. Detailed queries, candidate rows, request/session IDs, and memory content are never copied into the aggregate.
- Main queries: long-term lifecycle and utility trends after bounded detailed telemetry expires; build-to-build comparison without retaining user content.

### Existing graph, artifacts, and diagnostics

- `memory_synapses` gains agent ownership and agent-scoped endpoint constraints; the existing hippocampal-code and emotional-valence links become agent-scoped as well. Vitals reports strength percentiles and the share usable at the active CA3 threshold. Candidate appearance no longer strengthens edges.
- Existing `cognitive_artifacts` remain historical. New derived memory that should affect future answers enters the durable ingest/provenance path; artifact delivery/use is recorded through the same retrieval-item evidence, and background artifacts that remain unused past their bounded retention are expired instead of accumulating indefinitely.
- Existing diagnostic and dream logs remain, but health severity is calculated from real capture/index/retrieval/scheduler evidence. Lack of newly created skills alone is informational, not system degradation.

## Flow

1. **Durable capture and indexing**
   - REST, MCP, gateway, hook, reflection, or file import calls the shared ingest service with an agent and idempotency key.
   - A short transaction inserts or finds the immutable ingest event and commits before any external provider call. A duplicate request receives the same event ID and eventual result.
   - A PostgreSQL-backed worker claims accepted/retryable events with `FOR UPDATE SKIP LOCKED`. No external queue is introduced.
   - The worker chunks content, generates and normalizes embeddings, extracts entities/tags, computes optional hippocampal/valence metadata, and writes all projected nodes plus provenance in one transaction.
   - It then forms graph links and marks the event indexed. Provider or process failure records a bounded error and retry state; it never turns a durable acceptance into silent loss.
   - Exact duplicate content may reuse an existing projection while retaining the distinct source event. Semantic similarity only marks a possible update for later reconsolidation; it never drops raw capture.

2. **Retrieval and context assembly**
   - The shared retrieval service loads active working items and independently collects current lexical, vector, entity/tag, and optional graph candidates.
   - Temporal validity and agent ownership filter every candidate before fusion.
   - Reciprocal-rank fusion combines comparable ranks. A bounded deterministic reranker applies currentness, working-set relevance, and explicit user importance; storage priority is not a dominant relevance score.
   - The service writes the retrieval and bounded diagnostic candidates, then returns the requested results and retrieval ID without changing candidate access or resonance.
   - Search results actually returned to the caller enter the labile window. Recall then packs only the highest-value returned items into the token budget and records the delivered set.

3. **Boot and working context**
   - `cortex_init` loads active working items first, followed by a bounded current-memory retrieval for recent corrections, preferences, and task context.
   - Resolved, expired, or unconfirmed stale loops are excluded. P0 continues to protect retention but cannot monopolize boot context.
   - `cortex_journal` reconciles its active threads and concerns into working items; a newer journal can resolve or reconfirm existing items instead of creating another historical pile.

4. **Feedback and demonstrated utility**
   - Gateways and hooks report which returned IDs were injected. The causal evaluation runner records injection, answer evidence, task outcome, and harm automatically.
   - An integration may additionally report used or cited IDs when it can observe them honestly. The absence of such evidence remains `unknown`, not `unused` or `used`.
   - One immutable feedback receipt makes each multi-item observation atomic and idempotent. A memory's confirmed-use count increments at most once per retrieval. Only confirmed use, corrections, and task outcomes can influence utility and later retention.

5. **Versioned correction**
   - A delivered memory is eligible for reconsolidation during the existing window.
   - The correction itself is durably accepted as a new ingest event, then projected as a successor memory with fresh embedding and metadata.
   - In one transaction, the predecessor receives `valid_until` and `superseded_by`; provenance links the pair; the successor becomes current.
   - Historical content remains queryable for audit but is excluded from ordinary current retrieval.

6. **Dream, graph, and forgetting**
   - Nightly maintenance derives utility from confirmed use, successful outcomes, corrections, age, explicit importance, and graph evidence. It never treats pre-ranking candidacy as recall.
   - Resonance is bounded and decomposable. Retention and graph thresholds are calibrated from distributions, not a single average.
   - Automatic synthesis defaults off. If enabled experimentally, a derived fact must include source provenance, confidence, temporal validity, expiry, and the same retrieval/outcome telemetry as captured memory.
   - Pruning first archives projections; immutable raw ingest events and version history follow an explicit retention policy rather than being silently destroyed.
   - Unused background cognitive artifacts expire under a separate bounded rule. Before detailed retrieval telemetry expires, a retry-safe content-free daily rollup preserves lifecycle, utility, latency, and coverage trends.

7. **Health and operations**
   - Liveness checks only the process. Readiness verifies the expected migration checksum, database access, a current worker operation heartbeat/ownership record, and build identity.
   - Vitals derives warnings from accepted-but-not-indexed age, failure/retry rates, capture silence by expected integration, retrieval latency/errors, working-set staleness, feedback coverage, harmful-memory rate, graph percentiles, and actual scheduler last-success records.
   - Reflection or dream health comes from durable job execution, not host-specific file inspection. A healthy system can have no new skills; a busy system can still be unhealthy if it silently loses captures.

8. **Causal evaluation**
   - The runner verifies the locked private cases and reviewed sampling manifest, pins one evaluation-as-of clock, and executes the same model and prompt under memory-off, raw lexical-plus-vector, Cortex, oracle, irrelevant-memory, and stale-conflict conditions.
   - Whole projects/conversations stay in one split. Setup events map explicitly to gold evidence. Every Cortex and memory-off primary holdout result is blindly human-scored against its prewritten rubric; deterministic and LLM-assisted checks may prepare or diagnose a judgment but cannot replace it.
   - The Product gate cannot pass unless every memory-dependent holdout case has a complete paired Cortex/memory-off human judgment, at least 200 such pairs remain, uplift is at least 15 percentage points, and the 95% cluster-bootstrap interval is reported. Results also report memory-induced harm, retrieval/use gaps, latency, and token cost. Retrieval-only public benchmarks remain secondary diagnostics.

9. **Deployment and compatibility**
   - The one-shot migration job applies checked-in migrations. A NOLOGIN memory-runtime group receives only required DML/sequence privileges on memory/cognition data and read access to agent identity; separately provisioned login members receive no OAuth-authority access and no DDL. REST, worker, MCP, and cron only assert readiness. The OAuth gateway retains its separately approved role and boundary.
   - The MCP service uses the SDK's native long-lived Streamable HTTP transport, one connection pool, metadata-only logs, and a version/build identifier shared with REST health.
   - Existing clients are updated to recognize durable `accepted` ingest status and retrieval IDs. During rollout, response fields needed by older clients remain available.
   - The OAuth-hardening plan keeps raw services private and owns hosted route/tool policy. New private lifecycle routes are not exposed publicly by accident.

## External

No new hosted service, search engine, message queue, or database is introduced. Cortex continues to use PostgreSQL with pgvector; PostgreSQL full-text search provides the lexical lane and PostgreSQL row locking provides the durable ingest work queue.

Existing embedding integrations remain supported. Every provider result is normalized before cosine/dot comparisons, and the provider/model identity is recorded with each projection:

- `EMBEDDING_PROVIDER`
- `EMBEDDING_MODEL`
- `EMBEDDING_TIMEOUT_MS`
- `OLLAMA_URL`
- `VOYAGE_API_KEY`

The core retrieval path does not require an LLM. Existing LLM integrations are limited to optional entity extraction, experimental synthesis, and configured evaluation judging:

- `CORTEX_LLM_PROVIDER`
- `CORTEX_LLM_MODEL`
- `CORTEX_LLM_API_KEY`
- `CORTEX_LLM_TIMEOUT_MS`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OLLAMA_API_KEY`
- `OLLAMA_CLOUD_URL`
- `REFLECT_MODEL`
- `REFLECT_FALLBACK_URL`
- `REFLECT_FALLBACK_MODEL`
- `REFLECT_FALLBACK_KEY`

Provider credentials must have no source-code fallback. Missing required credentials disable only the dependent optional operation and appear in readiness/vitals as appropriate; already-indexed recall remains available.

New configuration names:

- `CORTEX_BUILD_ID` — immutable deployment/build identity returned by REST and MCP.
- `CORTEX_INGEST_WORKER_CONCURRENCY` — bounded PostgreSQL-backed worker concurrency.
- `CORTEX_INGEST_MAX_ATTEMPTS` — retry ceiling before an event requires operator attention.
- `CORTEX_RETRIEVAL_CANDIDATE_LIMIT` — diagnostic candidate bound shared by REST/MCP.
- `CORTEX_RETRIEVAL_EVENT_RETENTION_DAYS` — detailed non-evaluation telemetry retention.
- `CORTEX_SYNTHESIS_ENABLED` — explicit experimental switch; default disabled.
- `CORTEX_EVAL_DATASET_PATH` — private locked evaluation set.
- `CORTEX_EVAL_OUTPUT_DIR` — durable redacted reports and case-level result artifacts.
- `CORTEX_EVAL_JUDGE_PROVIDER`
- `CORTEX_EVAL_JUDGE_MODEL`

The separately approved OAuth-hardening environment and trust-boundary design remain unchanged and are a production prerequisite. If this architecture later requires a new hosted MCP tool or public lifecycle route, that earlier plan must be reopened before the surface changes.
