import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGatewayApp } from "./app.js";
import {
  createBrowserCredentialVerifier,
  loadGatewayConfig,
  loadGatewaySecrets
} from "./config.js";
import { createOAuthCrypto } from "./oauth-crypto.js";
import { createPostgresOAuthStore } from "./oauth-store.js";
import { createSecurityLogger } from "./security-log.js";

const REQUIRED_MIGRATION_ID = "009_oauth_authority";
export const FROZEN_OAUTH_MIGRATION_SHA256 =
  "e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BOUNDED_COUNT_PATTERN = /^(?:0|[1-9][0-9]{0,3})$/;
const MAX_LEGACY_RECORDS = 1_000;
const DEFAULT_SHUTDOWN_GRACE_MILLISECONDS = 5_000;
const DEFAULT_MAINTENANCE_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_PRUNE_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const DEFAULT_PRUNE_BATCH_SIZE = 1_000;
const DEFAULT_MIGRATION_FILE = new URL(
  "../db/migrations/009_oauth_authority.sql",
  import.meta.url
);
const MEMORY_MIGRATION_ID = "010_memory_lifecycle";
const DEFAULT_MEMORY_MIGRATION_FILE = new URL(
  "../db/migrations/010_memory_lifecycle.sql",
  import.meta.url
);

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server, graceMilliseconds) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolvePromise();
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, graceMilliseconds);
    deadline.unref?.();
    server.close((error) => {
      finish(error);
    });
    server.closeIdleConnections?.();
  });
}

