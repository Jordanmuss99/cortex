# Cortex / OmO usage audit tools

Two read-only tools that answer "are our systems actually used, and do they make a difference?"

| Tool | What it measures | Run |
|---|---|---|
| `usage_audit.mjs` | Per project, from OmO session logs: Cortex recall rate, chunks per turn, score spread, **utilisation vs a placebo** (a random memory that was never injected, scored the same way), **already-in-context redundancy**, prompt-cache hit ratio and cost, keepalive pings, token-optimizer folds and spills, project-guard blocks, OmO built-in memory activity. | `node usage_audit.mjs --days 7 [--project lucid-salk] [--json]` |
| `recall_replay.mjs` | Offline A/B test of Cortex versions on real prompts. It rebuilds the compaction-window context the model saw at each prompt and reports the injection rate, tokens, redundancy and handler latency (p50/p95/max). | `node recall_replay.mjs <session.jsonl> <cwd> <cortexA.js> <cortexB.js> --max 150` |

## Method
- **Utilisation** counts a recalled memory as used only when the reply introduces a distinctive token from that memory, or cites the memory's file name, that does not appear in the prompt, in earlier session text since the last compaction, or in that turn's tool results. Each injected memory gets a placebo: a random never-injected memory from the same project, checked against the same reply. A difference over the placebo means the memory was used beyond what lexical coincidence explains. No peer-reviewed paper defines memory-utilisation attribution for agents, so treat this as an engineering metric.
- **Redundancy** is the share of a memory's distinctive tokens already in the context window when it was injected.
- Cortex v2.6 writes one line per recall decision to `~/.omo/memory/agents/<slug>/runtime/cortex-telemetry.jsonl`. This lives in runtime, never in the memory git repo. The dashboard Vitals panel summarises the last 24 hours.

## Baseline (2026-10-28, lucid-salk, last 3 days, Cortex v2.5)
- Recall fired on 14 of 274 real user turns (5.1%), 2.5 chunks per turn.
- 72.3% of injected memory tokens were already in context. Strict utilisation was 0%, the same as the placebo.
- Prompt cache hit rate was 92.8%; the project-guard blocked 10 tool calls; the token-optimizer folded and spilled nothing (no tool output over 24 KB since it was installed).
- Replay, v2.5 vs v2.6 (129 prompts): injected tokens fell from 7,753 to 5,313 (-31%) and redundancy from 53.6% to 40.1%. That replay ran without the system prompt; live, the gate also sees the system prompt and should filter more. Latency p95 was about 8 ms for both.
