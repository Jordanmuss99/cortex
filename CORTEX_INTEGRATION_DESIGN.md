# CORTEX — Integration Design: Build a Memory Gateway, Not Better Tools

*Answers the question "is it better to build our own software that integrates Cortex + a provider API so the AI doesn't struggle to use memory correctly?" Grounded in the code, the live system, your own prior Cortex memories, and June-2026 state-of-the-art research.*

---

> **Verification status (2026-06-16):** A follow-up audit re-checked the load-bearing claims against real source. **Confirmed:** Meridian's routing (read from its repo), the dedup gate (live-refused a near-duplicate at cosine 0.924), the MCP-vs-REST CA3 divergence (code-verified), the vitals engine, hooks, and autoresearch evaluator all exist and work. **Corrected:** §6 (Meridian impact on Cortex was overstated — see below), §8 step 3 (autoresearch DB claim was stale), and the §1 compliance-decay figure (flagged below as an estimate, not a measurement).

## 1. The real problem, stated precisely

The thing the AI "struggles with" is **not retrieval quality** — it's that **memory is tool-gated**: the agent has to *choose* to call `cortex_search`/`cortex_ingest`, and models do that unreliably (compliance decays from ~73% at turn 5 to ~33% by turn 16 **[FLAGGED 2026-06-16: this specific decay curve is NOT traceable to any measurement in the repo, the papers, or the autoresearch runs — treat it as an unverified estimate]**; 72 ingests vs 13 reconsolidations/week; 15 skills with ~0 executions **[these imbalance counts ARE verified against live vitals/skill data]**). Three independent sources confirm the diagnosis and the fix:

1. **The Cortex papers never address it.** Both the arXiv technical note and CogBench measure retrieval in a harness that calls `search()` *directly* — they assume the agent always uses memory perfectly. The word "utilization" appears nowhere; "integration" only refers to cortex-lite tests. The academic framing has a **benchmark-vs-production gap**: it proves the engine retrieves well, not that a real agent will invoke it.

2. **Even Anthropic's native memory is tool-gated.** Anthropic shipped a [Memory tool](https://www.anthropic.com/news/context-management) (Sept 2025) + context editing (`context-management-2025-06-27`) and [Memory for Managed Agents](https://usewire.io/blog/anthropic-managed-agents-memory-context-engineering/) (Apr 2026) — but the memory tool is **client-side and invoked by the model choosing to call it**. So the native offering has the *same* flaw. Your deterministic-injection approach is **ahead** of it on the utilization axis.

