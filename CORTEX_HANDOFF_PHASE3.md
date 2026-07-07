# Cortex -- Phase 3 Handoff: Confirm CA3 Accuracy + Probe the Neuroscience Layers

*For Claude Code. Self-contained. Read `CORTEX_DOCS.md` -> `CORTEX_VERIFICATION_FINDINGS.md` first. Use `--` not em-dashes.*

## Status / context
The earlier "CA3 adds no recall (95.67% on==off)" result was a **test artifact**: the LoCoMo benchmark ingest (`benchmarks/lib/cortex-client.ts`) discarded the `hippocampalEncode` result and never wrote `hippocampal_codes`, so CA3 had no seeds and was inert. **Fixed** (the benchmark now persists DG codes, mirroring `api/ingest.ts`). CA3 actually **defaults to ON** (`CORTEX_CA3 !== "off"`; nothing pins it off). A direct probe on the live `arlo` corpus (full substrate, 12 queries, top-10) showed CA3 is **functional and impactful**: changed the top-10 set 12/12, top-1 9/12, injected 48 memories the pure hybrid missed. **Open question: do those changes improve *accuracy*, or just reshuffle?**

## Task A -- Confirm CA3 accuracy (the rigorous test)
Run the **fixed** full-pipeline LoCoMo retrieval A/B, CA3 off vs on, measuring **R@1 / R@5 / R@10 / MRR** (not just R@10, which is blind to re-ranking).

```
# retrieval-only (no LLM, no Max quota); full pipeline now persists hippocampal_codes
set LOCOMO_DATA=E:\cortex-data\locomo\locomo10.json
CORTEX_CA3=off  npx tsx benchmarks/locomo/run-retrieval.ts --full-pipeline --limit 3 --topk 10
CORTEX_CA3=on   npx tsx benchmarks/locomo/run-retrieval.ts --full-pipeline --limit 3 --topk 10
```
- **Heads-up:** full-pipeline ingest + one Voyage embed *per question* is slow (conv-26 alone is 199 questions; the harness has no per-conversation question cap). Either keep `--limit` small, or add a `--qlimit N` to cap questions/conversation for a faster, balanced sample. Each run re-ingests, so prefer fewer conversations.
- **Decision rule:** CA3-on beats off on R@1/MRR -> keep ON, consider tuning `CA3_WEIGHT` (currently 0.25 in `search.ts`). CA3-on worse -> `CORTEX_CA3=off` and document. Neutral -> keep but note.
- **Then** re-run the generative F1 (`run.ts`) with CA3 on vs the 0.199 baseline -- does better retrieval flow through to better answers? (Needs the LLM; weekly Max quota is back, but prefer a local Ollama model: `CORTEX_LLM_PROVIDER=openai`, `OPENAI_BASE_URL=http://127.0.0.1:11434/v1`.)

## Task B -- Probe the other neuroscience layers (updated 2026-06-20 with live findings)
1. **Fix `novelty_score` corruption -- DONE (2026-06-20).** See `scripts/backfill-novelty.ts`; re-run after any future agent migration.
2. **DG pattern separation -- VERIFIED working (2026-06-20), no action needed.** Probed on arlo: sparse Jaccard stays well below dense cosine in every band (orthogonalization, the DG's job) while preserving similarity order. The substrate is sound. (Only caveat: the high-cosine regime is undersampled because the corpus is diffuse.)
3. **Semantic-graph density -- LOWER priority than it first looked (my earlier suggestion corrected).** Live: entity 32,860 / temporal 6,252 / **semantic 320** (0.8%). BUT lowering the 0.85 synapse threshold would **barely help**: of 4,830 sampled `arlo` pairs, only **2** are in cosine 0.75-0.85 and **0** above 0.85 -- the corpus is semantically diffuse and lacks near-duplicate pairs regardless of threshold. Going to ~0.6 would add edges but risk noise. Treat graph enrichment as low-ROI unless the corpus character changes; do NOT prioritize the threshold change.

## Guardrails
- Isolation: benchmarks use the `benchmark-*` agents; **never** ingest into or destructively mutate `arlo`. Back up before any synapse-graph rebuild.
- IPv4 (`127.0.0.1`); no em-dashes in stored content.
- The `cortex-client.ts` code-persist fix only affects `--full-pipeline`; the fast path and `run.ts` (F1) are unchanged.

## Definition of done
A real CA3 accuracy number (R@1/MRR, on vs off, valid full-pipeline); a decision on `CORTEX_CA3` + `CA3_WEIGHT`; a measured finding on whether lowering the semantic-synapse threshold improves CA3; DG-separation + CA1-calibration notes. Update `CORTEX_VERIFICATION_FINDINGS.md`.
