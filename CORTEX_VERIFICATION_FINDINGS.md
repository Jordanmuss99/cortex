# CORTEX -- Verification Findings (2026-06-16)

*A multi-loop audit that re-checked the prior research session's claims against **real source and the live running system**, not memory or documentation. Method: read source in the repo; ran the test suite on the host; queried the live Postgres and the REST API; A/B-tested search paths; cross-checked Cortex's own memories. Where a claim could not be verified, it is marked as such.*

**Conventions:** uses `--` not em-dashes (repo standing-order + drift check). Ports referenced: Cortex REST `:3100`, Cortex MCP (stdio), Meridian `:3456`, cache-fix proxy `:9801`, Postgres `:5432` (Docker `db` service, pgvector pg16).

---

## TL;DR thesis

**The mechanical plumbing is genuinely good; the higher-order "cognitive" features that would make Cortex more than strong RAG are mostly weak or unrealized.**

- *Works and verified:* DG sparse-coding, dedup gate, reconsolidation (gated + audited), temporal validity, scheduling, vitals, 59 passing tests, 100% hippocampal/valence coverage.
- *Weak or unrealized:* CA3 pattern completion (~nil realized value), compounding-intelligence (44% on its own benchmark), emotional-recall (58%), dream synthesis (template co-occurrence, write-only), skill learning (dead), ~~priority (inflated, no demotion)~~ **FIXED 2026-06-18: priority now discriminates (47.6% -> 25.0% P0/P1)**, ~~forgetting (barely runs)~~ **FIXED: Phase 1b demotion + cap guard + pruning reach**.

The single highest-leverage move is not more features -- it is making the **one** flagship feature (CA3) real where the agent uses it, and **benchmarking it honestly** against the no-CA3 hybrid that already scores 100% on the easy split.

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
- **CA1 novelty (`computeNovelty`) is sophisticated and is the live path** -- all-time top-5 predictive-coding mismatch (dense+sparse), sparse-gating to suppress false novelty, contradiction boost. (Its priority side-effect feeds inflation; see below.)

---

## 3. What is WEAK or UNREALIZED (with evidence)

- **CA3 pattern completion -- ~nil realized value (3 defects).**
  1. *Not in the agent path:* MCP `cortex_search`/`cortex_recall` hand-roll inline SQL and never call `patternComplete`. Live A/B (same query) gave a near-inverted top-5 vs REST.
  2. *Prefilter-gated in REST:* `search.ts` applies CA3 only to memories already in the hybrid top-K (`.map(results.rows)`), so CA3 can re-rank but **never inject** a memory the semantic prefilter missed -- defeating the purpose of autoassociative recall.
  3. *Unnormalized:* `ca3Boost = activationScore * 0.3` with activation empirically ~30, so it swamps a hybrid score that maxes ~1.5. When CA3 fires it dominates regardless of relevance.
  - *And* the graph CA3 traverses is **85% entity-co-occurrence** (13,355 `entity_shared` / 2,414 `temporal` / **159 `semantic`**). So even functioning CA3 is closer to an entity join than semantic pattern completion. It was also **not used to produce the benchmark numbers**.
  - *Root cause of the starved semantic graph:* `synapse-formation.ts` only forms a `semantic` edge at cosine **> 0.85** (near-duplicate level), so almost nothing associative is ever linked at ingest (hence 159 lifetime). Entity edges are sensibly **IDF-weighted** (`clamp(0.8 - 0.1*ln(1+df), 0.3, 0.8)`, so hub entities floor at 0.3), but they dominate by count. Lowering the semantic threshold (~0.75) would build a real associative graph for CA3 to use.
  - **RESOLVED (Phase 1, 2026-06-18):** the three scorers were unified onto `hybridSearch` (MCP `cortex_search`/`cortex_recall` and the benchmark client now delegate to it), and CA3 was fixed -- normalized (`ca3Score / maxCa3`, weight 0.25) and able to inject, gated by `CORTEX_CA3`. The honest A/B (LoCoMo, n=231, top-10) then found **no recall improvement from CA3: 95.67% both on and off.** So the flagship feature, once properly wired and measured, **does not improve retrieval** -- it is gated **off** by default pending a measured gain. Retrieval is excellent (~95.7%) without it.
