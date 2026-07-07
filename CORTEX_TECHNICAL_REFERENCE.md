# CORTEX — Complete Technical Reference

*Module-by-module reference for this fork (`Jordanmuss99/cortex`, branch `superhighway-and-tweaks`). Built from a full read of `src/`, the REST + MCP surfaces, the scheduler wiring, deployment files, and a live probe of the running server (agent `arlo`: 848 active memories / 15,067 synapses / avg resonance 8.69, nightly dream at 17:00). DG determinism + pattern separation were independently reproduced.*

This document is the "how every part works" companion to `CORTEX_RESEARCH_BRIEF.md` (strategy) and `CORTEX_PROBLEMS_AND_RISKS.md` (defects/foot-guns).

> **Read with `CORTEX_VERIFICATION_FINDINGS.md` (2026-06-17).** That doc is authoritative for what is actually true vs aspirational and for all live-measured numbers; start from `CORTEX_DOCS.md` for the full map. Two corrections post-date this reference: (1) priority/novelty is assigned by CA1 `computeNovelty` -- the older `computeSurpriseGating` is **dead code**; and (2) end-to-end generative answer accuracy has now been measured (LoCoMo F1 ~0.3-0.4 / ~50% pass vs ~0.98 retrieval; temporal/date questions ~0). Treat any benchmark number here as retrieval-only with the caveats in the findings doc.

---

## 0. System topology (what runs where)

```
                 ┌──────────────────────────────────────────────────┐
   host LLM ─────┤  Windows Task Scheduler (the real cron)           │
   client        │   • "Cortex Dream Cycle"   → tsx dream-cycle.ts   │
   (Claude Code/ │   • "Cortex Background Threads"/audit             │
   OpenCode/     │       → scripts/run-metacognition.ts all          │
   OpenClaw)     │   • "Cortex Nightly Reflect" (EXTERNAL producer)  │
       │         └──────────────────────────────────────────────────┘
       │ stdio (MCP)                         │ REST :3100
       ▼                                     ▼
 ┌───────────────┐  hooks (your fork)  ┌───────────────────────┐
 │ src/mcp/      │◀───────────────────▶│ src/index.ts (Express)│
 │ server.ts     │   session-start /   │ /api/v1/* routers     │
 │ ~30 tools     │   prompt / end      └───────────┬───────────┘
 └───────┬───────┘                                 │
         └──────────────┬──────────────────────────┘
                        ▼
        ┌───────────────────────────────────┐     LLM proxy
        │ PostgreSQL 16 + pgvector (16 tbls) │   127.0.0.1:3456
        │ Voyage voyage-3 (1024-d) embeds    │  (dream summaries,
        └───────────────────────────────────┘   entity NER)
```

Two process entry points share one Postgres: the **REST server** (`src/index.ts`, port 3100) and the **MCP stdio server** (`src/mcp/server.ts`, launched by `scripts/cortex-mcp.cmd`). The **host hooks** (your fork) call REST to auto-inject memory and reinforce the protocol. Offline jobs (dream, metacognition, reflect) are driven by **Windows Task Scheduler**, not OpenClaw cron or `setInterval`.

---

## 1. Data model (16 tables, `src/db/schema.ts` + `init-cortex-db.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `agents` | Multi-agent isolation | `external_id` (e.g. "arlo"), `owner_id` (defaults "rez") |
| `memory_nodes` | Episodic memories | `embedding vector(1024)`, `priority` 0–4, `resonance_score`, `status` (active/archived/deleted), `valid_from/valid_until/superseded_by`, `last_recalled_at`, `novelty_score`, `entities[]`, `semantic_tags[]` |
| `memory_synapses` | Associative graph | `memory_a/b`, `connection_type` (semantic/entity_shared/temporal), `connection_strength`, `decay_rate`, unique on (a,b,type) |
| `hippocampal_codes` | DG sparse codes | `sparse_indices[]` (~204), `sparse_values[]`, `sparse_dim` 4096, GIN index on indices |
| `emotional_valence` | 6-D VAD+ | valence/arousal/dominance/certainty/relevance/urgency + intensity/decay_resistance/recall_boost/dominant_dimension |
| `procedural_memories` | Skills | `proficiency` (novice→expert), `execution_count`, `success_rate`, `steps[]`, `version`, `embedding` |
| `cognitive_artifacts` | Decisions/learnings | `artifact_type` (decision/learning/correction/insight/synthesis/reasoning_trace/audit/audit_feedback/inner_monologue/background_thread), `content jsonb` |
| `dream_cycle_logs` | Sleep run logs | `cycle_type`, `stats jsonb`, `insights_discovered` |
| `self_diagnostics` | Proprioception | `drift_score`, `overall_health`, `alerts[]` |
| `agent_state_logs` | Agent journal | `energy_state`, `confidence`, `active_threads`, `concerns[]`, `notes` (feeds Open Loops) |
| `principal_state` | Empathy model of human | `energy`, `stress`, `focus_state`, `adhd_state`, `confidence_score` |
| `background_threads` | Autonomous cognition | `thread_type`, `findings`, `next_action` (feeds Open Loops) |
| `relationship_graph` | Social | `person_name`, `contact_frequency`, `open_items jsonb`, `importance_score` |