function withDeadline(operation, timeoutMilliseconds, label) {
  let deadline;
  const work = Promise.resolve().then(operation);
  const timeout = new Promise((_resolve, reject) => {
    deadline = setTimeout(() => {
      reject(new Error(`${label} deadline exceeded`));
    }, timeoutMilliseconds);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(deadline));
}

export async function loadRequiredMigration(env = process.env) {
  const configuredPath = env.MCP_OAUTH_MIGRATION_FILE;
  const location = configuredPath
    ? resolve(configuredPath)
    : DEFAULT_MIGRATION_FILE;
  const memoryLocation = env.CORTEX_MEMORY_MIGRATION_FILE
    ? resolve(env.CORTEX_MEMORY_MIGRATION_FILE)
    : DEFAULT_MEMORY_MIGRATION_FILE;
  const [bytes, memoryBytes] = await Promise.all([
    readFile(location),
    readFile(memoryLocation)
  ]);
  const oauthSha256 = createHash("sha256").update(bytes).digest("hex");
  if (oauthSha256 !== FROZEN_OAUTH_MIGRATION_SHA256) {
    throw new Error("OAuth migration 009 does not match its frozen release checksum");
  }
  return Object.freeze({
    id: REQUIRED_MIGRATION_ID,
    sha256: oauthSha256,
    additionalMigrations: Object.freeze([Object.freeze({
      id: MEMORY_MIGRATION_ID,
      sha256: createHash("sha256").update(memoryBytes).digest("hex")
    })])
  });
}

/**
 * Load the checksum and parsed record counts produced by the mandatory
 * pre-start legacy-state orchestration. This carries no source path or raw
 * JSON into the staging server.
 */
export function loadExpectedLegacyState(env = process.env) {
  const checksum = env.MCP_OAUTH_LEGACY_STATE_SHA256;
  const clientCountText = env.MCP_OAUTH_LEGACY_STATE_CLIENT_COUNT;
  const codeCountText = env.MCP_OAUTH_LEGACY_STATE_CODE_COUNT;
  if (
    typeof checksum !== "string" ||
    !SHA256_PATTERN.test(checksum) ||
    typeof clientCountText !== "string" ||
    !BOUNDED_COUNT_PATTERN.test(clientCountText) ||
    typeof codeCountText !== "string" ||
    !BOUNDED_COUNT_PATTERN.test(codeCountText)
  ) {
    throw new TypeError("Legacy OAuth state expectation is invalid");
  }
  const clientCount = Number(clientCountText);
  const codeCount = Number(codeCountText);
  if (clientCount > MAX_LEGACY_RECORDS || codeCount > MAX_LEGACY_RECORDS) {
    throw new TypeError("Legacy OAuth state expectation is invalid");
  }
  return Object.freeze({
    sourceChecksum: new Uint8Array(Buffer.from(checksum, "hex")),
    clientCount,
    codeCount
  });
}

/**
 * Start the temporary database-authority executable used by disposable and
 * staging proofs. It deliberately has no legacy JSON import or fallback.
 */
export async function startGatewayV2({
  config,
  secrets,
  requiredMigration,
  expectedLegacyState,
  verifyStaticClientSecret = () => false,
  fetchImpl = fetch,
  host = "0.0.0.0",
  logger = createSecurityLogger(() => {}),
  storeFactory = createPostgresOAuthStore,
  pruneIntervalMilliseconds = DEFAULT_PRUNE_INTERVAL_MILLISECONDS,
  maintenanceTimeoutMilliseconds = DEFAULT_MAINTENANCE_TIMEOUT_MILLISECONDS,
  shutdownGraceMilliseconds = DEFAULT_SHUTDOWN_GRACE_MILLISECONDS,
  now = () => new Date(),
}) {
  if (!logger || typeof logger.event !== "function") {
    throw new TypeError("logger.event must be a function");
  }
  if (typeof storeFactory !== "function") {
    throw new TypeError("storeFactory must be a function");
  }
  if (!Number.isSafeInteger(pruneIntervalMilliseconds) || pruneIntervalMilliseconds < 1) {
    throw new TypeError("pruneIntervalMilliseconds must be a positive integer");
  }
  if (
    !Number.isSafeInteger(maintenanceTimeoutMilliseconds) ||
    maintenanceTimeoutMilliseconds < 1
  ) {
    throw new TypeError("maintenanceTimeoutMilliseconds must be a positive integer");
  }
  if (!Number.isSafeInteger(shutdownGraceMilliseconds) || shutdownGraceMilliseconds < 1) {
    throw new TypeError("shutdownGraceMilliseconds must be a positive integer");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const crypto = createOAuthCrypto(config, secrets);
  const verifyBrowserCredentials = createBrowserCredentialVerifier(
    config.bootstrapSubject,
    secrets
  );
  const store = storeFactory({
    databaseUrl: config.databaseUrl,
    requiredMigration,
    bootstrap: {
      issuer: config.issuerUrl,
      subject: config.bootstrapSubject,
      agentExternalId: config.bootstrapAgentExternalId
    },
    baseUrl: config.baseUrl,
    resourceUrl: config.resourceUrl,
    acceptLegacyUntil: config.acceptLegacyUntil,
    expectedLegacyState,
    maintenanceTimeoutMilliseconds,
  });

  let server;
  let pruneTimer = null;
  let prunePromise = null;
  let pruningStopped = false;
  const runPrune = () => {
    if (prunePromise) return prunePromise;
    prunePromise = (async () => {
      const report = await store.pruneExpired(now(), DEFAULT_PRUNE_BATCH_SIZE);
      logger.event("gateway_prune", "completed", report);
      return report;
    })().finally(() => {
      prunePromise = null;
    });
    return prunePromise;
  };
  const schedulePrune = () => {
    if (pruningStopped) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      void withDeadline(
        runPrune,
        maintenanceTimeoutMilliseconds,
        "Gateway pruning"
      ).catch(() => {
        logger.event("gateway_prune", "failed");
      }).finally(schedulePrune);
    }, pruneIntervalMilliseconds);
    pruneTimer.unref?.();
  };
  try {
    const readiness = await store.checkReadiness();
    if (readiness?.ready !== true) {
      throw new Error("OAuth database authority is not ready");
    }

    const app = createGatewayApp({
      config,
      crypto,
      verifyBrowserCredentials,
      verifyStaticClientSecret,
      store,
      fetchImpl,
      logger,
      now,
    });
    await withDeadline(
      runPrune,
      maintenanceTimeoutMilliseconds,
      "Gateway pruning"
    );
    server = http.createServer(app);
    await listen(server, config.port, host);
    schedulePrune();
    logger.event("gateway_started", "started");

    let closePromise = null;
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const shutdownDeadline = Date.now() + shutdownGraceMilliseconds;
        const remainingShutdownTime = () =>
          Math.max(1, shutdownDeadline - Date.now());
        pruningStopped = true;
        if (pruneTimer) {
          clearTimeout(pruneTimer);
          pruneTimer = null;
        }
        const failures = [];
        try {
          await closeHttpServer(server, remainingShutdownTime());
        } catch (error) {
          failures.push(error);
        }
        try {
          if (prunePromise) {
            await withDeadline(
              () => prunePromise,
              Math.min(maintenanceTimeoutMilliseconds, remainingShutdownTime()),
              "Gateway pruning"
            );
          }
        } catch (error) {
          failures.push(error);
        }
        try {
          await withDeadline(
            () => store.close(),
            remainingShutdownTime(),
            "Gateway store close"
          );
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Gateway shutdown failed");
        }
        logger.event("gateway_shutdown", "stopped", { reason: "shutdown" });
      })();
      return closePromise;
    };

    return Object.freeze({
      app,
      server,
      store,
      crypto,
      port: server.address().port,
      close
    });
  } catch (error) {
    pruningStopped = true;
    if (pruneTimer) clearTimeout(pruneTimer);
    if (server?.listening) {
      await closeHttpServer(server, shutdownGraceMilliseconds).catch(() => {});
    }
    await withDeadline(
      () => store.close(),
      shutdownGraceMilliseconds,
      "Gateway store close"
    ).catch(() => {});
    throw error;
  }
}

async function main() {
  const config = loadGatewayConfig(process.env);
  const secrets = loadGatewaySecrets(process.env);
  const requiredMigration = await loadRequiredMigration(process.env);
  const expectedLegacyState = loadExpectedLegacyState(process.env);
  const logger = createSecurityLogger((entry) => {
    console.error(JSON.stringify(entry));
  });
  const runtime = await startGatewayV2({
    config,
    secrets,
    requiredMigration,
    expectedLegacyState,
    logger,
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.close().then(
      () => process.exit(0),
      () => {
        logger.event("gateway_shutdown", "failed", { reason: "shutdown" });
        process.exit(1);
      }
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch(() => {
    const logger = createSecurityLogger((entry) => {
      console.error(JSON.stringify(entry));
    });
    logger.event("gateway_shutdown", "failed", { reason: "startup" });
    process.exit(1);
  });
}
