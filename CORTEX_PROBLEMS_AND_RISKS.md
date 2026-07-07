# CORTEX — Problems, Risks & Hardening Register

*Verified against the code in this fork and the live running server (agent `arlo`). Each item has evidence (file/observation), impact, and a concrete fix. Ordered by severity. This is deliberately blunt — it's the "what's actually wrong / fragile" list, not the marketing view.*

Severity legend: **P0** correctness/data, **P1** materially degrades the AI's use of memory, **P2** maintainability/portability, **P3** cosmetic/doc.

---

## P1 — Things that materially weaken how the AI uses memory

### 1. MCP search is weaker than REST search (CA3 missing)
**Evidence:** `src/api/search.ts` blends `patternComplete` (`+0.3·activation`, re-sort); `src/mcp/server.ts` `cortex_search` **and** `cortex_recall` run inline hybrid SQL with **no** CA3. **Impact:** the retrieval the *model* calls is measurably weaker than the REST path the benchmarks and your hooks use — multi-hop / "that thing about X with Y" queries that CA3 graph-spreading is designed to catch underperform when the model searches directly. **Fix (highest leverage):** either (a) route the model's recall through REST `/search` (which has CA3) via the hooks/middleware, or (b) port the ~15 lines of `patternComplete` blending into the two MCP tools so direct tool use matches the benchmark path. Recommend doing (b) so every entry point is equivalent.

### 2. Skill / procedural learning is stalled (live YELLOW)
**Evidence:** live `cortex_self_check` → "Learning stall: no new procedural memories in 7+ days"; upstream telemetry baked into the code comments: "15 skills, 1 recorded execution," "agents never call `cortex_skill_retrieve` unprompted." **Impact:** the procedural subsystem — the part that's supposed to make the agent *get better at repeated tasks* — is effectively inert. Proficiency only advances when `cortex_skill_executed` fires, and it almost never does. **Fix:** (a) the session-end hook already detects `SKILL-NOT-RECORDED`; promote that from a passive scorecard to an explicit per-turn instruction when a skill was surfaced; (b) consider auto-recording an execution when a surfaced skill's steps are followed (host-side heuristic); (c) periodically mine high-resonance "how I did X" memories into skills (a scheduled job), rather than relying on the model to volunteer them.

### 3. Dedup only protects single-chunk ingests
**Evidence:** both `mcp/server.ts` and `api/ingest.ts` gate **only when `chunks.length === 1`**; `chunker.ts` `CHUNK_SIZE=256` tokens (~1000 chars). **Impact:** any memory longer than ~256 tokens becomes multi-chunk and **bypasses dedup entirely** — exactly the long session-summaries that the reflect pipeline re-emits. Near-duplicate long memories accumulate silently. **Fix:** add a whole-document dedup check (e.g. embed the full text or the first chunk and compare before chunking), or run a periodic dedup/merge pass keyed on high pairwise cosine across multi-chunk docs.

### 4. Priority inflation defeats adaptive pruning
**Evidence:** live `cortex_init` Top Context is wall-to-wall **P0-CRITICAL** (resonance 12–22), avg resonance **8.69**; last dream deleted 0 / archived 2 of 848. Pruning (`dream-cycle.ts`) only touches `priority>1` and skips emotionally-salient rows. **Impact:** if session captures land at P0/P1, they are **permanently unprunable**, so the corpus only grows; "adaptive forgetting" can't act on the bulk of memory. Combined with #5 below, almost nothing is eligible to forget. **Fix:** reserve P0/P1 for genuinely durable facts; default session/reflection captures to P2–P3; or make pruning consider age/resonance for P1 too (with stricter floors).

