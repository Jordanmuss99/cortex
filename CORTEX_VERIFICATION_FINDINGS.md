# CORTEX -- Verification Findings (2026-06-16)

*A multi-loop audit that re-checked the prior research session's claims against **real source and the live running system**, not memory or documentation. Method: read source in the repo; ran the test suite on the host; queried the live Postgres and the REST API; A/B-tested search paths; cross-checked Cortex's own memories. Where a claim could not be verified, it is marked as such.*

**Conventions:** uses `--` not em-dashes (repo standing-order + drift check). Ports referenced: Cortex REST `:3100`, Cortex MCP (stdio), Meridian `:3456`, cache-fix proxy `:9801`, Postgres `:5432` (Docker `db` service, pgvector pg16).

---

## TL;DR thesis

**The mechanical plumbing is genuinely good; the higher-order "cognitive" features that would make Cortex more than strong RAG are mostly weak or unrealized.**

- *Works and verified:* DG sparse-coding, dedup gate, reconsolidation (gated + audited), temporal validity, scheduling, vitals, 59 passing tests, 100% hippocampal/valence coverage.
- *Weak or unrealized:* CA3 pattern completion (functional but **neutral on LoCoMo accuracy**, Phase 3), compounding-intelligence (44%), emotional-recall (58%), dream synthesis (write-only), skill learning (dead), ~~**CA1 `novelty_score` corrupt**~~ **FIXED 2026-06-20** (`sparseOverlap` dot-product + backfill + dream SQL clamp), ~~priority inflation~~ **FIXED Phase 2**, ~~forgetting~~ **FIXED Phase 2**.

The single highest-leverage move is improving end-to-end answer quality (retrieval is strong; generative F1 ~0.2) and making write-only cognitive layers (dream synthesis, skills) actually retrievable or pruning them.

---

## 1. Corrections to prior beliefs (verified wrong or overstated)

| Prior claim | Reality (verified) |
|---|---|
| "Meridian mangles our requests / harms caching" | False **for Cortex**. Meridian's routing (`mapModelToClaudeModel`, confirmed in `rynfar/meridian` source) is real, but Cortex requests `sonnet-4-6` via one-shot, stateless, non-streaming calls, so flattening/cache/dup-tool_use never apply. Real exposure is only operational coupling (below). |
| "Compliance decays 73%@turn5 -> 33%@turn16" | Not traceable to any measurement in repo/papers/autoresearch. Treat as estimate. |
| "Autoresearch watchdog points at dead docker 5432" | Stale. `cortex-roundtrip-evaluator.ts` already self-rewrites `@host:5432` -> `127.0.0.1:5432`. |
| "Reconsolidation has an un-gated drift loop" | Engine gates it (labile window, explicit call, audit trail). No paraphrase firehose exists in Cortex (only 1 `verified-api` memory live). |
| "P1 inflation is caused by surprise-gating" | **Wrong (corrected this session).** `computeSurpriseGating` is **dead code** (zero callers). Both REST and MCP ingest use CA1 `computeNovelty` via `hippocampalEncode`. Cortex memory #1233 carried the same stale belief; now reconsolidated. |
| "Benchmarks run the CA3 path" | **Wrong.** `longmemeval/results-final.json` scorer is `0.50 cosine + 0.20 text + 0.15 recency + 0.10 resonance + 0.05 priority` -- no CA3. |

---

## 2. What is PROVEN to work (with evidence)

