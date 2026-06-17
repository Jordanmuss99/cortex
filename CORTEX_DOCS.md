# CORTEX -- Documentation Index & System Overview

*Start here. This is the map to all Cortex documentation and a verified, high-level overview of how the system actually works. Last reconciled against source + the live running system: 2026-06-17.*

Convention: `--` is used instead of em-dashes (repo standing-order; the drift check counts em-dashes).

---

## What Cortex is

Cortex is a **biologically-inspired persistent memory system for AI agents**, written in TypeScript on PostgreSQL + pgvector. An agent ingests text (sessions, files, reflections); Cortex chunks + embeds it (Voyage, 1024-dim), runs a hippocampus-style encode (DG sparse separation + CA1 novelty), forms a synapse graph, and serves recall via hybrid scoring. A nightly "dream cycle" updates resonance, prunes, and forms associations. It is exposed to agents as an **MCP tool surface (~30 tools)** and a **REST API** (`/api/v1/*`). The fork here is ~28 commits ahead of `ATERNA-AI/cortex` (vitals, hooks, enforcement, observability, correctness fixes).

**One-line honest assessment** (see findings doc): the retrieval/CRUD plumbing is real and works well; the higher-order "cognitive" features (CA3 pattern completion, dream synthesis, skill learning, compounding intelligence) are largely unrealized today.

---

## The document set

| Document | Purpose | Status / authoritative for |
|---|---|---|
| **CORTEX_DOCS.md** (this file) | Index + verified system overview | Current. Start here. |
| **CORTEX_TECHNICAL_REFERENCE.md** | Full how-it-works detail (topology, data model, pipelines, MCP/REST, deploy) | Current + mostly accurate. Authoritative for *mechanics*. Read alongside the findings doc for live numbers. |
| **CORTEX_VERIFICATION_FINDINGS.md** | What is actually TRUE vs aspirational, verified against source + live system (2026-06-16/17) | Current. **Authoritative for what's real, measured numbers, and corrections.** |
| **CORTEX_PROBLEMS_AND_RISKS.md** | 30-item ranked problem/risk register | Current (prior session); cross-check specifics against the findings doc. |
| **CORTEX_INTEGRATION_DESIGN.md** | Proposal: deterministic memory-injection gateway | Proposal (corrected). The "Meridian collision" section was overstated and has been fixed. |
| **CORTEX_DREAM_REASONING_UPGRADE.md** | Proposal: make dream Phase-5 LLM-driven reasoning | Proposal. |
| **CORTEX_RESEARCH_BRIEF.md** | Strategy brief / framing | Prior session; the "73->33 compliance" stat is an unverified estimate (see findings doc). |
| README.md / REFERENCES.md | Upstream marketing + neuroscience citations | Upstream text (the headline benchmark claims carry heavy caveats -- see findings doc S4). |

---

## How it works (verified overview)

### Topology & ports
- **Postgres + pgvector** (Docker `db`, pg16) on `:5432` -- the store.
- **REST API** (`src/index.ts`, Express) on `:3100` -- `/api/v1/{search,recall,ingest,reconsolidate,procedural,graph,cognition,vitals,dream,health}`.
- **MCP server** (`src/mcp/server.ts`, ~1,373 lines, ~30 tools) over stdio -- the agent-facing surface.
- **Meridian** (`:3456`) -- a Claude-Max proxy; Cortex's LLM client inherits it as `ANTHROPIC_BASE_URL` for entity-extraction + dream summaries. (Operational coupling, not "mangling" -- findings doc S5.)
- **Embeddings:** Voyage `voyage-3` (1024-dim); a local Ollama provider (`mxbai-embed-large`) is also supported.
- Nightly jobs run via **Windows Task Scheduler** (not an internal cron) -- 7 tasks, all healthy.

### Data model (16 tables, `src/db/schema.ts` + `init-cortex-db.sql`)
- **Core memory:** `agents`, `memory_nodes` (content, embedding vec(1024), entities[], priority P0-P4, resonance, status active/archived/deleted, temporal `valid_from`/`valid_until`/`superseded_by`), `memory_synapses` (type causal/temporal/semantic/entity_shared, strength, decay), `hippocampal_codes` (DG sparse indices/values, dim 4096, novelty_score).
- **Affect & skills:** `emotional_valence` (6 dims + intensity/decayResistance/recallBoost), `procedural_memories` (skills: steps, proficiency, execution_count).
- **Cognition & introspection:** `cognitive_artifacts` (decision/correction/insight/synthesis/reasoning_trace/background_thread), `dream_cycle_logs`, `self_diagnostics` (proprioception), `agent_state_logs`, `principal_state` (empathic ADHD/energy/stress modeling), `background_threads` (strategic/operational/relational), `relationship_graph` (social).

