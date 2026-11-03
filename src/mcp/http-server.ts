/**
 * CORTEX V2 MCP over Streamable HTTP
 * ==================================
 * Exposes a READ-ONLY subset of the CORTEX tools over the Streamable HTTP transport for
 * remote clients such as the Superhuman Go "Prompt Rewriter". This is the trust boundary:
 * the full stdio surface (ingest/dream/reconsolidate/spawn/relationships/...) is NOT
 * reachable here — only the tools in CORTEX_READ_ONLY_TOOLS are registered.
 *
 * Design choices (see cortex/docs/superhuman-go-mcp-integration-plan.md Workstream A):
 *  - Stateless: a fresh McpServer + transport per request (sessionIdGenerator: undefined),
 *    so no Mcp-Session-Id bookkeeping and no cross-request leakage.
 *  - enableJsonResponse: replies with application/json (no SSE). Go cannot consume streams.
 *  - Auth: OAuth 2.1 resource-server semantics (managed IdP mints JWTs; Cortex verifies audience-
 *    bound tokens) with the legacy static bearer kept as a fallback. Fail-closed when neither is
 *    configured. 401s carry `WWW-Authenticate: Bearer resource_metadata=...` for OAuth discovery.
 *
 * Mount: index.ts -> `app.post("/mcp", express.json(), handleMcpRequest)` and
 *                 `app.get("/.well-known/oauth-protected-resource", handleResourceMetadata)`.
 */
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, registerTools } from "./server.js";
import { authenticate, protectedResourceMetadata, wwwAuthenticate } from "./auth.js";
import "dotenv/config";

// The only tools a remote consumer may see or call. cortex_prompt_context is the
// one-shot enrichment digest (memories + entities + constraints, budget-trimmed);
// cortex_recall is the budget-aware loader; cortex_search the hybrid recaller;
// cortex_init the session boot. All carry readOnlyHint:true so Go treats them as
// non-mutating (no confirmation).
export const CORTEX_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "cortex_prompt_context",
  "cortex_search",
  "cortex_recall",
  "cortex_init",
]);

// RFC 9728 Protected Resource Metadata — PUBLIC (no auth), consumed by MCP clients to
// discover the authorization server. 404 when OAuth is not configured (static-bearer-only).
export function handleResourceMetadata(_req: Request, res: Response): void {
  const doc = protectedResourceMetadata();
  if (!doc) {
    res.status(404).json({ error: "protected resource metadata not configured" });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json(doc);
}

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "method not allowed; this MCP endpoint accepts POST only" });
    return;
  }
  const auth = await authenticate(req);
  if (!auth.ok) {
    res.setHeader("WWW-Authenticate", wwwAuthenticate(req));
    res.status(401).json({ error: auth.error });
    return;
  }

  const server = createServer();
  registerTools(server, { only: CORTEX_READ_ONLY_TOOLS });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,       // application/json, no SSE stream
  });

  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[cortex-mcp-http] request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
}