### 5. Valence lexicon is domain-mismatched (and meta-biased)
**Evidence:** `valence/analyzer.ts` lexicons are business-assistant flavoured — `bug/fix/error/critical/issue` are **NEGATIVE + HIGH_AROUSAL**, and `RELEVANCE_CORE` includes `cortex/agent/memory`. **Impact:** for a coding/gamedev agent, ordinary bug notes get tagged emotionally charged → higher `decay_resistance` + `recall_boost` → they resist pruning and out-rank in recall; memories *about Cortex itself* get a relevance bump. This inflates resonance (see #4) and skews retrieval toward "technical-sounding" noise. **Fix:** retune the lexicon for the actual domain, or gate valence behind an LLM pass for technical corpora, or down-weight `emotional_boost` in the hybrid score for this deployment.

### 6. Real schedulers are invisible to `self_check`
**Evidence:** dream/threads/reflect run via **Windows Task Scheduler**; `self-check.ts` reads **OpenClaw** cron (`~/.openclaw/cron/jobs.json`) → live "Cron Jobs: Total 0." **Impact:** the agent's own health check can't see whether its nightly jobs are actually running; a silently-failed dream or reflect would not show up in `self_check`. **Fix:** treat `GET /api/v1/vitals` (which *does* check dream/reflect/threads staleness) as the source of truth, and surface it in the boot hook; or teach `self-check` to read the Task Scheduler state / job logs.

---

## P2 — Portability, maintainability, correctness-at-scale

### 7. `agent_id` foot-gun (default "arlo", owner "rez")
**Evidence:** every MCP tool + `watcher.ts` default `agent_id="arlo"`; `resolveAgent` auto-creates with `owner_id="rez"`. **Impact:** any caller that forgets `agent_id` writes into "arlo"; multiple projects on one DB silently cross-contaminate; a typo creates a brand-new agent rather than erroring. **Fix:** set a stable `CORTEX_AGENT_ID` per project/runtime; pass `agent_id` explicitly on direct calls; consider failing closed on unknown agents instead of auto-creating, and dropping the hardcoded `"rez"` owner.

### 8. `background-threads.ts` cron check uses `process.env.HOME`
**Evidence:** `cognition/background-threads.ts:153` uses `process.env.HOME`; `self-check.ts` correctly uses `os.homedir()`. **Impact:** on Windows `HOME` is usually undefined → the operational thread's cron check silently no-ops. **Fix:** switch to `homedir()` for consistency.

### 9. Empathy model hardcodes one specific person
**Evidence:** `empathy/state-model.ts` `getTimeBasedBaseline` encodes a fixed schedule (workout M/W/F, school drop-off, family 6–9pm "PROTECTED", afternoon dip) and ADHD states. **Impact:** correct only for the single principal it was written for; wrong for any other user; not portable if you ever multi-tenant. **Fix:** move the schedule/persona into per-agent config (`agents.config` jsonb) instead of code.

### 10. `KNOWN_ENTITIES` is a hand-maintained dictionary
**Evidence:** `ingestion/entities.ts` hardcodes the canonical list (SimsOnline, rts_fps, s&box, …). Synapse formation keys on entity overlap. **Impact:** new projects/people don't weave into the graph until added here; graph quality degrades silently as work drifts from the dictionary. **Fix:** keep relying on LLM NER (already on) as the safety net, periodically promote frequent regex-extracted proper nouns into the dictionary, or move the list to config.

### 11. REST API has no authentication
**Evidence:** `src/index.ts` mounts `/api/v1/*` with `cors()` and no auth; only safe because docker/compose binds to `127.0.0.1`. **Impact:** anyone who can reach the port can read, ingest, reconsolidate, **or trigger `/dream`/delete** memories. **Fix:** keep it strictly localhost-bound (it is); if it ever needs to be remote, add a bearer token / mTLS. Never expose 3100 publicly.

### 12. LLM proxy is a silent single point of failure
**Evidence:** `ANTHROPIC_BASE_URL=127.0.0.1:3456`, dummy key, `CORTEX_LLM_ENTITIES=true`, model `claude-sonnet-4-6-20250514`. **Impact:** if the proxy is down or the model string isn't mapped, dream consolidation degrades to extractive summaries and entity NER to regex — **silently** (both paths catch and fall back). Quality drops with no alarm. **Fix:** add a vitals rule for "dream consolidations are all extractive" / proxy reachability; pin/verify the model mapping; alert on fallback.

### 13. Silent-failure class is real and recurring
**Evidence:** code comments document CA3 + reconsolidation being dead in prod (drizzle serialized JS arrays as composite ROWs Postgres won't cast to int[]), and dream stats reporting 0 (rowCount shim). **Impact:** features can compile, throw at runtime, get caught, and look "fine" while silently disabled — for days. **Mitigation in place:** `drizzle-array-cast.test.ts`, `/api/v1/vitals`, explicit `ARRAY[...]::int[]` literals everywhere. **Fix:** extend the array-cast regression test to every raw-array SQL site; add a synthetic end-to-end "CA3 actually changed ranking" assertion to the autoresearch evaluator.

### 14. Dead / barely-used code paths
**Evidence:** `ingestion/surprise-gating.ts` (`computeSurpriseGating`) is superseded by CA1 and unreferenced; `watcher.ts` file ingestion accounts for only ~37 markdown memories. **Impact:** maintenance confusion; new readers may wire to the wrong novelty function. **Fix:** delete or clearly mark `surprise-gating.ts` as legacy; document the watcher as optional.

---

## P3 — Documentation / reporting drift (trust hygiene)

### 15. Benchmark headline is the easy subset
`BENCHMARKS.md` shows **100%** LongMemEval (its reproduce cmd uses `--dataset oracle`). The paper reports **R@1 89.4 / R@10 97.8 / MRR 93.0** on the full 500-q haystack and explicitly says "*not* the oracle subset." **Trust the paper's full-haystack numbers.** LoCoMo (~93.6 R@10, no LLM) is consistent and genuinely strong.

### 16. Scale claims are aspirational
README: "5,000+ memories, 1.9M+ synapses per agent." Live `arlo`: 848 / 15,067. Fine for a personal deployment; don't use the headline as a baseline expectation.

### 17. Stale in-code comments
`api/search.ts` header still lists the old weights (0.5/0.2/0.15/0.1/0.05) vs the actual 0.45/0.18/0.12/0.10/0.05/0.10; `chunker.ts` says "~512 tokens" but `CHUNK_SIZE=256`. Harmless but misleading. **Fix:** sync comments.

### 18. REST `/status` synapse count is global
`api/health.ts` `/status` counts `memory_synapses` with no agent filter (MCP `cortex_status` filters per-agent). Cross-agent deployments will see an inflated synapse number on the REST status. **Fix:** filter by agent.

---

## P0/P1 additions surfaced from the system's OWN stored research
*(Cortex memories #1382/#1383/#1311/#1448 — the agent previously studied itself; these corroborate the above and add new items. Strong signal: the developer already knows about most of this.)*

### 19. Reconsolidation feedback-loop drift (no ground-truth gate) — **P1, was unflagged by me**
**Evidence:** stored adversarial-review memory #1448: *"Reconsolidate-on-retrieval has a real drift risk: any automated write-back during the 1-hour labile window forms a feedback loop (model recalls → acts → writes back its own paraphrase → resonance climbs → recalled more) with no ground-truth check; needs human/verifier gate + provenance + drift metric."* **Impact:** because recall auto-opens the labile window and the model authors the new content, a memory can drift away from fact across cycles with nothing checking it — and the more it drifts-and-resurfaces, the higher its resonance climbs, so it's recalled *more*. This is the one risk that can silently corrupt the substance of memory. **Fix:** add provenance + a verifier/human gate on reconsolidation of high-stakes memories; track a per-memory drift metric (e.g. cosine distance from original embedding across versions); never auto-reconsolidate without a source.

### 20. Resonance measures salience, not correctness/stability — **P1**
**Evidence:** memory #1448: *"resonance is an access/reinforcement+recency+priority counter … it measures SALIENCE not STABILITY or STYLE-ness or CORRECTNESS. High resonance correlates with frequently-retrieved facts, which are exactly the volatile facts you must NOT bake."* **Impact:** any plan that treats high resonance as "this is true/important/stable" (e.g. fine-tune-baking candidates, trust weighting) is using the wrong signal. **Fix:** don't use resonance as a quality/truth signal; if you need stability, build a separate staleness/verification classifier.

### 21. P1 priority inflation is a *known-open* issue
**Evidence:** memory #1383 NOT-done list: *"priority-assignment guard (P1 inflation 177)."* **Impact:** confirms #4 with a number — ~177 P1 memories the pruner can't touch; the guard was scoped but never shipped. **Fix:** ship the priority-assignment guard (default captures to P2–P3).

### 22. Skill loop is "economically upside-down" (root cause of #2)
**Evidence:** memory #1382: *"retrieval must precede proven value, competes with .claude/skills and AGENTS.md pushed into context for free, everything stays novice so retrieval stays unattractive."* + #1311: *"the skill system was write-only: 15 skills stored, 0 executions, 0 refinements ever."* **Impact:** explains *why* #2 persists — skills start at `novice`, compete with free context files, and never earn proficiency because executions aren't recorded, so the model has no reason to retrieve them. **Fix:** seed proficiency for proven workflows, auto-record executions host-side, and/or surface skills *as if* they were AGENTS.md content (the search-rides-skills hook is a start).

### 23. Tool dilution / invisible tools
**Evidence:** memory #1382: *"28 cortex tools among 100+ total tools; monologue/observe appear in zero instruction surfaces; Claude Code runs ENABLE_TOOL_SEARCH so never-mentioned tools are effectively invisible."* **Impact:** several Cortex tools are never used simply because nothing references them and tool-search hides unmentioned tools. **Fix:** a "lean tool surface" env flag (also on the NOT-done list) and/or mention every intended-use tool in the instruction surfaces.

### 24. Stale docker MCP image
**Evidence:** memory #1383 NOT-done: *"docker cortex-mcp image rebuild (supergateway port 8000 path still serves the pre-fix image)."* **Impact:** if you ever drive the MCP server via the docker `cortex-mcp` service (supergateway :8000), it serves an **older tool surface** than the host `tsx` path — divergent behavior between entry points. **Fix:** rebuild the docker image, or standardize on the host launcher (`scripts/cortex-mcp.cmd`) which is current.

### 25. MCP end-of-session timeouts punish teardown writes
**Evidence:** memory #1382: *"end-of-session MCP timeouts (-32001) punish protocol-compliant teardown writes."* **Impact:** captures written at session end can be lost to MCP `-32001` timeouts — reinforcing the "capture at the moment of discovery, never batch to teardown" rule (which the instructions already preach, now with a mechanical reason). **Fix:** keep writing at discovery; don't rely on session-end flushes.

---

## Second-pass additions (benchmark methodology, observability gap, ops fragility)

### 26. Benchmark difficulty is more forgiving than the framing — **P3 trust hygiene, now code-verified**
**Evidence:** `benchmarks/*/run*.ts` + `lib/scorer.ts`: each question wipes+re-ingests only its own haystack; recall is **session-level** ("right session in top-K"), deduped to `source`; candidate pools are small (oracle: tiny; `longmemeval_s`: ~45 sessions; LoCoMo: ~19–32). The runner **defaults to `--dataset oracle`** (the easy subset that yields the 100%). **Impact:** the headline "no-LLM, top_k=10" numbers are real for *this* metric but the bar is "rank the right session in the top-10 of ~25–45" — not needle-in-5,000-memories, which is the production workload. **Fix (for your own confidence):** add a single-store benchmark variant (don't wipe between questions; mix all conversations into one corpus; score chunk-level) to measure the retrieval difficulty you actually run in production. Quote the paper's `longmemeval_s` (89.4/97.8/93.0), not the oracle 100%.

### 27. The richest health signal (`/vitals`) is invisible to the model — **P1, actionable**
**Evidence:** `api/vitals.ts` is a genuinely strong 16-rule early-warning engine (dup-pair scan, em-dash-predicts-drift, dream/reflect/threads staleness, synapse collapse, missing HC/valence, **loop-imbalance**, **skills-write-only**, write-spike, crashed-reconsolidation residue). But it's **REST-only — there is no `cortex_vitals` MCP tool**, so the agent that's supposed to maintain its own memory can't see it. **Impact:** the best operational view exists but the model can't consult it; `cortex_self_check` (what the model *can* call) is weaker and can't even see the real schedulers. **Fix:** add a `cortex_vitals` MCP tool (thin wrapper over the same query) and/or surface a vitals summary in the session-start hook. High payoff, low effort.

### 28. The real failure modes are operational, not algorithmic — **P1 to know, mostly mitigated**
**Evidence:** autoresearch runs recorded three actual outages: MCP `-32001` from **IPv6-first `localhost`** resolution stalling postgres-js (fixed by `127.0.0.1`), **Voyage 429** rate-limiting (free tier 3 RPM/10K TPM) throttling 17/20 calls, and **DB `ECONNREFUSED`**. **Impact:** memory silently stops working when any of these hits — and embeddings are a hard throughput ceiling under bursty ingest (e.g. reflect re-harvesting). **Fix:** keep all endpoints on `127.0.0.1` (done in hooks); ensure a paid Voyage tier + consider an embed cache (`CORTEX_EMBED_CACHE`) for re-ingested content; add a vitals/uptime alert for DB reachability; keep the autoresearch watchdog enabled (its last recorded tick was a DB-down failure a month ago — re-point it at the current `DATABASE_URL` or it's monitoring a dead docker stack).

### 30. CogBench is an author-designed benchmark measuring CORTEX's own features — **P3 trust hygiene**
**Evidence:** `paper/cogbench.tex`: the 7 tasks are exactly CORTEX's differentiators (temporal validity, reconsolidation, novelty, emotional recall, cross-agent transfer, compounding intelligence, procedural learning); the paper states a retrieval-only system "would achieve an estimated composite score of <5%." Composite is the **geometric mean** (one zero tanks it). **Impact:** CORTEX scoring 78.5% on a benchmark built around its own feature list is partly tautological — it shows "this architecture has these features," not "this architecture beats neutral third-party systems." The paper is reasonably honest about this and about weak spots: **Compounding Intelligence 44%** (the consolidation-makes-you-smarter claim is the *least* validated) and **Emotional Recall 56.5%**, plus an admitted novelty-threshold domain-calibration failure (corroborates #5). **Fix (for credibility):** treat CogBench as a capability checklist, not a competitive ranking; the LoCoMo/LongMemEval (third-party datasets) numbers carry the real comparative weight.

### 29. CRLF churn makes three docs perpetually "modified" — **P3**
**Evidence:** README/BENCHMARKS/technical-note show 801/801 insert/delete with **zero** `--ignore-all-space` content change; files are CRLF. **Impact:** noisy `git status`, risk of accidentally committing EOL-only churn and masking real edits. **Fix:** add `.gitattributes` with `* text=auto eol=lf` (or `*.md text eol=lf`) and renormalize once.

---

## Verified strengths (so the register isn't one-sided)
- **DG determinism + pattern separation reproduced independently** (dense cos 0.916 → sparse Jaccard 0.478).
- **Memory graph is healthy live:** orphans <100, missing hippocampal codes <50, no synaptic collapse, drift 0.00.
- **Reconsolidation is actively used** (corrections #481–485; journal "reconsolidated 6 memories").
- **Self-healing idempotent migrations**; good engineering discipline around the known drizzle footgun (explicit ARRAY literals + regression test), retry/backoff on embeddings, per-thread timeouts, graceful LLM fallbacks, loud-by-design `markLabile`.

---

## Recommended action order (biggest payoff first)
1. **Port CA3 into the MCP search/recall tools** (#1) — closes the gap between what the model calls and what the benchmarks prove.
2. **Fix `agent_id` discipline** (#7) — set `CORTEX_AGENT_ID`, stop auto-creating on typos.
3. **Unblock skill learning** (#2) — auto-record executions + scheduled skill-mining.
4. **Retune priority defaults + valence** (#4, #5) so forgetting actually works and resonance stops inflating.
5. **Whole-document dedup** (#3).
6. **Make degradation loud** (#6, #12, #13) — vitals rules for proxy fallback + scheduler staleness, surfaced at boot.
7. **Clean portability debt** (#8, #9, #10, #14) before any second agent/user.