Indexes that matter: **HNSW** on `memory_nodes.embedding` (`m=16, ef_construction=64`), GIN on `entities`, `semantic_tags`, `hippocampal_codes.sparse_indices`, plus composite `(agent_id,status,priority)` and `(memory_a,connection_strength)`. `initDatabase()` (`src/db/index.ts`) applies all of this idempotently on every boot via `CREATE … IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` — schema is self-healing, so a fresh Postgres needs no manual migration step beyond starting the server. (`init-cortex-db.sql` is the docker first-boot equivalent.)

**DB driver note:** `src/db/index.ts` uses `postgres-js` (not Neon HTTP) with a compat shim that re-adds `.rows`/`.rowCount`. `rowCount` is taken from postgres-js `result.count` — this is the fix for the "dream stats all zero" bug (deriving it from `arr.length` reported 0 for every UPDATE).

---

## 2. Ingestion pipeline

Path (both `cortex_ingest` MCP tool and `POST /api/v1/ingest`):
`chunk → embed → near-dup gate → per-chunk[ DG → CA1 → insert node → novelty → sparse code → valence ] → formSynapses`

- **Chunker** (`ingestion/chunker.ts`): `cl100k_base` tokenizer, **CHUNK_SIZE = 256 tokens** (not 512 — the comment is stale; reduced for mxbai context), overlap 25. ≤256 tokens → single chunk.
- **Embeddings** (`ingestion/embeddings.ts`): provider via `EMBEDDING_PROVIDER` (this deployment = `voyage`, voyage-3, 1024-d). `document` vs `query` input_type asymmetry. 3-try exponential backoff on Voyage TLS drops. Ollama (`mxbai-embed-large`) is the documented-lower-quality alternative.
- **Near-duplicate gate** (your fork): single-chunk ingests whose nearest cosine ≥ `CORTEX_DUP_THRESHOLD` (0.88) are blocked. **MCP refuses** (returns guidance + makes the match labile → reconsolidate); **REST skips** (returns `{skipped:true, duplicateOf}`) because automation can't act on a refusal. **Multi-chunk ingests bypass the gate entirely** (so anything >256 tokens is never dedup-checked).
- **DG** (`hippocampus/dentate-gyrus.ts`): 1024→4096 deterministic Gaussian projection (Mulberry32 seed 314159265, Box-Muller), ReLU, k-WTA top-5% (K=204), L2-norm. *Verified: identical input → identical code; dense cos 0.916 → sparse Jaccard 0.478 (separation works).*
- **CA1 novelty** (`hippocampus/ca1-novelty.ts`): compares to weighted centroid of top-5 neighbours in dense (0.6) + sparse (0.4) space. High novelty → resonance ×1.6 and priority −1; redundant → resonance ×0.6 (but still stores). Sparse-gating suppresses false novelty; contradiction-boost for dense-far + sparse-far.
- **Entities** (`ingestion/entities.ts`): **fast mode** = a hardcoded `KNOWN_ENTITIES` dictionary (project-specific: SimsOnline, rts_fps, s&box, Cortex, OpenCode…) + proper-noun regex with junk-phrase filtering. **LLM mode** (`CORTEX_LLM_ENTITIES=true`, on here) adds Claude NER via the proxy, falls back to fast on error. Canonical entity names are load-bearing — synapse formation keys on them.
- **Valence** (`valence/analyzer.ts`): pure English lexicon heuristic (<1ms). Produces VAD + relevance/urgency → intensity, decay_resistance, recall_boost. Lexicon is business-assistant-flavoured (revenue/client/OKR; bug/error = negative).
- **Synapse formation** (`ingestion/synapse-formation.ts`, your fork): three batched discovery queries — **semantic** (cosine>0.85, LATERAL top-10), **entity_shared** (IDF-weighted `0.8 − 0.1·ln(1+df)` clamped 0.3–0.8, so rare shared entities = strong, hub entities = weak), **temporal** (same `source`, strength 0.4). Upsert with `onConflictDoUpdate` keeping the max strength.

