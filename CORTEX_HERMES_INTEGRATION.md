# CORTEX -- Hermes Agent Integration (2026-06-18)

*Verified working. This documents the two integration layers: MCP tool surface + deterministic memory gateway.*

---

## What was built

### Layer 1: Cortex as native MCP server (28 tools)

Hermes connects to Cortex's MCP server via stdio. All 28 Cortex tools are auto-discovered and available as `mcp_cortex_*` tools in every Hermes session.

**Config** (`~/.hermes/config.yaml`):
```yaml
mcp_servers:
  cortex:
    command: node
    args: ["D:/Dev Work (SSD)/cortex/scripts/hermes-mcp-launcher.mjs"]
    timeout: 180
    connect_timeout: 30
```

**Launcher** (`scripts/hermes-mcp-launcher.mjs`):
A thin Node wrapper that loads Cortex's own `.env` (Hermes passes env values literally -- no `${VAR}` expansion), spawns the MCP server via `tsx`, and keeps the process alive across stdin EOF (Hermes' `mcp test` closes stdin early).

**Verification**: `hermes mcp test cortex` -> Connected in 3.8s, 28 tools discovered.

**Tools available**: cortex_search, cortex_recall, cortex_init, cortex_ingest, cortex_ingest_file, cortex_ingest_corpus, cortex_dream, cortex_status, cortex_artifact, cortex_self_check, cortex_journal, cortex_assess_state, cortex_state_history, cortex_bg_thread, cortex_synthesize, cortex_observe, cortex_relationship, cortex_relationships, cortex_relationship_update, cortex_reason, cortex_audit, cortex_monologue, cortex_reconsolidate, cortex_labile, cortex_skill_store, cortex_skill_retrieve, cortex_skill_executed, cortex_skill_refine.

### Layer 2: Deterministic Memory Gateway (recall-inject + capture)

Per `CORTEX_INTEGRATION_DESIGN.md` Option B. A thin HTTP proxy (`scripts/cortex-memory-gateway.py`) that sits between Hermes and the model provider (Ollama). Every request gets deterministic recall injection and every exchange is captured -- the model never chooses whether to use memory.

**Architecture**:
```
Hermes Agent (base_url = http://127.0.0.1:3101/v1)
    |
    v
CORTEX MEMORY GATEWAY (port 3101)
  PRE (deterministic):
    1. Extract latest user turn
    2. Cortex REST /recall (CA3-enabled, token-budgeted)
    3. Inject as system block AFTER stable prefix (KV-cache-aware)
  FORWARD -> Ollama (http://127.0.0.1:11434/v1)
  POST (async, non-blocking):
    4. Capture exchange -> Cortex /ingest (dedup gate on)
    5. "// VERIFIED" breadcrumbs -> P0 priority writes
```

**Config** (`~/.hermes/config.yaml` -- both model and provider point at gateway):
```yaml
model:
    base_url: http://127.0.0.1:3101/v1
    provider: ollama-launch
providers:
    ollama-launch:
        api: http://127.0.0.1:3101/v1
```

**Gateway config** (env vars, all have defaults):
- `CORTEX_REST_BASE` = http://127.0.0.1:3100
- `CORTEX_AGENT_ID` = arlo
- `CORTEX_RECALL_BUDGET` = 1200 (tokens per recall)
- `CORTEX_RECALL_THROTTLE_MS` = 600000 (10-min window; 0 = every request)
- `CORTEX_CAPTURE_MIN_CHARS` = 200 (skip trivial exchanges)
- `CORTEX_UPSTREAM` = http://127.0.0.1:11434/v1
- `CORTEX_GATEWAY_BIND` = 127.0.0.1
- `CORTEX_GATEWAY_PORT` = 3101

**Design constraints honored** (per CORTEX_INTEGRATION_DESIGN.md S5):
- KV-cache: inject AFTER the stable system prefix, not before
- No double-inject: the MCP tools remain for deliberate memory acts (reconsolidate, reason, skills); the gateway only owns the reflex (recall + capture)
- Latency: recall is throttled to task boundaries (10-min window), cached per session
- Dedup gate: capture uses the REST ingest path (skips dups, never refuses)
- VERIFIED breadcrumbs: `// VERIFIED` in user or assistant content -> P0 priority ingest
- IPv4 only: 127.0.0.1 everywhere (never localhost -- the -32001 IPv6 outage)
- Security: binds to 127.0.0.1, no logging of prompt bodies, only metadata
- Meridian: the gateway is for agent traffic only; Cortex's internal LLM path (entity extraction, dream summaries) is left alone

---

## How to run

### Start Cortex REST (port 3100)
```bash
cd "D:/Dev Work (SSD)/cortex"
npx tsx src/index.ts
```

### Start the Memory Gateway (port 3101)
```bash
cd "D:/Dev Work (SSD)/cortex"
python scripts/cortex-memory-gateway.py
```

### Start Hermes (uses gateway automatically)
```bash
hermes
```
Hermes now routes all chat completions through the gateway, getting deterministic recall injection and automatic capture.

### Health check
```bash
curl http://127.0.0.1:3101/health
```

---

## Verified round-trip (2026-06-18)

1. **Recall**: `POST /api/v1/recall` -> 200 OK, 5,230 chars of context returned
2. **Injection**: Inserted at position 1 (after system prefix) -> KV-cache preserved
3. **Forward**: Request proxied to Ollama -> 200 OK
4. **VERIFIED detection**: `// VERIFIED` breadcrumb -> P0 priority
5. **Capture**: `POST /api/v1/ingest` -> 1 chunk, 40 synapses formed
6. **Searchable**: Memory #3514, source=`hermes-gateway`, type=`verified-api`, priority=P0

---

## Hybrid model (the right architecture)

The gateway and MCP tools serve different purposes -- they don't overlap:

| Layer | What it owns | How |
|-------|-------------|-----|
| **Gateway** (deterministic) | Recall injection + capture | Every request, no model decision |
| **MCP tools** (deliberate) | Reconsolidate, reason, skills, journal, audit, relationships, dream, self-check | Model chooses to call |

This is the "hybrid: gateway owns the reflex, MCP owns the deliberate act" pattern from CORTEX_INTEGRATION_DESIGN.md S3.

---

## Troubleshooting

### MCP server won't connect
1. Check `hermes mcp test cortex` -- should show 28 tools in <5s
2. Check `~/.hermes/logs/mcp-stderr.log` for Cortex startup errors
3. Ensure Cortex `.env` exists with `DATABASE_URL` and `VOYAGE_API_KEY`
4. The launcher loads `.env` itself -- no env block needed in config.yaml

### Gateway not injecting
1. `curl http://127.0.0.1:3101/health` -- check `cortex_rest` is `ok`
2. Check `/tmp/cortex-gateway.log` for "Injected recall" lines
3. Trivial turns ("ok", "yes", "continue") are intentionally skipped
4. Throttle: same session won't re-recall within 10 minutes (configurable)

### Gateway not capturing
1. Exchange must be >= 200 chars total (configurable via `CORTEX_CAPTURE_MIN_CHARS`)
2. Check log for "Cortex ingest" lines
3. Dedup gate: if content is too similar to existing memory, it's skipped (check log for "skipped near-duplicate")

### Model timeouts
The gateway adds ~400ms (recall latency) to TTFB. If the model itself is slow, the total can exceed Hermes' default timeout. The gateway's upstream timeout is 300s.