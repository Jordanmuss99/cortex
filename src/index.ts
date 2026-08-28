import express from "express";
import cors from "cors";
import "dotenv/config";
import type { Server } from "node:http";
import { closeDatabaseConnection, initDatabase } from "./db/index.js";
import { MigrationIntegrityError } from "./db/migrations.js";
import { createSearchRouter } from "./api/search.js";
import { recallRouter } from "./api/recall.js";
import { createIngestRouter } from "./api/ingest.js";
import { healthRouter } from "./api/health.js";
import { reconsolidateRouter } from "./api/reconsolidate.js";
import { proceduralRouter } from "./api/procedural.js";
import { graphRouter } from "./api/graph.js";
import { cognitionRouter } from "./api/cognition.js";
import { vitalsRouter } from "./api/vitals.js";
import { dreamRouter } from "./api/dream.js";
import { createProbeRouter } from "./api/probes.js";
import { createWorkingSetRouter } from "./api/working-set.js";
import { loadMemoryConfig } from "./memory/config.js";
import { createMemoryServices } from "./memory/index.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3100", 10);
const memoryConfig = loadMemoryConfig();
const memoryServices = createMemoryServices({ config: memoryConfig });
let databaseReady = false;
let databaseRetryDelayMs = 1_000;
let httpServer: Server | null = null;
let databaseRetryTimer: NodeJS.Timeout | null = null;
let databaseInitializationInFlight = false;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let requestedExitCode = 0;
let httpListenerFailureReported = false;

const HTTP_DRAIN_TIMEOUT_MS = 10_000;

// Middleware
app.use(cors());
app.use(
  createProbeRouter(memoryServices, {
    isApplicationReady: () => databaseReady && !shuttingDown,
  })
);
app.use((_req, res, next) => {
  if (!databaseReady) {
    res.status(503).json({ status: "not_ready" });
    return;
  }
  next();
});
app.use(express.json({ limit: "10mb" }));

// Routes
app.use("/api/v1/search", createSearchRouter(memoryServices));
app.use("/api/v1/recall", recallRouter);
app.use("/api/v1/ingest", createIngestRouter(memoryServices));
app.use("/api/v1/working-set", createWorkingSetRouter(memoryServices));
app.use("/api/v1/reconsolidate", reconsolidateRouter);
app.use("/api/v1/procedural", proceduralRouter);
app.use("/api/v1/graph", graphRouter);
app.use("/api/v1/cognition", cognitionRouter);
app.use("/api/v1/vitals", vitalsRouter);
app.use("/api/v1/dream", dreamRouter);
app.use("/api/v1", healthRouter);

// Root
app.get("/", (_req, res) => {
  res.json({
    service: "CORTEX V2",
    description: "Synthetic cognition infrastructure for AI agents",
    version: "2.2.0",
    buildId: memoryConfig.buildId,
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
      cognition: "GET /api/v1/cognition?agentId=xxx",
      dream: "POST /api/v1/dream",
    },
  });
});

function recordFailureExitCode(): void {
  requestedExitCode = 1;
  process.exitCode = 1;
}

function reportHttpListenerFailure(): void {
  if (httpListenerFailureReported) return;
  httpListenerFailureReported = true;
  console.error("[cortex] Fatal HTTP listener failure", {
    errorType: "HttpListenerError",
  });
}

async function drainHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      console.error("[cortex] HTTP drain deadline reached; closing connections");
      recordFailureExitCode();
      server.closeAllConnections();
      finish();
    }, HTTP_DRAIN_TIMEOUT_MS);

    try {
      server.close((error?: Error) => {
        if (error) {
          console.error("[cortex] HTTP server close failed");
          recordFailureExitCode();
        }
        finish();
      });
      server.closeIdleConnections();
    } catch {
      console.error("[cortex] HTTP server close failed");
      recordFailureExitCode();
      finish();
    }
  });
}

type CoreShutdownReason =
  | "SIGINT"
  | "SIGTERM"
  | "fatal_schema"
  | "fatal_http";

