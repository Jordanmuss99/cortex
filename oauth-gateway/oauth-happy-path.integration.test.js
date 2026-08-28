import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import postgres from "postgres";
import { checksumLegacyState, readLegacyState } from "./legacy-state.js";
import { canonicalizeScopes, createOAuthCrypto } from "./oauth-crypto.js";
import {
  createPostgresOAuthStore,
  LEGACY_STATE_IMPORT_VERSION,
  OAuthLegacyStateImportError
} from "./oauth-store.js";
import { startGatewayV2 } from "./server-v2.js";

const MIGRATION_FILE = new URL(
  "../db/migrations/009_oauth_authority.sql",
  import.meta.url
);
const MEMORY_MIGRATION_FILE = new URL(
  "../db/migrations/010_memory_lifecycle.sql",
  import.meta.url
);
const LEGACY_SERVER_FILE = fileURLToPath(new URL("./server-v1.js", import.meta.url));
const JWT_SECRET = "slice-3-disposable-jwt-secret-with-more-than-32-bytes";
const BROWSER_PASSWORD = "slice-3-disposable-password";

async function loadRequiredMigrations() {
  const [migrationBytes, memoryMigrationBytes] = await Promise.all([
    readFile(MIGRATION_FILE),
    readFile(MEMORY_MIGRATION_FILE)
  ]);
  return {
    id: "009_oauth_authority",
    sha256: createHash("sha256").update(migrationBytes).digest("hex"),
    additionalMigrations: [{
      id: "010_memory_lifecycle",
      sha256: createHash("sha256").update(memoryMigrationBytes).digest("hex")
    }]
  };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for the disposable Slice 3 proof`);
  return value;
}

function assertDisposableUrls(ownerDatabaseUrl, gatewayDatabaseUrl) {
  assert.equal(
    requiredEnvironment("MCP_OAUTH_TEST_DISPOSABLE"),
    "1",
    "the disposable OAuth integration guard must be enabled"
  );
  const owner = new URL(ownerDatabaseUrl);
  const gateway = new URL(gatewayDatabaseUrl);
  for (const value of [owner, gateway]) {
    assert.ok(new Set(["postgres:", "postgresql:"]).has(value.protocol));
    assert.equal(value.hostname, "127.0.0.1");
    assert.equal(decodeURIComponent(value.pathname), "/cortex_test");
    assert.equal(value.search, "");
    assert.equal(value.hash, "");
  }
  assert.equal(owner.host, gateway.host);
  assert.equal(owner.pathname, gateway.pathname);
  assert.equal(decodeURIComponent(owner.username), "cortex_test");
  assert.equal(decodeURIComponent(gateway.username), "cortex_oauth_gateway");
}

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(port);
      });
    });
  });
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
    server.closeIdleConnections?.();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill("SIGTERM");
    if (forced) child.kill("SIGKILL");
  });
}

async function startLegacyGateway({
  port,
  statePath,
  baseUrl,
  issuerUrl,
  resourceUrl,
  subject,
  accessTokenTtlSeconds,
  refreshTokenTtlSeconds
}) {
  const child = spawn(process.execPath, [LEGACY_SERVER_FILE], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: baseUrl,
      ISSUER_URL: issuerUrl,
      RESOURCE_URL: resourceUrl,
      MCP_TARGET: "http://127.0.0.1:1",
      REST_TARGET: "http://127.0.0.1:1",
      MCP_OAUTH_USERNAME: subject,
      MCP_OAUTH_PASSWORD: BROWSER_PASSWORD,
      MCP_OAUTH_JWT_SECRET: JWT_SECRET,
      MCP_OAUTH_STATE_FILE: statePath,
      MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: String(accessTokenTtlSeconds),
      MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: String(refreshTokenTtlSeconds),
      MCP_OAUTH_LOGIN_ATTEMPT_LIMIT: "10",
      MCP_OAUTH_REGISTRATION_ATTEMPT_LIMIT: "10"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";

  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Legacy OAuth fixture gateway did not become ready"));
      }, 10_000);
      const onData = (chunk) => {
        stderr += chunk;
        if (stderr.includes(`[oauth-gateway] listening on :${port}`)) {
          cleanup();
          resolvePromise();
        }
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Legacy OAuth fixture gateway exited before readiness"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.stderr.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return Object.freeze({
    child,
    logs: () => stderr,
    close: () => stopChild(child)
  });
}

function form(path, port, values, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers
    },
    body: new URLSearchParams(values),
    redirect: "manual"
  });
}

function protectedHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

async function protectedCalls(port, accessToken) {
  const rest = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: protectedHeaders(accessToken)
  });
  const restBody = await rest.json();

  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...protectedHeaders(accessToken),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cortex_status", arguments: {} }
    })
  });
  const mcpBody = await mcp.json();
  return { rest, restBody, mcp, mcpBody };
}

test("startGatewayV2 rejects invalid migration and markerless authority before binding", async () => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  const secondAgentExternalId = requiredEnvironment("MCP_OAUTH_TEST_SECOND_AGENT_ID");
  assertDisposableUrls(ownerDatabaseUrl, gatewayDatabaseUrl);

  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const exactMigration = await loadRequiredMigrations();
  const markers = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_state_migrations
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
  assert.equal(markers[0].count, 0, "the markerless-start proof requires a clean database");

  const rejectedPort = await availablePort();
  const markerlessPort = await availablePort();
  const probe = net.createServer();
  const markerlessProbe = net.createServer();
  let unexpectedRuntime = null;
  let unexpectedMarkerlessRuntime = null;
  let startupError = null;
  let markerlessStartupError = null;
  try {
    try {
      unexpectedRuntime = await startGatewayV2({
        config: Object.freeze({
          port: rejectedPort,
          baseUrl: issuer,
          issuerUrl: issuer,
          resourceUrl: `${issuer}/mcp`,
          mcpTarget: "http://127.0.0.1:1",
          restTarget: "http://127.0.0.1:1",
          databaseUrl: gatewayDatabaseUrl,
          bootstrapSubject: subject,
          bootstrapAgentExternalId: agentExternalId,
          accessTokenTtlSeconds: 300,
          refreshTokenTtlSeconds: 3600,
          authCodeTtlSeconds: 300,
          loginSessionTtlSeconds: 30 * 24 * 60 * 60,
          acceptLegacyUntil: new Date(Date.now() + 60 * 60 * 1_000)
        }),
        secrets: Object.freeze({
          jwtSecret: JWT_SECRET,
          browserPassword: BROWSER_PASSWORD
        }),
        requiredMigration: {
          id: "009_oauth_authority",
          sha256: "0".repeat(64)
        },
        expectedLegacyState: {
          sourceChecksum: new Uint8Array(32),
          clientCount: 0,
          codeCount: 0
        },
        host: "127.0.0.1"
      });
    } catch (error) {
      startupError = error;
    }

    assert.equal(unexpectedRuntime, null);
    assert.match(startupError?.message ?? "", /database authority is not ready/i);

    // Successfully taking the exact port proves startup rejected before listen.
    await listen(probe, rejectedPort);
    assert.equal(probe.address().port, rejectedPort);

    try {
      unexpectedMarkerlessRuntime = await startGatewayV2({
        config: Object.freeze({
          port: markerlessPort,
          baseUrl: issuer,
          issuerUrl: issuer,
          resourceUrl: `${issuer}/mcp`,
          mcpTarget: "http://127.0.0.1:1",
          restTarget: "http://127.0.0.1:1",
          databaseUrl: gatewayDatabaseUrl,
          bootstrapSubject: subject,
          bootstrapAgentExternalId: agentExternalId,
          accessTokenTtlSeconds: 300,
          refreshTokenTtlSeconds: 3600,
          authCodeTtlSeconds: 300,
          loginSessionTtlSeconds: 30 * 24 * 60 * 60,
          acceptLegacyUntil: new Date(Date.now() + 60 * 60 * 1_000)
        }),
        secrets: Object.freeze({
          jwtSecret: JWT_SECRET,
          browserPassword: BROWSER_PASSWORD
        }),
        requiredMigration: exactMigration,
        expectedLegacyState: {
          sourceChecksum: new Uint8Array(32),
          clientCount: 0,
          codeCount: 0
        },
        host: "127.0.0.1"
      });
    } catch (error) {
      markerlessStartupError = error;
    }
    assert.equal(unexpectedMarkerlessRuntime, null);
    assert.match(markerlessStartupError?.message ?? "", /database authority is not ready/i);
    await listen(markerlessProbe, markerlessPort);
    assert.equal(markerlessProbe.address().port, markerlessPort);
  } finally {
    await closeServer(probe);
    await closeServer(markerlessProbe);
    await unexpectedRuntime?.close();
    await unexpectedMarkerlessRuntime?.close();
    await ownerSql.end({ timeout: 5 });
  }
});

test("frozen v1 authority imports once, exchanges on v2, survives restart, and fails closed", async () => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const compatibilityBaseUrl = `${issuer}/compatibility`;
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  const secondAgentExternalId = requiredEnvironment(
    "MCP_OAUTH_TEST_SECOND_AGENT_ID"
  );
  assertDisposableUrls(ownerDatabaseUrl, gatewayDatabaseUrl);

  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const gatewayPort = await availablePort();
  const restPort = await availablePort();
  const mcpPort = await availablePort();
  const callback = `https://chatgpt.com/connector/oauth/slice3-${randomBytes(6).toString("hex")}`;
  const legacyImportRequestId = `slice4-real-v1-${randomBytes(12).toString("hex")}`;
  const upstreamRequests = [];
  let runtime = null;
  let importStore = null;
  let legacyGateway = null;
  let legacyFixtureDirectory = null;
  let legacyStatePath = null;
  let legacyClientId = null;
  let legacyRawCode = null;
  let legacyLoginCookie = null;
  let legacyLoginExpiresAt = null;
  let upgradedLoginCookie = null;
  let legacyVerifier = null;
  let legacyImportInput = null;
  let legacyStateExpectation = null;
  let frozenStateBytes = null;
  let frozenStateMode = null;
  let compatibilityAccessToken = null;
  let legacyAccessToken = null;
  let legacyRefreshToken = null;
  let legacyHistoricalRefreshToken = null;
  let legacyMigratedAccessToken = null;
  let legacyMigratedRefreshToken = null;
  let concurrentRefreshToken = null;
  let narrowedRefreshToken = null;

  const restServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/readyz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    upstreamRequests.push({ kind: "rest", url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url }));
  });
  const mcpServer = http.createServer((req, res) => {
    if (req.method === "DELETE" && req.url === "/mcp") {
      assert.equal(
        req.headers["mcp-session-id"],
        "integration-readiness-session"
      );
      res.statusCode = 200;
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.method === "POST" &&
        req.url === "/mcp" &&
        message.method === "initialize") {
        res.setHeader("content-type", "application/json");
        res.setHeader("mcp-session-id", "integration-readiness-session");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "cortex-v2", version: "2.4.0" }
          }
        }));
        return;
      }
      if (req.method === "POST" &&
        req.url === "/mcp" &&
        message.method === "notifications/initialized") {
        assert.equal(
          req.headers["mcp-session-id"],
          "integration-readiness-session"
        );
        res.statusCode = 202;
        res.end();
        return;
      }
      if (req.method === "POST" &&
        req.url === "/mcp" &&
        message.method === "ping") {
        assert.equal(
          req.headers["mcp-session-id"],
          "integration-readiness-session"
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {}
        }));
        return;
      }
      upstreamRequests.push({
        kind: "mcp",
        authorization: req.headers.authorization,
        arguments: message.params?.arguments
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { received_arguments: message.params?.arguments }
      }));
    });
  });

  const requiredMigration = await loadRequiredMigrations();
  const config = Object.freeze({
    port: gatewayPort,
    baseUrl: compatibilityBaseUrl,
    issuerUrl: issuer,
    resourceUrl: `${issuer}/mcp`,
    mcpTarget: `http://127.0.0.1:${mcpPort}`,
    restTarget: `http://127.0.0.1:${restPort}`,
    databaseUrl: gatewayDatabaseUrl,
    bootstrapSubject: subject,
    bootstrapAgentExternalId: agentExternalId,
    accessTokenTtlSeconds: 300,
    refreshTokenTtlSeconds: 3600,
    refreshRetryGraceSeconds: 30,
    authCodeTtlSeconds: 300,
    loginSessionTtlSeconds: 30 * 24 * 60 * 60,
    acceptLegacyUntil: new Date(Date.now() + 60 * 60 * 1_000),
    trustedIpHeader: "x-test-client-ip",
    trustedProxyCidrs: ["192.0.2.0/24"],
    // One successful compatibility authorization occurs after the restart;
    // leave two more attempts so the spoofed-header proof fills this bucket.
    loginAttemptLimit: 3,
    loginAttemptWindowSeconds: 60,
    registrationAttemptLimit: 2,
    registrationAttemptWindowSeconds: 60
  });
  const secrets = Object.freeze({
    jwtSecret: JWT_SECRET,
    browserPassword: BROWSER_PASSWORD
  });

  let clientId = null;
  try {
    await listen(restServer, restPort);
    await listen(mcpServer, mcpPort);

    // Produce the migration input with the actual v1 executable rather than a
    // hand-written approximation of its persisted schema.
    legacyFixtureDirectory = await mkdtemp(join(tmpdir(), "cortex-slice4-v1-"));
    legacyStatePath = join(legacyFixtureDirectory, "state.json");
    const legacyPort = await availablePort();
    legacyGateway = await startLegacyGateway({
      port: legacyPort,
      statePath: legacyStatePath,
      baseUrl: config.baseUrl,
      issuerUrl: config.issuerUrl,
      resourceUrl: config.resourceUrl,
      subject,
      accessTokenTtlSeconds: config.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.refreshTokenTtlSeconds
    });

    const legacyRegistrationResponse = await fetch(
      `http://127.0.0.1:${legacyPort}/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [callback],
          client_name: "Slice 4 imported ChatGPT",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"]
        })
      }
    );
    const legacyRegistration = await legacyRegistrationResponse.json();
    assert.equal(legacyRegistrationResponse.status, 201);
    legacyClientId = legacyRegistration.client_id;
    assert.match(legacyClientId, /^chatgpt-[A-Za-z0-9_-]{24}$/);

    legacyVerifier = randomBytes(32).toString("base64url");
    const legacyAuthorization = {
      response_type: "code",
      client_id: legacyClientId,
      redirect_uri: callback,
      scope: "mcp cortex:write cortex:read",
      state: "slice-4-v1-state",
      code_challenge: createHash("sha256")
        .update(legacyVerifier, "ascii")
        .digest("base64url"),
      code_challenge_method: "S256",
      resource: config.resourceUrl
    };
    const legacyAuthorizationResponse = await form(
      "/authorize",
      legacyPort,
      {
        ...legacyAuthorization,
        username: subject,
        password: BROWSER_PASSWORD
      }
    );
    assert.equal(legacyAuthorizationResponse.status, 302);
    const legacySetCookie = legacyAuthorizationResponse.headers.get("set-cookie");
    assert.match(
      legacySetCookie,
      /^__Host-cortex_oauth_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/
    );
    legacyLoginCookie = legacySetCookie.split(";", 1)[0];
    const legacyLoginRaw = legacyLoginCookie.slice(
      legacyLoginCookie.indexOf("=") + 1
    );
    const [legacyLoginPayload] = legacyLoginRaw.split(".");
    const legacyLoginClaims = JSON.parse(
      Buffer.from(legacyLoginPayload, "base64url").toString("utf8")
    );
    legacyLoginExpiresAt = new Date(legacyLoginClaims.expires_at * 1_000);
    assert.equal(
      legacyLoginClaims.expires_at - legacyLoginClaims.issued_at,
      config.loginSessionTtlSeconds
    );
    const legacyRedirect = new URL(
      legacyAuthorizationResponse.headers.get("location")
    );
    legacyRawCode = legacyRedirect.searchParams.get("code");
    assert.match(legacyRawCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(legacyRedirect.searchParams.get("state"), "slice-4-v1-state");

    // Mint a real sid-less pair with the unchanged v1 executable while
    // leaving the first code outstanding for the immutable import proof.
    const legacyTokenVerifier = randomBytes(32).toString("base64url");
    const legacyTokenAuthorization = new URLSearchParams({
      ...legacyAuthorization,
      state: "slice-9-v1-token",
      code_challenge: createHash("sha256")
        .update(legacyTokenVerifier, "ascii")
        .digest("base64url")
    });
    const legacyTokenAuthorizationResponse = await fetch(
      `http://127.0.0.1:${legacyPort}/authorize?${legacyTokenAuthorization}`,
      { headers: { cookie: legacyLoginCookie }, redirect: "manual" }
    );
    assert.equal(legacyTokenAuthorizationResponse.status, 302);
    const legacyTokenCode = new URL(
      legacyTokenAuthorizationResponse.headers.get("location")
    ).searchParams.get("code");
    const legacyTokenResponse = await form("/token", legacyPort, {
      grant_type: "authorization_code",
      code: legacyTokenCode,
      redirect_uri: callback,
      client_id: legacyClientId,
      code_verifier: legacyTokenVerifier
    });
    const legacyTokens = await legacyTokenResponse.json();
    assert.equal(legacyTokenResponse.status, 200);
    legacyAccessToken = legacyTokens.access_token;
    legacyRefreshToken = legacyTokens.refresh_token;

    // v1 permitted scope narrowing and issued a distinct JTI. Keep that
    // authentic historical token to prove scope cannot split the family.
    const legacyNarrowedResponse = await form("/token", legacyPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId,
      scope: "mcp cortex:read"
    });
    const legacyNarrowed = await legacyNarrowedResponse.json();
    assert.equal(legacyNarrowedResponse.status, 200);
    legacyHistoricalRefreshToken = legacyNarrowed.refresh_token;
    assert.notEqual(legacyHistoricalRefreshToken, legacyRefreshToken);

    await legacyGateway.close();
    const frozenFileBefore = await stat(legacyStatePath);
    assert.equal(frozenFileBefore.mode & 0o7777, 0o600);
    const frozenState = await readLegacyState(legacyStatePath);
    frozenStateBytes = Buffer.from(frozenState.bytes);
    frozenStateMode = frozenFileBefore.mode & 0o7777;
    assert.equal(frozenState.state.clients.length, 1);
    assert.equal(frozenState.state.codes.length, 1);
    assert.equal(frozenState.state.clients[0].client_id, legacyClientId);
    assert.equal(frozenState.state.codes[0].code, legacyRawCode);

    const importCrypto = createOAuthCrypto(config, secrets);
    legacyImportInput = {
      sourceVersion: 1,
      sourceChecksum: checksumLegacyState(frozenState.bytes),
      clients: frozenState.state.clients.map((client) => ({
        clientId: client.client_id,
        redirectUris: client.redirect_uris,
        clientName: client.client_name,
        createdAt: new Date(client.created_at * 1_000)
      })),
      codes: frozenState.state.codes.map((code) => ({
        codeDigest: importCrypto.digestAuthorizationCode(code.code),
        clientId: code.client_id,
        redirectUri: code.redirect_uri,
        scopes: canonicalizeScopes(code.scope),
        codeChallenge: code.code_challenge,
        resource: code.resource,
        subject: code.sub,
        expiresAt: new Date(code.expires_at)
      })),
      requestId: legacyImportRequestId
    };
    legacyStateExpectation = {
      sourceChecksum: legacyImportInput.sourceChecksum,
      clientCount: frozenState.state.clients.length,
      codeCount: frozenState.state.codes.length
    };
    importStore = createPostgresOAuthStore({
      databaseUrl: gatewayDatabaseUrl,
      requiredMigration,
      bootstrap: {
        issuer: config.issuerUrl,
        subject,
        agentExternalId
      },
      baseUrl: config.baseUrl,
      resourceUrl: config.resourceUrl,
      acceptLegacyUntil: config.acceptLegacyUntil,
      expectedLegacyState: legacyStateExpectation
    });
    const imported = await importStore.importLegacyStateOnce(legacyImportInput);
    assert.deepEqual(imported, {
      kind: "imported",
      version: LEGACY_STATE_IMPORT_VERSION,
      report: {
        clientsImported: 1,
        clientsExisting: 0,
        codesImported: 1,
        codesExpired: 0
      }
    });
    assert.equal(
      imported.report.clientsImported + imported.report.clientsExisting,
      frozenState.state.clients.length
    );
    assert.equal(
      imported.report.codesImported + imported.report.codesExpired,
      frozenState.state.codes.length
    );
    await importStore.close();
    importStore = null;
    assert.deepEqual(await readFile(legacyStatePath), frozenStateBytes);
    assert.equal((await stat(legacyStatePath)).mode & 0o7777, frozenStateMode);
    assert.equal(legacyGateway.logs().includes(legacyRawCode), false);

    runtime = await startGatewayV2({
      config,
      secrets,
      requiredMigration,
      expectedLegacyState: legacyStateExpectation,
      host: "127.0.0.1"
    });

    const importedReady = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
    assert.equal(importedReady.status, 200);
    assert.deepEqual(await importedReady.json(), { status: "ok" });

    const verifiedLegacyAccess = await runtime.crypto.verifyAccessToken(
      legacyAccessToken
    );
    const verifiedLegacyRefresh = await runtime.crypto.verifyRefreshToken(
      legacyRefreshToken
    );
    assert.equal(verifiedLegacyAccess.legacy, true);
    assert.equal(verifiedLegacyRefresh.legacy, true);
    assert.equal(Object.hasOwn(verifiedLegacyAccess, "sid"), false);
    assert.match(verifiedLegacyRefresh.jti, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(verifiedLegacyRefresh.scope, "cortex:read cortex:write mcp");

    await ownerSql`
      UPDATE public.oauth_principals
      SET legacy_not_before = pg_catalog.to_timestamp(${verifiedLegacyRefresh.iat + 1})
      WHERE issuer = ${config.issuerUrl}
        AND subject = ${subject}
    `;
    const beforeLegacyEpochCalls = upstreamRequests.length;
    const legacyEpochCalls = await protectedCalls(gatewayPort, legacyAccessToken);
    assert.equal(legacyEpochCalls.rest.status, 401);
    assert.equal(legacyEpochCalls.mcp.status, 401);
    const legacyEpochRefresh = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId
    });
    assert.equal(legacyEpochRefresh.status, 400);
    assert.deepEqual(await legacyEpochRefresh.json(), { error: "invalid_grant" });
    assert.equal(upstreamRequests.length, beforeLegacyEpochCalls);
    await ownerSql`
      UPDATE public.oauth_principals
      SET legacy_not_before = 'epoch'::timestamptz
      WHERE issuer = ${config.issuerUrl}
        AND subject = ${subject}
    `;

    const legacyAccessCalls = await protectedCalls(gatewayPort, legacyAccessToken);
    assert.equal(legacyAccessCalls.rest.status, 200);
    assert.equal(legacyAccessCalls.mcp.status, 200);
    assert.equal(
      legacyAccessCalls.mcpBody.result.received_arguments.agent_id,
      agentExternalId
    );

    // The compatibility family is issuer/subject/client/resource. A v2 family
    // on a different (older, non-default) binding must still prevent a stale
    // sid-less token from creating a second family.
    const historicalBindingId = randomUUID();
    const preexistingV2GrantId = randomUUID();
    await ownerSql`
      INSERT INTO public.oauth_agent_bindings (
        id,
        principal_id,
        agent_id,
        status,
        is_default,
        binding_version,
        allowed_scopes,
        created_at,
        updated_at
      )
      SELECT
        ${historicalBindingId},
        principal.id,
        agent.id,
        'active',
        FALSE,
        1,
        ${ownerSql.array(["cortex:read", "cortex:write", "mcp"])}::public.oauth_scope[],
        CURRENT_TIMESTAMP - INTERVAL '1 day',
        CURRENT_TIMESTAMP - INTERVAL '1 day'
      FROM public.oauth_principals AS principal
      CROSS JOIN public.agents AS agent
      WHERE principal.issuer = ${config.issuerUrl}
        AND principal.subject = ${subject}
        AND agent.external_id = ${secondAgentExternalId}
    `;
    await ownerSql`
      INSERT INTO public.oauth_grants (
        id,
        principal_id,
        binding_id,
        oauth_client_id,
        resource,
        scopes,
        authentication_epoch,
        binding_version,
        status,
        current_refresh_generation,
        inactivity_expires_at
      )
      SELECT
        ${preexistingV2GrantId},
        principal.id,
        ${historicalBindingId},
        client.id,
        ${config.resourceUrl},
        ${ownerSql.array(["cortex:read", "cortex:write", "mcp"])}::public.oauth_scope[],
        principal.authentication_epoch,
        1,
        'active',
        0,
        CURRENT_TIMESTAMP + INTERVAL '1 hour'
      FROM public.oauth_principals AS principal
      CROSS JOIN public.oauth_clients AS client
      WHERE principal.issuer = ${config.issuerUrl}
        AND principal.subject = ${subject}
        AND client.client_id = ${legacyClientId}
    `;
    const refusedLegacyTakeover = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId
    });
    assert.equal(refusedLegacyTakeover.status, 400);
    assert.deepEqual(await refusedLegacyTakeover.json(), { error: "invalid_grant" });
    const preservedV2Grant = await ownerSql`
      SELECT status, legacy_tuple_digest
      FROM public.oauth_grants
      WHERE id = ${preexistingV2GrantId}
    `;
    assert.deepEqual([...preservedV2Grant], [{
      status: "active",
      legacy_tuple_digest: null
    }]);
    await ownerSql`
      DELETE FROM public.oauth_grants
      WHERE id = ${preexistingV2GrantId}
    `;
    await ownerSql`
      DELETE FROM public.oauth_agent_bindings
      WHERE id = ${historicalBindingId}
    `;

    await ownerSql.unsafe(`
      CREATE FUNCTION public.slice9_fail_legacy_upgrade_audit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.event_type = 'legacy_refresh_upgrade' THEN
          RAISE EXCEPTION 'injected Slice 9 legacy audit failure';
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER slice9_fail_legacy_upgrade_audit
      BEFORE INSERT ON public.oauth_audit_events
      FOR EACH ROW
      EXECUTE FUNCTION public.slice9_fail_legacy_upgrade_audit();
    `);
    try {
      const failedLegacyUpgrade = await form("/token", gatewayPort, {
        grant_type: "refresh_token",
        refresh_token: legacyRefreshToken,
        client_id: legacyClientId
      });
      assert.equal(failedLegacyUpgrade.status, 503);
      assert.equal(failedLegacyUpgrade.headers.get("www-authenticate"), null);
      assert.deepEqual(await failedLegacyUpgrade.json(), {
        error: "temporarily_unavailable"
      });
      const rolledBackLegacyRows = await ownerSql`
        SELECT pg_catalog.count(*)::integer AS count
        FROM public.oauth_grants
        WHERE legacy_tuple_digest IS NOT NULL
      `;
      assert.equal(rolledBackLegacyRows[0].count, 0);
    } finally {
      await ownerSql.unsafe(`
        DROP TRIGGER IF EXISTS slice9_fail_legacy_upgrade_audit
          ON public.oauth_audit_events;
        DROP FUNCTION IF EXISTS public.slice9_fail_legacy_upgrade_audit();
      `);
    }

    const legacyTokenUpgradeResponses = await Promise.all([0, 1].map(() =>
      form("/token", gatewayPort, {
        grant_type: "refresh_token",
        refresh_token: legacyRefreshToken,
        client_id: legacyClientId
      })
    ));
    const legacyTokenUpgradeBodies = await Promise.all(
      legacyTokenUpgradeResponses.map((response) => response.json())
    );
    assert.deepEqual(
      legacyTokenUpgradeResponses.map((response) => response.status),
      [200, 200]
    );
    assert.equal(
      legacyTokenUpgradeBodies[0].refresh_token,
      legacyTokenUpgradeBodies[1].refresh_token,
      "concurrent first legacy refreshes must converge on persisted generation zero"
    );
    legacyMigratedAccessToken = legacyTokenUpgradeBodies[0].access_token;
    legacyMigratedRefreshToken = legacyTokenUpgradeBodies[0].refresh_token;
    const migratedAccessClaims = await runtime.crypto.verifyAccessToken(
      legacyMigratedAccessToken
    );
    const migratedRefreshClaims = await runtime.crypto.verifyRefreshToken(
      legacyMigratedRefreshToken
    );
    assert.equal(migratedAccessClaims.legacy, false);
    assert.equal(migratedRefreshClaims.legacy, false);
    assert.equal(migratedRefreshClaims.generation, 0);
    assert.equal(migratedAccessClaims.sid, migratedRefreshClaims.sid);
    assert.equal(migratedAccessClaims.agent_id, agentExternalId);

    const legacyMigrationRows = await ownerSql`
      SELECT
        grant_row.id AS sid,
        grant_row.status,
        grant_row.current_refresh_generation,
        pg_catalog.octet_length(grant_row.legacy_tuple_digest) AS tuple_digest_length,
        refresh.generation,
        refresh.kind,
        refresh.effective_scopes::text[] AS effective_scopes,
        refresh.consumed_at,
        refresh.replacement_generation,
        refresh.retry_deadline,
        refresh.request_fingerprint,
        refresh.reconstruction_nonce,
        pg_catalog.octet_length(refresh.jti_digest) AS jti_digest_length
      FROM public.oauth_grants AS grant_row
      INNER JOIN public.oauth_clients AS client ON client.id = grant_row.oauth_client_id
      INNER JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
      WHERE client.client_id = ${legacyClientId}
        AND grant_row.legacy_tuple_digest IS NOT NULL
      ORDER BY refresh.generation
    `;
    assert.deepEqual(
      legacyMigrationRows.map((row) => [row.generation, row.kind]),
      [[-1, "legacy"], [0, "v2"]]
    );
    assert.equal(legacyMigrationRows[0].sid, migratedRefreshClaims.sid);
    assert.equal(legacyMigrationRows[0].status, "active");
    assert.equal(legacyMigrationRows[0].current_refresh_generation, 0);
    assert.equal(legacyMigrationRows[0].tuple_digest_length, 32);
    assert.equal(legacyMigrationRows[0].consumed_at instanceof Date, true);
    assert.equal(legacyMigrationRows[0].replacement_generation, 0);
    assert.equal(legacyMigrationRows[0].retry_deadline instanceof Date, true);
    assert.equal(Buffer.from(legacyMigrationRows[0].request_fingerprint).byteLength, 32);
    assert.equal(legacyMigrationRows[0].reconstruction_nonce, null);
    assert.equal(legacyMigrationRows[0].jti_digest_length, 32);
    assert.deepEqual(
      legacyMigrationRows[0].effective_scopes,
      ["cortex:read", "cortex:write", "mcp"]
    );
    assert.equal(
      Buffer.from(legacyMigrationRows[1].reconstruction_nonce).byteLength,
      32
    );

    await runtime.close();
    runtime = await startGatewayV2({
      config,
      secrets,
      requiredMigration,
      expectedLegacyState: legacyStateExpectation,
      host: "127.0.0.1"
    });
    const legacyRestartRetry = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId
    });
    const legacyRestartRetryBody = await legacyRestartRetry.json();
    assert.equal(legacyRestartRetry.status, 200);
    assert.equal(
      legacyRestartRetryBody.refresh_token,
      legacyMigratedRefreshToken,
      "legacy retry must reconstruct generation zero after restart"
    );

    await ownerSql.unsafe(`
      CREATE FUNCTION public.slice9_fail_changed_legacy_retry_audit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.event_type = 'refresh_replay'
          AND NEW.metadata ->> 'reason' = 'legacy_request_fingerprint_mismatch'
        THEN
          RAISE EXCEPTION 'injected Slice 9 changed legacy retry audit failure';
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER slice9_fail_changed_legacy_retry_audit
      BEFORE INSERT ON public.oauth_audit_events
      FOR EACH ROW
      EXECUTE FUNCTION public.slice9_fail_changed_legacy_retry_audit();
    `);
    try {
      const failedChangedLegacyRetry = await form("/token", gatewayPort, {
        grant_type: "refresh_token",
        refresh_token: legacyRefreshToken,
        client_id: legacyClientId,
        resource: config.baseUrl
      });
      assert.equal(failedChangedLegacyRetry.status, 503);
      assert.deepEqual(await failedChangedLegacyRetry.json(), {
        error: "temporarily_unavailable"
      });
      const rolledBackChangedRetry = await ownerSql`
        SELECT status
        FROM public.oauth_grants
        WHERE id = ${migratedRefreshClaims.sid}
      `;
      assert.deepEqual([...rolledBackChangedRetry], [{ status: "active" }]);
    } finally {
      await ownerSql.unsafe(`
        DROP TRIGGER IF EXISTS slice9_fail_changed_legacy_retry_audit
          ON public.oauth_audit_events;
        DROP FUNCTION IF EXISTS public.slice9_fail_changed_legacy_retry_audit();
      `);
    }

    const migratedCalls = await protectedCalls(
      gatewayPort,
      legacyMigratedAccessToken
    );
    assert.equal(migratedCalls.rest.status, 200);
    assert.equal(migratedCalls.mcp.status, 200);
    await ownerSql.unsafe(`
      CREATE FUNCTION public.slice9_fail_legacy_replay_audit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.event_type = 'refresh_replay'
          AND NEW.metadata ->> 'reason' = 'legacy_historical_jti'
        THEN
          RAISE EXCEPTION 'injected Slice 9 legacy replay audit failure';
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER slice9_fail_legacy_replay_audit
      BEFORE INSERT ON public.oauth_audit_events
      FOR EACH ROW
      EXECUTE FUNCTION public.slice9_fail_legacy_replay_audit();
    `);
    try {
      const failedHistoricalReplay = await form("/token", gatewayPort, {
        grant_type: "refresh_token",
        refresh_token: legacyHistoricalRefreshToken,
        client_id: legacyClientId
      });
      assert.equal(failedHistoricalReplay.status, 503);
      assert.deepEqual(await failedHistoricalReplay.json(), {
        error: "temporarily_unavailable"
      });
      const rolledBackReplay = await ownerSql`
        SELECT status
        FROM public.oauth_grants
        WHERE id = ${migratedRefreshClaims.sid}
      `;
      assert.deepEqual([...rolledBackReplay], [{ status: "active" }]);
    } finally {
      await ownerSql.unsafe(`
        DROP TRIGGER IF EXISTS slice9_fail_legacy_replay_audit
          ON public.oauth_audit_events;
        DROP FUNCTION IF EXISTS public.slice9_fail_legacy_replay_audit();
      `);
    }
    const beforeHistoricalReplay = upstreamRequests.length;
    const historicalReplay = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyHistoricalRefreshToken,
      client_id: legacyClientId
    });
    assert.equal(historicalReplay.status, 400);
    assert.deepEqual(await historicalReplay.json(), { error: "invalid_grant" });
    const replayBlockedCalls = await protectedCalls(
      gatewayPort,
      legacyMigratedAccessToken
    );
    assert.equal(replayBlockedCalls.rest.status, 401);
    assert.equal(replayBlockedCalls.mcp.status, 401);
    assert.equal(upstreamRequests.length, beforeHistoricalReplay);

    const importedTokenResponse = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code: legacyRawCode,
      redirect_uri: callback,
      client_id: legacyClientId,
      code_verifier: legacyVerifier
    });
    const importedTokens = await importedTokenResponse.json();
    assert.equal(importedTokenResponse.status, 200);
    const importedAccessClaims = await runtime.crypto.verifyAccessToken(
      importedTokens.access_token
    );
    assert.equal(importedAccessClaims.client_id, legacyClientId);
    assert.equal(importedAccessClaims.agent_id, agentExternalId);
    const legacyRevocationReference = await form("/revoke", gatewayPort, {
      client_id: legacyClientId,
      token: legacyAccessToken,
      token_type_hint: "access_token"
    });
    assert.equal(legacyRevocationReference.status, 200);
    assert.equal(await legacyRevocationReference.text(), "");
    const terminalLegacyRetry = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId
    });
    assert.equal(terminalLegacyRetry.status, 400);
    assert.deepEqual(await terminalLegacyRetry.json(), { error: "invalid_grant" });
    const importedLegacyClientCalls = await protectedCalls(
      gatewayPort,
      importedTokens.access_token
    );
    assert.equal(importedLegacyClientCalls.rest.status, 200);
    assert.equal(importedLegacyClientCalls.mcp.status, 200);
    const legacyTombstoneRows = await ownerSql`
      SELECT
        pg_catalog.count(*) FILTER (
          WHERE grant_row.legacy_tuple_digest IS NOT NULL
            AND grant_row.status = 'revoked'
        )::integer AS terminal_legacy_count,
        pg_catalog.count(*) FILTER (
          WHERE grant_row.legacy_tuple_digest IS NULL
            AND grant_row.status = 'active'
        )::integer AS active_v2_count
      FROM public.oauth_grants AS grant_row
      INNER JOIN public.oauth_clients AS client ON client.id = grant_row.oauth_client_id
      WHERE client.client_id = ${legacyClientId}
    `;
    assert.deepEqual(legacyTombstoneRows[0], {
      terminal_legacy_count: 1,
      active_v2_count: 1
    });

    await runtime.close();
    runtime = await startGatewayV2({
      config: Object.freeze({
        ...config,
        acceptLegacyUntil: new Date(Date.now() - 1_000)
      }),
      secrets,
      requiredMigration,
      expectedLegacyState: legacyStateExpectation,
      host: "127.0.0.1"
    });
    const cutoffLegacyCalls = await protectedCalls(gatewayPort, legacyAccessToken);
    assert.equal(cutoffLegacyCalls.rest.status, 401);
    assert.equal(cutoffLegacyCalls.mcp.status, 401);
    const cutoffLegacyRefresh = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId
    });
    assert.equal(cutoffLegacyRefresh.status, 400);
    assert.deepEqual(await cutoffLegacyRefresh.json(), { error: "invalid_grant" });
    const v2AfterCutoff = await protectedCalls(
      gatewayPort,
      importedTokens.access_token
    );
    assert.equal(v2AfterCutoff.rest.status, 200);
    assert.equal(v2AfterCutoff.mcp.status, 200);
    await runtime.close();
    runtime = await startGatewayV2({
      config,
      secrets,
      requiredMigration,
      expectedLegacyState: legacyStateExpectation,
      host: "127.0.0.1"
    });
    const importedPersistence = await ownerSql`
      SELECT
        code.code_digest,
        marker.source_checksum,
        marker.report,
        audit.metadata
      FROM public.oauth_authorization_codes AS code
      INNER JOIN public.oauth_clients AS client ON client.id = code.oauth_client_id
      CROSS JOIN public.oauth_state_migrations AS marker
      INNER JOIN public.oauth_audit_events AS audit
        ON audit.request_id = ${legacyImportRequestId}
      WHERE client.client_id = ${legacyClientId}
        AND marker.version = ${LEGACY_STATE_IMPORT_VERSION}
    `;
    assert.equal(importedPersistence.length, 1);
    assert.deepEqual(
      Buffer.from(importedPersistence[0].code_digest),
      Buffer.from(legacyImportInput.codes[0].codeDigest)
    );
    const redactedPersistence = JSON.stringify(importedPersistence);
    for (const canary of [legacyRawCode, BROWSER_PASSWORD, JWT_SECRET]) {
      assert.equal(redactedPersistence.includes(canary), false);
      assert.equal(legacyGateway.logs().includes(canary), false);
    }
    const persistedCanaries = [
      legacyRawCode,
      legacyAccessToken,
      legacyRefreshToken,
      legacyHistoricalRefreshToken,
      verifiedLegacyRefresh.jti,
      legacyMigratedAccessToken,
      legacyMigratedRefreshToken,
      importedTokens.access_token,
      importedTokens.refresh_token,
      BROWSER_PASSWORD,
      JWT_SECRET
    ];
    const oauthLeakScan = await ownerSql`
      SELECT pg_catalog.count(*)::integer AS count
      FROM (
        SELECT pg_catalog.row_to_json(record)::text AS payload
        FROM public.oauth_principals AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_agent_bindings AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_clients AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_authorization_codes AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_grants AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_refresh_tokens AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_login_sessions AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_audit_events AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_state_migrations AS record
      ) AS oauth_rows
      CROSS JOIN pg_catalog.unnest(${ownerSql.array(persistedCanaries)}::text[]) AS canary(value)
      WHERE pg_catalog.strpos(oauth_rows.payload, canary.value) > 0
    `;
    assert.equal(oauthLeakScan[0].count, 0);

    const alteredBytes = Buffer.concat([frozenStateBytes, Buffer.from(" ")]);
    await assert.rejects(
      runtime.store.importLegacyStateOnce({
        ...legacyImportInput,
        sourceChecksum: checksumLegacyState(alteredBytes),
        requestId: `${legacyImportRequestId}-altered`
      }),
      (error) => error instanceof OAuthLegacyStateImportError &&
        error.code === "checksum_mismatch"
    );
    const alteredCandidatePort = await availablePort();
    const alteredCandidateProbe = net.createServer();
    let alteredCandidateRuntime = null;
    let alteredCandidateError = null;
    try {
      try {
        alteredCandidateRuntime = await startGatewayV2({
          config: Object.freeze({ ...config, port: alteredCandidatePort }),
          secrets,
          requiredMigration,
          expectedLegacyState: {
            ...legacyStateExpectation,
            sourceChecksum: checksumLegacyState(alteredBytes)
          },
          host: "127.0.0.1"
        });
      } catch (error) {
        alteredCandidateError = error;
      }
      assert.equal(alteredCandidateRuntime, null);
      assert.match(
        alteredCandidateError?.message ?? "",
        /database authority is not ready/i
      );
      await listen(alteredCandidateProbe, alteredCandidatePort);
    } finally {
      await alteredCandidateRuntime?.close();
      await closeServer(alteredCandidateProbe);
    }

    // Present the exact cookie minted by the unchanged v1 executable twice.
    // The unique legacy-cookie digest permits one upgrade and one safe loser.
    const legacyUpgradeRequests = [0, 1].map((index) => {
      const verifier = randomBytes(32).toString("base64url");
      const query = new URLSearchParams({
        ...legacyAuthorization,
        state: `slice-5-v1-upgrade-${index}`,
        code_challenge: runtime.crypto.createPkceChallenge(verifier)
      });
      return fetch(`http://127.0.0.1:${gatewayPort}/authorize?${query}`, {
        headers: { cookie: legacyLoginCookie },
        redirect: "manual"
      });
    });
    const legacyUpgradeResponses = await Promise.all(legacyUpgradeRequests);
    assert.deepEqual(
      legacyUpgradeResponses.map((response) => response.status).sort(),
      [200, 302]
    );
    const upgradeWinner = legacyUpgradeResponses.find(
      (response) => response.status === 302
    );
    const upgradeLoser = legacyUpgradeResponses.find(
      (response) => response.status === 200
    );
    const upgradedSetCookie = upgradeWinner.headers.get("set-cookie");
    assert.match(
      upgradedSetCookie,
      /^__Host-cortex_oauth_session=[A-Za-z0-9_-]{43};/
    );
    assert.match(upgradedSetCookie, /; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal(upgradeLoser.headers.get("set-cookie"), null);
    upgradedLoginCookie = upgradedSetCookie.split(";", 1)[0];

    const legacyDescriptor = await runtime.crypto.verifyLegacyLoginCookie(
      legacyLoginCookie.slice(legacyLoginCookie.indexOf("=") + 1),
      "127.0.0.1"
    );
    assert.ok(legacyDescriptor);
    const upgradedPersistence = await ownerSql`
      SELECT issued_at, expires_at
      FROM public.oauth_login_sessions
      WHERE legacy_cookie_digest = ${legacyDescriptor.legacyCookieDigest}
    `;
    assert.equal(upgradedPersistence.length, 1);
    assert.equal(
      upgradedPersistence[0].expires_at.getTime(),
      legacyLoginExpiresAt.getTime(),
      "the v1 upgrade must not extend the verified source lifetime"
    );

    const changedCookie = `${upgradedLoginCookie.slice(0, -1)}${
      upgradedLoginCookie.endsWith("A") ? "B" : "A"
    }`;
    const changedCookieResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/authorize?${new URLSearchParams({
        ...legacyAuthorization,
        state: "slice-5-changed-cookie",
        code_challenge: runtime.crypto.createPkceChallenge(
          randomBytes(32).toString("base64url")
        )
      })}`,
      { headers: { cookie: changedCookie }, redirect: "manual" }
    );
    assert.equal(changedCookieResponse.status, 200);
    assert.match(
      changedCookieResponse.headers.get("set-cookie"),
      /^__Host-cortex_oauth_session=; Max-Age=0;/
    );

    const sessionLeakCanaries = [legacyLoginCookie, upgradedLoginCookie].map(
      (cookiePair) => cookiePair.slice(cookiePair.indexOf("=") + 1)
    );
    const sessionLeakScan = await ownerSql`
      SELECT pg_catalog.count(*)::integer AS count
      FROM (
        SELECT pg_catalog.row_to_json(record)::text AS payload
        FROM public.oauth_login_sessions AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_audit_events AS record
      ) AS oauth_rows
      CROSS JOIN pg_catalog.unnest(${ownerSql.array(sessionLeakCanaries)}::text[])
        AS canary(value)
      WHERE pg_catalog.strpos(oauth_rows.payload, canary.value) > 0
    `;
    assert.equal(sessionLeakScan[0].count, 0);

    const registrationResponse = await fetch(`http://127.0.0.1:${gatewayPort}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [callback],
        client_name: "Slice 3 disposable ChatGPT",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      })
    });
    const registration = await registrationResponse.json();
    assert.equal(registrationResponse.status, 201);
    clientId = registration.client_id;
    assert.match(clientId, /^chatgpt-[A-Za-z0-9_-]{24}$/);
    assert.deepEqual(registration.redirect_uris, [callback]);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = runtime.crypto.createPkceChallenge(verifier);
    const authorization = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback,
      scope: "cortex:read cortex:write mcp",
      state: "slice-3-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: config.resourceUrl
    };
    const loginPage = await fetch(
      `http://127.0.0.1:${gatewayPort}/authorize?${new URLSearchParams(authorization)}`
    );
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /Cortex Login/);

    const authorizationResponse = await form("/authorize", gatewayPort, {
      ...authorization,
      username: subject,
      password: BROWSER_PASSWORD
    });
    assert.equal(authorizationResponse.status, 302);
    const redirect = new URL(authorizationResponse.headers.get("location"));
    const code = redirect.searchParams.get("code");
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(redirect.searchParams.get("state"), "slice-3-state");

    const rejectedBasicCodeExchange = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: verifier
    }, { authorization: "Basic Zm9vOmJhcg==" });
    assert.equal(rejectedBasicCodeExchange.status, 401);
    assert.equal(
      rejectedBasicCodeExchange.headers.get("www-authenticate"),
      'Basic realm="cortex-oauth"'
    );
    assert.deepEqual(await rejectedBasicCodeExchange.json(), {
      error: "invalid_client"
    });
    const rejectedSecretCodeExchange = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: verifier,
      client_secret: "unsupported-secret"
    });
    assert.equal(rejectedSecretCodeExchange.status, 400);
    assert.deepEqual(await rejectedSecretCodeExchange.json(), {
      error: "invalid_client"
    });

    const tokenResponse = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: verifier
    });
    const tokens = await tokenResponse.json();
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);

    const accessClaims = await runtime.crypto.verifyAccessToken(tokens.access_token);
    const refreshClaims = await runtime.crypto.verifyRefreshToken(tokens.refresh_token);
    assert.equal(accessClaims.sid, refreshClaims.sid);
    assert.equal(accessClaims.agent_id, agentExternalId);
    assert.equal(refreshClaims.agent_id, agentExternalId);
    assert.equal(refreshClaims.generation, 0);
    assert.equal(accessClaims.client_id, clientId);
    assert.equal(accessClaims.aud, config.resourceUrl);

    const persisted = await ownerSql`
      SELECT
        code.consumed_at,
        grant_row.id AS sid,
        refresh.generation,
        pg_catalog.octet_length(code.code_digest) AS code_digest_length,
        pg_catalog.octet_length(refresh.jti_digest) AS jti_digest_length,
        pg_catalog.octet_length(refresh.reconstruction_nonce) AS nonce_length
      FROM public.oauth_clients AS client
      INNER JOIN public.oauth_authorization_codes AS code
        ON code.oauth_client_id = client.id
      INNER JOIN public.oauth_grants AS grant_row
        ON grant_row.oauth_client_id = client.id
      INNER JOIN public.oauth_refresh_tokens AS refresh
        ON refresh.grant_id = grant_row.id
      WHERE client.client_id = ${clientId}
    `;
    assert.equal(persisted.length, 1);
    assert.ok(persisted[0].consumed_at);
    assert.equal(persisted[0].sid, accessClaims.sid);
    assert.equal(persisted[0].generation, 0);
    assert.equal(persisted[0].code_digest_length, 32);
    assert.equal(persisted[0].jti_digest_length, 32);
    assert.equal(persisted[0].nonce_length, 32);
    assert.equal(JSON.stringify(persisted).includes(code), false);
    assert.equal(JSON.stringify(persisted).includes(tokens.refresh_token), false);

    const missingRefresh = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      client_id: clientId
    });
    assert.equal(missingRefresh.status, 400);
    assert.deepEqual(await missingRefresh.json(), { error: "invalid_request" });
    const secretAuthRefresh = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId
    }, { authorization: "Basic Zm9vOmJhcg==" });
    assert.equal(secretAuthRefresh.status, 401);
    assert.equal(
      secretAuthRefresh.headers.get("www-authenticate"),
      'Basic realm="cortex-oauth"'
    );
    assert.deepEqual(await secretAuthRefresh.json(), { error: "invalid_client" });
    const unknownClientRefresh = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: `chatgpt-${randomBytes(18).toString("base64url")}`
    });
    assert.equal(unknownClientRefresh.status, 401);
    assert.deepEqual(await unknownClientRefresh.json(), { error: "invalid_client" });
    const changedResourceRefresh = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: config.baseUrl
    });
    assert.equal(changedResourceRefresh.status, 400);
    assert.deepEqual(await changedResourceRefresh.json(), { error: "invalid_grant" });

    const concurrentRefreshResponses = await Promise.all([
      form("/token", gatewayPort, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId
      }),
      form("/token", gatewayPort, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        resource: config.resourceUrl,
        scope: "mcp cortex:write cortex:read"
      })
    ]);
    const concurrentRefreshBodies = await Promise.all(
      concurrentRefreshResponses.map((response) => response.json())
    );
    assert.deepEqual(
      concurrentRefreshResponses.map((response) => response.status),
      [200, 200]
    );
    assert.equal(
      concurrentRefreshBodies[0].refresh_token,
      concurrentRefreshBodies[1].refresh_token,
      "concurrent callers must receive the persisted winner's refresh token"
    );
    concurrentRefreshToken = concurrentRefreshBodies[0].refresh_token;
    assert.notEqual(concurrentRefreshToken, tokens.refresh_token);
    assert.deepEqual(
      concurrentRefreshBodies.map((body) => body.scope),
      ["cortex:read cortex:write mcp", "cortex:read cortex:write mcp"]
    );
    const concurrentRefreshClaims = await runtime.crypto.verifyRefreshToken(
      concurrentRefreshToken
    );
    assert.equal(concurrentRefreshClaims.sid, refreshClaims.sid);
    assert.equal(concurrentRefreshClaims.generation, 1);
    const rotationRows = await ownerSql`
      SELECT
        grant_row.current_refresh_generation,
        grant_row.inactivity_expires_at,
        parent.consumed_at,
        parent.replacement_generation,
        parent.retry_deadline,
        parent.request_fingerprint,
        replacement.generation,
        replacement.issued_at,
        replacement.expires_at,
        replacement.consumed_at AS replacement_consumed_at,
        replacement.effective_scopes::text[] AS effective_scopes
      FROM public.oauth_grants AS grant_row
      INNER JOIN public.oauth_refresh_tokens AS parent
        ON parent.grant_id = grant_row.id
        AND parent.generation = 0
      INNER JOIN public.oauth_refresh_tokens AS replacement
        ON replacement.grant_id = grant_row.id
        AND replacement.generation = 1
      WHERE grant_row.id = ${refreshClaims.sid}
    `;
    assert.equal(rotationRows.length, 1);
    assert.equal(rotationRows[0].current_refresh_generation, 1);
    assert.ok(rotationRows[0].consumed_at);
    assert.equal(rotationRows[0].replacement_generation, 1);
    assert.equal(
      rotationRows[0].retry_deadline.getTime() -
        rotationRows[0].consumed_at.getTime(),
      config.refreshRetryGraceSeconds * 1_000
    );
    assert.equal(Buffer.from(rotationRows[0].request_fingerprint).byteLength, 32);
    assert.equal(rotationRows[0].replacement_consumed_at, null);
    assert.deepEqual(
      rotationRows[0].effective_scopes,
      ["cortex:read", "cortex:write", "mcp"]
    );
    assert.equal(
      rotationRows[0].inactivity_expires_at.getTime(),
      rotationRows[0].expires_at.getTime()
    );
    assert.equal(
      rotationRows[0].expires_at.getTime() - rotationRows[0].issued_at.getTime(),
      config.refreshTokenTtlSeconds * 1_000
    );

    await runtime.close();
    runtime = await startGatewayV2({
      config,
      secrets,
      requiredMigration,
      expectedLegacyState: legacyStateExpectation,
      host: "127.0.0.1"
    });

    const restartRetryResponse = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: config.resourceUrl,
      scope: "cortex:read cortex:write mcp"
    });
    const restartRetryBody = await restartRetryResponse.json();
    assert.equal(restartRetryResponse.status, 200);
    assert.equal(
      restartRetryBody.refresh_token,
      concurrentRefreshToken,
      "the original parent must reconstruct the same replacement after restart"
    );
    assert.equal(
      (await runtime.crypto.verifyRefreshToken(restartRetryBody.refresh_token)).generation,
      1
    );

    const narrowedRefreshResponse = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: concurrentRefreshToken,
      client_id: clientId,
      scope: "cortex:read"
    });
    const narrowedRefreshBody = await narrowedRefreshResponse.json();
    assert.equal(narrowedRefreshResponse.status, 200);
    assert.equal(narrowedRefreshBody.scope, "cortex:read");
    narrowedRefreshToken = narrowedRefreshBody.refresh_token;
    const narrowedRefreshClaims = await runtime.crypto.verifyRefreshToken(
      narrowedRefreshToken
    );
    const narrowedAccessClaims = await runtime.crypto.verifyAccessToken(
      narrowedRefreshBody.access_token
    );
    assert.equal(narrowedRefreshClaims.generation, 2);
    assert.equal(narrowedRefreshClaims.scope, "cortex:read");
    assert.equal(narrowedAccessClaims.scope, "cortex:read");
    const expandedRefreshResponse = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: narrowedRefreshToken,
      client_id: clientId,
      scope: "cortex:read mcp"
    });
    assert.equal(expandedRefreshResponse.status, 400);
    assert.deepEqual(await expandedRefreshResponse.json(), {
      error: "invalid_scope"
    });
    const narrowedCalls = await protectedCalls(
      gatewayPort,
      narrowedRefreshBody.access_token
    );
    assert.equal(narrowedCalls.rest.status, 200);
    assert.equal(narrowedCalls.mcp.status, 403);
    assert.equal(narrowedCalls.mcpBody.error, "insufficient_scope");

    const restartRotationRows = await ownerSql`
      SELECT
        grant_row.current_refresh_generation,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
        ) AS generation_count,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_audit_events AS audit
          WHERE audit.grant_id = grant_row.id
            AND audit.event_type = 'refresh_rotation'
            AND audit.outcome = 'rotated'
        ) AS rotated_count,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_audit_events AS audit
          WHERE audit.grant_id = grant_row.id
            AND audit.event_type = 'refresh_rotation'
            AND audit.outcome = 'retry'
        ) AS retry_count
      FROM public.oauth_grants AS grant_row
      WHERE grant_row.id = ${refreshClaims.sid}
    `;
    assert.equal(restartRotationRows.length, 1);
    assert.equal(restartRotationRows[0].current_refresh_generation, 2);
    assert.equal(restartRotationRows[0].generation_count, 3);
    assert.equal(restartRotationRows[0].rotated_count, 2);
    assert.equal(restartRotationRows[0].retry_count, 2);

    const replay = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: verifier
    });
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: "invalid_grant" });

    const compatibilityVerifier = randomBytes(32).toString("base64url");
    const compatibilityAuthorization = {
      ...authorization,
      state: "slice-3-base-resource",
      code_challenge: runtime.crypto.createPkceChallenge(compatibilityVerifier),
      resource: config.baseUrl
    };
    const compatibilityAuthorizationResponse = await form("/authorize", gatewayPort, {
      ...compatibilityAuthorization,
      username: subject,
      password: BROWSER_PASSWORD
    });
    assert.equal(compatibilityAuthorizationResponse.status, 302);
    const compatibilityCode = new URL(
      compatibilityAuthorizationResponse.headers.get("location")
    ).searchParams.get("code");
    const compatibilityTokenResponse = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code: compatibilityCode,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: compatibilityVerifier,
      resource: config.baseUrl
    });
    const compatibilityTokens = await compatibilityTokenResponse.json();
    assert.equal(compatibilityTokenResponse.status, 200);
    compatibilityAccessToken = compatibilityTokens.access_token;
    const compatibilityClaims = await runtime.crypto.verifyAccessToken(
      compatibilityAccessToken
    );
    assert.equal(compatibilityClaims.iss, issuer);
    assert.equal(compatibilityClaims.aud, config.baseUrl);

    const issuerOnlyAuthorization = await fetch(
      `http://127.0.0.1:${gatewayPort}/authorize?${new URLSearchParams({
        ...authorization,
        state: "slice-3-issuer-only-rejected",
        resource: issuer
      })}`
    );
    assert.equal(issuerOnlyAuthorization.status, 400);

    const initialCalls = await protectedCalls(gatewayPort, tokens.access_token);
    assert.equal(initialCalls.rest.status, 200);
    assert.match(initialCalls.restBody.url, new RegExp(`agentId=${agentExternalId}$`));
    assert.equal(initialCalls.mcp.status, 200);
    assert.deepEqual(initialCalls.mcpBody.result.received_arguments, {
      agent_id: agentExternalId
    });

    const idempotentImport = await runtime.store.importLegacyStateOnce({
      ...legacyImportInput,
      requestId: `${legacyImportRequestId}-restart`
    });
    assert.deepEqual(idempotentImport, {
      kind: "already_imported",
      version: LEGACY_STATE_IMPORT_VERSION,
      report: {
        clientsImported: 1,
        clientsExisting: 0,
        codesImported: 1,
        codesExpired: 0
      }
    });

    const restartSessionResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/authorize?${new URLSearchParams({
        ...legacyAuthorization,
        state: "slice-5-opaque-after-restart",
        code_challenge: runtime.crypto.createPkceChallenge(
          randomBytes(32).toString("base64url")
        )
      })}`,
      { headers: { cookie: upgradedLoginCookie }, redirect: "manual" }
    );
    assert.equal(restartSessionResponse.status, 302);
    assert.equal(restartSessionResponse.headers.get("set-cookie"), null);
    assert.equal(
      new URL(restartSessionResponse.headers.get("location")).searchParams.get("state"),
      "slice-5-opaque-after-restart"
    );

    // The loopback socket is not in the configured proxy CIDR. Changing the
    // forwarded value therefore cannot evade either socket-IP bucket.
    for (const spoofedIp of ["203.0.113.10", "203.0.113.11"]) {
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/register`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-client-ip": spoofedIp
          },
          body: JSON.stringify({})
        }
      );
      assert.equal(response.status, 400);
    }
    const blockedRegistration = await fetch(
      `http://127.0.0.1:${gatewayPort}/register`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-client-ip": "203.0.113.12"
        },
        body: JSON.stringify({})
      }
    );
    assert.equal(blockedRegistration.status, 429);
    assert.match(blockedRegistration.headers.get("retry-after"), /^[1-9][0-9]*$/);

    for (const spoofedIp of ["203.0.113.20", "203.0.113.21"]) {
      const response = await form("/authorize", gatewayPort, {
        ...authorization,
        username: "wrong-user",
        password: "wrong-password"
      }, { "x-test-client-ip": spoofedIp });
      assert.equal(response.status, 401);
    }
    const blockedLogin = await form("/authorize", gatewayPort, {
      ...authorization,
      username: subject,
      password: BROWSER_PASSWORD
    }, { "x-test-client-ip": "203.0.113.22" });
    assert.equal(blockedLogin.status, 429);
    assert.match(blockedLogin.headers.get("retry-after"), /^[1-9][0-9]*$/);

    const afterRestart = await protectedCalls(gatewayPort, tokens.access_token);
    assert.equal(afterRestart.rest.status, 200);
    assert.equal(afterRestart.mcp.status, 200);
    const compatibilityAfterRestart = await fetch(
      `http://127.0.0.1:${gatewayPort}/api/v1/status`,
      { headers: protectedHeaders(compatibilityAccessToken) }
    );
    assert.equal(compatibilityAfterRestart.status, 200);

    const beforeRefreshReplay = upstreamRequests.length;
    const replayRevokedChallenge =
      `Bearer error="invalid_token", resource_metadata="${config.baseUrl}` +
      `/.well-known/oauth-protected-resource"`;
    const compatibilityRefreshClaims = await runtime.crypto.verifyRefreshToken(
      compatibilityTokens.refresh_token
    );
    const compatibilityAccessDecision = await runtime.store.resolveAccessContext({
      claims: compatibilityClaims
    });
    assert.equal(compatibilityAccessDecision.kind, "active");
    const signedUnknownRefresh = await runtime.crypto.issueRefreshToken({
      grant: compatibilityAccessDecision.context,
      generation: compatibilityRefreshClaims.generation,
      reconstructionNonce: randomBytes(32),
      issuedAt: new Date(compatibilityRefreshClaims.iat * 1_000),
      expiresAt: new Date(compatibilityRefreshClaims.exp * 1_000)
    });
    const signedUnknownRefreshClaims = await runtime.crypto.verifyRefreshToken(
      signedUnknownRefresh
    );
    assert.notEqual(
      signedUnknownRefreshClaims.jti,
      compatibilityRefreshClaims.jti
    );
    const unknownJtiReplay = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: signedUnknownRefresh,
      client_id: clientId
    });
    assert.equal(unknownJtiReplay.status, 400);
    assert.equal(unknownJtiReplay.headers.get("cache-control"), "no-store");
    assert.equal(unknownJtiReplay.headers.get("www-authenticate"), null);
    assert.deepEqual(await unknownJtiReplay.json(), { error: "invalid_grant" });

    const compatibilityAfterUnknownJti = await fetch(
      `http://127.0.0.1:${gatewayPort}/api/v1/status`,
      { headers: protectedHeaders(compatibilityAccessToken) }
    );
    assert.equal(compatibilityAfterUnknownJti.status, 401);
    assert.equal(
      compatibilityAfterUnknownJti.headers.get("www-authenticate"),
      replayRevokedChallenge
    );
    assert.deepEqual(await compatibilityAfterUnknownJti.json(), {
      error: "invalid_token"
    });
    assert.equal(upstreamRequests.length, beforeRefreshReplay);

    const unknownJtiRows = await ownerSql`
      SELECT
        grant_row.status,
        grant_row.revoked_reason,
        grant_row.current_refresh_generation,
        NOT EXISTS (
          SELECT 1
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
            AND refresh.expires_at > GREATEST(
              grant_row.revoked_at,
              refresh.issued_at + INTERVAL '1 microsecond'
            )
        ) AS all_refresh_clipped,
        audit.event_type,
        audit.outcome,
        audit.principal_id,
        audit.binding_id,
        audit.oauth_client_id,
        audit.metadata
      FROM public.oauth_grants AS grant_row
      INNER JOIN public.oauth_audit_events AS audit
        ON audit.grant_id = grant_row.id
        AND audit.event_type = 'refresh_replay'
      WHERE grant_row.id = ${compatibilityRefreshClaims.sid}
    `;
    assert.equal(unknownJtiRows.length, 1);
    assert.deepEqual({ ...unknownJtiRows[0] }, {
      status: "revoked",
      revoked_reason: "refresh_replay_detected",
      current_refresh_generation: 0,
      all_refresh_clipped: true,
      event_type: "refresh_replay",
      outcome: "revoked",
      principal_id: null,
      binding_id: null,
      oauth_client_id: null,
      metadata: {
        reason: "unknown_jti",
        presented_generation: 0,
        current_generation: 0
      }
    });

    const oldestRefreshReplay = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId
    });
    assert.equal(oldestRefreshReplay.status, 400);
    assert.equal(oldestRefreshReplay.headers.get("cache-control"), "no-store");
    assert.equal(oldestRefreshReplay.headers.get("www-authenticate"), null);
    assert.deepEqual(await oldestRefreshReplay.json(), {
      error: "invalid_grant"
    });

    const replayRevokedCalls = await protectedCalls(
      gatewayPort,
      narrowedRefreshBody.access_token
    );
    for (const response of [
      replayRevokedCalls.rest,
      replayRevokedCalls.mcp
    ]) {
      assert.equal(response.status, 401);
      assert.equal(
        response.headers.get("www-authenticate"),
        replayRevokedChallenge
      );
    }
    assert.deepEqual(replayRevokedCalls.restBody, { error: "invalid_token" });
    assert.deepEqual(replayRevokedCalls.mcpBody, { error: "invalid_token" });
    assert.equal(upstreamRequests.length, beforeRefreshReplay);

    const replayRevokedGrantRows = await ownerSql`
      SELECT
        grant_row.status,
        grant_row.revoked_at,
        grant_row.revoked_reason,
        grant_row.current_refresh_generation,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
        ) AS refresh_count,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
            AND refresh.expires_at > grant_row.revoked_at
        ) AS live_refresh_count
      FROM public.oauth_grants AS grant_row
      WHERE grant_row.id = ${refreshClaims.sid}
    `;
    assert.equal(replayRevokedGrantRows.length, 1);
    assert.equal(replayRevokedGrantRows[0].status, "revoked");
    assert.ok(replayRevokedGrantRows[0].revoked_at);
    assert.equal(
      replayRevokedGrantRows[0].revoked_reason,
      "refresh_replay_detected"
    );
    assert.equal(
      replayRevokedGrantRows[0].current_refresh_generation,
      2
    );
    assert.equal(replayRevokedGrantRows[0].refresh_count, 3);
    assert.equal(replayRevokedGrantRows[0].live_refresh_count, 0);

    const refreshReplayAuditRows = await ownerSql`
      SELECT
        event_type,
        outcome,
        principal_id,
        binding_id,
        grant_id,
        oauth_client_id,
        metadata,
        created_at
      FROM public.oauth_audit_events
      WHERE grant_id = ${refreshClaims.sid}
        AND event_type = 'refresh_replay'
        AND outcome = 'revoked'
    `;
    assert.equal(refreshReplayAuditRows.length, 1);
    assert.equal(refreshReplayAuditRows[0].event_type, "refresh_replay");
    assert.equal(refreshReplayAuditRows[0].outcome, "revoked");
    assert.equal(refreshReplayAuditRows[0].principal_id, null);
    assert.equal(refreshReplayAuditRows[0].binding_id, null);
    assert.equal(refreshReplayAuditRows[0].grant_id, refreshClaims.sid);
    assert.equal(refreshReplayAuditRows[0].oauth_client_id, null);
    assert.deepEqual(refreshReplayAuditRows[0].metadata, {
      reason: "older_generation",
      presented_generation: 0,
      current_generation: 2
    });
    assert.equal(
      refreshReplayAuditRows[0].created_at.getTime(),
      replayRevokedGrantRows[0].revoked_at.getTime()
    );

    const refreshLeakCanaries = [
      tokens.refresh_token,
      concurrentRefreshToken,
      narrowedRefreshToken,
      signedUnknownRefresh,
      refreshClaims.jti,
      concurrentRefreshClaims.jti,
      narrowedRefreshClaims.jti,
      signedUnknownRefreshClaims.jti
    ];
    const refreshLeakScan = await ownerSql`
      SELECT pg_catalog.count(*)::integer AS count
      FROM (
        SELECT pg_catalog.row_to_json(record)::text AS payload
        FROM public.oauth_grants AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_refresh_tokens AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_audit_events AS record
      ) AS oauth_rows
      CROSS JOIN pg_catalog.unnest(${ownerSql.array(refreshLeakCanaries)}::text[])
        AS canary(value)
      WHERE pg_catalog.strpos(oauth_rows.payload, canary.value) > 0
    `;
    assert.equal(refreshLeakScan[0].count, 0);
    const refreshDigestLengths = await ownerSql`
      SELECT generation, pg_catalog.octet_length(jti_digest) AS digest_length
      FROM public.oauth_refresh_tokens
      WHERE grant_id = ${refreshClaims.sid}
      ORDER BY generation
    `;
    assert.deepEqual([...refreshDigestLengths], [
      { generation: 0, digest_length: 32 },
      { generation: 1, digest_length: 32 },
      { generation: 2, digest_length: 32 }
    ]);

    for (const discoveryPath of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration"
    ]) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}${discoveryPath}`);
      assert.equal(response.status, 200);
      const metadata = await response.json();
      assert.equal(metadata.revocation_endpoint, `${issuer}/revoke`);
      assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, [
        "none",
        "client_secret_basic",
        "client_secret_post"
      ]);
    }

    const explicitVerifier = randomBytes(32).toString("base64url");
    const explicitAuthorization = {
      ...authorization,
      state: "slice-8-explicit-revocation",
      code_challenge: runtime.crypto.createPkceChallenge(explicitVerifier)
    };
    const explicitAuthorizationResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/authorize?${new URLSearchParams(explicitAuthorization)}`,
      { headers: { cookie: upgradedLoginCookie }, redirect: "manual" }
    );
    assert.equal(explicitAuthorizationResponse.status, 302);
    assert.equal(explicitAuthorizationResponse.headers.get("set-cookie"), null);
    const explicitCode = new URL(
      explicitAuthorizationResponse.headers.get("location")
    ).searchParams.get("code");
    assert.match(explicitCode, /^[A-Za-z0-9_-]{43}$/);
    const explicitTokenResponse = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code: explicitCode,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: explicitVerifier
    });
    const explicitTokens = await explicitTokenResponse.json();
    assert.equal(explicitTokenResponse.status, 200);
    const explicitClaims = await runtime.crypto.verifyAccessToken(
      explicitTokens.access_token
    );
    const explicitRefreshClaims = await runtime.crypto.verifyRefreshToken(
      explicitTokens.refresh_token
    );
    const beforeExplicitCalls = upstreamRequests.length;
    const explicitBeforeRevoke = await protectedCalls(
      gatewayPort,
      explicitTokens.access_token
    );
    assert.equal(explicitBeforeRevoke.rest.status, 200);
    assert.equal(explicitBeforeRevoke.mcp.status, 200);
    assert.equal(upstreamRequests.length, beforeExplicitCalls + 2);

    const explicitRevoke = await form("/revoke", gatewayPort, {
      client_id: clientId,
      token: explicitTokens.refresh_token,
      token_type_hint: "access_token"
    });
    assert.equal(explicitRevoke.status, 200);
    assert.equal(await explicitRevoke.text(), "");
    assert.equal(explicitRevoke.headers.get("content-type"), null);
    assert.equal(explicitRevoke.headers.get("cache-control"), "no-store");
    assert.equal(explicitRevoke.headers.get("pragma"), "no-cache");
    assert.equal(explicitRevoke.headers.get("www-authenticate"), null);
    const repeatedExplicitRevoke = await form("/revoke", gatewayPort, {
      client_id: clientId,
      token: explicitTokens.access_token,
      token_type_hint: "unsupported_hint"
    });
    assert.equal(repeatedExplicitRevoke.status, 200);
    assert.equal(await repeatedExplicitRevoke.text(), "");

    const beforeRevokedCalls = upstreamRequests.length;
    const explicitAfterRevoke = await protectedCalls(
      gatewayPort,
      explicitTokens.access_token
    );
    for (const response of [explicitAfterRevoke.rest, explicitAfterRevoke.mcp]) {
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), replayRevokedChallenge);
    }
    assert.deepEqual(explicitAfterRevoke.restBody, { error: "invalid_token" });
    assert.deepEqual(explicitAfterRevoke.mcpBody, { error: "invalid_token" });
    assert.equal(upstreamRequests.length, beforeRevokedCalls);

    const explicitRows = await ownerSql`
      SELECT
        grant_row.status,
        grant_row.revoked_reason,
        NOT EXISTS (
          SELECT 1
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
            AND refresh.expires_at > GREATEST(
              grant_row.revoked_at,
              refresh.issued_at + INTERVAL '1 microsecond'
            )
        ) AS all_refresh_clipped,
        pg_catalog.count(audit.id)::integer AS audit_count,
        pg_catalog.bool_and(audit.principal_id IS NULL) AS audits_omit_principal,
        pg_catalog.bool_and(audit.binding_id IS NULL) AS audits_omit_binding,
        pg_catalog.bool_and(audit.oauth_client_id IS NULL) AS audits_omit_client
      FROM public.oauth_grants AS grant_row
      LEFT JOIN public.oauth_audit_events AS audit
        ON audit.grant_id = grant_row.id
        AND audit.event_type = 'token_revocation'
      WHERE grant_row.id = ${explicitClaims.sid}
      GROUP BY grant_row.id
    `;
    assert.deepEqual({ ...explicitRows[0] }, {
      status: "revoked",
      revoked_reason: "client_token_revocation",
      all_refresh_clipped: true,
      audit_count: 1,
      audits_omit_principal: true,
      audits_omit_binding: true,
      audits_omit_client: true
    });

    const reauthorizeVerifier = randomBytes(32).toString("base64url");
    const reauthorizeResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/authorize?${new URLSearchParams({
        ...authorization,
        state: "slice-8-session-preserved",
        code_challenge: runtime.crypto.createPkceChallenge(reauthorizeVerifier)
      })}`,
      { headers: { cookie: upgradedLoginCookie }, redirect: "manual" }
    );
    assert.equal(reauthorizeResponse.status, 302);
    assert.equal(reauthorizeResponse.headers.get("set-cookie"), null);
    const reauthorizeCode = new URL(
      reauthorizeResponse.headers.get("location")
    ).searchParams.get("code");
    const reauthorizeTokenResponse = await form("/token", gatewayPort, {
      grant_type: "authorization_code",
      code: reauthorizeCode,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: reauthorizeVerifier
    });
    const reauthorizedTokens = await reauthorizeTokenResponse.json();
    assert.equal(reauthorizeTokenResponse.status, 200);
    const reauthorizedAccessClaims = await runtime.crypto.verifyAccessToken(
      reauthorizedTokens.access_token
    );
    const reauthorizedRefreshClaims = await runtime.crypto.verifyRefreshToken(
      reauthorizedTokens.refresh_token
    );
    const reauthorizedCalls = await protectedCalls(
      gatewayPort,
      reauthorizedTokens.access_token
    );
    assert.equal(reauthorizedCalls.rest.status, 200);
    assert.equal(reauthorizedCalls.mcp.status, 200);

    const slice8LeakCanaries = [
      explicitTokens.access_token,
      explicitTokens.refresh_token,
      explicitClaims.jti,
      explicitRefreshClaims.jti,
      reauthorizedTokens.access_token,
      reauthorizedTokens.refresh_token,
      reauthorizedAccessClaims.jti,
      reauthorizedRefreshClaims.jti
    ];
    const slice8LeakScan = await ownerSql`
      SELECT pg_catalog.count(*)::integer AS count
      FROM (
        SELECT pg_catalog.row_to_json(record)::text AS payload
        FROM public.oauth_grants AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_refresh_tokens AS record
        UNION ALL
        SELECT pg_catalog.row_to_json(record)::text
        FROM public.oauth_audit_events AS record
      ) AS oauth_rows
      CROSS JOIN pg_catalog.unnest(${ownerSql.array(slice8LeakCanaries)}::text[])
        AS canary(value)
      WHERE pg_catalog.strpos(oauth_rows.payload, canary.value) > 0
    `;
    assert.equal(slice8LeakScan[0].count, 0);

    const beforeOutage = upstreamRequests.length;
    await runtime.store.close();
    const revokeOutage = await form("/revoke", gatewayPort, {
      client_id: clientId,
      token: reauthorizedTokens.access_token
    });
    assert.equal(revokeOutage.status, 503);
    assert.equal(revokeOutage.headers.get("www-authenticate"), null);
    assert.deepEqual(await revokeOutage.json(), {
      error: "temporarily_unavailable"
    });
    const refreshOutage = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: reauthorizedTokens.refresh_token,
      client_id: clientId
    });
    assert.equal(refreshOutage.status, 503);
    assert.equal(refreshOutage.headers.get("www-authenticate"), null);
    assert.deepEqual(await refreshOutage.json(), {
      error: "temporarily_unavailable"
    });
    const legacyRefreshOutage = await form("/token", gatewayPort, {
      grant_type: "refresh_token",
      refresh_token: legacyRefreshToken,
      client_id: legacyClientId
    });
    assert.equal(legacyRefreshOutage.status, 503);
    assert.equal(legacyRefreshOutage.headers.get("www-authenticate"), null);
    assert.deepEqual(await legacyRefreshOutage.json(), {
      error: "temporarily_unavailable"
    });
    const outage = await protectedCalls(gatewayPort, reauthorizedTokens.access_token);
    for (const response of [outage.rest, outage.mcp]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("www-authenticate"), null);
    }
    assert.deepEqual(outage.restBody, { error: "temporarily_unavailable" });
    assert.deepEqual(outage.mcpBody, { error: "temporarily_unavailable" });
    const legacyOutage = await protectedCalls(gatewayPort, legacyAccessToken);
    for (const response of [legacyOutage.rest, legacyOutage.mcp]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("www-authenticate"), null);
    }
    assert.deepEqual(legacyOutage.restBody, { error: "temporarily_unavailable" });
    assert.deepEqual(legacyOutage.mcpBody, { error: "temporarily_unavailable" });
    assert.equal(upstreamRequests.length, beforeOutage);

    const live = await fetch(`http://127.0.0.1:${gatewayPort}/livez`);
    const discovery = await fetch(
      `http://127.0.0.1:${gatewayPort}/.well-known/oauth-authorization-server`
    );
    const ready = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
    assert.equal(live.status, 200);
    assert.equal(discovery.status, 200);
    assert.equal(ready.status, 503);

    for (const request of upstreamRequests) {
      assert.equal(request.authorization, undefined);
    }
    assert.deepEqual(await readFile(legacyStatePath), frozenStateBytes);
    assert.equal((await stat(legacyStatePath)).mode & 0o7777, frozenStateMode);
  } finally {
    const failures = [];
    for (const operation of [
      async () => legacyGateway?.close(),
      async () => importStore?.close(),
      async () => runtime?.close(),
      async () => closeServer(restServer),
      async () => closeServer(mcpServer),
      async () => {
        const cleanupClientIds = [clientId, legacyClientId].filter(Boolean);
        if (cleanupClientIds.length === 0) return;
        await ownerSql`
          DELETE FROM public.oauth_audit_events
          WHERE request_id LIKE ${`${legacyImportRequestId}%`}
             OR (
               principal_id IN (
                 SELECT id FROM public.oauth_principals
                 WHERE issuer = ${config.issuerUrl}
                   AND subject = ${subject}
               )
               AND event_type IN (
                 'browser_login_session',
                 'legacy_login_session_upgrade'
               )
             )
             OR oauth_client_id IN (
               SELECT id FROM public.oauth_clients
               WHERE client_id = ANY(${ownerSql.array(cleanupClientIds)}::text[])
             )
             OR grant_id IN (
               SELECT grant_row.id
               FROM public.oauth_grants AS grant_row
               INNER JOIN public.oauth_clients AS client
                 ON client.id = grant_row.oauth_client_id
               WHERE client.client_id = ANY(
                 ${ownerSql.array(cleanupClientIds)}::text[]
               )
             )
        `;
        await ownerSql`
          DELETE FROM public.oauth_grants
          WHERE oauth_client_id IN (
            SELECT id FROM public.oauth_clients
            WHERE client_id = ANY(${ownerSql.array(cleanupClientIds)}::text[])
          )
        `;
        await ownerSql`
          DELETE FROM public.oauth_authorization_codes
          WHERE oauth_client_id IN (
            SELECT id FROM public.oauth_clients
            WHERE client_id = ANY(${ownerSql.array(cleanupClientIds)}::text[])
          )
        `;
        await ownerSql`
          DELETE FROM public.oauth_login_sessions
          WHERE principal_id IN (
            SELECT id FROM public.oauth_principals
            WHERE issuer = ${config.issuerUrl}
              AND subject = ${subject}
          )
        `;
        await ownerSql`
          DELETE FROM public.oauth_state_migrations
          WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
        `;
        await ownerSql`
          DELETE FROM public.oauth_clients
          WHERE client_id = ANY(${ownerSql.array(cleanupClientIds)}::text[])
        `;
      },
      async () => {
        if (!legacyStatePath || !frozenStateBytes || frozenStateMode === null) return;
        assert.deepEqual(await readFile(legacyStatePath), frozenStateBytes);
        assert.equal((await stat(legacyStatePath)).mode & 0o7777, frozenStateMode);
      },
      async () => {
        if (legacyFixtureDirectory) {
          await rm(legacyFixtureDirectory, { recursive: true, force: true });
        }
      },
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Slice 5 integration cleanup failed");
    }
  }
});
