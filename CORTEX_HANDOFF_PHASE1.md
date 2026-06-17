# Cortex -- Phase 1 Handoff: Unify Retrieval & Make CA3 Real

*For Claude Code. Self-contained engineering brief. Written 2026-06-17 after a full source + live-system audit (see `CORTEX_DOCS.md` -> `CORTEX_VERIFICATION_FINDINGS.md`). Convention: use `--` not em-dashes (a drift check counts em-dashes in stored content).*

## Goal (one line)
Make the agent-facing **MCP** retrieval path identical to the benchmarked **REST** path, fix the two CA3 defects (CA3 can only re-rank, and its boost is unnormalized), then run an **honest A/B** to prove whether CA3 actually improves recall. If it does not beat the no-CA3 hybrid, document that and gate it off.

## Why this is Phase 1 (the evidence)
- There are **three different retrieval scorers** and they do not match: the **benchmark** harness (5-factor, no CA3), **REST `hybridSearch`** (6-factor + CA3 blend), and **MCP `cortex_search`/`cortex_recall`** (hand-rolled SQL, no CA3). The agent uses the MCP path.
- So CA3 -- the flagship "pattern completion" feature -- **never reaches the agent**, was **not** in the scorer that produced the 100% benchmark, and where it does run (REST) it is **prefilter-gated** (re-rank only) and **unnormalized** (dominates ranking).
- A live A/B on the same query gave a **near-inverted top-5** between MCP and REST.
- Measured end-to-end (LoCoMo, n=30, completed): **retrieval = 1.0 but answer avgF1 = 0.199, EM 3.3%** (Cat2 temporal F1 0.115). Retrieval is solved; everything downstream is not -- so the cheapest real win is making the one retrieval feature that exists actually reach the agent and proving its worth.

