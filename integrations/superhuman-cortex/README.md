# Superhuman Go connector — CORTEX (scaffold)

Connects Superhuman Go's **Prompt Rewriter** to the CORTEX read-only memory MCP endpoint
so it can recall relevant memories before rewriting a prompt.

- Backend: `src/mcp/http-server.ts` (`POST /mcp`), gated by `CORTEX_MCP_TOKEN` (Bearer).
- Exposed tools (read-only only): `cortex_search`, `cortex_recall`, `cortex_init`
  (each `readOnlyHint:true`, so Go shows no confirmation dialog).

## Deployment fork (see `../../docs/superhuman-go-mcp-integration-plan.md` §7.4)
Preferred: host Cortex on Vercel + Neon and point `endpointUrl` at the Vercel URL + `/mcp`
(no Cloudflare tunnel needed). The `cortex.obsidiannetwork.au` value in `pack.ts` is only
correct if you instead run Cortex on the tunnel host.

## Build
```sh
npx @codahq/packs-cli init            # scaffold a real Pack, then paste pack.ts here
npx @codahq/packs-cli run
npx @codahq/packs-cli release         # only after CORTEX_MCP_TOKEN is set and /mcp verified
```
