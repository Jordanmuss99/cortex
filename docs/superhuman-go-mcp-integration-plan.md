# Superhuman Go Prompt Rewriter: Cortex + AgentBridge MCP Connectors

Implementation plan for exposing CORTEX memory and AgentBridge session context to
Superhuman Go's **Prompt Rewriter** agent via two custom MCP connectors.

## Current decisions and implementation checkpoint (November 3, 2026)

The user selected memory-only Cortex, separate consumer-side composition,
shared project identity with preserved agent scopes, and current main with
selective compatible ports. See [the accepted decisions](cortex-decisions.md).

Cortex's current `/mcp` surface exposes four memory tools. The shared tool module
is safe to import without starting stdio/database initialization; restricted calls
do not create agent namespaces or update search access counters. Cortex no longer
contains a runtime AgentBridge client. Its memory digest honors the complete
requested token budget. The server suite passes 80 tests and TypeScript checking.

Connector build targets selected by the user are
`https://cortex.obsidiannetwork.au/mcp` and
`https://ab.obsidiannetwork.au/api/mcp`. Those choices are not publication,
deployment, DNS/tunnel-change approval, or evidence that the endpoints are live.

The original planning sections below are historical context. Their old dependency
availability, process IDs, inferred infrastructure state, and SDK assumptions
must not be treated as current operational instructions or authorization.

The completed local implementation, commands and activation prerequisites are in
the [connector runbook](../integrations/README.md). Both definitions pass strict
checking, SDK validation/build and generated deployment-contract tests. The
current SDK accepts omission of the search field but not an empty list; the user
selected `agentbridge_prompt_context` for AgentBridge. See the
[full project update](cortex-project-update-2026-11-03.md) for evidence boundaries
and the unresolved SDK dependency audit.

---

## 0. TL;DR decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Connector count | **Two separate Packs** (Go enforces exactly one MCP server per connector) |
| D2 | Cortex transport | Add `WebStreamableHTTPServerTransport` to the existing MCP server, mount at `POST /mcp` on the existing Express app |
| D3 | Cortex hosting | Vercel (already configured in `vercel.json`) + Neon serverless Postgres — genuinely hosted |
| D4 | AgentBridge transport | New stdlib `POST /mcp` route inside `connector.py`, dispatching to the existing `MCPServer.handle_request()` |
| D5 | AgentBridge hosting | **Cannot be hosted.** Data is on local disk (`~/.claude/projects`, `~/.gemini/antigravity/brain`) + Windows named pipes. Requires a persistent named Cloudflare Tunnel from the dev machine |
| D6 | Auth | `HeaderBearerToken` for both (maps 1:1 to Cortex `CORTEX_MCP_TOKEN` and the existing `X-Bridge-Token` / `Authorization: Bearer` scheme) |
| D7 | Tool surface | **Curated read-only allowlist per server.** Never ship the 18-tool AgentBridge surface to Go |
| D8 | New capability | One purpose-built tool per server (`cortex_prompt_context`, `agentbridge_prompt_context`) that composes existing primitives into a token-budgeted digest |

The asymmetry in D5 is the single most important thing in this document: the two
connectors look symmetric in the Go UI but have completely different deployment
topologies. Plan your infra accordingly.

---

## 1. Platform constraints that shape the design

