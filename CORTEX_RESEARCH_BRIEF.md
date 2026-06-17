# CORTEX — Deep Research Brief & Integration Recommendation

*Prepared for Obsidian · based on the paper + a full read of this local fork (`Jordanmuss99/cortex`, branch `superhighway-and-tweaks`, upstream `ATERNA-AI/cortex`) + a live probe of the running MCP server.*

---

## 1. What it is, in one breath

CORTEX is a **stateful memory substrate for AI agents** built on PostgreSQL + pgvector, modelled on the hippocampal–cortical circuit. It is not a vector DB and not RAG: it adds pattern separation, novelty gating, autoassociative recall, emotional weighting, temporal validity, an offline "dream" consolidation cycle, belief reconsolidation, and procedural-skill learning on top of a vector store. It is exposed two ways: a **REST API** (`src/index.ts`, port 3100) and an **MCP stdio server** (`src/mcp/server.ts`, ~30 tools). Both hit the same Postgres.

The live server in this deployment is real and running: agent `arlo` currently holds **848 active memories / 15,067 synapses / avg resonance 8.69**, with a `full` dream cycle that completed **2026-06-15 17:00** (nightly cron is live).

---

## 2. How it actually works (paper ↔ code)

### 2.1 Ingest pipeline (`cortex_ingest` / REST `/ingest`)
`chunk → embed → near-dup gate → DG sparse-encode → CA1 novelty → store node → store sparse code → valence → form synapses`

- **Chunking + embedding** (`ingestion/chunker.ts`, `embeddings.ts`): text is chunked and embedded to **1024-dim** vectors. Provider is pluggable: `voyage` (voyage-3, what this deployment uses and what the benchmarks use) or `ollama` (mxbai-embed-large, documented as lower quality). Voyage calls have a 3-try exponential-backoff wrapper for TLS drops.
- **Near-duplicate gate** (custom, see §4): single-chunk ingests whose top cosine match ≥ `CORTEX_DUP_THRESHOLD` (0.88) are **refused**; the matched memory is made labile and you're told to `cortex_reconsolidate` instead. This is the enforcement mechanism for "update, don't append."
- **Dentate Gyrus** (`hippocampus/dentate-gyrus.ts`): deterministic random projection 1024 → **4096**, ReLU, **k-WTA at 5% (K=204)**, L2-normalize. Seed = `314159265` (pi), Mulberry32 + Box-Muller — so identical inputs give identical sparse codes everywhere (also used as a provenance fingerprint). This is what stops "every Tuesday standup looks the same."
- **CA1 novelty** (`ca1-novelty.ts`): compares the new item against the weighted centroid of its top-5 neighbours in *both* dense and sparse space (0.6 dense / 0.4 sparse). High novelty boosts resonance and elevates priority; redundancy lowers resonance but **still stores** (biologically faithful). Has sparse-gating (suppress false novelty when DG recognizes the pattern) and contradiction-boost.
- **Valence** (`valence/analyzer.ts`): a 6-D vector (valence, arousal, dominance, certainty, relevance, urgency) → intensity, decay-resistance, recall-boost. Drives both recall ranking and dream pruning protection.
- **Synapse formation** (`synapse-formation.ts`, heavily customized here): links new nodes to others, **IDF-weighting entity-shared synapses by the rarest shared entity** (a local improvement over upstream).

### 2.2 Retrieval
Two different search paths — **this matters for your question:**

| | MCP `cortex_search` (`mcp/server.ts`) | REST `/api/v1/search` (`api/search.ts`) |
|---|---|---|
| 6-factor hybrid score | ✅ | ✅ |
| CA3 pattern-completion blend (`+0.3·activation`) | ❌ **not wired in** | ✅ (`patternComplete`) |
| Procedural-skill discovery rides results | ✅ | (varies) |

**The 6-factor hybrid** (identical weights both paths): `0.45·cosine + 0.18·text + 0.12·recency(30-day half-life) + 0.10·resonance/10 + 0.05·priority + 0.10·emotional_boost`, filtered by temporal validity (`valid_from/valid_until`).

CA3 (`ca3-pattern-completion.ts`) DG-encodes the query, pulls a top-20 sparse-overlap set, then spreads activation through the synapse graph for 2 iterations (β=0.3, min-strength 0.15), pulling in strongly-connected neighbours. **It is only in the REST path.** (Note: CA3 was silently dead in production until an April-2026 drizzle array-cast fix — the codebase has a history of features that compiled but threw at runtime; see §5.)

### 2.3 Dream cycle (`dream/dream-cycle.ts`, nightly cron)
Two stages, five phases:
- **SWS** — (1) Resonance analysis: Ebbinghaus stability-adjusted decay, where access count + connectivity slow forgetting; (2) Adaptive pruning: **percentile-based** (P5 delete / P15 archive) with safety floors, P0/P1 and emotionally-salient memories protected; (3) Consolidation: union-find clustering of high-resonance nodes → LLM abstractive summary per cluster → strengthen intra-cluster synapses.
- **REM** — (4) Free association: random + sparse-overlap pairing to mint novel weak synapses; (5) Synthesis: turn new cross-source synapses into "insight" artifacts.