function requestShutdown(
  reason: CoreShutdownReason,
  exitCode: 0 | 1
): Promise<void> {
  if (exitCode !== 0) recordFailureExitCode();
  if (shutdownPromise) return shutdownPromise;

  shuttingDown = true;
  databaseReady = false;
  if (databaseRetryTimer) {
    clearTimeout(databaseRetryTimer);
    databaseRetryTimer = null;
  }

  shutdownPromise = (async () => {
    const server = httpServer;
    httpServer = null;
    if (server) await drainHttpServer(server);

    try {
      await closeDatabaseConnection();
    } catch {
      console.error("[cortex] Database connection close failed");
      recordFailureExitCode();
    }

    process.exitCode = requestedExitCode;
    console.error("[cortex] Shutdown complete", { reason });
    // A database connection attempt that was already in flight can otherwise
    // retain a socket after the pool closes. Drain and close are complete here.
    process.exit(requestedExitCode);
  })();

  return shutdownPromise;
}

// Bind the probe surface before attempting any dependency work. Application
// routes remain behind the databaseReady gate, while /livez can report the
// process and /readyz can fail closed throughout a slow or failed handshake.
function listenForRequests(): Promise<void> {
  if (httpServer) return Promise.resolve();
  if (shuttingDown) return Promise.reject(new Error("shutdown_in_progress"));

  return new Promise<void>((resolve, reject) => {
    let startupSettled = false;
    const server = app.listen(PORT);
    httpServer = server;

    server.once("listening", () => {
      startupSettled = true;
      console.error(`[cortex] REST probes listening on http://localhost:${PORT}`);
      resolve();
    });
    server.on("error", () => {
      if (!shuttingDown) {
        reportHttpListenerFailure();
        void requestShutdown("fatal_http", 1);
      }
      if (!startupSettled) {
        startupSettled = true;
        reject(new Error("http_listener_failed"));
      }
    });
  });
}

async function failForMigrationIntegrity(error: MigrationIntegrityError): Promise<void> {
  console.error("[cortex] Fatal database/schema initialization failure:", {
    errorType: "MigrationIntegrityError",
    reason: error.reason,
  });

  await requestShutdown("fatal_schema", 1);
}

async function initializeDatabaseUntilReady(): Promise<void> {
  if (shuttingDown || databaseInitializationInFlight) return;
  databaseInitializationInFlight = true;

  try {
    await initDatabase();
    if (shuttingDown) return;
    databaseReady = true;
    databaseRetryDelayMs = 1_000;
    console.error(
      "[cortex] Database schema is ready; application routes enabled"
    );
  } catch (error) {
    if (
      error instanceof MigrationIntegrityError &&
      error.reason !== "unreachable"
    ) {
      await failForMigrationIntegrity(error);
      return;
    }

    if (shuttingDown) return;

    const retryDelayMs = databaseRetryDelayMs;
    databaseRetryDelayMs = Math.min(databaseRetryDelayMs * 2, 30_000);
    const reason =
      error instanceof MigrationIntegrityError && error.reason === "unreachable"
        ? "unreachable"
        : "database_unavailable";
    console.error(
      "[cortex] Database/schema initialization failed; application routes remain unavailable:",
      {
        errorType:
          error instanceof MigrationIntegrityError
            ? "MigrationIntegrityError"
            : "DatabaseInitializationError",
        reason,
        retryDelayMs,
      }
    );
    databaseRetryTimer = setTimeout(() => {
      databaseRetryTimer = null;
      void initializeDatabaseUntilReady();
    }, retryDelayMs);
  } finally {
    databaseInitializationInFlight = false;
  }
}

async function start(): Promise<void> {
  try {
    await listenForRequests();
  } catch {
    if (!shuttingDown) {
      reportHttpListenerFailure();
      await requestShutdown("fatal_http", 1);
    }
    return;
  }

  if (!shuttingDown) await initializeDatabaseUntilReady();
}

process.once("SIGINT", () => {
  void requestShutdown("SIGINT", 0);
});
process.once("SIGTERM", () => {
  void requestShutdown("SIGTERM", 0);
});

void start();

export default app;