3. **The industry-standard fix is a proxy/interceptor.** Memory-architecture guidance is explicit: with a proxy, "context retrieval happens transparently on every request, without LLM involvement... the LLM may skip retrieval when it shouldn't, or call it unnecessarily — which is the reliability problem this pattern solves" ([Atlan](https://atlan.com/know/agent-memory-architectures/), [AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/memory-augmented-agents.html)).

**Conclusion: yes — building a Cortex + provider memory gateway is the correct move, and it is the right kind of "build from scratch."** You are not rebuilding Cortex (don't — the engine is good and benchmark-validated). You are building the thin **injection layer** that makes memory non-optional. You've already proven the pattern client-side; the gateway generalizes it.

---

## 2. What you already have (do NOT rebuild)

From your own Cortex memory, you have shipped most of the pattern already:

- **`cortex-rest-bridge.ts`** (OpenCode plugin): deterministic **push** — boot recall injected into the system prompt via `experimental.chat.system.transform`, task-aware re-recall on first user turn, compaction recall — *plus* **pull** (MCP tools) *plus* **feedback** (loop-compliance verdict). "Push gives guaranteed boot context — the model gets memory without spending a tool call" (your words).
- **Claude Code hooks** (this repo, `scripts/hooks/`): session-start injection, per-turn protocol pulse + throttled recall, session-end compliance scorecard.
- **Nightly Reflect** + **dream cycle** = a working **sleep-time-compute** layer. Letta's [sleep-time compute](https://www.letta.com/blog/sleep-time-compute) ("transform raw context into learned context during downtime") is exactly what your dream/reconsolidation cycle does. You are *on* the frontier tier here.
- **The owned asset is the Cortex REST/JSON contract**, not any one client's glue (your memory #1451). This is the right instinct: the gateway is just another consumer of that contract.

What's missing is the **last generalization**: a single provider-side layer so memory works for **any** client (Claude Desktop, Cursor, raw API scripts, future harnesses) without writing a new plugin/hook per client — and so it **cannot be skipped**.

---

## 3. The architecture: a Cortex Memory Gateway

A small HTTP service that speaks the provider's Messages API. Every client points its `BASE_URL` at the gateway instead of the provider. Per request:

```
client (Claude Desktop / Cursor / script / agent)
        │  POST /v1/messages   (BASE_URL = gateway)
        ▼
┌─────────────────────────────────────────────────────────┐
│  CORTEX MEMORY GATEWAY                                    │
│  PRE  (deterministic, no model decision):                │
│   1. extract latest user turn (+ task signal)            │
│   2. Cortex REST /recall  → CA3-enabled, token-budgeted  │
│   3. inject as a memory block AFTER the stable system     │
│      prefix (KV-cache-aware), throttled per task boundary │
│  ── forward to real provider (Anthropic/OpenAI/LiteLLM) ──│
│  POST (async, never blocks the response):                │
│   4. capture exchange → Cortex /ingest (dedup gate on)   │
│   5. honor "// VERIFIED" breadcrumbs as priority writes   │
└─────────────────────────────────────────────────────────┘
        │  real provider call
        ▼   Anthropic / OpenAI / Bedrock
   (offline) Cortex dream cycle = sleep-time compute
```

- **Baseline recall + capture are deterministic** (the gateway does them; the model never chooses). This is the whole point.
- **MCP tools remain** for *agentic* memory the model *should* reason about: `cortex_reconsolidate`, `cortex_skill_*`, `cortex_reason`, `cortex_relationship*`. Hybrid: gateway owns the reflex, MCP owns the deliberate act.
- **Route recall through REST** so you get the **CA3 boost** the MCP tools lack (see the problems register #1).

---

## 4. Build options, ranked

**Option B — bespoke Anthropic-Messages gateway (recommended for your stack).** A thin Fastify/Express service implementing `POST /v1/messages` (streaming + non-streaming). You're Anthropic-centric (Voyage + Claude). Full control over injection position, throttling, and capture. It can **fold in model-routing and retire Meridian's mangling** (see §6). The REST contract you already own is the backend.

**Option A — LiteLLM proxy + custom callback (recommended when you need multi-provider).** [LiteLLM](https://docs.litellm.ai/docs/simple_proxy) is the standard OpenAI/Anthropic-compatible gateway. Put Cortex recall in `async_pre_call_hook` and capture in `async_post_call_success_hook`. Fastest path to broad provider coverage; less control over Anthropic-specific cache breakpoints.

**Option C — stay client-side (status quo).** Keep rest-bridge/hooks. Lowest effort, but per-client and can't cleanly cover Claude Desktop (which injects its own `ANTHROPIC_BASE_URL=api.anthropic.com` into embedded sessions — your memory #1375) or raw API use.

**Recommendation:** Build **B** for the Claude daily-driver path; reuse the same REST contract so **A** is a drop-in later if you add OpenAI/multi-provider. Keep **C**'s hooks for clients you don't route through the gateway.

---

## 5. Design constraints that will bite (grounded in your own findings)

1. **KV-cache.** A per-turn memory block busts the cache for that block. Mitigation (your memory #1444, Anthropic-measured): keep the system+tools prefix **stable and cached**, inject the recall block **after** it at a cache breakpoint; accept that ~1–2k recall tokens are uncached per turn. Do **not** prepend memory (it would invalidate the whole prefix).
2. **Don't double-inject.** If a client already runs rest-bridge/hooks AND you route it through the gateway, you'll inject twice (your memory: project + global injectors double-inject). Pick one layer per client.
3. **Latency.** Measured recall p95 = **400 ms** → that's added TTFB. Throttle recall to task boundaries (the hooks already use a 10-min window) rather than literally every turn; cache the last recall per session.
4. **Embedding cost + Voyage rate limits.** Capture-every-turn hits Voyage (the 429 failure mode you already hit). Async + batch + **dedup gate** + skip trivial turns; consider `CORTEX_EMBED_CACHE` for re-ingested content; use a paid tier.
5. **Reconsolidation drift (the P1 risk).** The gateway's auto-capture must **not auto-reconsolidate** the model's own paraphrase without a gate — that's the feedback-loop drift (model recalls → paraphrases → writes back → resonance climbs → recalled more). Keep capture as **dedup-gated ingest** with provenance; reserve reconsolidation for the model's explicit, sourced calls.
6. **Security.** The gateway sees every prompt, completion, and API key. Bind to `127.0.0.1`, handle keys carefully, log minimally. It is the single most sensitive process in the stack.
7. **IPv4.** Use `127.0.0.1`, never `localhost` (your `-32001` IPv6 handshake outage).

---

## 6. Meridian: verified, and mostly a non-issue *for Cortex* (corrected 2026-06-16)

That `:3456` proxy is **Meridian** (`@rynfar/meridian`) — a legitimate, open-source proxy whose purpose is to let third-party tools use a **Claude Max subscription** (OAuth) via the Claude Agent SDK instead of API-key billing. Verified against its **real source** (`src/proxy/models.ts`), not just memory:

- **Model routing is real and confirmed.** `mapModelToClaudeModel` collapses every request to one of three SDK lanes by substring: `includes("haiku")`→haiku, `includes("opus")`→opus/opus[1m], **everything else → `return "sonnet"`**. The requested model ID is discarded and the lane resolves to a canonical pin (now `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5`). This is why a `claude-fable-5` request silently lands on sonnet. The function name matches the prior Cortex memory verbatim — those memories were grounded in real inspection.
- **But for Cortex this routing is a no-op.** `src/lib/llm.ts` requests `claude-sonnet-4-6` and makes **one-shot, stateless, non-streaming, text-only** completions (entity extraction + dream summaries). It asks for sonnet and gets sonnet. The history-flattening, KV-cache loss, and duplicate-`tool_use` bugs documented in prior memories all require **multi-turn lineage / streaming / tool use** — none of which Cortex does. Those problems bit OpenCode's long agent sessions, **not Cortex**.

**Correction to earlier framing:** the claim that "Meridian mangles *our* requests / is actively harmful to caching" does **not** hold for Cortex. There is no "collision" to resolve. The real, narrower risk is **operational coupling**: Cortex's Anthropic client is built with *no explicit baseURL* (`new Anthropic({ apiKey })`), so it inherits `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` from `.env`. Every ingest's entity-extraction (`CORTEX_LLM_ENTITIES=true`) and every dream summary therefore depend on Meridian being **up and correctly authenticated/pinned**. If Meridian is down, repinned, or its Max OAuth lapses, those calls fail or silently run on an unexpected model — degrading NER/dream quality with no error surfaced to Cortex.

**Implication for the gateway:** if you build the gateway for *agent traffic*, leave Cortex's internal LLM path alone — or point it straight at the cache-fix proxy / real API to **drop the Meridian dependency for dream/NER** entirely. Retire/front-run Meridian only on the **OpenCode/agent** paths where its flattening actually hurts, never "on Cortex's account."

---

## 7. What NOT to build (your own research already settled this)

- **Don't rebuild the memory engine.** DG/CA1/CA3 + dream + reconsolidation + valence are benchmark-validated; rebuilding is months for no gain.
- **Don't go parametric/LoRA yet.** Your memory #1430/#1448: SEAL-style self-editing LoRA costs 30–45s/edit + catastrophic forgetting; your corpus has ~3 git-commit memories = **zero coding-pair training data**. Fence it as research.
- **Don't reframe the dream cycle as something new** — it already *is* sleep-time compute. Just make sure it runs (vitals watchdog).

---

## 8. Concrete migration path (incremental, low-risk)

1. **Now, inside Cortex (cheap, high payoff):**
   - Add a **`cortex_vitals` MCP tool** (wrap the REST query) so the agent can see its best health signal.
   - Add the **`cortex.do` single-dispatch tool** you already planned, to fix the >200-tool dilution that makes memory tools "invisible."
   - **Port CA3 into the MCP `cortex_search`/`cortex_recall`** so tool use matches the benchmark/REST path.
2. **Stand up the gateway for ONE client** that hooks can't cover well — **Claude Desktop** — using Option B. Recall-inject + capture only; leave agentic MCP tools alone.
3. **Validate** with your existing **autoresearch round-trip evaluator** (extend it to assert "memory block present in forwarded request" and "capture landed"). (Correction 2026-06-16: the evaluator already self-rewrites the DB URL — `cortex-roundtrip-evaluator.ts` falls back through `CORTEX_AR_DATABASE_URL` → `DATABASE_URL` and rewrites the `@host:5432` placeholder to `127.0.0.1:5432`, so no re-pointing is needed. It targets REST_BASE `http://127.0.0.1:3100`.)
4. **Expand** to Cursor/raw-API; **retire Meridian** by folding model-pinning into the gateway.
5. **Keep** the hooks for any client you don't route, and keep the dream cycle nightly.

---

## 9. Why this is the right answer in one paragraph

The papers prove Cortex *retrieves* well; they never prove an agent will *use* it — and in production it doesn't, reliably. Anthropic's own native memory has the same tool-gated flaw. The industry-validated fix, which you've already half-built client-side, is a **deterministic interceptor**. Generalize it into a **provider-side memory gateway**: recall-inject + capture on every request (deterministic, CA3-routed, KV-cache-aware, drift-gated), keep MCP tools for deliberate memory acts, and let the dream cycle keep doing sleep-time compute. Build the injection layer, not a new engine — and definitely not better tool descriptions, because the problem was never the descriptions; it was that using memory was ever optional.

---

### Sources
- Anthropic context management / memory tool — https://www.anthropic.com/news/context-management ; managed-agents memory — https://usewire.io/blog/anthropic-managed-agents-memory-context-engineering/
- Letta sleep-time compute — https://www.letta.com/blog/sleep-time-compute ; memory blocks — https://www.letta.com/blog/memory-blocks
- Agent memory architectures (proxy pattern vs tool-gated) — https://atlan.com/know/agent-memory-architectures/ ; AWS memory-augmented agents — https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/memory-augmented-agents.html
- LiteLLM gateway — https://docs.litellm.ai/docs/simple_proxy
- mem0 / OpenMemory MCP — https://github.com/mem0ai/mem0 ; https://mem0.ai/blog/how-to-make-your-clients-more-context-aware-with-openmemory-mcp
- Internal sources of truth: Cortex memories #1223, #1344, #1430, #1444, #1451, #1197/#1198/#1298/#1375/#1376 (Meridian); `paper/cogbench.tex`, `paper/drafts/cortex-v2-4-arxiv.tex`.