### 2.4 Reconsolidation (`reconsolidation/index.ts`)
Recall (`search`/`recall`) sets `last_recalled_at`, opening a **1-hour labile window**. `cortex_reconsolidate` then: timestamps the old version (`valid_until=now`), saves the original as a `correction` artifact (audit trail), re-embeds, re-encodes through DG/CA1, +1.5 resonance, clears labile. Beliefs evolve in place with history preserved.

### 2.5 The rest of the brain
Procedural memory (skills with proficiency that grows only when `cortex_skill_executed` is called), proprioception (`self_check` drift/orphan diagnostics), metacognition (`reason` traces + weekly `audit` for overconfidence bias + `monologue`), empathy (`assess_state` of the human), autonomous `bg_thread`s (strategic/operational/relational), social `relationship` graph, and `observe` (screen capture). **16 tables** across these layers (`db/schema.ts`).

---

## 3. The MCP surface & the "Recall-and-Reconsolidate" loop

The server ships an `instructions` block (delivered to every client) + `IDE_INSTRUCTIONS.md` that encode an 8-step loop: boot with `cortex_init` → search before deciding → reconsolidate over ingest → capture novel facts at the moment of discovery → retrieve/record skills → log decisions with honest confidence → consult Open Loops instead of asking "what next" → assess principal state on clear signals. Style rule: no em-dashes in stored content (a drift self-check literally counts them).

This loop exists because **the authors measured that models don't use memory well on their own**: 72 ingests vs 13 reconsolidations in a week; 15 skills with 1 recorded execution; boot-instruction compliance decaying from ~73% at turn 5 to ~33% by turn 16. Everything in §4 is their response to that finding.

---

## 4. What's custom in *your* fork (vs upstream `ATERNA-AI/cortex`)

You diverge from upstream by ~3,900 inserted lines. The material additions:

- **Host hooks** (`scripts/hooks/`) — the real "make the AI use it" layer:
  - `cortex-session-start.mjs`: on boot, hits REST `/health`+`/status`+`/search` and prints an auto-loaded context block (so recall isn't optional). Re-runs work-scoped after compaction. Also surfaces the **previous session's compliance scorecard**.
  - `cortex-user-prompt-submit.mjs`: injects a 2-line protocol "pulse" **every turn** (countering instruction decay) + a throttled task-aware `recall` (≤ every 10 min).
  - `cortex-session-end.mjs`: parses the transcript, counts cortex tool usage by verb, computes loop "gaps" (NO-CORTEX, WRITE-WITHOUT-READ, INGEST-HEAVY, SKILL-NOT-RECORDED) and writes a verdict that the next session's start hook reads back. A self-correcting compliance loop.
- **Vitals API** (`src/api/vitals.ts`, custom): `/api/v1/vitals` observability + early-warning rules (dup formation, em-dash drift, stale dream cycle, synapse collapse, missing hippocampal codes, ingest/reconsolidate imbalance), all thresholds tunable via `CORTEX_VITALS_THRESHOLDS`.
- **Cognition API** (`src/api/cognition.ts`), near-dup **gate on the REST ingest path** too, temporal-validity enforcement in production retrieval, IDF-weighted entity synapses, and a pile of drizzle array-cast fixes that revived CA3 + reconsolidation.
- **Ops** (`local-customizations` branch + working tree): `scripts/cortex-mcp.cmd` launcher (sets cwd so `.env` loads, then `tsx src/mcp/server.ts`), `init-cortex-db.sql`, smoke tests, `list_agents.js`, autoresearch/watchdog scaffolding (`.omc/`, `scripts/autoresearch/`).
- **Local LLM routing** (`.env`): `EMBEDDING_PROVIDER=voyage` (real key), but the **Anthropic LLM is pointed at a local proxy** `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` with a dummy key, and `CORTEX_LLM_ENTITIES=true` (every ingest does LLM NER through that proxy). If that proxy is down, dream summaries fall back to extractive and entity extraction to regex.

---

## 5. Honest caveats (verify before you trust a claim)

- **Two different benchmark stories.** `BENCHMARKS.md` advertises **100%** R@1/5/10 on LongMemEval — but its own reproduce command uses `--dataset oracle` (the easy subset). The **paper** explicitly says "*not* the oracle subset" and reports **R@1 89.4 / R@10 97.8 / MRR 93.0** on the full 500-question haystack. Trust the paper's full-haystack numbers. LoCoMo (~93.6 R@10, no LLM) is consistent across both and is the genuinely strong result.
- **Scale claims are aspirational.** README: "5,000+ memories, 1.9M+ synapses per agent." Live `arlo`: 848 / 15,067. Fine for a personal deployment — just don't take the headline as your baseline.
- **MCP search ≠ benchmark search.** As in §2.2, the MCP `cortex_search` the model calls does **not** include the CA3 boost; the benchmarked/REST path does.
- **Silent-failure history.** CA3 and reconsolidation both threw on every call in production for a while (drizzle serializes JS arrays as composite ROWs Postgres won't cast). There's now a regression test, but treat "advertised neuroscience feature" as "verify it's firing" — the vitals endpoint and `cortex_self_check` exist precisely for this.
- **Single-author, fast-moving.** Lots of value, but rough edges; pin versions and keep your smoke tests.

---

## 6. The actual question: tune the MCP server, or build from scratch?

**Recommendation: keep the MCP server as the model-facing tool surface, do NOT rebuild the memory engine, and put your "build" effort into the deterministic orchestration layer around it (REST + hooks) — which you've largely already built.**

Reasoning:

1. **Don't rebuild the engine.** DG/CA1/CA3 + dream + reconsolidation + valence + the tuned 6-factor weights + the Postgres schema represent real, benchmark-validated, stateful work. Re-implementing it would be months for no retrieval gain. The only reasons to go greenfield on the *core* are: you can't run Postgres+pgvector, you need a non-TS/Python runtime, or you genuinely only need plain top-k semantic recall (in which case `cortex-lite`/a vanilla vector store is the right smaller tool, not a rewrite).

2. **But the MCP server alone, used by a vanilla client, will be under-utilized** — the authors proved this with their own telemetry. Tool availability ≠ tool use. Models forget to recall, ingest duplicates instead of reconsolidating, and never record skill executions. So the leverage is **not** in the MCP tools; it's in making the baseline behaviour non-optional.

3. **The winning architecture is hybrid:**
   - **Deterministic layer (your code, via REST):** every turn/session, *your* middleware calls `/search` or `/recall` and injects the result, and captures durable facts — without asking the model to choose. This is exactly what your three hooks do. Route this through **REST**, because REST has the CA3 blend the MCP tool lacks.
   - **Model-initiated layer (MCP tools):** reserve the tools for the things that genuinely need agency — `reconsolidate`, `skill_retrieve/refine`, `reason`, `assess_state`, `dream`. Keep the `instructions` + a per-turn pulse so the model knows they exist.
   - **Audit layer:** the session-end compliance scorecard closes the loop. Keep it.

   In short: **"build from scratch" is the right instinct only for the thin host integration, not for Cortex itself — and you already have that layer.** The highest-value new work is hardening and generalizing it, not replacing the engine.

### When "from scratch / don't use MCP" actually wins
- Your host has **no MCP and no hook support** → drive Cortex purely from the REST API in your own agent loop (the hooks already prove the REST surface is sufficient).
- You want memory to be **truly un-bypassable** → a request/response middleware (proxy in front of the model) that does recall-inject on input and capture on output is stronger than any tool the model must choose to call. Cortex's REST API is built for exactly this.

---

## 7. Optimal-setup checklist (for "the AI uses it best")

1. **Run both surfaces** against one Postgres: REST (`npm run dev` / `tsx src/index.ts`, :3100) for deterministic hooks, MCP (`scripts/cortex-mcp.cmd`) for model calls.
2. **Wire the three hooks** into the host (Claude Code `settings.json` SessionStart / UserPromptSubmit / SessionEnd). This is the single biggest utilization lever.
3. **Fix the `agent_id` foot-gun.** *Every* tool defaults to `agent_id="arlo"` (and `resolveAgent` stamps `ownerId="rez"`). If more than one project shares this DB and you don't pass a stable `agent_id`, memories cross-contaminate. Set `CORTEX_AGENT_ID` per agent/project and pass `agent_id` on direct tool calls. This is the #1 thing to get right.
4. **Close the CA3 gap.** Either point deterministic recall at REST `/search` (has CA3), or add `patternComplete` blending into the MCP `cortex_search` so model-initiated search is as strong as the benchmark path.
5. **Keep the nightly dream cron** (confirmed at 17:00). Add `cortex_self_check` / `/vitals` to a heartbeat so silent failures (missing hippocampal codes, synapse collapse, dup drift) surface early. Run `npm run backfill:hippocampal` if vitals flags missing codes.
6. **Mind the local LLM proxy.** Dream consolidation + (because `CORTEX_LLM_ENTITIES=true`) entity NER both depend on `127.0.0.1:3456`. Keep it up, or accept extractive/regex fallbacks; it also adds ~$0.001 + latency per ingest.
7. **Embeddings:** stay on `voyage-3` to match benchmark quality; don't silently switch to Ollama. Query vs document `input_type` asymmetry is already handled.
8. **Tune gates if needed:** `CORTEX_DUP_THRESHOLD` (0.88 dedup) and `CORTEX_VITALS_THRESHOLDS`.
9. **Keep the em-dash discipline** in anything written to Cortex (the drift self-check counts them and will flag your agent as "drifting").

---

## 8. Where to go deeper next (open threads)
- Read `src/api/search.ts` end-to-end and decide whether to port CA3 into the MCP tool.
- Read `src/ingestion/synapse-formation.ts` (your IDF-weighting) and `src/metacognition/audit.ts` (bias detection) — both heavily customized here.
- Inspect the `local-customizations` branch diff vs `superhighway-and-tweaks` to reconcile which custom ops you actually want on the running branch.
- Decide multi-agent strategy (one DB many `agent_id`s vs DB-per-agent) before usage grows.
