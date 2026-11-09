import express from "express";
import cors from "cors";
import { PACKAGE_VERSION } from "./lib/version.js";
import { searchRouter } from "./api/search.js";
import { recallRouter } from "./api/recall.js";
import { ingestRouter } from "./api/ingest.js";
import { healthRouter } from "./api/health.js";
import { reconsolidateRouter } from "./api/reconsolidate.js";
import { proceduralRouter } from "./api/procedural.js";
import { graphRouter } from "./api/graph.js";
import { dreamRouter } from "./api/dream.js";
import { handleMcpRequest, handleResourceMetadata } from "./mcp/http-server.js";
import { requireAuth } from "./mcp/auth.js";

/** Builds the Express app (no listening, no DB init) so tests exercise the real wiring. */
export function createApp() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Every REST route requires the same authentication as POST /mcp (OAuth JWT or static
  // bearer; fail-closed when neither is configured). No /api/v1 route is public.
  app.use("/api/v1", requireAuth);

  // Routes
  app.use("/api/v1/search", searchRouter);
  app.use("/api/v1/recall", recallRouter);
  app.use("/api/v1/ingest", ingestRouter);
  app.use("/api/v1/reconsolidate", reconsolidateRouter);
  app.use("/api/v1/procedural", proceduralRouter);
  app.use("/api/v1/graph", graphRouter);
  app.use("/api/v1/dream", dreamRouter);
  app.use("/api/v1", healthRouter);

  // MCP over Streamable HTTP (read-only surface for remote clients, e.g. Superhuman Go).
  // OAuth 2.1 resource-server auth (managed IdP mints JWTs; Cortex verifies) with a static-bearer
  // fallback (CORTEX_MCP_TOKEN). Fail-closed when neither is configured.
  app.get("/.well-known/oauth-protected-resource", handleResourceMetadata);
  app.post("/mcp", express.json({ limit: "1mb" }), handleMcpRequest);

  // Root (public: service description only)
  app.get("/", (_req, res) => {
    res.json({
      service: "CORTEX V2",
      description: "Synthetic cognition infrastructure for AI agents",
      version: PACKAGE_VERSION,
      endpoints: {
        health: "GET /api/v1/health",
        status: "GET /api/v1/status",
        search: "POST /api/v1/search",
        recall: "POST /api/v1/recall",
        ingest: "POST /api/v1/ingest",
        reconsolidate: "POST /api/v1/reconsolidate",
        labileMemories: "GET /api/v1/reconsolidate/labile?agentId=xxx",
        proceduralStore: "POST /api/v1/procedural",
        proceduralRetrieve: "POST /api/v1/procedural/retrieve",
        proceduralExecute: "POST /api/v1/procedural/:id/execute",
        proceduralRefine: "PATCH /api/v1/procedural/:id",
        graph: "GET /api/v1/graph?agentId=xxx",
        dream: "POST /api/v1/dream",
      },
    });
  });

  return app;
}