---

## 3. Retrieval — two paths, not identical

**6-factor hybrid score** (same weights in MCP and REST):
`0.45·cosine + 0.18·text_ILIKE + 0.12·recency(30-day e-decay) + 0.10·resonance/10 + 0.05·priority + 0.10·emotional_recall_boost`, filtered to temporally-valid active rows.

| Path | CA3 blend | Notes |
|---|---|---|
| MCP `cortex_search` / `cortex_recall` | **No** | inline SQL only; also attaches matching procedural skills to search output |
| REST `/api/v1/search` / `/api/v1/recall` | **Yes** (`+0.3·activation`, then re-sort) | `recall` calls `hybridSearch`, so it inherits CA3 |

**CA3** (`hippocampus/ca3-pattern-completion.ts`): DG-encode query → top-20 by sparse overlap (GIN `&&` prefilter) → 2 iterations of activation spreading through synapses (β=0.3, min strength 0.15, pulls in strong neighbours >0.5 on iter 0). Additive: if it throws (e.g. no hippocampal codes), hybrid still returns. *Was silently dead in prod until the April-2026 drizzle array-cast fix; now covered by `drizzle-array-cast.test.ts`.*

**Side effect:** every search/recall marks returned ids `last_recalled_at = NOW()` (`markLabile`) — opening the 1-hour reconsolidation window. In REST search this is deliberately **not** wrapped in try/catch (loud failure by design); access-count telemetry is best-effort.

**Token-budget recall**: greedily fills ~80% of budget with memories (truncating high-score overflow to 400 chars) + ~20% recent artifacts.

---

## 4. Dream cycle (`dream/dream-cycle.ts`, nightly via Task Scheduler)

SWS: **(1) Resonance** — Ebbinghaus stability-adjusted: `resonance = 10·(0.15·decay/stability + 0.2·ln(access) + 0.25·connectivity + 0.2·priority_w + 0.1·access + 0.1·novelty)`, where `stability = 1 + 0.3·ln(access+1) + 0.2·connectivity`. **(2) Pruning** — percentile thresholds (P5 delete / P15 archive) computed from the agent's own distribution, with floors (delete ≤2.0, archive ≤4.0); **only `priority>1` and not emotionally-salient** rows are eligible; weak synapses decayed then deleted <0.1; observations >7d purged. **(3) Consolidation** — union-find clusters of resonance≥5 nodes; LLM abstractive summary per cluster (extractive fallback if proxy down); intra-cluster synapses +0.2.

REM: **(4) Free association** — 50 random nodes, sampled pairs with cosine 0.6–0.85 → new weak semantic synapses; plus sparse-space pairs with DG overlap 0.15–0.45 (structurally-similar / semantically-divergent). **(5) Synthesis** — recent weak cross-source synapses → "synthesis" artifacts.

Live last run (full, 1.7s): resonance updated 850, archived 2, deleted 0, clusters 3, consolidations 3, synapses strengthened 283, novel synapses 2, syntheses 30.

---

## 5. Reconsolidation (`reconsolidation/index.ts`)

`markLabile` (on recall) sets `last_recalled_at`. `reconsolidate(id, newContent, reason)` checks the 1-hour window, then: `valid_until=NOW()` on the old version → store original as a `correction` artifact (audit trail) → re-embed → re-run DG/CA1 → overwrite content/embedding/entities/tags, `resonance +1.5` (cap 10), `valid_from=NOW()`, `valid_until=NULL`, `last_recalled_at=NULL` → replace the hippocampal code. This is the "update, don't append" mechanism; live data shows it's actively used (corrections #481–485).

---

## 6. Self-awareness layers