- **Compounding intelligence: 44%** on CogBench (its own benchmark) -- the "gets smarter over time" capability is the weakest measured.
- **Emotional recall: 58%** on CogBench (`emotionalRecallAdvantage` 0.5). The valence machinery barely moves recall -- and the code explains why: `valence/analyzer.ts` is a hardcoded English keyword lexicon with crude `String.includes` substring matching (`"won"` matches "wonder", `"fire"` matches "fired"), presence-counts, and arbitrary multipliers. It is an admitted "Phase 1" stub, yet it feeds a real `0.10 * recall_boost` term in ranking. Worse, `RELEVANCE_CORE` includes `"cortex"/"memory"/"agent"`, so this self-referential corpus is systematically relevance-boosted toward meta-content.
- **Dream synthesis is template filler, write-only.** Phase 5 produces exactly 30/night (its `LIMIT`); every `implication` is `Memory from [A] connects to [B]` from entity-set intersection (150 actionable / 48 not). ~198 accumulated, and since both search paths query `memory_nodes` (not `cognitive_artifacts`), they are **never retrieved**. (Phase 4 candidate generation is fine; Phase 5 is the gap -- see `CORTEX_DREAM_REASONING_UPGRADE.md`.)
- **Skill learning is dead -- behavioral, not a bug.** `recordExecution` works; the tool + hooks both remind and detect non-compliance; one skill has an execution. Live: 15 skills, 7 executions total. Agents simply never call `cortex_skill_executed`. *Also:* `retrieveProcedural` applies **no minimum-similarity floor** -- it always returns up to `limit` skills ordered by trigger/cosine even when the best match is ~0.25, which is why a memory-audit query surfaced SimsOnline coding skills. The trigger match is an 80-char `ILIKE` substring (near-never fires), and proficiency advancement (3/10/20 executions) is unreachable given the dead loop.
- **"Autonomous cognition" (background threads) is deterministic SQL, not reasoning.** `cognition/background-threads.ts` runs three hand-coded SQL health-checks (strategic stalled-P0/P1 detection, operational diagnostics, relational contact-overdue) emitting templated insights stored as artifacts; only the strategic `nextAction` is surfaced (in `cortex_init`). Two sub-checks are effectively dead: strategic `knownCritical` is an empty array (entity-coverage no-op), and the operational cron check reads `~/.openclaw/cron/jobs.json`, which does not exist on this Windows host -- so it is blind to the real scheduler (the same blind spot as `self_check`). Useful where it fires (stalled-item detection), but it is bookkeeping, not cognition.
- **Priority is inflated; no demotion.** ~~Live: P0=103, P1=350, P2=416, **P3/P4=0** (52% critical/high). Cause: CA1 `computeNovelty` promotes highly-novel content one tier (`max(0, basePriority-1)`), reflections/agents ingest at P1, and **nothing ever demotes** + the P1 cap guard was never shipped. Priority no longer discriminates for ranking or forgetting.~~ **FIXED 2026-06-18 (Phase 2):** CA1 no longer promotes priority from novelty (only resonance). New dream-cycle Phase 1b reconciles priority from sustained signals: demotes old/low-resonance/never-accessed P1->P2, enforces P0+P1 cap (25% target), and re-promotes genuinely active P2s. Pruning now reaches P1 (guarded). **Arlo before: P0=300(18.2%), P1=486(29.4%), P2=865(52.4%), P0/P1=47.6%. After: P0=300(18.2%), P1=113(6.8%), P2=1237(75.0%), P0/P1=25.0%.** Distribution converges and is stable across cycles.
- **Forgetting barely happens -- and the root cause is the priority gate.** 874 active vs **32 archived lifetime** (~28 before this session's dupe cleanup); corpus grows monotonically since 2026-05-14. The dream's Phase-2 pruning is reasonable code (adaptive P5/P15 resonance percentiles, age gates, salience exemption) **but it only considers `priority > 1`** -- so the inflated 52% at P0/P1 is *structurally unprunable*, and the valence stub's `decay_resistance` exempts more. Pruning code is fine; it is defeated by upstream priority inflation. (The belief that "dream clustering keeps P1 manageable" is false.)
- **Resonance measures popularity, not value.** Phase-1 resonance is dominated by `access_count` + connectivity + priority; the Ebbinghaus time-decay term is only weight 0.15 and is further slowed by a stability factor. So frequently-recalled/connected memories stay high while genuinely-useful-but-unaccessed notes look low-value (e.g. a local-LLM hardware note sat at resonance 0.5 simply because nothing had recalled it). Confirms the prior "resonance = salience, not correctness/stability" finding.
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

Conclusion: on this retrieval task, CA3 pattern completion does **not** improve recall. The no-CA3 hybrid already retrieves the correct session 95.7% of the time; CA3 neither added hits nor changed rankings meaningfully.

### Implications

- The "three different scorers" divergence is resolved: benchmark, REST, and MCP now use one scorer.
- CA3 remains mathematically interesting but is not earning its runtime cost or complexity on real retrieval. Recommendation: keep the fixed implementation, but **gate CA3 off by default** (`CORTEX_CA3=off`) and only re-enable after a future change demonstrates measurable recall gain. Document this in the benchmark baseline.

## 5. Operational findings

- **Meridian coupling (the real, narrow risk).** Cortex's `llm.ts` builds the Anthropic client with no `baseURL`, inheriting `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`. So per-ingest entity-extraction (`CORTEX_LLM_ENTITIES=true`) and dream summaries depend on Meridian being up + Max-OAuth-authed + pinned. If it is down/repinned, they fail or silently run on an unexpected model. Going local (below) removes this.
- **Ingest timeout -> duplicate race (caught live).** The MCP ingest writes server-side even when the call times out (large content -> Voyage+NER fan-out, ~25-30s/chunk). Retries then duplicate. This session created dup pairs `#1640~#1643` (0.989) and `#1641~#1644` (0.935); the dedup gate did not catch them (first write uncommitted when the retry's check ran). **Cleaned up:** archived `1640,1641,1642` and `1663` (redundant copies; complete copies kept at `1643-1646` and `1660-1662`). Fix: idempotency key on ingest, or a post-write dedup sweep, or raise/await the MCP timeout.
- **`self_check` is blind to the scheduler** -- reports "0 cron jobs" though 7 Windows tasks fire. Cosmetic but misleading.
- **Secrets:** live scan found **0** secret-shaped tokens. `scrub.ts` only scrubs em-dashes, not PII/secrets -- clean by practice, not by guard.
- **Three divergent scoring formulas** (none match): benchmark (5-factor, no CA3); REST `hybridSearch` (adds emotional + CA3 blend); MCP `cortex_search` (`0.45/0.18/0.12/0.10/0.05` + `0.10` emotional, no CA3).

---

## 6. Environment reference

- **Hardware:** RTX 4070 Ti (12 GB VRAM; ~10-11 GB usable -- Virtual Desktop/Meta virtual monitors present), Ryzen 7 5800X3D (8c), 96 GB RAM, Windows 11 Pro.
- **Local-LLM plan (for dream/NER):** Qwen3 14B (Q4_K_M, on-GPU) for latency-sensitive per-ingest NER; DeepSeek-R1-Distill-Qwen-32B (or Qwen3.6-32B thinking; or 35B-A3B MoE via llama.cpp `-ncmoe`) for nightly deep synthesis, offloaded into 96 GB RAM. Serve via Ollama; wire with `CORTEX_LLM_PROVIDER=openai` + `OPENAI_BASE_URL=http://127.0.0.1:11434/v1` (no code change). Keep Voyage for embeddings.

---

## 7. Ranked recommendations

1. **~~Port a fixed CA3 into the MCP path and benchmark it honestly.~~ DONE (Phase 1, 2026-06-18).** MCP and REST now share `hybridSearch`; CA3 injection + normalization are fixed. The honest A/B on LoCoMo (n=231, full pipeline) found no recall improvement from CA3 (95.67% both on/off). Next: gate CA3 off by default and revisit only when a future change shows measurable gain.
2. **Fix priority inflation:** add a demotion path + ship the P1 cap guard; reconsider CA1's one-tier promotion. Restore P3/P4 usage so priority discriminates again.
3. **Phase-5 dream reasoning upgrade** (see `CORTEX_DREAM_REASONING_UPGRADE.md`): replace the entity-intersection template with an LLM reasoning pass over Phase-4 candidates; make syntheses retrievable.
4. **Stand up the local LLM** (removes Meridian coupling + ingest timeouts for NER).
5. **Embeddings:** re-embed on `voyage-4` (test `voyage-code-3`); add a Voyage reranker pass at the REST layer; increase retry/backoff or move embeddings local.
6. **Add a `cortex_vitals` MCP tool** so the agent can see its own health.
7. **Make ingest idempotent** (or post-write dedup) to kill the timeout-retry duplicate class.
8. **Delete the dead `computeSurpriseGating`** and update stale comments/docs that reference it as active.

---

## 8. Remaining unknowns

- **Run the generative F1 harness.** `locomo/run.ts` exists but has no committed result -- running it would give the first real end-to-end answer-accuracy number (today only retrieval recall is published).
- Whether the ~198 write-only synthesis artifacts should be pruned or surfaced.
- Multi-agent isolation / `cross-agent-transfer` correctness beyond the 0.82 score.
- Corpus composition is now known (584 api / 259 reflection / 37 markdown / 3 git-commit / 1 verified-api; reflections ~30%); still open is whether those nightly reflections are net-useful or noise.

*(Examined this session and folded above: valence analyzer, synapse-formation thresholds, CA1, scrub/secrets, scheduling, the resonance-decay + pruning math -- forgetting is defeated by the `priority > 1` prune gate + inflation -- and the existence of a generative-QA harness.)*
