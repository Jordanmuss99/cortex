# CORTEX — Dream-Cycle Deep-Reasoning Upgrade (Phase 5)

*Design grounded in `src/dream/dream-cycle.ts` (read 2026-06-16). Answers: "make the dream cycle actually reason."*

## 1. Current state (verified in code)

The dream cycle does **almost no reasoning** today. The two phases that look like "dreaming" are vector math + string templates:

- **Phase 4 — free association** (`phaseFreeAssociation`, lines ~585–718): samples up to 200 pairs, keeps dense cosine in **0.6–0.85** and sparse-DG overlap in **0.15–0.45**, and creates weak `semantic` synapses (strength 0.2–0.3). This is a **good, cheap candidate generator** for non-obvious links. Keep it.
- **Phase 5 — "synthesis"** (`phaseSynthesis`, lines ~728–804): loads the recent weak cross-source synapses, **intersects the two memories' entity lists**, and writes a canned artifact: `Memory from [srcA] connects to [srcB] via shared entities: X` (or, if no shared entity, just `Semantic similarity (strength N)`). `actionable = shared.length > 0`. **No LLM, no reasoning** — it cannot say *why* a link matters, whether it's a contradiction, or what hypothesis it implies.
- The only real LLM use in the cycle is the **Phase 3** cluster summary (`maxTokens: 150`), which already has a graceful **extractive fallback** when the LLM is unavailable (lines ~471–494). Reuse that fallback pattern.

**Conclusion:** the lever for "deep reasoning" is to replace Phase 5's template assembly with an LLM reasoning pass over Phase 4's candidate pairs. Phase 4 stays.

## 2. The upgrade

For each candidate (a recent weak cross-source synapse, capped at 30/night as today), give a **reasoning model** both memories' content (raise the slice from 200 → ~600–800 chars each) plus their shared entities, and ask for a **structured judgment** instead of a template:

```
SYSTEM: You consolidate memory. Given two memories that a cheap similarity pass flagged as
possibly related, decide whether the link is real and meaningful. Be skeptical — most
flagged pairs are coincidence. Respond ONLY as JSON.

USER: Memory A [source a]: "<contentA ~700 chars>"
      Memory B [source b]: "<contentB ~700 chars>"
      Shared entities: [...]
```

Expected output (parsed like `entities.ts` already does — regex-extract the JSON block, tolerating any preceding `<think>`):

```json
{
  "relation": "contradiction | generalization | cause_effect | analogy | reinforcement | coincidence",
  "insight": "1–2 sentences on what the connection means / why it matters",
  "hypothesis": "optional testable hypothesis, or null",
  "confidence": 0.0,
  "actionable": false
}
```

Then:

- **`coincidence` or `confidence < 0.5` → discard the insight AND prune the weak synapse Phase 4 created.** This is a bonus: deep reasoning becomes a *quality filter* on the graph, not just richer text. Today every weak synapse survives as noise.
- Otherwise store a **richer synthesis artifact** (`relation`, `insight`, `hypothesis`, `confidence`, provenance: model + nodeA/nodeB ids). Optionally store the model's chain-of-thought in a separate `rationale` field or as a `reasoning_trace` artifact — this is *exactly* what Cortex's `reasoning_trace`/`synthesis` artifact types are for.

## 3. Model & integration

- **Model:** the nightly reasoner — `deepseek-r1-distill-qwen-32b` or `qwen3:32b` (thinking on), Q4_K_M with GPU+CPU offload into the 96 GB RAM. Phase 5 is ≤30 calls/night, offline, so a few tok/s is fine.
- **Serving:** Ollama (OpenAI-compatible at `:11434/v1`). Wiring is config-only (verified vs `src/lib/llm.ts`): `CORTEX_LLM_PROVIDER=openai`, `OPENAI_BASE_URL=http://127.0.0.1:11434/v1`, dummy `CORTEX_LLM_API_KEY`, `CORTEX_LLM_MODEL=<reasoner>`. Keep a fast `qwen3:14b` for per-ingest NER (different, latency-sensitive path) — Ollama can hold both and load per request.
- **Bonus:** moving the dream LLM local removes the dream cycle's dependency on Meridian entirely.

## 4. Caveats (grounded)

1. **Think-tag pollution.** Dream code does `.content.trim()` with no think-strip. Reasoning models emit `<think>…</think>` (DeepSeek-R1) or a thinking segment (Qwen3). **Parse the trailing JSON block** (mirror `entities.ts` `match[0]`), or strip the think span — otherwise artifacts are garbage.
2. **Latency budget.** 30 calls on a slow offloaded 32B can be 10–30 min/night. Ensure the dream cron has the window and Ollama `keep_alive` holds the model loaded across the batch.
3. **Provenance, not facts.** Synthesis artifacts are model-generated, but they are `synthesis` artifacts (resonance 5.0), **not** `memory_nodes` that re-enter as facts — so the paraphrase-drift risk is low. Still tag the model + mark them model-generated.
4. **Graceful degradation.** If the LLM is unavailable, fall back to today's entity-intersection template (mirror Phase 3's existing fallback) so the cycle never hard-fails.

## 5. Incremental rollout

1. **Shadow mode:** run the LLM judgment, log the structured output and the would-prune decisions, but keep writing the old template artifacts. Compare for a few nights.
2. **Enable writes:** switch synthesis artifacts to the structured form; keep synapse pruning behind a flag.
3. **Enable pruning:** let low-confidence/coincidence verdicts prune weak synapses; watch the vitals `avg synapse strength` and dup-pair signals.
4. (Optional) upgrade Phase 3 cluster summaries with the same reasoner, but keep them short.

## 6. Do NOT change

- Phase 4's candidate generation (dense + sparse association) — it's a good, cheap recall of non-obvious pairs; the reasoner just judges its output.
- The embedding path (separate concern; see the Voyage review).
- Phase 1/2 (resonance + pruning) — not reasoning tasks.