From the [MCP block guide](https://coda.io/packs/build/latest/guides/blocks/mcp),
checked against the current state of both repos:

| Go requirement | Cortex today | AgentBridge today |
|---|---|---|
| **Hosted servers only** (no `npm`-installed local servers) | ❌ `npx tsx src/mcp/server.ts`, stdio | ❌ stdio JSON-RPC loop |
| **Streamable HTTP transport only** (HTTP+SSE unsupported) | ❌ `StdioServerTransport` | ❌ line-delimited stdio JSON-RPC |
| **Tools only** (resources/prompts ignored) | ✅ tools | ✅ tools |
| **No streaming** — must await complete response | ✅ request/response | ⚠️ `wait`-style tools can block for minutes |
| **≤16 search tools**, names ≤128 chars | n/a | n/a |
| **One MCP server per connector** | → 2 Packs | → 2 Packs |
| Domains pre-declared via `addNetworkDomain` | needs `neon`/Vercel domain | needs a *stable* tunnel domain |
| `readOnlyHint: true` → no user confirmation | unset | unset |

Supporting facts, verified in-repo:

- `cortex/package.json` declares `@modelcontextprotocol/sdk ^1.26.0`, which ships
  `WebStreamableHTTPServerTransport`. **`node_modules` is not currently installed** —
  run `npm install` before any of this work.
- `cortex/src/db/index.ts` already branches on `neon.tech` URLs and `cortex` depends on
  `@neondatabase/serverless`, so serverless hosting is a supported path, not a hack.
- `cortex/vercel.json` routes `/api/(.*) → src/index.ts`; the Express app in
  `src/index.ts` is the natural mount point for `/mcp`.
- `agentbridge/agentbridge/mcp_server.py` hand-rolls JSON-RPC with
  `PROTOCOL_VERSION = "2024-11-05"` and a `for line in sys.stdin` loop.
- `agentbridge/agentbridge/connector.py` is a stdlib `ThreadingHTTPServer` with a
  `route()` table, Bearer/X-Bridge-Token auth (`resolve_token`, `_extract_token`), and an
  existing cloudflared tunnel launcher (`CloudflareTunnel`).
- `agentbridge` already proves the composition pattern we want: the AI Studio spec's
  `attach_delta` path concatenates `config.paste_file` with
  `read_session_transcript(..., turns=10, include_tools=False, max_chars_per_turn=2000)`.

---

## 2. Tool contracts

Expose **only** these. Everything else in the two servers stays local-only.

### 2.1 Cortex MCP allowlist (4 tools)

| Tool | Source | `readOnlyHint` | Role in rewriting |
|---|---|---|---|
| `cortex_search` | existing, `src/mcp/server.ts:65` | true | Hybrid 7-factor recall for prior decisions/conventions |
| `cortex_recall` | existing, `src/mcp/server.ts:213` | true | Token-budget-aware context (the workhorse) |
| `cortex_init` | existing, `src/mcp/server.ts:316` | true | Session boot — top memories + active entities |
| `cortex_prompt_context` | **new** | true | One-shot: search + recall + entity framing trimmed to N tokens |

Deliberately excluded: `cortex_ingest`, `cortex_dream`, `cortex_status` and every
mutation tool. They are either side-effecting (triggering Go's confirmation dialog on a
read-only prompt-rewrite path) or irrelevant.

`cortex_prompt_context` request/response:

```jsonc
// in
{ "query": "refactor the compaction evaluator", "agent_id": "arlo",
  "token_budget": 1200, "limit": 8 }
// out (text content, markdown)
## Relevant memories (scored)
1. [P1, r8.2, 2026-10-12] DECISION_7: ... 
## Active entities
- cortex_search, compaction_eval.py
## Constraints from prior sessions
- ...
// footer: [CORTEX: 7 nodes, ~1180 est. tokens, agent=arlo]
```

### 2.2 AgentBridge MCP allowlist (5 tools)

| Tool | Source | `readOnlyHint` | Role |
|---|---|---|---|
| `agentbridge_list_sessions` | `list_sessions` → `bridge.list_all_sessions()` | true | Which work is in flight |
| `agentbridge_inspect_session` | `inspect_session` → `bridge.inspect_session()` | true | Live state, touched files, cwd, branch, stack claim |
| `agentbridge_read_session_transcript` | `read_session_transcript` → `bridge.read_session_transcript()` | true | Recent turns the prompt must stay consistent with |
| `agentbridge_get_fleet_pulse` | `get_fleet_pulse` → `bridge.get_fleet_pulse()` | true | IDLE/BUSY across the fleet, <0.2s single call |
| `agentbridge_prompt_context` | **new** | true | Bundles the above into one token-budgeted digest |

Hard-excluded — all side-effecting, and each would fire a confirmation prompt in Go:
`send_session_message`, `dispatch_outcome_contract`, `delegate_task`, `handoff_session`,
`handoff_to_omo`, `spawn_claude_session`, `spawn_omo_session`, `stop_claude_session`,
`acquire_stack_claim`, `release_stack_claim`, `sync_linked_sessions`,
`sync_architect_blackboard`, `sync_simsonline_blackboard`.

`agentbridge_prompt_context` in/out:

```jsonc
// in
{ "target": "Field Commander", "turns": 8, "token_budget": 900, "include_fleet": true }
// out
## Session: Field Commander (claude) — BUSY, 12s ago
cwd …\SimsOnline · branch w1-mod-feed · holds stack claim ("TS3 ABI probe")
## Last 8 turns
### user\n…  ### assistant\n… (tools: Read, Grep)
## Touched files
- engine/SimJSON/…  
## Fleet
3 active · 1 idle · GPU cuda:0 locked by Session O
// footer: [AgentBridge: 8 turns, ~870 est. tokens]
```

`target` resolution reuses `bridge.resolve_session()` verbatim, so title / PID / pipe
address / UUID fuzzy matching all keep working.

---

## 3. Workstream A — Cortex MCP over Streamable HTTP

**A1. Refactor tool registration out of the entrypoint.**
`src/mcp/server.ts` currently constructs the `McpServer` at module scope and runs stdio.
Extract every `server.tool(...)` call into a new
`src/mcp/register-tools.ts` exporting `registerTools(server: McpServer): void`, so the
stdio server and the HTTP server register the identical tool set. No behavior change;
this is the prerequisite for everything else.

**A2. Preserve `cortex_search` semantics exactly.** The hybrid SQL (cosine sim + ILIKE
text match + `EXP(-0.023 * days)` recency + `resonance/10` + priority case-boost) and the
non-fatal access-count `UPDATE` stay in the shared module. Do not re-implement search in
the new tool; call `cortex_search`'s handler body.

**A3. Add `cortex_prompt_context`** — ✅ IMPLEMENTED. Landed in `src/mcp/server.ts` (the
registration was done in-place via `registerTools(server, { only })` rather than a separate
`register-tools.ts`). It composes hybrid-relevant memories + aggregated entities + P0/P1
prior-session constraints and trims to `token_budget` via `countTokens` (mirroring
`consolidated_memory_block`'s loop-down). Pure formatting lives in `src/mcp/prompt-context.ts`
(`buildPromptContextDigest`) so it is unit-tested without a DB (`src/__tests__/prompt-context
.test.ts`); the search reuses a single-source `runHybridSearch` helper extracted from
`cortex_search` (the access-count telemetry stays in `cortex_search`, so the
`drizzle-array-cast` test is unaffected). Added to the HTTP read-only allowlist.

> Scope note (decision 2026-10-29): `cortex_prompt_context` is deliberately **Cortex-internal**
> (memories only). It does NOT reach into AgentBridge. Live session data stays in the separate
> `agentbridge_prompt_context` (§2.2), and the Prompt Rewriter merges the two on the Go side.
> Coupling Cortex→AgentBridge server-side would violate "one MCP server per connector", let the
> Cortex connector surface session/transcript data through its own bearer token (bypassing the
> AgentBridge allowlist+redaction boundary), and add a hard availability dependency. Verified:
> HTTP `tools/list` returns 4 read-only tools, each `readOnlyHint:true`.

**A4. New file `src/mcp/http-server.ts`.**
- Build an `McpServer`, call `registerTools(server)`.
- Per request: `new WebStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`
  (stateless — see Risks R3), `await server.connect(transport)`,
  `await transport.handleRequest(req, res, req.body)`, `onclose` cleanup.
- Express `app.use("/mcp", express.json(), handler)`; also expose `GET /mcp/health`.

**A5. Mount on `src/index.ts`** at `/mcp` next to the existing `/api/v1/*` routers so the
current `vercel.json` `/api/(.*)` route plus a `/mcp` route both resolve.

**A6. Auth.** Guard the `/mcp` router with a bearer check against
`process.env.CORTEX_MCP_TOKEN`; `401` on mismatch. Never fall back to
open — `_is_trusted_loopback`-style auto-trust must not apply to a public endpoint.

**A7. Annotations.** Set `{ readOnlyHint: true }` on all four tools so Go skips
confirmation prompts.

**A8. Deploy.** `vercel deploy` (config already present) or a small container; `DATABASE_URL`
points at Neon. Confirm `pgvector` + the `.rows`/`.rowCount` shim in `src/db/index.ts`
behave under the serverless driver before wiring Go.

---

## 4. Workstream B — AgentBridge MCP over Streamable HTTP

**B1. New file `agentbridge/mcp_http.py`** (stdlib only, matching repo convention) that
adapts the existing `MCPServer.handle_request()` dict API to Streamable HTTP:
- `POST /mcp` accepts a JSON-RPC request or batch, returns `application/json`.
- Echo the client's `protocolVersion` if recognized, else respond with a supported
  version — the hard-coded `"2024-11-05"` will likely be rejected by a modern client.
- `Mcp-Session-Id` omitted in stateless mode; reject `GET /mcp` with `405` (no SSE
  server channel — Go can't consume streams anyway).
- Unknown method → JSON-RPC `-32601`, already implemented.

**B2. Route it in `connector.py`.** Add `"/mcp": {"POST": self.api_mcp}` to the `route()`
table at line ~933 and a thin handler delegating to `mcp_http`. This buys us the existing
token auth, CORS, body-size limits, and ThreadingHTTPServer concurrency for free.

**B3. Enforce the allowlist.** In the HTTP path only, filter `TOOLS` to the five
allowlisted names (prefix them `agentbridge_` in `tools/list` output for clear namespacing
in Go) and raise `-32602` for anything else. The stdio server used by Claude Code and
Antigravity keeps the full 18-tool surface — this is a *remote* policy, not a global one.

**B4. Add `agentbridge_prompt_context`** to `MCPServer.execute_tool` and `core.py`,
composing `resolve_session` + `inspect_session` + `read_session_transcript` +
`get_fleet_pulse`. Reuse the AI Studio delta pattern: `include_tools=False`,
`max_chars_per_turn=2000`, then a token trim pass using the module's existing
`estimate_tokens()`.

**B5. Protocol parity.** `handle_request` must also answer `tools/list` with
`annotations.readOnlyHint=true` and keep `notifications/initialized` returning `None`.

**B6. Tunnel — already provisioned (revised after the 2026-10-29 probe).**
This machine already runs a Windows service `Cloudflared` (Automatic, survives reboot) as
`tunnel run --token-file C:\ProgramData\cloudflared\token`, so a named tunnel exists and no
`cloudflared tunnel create` is needed. `~/.cloudflared/cert.pem` is absent, so the hostname
route must be added in the **dashboard** (Network → Tunnels → Public Hostname →
`HTTP://127.0.0.1:8765`), not via `route dns`.

The connector currently runs as `connector --port 8765 --tunnel`. Live-verified: an
untokened `POST /api/send` returns `401 missing or invalid bridge token`, because `--tunnel`
sets `tunnel_active` and disables loopback auto-trust. **When traffic moves to the named
service tunnel, stop relying on that flag and relaunch with `--require-local-token`** —
otherwise token enforcement hinges entirely on cloudflared forwarding `CF-Connecting-IP`, a
header the connector cannot require. Full runbook:
`agentbridge/docs/superhuman-tunnel.md`.

Also found: two stray ad-hoc quick tunnels (`tunnel --url http://127.0.0.1:8765`, pids 21312
and 75072) already publishing the connector on ephemeral `trycloudflare.com` hostnames.
Unrelated to this project, but they should be closed before anything new is exposed.

---

## 5. Workstream C — the two Go connectors

Go allows exactly one MCP server per connector, so two Packs.

`cortex-go/pack.ts`:
```ts
import * as sdk from "@codahq/packs-sdk";
export const pack = sdk.newPack();
pack.addMCPServer({
  name: "Cortex",
  endpointUrl: "https://mcp-cortex.<domain>/mcp",
  searchToolNames: ["cortex_search", "cortex_recall", "cortex_prompt_context"],
});
pack.setUserAuthentication({ type: sdk.AuthenticationType.HeaderBearerToken });
pack.addNetworkDomain("<domain>");   // root domain, per the guide's best practice
```

`agentbridge-go/pack.ts` is identical in shape with
`searchToolNames: ["agentbridge_prompt_context", "agentbridge_read_session_transcript"]`.

Notes:
- `searchToolNames` (≤16 entries) is what lets Go's **knowledge search** reach the server —
  Cortex is the natural fit; register AgentBridge's context tools too if you want them
  reachable from ordinary Q&A, not only from the Rewriter.
- Name the server block `Cortex` / `AgentBridge`, not `MCP`, so tool labels read well in
  Go. Verify actual surfaced names in a smoke test; expected shape is
  `Cortex - cortex_search`.
- Build with the Packs CLI (`npx @codahq/packs-cli`) or Pack Studio; release each after
  testing, since installed connectors only pick up released versions.

**Prompt Rewriter wiring.** Go's built-in agent types are configured at the product level;
connectors *enable* it rather than define it. Load-bearing assumption to verify on day 1:
whether `pack.setAgentType(...)` with a Prompt-Rewriter type and `systemInstruction` exists
in your installed SDK version, or whether you instead enable both connectors and let the
Rewriter discover tools. **Do not build against `setAgentType` until it is confirmed** — the
rest of the plan is independent of the answer.

---

## 6. Security (non-negotiable for Workstream B)

This plan publishes the full text of your private agent transcripts to the internet.

1. **Token discipline.** Cortex: generate a distinct high-entropy `CORTEX_MCP_TOKEN`, never
   reuse `~/.agentbridge/bridge_token.txt`. AgentBridge: the existing
   `tunnel_active` flag already disables loopback auto-trust and `_is_trusted_loopback`
   rejects requests carrying `CF-Connecting-IP`/`X-Forwarded-*`, so tunnel traffic is
   token-gated by construction. Keep that check intact.
2. **Redaction at the adapter layer**, before serialization: strip secret-shaped strings
   (`sk-…`, `sk-ant-…`, `ghp_…`, JWTs, PEM headers, `X-Bridge-Token` echoes) from turn text.
   Do this in `mcp_http.py` so every read tool inherits it.
3. **Workspace scoping.** Add an env allowlist (`AGENTBRIDGE_MCP_WORKSPACES`) and refuse
   `target` resolution outside it.
4. **Hard caps** independent of client args: `turns ≤ 25`,
   `max_chars_per_turn ≤ 4000`, `token_budget ≤ 2000`, response body ≤ 256 KiB.
5. **Read-only is the policy, not just a hint** — B3 rejects non-allowlisted tools at the
   HTTP boundary so a prompt in the Go UI cannot become an action on your machine.
6. **Audit log** each remote call (tool, args-hash, token prefix, result size) — timestamps
   only, never content, matching the connector's existing "bodies and tokens are never
   logged" stance.
7. Kill switch: `cloudflared tunnel delete` / stop the scheduled task, or set
   `CORTEX_MCP_TOKEN=invalid` to hard-fail auth.

---

## 7. Files touched

| Repo | File | Change |
|---|---|---|
| cortex | `src/mcp/register-tools.ts` | **new** — all `server.tool()` registrations, extracted |
| cortex | `src/mcp/server.ts` | thin stdio wrapper calling `registerTools` + `StdioServerTransport` |
| cortex | `src/mcp/http-server.ts` | **new** — `WebStreamableHTTPServerTransport` + bearer auth |
| cortex | `src/mcp/prompt-context.ts` | **new** — `cortex_prompt_context` composition |
| cortex | `src/index.ts` | mount `/mcp` |
| cortex | `vercel.json` | add `/mcp` route |
| cortex | `.env.example` | `CORTEX_MCP_TOKEN` |
| agentbridge | `agentbridge/mcp_http.py` | **new** — Streamable HTTP adapter + allowlist + redaction |
| agentbridge | `agentbridge/connector.py` | `/mcp` route in `route()`; caps |
| agentbridge | `agentbridge/mcp_server.py` | `agentbridge_prompt_context`; `readOnlyHint` in `TOOLS` |
| agentbridge | `agentbridge/core.py` | `build_prompt_context()` |
| agentbridge | `agentbridge/cli.py` | `connector --mcp` flag; `mcp-serve --http --port` |
| new | `cortex-go/pack.ts` | Go connector Pack 1 |
| new | `agentbridge-go/pack.ts` | Go connector Pack 2 |
| new | `docs/superhuman-tunnel.md` | named-tunnel setup + runbook |

---

## 8. Sequence

1. `npm install` in cortex; smoke-test `npm run mcp` over stdio (baseline: nothing broken).
2. A1–A2 refactor → stdio `tools/list` unchanged (byte-compare before/after).
3. A4–A7 HTTP transport; verify with `npx @modelcontextprotocol/inspector --transport http`.
4. B1–B5 AgentBridge HTTP adapter; same inspector against the local tunnel URL.
5. Deploy Cortex to Vercel; confirm Neon query compatibility.
6. ~~Stand up the named Cloudflare Tunnel~~ **done by a prior setup** — remaining infra is
   one dashboard Public Hostname route + relaunching the connector with
   `--require-local-token`, then the 4 checks in `agentbridge/docs/superhuman-tunnel.md` §4.3.
   Zero-allowlist prerequisite: B3 must land before `/mcp` is routed.
7. Build + release both Packs; authenticate with the two tokens; confirm tool discovery.
8. Land the `prompt_context` tools (A3, B4) once transport is proven.
9. Configure the Prompt Rewriter and run the E2E acceptance prompts.

Steps 1–4 are independent per repo and can be parallelized across two sessions. Infra is no
longer on the critical path — the tunnel and service already exist, so step 6 is minutes of
dashboard clicking rather than a lead-time item. **Start at step 1 or 4, not step 6.** The one
item that should jump the queue is closing the two stray quick tunnels in §2.1 of the runbook,
which is unrelated to this project and worth doing regardless.

---

## 9. Verification

**Unit / contract**
- cortex: jest — `register-tools` exposes exactly the expected names; `prompt_context`
  output ≤ budget; bearer middleware returns 401 without and 200 with a token.
- agentbridge: `tests/test_mcp_http.py` — initialize negotiates the client's version;
  `tools/list` returns only the 5 allowlisted entries with `readOnlyHint`; `tools/call`
  on `delegate_task` → JSON-RPC error; redaction strips an injected `sk-ant-…` string.
- Both: assert no mutation tool is reachable over HTTP.

**Transport**
- `@modelcontextprotocol/inspector` in HTTP mode against each server.
- Raw curl proving Streamable HTTP compliance: `initialize` → `notifications/initialized`
  → `tools/list` → `tools/call`, all `application/json`, no SSE.
- Explicit **HTTP+SSE negative test**: confirm we never emit `text/event-stream`, since Go
  rejects that transport.

**End-to-end**
1. Prompt: *"Rewrite: 'fix the compaction bug'"* → rewritten output must cite
   `DECISION_7`-style memory (proves Cortex path) and name `compaction_eval.py` (proves
   AgentBridge path).
2. Latency budget < 8s round trip: `cortex_recall` limit 8 → 0.5–1.5s (Neon round trip +
   Voyage embedding); `agentbridge_get_fleet_pulse` → 0.2s + cloudflared 100–300ms;
   `inspect_session` on 60MB JSONL <1s via `_read_jsonl_fast` tail window
   `max(2 MiB, turns × 160 KiB)`.
3. Negative auth: wrong bearer token in Go → clean auth error, not a tool failure.
4. Tool-surface assertion: Go's connector detail page shows exactly 4 + 5 tools.

---

## 10. Risks & mitigations

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Ephemeral tunnel URL breaks the declared domain allowlist on every restart | Named Cloudflare Tunnel + as-a-service scheduled task (B6) |
| R2 | Transcript disclosure via public HTTPS endpoint | §6: allowlist, redaction, workspace scope, caps, distinct tokens |
| R3 | Go may require a session-ful Streamable HTTP handshake (`Mcp-Session-Id`) | Start stateless (`sessionIdGenerator: undefined`); if `initialize` fails, add session map + `DELETE /mcp`. Cheap change in both repos |
| R4 | `PROTOCOL_VERSION = "2024-11-05"` rejected by Go's client | Echo/negotiate supported versions (B1); confirm via inspector |
| R5 | Blocking tools exceed Go's fetch timeout (e.g. `acquire_stack_claim wait`) | Excluded from allowlist; enforce 15s ceiling on every exposed tool |
| R6 | `setAgentType` / Prompt-Rewriter config API differs from assumption | Verify SDK surface at step 7; nothing before it depends on it |
| R7 | `node_modules` absent in cortex → SDK transport availability unproven | `npm install` in step 1; assert `dist/esm/server/webStreamableHTTP.js` exists |
| R8 | Neon serverless + `pgvector` hybrid SQL behaves differently | Step 5 gate before Go wiring |
| R9 | `searchToolNames` drift as servers change | Names asserted in unit tests; missing names are ignored by Go, not fatal |
| R10 | Two connectors confusing for knowledge-search attribution | Cortex is the search source; AgentBridge stays context-only |

---

## 11. Resolved decisions (2026-10-29)

| # | Question | Decision |
|---|---|---|
| Q1 | Dev-machine uptime | **Ship both.** AgentBridge tools return a clean error when the machine is offline; the Rewriter degrades gracefully rather than the integration being withheld. |
| Q2 | Tunnel hostname | **Own a domain** → named Cloudflare Tunnel with a stable `mcp.<domain>` route. B6 is unblocked; no quick-tunnel workaround needed. |
| Q3 | Write-back | **Read-only.** No `cortex_ingest` on the remote surface. Every exposed tool keeps `readOnlyHint: true`. D7 is final, not provisional. |
| Q4 | Cortex `agent_id` | Still open. Default to `arlo` for Phase 1; revisit per-prompt selection only if multi-agent rewriting is actually needed. |

Consequence of Q1 — add an explicit **offline contract**: when the tunnel is down or the
connector unreachable, Go must see a tool error reading *"AgentBridge host offline;
rewriting without live session context"* rather than a generic fetch failure, so the
Rewriter tells you what it couldn't see instead of silently rewriting blind. Cheap to
implement in `mcp_http.py`, worth doing before step 9.

## 12. Still open

1. Exact `mcp.<domain>` hostname to register, and which machine permanently hosts the
   connector — it must be the box whose `~/.claude/projects` you want Go to read.
2. Whether `pack.setAgentType` / Prompt-Rewriter config exists in the installed SDK
   (R6; verify at step 7, nothing before it depends on the answer).
