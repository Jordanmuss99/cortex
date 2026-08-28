import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadGatewayConfig,
  loadGatewaySecrets,
  loadStaticClientConfiguration
} from "./config.js";
import { checksumLegacyState, readLegacyState } from "./legacy-state.js";
import { canonicalizeScopes, createOAuthCrypto } from "./oauth-crypto.js";
import { createPostgresOAuthStore } from "./oauth-store.js";
import { createSecurityLogger } from "./security-log.js";
import { loadRequiredMigration, startGatewayV2 } from "./server-v2.js";

export function createLegacyImportInput(snapshot, crypto, requestId = randomUUID()) {
  if (!snapshot || !(snapshot.bytes instanceof Uint8Array) || !snapshot.state) {
    throw new TypeError("Legacy OAuth state snapshot is required");
  }
  return Object.freeze({
    sourceVersion: 1,
    sourceChecksum: checksumLegacyState(snapshot.bytes),
    clients: Object.freeze(snapshot.state.clients.map((client) => Object.freeze({
      clientId: client.client_id,
      redirectUris: Object.freeze([...client.redirect_uris]),
      clientName: client.client_name,
      createdAt: new Date(client.created_at * 1_000)
    }))),
    codes: Object.freeze(snapshot.state.codes.map((code) => Object.freeze({
      codeDigest: crypto.digestAuthorizationCode(code.code),
      clientId: code.client_id,
      redirectUri: code.redirect_uri,
      scopes: Object.freeze(canonicalizeScopes(code.scope)),
      codeChallenge: code.code_challenge,
      resource: code.resource,
      subject: code.sub,
      expiresAt: new Date(code.expires_at)
    }))),
    requestId
  });
}

export async function startGateway({
  env = process.env,
  fetchImpl = fetch,
  logger = createSecurityLogger(() => {}),
  storeFactory = createPostgresOAuthStore,
  runtimeStarter = startGatewayV2,
  host = "0.0.0.0"
} = {}) {
  const config = loadGatewayConfig(env);
  const secrets = loadGatewaySecrets(env);
  const staticClients = loadStaticClientConfiguration(env);
  const requiredMigration = await loadRequiredMigration(env);
  const crypto = createOAuthCrypto(config, secrets);
  if (
    env.MCP_OAUTH_FRESH_INSTALL !== undefined &&
    !new Set(["0", "1"]).has(env.MCP_OAUTH_FRESH_INSTALL)
  ) {
    throw new TypeError("MCP_OAUTH_FRESH_INSTALL must be 0 or 1");
  }
  const freshInstall = env.MCP_OAUTH_FRESH_INSTALL === "1";
  const snapshot = freshInstall
    ? null
    : await readLegacyState(config.legacyStateFile, staticClients.clients);
  const importInput = snapshot === null ? null : createLegacyImportInput(snapshot, crypto);
  const expectedLegacyState = importInput === null
    ? null
    : Object.freeze({
        sourceChecksum: importInput.sourceChecksum,
        clientCount: importInput.clients.length,
        codeCount: importInput.codes.length
      });
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
    ...(expectedLegacyState === null ? { freshInstall: true } : { expectedLegacyState })
  });

  let runtimeStarted = false;
  try {
    if (typeof store.synchronizeStaticClients !== "function") {
      throw new Error("Static OAuth client synchronization is unavailable");
    }
    await store.synchronizeStaticClients(staticClients.clients);
    if (freshInstall) {
      if (typeof store.recordFreshInstall !== "function") {
        throw new Error("Explicit fresh-install initialization is unavailable");
      }
      await store.recordFreshInstall({
        confirmation: "fresh_install",
        requestId: randomUUID()
      });
    } else {
      await store.importLegacyStateOnce(importInput);
    }
    const runtime = await runtimeStarter({
      config,
      secrets,
      requiredMigration,
      expectedLegacyState,
      verifyStaticClientSecret: staticClients.verifyClientSecret,
      fetchImpl,
      host,
      logger,
      storeFactory: () => store
    });
    runtimeStarted = true;
    return runtime;
  } finally {
    if (!runtimeStarted) await store.close().catch(() => {});
  }
}

async function main() {
  const logger = createSecurityLogger((entry) => {
    console.error(JSON.stringify(entry));
  });
  const runtime = await startGateway({ logger });
  let shuttingDown = false;
  const shutdown = () => {
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
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