- **Proprioception** (`proprioception/self-check.ts`): four checks — OpenClaw skill files (`~/.openclaw/skills/{cortex-v2,screen-awareness}/SKILL.md`), OpenClaw cron (`~/.openclaw/cron/jobs.json`), channels, and **cognitive integrity** (orphans >100, missing hippocampal codes >50, synaptic collapse <0.15 avg, procedural learning stall >7d). Drift = em-dash + sycophancy count in last 20 artifacts. `journal.ts` writes `agent_state_logs` (feeds Open Loops).
- **Metacognition**: `reasoning.ts` stores decision traces (resonance = max(5, confidence·8)); `audit.ts` weekly calibration (overconfidence if avg>0.85, uniform-high flag, contradiction detection, optional `CORTEX_WORKSPACE/SOUL.md` alignment) and **writes an `audit_feedback` artifact at resonance 8.0 so corrections resurface in `cortex_init`**; `inner-monologue.ts` stores loose thoughts.
- **Empathy** (`empathy/state-model.ts`): infers principal energy/stress/focus/ADHD from message patterns + a **hardcoded daily-schedule baseline for one specific person** (workout M/W/F, family 6–9pm protected, afternoon dip). Returns communication guidance.
- **Autonomous cognition** (`cognition/background-threads.ts`): strategic (stalled P0/P1 with no synapse activity 7d → the "Open Loops next action"), operational (diagnostics/cron/memory health), relational (overdue contacts/open items). Deterministic (no LLM). Triggered by `run-metacognition.ts` or the `cortex_bg_thread` tool.
- **Perception** (`perception/screen-observer.ts`): Windows PowerShell foreground-window metadata + full-screen PNG to `~/.cortex/observations/`, returns the path for the multimodal host to read. Stored as `source_type='observation'`, pruned after 7 days.

---

## 7. MCP tool surface (`src/mcp/server.ts`, ~30 tools)

Boot/core: `cortex_init`, `cortex_search`, `cortex_recall`, `cortex_ingest`, `cortex_ingest_file`, `cortex_ingest_corpus`, `cortex_status`, `cortex_dream`, `cortex_artifact`.
Evolution: `cortex_reconsolidate`, `cortex_labile`.
Skills: `cortex_skill_store/retrieve/executed/refine`.
Self-awareness: `cortex_self_check`, `cortex_journal`, `cortex_assess_state`, `cortex_state_history`, `cortex_bg_thread`, `cortex_synthesize`, `cortex_observe`, `cortex_relationship(s)`, `cortex_relationship_update`, `cortex_reason`, `cortex_audit`, `cortex_monologue`.

Every tool defaults `agent_id="arlo"`; `resolveAgent` auto-creates a missing agent with `owner_id="rez"`. The server ships an `instructions` block (the 8-step Recall-and-Reconsolidate loop) delivered to every client, and self-terminates on stdin EOF (Windows orphan/leak fix).

---

## 8. Configuration (env)

| Var | Effect | This deployment |
|---|---|---|
| `DATABASE_URL` | Postgres+pgvector | set (redacted) |
| `EMBEDDING_PROVIDER` / `VOYAGE_API_KEY` | embeddings | `voyage` + real key |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | LLM for dream summaries + NER | dummy key + **proxy `127.0.0.1:3456`** (Anthropic SDK reads `ANTHROPIC_BASE_URL` from env) |
| `CORTEX_LLM_ENTITIES` | LLM NER on every ingest | `true` (~$0.001 + latency/ingest, via proxy) |
| `CORTEX_LLM_PROVIDER`/`_MODEL` | provider/model | default anthropic, model `claude-sonnet-4-6-20250514` (proxy must map it) |
| `CORTEX_DUP_THRESHOLD` | dedup gate | default 0.88 |
| `CORTEX_VITALS_THRESHOLDS` | vitals warning rules (JSON) | tunable, hot-reload |
| `CORTEX_WORKSPACE` | file watcher root + audit alignment | optional |
| `CORTEX_AGENT_ID` (hooks) | which agent the hooks target | default `arlo` |

Hooks add: `CORTEX_REST_BASE` (127.0.0.1:3100), `CORTEX_BOOT_QUERY/LIMIT/PREVIEW`, `CORTEX_PULSE_RECALL_MS` (600000), `CORTEX_PULSE_BUDGET` (1200).