## Read first
`CORTEX_DOCS.md` (map) -> `CORTEX_VERIFICATION_FINDINGS.md` (what's true + numbers) -> `CORTEX_TECHNICAL_REFERENCE.md` (mechanics). Repo: `D:\Dev Work (SSD)\cortex` (branch `superhighway-and-tweaks`). Stack: TypeScript, Postgres+pgvector (Docker `db` on :5432), REST on :3100, MCP over stdio.

## Current state (exact pointers)
- **MCP retrieval, NO CA3** -- `src/mcp/server.ts`: `cortex_search` SQL ~L116-156 (scorer `0.45 cosine + 0.18 text + 0.12 recency + 0.10 resonance + 0.05 priority + 0.10 recall_boost`, `ORDER BY hybrid_score`); `cortex_recall` ~L289-303. Only imports `hippocampalEncode` (L21) -- never `patternComplete`/`hybridSearch`.
- **REST retrieval, HAS CA3** -- `src/api/search.ts`: `hybridSearch` (exported, L237); `patternComplete` call ~L100-110; CA3 blend ~L168-196 (`ca3Boost = ca3Score * 0.3; blendedScore = hybrid_score + ca3Boost`; re-sort; `slice(0,limit)`).
  - **Defect A (re-rank only):** the `.map()` iterates only `results.rows` (the hybrid top-K), so a CA3 hit not already in that set gets `markLabile` + access-bump but is **never returned**.
  - **Defect B (unnormalized):** `ca3Score` (activation) is unbounded (~30 observed live), so `*0.3 ~= +9` swamps a hybrid score that is a sum of [0,1] terms (max ~1.5).
- **CA3 engine** -- `src/hippocampus/ca3-pattern-completion.ts`: `patternComplete(agentId, queryEmbedding, limit) -> [{memoryId, activationScore}]` (2 iterations of activation spreading over synapses; additive, fails safe).
- `src/api/recall.ts` already delegates to `hybridSearch` (so REST recall inherits CA3).

## The task
1. **Unify MCP onto the shared scorer.** Make `cortex_search` and `cortex_recall` use `hybridSearch` (export it, or extract a pure `scoreCandidates()` shared by REST + MCP). Preserve MCP-specific behavior: `markLabile`, skill surfacing in `cortex_search`, token-budget logic in `cortex_recall`, and existing response formatting. Result: **one scorer, two presenters.**
2. **Fix Defect A (inject, not just re-rank).** In `hybridSearch`, build candidates from the **union** of (hybrid top-K) and (CA3 `memoryId`s); fetch rows for CA3-only IDs (`WHERE id = ANY(...)`), then score + blend + sort the union. CA3 can now surface a memory the semantic prefilter missed.
3. **Fix Defect B (normalize).** Normalize `activationScore` to [0,1] before blending (divide by batch max, or normalize inside `patternComplete`); then `ca3Boost = w * normActivation` with a sane `w` (start ~0.25, tune). CA3 should influence ranking, not deterministically dominate.
4. **Honest A/B.** Add a CA3 on/off switch (env `CORTEX_CA3=on|off` or param). Run the benchmark both ways; compare retrieval@10 + F1. **Decision rule:** if CA3-on does not beat CA3-off, document it in `CORTEX_VERIFICATION_FINDINGS.md` and propose gating CA3 off by default. Do not keep it just because it exists.

## Acceptance criteria
- **Parity:** `cortex_search` (MCP) and `/api/v1/search` (REST) return identical ranked IDs for the same query+limit (add a parity test).
- **Injection:** a test shows CA3 can return a memory NOT in the pure-hybrid top-K.
- **Normalization:** a low-cosine CA3 hit no longer auto-ranks #1; the boost is bounded.
- **Benchmark:** a committed A/B (CA3 on vs off) with retrieval@10 + F1 for both, plus a written conclusion.
- **No regression:** `npm test` green (59 existing + new tests).

## How to test / benchmark (exact)
- **Unit:** `npm test` (host; 59 currently pass).
- **Pure-retrieval benchmark (no LLM, fast, no quota):** `npx tsx benchmarks/locomo/run-retrieval.ts --topk 10` -- use this for the CA3 on/off retrieval@10 comparison.
- **Full generative F1:** set `LOCOMO_DATA=E:\cortex-data\locomo\locomo10.json`, then `npx tsx benchmarks/locomo/run.ts --limit 3 --topk 10`. **Baseline to beat: avgF1 0.199 / retrieval 1.0** (n=30; Cat2 temporal 0.115). This generates answers via the LLM (Meridian/Max) -- it is **quota-fragile and can hang**; prefer pointing the LLM at a local Ollama model for evals (`CORTEX_LLM_PROVIDER=openai`, `OPENAI_BASE_URL=http://127.0.0.1:11434/v1`, dummy key, `CORTEX_LLM_MODEL=<model>`). For the CA3 question specifically, `run-retrieval.ts` (no LLM) is sufficient and cheaper.

## Guardrails (do not skip)
- **Isolation:** all benchmarks run in the `benchmark-locomo` agent (`initBenchmark`). **NEVER** ingest into or clear agent `arlo` (the live ~874-memory corpus). `clearBenchmarkData` is scoped by `agent_id` -- keep it that way.
- **IPv4 only:** `127.0.0.1`, never `localhost` (the `-32001` IPv6 MCP outage).
- **No em-dashes** in any Cortex-bound content / cognitive artifacts (the drift check flips health on them; use `--`).
- **Dataset stays on E:** `E:\cortex-data\locomo\locomo10.json`, read via the `LOCOMO_DATA` env (`run.ts` already supports it).
- The historical `results-top10.json` avgF1 0.024/total 50 was a usage-outage-contaminated run; the current file is the valid n=30 (avgF1 0.199). Do not cite the old one.

## Roadmap after Phase 1 (context, not this task)
- **Phase 2 -- fix forgetting:** priority is inflated (52% P0/P1) and Phase-2 pruning skips `priority > 1`, so most of the corpus is unprunable. Add a demotion path + ship the P1 cap; reconsider CA1's one-tier promotion (`src/hippocampus/ca1-novelty.ts`, `src/dream/dream-cycle.ts` `phasePruning`).
- **Phase 3 -- dream reasoning:** replace the entity-intersection template synthesis with LLM reasoning over Phase-4 candidates and make syntheses retrievable (see `CORTEX_DREAM_REASONING_UPGRADE.md`).
- **Quick wins:** add a `cortex_vitals` MCP tool (REST-only today); re-embed on `voyage-4` / test `voyage-code-3` + add a reranker; stand up the local LLM for dream/NER; make ingest idempotent (kills the timeout-retry duplicate race); delete the dead `computeSurpriseGating`.

## Definition of done
MCP and REST retrieval are one code path; CA3 can inject and is normalized; an honest A/B states whether CA3 earns its place; tests are green; `CORTEX_VERIFICATION_FINDINGS.md` is updated with the A/B result.