### Ingestion pipeline (`api/ingest.ts`, mirrored in MCP)
chunk (256 tok / 25 overlap) -> Voyage embed -> `hippocampalEncode` = **DG** sparse-separate + **CA1** `computeNovelty` (sets priority/resonance; NOTE the older `computeSurpriseGating` is dead code) -> entity + semantic-tag extraction (regex + optional LLM NER) -> store node + hippocampal code -> `formSynapses` (semantic >0.85 cosine; entity_shared IDF-weighted; temporal same-source) -> valence analysis.

### Retrieval -- THREE non-identical scorers (findings doc S1)
- **REST `/api/v1/search` + `/recall`** -> `hybridSearch`: 6-factor hybrid **+ CA3 blend** (`+0.3 x activation`, re-sorted). CA3 here is prefilter-gated (re-rank only) and unnormalized.
- **MCP `cortex_search` / `cortex_recall`** -> hand-rolled inline SQL, hybrid + emotional boost, **no CA3**. This is the path agents actually use.
- **Benchmark harness** -> its own 5-factor hybrid, **no CA3**.
These do not match; the published numbers reflect the benchmark scorer, not the agent's MCP path.

### Dream cycle (`dream/dream-cycle.ts`, nightly 03:00)
Phase 1 resonance (Ebbinghaus stability-adjusted; dominated by access+connectivity+priority, not time) -> Phase 2 pruning (adaptive P5/P15 percentiles, **only `priority > 1`** -> P0/P1 are unprunable) -> Phase 3 cluster summary (LLM, 150 tok, extractive fallback) -> Phase 4 free association (dense 0.6-0.85 + sparse-overlap candidate synapses) -> Phase 5 "synthesis" (currently entity-intersection template, not reasoning -- see upgrade doc).

### Self-awareness / cognition layers (back the MCP tools)
- **Proprioception:** `self-check.ts` (health), `journal.ts` (state logging).
- **Empathy:** `empathy/state-model.ts` -- infers principal energy/stress/focus/ADHD state from message patterns (lexicon/heuristic).
- **Metacognition:** `reasoning.ts` (decision traces), `audit.ts` (weekly calibration audit), `inner-monologue.ts`.
- **Autonomous cognition:** `cognition/background-threads.ts` -- strategic/operational/relational SQL health-checks (deterministic, not LLM).
- **Social:** `social/relationships.ts` -- contact graph + freshness.
- **Perception:** `perception/screen-observer.ts` -- screen capture for context.

### Interfaces
- **MCP (~30 tools):** init, search, recall, ingest, reconsolidate, skill_{store,retrieve,executed,refine}, reason, journal, self_check, audit, assess_state, relationship*, observe, monologue, synthesize, dream, status, etc. Server declares the Recall-and-Reconsolidate loop in its instructions.
- **REST:** the `/api/v1/*` endpoints above, incl. the strong `vitals` early-warning engine (REST-only -- no MCP tool yet).

---

## What's real vs aspirational

For the honest, evidence-backed picture -- proven plumbing, the CA3/synthesis/skills/priority/forgetting gaps, the live metrics (52% P0/P1, 85% entity synapses, dream syntheses write-only, end-to-end answer F1 ~0.3-0.4 vs ~0.98 retrieval), and the ranked fixes -- read **CORTEX_VERIFICATION_FINDINGS.md**. Do not trust a benchmark number without its caveats there.

---

## Reading order by goal
- **Understand the system:** this file -> TECHNICAL_REFERENCE -> VERIFICATION_FINDINGS.
- **Decide what to fix:** VERIFICATION_FINDINGS (S7 ranked recommendations) -> PROBLEMS_AND_RISKS.
- **Build the gateway / dream upgrade:** INTEGRATION_DESIGN / DREAM_REASONING_UPGRADE.

## Source-of-truth pointers (where to edit what)
- Retrieval scoring: `src/api/search.ts` (REST+CA3) and `src/mcp/server.ts` (MCP, no CA3).
- Ingest/novelty/priority: `src/api/ingest.ts` -> `src/hippocampus/{index,ca1-novelty,dentate-gyrus}.ts`.
- Dream/forgetting: `src/dream/dream-cycle.ts`. Synapses: `src/ingestion/synapse-formation.ts`.
- Embeddings/Voyage: `src/ingestion/embeddings.ts`. LLM/Meridian: `src/lib/llm.ts`.
- Data model: `src/db/schema.ts` + `init-cortex-db.sql`. Health rules: `src/api/vitals.ts`.