---

## 9. Deployment options

- **This deployment (host-side):** `scripts/cortex-mcp.cmd` runs the MCP server via `tsx`; REST runs separately; Postgres is remote/local (redacted URL); LLM via local proxy; offline jobs via Windows Task Scheduler. Hooks wired into the host client.
- **Reference (docker-compose):** three services — `db` (pgvector pg16, 127.0.0.1:5432), `cortex` (REST 127.0.0.1:3100), `cortex-mcp` (MCP exposed over HTTP via `supergateway` on 127.0.0.1:8000). Mounts `~/.openclaw` and `~/.cortex/config`. All ports bound to localhost.
- **Vitals as the real health surface:** `GET /api/v1/vitals?agentId=…` evaluates dream/reflect/threads staleness, dup formation, em-dash drift, synapse collapse, missing hippocampal codes, ingest/reconsolidate ratio — each rule maps to a failure this system actually hit. Prefer this over `cortex_self_check`'s cron check (which only sees OpenClaw cron, not the Task Scheduler jobs).

---

## 10. The "autoresearch loop" (context for the iterate-until-told paradigm)

`.omc/autoresearch/` + `scripts/autoresearch/` implement a mission-driven evaluator (`cortex-roundtrip-omo-omc`) that, each iteration, drives Cortex through **both** MCP stdio and REST (≈45 timed calls: 20 ingests, 20 recalls, status, self-check, health, search) and grades reliability + latency, **looping through non-passing results until a max-runtime ceiling** (30 min watchdog / 4 h improvement). It's the in-repo precedent for "keep running until a terminal condition," and a ready-made harness for regression-testing both surfaces after any change.

---

## 11. Source-of-truth pointers (where to edit what)

| Want to change… | Edit |
|---|---|
| Search weights | `src/api/search.ts` (REST) **and** `src/mcp/server.ts` cortex_search SQL (kept in sync by hand) |
| CA3 in MCP search | add `patternComplete` blend to `src/mcp/server.ts` (currently REST-only) |
| Dedup strictness / coverage | `CORTEX_DUP_THRESHOLD`; multi-chunk gate logic in `api/ingest.ts` + `mcp/server.ts` |
| Pruning aggressiveness | `dream/dream-cycle.ts` `phasePruning` percentiles/floors |
| Valence lexicon | `src/valence/analyzer.ts` signal lists |
| Canonical entities | `src/ingestion/entities.ts` `KNOWN_ENTITIES` |
| Empathy schedule | `src/empathy/state-model.ts` `getTimeBasedBaseline` |
| Health rules | `src/api/vitals.ts` `THRESHOLD_DEFAULTS` or `CORTEX_VITALS_THRESHOLDS` |
| Protocol nudges | `scripts/hooks/*.mjs` + MCP `instructions` + `IDE_INSTRUCTIONS.md` |

---

## 12. Benchmark methodology — verified at code level (read this before trusting a number)

Both harnesses (`benchmarks/longmemeval/run.ts`, `benchmarks/locomo/run-retrieval.ts`) score the **same way** via `benchmarks/lib/scorer.ts`:

1. **Per question, the corpus is wiped and re-ingested** (`clearBenchmarkData` then ingest only that question's haystack sessions). So retrieval is tested against *one question's haystack*, never a large mixed store.
2. **Recall is session-level, not chunk-level.** A "hit" = at least one *expected session id* appears in the top-K retrieved (results are deduped to their `source` = `"{bench}/{sessionId}"`). `recallAtK` = `expected.some(e => top_k.includes(e))`; MRR from the rank of the first correct session.
3. **The candidate pool is small.** LongMemEval `oracle` (the runner's **default** `--dataset oracle`) has a tiny haystack per question; `longmemeval_s` has a median ~45 sessions; LoCoMo has ~19–32 sessions per conversation. So "R@10" means "is the right session in the top 10 of ~25–45 candidates" — a *forgiving* bar (you're returning a third to a half of everything).
4. **Adversarial/unanswerable (LoCoMo cat 5) is skipped** entirely.

**Implication for the headline numbers:**
- `BENCHMARKS.md`'s **100% LongMemEval** is produced by the runner's **default oracle dataset** (small haystack) — reproducible but easy.
- The **paper's `longmemeval_s` full-haystack numbers (R@1 89.4 / R@10 97.8 / MRR 93.0)** are the credible, harder result. Use these.
- LoCoMo **93.6 R@10 no-LLM** is real and genuinely good *for this metric*, but remember it's "rank the right session in top-10 of ~25." It is **not** evidence about needle-in-5,000-memories recall, which is the actual production workload. CORTEX's CA3/DG machinery is designed for the harder case, but the published benchmarks don't stress it.

Bottom line: the numbers aren't fabricated, but the task is more forgiving than the framing implies. The honest comparison is "no-LLM retrieval recall at session granularity," and on that narrow metric CORTEX does lead the cited systems.

---

## 13. Measured performance (from the autoresearch baseline, `.omc/.../iteration-0003`)

The fork's own round-trip evaluator measured the live MCP+REST stack on 2026-05-14. When healthy (iteration-0003, **47/47 calls OK**):

| Metric | Measured | Target |
|---|---|---|
| MCP recall p95 | **400 ms** | <500 ms |
| MCP ingest p95 | **689 ms** | <2000 ms |
| Full round-trip (20 ingest + 20 recall + status + self-check + 4 REST) | **18.5 s** | 3–7 min budget |
| Health endpoints | all healthy | — |

**Real failure modes observed** (these are *the* operational risks, not hypotheticals):
- **MCP `-32001` timeout** — host-side `localhost` resolved IPv6 first on Windows + Docker and stalled the postgres-js handshake. Fix: use `127.0.0.1` everywhere (this is why the hooks hardcode `127.0.0.1:3100`).
- **Voyage 429** — free tier is 3 RPM / 10K TPM; 17/20 ingests+recalls throttled until a payment method was added. Embedding rate limits are the throughput ceiling at scale.
- **DB `ECONNREFUSED 127.0.0.1:5432`** — a later watchdog tick caught Postgres down (all 47 calls failed, p95 jumped to 7–11 s). The watchdog (Windows Task Scheduler, 30-min cadence, `IgnoreNew`, 15-min kill) works as a real liveness monitor.

Note: the autoresearch data is from mid-May against the **docker** DB (5432); the **current** production deployment uses a different `DATABASE_URL` (the live `cortex_status` responds fine), so those `ECONNREFUSED` ticks reflect the old docker stack being down, not the current store.

---

## 14. Precise fork delta vs upstream (`ATERNA-AI/cortex`)

As of the locally-cached `upstream/main`, HEAD (`superhighway-and-tweaks`) is **28 commits ahead and 0 behind** — i.e. these 28 commits *are* your entire customization over upstream:

- **Observability/enforcement layer (the high-value custom work):** `/api/v1/vitals` early-warning engine + tunable/hot-reload thresholds; `/api/v1/cognition`; near-duplicate **ingest gate** on both MCP (refuse) and REST (skip); MCP **server `instructions`** + loop-compliance feed-forward; opportunistic principal-state assessment; **temporal-validity** enforcement in production search; **em-dash scrub at write time**; IDF-weighted + batched **synapse formation**; entity junk-rejection/compound-capture fixes; `cortex_ingest` matched to the REST pipeline (DG+valence+synapses).
- **Correctness fixes:** postgres-js `result.count` row-count fix (the "dream stats all zero" bug); `refineProcedural` text[] literal fix; reflection/git-commit/verified-api source-bucket fix; stderr-only logging; exit-on-stdin-disconnect (Windows orphan/leak).
- **Ops (the `local-customizations`/working-tree material):** `scripts/cortex-mcp.cmd` launcher, `init-cortex-db.sql`, the three **Claude Code hooks**, `run-metacognition.ts`, backfills, smoke tests, and the **autoresearch watchdog** harness; docker hardening + IPv4 port pinning.

**The marketing docs are NOT customized.** README.md, BENCHMARKS.md, and the technical-note show as "modified" only because of **CRLF line endings** (Windows checkout) — `git diff --ignore-all-space` shows **zero** content changes. So every claim in those files is upstream's, not yours. (Side effect: those three files will show as perpetually "modified" in `git status`; consider a `.gitattributes` `* text=auto` / `eol=lf` to stop the churn.)

*Caveat: `upstream/main` is the locally-cached ref; it may lag the live GitHub upstream, so a few of the 28 commits could have been upstreamed since the last fetch.*