- **Test suite passes.** Ran `npm test` on the host via Desktop Commander: **4 suites, 59 tests, green in 8.8s** (DG, chunker, entities, drizzle-array-cast). Caveat: coverage only -- vitals, hooks, the MCP path, the CA3 blend, and reconsolidation have **no tests**.
- **Data integrity is healthy (live `/api/v1/vitals`).** 868-874 active memories, **100% hippocampal + valence coverage**, 0 orphans, avg synapse strength 0.446, drift 0. `DEGRADED` status is solely the skill stall.
- **DG sparse-coding is a correct implementation** (`dentate-gyrus.ts`): 1024->4096 Gaussian random projection (Box-Muller, variance-preserving), ReLU, top-204 k-WTA (5%), L2-norm, deterministic seed. Not hand-wavy, and 100% applied.
- **Dedup gate works** -- live-refused a near-duplicate at cosine 0.924 (threshold 0.88).
- **Reconsolidation is properly gated** (`reconsolidation/index.ts`): requires the labile window, explicit call, preserves original as a cognitive artifact (verified by using it this session; originals #508/#509 preserved).
- **Scheduling is healthy** (Windows Task Scheduler): 7 Cortex tasks, all `Last Result = 0` (Dream 3:00, Background Threads 3:50, Reflect 3:45, Backup 3:30, Snapshot 4-hourly, Weekly Audit). The dream cycle does real work (last cycle: 850 resonance updates, 30 syntheses).
- **CA1 novelty (`computeNovelty`) is the live ingest path** -- all-time top-5 predictive-coding mismatch (dense+sparse), sparse-gating, contradiction boost. Phase 2 removed its priority side-effect (resonance only). **`sparseOverlap` bug fixed 2026-06-20** (see section 3).

---

## 3. What is WEAK or UNREALIZED (with evidence)

- **CA3 pattern completion -- ~nil realized value (3 defects).**
  1. *Not in the agent path:* MCP `cortex_search`/`cortex_recall` hand-roll inline SQL and never call `patternComplete`. Live A/B (same query) gave a near-inverted top-5 vs REST.
  2. *Prefilter-gated in REST:* `search.ts` applies CA3 only to memories already in the hybrid top-K (`.map(results.rows)`), so CA3 can re-rank but **never inject** a memory the semantic prefilter missed -- defeating the purpose of autoassociative recall.
  3. *Unnormalized:* `ca3Boost = activationScore * 0.3` with activation empirically ~30, so it swamps a hybrid score that maxes ~1.5. When CA3 fires it dominates regardless of relevance.
  - *And* the graph CA3 traverses is **85% entity-co-occurrence** (13,355 `entity_shared` / 2,414 `temporal` / **159 `semantic`**). So even functioning CA3 is closer to an entity join than semantic pattern completion. It was also **not used to produce the benchmark numbers**.
  - *Semantic graph is entity-dominated, but lowering the 0.85 threshold would barely help (Phase 3, 2026-06-20):* live `arlo` synapses are entity 32,939 / temporal 6,262 / semantic 320 (0.8%). Of 4,830 sampled pairs, only **2** fall in cosine 0.75-0.85 and **0** above 0.85 -- the corpus is semantically diffuse, so the sparse semantic graph reflects the *data*, not mainly the threshold.
  - **Phase 1 (2026-06-18):** the three scorers were unified onto `hybridSearch` (MCP + benchmark client delegate), and CA3 was fixed -- normalized (`ca3Score / maxCa3`, weight 0.25), able to inject, gated by `CORTEX_CA3`. Good changes.
  - **CORRECTION (2026-06-18): the first CA3 A/B was INVALID -- a test artifact.** LoCoMo ingest discarded `hippocampalEncode` results -> no `hippocampal_codes` -> CA3 inert -> on==off by construction. *Fixed:* benchmark now persists DG codes (mirrors `api/ingest.ts`). **Phase 3 accuracy A/B (2026-06-20):** full-pipeline LoCoMo, n=231, top-10, CA3 off vs on -- **identical** R@1=53.2%, R@5=88.3%, R@10=95.7%, MRR=67.5%; miss lists byte-identical (`results-retrieval-top10-ca3off-l2.json` / `ca3on-l2.json`). **Decision: NEUTRAL -- keep CA3 ON (default), no `CA3_WEIGHT` change.** CA3 reshuffles on `arlo` (12/12 queries change top-10, 48 injections) but does not improve ground-truth session recall on LoCoMo. CA3 defaults ON (`CORTEX_CA3 !== "off"`); do not gate off by default.
- **Compounding intelligence: 44%** on CogBench (its own benchmark) -- the "gets smarter over time" capability is the weakest measured.
- **Emotional recall: 58%** on CogBench (`emotionalRecallAdvantage` 0.5). The valence machinery barely moves recall -- and the code explains why: `valence/analyzer.ts` is a hardcoded English keyword lexicon with crude `String.includes` substring matching (`"won"` matches "wonder", `"fire"` matches "fired"), presence-counts, and arbitrary multipliers. It is an admitted "Phase 1" stub, yet it feeds a real `0.10 * recall_boost` term in ranking. Worse, `RELEVANCE_CORE` includes `"cortex"/"memory"/"agent"`, so this self-referential corpus is systematically relevance-boosted toward meta-content.
- **Dream synthesis is template filler, write-only.** Phase 5 produces exactly 30/night (its `LIMIT`); every `implication` is `Memory from [A] connects to [B]` from entity-set intersection (150 actionable / 48 not). ~198 accumulated, and since both search paths query `memory_nodes` (not `cognitive_artifacts`), they are **never retrieved**. (Phase 4 candidate generation is fine; Phase 5 is the gap -- see `CORTEX_DREAM_REASONING_UPGRADE.md`.)
- **Skill learning is dead -- behavioral, not a bug.** `recordExecution` works; the tool + hooks both remind and detect non-compliance; one skill has an execution. Live: 15 skills, 7 executions total. Agents simply never call `cortex_skill_executed`. *Also:* `retrieveProcedural` applies **no minimum-similarity floor** -- it always returns up to `limit` skills ordered by trigger/cosine even when the best match is ~0.25, which is why a memory-audit query surfaced SimsOnline coding skills. The trigger match is an 80-char `ILIKE` substring (near-never fires), and proficiency advancement (3/10/20 executions) is unreachable given the dead loop.
- **"Autonomous cognition" (background threads) is deterministic SQL, not reasoning.** `cognition/background-threads.ts` runs three hand-coded SQL health-checks (strategic stalled-P0/P1 detection, operational diagnostics, relational contact-overdue) emitting templated insights stored as artifacts; only the strategic `nextAction` is surfaced (in `cortex_init`). Two sub-checks are effectively dead: strategic `knownCritical` is an empty array (entity-coverage no-op), and the operational cron check reads `~/.openclaw/cron/jobs.json`, which does not exist on this Windows host -- so it is blind to the real scheduler (the same blind spot as `self_check`). Useful where it fires (stalled-item detection), but it is bookkeeping, not cognition.
- **Priority is inflated; no demotion.** ~~Live: P0=103, P1=350, P2=416, **P3/P4=0** (52% critical/high). Cause: CA1 `computeNovelty` promotes highly-novel content one tier (`max(0, basePriority-1)`), reflections/agents ingest at P1, and **nothing ever demotes** + the P1 cap guard was never shipped. Priority no longer discriminates for ranking or forgetting.~~ **FIXED 2026-06-18 (Phase 2):** CA1 no longer promotes priority from novelty (only resonance). New dream-cycle Phase 1b reconciles priority from sustained signals: demotes old/low-resonance/never-accessed P1->P2, enforces P0+P1 cap (25% target), and re-promotes genuinely active P2s. Pruning now reaches P1 (guarded). **Arlo before: P0=300(18.2%), P1=486(29.4%), P2=865(52.4%), P0/P1=47.6%. After: P0=300(18.2%), P1=113(6.8%), P2=1237(75.0%), P0/P1=25.0%.** Distribution converges and is stable across cycles.
- **Forgetting barely happens -- and the root cause is the priority gate.** 874 active vs **32 archived lifetime** (~28 before this session's dupe cleanup); corpus grows monotonically since 2026-05-14. The dream's Phase-2 pruning is reasonable code (adaptive P5/P15 resonance percentiles, age gates, salience exemption) **but it only considers `priority > 1`** -- so the inflated 52% at P0/P1 is *structurally unprunable*, and the valence stub's `decay_resistance` exempts more. Pruning code is fine; it is defeated by upstream priority inflation. (The belief that "dream clustering keeps P1 manageable" is false.)
- **Resonance measures popularity, not value.** Phase-1 resonance is dominated by `access_count` + connectivity + priority; the Ebbinghaus time-decay term is only weight 0.15 and is further slowed by a stability factor. So frequently-recalled/connected memories stay high while genuinely-useful-but-unaccessed notes look low-value (e.g. a local-LLM hardware note sat at resonance 0.5 simply because nothing had recalled it). Confirms the prior "resonance = salience, not correctness/stability" finding.
- **~~`novelty_score` corrupted by live CA1 math bug~~ FIXED (2026-06-20).** Root cause: `sparseOverlap()` used unbounded min-sum (pairs reached 7.48+). **Fix shipped:** dot-product on shared indices (true sparse cosine, [0,1]), output clamp in `computeNovelty`, dream resonance SQL clamp, `scripts/backfill-novelty.ts`. **Arlo after backfill:** median **0.177** (was -1.98), mean 0.179, **0 negative / 1726 in [0,1]**.
- **Lowering the 0.85 semantic-synapse threshold would NOT meaningfully enrich the graph (corrects an earlier suggestion).** Live synapses: entity 32,860 / temporal 6,252 / semantic 320. Of 4,830 sampled arlo pairs, only 2 sit in cosine 0.75-0.85 and 0 above 0.85 -- the corpus is semantically diffuse, so the sparse semantic graph reflects the *data*, not just the threshold. **DG pattern separation, by contrast, is verified working** (sparse Jaccard << dense cosine, order preserved).
- **Embeddings are a generation behind.** On `voyage-3`; `voyage-4` series (Jan 2026) is strictly better; `voyage-code-3` likely better for this code-heavy corpus. All are 1024-dim (incl. local `mxbai-embed-large`), so a switch is a re-embed, not a schema change. Only a single retry on failure -> the ingest timeouts.

---

## 4. Benchmarks: honest read

- **LongMemEval 100%** = the **oracle** (easy, "cleaned") dataset, session-level **retrieval-only**, a **no-CA3** 5-factor scorer, with **mixed embeddings** (mxbai for Q1-302, voyage-3 for Q303-500). Real, but not the agent's workload.
- **LoCoMo 93.6% Recall@10** is more honest, but **Recall@1 is only 57.9%** -- acting on the single top memory is right ~58% of the time.
- **CogBench 0.785 composite** is a **CORTEX-only self-scorecard** (no RAG/baseline in the harness; the "RAG <5% by design" line is paper narrative, not code). Strong on mechanical CRUD (temporal 1.0, reconsolidation 0.99); weakest on the "intelligence" tasks (compounding 0.44, emotional 0.58).
- **End-to-end answer accuracy: MEASURED (complete run), and far below retrieval.** Ran the generative harness (`locomo/run.ts`, dataset on E:, isolated `benchmark-locomo` agent, `--limit 3`, n=30, completed). Authoritative result (`results-top10.json`, 2026-06-17): **avgF1 = 0.199, exact-match = 3.3% (1/30), retrieval = 1.0.** By category: Cat1 multi-hop F1 0.29 (n=12), **Cat2 temporal F1 0.115 (n=14)**, Cat3 open-domain F1 0.067 (n=3). So retrieval is *perfect* (the right session is always in top-10) but turning it into the gold answer scores ~0.2 token-F1 and matches exactly only ~3% of the time -- worst on temporal/date questions. This is the sharpest confirmation of BENCHMARKS.md's own caveat (*"CORTEX finds the right memory; the LLM answers -- different jobs"*): the 93.6-100% retrieval headline says nothing about answer accuracy. Caveats: n=30 (small); `--limit 3` = first 3 Q/conversation (not random); token-F1 penalizes verbose-but-correct phrasing so semantic correctness is somewhat higher than 0.199; answer LLM was Meridian's sonnet-tier. (An earlier `--limit 5` run showing avgF1 0.024/total 50 was INVALID -- contaminated by a mid-run Max usage outage; the current results file is the valid n=30 run.)

---

## Phase 1 Follow-up: Unified retrieval & honest CA3 A/B (2026-06-18)

Phase 1 completed: MCP `cortex_search` / `cortex_recall` now call the same `hybridSearch` scorer as REST; CA3 injection and normalization defects are fixed; an honest A/B was run.

### What changed

- `src/api/search.ts`: exported `hybridSearch` with an options interface; fixed CA3 to (a) inject CA3-only candidates into the candidate set (not just re-rank the hybrid top-K) and (b) normalize activation scores to [0,1] before blending with weight 0.25. Added `CORTEX_CA3=off` env switch to cleanly disable CA3.
- `src/mcp/server.ts`: `cortex_search` and `cortex_recall` now delegate to `hybridSearch`, preserving skill surfacing, verbose formatting, and token-budget trimming.
- `benchmarks/lib/cortex-client.ts`: benchmark `search()` now uses `hybridSearch` so the benchmark scorer matches production.
- `benchmarks/locomo/run-retrieval.ts`: supports `LOCOMO_DATA`, `--full-pipeline` (required for CA3 because fastMode skips hippocampal encoding), `--limit N`, and exits cleanly.
- Added `src/__tests__/search.test.ts`: 5 tests covering CA3 disable, CA3-only injection, normalization preventing auto-rank #1, empty CA3 no-op, and hybrid/blended score exposure.

### Honest CA3 A/B

Method: LoCoMo retrieval-only benchmark, top-10, full hippocampal pipeline (synapses + sparse codes enabled), same two conversations in both runs, only `CORTEX_CA3` toggled.

- CA3 **off**: 231 questions, R@10 = 95.67%, MRR = 66.0%
- CA3 **on**: 231 questions, R@10 = 95.67%, MRR = 66.0%
- Miss lists are identical.

Conclusion: that run was **invalid** (missing hippocampal codes). Superseded by Phase 3 below.

### Implications (Phase 1)

- The "three different scorers" divergence is resolved: benchmark, REST, and MCP now use one scorer.

---

## Phase 3 Follow-up: CA3 accuracy + neuroscience probes (2026-06-20)

### Task A -- CA3 accuracy A/B (valid full-pipeline)

Method: LoCoMo retrieval-only, `--full-pipeline`, n=231 questions (2 conversations, cat5 excluded), top-10, hippocampal codes + synapses persisted, only `CORTEX_CA3` toggled.

| Metric | CA3 off | CA3 on | Delta |
|---|---|---|---|
| R@1 | 53.2% | 53.2% | 0 |
| R@5 | 88.3% | 88.3% | 0 |
| R@10 | 95.7% | 95.7% | 0 |
| MRR | 67.5% | 67.5% | 0 |

Miss lists identical (10 misses each, same ranks). By category: Cat1 R@1=46.5%, Cat2 R@1=49.2% (weakest), Cat3 R@1=18.2%, Cat4 R@1=61.4%.

**Decision:** **NEUTRAL.** Keep `CORTEX_CA3` **ON** (production default). No `CA3_WEIGHT` (0.25) tuning warranted -- CA3 reshuffles results on `arlo` but does not improve ground-truth session recall here. Generative F1 re-run with CA3 on vs 0.199 baseline still open.

### Task B -- Neuroscience layer probes

1. **Semantic graph / threshold (corrects earlier handoff):** Lowering `synapse-formation.ts` threshold from 0.85 to ~0.75 would **not** meaningfully enrich the graph. Live counts above; pair sampling shows almost no cosine-neighbor pairs in the 0.75-0.85 band. Graph enrichment is low-ROI unless corpus character changes.

2. **DG pattern separation: VERIFIED.** Sparse Jaccard rises with dense cosine but stays well below it (orthogonalization). Low-cosine pairs near-zero overlap. DG is not the bottleneck.

3. **CA1 novelty calibration: FIXED (2026-06-20).** See section 3. Next dream cycle will use clean novelty in resonance.

### Harness improvements (this session)

- `run-retrieval.ts`: added `--qlimit N` (cap questions/conversation) and CA3/semantic-threshold tags in output filenames.
- `synapse-formation.ts`: `CORTEX_SEMANTIC_THRESHOLD` env override for experiments (default 0.85).

## 5. Operational findings

- **Meridian coupling (the real, narrow risk).** Cortex's `llm.ts` builds the Anthropic client with no `baseURL`, inheriting `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`. So per-ingest entity-extraction (`CORTEX_LLM_ENTITIES=true`) and dream summaries depend on Meridian being up + Max-OAuth-authed + pinned. If it is down/repinned, they fail or silently run on an unexpected model. Going local (below) removes this.
- **Ingest timeout -> duplicate race (caught live).** The MCP ingest writes server-side even when the call times out (large content -> Voyage+NER fan-out, ~25-30s/chunk). Retries then duplicate. This session created dup pairs `#1640~#1643` (0.989) and `#1641~#1644` (0.935); the dedup gate did not catch them (first write uncommitted when the retry's check ran). **Cleaned up:** archived `1640,1641,1642` and `1663` (redundant copies; complete copies kept at `1643-1646` and `1660-1662`). Fix: idempotency key on ingest, or a post-write dedup sweep, or raise/await the MCP timeout.
- **`self_check` is blind to the scheduler** -- reports "0 cron jobs" though 7 Windows tasks fire. Cosmetic but misleading.
- **Secrets:** live scan found **0** secret-shaped tokens. `scrub.ts` only scrubs em-dashes, not PII/secrets -- clean by practice, not by guard.
- ~~**Three divergent scoring formulas**~~ **FIXED Phase 1:** benchmark, REST, and MCP now share `hybridSearch`.

---

## 6. Environment reference

- **Hardware:** RTX 4070 Ti (12 GB VRAM; ~10-11 GB usable -- Virtual Desktop/Meta virtual monitors present), Ryzen 7 5800X3D (8c), 96 GB RAM, Windows 11 Pro.
- **Local-LLM plan (for dream/NER):** Qwen3 14B (Q4_K_M, on-GPU) for latency-sensitive per-ingest NER; DeepSeek-R1-Distill-Qwen-32B (or Qwen3.6-32B thinking; or 35B-A3B MoE via llama.cpp `-ncmoe`) for nightly deep synthesis, offloaded into 96 GB RAM. Serve via Ollama; wire with `CORTEX_LLM_PROVIDER=openai` + `OPENAI_BASE_URL=http://127.0.0.1:11434/v1` (no code change). Keep Voyage for embeddings.

---

## 7. Ranked recommendations

1. **~~Port a fixed CA3 into the MCP path and benchmark it honestly.~~ DONE (Phases 1+3).** Valid full-pipeline A/B: CA3 neutral on LoCoMo accuracy (R@1/MRR unchanged). Keep ON by default; revisit if graph/corpus changes.
2. **~~Fix CA1 `sparseOverlap` + backfill novelty~~ DONE (2026-06-20).** Next dream cycle will apply clean resonance; monitor pruning behavior.
3. **Phase-5 dream reasoning upgrade** (see `CORTEX_DREAM_REASONING_UPGRADE.md`): replace the entity-intersection template with an LLM reasoning pass over Phase-4 candidates; make syntheses retrievable.
4. **Stand up the local LLM** (removes Meridian coupling + ingest timeouts for NER).
5. **Embeddings:** re-embed on `voyage-4` (test `voyage-code-3`); add a Voyage reranker pass at the REST layer; increase retry/backoff or move embeddings local.
6. **Add a `cortex_vitals` MCP tool** so the agent can see its own health.
7. **Make ingest idempotent** (or post-write dedup) to kill the timeout-retry duplicate class.
8. **Delete the dead `computeSurpriseGating`** and update stale comments/docs that reference it as active.

---

## 8. Remaining unknowns

- **Generative F1 with CA3 on** vs the 0.199 baseline (`locomo/run.ts`, local Ollama preferred).
- Whether the ~198 write-only synthesis artifacts should be pruned or surfaced.
- Multi-agent isolation / `cross-agent-transfer` correctness beyond the 0.82 score.
- Corpus composition is now known (584 api / 259 reflection / 37 markdown / 3 git-commit / 1 verified-api; reflections ~30%); still open is whether those nightly reflections are net-useful or noise.

*(Examined this session and folded above: valence analyzer, synapse-formation thresholds, CA1, scrub/secrets, scheduling, the resonance-decay + pruning math -- forgetting is defeated by the `priority > 1` prune gate + inflation -- and the existence of a generative-QA harness.)*
