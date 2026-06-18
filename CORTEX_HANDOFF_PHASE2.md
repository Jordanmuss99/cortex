# Cortex -- Phase 2 Handoff: De-inflate Priority & Restore Forgetting

*For Claude Code. Self-contained engineering brief. Written 2026-06-18. Read `CORTEX_DOCS.md` -> `CORTEX_VERIFICATION_FINDINGS.md` first. Convention: use `--` not em-dashes (a drift check counts em-dashes in stored content).*

## Status: Phase 1 is DONE (verified in code)
Retrieval paths are unified onto `hybridSearch` (MCP + benchmark client delegate), CA3 was normalized + made to inject + gated by `CORTEX_CA3`, and the honest A/B found **CA3 adds no recall (95.67% on or off)** -- it is gated off by default. Committed (`b74e27e`). This handoff is the **next** phase.

## Goal (one line)
Make `priority` discriminate again and make the dream cycle actually **forget**, so the corpus stops growing unboundedly, ranking improves, and Phase 3 (dream reasoning) can operate on a healthy, pruned corpus.

## Why this is next (the evidence)
- Live priority distribution: **P0 103, P1 350, P2 416, P3/P4 0** -- 52% of the corpus is critical/high and nothing is low. Priority no longer discriminates (it is a factor in `hybrid_score`, so this also dulls ranking).
- **Forgetting is structurally off:** dream Phase-2 pruning only considers `priority > 1`, so the inflated 52% is unprunable. Lifetime: ~874 active vs ~32 archived -- the corpus only grows.
- **Cause:** CA1 `computeNovelty` promotes novel content one priority tier at ingest and **nothing ever demotes**; the "P1 cap guard" was scoped but never shipped. Resonance decays but priority does not.
- Retrieval itself is solved (Phase 1). The next real Cortex-side defect is corpus health / forgetting.

## Current state (exact pointers)
- **One-way promotion:** `src/hippocampus/ca1-novelty.ts` L153-163 -- `if (noveltyScore > 0.7) adjustedPriority = Math.max(0, basePriority - 1)` (promotes; never demotes). Default `basePriority = 2`, so novel content lands at P1.
- **No demotion anywhere:** resonance is recomputed nightly (`dream-cycle.ts` `phaseResonanceAnalysis`) but priority is never lowered.
- **Prune gate:** `src/dream/dream-cycle.ts` `phasePruning` ~L243-296 -- percentiles computed over `priority > 1` only; Tier-1 DELETE and Tier-2 ARCHIVE both require `priority > 1` + bottom P5/P15 resonance + age + not emotionally-salient (`decay_resistance`). So P0/P1 can never be pruned.
- **Schema:** `memory_nodes.priority` (0-4, default 2), `resonance_score`, `access_count`, `last_accessed_at`, `status` (active/archived/deleted), `valid_until`. Emotional exemption via `emotional_valence.decay_resistance`.
- **Caveat:** the `decay_resistance` exemption leans on `valence/analyzer.ts`, a keyword lexicon with a `cortex/memory/agent` relevance bias (findings doc) -- do not over-trust it; consider tightening.

## The task
1. **Add a demotion path (core fix).** Recommended: a dream-cycle "priority reconciliation" step that recomputes priority from *sustained* signals (access frequency, connectivity, recency) instead of one-time ingest novelty. E.g., demote P1 -> P2 when resonance < P25 and `last_accessed_at` older than 30d and not emotionally salient. Make re-access re-promote (or at least re-boost resonance).
2. **Stop CA1 from permanently setting priority.** Novelty should boost *resonance* (transient salience), not pin *priority*. Either remove the `adjustedPriority` promotion in `ca1-novelty.ts`, or make it decay unless access is sustained.
3. **Ship the P1 cap guard.** Cap the share (or count) of P0/P1; when exceeded, demote the least-resonant P1s to P2. Target a discriminating distribution (e.g., P0/P1 < ~25%).
4. **Restore the low end.** Ensure ephemeral/observation/low-value content ingests at P3/P4 so it ages out (screen observations are already pruned at 7d -- make sure they are P3/P4).
5. **Let pruning reach genuinely-dead high-priority items.** Once priority is meaningful, optionally add a guarded path to archive very-old, never-accessed, low-resonance former-P1s.

## Acceptance criteria
- **Discriminating distribution:** P0/P1 share drops from 52% toward a target (<~25%), with a populated P2/P3 tail (measure live before/after with `SELECT priority, COUNT(*) FROM memory_nodes WHERE status='active' GROUP BY priority`).
- **Forgetting works:** on an aged test corpus, low-value old memories get archived/deleted and corpus size stabilizes instead of growing monotonically.
- **No loss of important memories:** P0, emotionally-salient, and recently-accessed memories are protected (test).
- **Reversible/safe:** demotion is recoverable (re-access re-promotes or re-boosts).
- **No regression:** `npm test` green; add unit tests for demotion + cap logic.

## How to test
- **Unit:** pure-logic tests for the demotion/cap functions + DB-fixture tests.
- **Aged-corpus simulation:** seed a **test agent** (NOT arlo) with memories at varied `created_at`/`last_accessed_at`/`resonance_score` (backdate timestamps so you do not wait real time); run the dream cycle; assert the distribution shifts and the right rows archive.
- **Live monitoring:** `GET /api/v1/vitals` already surfaces loop-ratio, orphans, dup pairs; watch it before/after.

## Guardrails (do not skip)
- **NEVER run destructive priority/prune changes against agent `arlo`** (the live ~874-memory corpus) until validated on a test/benchmark agent. During development, consider switching Tier-1 DELETE to ARCHIVE so nothing is irreversibly lost.
- **Back up first:** there is a nightly "Cortex Nightly Backup" task; take a fresh backup before the first real run against arlo.
- **IPv4 only** (`127.0.0.1`, not `localhost`); **no em-dashes** in stored content (drift check).
- Keep (but tighten) the emotional-salience exemption; do not let the valence keyword-stub indefinitely shield meta-memories.

## Roadmap after Phase 2
- **Phase 3 -- dream reasoning:** replace the entity-intersection template synthesis with LLM reasoning over Phase-4 candidates; make syntheses retrievable (`CORTEX_DREAM_REASONING_UPGRADE.md`). Best done now that the corpus is healthy.
- **Quick wins:** add a `cortex_vitals` MCP tool; re-embed on `voyage-4` / test `voyage-code-3` + add a reranker; stand up the local LLM for dream/NER; make ingest idempotent (kills the timeout-retry dup race); delete the now-dead `computeSurpriseGating`.

## Strategic note for the owner (not a Phase-2 task)
Phase 1 proved CA3 adds **0 recall**, and retrieval is excellent (~95.7%) on the plain hybrid. Combined with the audit, the "hippocampal" machinery (DG/CA3) is not earning its keep on *retrieval* -- Cortex is, in practice, a very good retrieval/CRUD memory store whose higher-order cognitive features are still unrealized. Before investing further in neuroscience-flavored features, it is worth an explicit decision on what Cortex's differentiator should be. Flagging, not prescribing.

## Definition of done
Priority discriminates again (P0/P1 well under half); the dream cycle demotes + forgets on an aged test corpus without losing protected memories; tests are green; `CORTEX_VERIFICATION_FINDINGS.md` is updated with the before/after distribution.
