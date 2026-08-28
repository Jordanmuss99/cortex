import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { test } from "node:test";
import { inspect } from "node:util";
import postgres from "postgres";
import {
  createPostgresOAuthAdminStore,
  parseAdminCommand,
  runAdminCli,
  runAdminCommand
} from "./admin.js";
import { createGatewayApp } from "./app.js";
import { loadStaticClientConfiguration } from "./config.js";
import {
  createPostgresOAuthStore,
  FRESH_INSTALL_SHA256,
  LEGACY_STATE_IMPORT_VERSION,
  OAuthLegacyStateImportError,
  OAuthStoreUnavailableError
} from "./oauth-store.js";

const MIGRATION_ID = "009_oauth_authority";
const MIGRATION_URL = new URL(
  "../db/migrations/009_oauth_authority.sql",
  import.meta.url
);
const MEMORY_MIGRATION_URL = new URL(
  "../db/migrations/010_memory_lifecycle.sql",
  import.meta.url
);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for the disposable OAuth integration suite`);
  return value;
}

function assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl) {
  assert.equal(
    requiredEnvironment("MCP_OAUTH_TEST_DISPOSABLE"),
    "1",
    "the disposable OAuth integration guard must be enabled"
  );
  const owner = new URL(ownerDatabaseUrl);
  const gateway = new URL(gatewayDatabaseUrl);

  for (const url of [owner, gateway]) {
    assert.ok(
      new Set(["postgres:", "postgresql:"]).has(url.protocol),
      "disposable OAuth integration URLs must use PostgreSQL"
    );
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(decodeURIComponent(url.pathname), "/cortex_test");
    assert.equal(url.search, "", "disposable OAuth URLs must not contain query overrides");
    assert.equal(url.hash, "", "disposable OAuth URLs must not contain fragments");
  }
  assert.equal(owner.host, gateway.host);
  assert.equal(owner.pathname, gateway.pathname);
  assert.equal(decodeURIComponent(owner.username), "cortex_test");
  assert.equal(decodeURIComponent(gateway.username), "cortex_oauth_gateway");
}

async function requiredMigration() {
  const [bytes, memoryBytes] = await Promise.all([
    readFile(MIGRATION_URL),
    readFile(MEMORY_MIGRATION_URL)
  ]);
  return {
    id: MIGRATION_ID,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    additionalMigrations: [{
      id: "010_memory_lifecycle",
      sha256: createHash("sha256").update(memoryBytes).digest("hex")
    }]
  };
}

function oauthStoreOptions(databaseUrl, migration, issuer, subject, agentExternalId) {
  return {
    databaseUrl,
    requiredMigration: migration,
    bootstrap: { issuer, subject, agentExternalId },
    baseUrl: issuer,
    resourceUrl: "https://cortex.example.test/mcp"
  };
}

function exchangeMaterial(overrides = {}) {
  const issuedAt = new Date();
  return {
    grantId: randomUUID(),
    inactivityExpiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000),
    refresh: {
      generation: 0,
      jtiDigest: randomBytes(32),
      reconstructionNonce: randomBytes(32),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000)
    },
    ...overrides
  };
}

function assertGenericStoreError(error, secretValues) {
  assert.ok(error instanceof OAuthStoreUnavailableError);
  assert.equal(error.message, "OAuth persistence is unavailable");
  assert.equal(error.cause, undefined);
  const serialized = inspect(error, { depth: 20, showHidden: true });
  for (const value of secretValues) {
    const bytes = Buffer.from(value);
    for (const canary of [bytes.toString("hex"), bytes.toString("base64url")]) {
      assert.equal(
        serialized.includes(canary),
        false,
        "store errors must not recursively expose supplied security material"
      );
    }
  }
  return true;
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function requestGatewayHealth(store, path) {
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      restTarget: "http://core.internal:3100",
      mcpTarget: "http://mcp.internal:8000"
    },
    crypto: {
      async verifyAccessToken() {
        throw new Error("not used by health endpoints");
      },
      async verifyRevocationReference() {
        return null;
      }
    },
    store,
    async fetchImpl(target, options) {
      if (String(target).endsWith("/readyz")) {
        assert.equal(options.method, "GET");
        return Response.json({ status: "ok" });
      }
      if (String(target).endsWith("/mcp") && options.method === "POST") {
        const message = JSON.parse(options.body);
        if (message.method === "notifications/initialized") {
          assert.equal(
            options.headers["mcp-session-id"],
            "integration-readiness-session"
          );
          return new Response(null, { status: 202 });
        }
        if (message.method === "ping") {
          assert.equal(
            options.headers["mcp-session-id"],
            "integration-readiness-session"
          );
          return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
        }
        assert.equal(message.method, "initialize");
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "cortex-v2", version: "2.4.0" }
          }
        }, {
          headers: { "mcp-session-id": "integration-readiness-session" }
        });
      }
      if (String(target).endsWith("/mcp") && options.method === "DELETE") {
        assert.equal(
          options.headers["mcp-session-id"],
          "integration-readiness-session"
        );
        return new Response(null, { status: 200 });
      }
      throw new Error("unexpected health target");
    }
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return {
      status: response.status,
      body: await response.json()
    };
  } finally {
    await closeServer(server);
  }
}

test("security event persistence keeps only redacted mismatch metadata", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const requestId = randomUUID();
  const canaries = [
    "bearer-canary",
    "authorization-code-canary",
    "cookie-canary",
    "password-canary",
    "client-secret-canary",
    "raw-jti-canary",
    "203.0.113.91",
    "foreign-agent-canary",
  ];

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events WHERE request_id = ${requestId}
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 }),
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "security audit cleanup failed");
  });

  const binding = await store.resolveBootstrapBinding();
  assert.ok(binding);
  await store.recordSecurityEvent({
    eventType: "agent_mismatch",
    outcome: "rejected",
    principalId: binding.principalId,
    bindingId: binding.bindingId,
    grantId: null,
    requestId,
    actorType: "connector",
    metadata: {
      surface: "rest",
      authorization: canaries[0],
      code: canaries[1],
      cookie: canaries[2],
      password: canaries[3],
      client_secret: canaries[4],
      jti: canaries[5],
      ip: canaries[6],
      agent_id: canaries[7],
    },
  });
  const rows = await ownerSql`
    SELECT event_type, outcome, principal_id, binding_id, grant_id,
           actor_type, metadata
    FROM public.oauth_audit_events
    WHERE request_id = ${requestId}
  `;
  assert.deepEqual([...rows], [{
    event_type: "agent_mismatch",
    outcome: "rejected",
    principal_id: binding.principalId,
    binding_id: binding.bindingId,
    grant_id: null,
    actor_type: "connector",
    metadata: { surface: "rest" },
  }]);
  const serialized = JSON.stringify(rows);
  for (const canary of canaries) assert.equal(serialized.includes(canary), false);
});

test("the fixed-role operator CLI and PostgreSQL adapter work end to end with redacted output", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const operatorDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OPERATOR_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const ownerAuthority = new URL(ownerDatabaseUrl);
  const operatorAuthority = new URL(operatorDatabaseUrl);
  assert.equal(operatorAuthority.hostname, "127.0.0.1");
  assert.equal(operatorAuthority.host, ownerAuthority.host);
  assert.equal(operatorAuthority.pathname, ownerAuthority.pathname);
  assert.equal(decodeURIComponent(operatorAuthority.username), "cortex_oauth_operator_user");
  assert.ok(operatorAuthority.password);

  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  let adminStore = null;
  let client = null;
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice8-admin-adapter-${suffix}`;
  const actor = `slice8-admin-${suffix}`;
  const reason = `disposable operator adapter proof ${suffix}`;

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => adminStore?.close(),
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
           OR metadata ->> 'actor' = ${actor}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE id = ${client?.id ?? null}
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "operator adapter integration cleanup failed");
    }
  });

  const bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const codeChallenge = "A".repeat(43);
  const codeDigest = randomBytes(32);
  client = await store.registerDynamicClient({
    redirectUris: [redirectUri],
    clientName: `Slice 8 operator adapter ${suffix}`
  });
  assert.ok(client);
  assert.equal(await store.createAuthorization({
    codeDigest,
    authenticatedContext: bootstrap,
    clientId: client.clientId,
    redirectUri,
    scopes: ["cortex:read", "mcp"],
    codeChallenge,
    resource: "https://cortex.example.test/mcp",
    expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
    requestId: `${requestPrefix}-authorize`,
    ipFingerprint: null,
    userAgentFingerprint: null
  }), undefined);
  const material = exchangeMaterial();
  const grant = await store.exchangeAuthorizationCode({
    codeDigest,
    clientId: client.clientId,
    redirectUri,
    codeChallenge,
    ...material,
    requestId: `${requestPrefix}-exchange`
  });
  assert.ok(grant);

  const invokeCli = async (argv) => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runAdminCli({
      argv,
      env: { MCP_OAUTH_OPERATOR_DATABASE_URL: operatorDatabaseUrl },
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } }
    });
    return { exitCode, stdout, stderr };
  };

  const listed = await invokeCli([
    "grants", "list", "--client-id", client.clientId, "--limit", "1", "--json"
  ]);
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.stderr, "");
  const listedResult = JSON.parse(listed.stdout);
  assert.equal(listedResult.kind, "grants.list");
  assert.equal(listedResult.truncated, false);
  assert.equal(listedResult.grants.length, 1);
  assert.deepEqual({
    sid: listedResult.grants[0].sid,
    issuer: listedResult.grants[0].issuer,
    subject: listedResult.grants[0].subject,
    clientId: listedResult.grants[0].clientId,
    status: listedResult.grants[0].status,
    scopes: listedResult.grants[0].scopes
  }, {
    sid: grant.sid,
    issuer,
    subject,
    clientId: client.clientId,
    status: "active",
    scopes: ["cortex:read", "mcp"]
  });
  for (const secret of [
    decodeURIComponent(operatorAuthority.password),
    codeDigest.toString("hex"),
    material.refresh.jtiDigest.toString("hex"),
    material.refresh.reconstructionNonce.toString("hex")
  ]) {
    assert.equal(listed.stdout.includes(secret), false);
  }

  const revoked = await invokeCli([
    "grants", "revoke", "--sid", grant.sid,
    "--actor", actor, "--reason", reason, "--json"
  ]);
  assert.equal(revoked.exitCode, 0);
  assert.equal(revoked.stderr, "");
  assert.deepEqual(JSON.parse(revoked.stdout), {
    kind: "grants.revoke",
    matched: true,
    changed: true,
    sid: grant.sid
  });

  const unknownSid = randomUUID();
  const notFound = await invokeCli([
    "grants", "revoke", "--sid", unknownSid,
    "--actor", actor, "--reason", reason, "--json"
  ]);
  assert.equal(notFound.exitCode, 3);
  assert.equal(notFound.stderr, "");
  assert.deepEqual(JSON.parse(notFound.stdout), {
    kind: "grants.revoke",
    matched: false,
    changed: false,
    sid: null
  });

  const rollout = await invokeCli(["rollout", "status", "--json"]);
  assert.equal(rollout.exitCode, 0);
  assert.equal(rollout.stderr, "");
  assert.equal(JSON.parse(rollout.stdout).kind, "rollout.status");

  adminStore = createPostgresOAuthAdminStore({ databaseUrl: operatorDatabaseUrl });
  const absentIssuer = `https://absent-${suffix}.example.test`;
  const absentSubject = `absent-${suffix}`;
  const mutationArguments = ["--actor", actor, "--reason", reason];
  const noMatchResults = [];
  for (const argv of [
    ["principals", "revoke-all", "--issuer", absentIssuer, "--subject", absentSubject],
    ["principals", "disable", "--issuer", absentIssuer, "--subject", absentSubject],
    ["principals", "security-logout", "--issuer", absentIssuer, "--subject", absentSubject],
    ["bindings", "disable", "--binding-id", randomUUID()],
    [
      "recovery", "invalidate-issuer", "--issuer", absentIssuer,
      "--confirmation", absentIssuer
    ]
  ]) {
    noMatchResults.push(await runAdminCommand(
      adminStore,
      parseAdminCommand([...argv, ...mutationArguments])
    ));
  }
  assert.deepEqual(noMatchResults, [
    {
      kind: "principals.revokeAll",
      matched: false,
      changed: false,
      grantCount: 0,
      codeCount: 0
    },
    {
      kind: "principals.disable",
      matched: false,
      changed: false,
      grantCount: 0,
      codeCount: 0,
      sessionCount: 0
    },
    {
      kind: "principals.securityLogout",
      matched: false,
      changed: false,
      authenticationEpoch: null,
      grantCount: 0,
      codeCount: 0,
      sessionCount: 0
    },
    {
      kind: "bindings.disable",
      matched: false,
      changed: false,
      bindingId: null,
      grantCount: 0,
      codeCount: 0
    },
    {
      kind: "recovery.invalidateIssuer",
      matched: false,
      changed: false,
      principalCount: 0,
      grantCount: 0,
      codeCount: 0,
      sessionCount: 0
    }
  ]);
});

test("PostgreSQL readiness and live grant resolution use the prepared bootstrap authority", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();

  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  let store;
  const clientUuid = randomUUID();
  const grantId = randomUUID();
  const readinessImportRequestId = `slice4-readiness-${randomUUID()}`;
  const readinessChecksum = createHash("sha256")
    .update("slice4-readiness")
    .digest();
  const readinessCountMismatchClientId = `chatgpt-${createHash("sha256")
    .update(readinessImportRequestId)
    .digest("base64url")
    .slice(0, 24)}`;
  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`DELETE FROM public.oauth_grants WHERE id = ${grantId}`,
      async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${clientUuid}`,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE client_id = ${readinessCountMismatchClientId}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id = ${readinessImportRequestId}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_state_migrations
        WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
      `,
      async () => store?.close(),
      async () => ownerSql`ALTER DATABASE cortex_test RESET search_path`,
      async () => ownerSql`SET search_path TO pg_catalog, public`,
      async () => ownerSql`DROP SCHEMA IF EXISTS slice2_hostile_gateway CASCADE`,
      async () => ownerSql`RESET search_path`,
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "OAuth gateway integration cleanup failed");
    }
  });

  const ownerIdentity = await ownerSql`
    SELECT SESSION_USER AS session_user, pg_catalog.current_database() AS current_database
  `;
  assert.deepEqual(
    { ...ownerIdentity[0] },
    { session_user: "cortex_test", current_database: "cortex_test" },
    "disposable owner connection identity must match the guarded URL"
  );

  await ownerSql`CREATE SCHEMA slice2_hostile_gateway`;
  await ownerSql.unsafe(`
    CREATE FUNCTION slice2_hostile_gateway.uuid_equal(uuid, uuid)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    SET search_path = pg_catalog
    AS 'SELECT FALSE';

    CREATE OPERATOR slice2_hostile_gateway.= (
      LEFTARG = uuid,
      RIGHTARG = uuid,
      FUNCTION = slice2_hostile_gateway.uuid_equal
    );
  `);
  await ownerSql`
    GRANT USAGE ON SCHEMA slice2_hostile_gateway TO cortex_oauth_gateway
  `;
  await ownerSql`
    ALTER DATABASE cortex_test
    SET search_path TO slice2_hostile_gateway, pg_catalog, public
  `;
  await ownerSql`SET search_path TO slice2_hostile_gateway, pg_catalog, public`;
  const equalityCanary = randomUUID();
  const hostileEquality = await ownerSql`
    SELECT ${equalityCanary}::uuid = ${equalityCanary}::uuid AS equal
  `;
  assert.equal(hostileEquality.length, 1);
  assert.equal(
    hostileEquality[0].equal,
    false,
    "the hostile database default must shadow UUID equality before the store pins search_path"
  );
  await ownerSql`SET search_path TO pg_catalog, public`;

  store = createPostgresOAuthStore({
    databaseUrl: gatewayDatabaseUrl,
    requiredMigration: migration,
    bootstrap: { issuer, subject, agentExternalId },
    baseUrl: issuer
  });

  assert.deepEqual(await store.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });

  const liveResponse = await requestGatewayHealth(store, "/livez");
  assert.equal(liveResponse.status, 200);
  assert.deepEqual(liveResponse.body, { status: "ok" });

  const notReadyResponse = await requestGatewayHealth(store, "/readyz");
  assert.equal(notReadyResponse.status, 503);
  assert.deepEqual(notReadyResponse.body, { status: "not_ready" });

  const readinessImport = await store.importLegacyStateOnce({
    sourceVersion: 1,
    sourceChecksum: readinessChecksum,
    clients: [],
    codes: [],
    requestId: readinessImportRequestId
  });
  assert.deepEqual(readinessImport, {
    kind: "imported",
    version: LEGACY_STATE_IMPORT_VERSION,
    report: {
      clientsImported: 0,
      clientsExisting: 0,
      codesImported: 0,
      codesExpired: 0
    }
  });

  assert.deepEqual(await store.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });
  await store.close();
  store = createPostgresOAuthStore({
    databaseUrl: gatewayDatabaseUrl,
    requiredMigration: migration,
    bootstrap: { issuer, subject, agentExternalId },
    baseUrl: issuer,
    expectedLegacyState: {
      sourceChecksum: readinessChecksum,
      clientCount: 0,
      codeCount: 0
    }
  });
  assert.deepEqual(await store.checkReadiness(), {
    ready: true,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: true
  });
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: readinessChecksum,
      clients: [{
        clientId: readinessCountMismatchClientId,
        redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        clientName: "Slice 4 count mismatch",
        createdAt: new Date(Math.floor((Date.now() - 60_000) / 1_000) * 1_000)
      }],
      codes: [],
      requestId: `${readinessImportRequestId}-count-mismatch`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "source_mismatch"
  );
  assert.equal((await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_id = ${readinessCountMismatchClientId}
  `)[0].count, 0);

  const readyResponse = await requestGatewayHealth(store, "/readyz");
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(readyResponse.body, { status: "ok" });
  await assert.rejects(
    store.pruneExpired(new Date(), 0),
    /batch size from 1 to 1000/
  );
  assert.deepEqual(await store.pruneExpired(new Date(), 1), {
    audit_event_count: 0,
    authorization_code_count: 0,
    grant_count: 0,
    login_session_count: 0,
    refresh_token_count: 0,
  });

  const wrongMigrationStore = createPostgresOAuthStore({
    databaseUrl: gatewayDatabaseUrl,
    requiredMigration: { id: migration.id, sha256: "0".repeat(64) },
    bootstrap: { issuer, subject, agentExternalId },
    baseUrl: issuer,
    expectedLegacyState: {
      sourceChecksum: readinessChecksum,
      clientCount: 0,
      codeCount: 0
    }
  });
  try {
    const response = await requestGatewayHealth(wrongMigrationStore, "/readyz");
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: "not_ready" });
  } finally {
    await wrongMigrationStore.close();
  }

  const unknownMigrationId = `999_disposable_${randomUUID().replaceAll("-", "")}`;
  await ownerSql`
    INSERT INTO public.cortex_schema_migrations (id, sha256)
    VALUES (${unknownMigrationId}, ${"1".repeat(64)})
  `;
  try {
    const response = await requestGatewayHealth(store, "/readyz");
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: "not_ready" });
  } finally {
    await ownerSql`
      DELETE FROM public.cortex_schema_migrations WHERE id = ${unknownMigrationId}
    `;
  }
  assert.deepEqual(await store.checkReadiness(), {
    ready: true,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: true
  });

  const alteredChecksumStore = createPostgresOAuthStore({
    databaseUrl: gatewayDatabaseUrl,
    requiredMigration: migration,
    bootstrap: { issuer, subject, agentExternalId },
    baseUrl: issuer,
    expectedLegacyState: {
      sourceChecksum: createHash("sha256")
        .update("slice4-altered-readiness")
        .digest(),
      clientCount: 0,
      codeCount: 0
    }
  });
  try {
    assert.deepEqual(await alteredChecksumStore.checkReadiness(), {
      ready: false,
      database: true,
      schema: true,
      bootstrap: true,
      legacyImport: false,
      reason: "legacy_import"
    });
  } finally {
    await alteredChecksumStore.close();
  }

  const alteredCountStore = createPostgresOAuthStore({
    databaseUrl: gatewayDatabaseUrl,
    requiredMigration: migration,
    bootstrap: { issuer, subject, agentExternalId },
    baseUrl: issuer,
    expectedLegacyState: {
      sourceChecksum: readinessChecksum,
      clientCount: 1,
      codeCount: 0
    }
  });
  try {
    assert.deepEqual(await alteredCountStore.checkReadiness(), {
      ready: false,
      database: true,
      schema: true,
      bootstrap: true,
      legacyImport: false,
      reason: "legacy_import"
    });
  } finally {
    await alteredCountStore.close();
  }

  const wrongBootstrapStore = createPostgresOAuthStore({
    databaseUrl: gatewayDatabaseUrl,
    requiredMigration: migration,
    bootstrap: {
      issuer,
      subject,
      agentExternalId: `missing-${randomUUID()}`
    },
    baseUrl: issuer,
    expectedLegacyState: {
      sourceChecksum: readinessChecksum,
      clientCount: 0,
      codeCount: 0
    }
  });
  try {
    const response = await requestGatewayHealth(wrongBootstrapStore, "/readyz");
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { status: "not_ready" });
  } finally {
    await wrongBootstrapStore.close();
  }

  const bootstrapRows = await ownerSql`
    SELECT
      p.id AS principal_id,
      p.authentication_epoch,
      b.id AS binding_id,
      b.binding_version,
      b.agent_id,
      a.external_id AS agent_external_id
    FROM oauth_principals AS p
    INNER JOIN oauth_agent_bindings AS b
      ON b.principal_id = p.id
    INNER JOIN agents AS a
      ON a.id = b.agent_id
    WHERE p.issuer = ${issuer}
      AND p.subject = ${subject}
      AND p.status = 'active'
      AND b.status = 'active'
      AND b.is_default = TRUE
      AND a.external_id = ${agentExternalId}
    LIMIT 2
  `;
  assert.equal(bootstrapRows.length, 1, "the harness must prepare one exact default binding");
  const binding = bootstrapRows[0];

  const publicClientId = `chatgpt-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const resource = `${issuer.replace(/\/+$/, "")}/mcp`;
  const scopes = ["cortex:read", "mcp"];

  await ownerSql`
    INSERT INTO oauth_clients (
      id,
      client_id,
      client_kind,
      redirect_uris,
      client_name,
      token_endpoint_auth_method,
      status
    ) VALUES (
      ${clientUuid},
      ${publicClientId},
      'dynamic',
      ${ownerSql.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
      'Slice 2 integration client',
      'none',
      'active'
    )
  `;

  await ownerSql`
    INSERT INTO oauth_grants (
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
    ) VALUES (
      ${grantId},
      ${binding.principal_id},
      ${binding.binding_id},
      ${clientUuid},
      ${resource},
      ${ownerSql.array(scopes)}::oauth_scope[],
      ${binding.authentication_epoch},
      ${binding.binding_version},
      'active',
      0,
      CURRENT_TIMESTAMP + INTERVAL '1 hour'
    )
  `;

  const claims = {
    iss: issuer,
    sub: subject,
    aud: resource,
    scope: scopes.join(" "),
    client_id: publicClientId,
    token_use: "access",
    sid: grantId,
    agent_id: agentExternalId,
    auth_epoch: binding.authentication_epoch,
    binding_version: binding.binding_version,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  const active = await store.resolveAccessContext({ claims });
  assert.equal(active.kind, "active");
  assert.equal(active.context.sid, grantId);
  assert.equal(active.context.principalId, binding.principal_id);
  assert.equal(active.context.bindingId, binding.binding_id);
  assert.equal(active.context.agentId, binding.agent_id);
  assert.equal(active.context.agentExternalId, agentExternalId);
  assert.equal(active.context.clientId, publicClientId);
  assert.deepEqual([...active.context.scopes].sort(), [...scopes].sort());

  const staleClaims = { ...claims, binding_version: claims.binding_version + 1 };
  assert.deepEqual(
    await store.resolveAccessContext({ claims: staleClaims }),
    { kind: "invalid" }
  );

  await ownerSql`
    UPDATE oauth_grants
    SET
      status = 'revoked',
      revoked_at = CURRENT_TIMESTAMP,
      revoked_reason = 'slice_2_integration_test'
    WHERE id = ${grantId}
  `;
  assert.deepEqual(
    await store.resolveAccessContext({ claims }),
    { kind: "revoked" }
  );
});

test("strict dynamic registration is durable and schema constraints reject mixed authority", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  let store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  let client = null;
  const foreignPrincipalId = randomUUID();
  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients WHERE id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_principals WHERE id = ${foreignPrincipalId}
      `,
      async () => store?.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "strict DCR integration cleanup failed");
    }
  });

  const redirects = [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    `https://chatgpt.com/connector/oauth/${randomUUID().replaceAll("-", "")}`
  ];
  const beforeCounts = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_kind = 'dynamic'
  `;
  client = await store.registerDynamicClient({
    redirectUris: redirects,
    clientName: "Slice 3 durable client"
  });
  assert.ok(client);
  assert.match(client.clientId, /^chatgpt-[A-Za-z0-9_-]{24}$/);
  assert.equal(client.clientKind, "dynamic");
  assert.equal(client.tokenEndpointAuthMethod, "none");
  assert.deepEqual([...client.redirectUris], redirects);
  assert.equal(Object.isFrozen(client), true);
  assert.equal(Object.isFrozen(client.redirectUris), true);

  await store.close();
  store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  assert.deepEqual(await store.resolveActiveClient(client.clientId), client);

  for (const invalidRedirects of [
    [redirects[0], redirects[0]],
    [`${redirects[0]}?`],
    [`${redirects[0]}#`],
    ["https://example.test/connector_platform_oauth_redirect"],
    [""],
    Array.from({ length: 6 }, (_, index) =>
      `https://chatgpt.com/connector/oauth/too-many-${index}`
    )
  ]) {
    assert.equal(
      await store.registerDynamicClient({
        redirectUris: invalidRedirects,
        clientName: "Rejected Slice 3 client"
      }),
      null
    );
  }
  const afterCounts = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_kind = 'dynamic'
  `;
  assert.equal(afterCounts[0].count, beforeCounts[0].count + 1);

  await assert.rejects(
    ownerSql`
      INSERT INTO public.oauth_clients (
        id, client_id, client_kind, redirect_uris, client_name,
        token_endpoint_auth_method, status
      ) VALUES (
        ${randomUUID()},
        ${`schema-duplicate-${randomUUID()}`},
        'dynamic',
        ${ownerSql.array([redirects[0], redirects[0]])}::text[],
        'Schema duplicate rejection',
        'none',
        'active'
      )
    `,
    (error) => error?.code === "23514" &&
      error?.constraint_name === "oauth_clients_redirect_uris_check"
  );
  await assert.rejects(
    ownerSql`
      INSERT INTO public.oauth_clients (
        id, client_id, client_kind, redirect_uris, client_name,
        token_endpoint_auth_method, status
      ) VALUES (
        ${randomUUID()},
        ${`schema-secret-dcr-${randomUUID()}`},
        'dynamic',
        ${ownerSql.array([redirects[0]])}::text[],
        'Schema auth method rejection',
        'client_secret_post',
        'active'
      )
    `,
    (error) => error?.code === "23514" &&
      error?.constraint_name === "oauth_clients_dynamic_auth_method_check"
  );

  const bindingRows = await ownerSql`
    SELECT b.id AS binding_id
    FROM public.oauth_principals AS p
    JOIN public.oauth_agent_bindings AS b ON b.principal_id = p.id
    WHERE p.issuer = ${issuer}
      AND p.subject = ${subject}
      AND b.status = 'active'
      AND b.is_default = TRUE
  `;
  assert.equal(bindingRows.length, 1);
  await ownerSql`
    INSERT INTO public.oauth_principals (id, issuer, subject)
    VALUES (
      ${foreignPrincipalId},
      ${issuer},
      ${`slice3-foreign-${randomUUID()}`}
    )
  `;
  await assert.rejects(
    ownerSql`
      INSERT INTO public.oauth_authorization_codes (
        id, code_digest, oauth_client_id, principal_id, binding_id,
        authentication_epoch, binding_version, redirect_uri, scopes,
        code_challenge, resource, expires_at
      ) VALUES (
        ${randomUUID()},
        ${randomBytes(32)},
        ${client.id},
        ${foreignPrincipalId},
        ${bindingRows[0].binding_id},
        0,
        1,
        ${redirects[0]},
        ${ownerSql.array(["cortex:read", "mcp"])}::public.oauth_scope[],
        ${"A".repeat(43)},
        'https://cortex.example.test/mcp',
        CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      )
    `,
    (error) => error?.code === "23503" &&
      error?.constraint_name === "oauth_authorization_codes_binding_principal_fkey"
  );
  await assert.rejects(
    ownerSql`
      INSERT INTO public.oauth_grants (
        id, principal_id, binding_id, oauth_client_id, resource, scopes,
        authentication_epoch, binding_version, inactivity_expires_at
      ) VALUES (
        ${randomUUID()},
        ${foreignPrincipalId},
        ${bindingRows[0].binding_id},
        ${client.id},
        'https://cortex.example.test/mcp',
        ${ownerSql.array(["cortex:read", "mcp"])}::public.oauth_scope[],
        0,
        1,
        CURRENT_TIMESTAMP + INTERVAL '1 hour'
      )
    `,
    (error) => error?.code === "23503" &&
      error?.constraint_name === "oauth_grants_binding_principal_fkey"
  );
});

test("dynamic registration capacity is serialized under concurrency", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const fillerPrefix = `slice3-capacity-${suffix}-`;
  const contenderName = `Slice 3 capacity ${suffix}`;
  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE client_id LIKE ${`${fillerPrefix}%`}
           OR client_name = ${contenderName}
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "DCR capacity integration cleanup failed");
    }
  });

  const counts = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_kind = 'dynamic'
  `;
  assert.ok(counts[0].count <= 999, "test fixture must leave room for the capacity boundary");
  const fillerCount = 999 - counts[0].count;
  if (fillerCount > 0) {
    await ownerSql`
      INSERT INTO public.oauth_clients (
        id, client_id, client_kind, redirect_uris, client_name,
        token_endpoint_auth_method, status
      )
      SELECT
        pg_catalog.gen_random_uuid(),
        ${fillerPrefix} || series.value::text,
        'dynamic',
        ARRAY['https://chatgpt.com/connector_platform_oauth_redirect']::text[],
        ${`Slice 3 capacity filler ${suffix}`},
        'none',
        'active'
      FROM pg_catalog.generate_series(1, ${fillerCount}) AS series(value)
    `;
  }

  const results = await Promise.all([
    store.registerDynamicClient({
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      clientName: contenderName
    }),
    store.registerDynamicClient({
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      clientName: contenderName
    })
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  const finalCounts = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_kind = 'dynamic'
  `;
  assert.equal(finalCounts[0].count, 1_000);
});

test("static client synchronization is idempotent, secretless, conflict-atomic, and auth-method bound", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice13-static-${suffix}`;
  const linearSecret = `linear-secret-${suffix}`;
  const notionSecret = `notion-secret-${suffix}`;
  const configured = loadStaticClientConfiguration({
    LINEAR_OAUTH_CLIENT_ID: `linear-slice13-${suffix}`,
    LINEAR_OAUTH_CLIENT_SECRET: linearSecret,
    LINEAR_OAUTH_REDIRECT_URI: `https://linear.example.test/${suffix}/callback`,
    NOTION_OAUTH_CLIENT_ID: `notion-slice13-${suffix}`,
    NOTION_OAUTH_CLIENT_SECRET: notionSecret,
    NOTION_OAUTH_REDIRECT_URI: `https://notion.example.test/${suffix}/callback`
  });
  const clientIds = configured.clients.map((client) => client.clientId);
  const rollbackClientId = `rollback-slice13-${suffix}`;

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
           OR oauth_client_id IN (
             SELECT id FROM public.oauth_clients
             WHERE client_id IN (${clientIds[0]}, ${clientIds[1]}, ${rollbackClientId})
           )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id IN (
          SELECT id FROM public.oauth_clients
          WHERE client_id IN (${clientIds[0]}, ${clientIds[1]}, ${rollbackClientId})
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id IN (
          SELECT id FROM public.oauth_clients
          WHERE client_id IN (${clientIds[0]}, ${clientIds[1]}, ${rollbackClientId})
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE client_id IN (${clientIds[0]}, ${clientIds[1]}, ${rollbackClientId})
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "static client integration cleanup failed");
    }
  });

  assert.equal(configured.verifyClientSecret(clientIds[0], linearSecret), true);
  assert.equal(configured.verifyClientSecret(clientIds[0], `${linearSecret}-wrong`), false);
  assert.equal(configured.verifyClientSecret(clientIds[1], notionSecret), true);
  for (const client of configured.clients) {
    assert.deepEqual(Object.keys(client), [
      "clientId",
      "redirectUris",
      "clientName",
      "tokenEndpointAuthMethod"
    ]);
    assert.equal(client.tokenEndpointAuthMethod, "client_secret_basic");
  }

  assert.deepEqual(await store.synchronizeStaticClients(configured.clients), {
    inserted: 2,
    existing: 0
  });
  assert.deepEqual(await store.synchronizeStaticClients(configured.clients), {
    inserted: 0,
    existing: 2
  });

  const persistedRows = await ownerSql`
    SELECT
      client.client_id,
      client.client_kind,
      client.redirect_uris,
      client.client_name,
      client.token_endpoint_auth_method,
      client.status,
      pg_catalog.row_to_json(client)::text AS serialized
    FROM public.oauth_clients AS client
    WHERE client.client_id IN (${clientIds[0]}, ${clientIds[1]})
    ORDER BY client.client_id
  `;
  assert.equal(persistedRows.length, 2);
  const secretColumnRows = await ownerSql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'oauth_clients'
      AND column_name ILIKE '%secret%'
  `;
  assert.equal(secretColumnRows.length, 0);
  for (const row of persistedRows) {
    assert.equal(row.client_kind, "static");
    assert.equal(row.token_endpoint_auth_method, "client_secret_basic");
    assert.equal(row.status, "active");
    for (const secret of [linearSecret, notionSecret]) {
      assert.equal(row.serialized.includes(secret), false);
      assert.equal(
        row.serialized.includes(createHash("sha256").update(secret).digest("hex")),
        false
      );
    }
  }

  const rollbackClient = Object.freeze({
    clientId: rollbackClientId,
    redirectUris: [`https://rollback.example.test/${suffix}/callback`],
    clientName: `Slice 13 rollback ${suffix}`,
    tokenEndpointAuthMethod: "none"
  });
  await assert.rejects(
    store.synchronizeStaticClients([
      rollbackClient,
      { ...configured.clients[0], clientName: `${configured.clients[0].clientName} conflict` }
    ]),
    OAuthStoreUnavailableError
  );
  const afterConflict = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_clients WHERE client_id = ${rollbackClientId}
      ) AS rollback_client_absent,
      (
        SELECT client_name = ${configured.clients[0].clientName}
        FROM public.oauth_clients
        WHERE client_id = ${configured.clients[0].clientId}
      ) AS existing_client_unchanged
  `;
  assert.deepEqual({ ...afterConflict[0] }, {
    rollback_client_absent: true,
    existing_client_unchanged: true
  });

  const bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);
  const staticClient = configured.clients[0];
  const codeDigest = randomBytes(32);
  const codeChallenge = "S".repeat(43);
  assert.equal(await store.createAuthorization({
    codeDigest,
    authenticatedContext: bootstrap,
    clientId: staticClient.clientId,
    redirectUri: staticClient.redirectUris[0],
    scopes: ["cortex:read", "mcp"],
    codeChallenge,
    resource: "https://cortex.example.test/mcp",
    expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
    requestId: `${requestPrefix}-authorize`,
    ipFingerprint: null,
    userAgentFingerprint: null
  }), undefined);
  const wrongMethodResult = await store.exchangeAuthorizationCode({
    codeDigest,
    clientId: staticClient.clientId,
    tokenEndpointAuthMethod: "client_secret_post",
    redirectUri: staticClient.redirectUris[0],
    codeChallenge,
    ...exchangeMaterial(),
    requestId: `${requestPrefix}-wrong-method`
  });
  assert.equal(wrongMethodResult, null);
  const afterWrongMethod = await ownerSql`
    SELECT
      (SELECT consumed_at IS NULL
       FROM public.oauth_authorization_codes
       WHERE code_digest = ${codeDigest}) AS code_unconsumed,
      NOT EXISTS (
        SELECT 1
        FROM public.oauth_grants AS grant_row
        INNER JOIN public.oauth_clients AS client
          ON client.id = grant_row.oauth_client_id
        WHERE client.client_id = ${staticClient.clientId}
      ) AS no_grant
  `;
  assert.deepEqual({ ...afterWrongMethod[0] }, {
    code_unconsumed: true,
    no_grant: true
  });

  const exchange = exchangeMaterial();
  const grant = await store.exchangeAuthorizationCode({
    codeDigest,
    clientId: staticClient.clientId,
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUri: staticClient.redirectUris[0],
    codeChallenge,
    ...exchange,
    requestId: `${requestPrefix}-correct-method`
  });
  assert.ok(grant);
  assert.equal(grant.clientId, staticClient.clientId);
  assert.equal(grant.sid, exchange.grantId);
  assert.equal((await ownerSql`
    SELECT consumed_at IS NOT NULL AS consumed
    FROM public.oauth_authorization_codes
    WHERE code_digest = ${codeDigest}
  `)[0].consumed, true);
});

test("explicit fresh installation is durable, idempotent, static-safe, and mode bound", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const suffix = randomUUID().replaceAll("-", "");
  const requestId = `slice13-fresh-${suffix}`;
  const staticClient = Object.freeze({
    clientId: `fresh-static-slice13-${suffix}`,
    redirectUris: [`https://fresh.example.test/${suffix}/callback`],
    clientName: `Slice 13 fresh static ${suffix}`,
    tokenEndpointAuthMethod: "none"
  });
  const freshStore = createPostgresOAuthStore({
    ...oauthStoreOptions(
      gatewayDatabaseUrl,
      migration,
      issuer,
      subject,
      agentExternalId
    ),
    freshInstall: true
  });
  let ordinaryStore = null;

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ordinaryStore?.close(),
      async () => freshStore.close(),
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id = ${requestId}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_state_migrations
        WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE client_id = ${staticClient.clientId}
      `,
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "fresh installation integration cleanup failed");
    }
  });

  assert.deepEqual(await freshStore.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });
  assert.deepEqual(await freshStore.synchronizeStaticClients([staticClient]), {
    inserted: 1,
    existing: 0
  });

  const concurrent = await Promise.all([
    freshStore.recordFreshInstall({ confirmation: "fresh_install", requestId }),
    freshStore.recordFreshInstall({ confirmation: "fresh_install", requestId })
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.kind).sort(),
    ["already_fresh_install", "fresh_install"]
  );
  for (const result of concurrent) {
    assert.equal(result.version, LEGACY_STATE_IMPORT_VERSION);
    assert.deepEqual(result.report, {
      clientsImported: 0,
      clientsExisting: 0,
      codesImported: 0,
      codesExpired: 0
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.report), true);
  }
  assert.deepEqual(
    await freshStore.recordFreshInstall({ confirmation: "fresh_install", requestId }),
    {
      kind: "already_fresh_install",
      version: LEGACY_STATE_IMPORT_VERSION,
      report: {
        clientsImported: 0,
        clientsExisting: 0,
        codesImported: 0,
        codesExpired: 0
      }
    }
  );
  assert.deepEqual(await freshStore.checkReadiness(), {
    ready: true,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: true
  });

  const persisted = await ownerSql`
    SELECT
      marker.version,
      pg_catalog.encode(marker.source_checksum, 'hex') AS source_checksum,
      marker.outcome,
      marker.report,
      (SELECT pg_catalog.count(*)::integer
       FROM public.oauth_state_migrations
       WHERE version = ${LEGACY_STATE_IMPORT_VERSION}) AS marker_count,
      (SELECT pg_catalog.count(*)::integer
       FROM public.oauth_audit_events
       WHERE request_id = ${requestId}
         AND event_type = 'legacy_state_import'
         AND outcome = 'fresh_install') AS audit_count
    FROM public.oauth_state_migrations AS marker
    WHERE marker.version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
  assert.equal(persisted.length, 1);
  assert.deepEqual({ ...persisted[0] }, {
    version: LEGACY_STATE_IMPORT_VERSION,
    source_checksum: FRESH_INSTALL_SHA256,
    outcome: "fresh_install",
    report: {
      clientsImported: 0,
      clientsExisting: 0,
      codesImported: 0,
      codesExpired: 0
    },
    marker_count: 1,
    audit_count: 1
  });

  ordinaryStore = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  assert.deepEqual(await ordinaryStore.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });
  await assert.rejects(
    ordinaryStore.recordFreshInstall({ confirmation: "fresh_install", requestId }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "invalid_input"
  );
  assert.equal((await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_audit_events
    WHERE request_id = ${requestId}
  `)[0].count, 1);
});

test("authorization exchange is one-time, rollback-safe, superseding, and restart-live", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  let store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice3-${suffix}`;
  const clients = [];
  let failureTriggerInstalled = false;
  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`DROP TRIGGER IF EXISTS slice6_fail_refresh_audit ON public.oauth_audit_events`,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice6_fail_refresh_audit()`,
      async () => ownerSql`DROP TRIGGER IF EXISTS slice3_fail_exchange_audit ON public.oauth_audit_events`,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice3_fail_exchange_audit()`,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ANY(${ownerSql.array(clients.map((client) => client.id))}::uuid[])
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ANY(${ownerSql.array(clients.map((client) => client.id))}::uuid[])
          AND status = 'superseded'
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ANY(${ownerSql.array(clients.map((client) => client.id))}::uuid[])
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE id = ANY(${ownerSql.array(clients.map((client) => client.id))}::uuid[])
      `,
      async () => store?.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "authorization exchange integration cleanup failed");
    }
  });

  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = "https://cortex.example.test/mcp";
  const scopes = ["cortex:read", "mcp"];
  const codeChallenge = "A".repeat(43);
  const bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);
  assert.equal(bootstrap.subject, subject);
  assert.equal(bootstrap.agentExternalId, agentExternalId);

  const primaryClient = await store.registerDynamicClient({
    redirectUris: [redirectUri],
    clientName: `Slice 3 primary ${suffix}`
  });
  assert.ok(primaryClient);
  clients.push(primaryClient);

  assert.equal(await store.createAuthorization({
    codeDigest: randomBytes(32),
    authenticatedContext: bootstrap,
    clientId: primaryClient.clientId,
    redirectUri,
    scopes,
    codeChallenge,
    resource: "https://foreign.example.test/mcp",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    requestId: `${requestPrefix}-create-foreign-resource`,
    ipFingerprint: null,
    userAgentFingerprint: null
  }), null);

  const primaryDigest = randomBytes(32);
  assert.equal(await store.createAuthorization({
    codeDigest: primaryDigest,
    authenticatedContext: bootstrap,
    clientId: primaryClient.clientId,
    redirectUri,
    scopes,
    codeChallenge,
    resource,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    requestId: `${requestPrefix}-create-primary`,
    ipFingerprint: randomBytes(32),
    userAgentFingerprint: randomBytes(32)
  }), undefined);
  const codeRows = await ownerSql`
    SELECT
      code_digest,
      authentication_epoch,
      binding_version,
      consumed_at,
      scopes::text[] AS scopes,
      resource
    FROM public.oauth_authorization_codes
    WHERE code_digest = ${primaryDigest}
  `;
  assert.equal(codeRows.length, 1);
  assert.deepEqual(Buffer.from(codeRows[0].code_digest), Buffer.from(primaryDigest));
  assert.equal(codeRows[0].authentication_epoch, bootstrap.authenticationEpoch);
  assert.equal(codeRows[0].binding_version, bootstrap.bindingVersion);
  assert.equal(codeRows[0].consumed_at, null);
  assert.deepEqual(codeRows[0].scopes, scopes);
  assert.equal(codeRows[0].resource, resource);

  await store.close();
  store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const baseExchange = {
    codeDigest: primaryDigest,
    clientId: primaryClient.clientId,
    redirectUri,
    codeChallenge,
    requestId: `${requestPrefix}-exchange-primary`
  };
  for (const invalid of [
    { redirectUri: `${redirectUri}/wrong` },
    { clientId: `chatgpt-${randomBytes(18).toString("base64url")}` },
    { resource: `${resource}/wrong` },
    { scopes: ["cortex:read"] },
    { codeChallenge: "B".repeat(43) }
  ]) {
    assert.equal(
      await store.exchangeAuthorizationCode({
        ...baseExchange,
        ...invalid,
        ...exchangeMaterial()
      }),
      null
    );
  }
  const unchangedAfterInvalid = await ownerSql`
    SELECT consumed_at IS NULL AS unconsumed
    FROM public.oauth_authorization_codes
    WHERE code_digest = ${primaryDigest}
  `;
  assert.equal(unchangedAfterInvalid.length, 1);
  assert.equal(unchangedAfterInvalid[0]?.unconsumed, true);

  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice3_fail_exchange_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'authorization_code_exchange' THEN
        RAISE EXCEPTION 'injected Slice 3 audit failure';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice3_fail_exchange_audit
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice3_fail_exchange_audit();
  `);
  failureTriggerInstalled = true;
  await assert.rejects(
    store.exchangeAuthorizationCode({
      ...baseExchange,
      ...exchangeMaterial(),
      requestId: `${requestPrefix}-exchange-injected-failure`
    }),
    OAuthStoreUnavailableError
  );
  await ownerSql`DROP TRIGGER slice3_fail_exchange_audit ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice3_fail_exchange_audit()`;
  failureTriggerInstalled = false;
  assert.equal(failureTriggerInstalled, false);
  const rolledBack = await ownerSql`
    SELECT
      (SELECT consumed_at IS NULL FROM public.oauth_authorization_codes WHERE code_digest = ${primaryDigest}) AS code_unconsumed,
      NOT EXISTS (SELECT 1 FROM public.oauth_grants WHERE oauth_client_id = ${primaryClient.id}) AS no_grant,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_refresh_tokens AS refresh
        JOIN public.oauth_grants AS grant_row ON grant_row.id = refresh.grant_id
        WHERE grant_row.oauth_client_id = ${primaryClient.id}
      ) AS no_refresh,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_audit_events
        WHERE request_id = ${`${requestPrefix}-exchange-injected-failure`}
      ) AS no_audit
  `;
  assert.equal(rolledBack.length, 1);
  assert.deepEqual({ ...rolledBack[0] }, {
    code_unconsumed: true,
    no_grant: true,
    no_refresh: true,
    no_audit: true
  });

  const primaryMaterial = exchangeMaterial();
  const primaryGrant = await store.exchangeAuthorizationCode({
    ...baseExchange,
    ...primaryMaterial,
    resource: null,
    scopes: null
  });
  assert.ok(primaryGrant);
  assert.equal(primaryGrant.sid, primaryMaterial.grantId);
  assert.deepEqual([...primaryGrant.scopes], scopes);
  assert.equal(primaryGrant.resource, resource);

  const claims = {
    iss: issuer,
    sub: subject,
    aud: primaryGrant.resource,
    scope: primaryGrant.scopes.join(" "),
    client_id: primaryGrant.clientId,
    token_use: "access",
    sid: primaryGrant.sid,
    agent_id: primaryGrant.agentExternalId,
    auth_epoch: primaryGrant.authenticationEpoch,
    binding_version: primaryGrant.bindingVersion,
    jti: randomBytes(18).toString("base64url"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  assert.equal((await store.resolveAccessContext({ claims })).kind, "active");
  for (const missing of ["jti", "iat", "exp"]) {
    const malformed = { ...claims };
    delete malformed[missing];
    assert.deepEqual(await store.resolveAccessContext({ claims: malformed }), { kind: "invalid" });
  }
  assert.deepEqual(
    await store.resolveAccessContext({ claims: { ...claims, iss: "https://foreign.example.test" } }),
    { kind: "invalid" }
  );

  await store.close();
  store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  assert.equal((await store.resolveAccessContext({ claims })).kind, "active");

  const presentedRefresh = Object.freeze({
    issuer,
    subject,
    resource: primaryGrant.resource,
    scopes: Object.freeze([...primaryGrant.scopes]),
    clientId: primaryGrant.clientId,
    sid: primaryGrant.sid,
    agentExternalId: primaryGrant.agentExternalId,
    authenticationEpoch: primaryGrant.authenticationEpoch,
    bindingVersion: primaryGrant.bindingVersion,
    generation: 0,
    issuedAt: new Date(
      Math.floor(primaryMaterial.refresh.issuedAt.getTime() / 1_000) * 1_000
    ),
    expiresAt: new Date(
      Math.floor(primaryMaterial.refresh.expiresAt.getTime() / 1_000) * 1_000
    )
  });
  const rotationFingerprint = randomBytes(32);
  const narrowedScopes = ["cortex:read"];
  const rotationInput = (candidate, requestId) => ({
    token: presentedRefresh,
    presentedJtiDigest: primaryMaterial.refresh.jtiDigest,
    clientId: primaryGrant.clientId,
    resource: primaryGrant.resource,
    effectiveScopes: narrowedScopes,
    requestFingerprint: rotationFingerprint,
    replacement: {
      generation: 1,
      jtiDigest: candidate.jtiDigest,
      reconstructionNonce: candidate.reconstructionNonce
    },
    refreshTokenTtlSeconds: 3600,
    retryGraceSeconds: 30,
    requestId,
    ipFingerprint: null,
    userAgentFingerprint: null
  });

  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice6_fail_refresh_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'refresh_rotation' THEN
        RAISE EXCEPTION 'injected Slice 6 audit failure';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice6_fail_refresh_audit
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice6_fail_refresh_audit();
  `);
  const failedRefreshCandidate = {
    jtiDigest: randomBytes(32),
    reconstructionNonce: randomBytes(32)
  };
  await assert.rejects(
    store.rotateRefreshToken(rotationInput(
      failedRefreshCandidate,
      `${requestPrefix}-refresh-injected-failure`
    )),
    (error) => assertGenericStoreError(error, [
      primaryMaterial.refresh.jtiDigest,
      rotationFingerprint,
      failedRefreshCandidate.jtiDigest,
      failedRefreshCandidate.reconstructionNonce
    ])
  );
  await ownerSql`DROP TRIGGER slice6_fail_refresh_audit ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice6_fail_refresh_audit()`;
  const refreshRollback = await ownerSql`
    SELECT
      grant_row.current_refresh_generation,
      refresh.consumed_at,
      refresh.replacement_generation,
      refresh.retry_deadline,
      refresh.request_fingerprint,
      NOT EXISTS (
        SELECT 1
        FROM public.oauth_refresh_tokens AS replacement
        WHERE replacement.grant_id = ${primaryGrant.sid}
          AND replacement.generation = 1
      ) AS no_replacement,
      NOT EXISTS (
        SELECT 1
        FROM public.oauth_audit_events AS audit
        WHERE audit.request_id = ${`${requestPrefix}-refresh-injected-failure`}
      ) AS no_audit
    FROM public.oauth_grants AS grant_row
    INNER JOIN public.oauth_refresh_tokens AS refresh
      ON refresh.grant_id = grant_row.id
      AND refresh.generation = 0
    WHERE grant_row.id = ${primaryGrant.sid}
  `;
  assert.deepEqual({ ...refreshRollback[0] }, {
    current_refresh_generation: 0,
    consumed_at: null,
    replacement_generation: null,
    retry_deadline: null,
    request_fingerprint: null,
    no_replacement: true,
    no_audit: true
  });

  const refreshCandidates = [0, 1].map(() => ({
    jtiDigest: randomBytes(32),
    reconstructionNonce: randomBytes(32)
  }));
  let markClientLocked;
  let releaseClientLock;
  const clientLocked = new Promise((resolvePromise) => {
    markClientLocked = resolvePromise;
  });
  const clientLockReleased = new Promise((resolvePromise) => {
    releaseClientLock = resolvePromise;
  });
  const clientBlocker = ownerSql.begin(async (transaction) => {
    await transaction`
      SELECT id
      FROM public.oauth_clients
      WHERE id = ${primaryClient.id}
      FOR UPDATE
    `;
    markClientLocked();
    await clientLockReleased;
  });
  await clientLocked;

  let refreshDecisions;
  let lockTimeout;
  let rotations;
  try {
    rotations = Promise.all(refreshCandidates.map((candidate, index) =>
      store.rotateRefreshToken(rotationInput(
        candidate,
        `${requestPrefix}-refresh-concurrent-${index}`
      ))
    ));
    refreshDecisions = await Promise.race([
      rotations,
      new Promise((_, reject) => {
        lockTimeout = setTimeout(() => {
          reject(new Error("refresh rotation waited on the audit client FK"));
        }, 10_000);
      })
    ]);
  } finally {
    clearTimeout(lockTimeout);
    releaseClientLock();
    await clientBlocker;
    if (!refreshDecisions && rotations) await rotations.catch(() => {});
  }
  assert.deepEqual(
    refreshDecisions.map((decision) => decision.kind).sort(),
    ["retry", "rotated"]
  );
  for (const decision of refreshDecisions) {
    assert.equal(decision.grant.sid, primaryGrant.sid);
    assert.deepEqual([...decision.grant.scopes], narrowedScopes);
    assert.equal(decision.refresh.generation, 1);
  }
  assert.deepEqual(
    Buffer.from(refreshDecisions[0].refresh.reconstructionNonce),
    Buffer.from(refreshDecisions[1].refresh.reconstructionNonce)
  );
  assert.equal(
    refreshDecisions[0].refresh.issuedAt.getTime(),
    refreshDecisions[1].refresh.issuedAt.getTime()
  );
  assert.equal(
    refreshDecisions[0].refresh.expiresAt.getTime(),
    refreshDecisions[1].refresh.expiresAt.getTime()
  );

  await store.close();
  store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const restartedCandidate = {
    jtiDigest: randomBytes(32),
    reconstructionNonce: randomBytes(32)
  };
  const restartedRetry = await store.rotateRefreshToken(rotationInput(
    restartedCandidate,
    `${requestPrefix}-refresh-after-restart`
  ));
  assert.equal(restartedRetry.kind, "retry");
  assert.deepEqual(
    Buffer.from(restartedRetry.refresh.reconstructionNonce),
    Buffer.from(refreshDecisions[0].refresh.reconstructionNonce)
  );
  assert.equal(
    restartedRetry.refresh.issuedAt.getTime(),
    refreshDecisions[0].refresh.issuedAt.getTime()
  );
  assert.equal(
    restartedRetry.refresh.expiresAt.getTime(),
    refreshDecisions[0].refresh.expiresAt.getTime()
  );

  const refreshPersistence = await ownerSql`
    SELECT
      grant_row.current_refresh_generation,
      grant_row.refreshed_at,
      grant_row.inactivity_expires_at,
      parent.consumed_at,
      parent.replacement_generation,
      parent.retry_deadline,
      parent.request_fingerprint,
      replacement.generation,
      replacement.jti_digest,
      replacement.reconstruction_nonce,
      replacement.effective_scopes::text[] AS effective_scopes,
      replacement.issued_at,
      replacement.expires_at,
      replacement.consumed_at AS replacement_consumed_at
    FROM public.oauth_grants AS grant_row
    INNER JOIN public.oauth_refresh_tokens AS parent
      ON parent.grant_id = grant_row.id
      AND parent.generation = 0
    INNER JOIN public.oauth_refresh_tokens AS replacement
      ON replacement.grant_id = grant_row.id
      AND replacement.generation = 1
    WHERE grant_row.id = ${primaryGrant.sid}
  `;
  assert.equal(refreshPersistence.length, 1);
  const persistedRefresh = refreshPersistence[0];
  assert.equal(persistedRefresh.current_refresh_generation, 1);
  assert.ok(persistedRefresh.refreshed_at);
  assert.ok(persistedRefresh.consumed_at);
  assert.equal(persistedRefresh.replacement_generation, 1);
  assert.equal(
    persistedRefresh.retry_deadline.getTime() -
      persistedRefresh.consumed_at.getTime(),
    30_000
  );
  assert.deepEqual(
    Buffer.from(persistedRefresh.request_fingerprint),
    Buffer.from(rotationFingerprint)
  );
  assert.deepEqual(persistedRefresh.effective_scopes, narrowedScopes);
  assert.equal(persistedRefresh.replacement_consumed_at, null);
  assert.equal(
    persistedRefresh.inactivity_expires_at.getTime(),
    persistedRefresh.expires_at.getTime()
  );
  assert.equal(
    persistedRefresh.expires_at.getTime() - persistedRefresh.issued_at.getTime(),
    3600 * 1_000
  );
  assert.deepEqual(
    Buffer.from(persistedRefresh.reconstruction_nonce),
    Buffer.from(refreshDecisions[0].refresh.reconstructionNonce)
  );
  assert.ok(refreshCandidates.some((candidate) =>
    Buffer.from(candidate.jtiDigest).equals(Buffer.from(persistedRefresh.jti_digest))
  ));
  assert.equal(
    Buffer.from(restartedCandidate.jtiDigest)
      .equals(Buffer.from(persistedRefresh.jti_digest)),
    false
  );
  const refreshAudits = await ownerSql`
    SELECT
      outcome,
      metadata,
      grant_id,
      principal_id,
      binding_id,
      oauth_client_id
    FROM public.oauth_audit_events
    WHERE request_id LIKE ${`${requestPrefix}-refresh%`}
    ORDER BY created_at, request_id
  `;
  assert.deepEqual(
    refreshAudits.map((audit) => audit.outcome).sort(),
    ["retry", "retry", "rotated"]
  );
  for (const audit of refreshAudits) {
    assert.deepEqual(audit.metadata, {
      presented_generation: 0,
      replacement_generation: 1
    });
    assert.equal(audit.grant_id, primaryGrant.sid);
    assert.equal(audit.principal_id, null);
    assert.equal(audit.binding_id, null);
    assert.equal(audit.oauth_client_id, null);
  }

  const narrowedClaims = { ...claims, scope: narrowedScopes.join(" ") };
  const narrowedAccess = await store.resolveAccessContext({ claims: narrowedClaims });
  assert.equal(narrowedAccess.kind, "active");
  assert.deepEqual([...narrowedAccess.context.scopes], narrowedScopes);

  const unrelatedClient = await store.registerDynamicClient({
    redirectUris: [redirectUri],
    clientName: `Slice 3 unrelated ${suffix}`
  });
  assert.ok(unrelatedClient);
  clients.push(unrelatedClient);
  const unrelatedDigest = randomBytes(32);
  assert.equal(await store.createAuthorization({
    codeDigest: unrelatedDigest,
    authenticatedContext: bootstrap,
    clientId: unrelatedClient.clientId,
    redirectUri,
    scopes,
    codeChallenge,
    resource,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    requestId: `${requestPrefix}-create-unrelated`,
    ipFingerprint: null,
    userAgentFingerprint: null
  }), undefined);
  const unrelatedGrant = await store.exchangeAuthorizationCode({
    codeDigest: unrelatedDigest,
    clientId: unrelatedClient.clientId,
    redirectUri,
    codeChallenge,
    ...exchangeMaterial(),
    requestId: `${requestPrefix}-exchange-unrelated`
  });
  assert.ok(unrelatedGrant);

  const issuerResourceBase = issuer.replace(/\/+$/, "");
  const issuerResourceGrants = [];
  for (const [index, acceptedResource] of [
    issuerResourceBase,
    `${issuerResourceBase}/`
  ].entries()) {
    const issuerResourceDigest = randomBytes(32);
    assert.equal(await store.createAuthorization({
      codeDigest: issuerResourceDigest,
      authenticatedContext: bootstrap,
      clientId: unrelatedClient.clientId,
      redirectUri,
      scopes,
      codeChallenge,
      resource: acceptedResource,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      requestId: `${requestPrefix}-create-issuer-resource-${index}`,
      ipFingerprint: null,
      userAgentFingerprint: null
    }), undefined);
    const issuerResourceGrant = await store.exchangeAuthorizationCode({
      codeDigest: issuerResourceDigest,
      clientId: unrelatedClient.clientId,
      redirectUri,
      scopes,
      codeChallenge,
      resource: acceptedResource,
      ...exchangeMaterial(),
      requestId: `${requestPrefix}-exchange-issuer-resource-${index}`
    });
    assert.ok(issuerResourceGrant);
    assert.equal(issuerResourceGrant.resource, acceptedResource);
    issuerResourceGrants.push(issuerResourceGrant);
    assert.equal((await store.resolveAccessContext({ claims: {
      ...claims,
      sid: issuerResourceGrant.sid,
      aud: issuerResourceGrant.resource,
      client_id: issuerResourceGrant.clientId,
      agent_id: issuerResourceGrant.agentExternalId,
      auth_epoch: issuerResourceGrant.authenticationEpoch,
      binding_version: issuerResourceGrant.bindingVersion
    } })).kind, "active");
  }
  const foreignResource = "https://foreign.example.test/mcp";
  await ownerSql`
    UPDATE public.oauth_grants
    SET resource = ${foreignResource}
    WHERE id = ${issuerResourceGrants[0].sid}
  `;
  assert.deepEqual(await store.resolveAccessContext({ claims: {
    ...claims,
    sid: issuerResourceGrants[0].sid,
    aud: foreignResource,
    client_id: issuerResourceGrants[0].clientId,
    agent_id: issuerResourceGrants[0].agentExternalId,
    auth_epoch: issuerResourceGrants[0].authenticationEpoch,
    binding_version: issuerResourceGrants[0].bindingVersion
  } }), { kind: "invalid" });

  const replacementDigest = randomBytes(32);
  assert.equal(await store.createAuthorization({
    codeDigest: replacementDigest,
    authenticatedContext: bootstrap,
    clientId: primaryClient.clientId,
    redirectUri,
    scopes,
    codeChallenge,
    resource,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    requestId: `${requestPrefix}-create-replacement`,
    ipFingerprint: null,
    userAgentFingerprint: null
  }), undefined);
  const contenders = [exchangeMaterial(), exchangeMaterial()];
  const concurrentResults = await Promise.all(contenders.map((material, index) =>
    store.exchangeAuthorizationCode({
      codeDigest: replacementDigest,
      clientId: primaryClient.clientId,
      redirectUri,
      codeChallenge,
      ...material,
      requestId: `${requestPrefix}-exchange-replacement-${index}`
    })
  ));
  assert.equal(concurrentResults.filter(Boolean).length, 1);
  assert.equal(concurrentResults.filter((result) => result === null).length, 1);
  const replacementGrant = concurrentResults.find(Boolean);
  assert.ok(replacementGrant);

  const authorityRows = await ownerSql`
    SELECT id, oauth_client_id, status, superseded_by
    FROM public.oauth_grants
    WHERE oauth_client_id = ANY(${ownerSql.array(clients.map((client) => client.id))}::uuid[])
    ORDER BY created_at, id
  `;
  const primaryOld = authorityRows.find((row) => row.id === primaryGrant.sid);
  const primaryNew = authorityRows.find((row) => row.id === replacementGrant.sid);
  const unrelated = authorityRows.find((row) => row.id === unrelatedGrant.sid);
  assert.deepEqual(
    { status: primaryOld?.status, supersededBy: primaryOld?.superseded_by },
    { status: "superseded", supersededBy: replacementGrant.sid }
  );
  assert.equal(primaryNew?.status, "active");
  assert.equal(unrelated?.status, "active");
  assert.deepEqual(await store.resolveAccessContext({ claims }), { kind: "revoked" });
  const persisted = await ownerSql`
    SELECT
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_refresh_tokens AS refresh
       JOIN public.oauth_grants AS grant_row ON grant_row.id = refresh.grant_id
       WHERE grant_row.oauth_client_id = ANY(${ownerSql.array(clients.map((client) => client.id))}::uuid[])) AS refresh_count,
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_audit_events
       WHERE request_id LIKE ${`${requestPrefix}-exchange%`}
         AND event_type = 'authorization_code_exchange') AS exchange_audit_count
  `;
  assert.equal(persisted.length, 1);
  assert.deepEqual(
    { ...persisted[0] },
    { refresh_count: 6, exchange_audit_count: 5 }
  );

  const unavailableUrl = new URL(gatewayDatabaseUrl);
  unavailableUrl.port = "1";
  const unavailableStore = createPostgresOAuthStore(
    oauthStoreOptions(unavailableUrl.toString(), migration, issuer, subject, agentExternalId)
  );
  try {
    await assert.rejects(
      unavailableStore.resolveAccessContext({ claims: {
        ...claims,
        sid: replacementGrant.sid
      } }),
      OAuthStoreUnavailableError
    );
  } finally {
    await unavailableStore.close();
  }
});

test("refresh replay atomically revokes its family and cannot race access back to life", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 6 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice7-${suffix}`;
  const clients = [];

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DROP TRIGGER IF EXISTS slice7_audit_barrier ON public.oauth_audit_events
      `,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice7_audit_barrier()`,
      async () => ownerSql`
        DROP TRIGGER IF EXISTS slice7_fail_replay_audit ON public.oauth_audit_events
      `,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice7_fail_replay_audit()`,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ANY(
          ${ownerSql.array(clients.map((client) => client.id))}::uuid[]
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ANY(
          ${ownerSql.array(clients.map((client) => client.id))}::uuid[]
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE id = ANY(
          ${ownerSql.array(clients.map((client) => client.id))}::uuid[]
        )
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "refresh replay integration cleanup failed");
    }
  });

  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = "https://cortex.example.test/mcp";
  const scopes = ["cortex:read", "mcp"];
  const codeChallenge = "A".repeat(43);
  const bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);

  const floorToSeconds = (date) => new Date(
    Math.floor(date.getTime() / 1_000) * 1_000
  );
  const refreshState = (grant, descriptor, jtiDigest) => Object.freeze({
    grant,
    token: Object.freeze({
      issuer,
      subject: grant.subject,
      resource: grant.resource,
      scopes: Object.freeze([...grant.scopes]),
      clientId: grant.clientId,
      sid: grant.sid,
      agentExternalId: grant.agentExternalId,
      authenticationEpoch: grant.authenticationEpoch,
      bindingVersion: grant.bindingVersion,
      generation: descriptor.generation,
      issuedAt: floorToSeconds(descriptor.issuedAt),
      expiresAt: floorToSeconds(descriptor.expiresAt)
    }),
    jtiDigest: Buffer.from(jtiDigest)
  });
  const accessClaims = (grant) => ({
    iss: issuer,
    sub: grant.subject,
    aud: grant.resource,
    scope: grant.scopes.join(" "),
    client_id: grant.clientId,
    token_use: "access",
    sid: grant.sid,
    agent_id: grant.agentExternalId,
    auth_epoch: grant.authenticationEpoch,
    binding_version: grant.bindingVersion,
    jti: randomBytes(18).toString("base64url"),
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 3600
  });
  const replacementCandidate = () => ({
    jtiDigest: randomBytes(32),
    reconstructionNonce: randomBytes(32)
  });
  const rotationInput = (
    state,
    { requestFingerprint, candidate, requestId, presentedJtiDigest = state.jtiDigest }
  ) => ({
    token: state.token,
    presentedJtiDigest,
    clientId: state.grant.clientId,
    resource: state.grant.resource,
    effectiveScopes: [...state.token.scopes],
    requestFingerprint,
    replacement: {
      generation: state.token.generation + 1,
      jtiDigest: candidate.jtiDigest,
      reconstructionNonce: candidate.reconstructionNonce
    },
    refreshTokenTtlSeconds: 3600,
    retryGraceSeconds: 30,
    requestId,
    ipFingerprint: null,
    userAgentFingerprint: null
  });

  async function createFamily(label) {
    const client = await store.registerDynamicClient({
      redirectUris: [redirectUri],
      clientName: `Slice 7 ${label} ${suffix}`
    });
    assert.ok(client);
    clients.push(client);
    const codeDigest = randomBytes(32);
    assert.equal(await store.createAuthorization({
      codeDigest,
      authenticatedContext: bootstrap,
      clientId: client.clientId,
      redirectUri,
      scopes,
      codeChallenge,
      resource,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      requestId: `${requestPrefix}-${label}-authorize`,
      ipFingerprint: null,
      userAgentFingerprint: null
    }), undefined);
    const material = exchangeMaterial();
    const grant = await store.exchangeAuthorizationCode({
      codeDigest,
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      ...material,
      requestId: `${requestPrefix}-${label}-exchange`
    });
    assert.ok(grant);
    const initialState = refreshState(grant, material.refresh, material.refresh.jtiDigest);
    const claims = accessClaims(grant);
    assert.equal((await store.resolveAccessContext({ claims })).kind, "active");
    return { client, grant, material, initialState, claims };
  }

  async function rotate(state, requestFingerprint, requestId) {
    const candidate = replacementCandidate();
    const decision = await store.rotateRefreshToken(rotationInput(state, {
      requestFingerprint,
      candidate,
      requestId
    }));
    assert.equal(decision.kind, "rotated");
    return {
      candidate,
      decision,
      state: refreshState(decision.grant, decision.refresh, candidate.jtiDigest)
    };
  }

  async function assertFamilyRevoked({
    family,
    replayRequestId,
    replayReason,
    presentedGeneration,
    currentGeneration,
    latestState,
    refreshCount
  }) {
    const rows = await ownerSql`
      SELECT
        grant_row.status,
        grant_row.current_refresh_generation,
        grant_row.revoked_at,
        grant_row.revoked_reason,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
        ) AS refresh_count,
        NOT EXISTS (
          SELECT 1
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
            AND refresh.expires_at > GREATEST(
              grant_row.revoked_at,
              refresh.issued_at + INTERVAL '1 microsecond'
            )
        ) AS all_refresh_clipped
      FROM public.oauth_grants AS grant_row
      WHERE grant_row.id = ${family.grant.sid}
    `;
    assert.equal(rows.length, 1);
    assert.deepEqual({
      status: rows[0].status,
      currentGeneration: rows[0].current_refresh_generation,
      revokedReason: rows[0].revoked_reason,
      refreshCount: rows[0].refresh_count,
      allRefreshClipped: rows[0].all_refresh_clipped
    }, {
      status: "revoked",
      currentGeneration,
      revokedReason: "refresh_replay_detected",
      refreshCount,
      allRefreshClipped: true
    });
    assert.ok(rows[0].revoked_at);

    const audits = await ownerSql`
      SELECT
        event_type,
        outcome,
        grant_id,
        principal_id,
        binding_id,
        oauth_client_id,
        request_id,
        metadata,
        created_at
      FROM public.oauth_audit_events
      WHERE grant_id = ${family.grant.sid}
        AND event_type = 'refresh_replay'
      ORDER BY created_at, id
    `;
    assert.equal(audits.length, 1);
    assert.deepEqual({
      eventType: audits[0].event_type,
      outcome: audits[0].outcome,
      grantId: audits[0].grant_id,
      principalId: audits[0].principal_id,
      bindingId: audits[0].binding_id,
      oauthClientId: audits[0].oauth_client_id,
      requestId: audits[0].request_id,
      metadata: audits[0].metadata
    }, {
      eventType: "refresh_replay",
      outcome: "revoked",
      grantId: family.grant.sid,
      principalId: null,
      bindingId: null,
      oauthClientId: null,
      requestId: replayRequestId,
      metadata: {
        reason: replayReason,
        presented_generation: presentedGeneration,
        current_generation: currentGeneration
      }
    });
    assert.equal(audits[0].created_at.getTime(), rows[0].revoked_at.getTime());
    assert.deepEqual(
      await store.resolveAccessContext({ claims: family.claims }),
      { kind: "revoked" }
    );
    const afterRevocation = await store.rotateRefreshToken(rotationInput(latestState, {
      requestFingerprint: randomBytes(32),
      candidate: replacementCandidate(),
      requestId: `${requestPrefix}-post-revocation-${randomUUID()}`
    }));
    assert.deepEqual(afterRevocation, { kind: "revoked" });
    const auditCount = await ownerSql`
      SELECT pg_catalog.count(*)::integer AS count
      FROM public.oauth_audit_events
      WHERE grant_id = ${family.grant.sid}
        AND event_type = 'refresh_replay'
    `;
    assert.equal(auditCount[0].count, 1);
  }

  const unrelatedFamily = await createFamily("unrelated");
  const rollbackFamily = await createFamily("fingerprint-rollback");
  const rollbackFingerprint = randomBytes(32);
  const rollbackRotation = await rotate(
    rollbackFamily.initialState,
    rollbackFingerprint,
    `${requestPrefix}-fingerprint-rollback-rotate`
  );
  const beforeInjectedFailure = await ownerSql`
    SELECT
      grant_row.status,
      grant_row.current_refresh_generation,
      grant_row.revoked_at,
      grant_row.revoked_reason,
      grant_row.updated_at,
      refresh.generation,
      refresh.expires_at
    FROM public.oauth_grants AS grant_row
    INNER JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
    WHERE grant_row.id = ${rollbackFamily.grant.sid}
    ORDER BY refresh.generation
  `;
  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice7_fail_replay_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'refresh_replay' THEN
        RAISE EXCEPTION 'injected Slice 7 replay audit failure';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice7_fail_replay_audit
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice7_fail_replay_audit();
  `);
  const failedReplayFingerprint = randomBytes(32);
  const failedReplayCandidate = replacementCandidate();
  const failedReplayRequestId = `${requestPrefix}-fingerprint-injected-failure`;
  await assert.rejects(
    store.rotateRefreshToken(rotationInput(rollbackFamily.initialState, {
      requestFingerprint: failedReplayFingerprint,
      candidate: failedReplayCandidate,
      requestId: failedReplayRequestId
    })),
    (error) => assertGenericStoreError(error, [
      rollbackFamily.initialState.jtiDigest,
      failedReplayFingerprint,
      failedReplayCandidate.jtiDigest,
      failedReplayCandidate.reconstructionNonce
    ])
  );
  await ownerSql`DROP TRIGGER slice7_fail_replay_audit ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice7_fail_replay_audit()`;
  const afterInjectedFailure = await ownerSql`
    SELECT
      grant_row.status,
      grant_row.current_refresh_generation,
      grant_row.revoked_at,
      grant_row.revoked_reason,
      grant_row.updated_at,
      refresh.generation,
      refresh.expires_at
    FROM public.oauth_grants AS grant_row
    INNER JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
    WHERE grant_row.id = ${rollbackFamily.grant.sid}
    ORDER BY refresh.generation
  `;
  assert.deepEqual(afterInjectedFailure, beforeInjectedFailure);
  assert.equal((await store.resolveAccessContext({ claims: rollbackFamily.claims })).kind, "active");
  const failedReplayAudits = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_audit_events
    WHERE request_id = ${failedReplayRequestId}
  `;
  assert.equal(failedReplayAudits[0].count, 0);
  const exactRetry = await store.rotateRefreshToken(rotationInput(
    rollbackFamily.initialState,
    {
      requestFingerprint: rollbackFingerprint,
      candidate: replacementCandidate(),
      requestId: `${requestPrefix}-fingerprint-after-rollback-retry`
    }
  ));
  assert.equal(exactRetry.kind, "retry");
  const mismatchReplayRequestId = `${requestPrefix}-fingerprint-replay`;
  assert.deepEqual(await store.rotateRefreshToken(rotationInput(
    rollbackFamily.initialState,
    {
      requestFingerprint: failedReplayFingerprint,
      candidate: replacementCandidate(),
      requestId: mismatchReplayRequestId
    }
  )), { kind: "replay", sid: rollbackFamily.grant.sid });
  await assertFamilyRevoked({
    family: rollbackFamily,
    replayRequestId: mismatchReplayRequestId,
    replayReason: "request_fingerprint_mismatch",
    presentedGeneration: 0,
    currentGeneration: 1,
    latestState: rollbackRotation.state,
    refreshCount: 2
  });

  const lateFamily = await createFamily("late");
  const lateFingerprint = randomBytes(32);
  const lateRotation = await rotate(
    lateFamily.initialState,
    lateFingerprint,
    `${requestPrefix}-late-rotate`
  );
  await ownerSql`
    UPDATE public.oauth_refresh_tokens
    SET retry_deadline = consumed_at
    WHERE grant_id = ${lateFamily.grant.sid}
      AND generation = 0
  `;
  const lateReplayRequestId = `${requestPrefix}-late-replay`;
  assert.deepEqual(await store.rotateRefreshToken(rotationInput(lateFamily.initialState, {
    requestFingerprint: lateFingerprint,
    candidate: replacementCandidate(),
    requestId: lateReplayRequestId
  })), { kind: "replay", sid: lateFamily.grant.sid });
  await assertFamilyRevoked({
    family: lateFamily,
    replayRequestId: lateReplayRequestId,
    replayReason: "retry_window_elapsed",
    presentedGeneration: 0,
    currentGeneration: 1,
    latestState: lateRotation.state,
    refreshCount: 2
  });

  const olderFamily = await createFamily("older");
  const olderFirstRotation = await rotate(
    olderFamily.initialState,
    randomBytes(32),
    `${requestPrefix}-older-rotate-0`
  );
  const olderSecondRotation = await rotate(
    olderFirstRotation.state,
    randomBytes(32),
    `${requestPrefix}-older-rotate-1`
  );
  const olderReplayRequestId = `${requestPrefix}-older-replay`;
  assert.deepEqual(await store.rotateRefreshToken(rotationInput(olderFamily.initialState, {
    requestFingerprint: randomBytes(32),
    candidate: replacementCandidate(),
    requestId: olderReplayRequestId
  })), { kind: "replay", sid: olderFamily.grant.sid });
  await assertFamilyRevoked({
    family: olderFamily,
    replayRequestId: olderReplayRequestId,
    replayReason: "older_generation",
    presentedGeneration: 0,
    currentGeneration: 2,
    latestState: olderSecondRotation.state,
    refreshCount: 3
  });

  const unknownJtiFamily = await createFamily("unknown-jti");
  const unknownJtiReplayRequestId = `${requestPrefix}-unknown-jti-replay`;
  assert.deepEqual(await store.rotateRefreshToken(rotationInput(
    unknownJtiFamily.initialState,
    {
      requestFingerprint: randomBytes(32),
      candidate: replacementCandidate(),
      requestId: unknownJtiReplayRequestId,
      presentedJtiDigest: randomBytes(32)
    }
  )), { kind: "replay", sid: unknownJtiFamily.grant.sid });
  await assertFamilyRevoked({
    family: unknownJtiFamily,
    replayRequestId: unknownJtiReplayRequestId,
    replayReason: "unknown_jti",
    presentedGeneration: 0,
    currentGeneration: 0,
    latestState: unknownJtiFamily.initialState,
    refreshCount: 1
  });

  const simultaneousFamily = await createFamily("simultaneous-replay");
  const simultaneousRequestIds = [0, 1].map(
    (index) => `${requestPrefix}-simultaneous-replay-${index}`
  );
  const simultaneousDecisions = await Promise.all(simultaneousRequestIds.map(
    (requestId) => store.rotateRefreshToken(rotationInput(
      simultaneousFamily.initialState,
      {
        requestFingerprint: randomBytes(32),
        candidate: replacementCandidate(),
        requestId,
        presentedJtiDigest: randomBytes(32)
      }
    ))
  ));
  assert.deepEqual(
    simultaneousDecisions.map((decision) => decision.kind).sort(),
    ["replay", "revoked"]
  );
  const simultaneousWinner = simultaneousDecisions.findIndex(
    (decision) => decision.kind === "replay"
  );
  await assertFamilyRevoked({
    family: simultaneousFamily,
    replayRequestId: simultaneousRequestIds[simultaneousWinner],
    replayReason: "unknown_jti",
    presentedGeneration: 0,
    currentGeneration: 0,
    latestState: simultaneousFamily.initialState,
    refreshCount: 1
  });

  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice7_audit_barrier()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'refresh_rotation' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(7007001);
      ELSIF NEW.event_type = 'refresh_replay' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(7007002);
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice7_audit_barrier
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice7_audit_barrier();
  `);

  const gatewayRole = decodeURIComponent(new URL(gatewayDatabaseUrl).username);
  async function waitForBlockedSessions(blockerPid, minimumTotal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await ownerSql`
        SELECT
          pg_catalog.count(*) FILTER (
            WHERE ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
          )::integer AS directly_blocked,
          pg_catalog.count(*) FILTER (
            WHERE pg_catalog.cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
          )::integer AS total_blocked
        FROM pg_catalog.pg_stat_activity
        WHERE datname = pg_catalog.current_database()
          AND usename = ${gatewayRole}
      `;
      if (rows[0].directly_blocked >= 1 && rows[0].total_blocked >= minimumTotal) {
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`timed out waiting for ${minimumTotal} blocked refresh transactions`);
  }

  async function runAuditBarrierRace(advisoryKey, firstAction, secondAction) {
    let announceBlocker;
    let releaseBlocker;
    const blockerReady = new Promise((resolvePromise) => {
      announceBlocker = resolvePromise;
    });
    const blockerReleased = new Promise((resolvePromise) => {
      releaseBlocker = resolvePromise;
    });
    const blocker = ownerSql.begin(async (transaction) => {
      const rows = await transaction`
        SELECT
          pg_catalog.pg_advisory_xact_lock(${advisoryKey}),
          pg_catalog.pg_backend_pid() AS pid
      `;
      announceBlocker(rows[0].pid);
      await blockerReleased;
    });
    const blockerPid = await blockerReady;
    let first;
    let second;
    let setupError;
    try {
      first = firstAction();
      await waitForBlockedSessions(blockerPid, 1);
      second = secondAction();
      await waitForBlockedSessions(blockerPid, 2);
    } catch (error) {
      setupError = error;
    } finally {
      releaseBlocker();
    }
    if (setupError) {
      await Promise.allSettled([blocker, first, second].filter(Boolean));
      throw setupError;
    }
    try {
      await blocker;
      return await Promise.all([first, second]);
    } catch (error) {
      await Promise.allSettled([blocker, first, second].filter(Boolean));
      throw error;
    }
  }

  const rotationFirstFamily = await createFamily("race-rotation-first");
  const rotationFirstFingerprint = randomBytes(32);
  const rotationFirstCandidate = replacementCandidate();
  const rotationFirstReplayRequestId = `${requestPrefix}-race-rotation-first-replay`;
  const [rotationFirst, replaySecond] = await runAuditBarrierRace(
    7007001,
    () => store.rotateRefreshToken(rotationInput(rotationFirstFamily.initialState, {
      requestFingerprint: rotationFirstFingerprint,
      candidate: rotationFirstCandidate,
      requestId: `${requestPrefix}-race-rotation-first-rotate`
    })),
    () => store.rotateRefreshToken(rotationInput(rotationFirstFamily.initialState, {
      requestFingerprint: randomBytes(32),
      candidate: replacementCandidate(),
      requestId: rotationFirstReplayRequestId
    }))
  );
  assert.equal(rotationFirst.kind, "rotated");
  assert.deepEqual(replaySecond, { kind: "replay", sid: rotationFirstFamily.grant.sid });
  const rotationFirstLatestState = refreshState(
    rotationFirst.grant,
    rotationFirst.refresh,
    rotationFirstCandidate.jtiDigest
  );
  await assertFamilyRevoked({
    family: rotationFirstFamily,
    replayRequestId: rotationFirstReplayRequestId,
    replayReason: "request_fingerprint_mismatch",
    presentedGeneration: 0,
    currentGeneration: 1,
    latestState: rotationFirstLatestState,
    refreshCount: 2
  });

  const replayFirstFamily = await createFamily("race-replay-first");
  const replayFirstRequestId = `${requestPrefix}-race-replay-first-replay`;
  const [replayFirst, refreshSecond] = await runAuditBarrierRace(
    7007002,
    () => store.rotateRefreshToken(rotationInput(replayFirstFamily.initialState, {
      requestFingerprint: randomBytes(32),
      candidate: replacementCandidate(),
      requestId: replayFirstRequestId,
      presentedJtiDigest: randomBytes(32)
    })),
    () => store.rotateRefreshToken(rotationInput(replayFirstFamily.initialState, {
      requestFingerprint: randomBytes(32),
      candidate: replacementCandidate(),
      requestId: `${requestPrefix}-race-replay-first-refresh`
    }))
  );
  assert.deepEqual(replayFirst, { kind: "replay", sid: replayFirstFamily.grant.sid });
  assert.deepEqual(refreshSecond, { kind: "revoked" });
  await assertFamilyRevoked({
    family: replayFirstFamily,
    replayRequestId: replayFirstRequestId,
    replayReason: "unknown_jti",
    presentedGeneration: 0,
    currentGeneration: 0,
    latestState: replayFirstFamily.initialState,
    refreshCount: 1
  });

  await ownerSql`DROP TRIGGER slice7_audit_barrier ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice7_audit_barrier()`;

  assert.equal(
    (await store.resolveAccessContext({ claims: unrelatedFamily.claims })).kind,
    "active"
  );
  const unrelatedRotation = await rotate(
    unrelatedFamily.initialState,
    randomBytes(32),
    `${requestPrefix}-unrelated-rotate`
  );
  assert.equal(unrelatedRotation.decision.kind, "rotated");
  const unrelatedRows = await ownerSql`
    SELECT status, current_refresh_generation, revoked_at, revoked_reason
    FROM public.oauth_grants
    WHERE id = ${unrelatedFamily.grant.sid}
  `;
  assert.deepEqual({ ...unrelatedRows[0] }, {
    status: "active",
    current_refresh_generation: 1,
    revoked_at: null,
    revoked_reason: null
  });
});

test("token-reference revocation is atomic, client-bound, session-preserving, and refresh-race safe", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 6 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice8-${suffix}`;
  const clients = [];
  const sessionDigest = randomBytes(32);
  const sessionIpFingerprint = randomBytes(32);

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DROP TRIGGER IF EXISTS slice8_audit_barrier ON public.oauth_audit_events
      `,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice8_audit_barrier()`,
      async () => ownerSql`
        DROP TRIGGER IF EXISTS slice8_fail_revocation_audit ON public.oauth_audit_events
      `,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice8_fail_revocation_audit()`,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ANY(
          ${ownerSql.array(clients.map((client) => client.id))}::uuid[]
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ANY(
          ${ownerSql.array(clients.map((client) => client.id))}::uuid[]
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE id = ANY(
          ${ownerSql.array(clients.map((client) => client.id))}::uuid[]
        )
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_login_sessions
        WHERE session_digest = ${sessionDigest}
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "token-reference revocation cleanup failed");
    }
  });

  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = "https://cortex.example.test/mcp";
  const scopes = ["cortex:read", "mcp"];
  const codeChallenge = "A".repeat(43);
  const bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);

  const browserSession = await store.createLoginSession({
    sessionDigest,
    ipFingerprint: sessionIpFingerprint,
    ttlSeconds: 3600,
    requestId: `${requestPrefix}-browser-session`,
    userAgentFingerprint: null
  });
  assert.ok(browserSession);
  assert.equal((await store.resolveLoginSession({
    sessionDigest,
    ipFingerprint: sessionIpFingerprint
  })).kind, "active");

  const floorToSeconds = (date) => new Date(
    Math.floor(date.getTime() / 1_000) * 1_000
  );
  const accessClaims = (grant) => ({
    iss: issuer,
    sub: grant.subject,
    aud: grant.resource,
    scope: grant.scopes.join(" "),
    client_id: grant.clientId,
    token_use: "access",
    sid: grant.sid,
    agent_id: grant.agentExternalId,
    auth_epoch: grant.authenticationEpoch,
    binding_version: grant.bindingVersion,
    jti: randomBytes(32).toString("base64url"),
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 3600
  });
  const refreshState = (grant, descriptor, jtiDigest) => Object.freeze({
    grant,
    token: Object.freeze({
      issuer,
      subject: grant.subject,
      resource: grant.resource,
      scopes: Object.freeze([...grant.scopes]),
      clientId: grant.clientId,
      sid: grant.sid,
      agentExternalId: grant.agentExternalId,
      authenticationEpoch: grant.authenticationEpoch,
      bindingVersion: grant.bindingVersion,
      generation: descriptor.generation,
      issuedAt: floorToSeconds(descriptor.issuedAt),
      expiresAt: floorToSeconds(descriptor.expiresAt)
    }),
    jtiDigest: Buffer.from(jtiDigest)
  });
  const replacementCandidate = () => ({
    jtiDigest: randomBytes(32),
    reconstructionNonce: randomBytes(32)
  });
  const rotationInput = (state, requestId, candidate = replacementCandidate()) => ({
    input: {
      token: state.token,
      presentedJtiDigest: state.jtiDigest,
      clientId: state.grant.clientId,
      resource: state.grant.resource,
      effectiveScopes: [...state.token.scopes],
      requestFingerprint: randomBytes(32),
      replacement: {
        generation: state.token.generation + 1,
        jtiDigest: candidate.jtiDigest,
        reconstructionNonce: candidate.reconstructionNonce
      },
      refreshTokenTtlSeconds: 3600,
      retryGraceSeconds: 30,
      requestId,
      ipFingerprint: null,
      userAgentFingerprint: null
    },
    candidate
  });

  async function createFamily(label) {
    const client = await store.registerDynamicClient({
      redirectUris: [redirectUri],
      clientName: `Slice 8 ${label} ${suffix}`
    });
    assert.ok(client);
    clients.push(client);
    const codeDigest = randomBytes(32);
    assert.equal(await store.createAuthorization({
      codeDigest,
      authenticatedContext: bootstrap,
      clientId: client.clientId,
      redirectUri,
      scopes,
      codeChallenge,
      resource,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      requestId: `${requestPrefix}-${label}-authorize`,
      ipFingerprint: null,
      userAgentFingerprint: null
    }), undefined);
    const material = exchangeMaterial();
    const grant = await store.exchangeAuthorizationCode({
      codeDigest,
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      ...material,
      requestId: `${requestPrefix}-${label}-exchange`
    });
    assert.ok(grant);
    const claims = accessClaims(grant);
    const initialState = refreshState(grant, material.refresh, material.refresh.jtiDigest);
    assert.equal((await store.resolveAccessContext({ claims })).kind, "active");
    return { client, grant, material, claims, initialState };
  }

  const revokeInput = (family, requestId, overrides = {}) => ({
    reference: {
      sid: family.grant.sid,
      clientId: family.client.clientId,
      tokenUse: "access",
      ...(overrides.reference ?? {})
    },
    clientId: overrides.clientId ?? family.client.clientId,
    requestId,
    ipFingerprint: overrides.ipFingerprint ?? null,
    userAgentFingerprint: overrides.userAgentFingerprint ?? null
  });

  async function assertRevokedFamily(family, expectedGeneration) {
    const rows = await ownerSql`
      SELECT
        grant_row.status,
        grant_row.current_refresh_generation,
        grant_row.revoked_at,
        grant_row.revoked_reason,
        NOT EXISTS (
          SELECT 1
          FROM public.oauth_refresh_tokens AS refresh
          WHERE refresh.grant_id = grant_row.id
            AND refresh.expires_at > GREATEST(
              grant_row.revoked_at,
              refresh.issued_at + INTERVAL '1 microsecond'
            )
        ) AS all_refresh_clipped
      FROM public.oauth_grants AS grant_row
      WHERE grant_row.id = ${family.grant.sid}
    `;
    assert.equal(rows.length, 1);
    assert.deepEqual({
      status: rows[0].status,
      generation: rows[0].current_refresh_generation,
      reason: rows[0].revoked_reason,
      allRefreshClipped: rows[0].all_refresh_clipped
    }, {
      status: "revoked",
      generation: expectedGeneration,
      reason: "client_token_revocation",
      allRefreshClipped: true
    });
    assert.ok(rows[0].revoked_at);
    assert.deepEqual(await store.resolveAccessContext({ claims: family.claims }), {
      kind: "revoked"
    });
    return rows[0];
  }

  const unrelatedFamily = await createFamily("unrelated");
  const family = await createFamily("direct");
  const beforeOracleAudits = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_audit_events
    WHERE event_type = 'token_revocation'
      AND request_id LIKE ${`${requestPrefix}%`}
  `;
  assert.deepEqual(await store.revokeByTokenReference({
    ...revokeInput(family, `${requestPrefix}-malformed`),
    reference: {
      ...revokeInput(family, `${requestPrefix}-malformed`).reference,
      rawJti: "must-not-cross-store-boundary"
    }
  }), { kind: "not_found" });
  assert.deepEqual(await store.revokeByTokenReference(revokeInput(
    family,
    `${requestPrefix}-wrong-client`,
    { reference: { clientId: unrelatedFamily.client.clientId } }
  )), { kind: "not_found" });
  assert.deepEqual(await store.revokeByTokenReference(revokeInput(
    family,
    `${requestPrefix}-database-client-mismatch`,
    {
      reference: { clientId: unrelatedFamily.client.clientId },
      clientId: unrelatedFamily.client.clientId
    }
  )), { kind: "not_found" });
  assert.deepEqual(await store.revokeByTokenReference(revokeInput(
    family,
    `${requestPrefix}-unknown-family`,
    { reference: { sid: randomUUID() } }
  )), { kind: "not_found" });
  await ownerSql`
    UPDATE public.oauth_clients
    SET status = 'disabled'
    WHERE id = ${family.client.id}
  `;
  assert.deepEqual(await store.revokeByTokenReference(revokeInput(
    family,
    `${requestPrefix}-disabled-client`
  )), { kind: "not_found" });
  await ownerSql`
    UPDATE public.oauth_clients
    SET status = 'active'
    WHERE id = ${family.client.id}
  `;
  const afterOracleAudits = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_audit_events
    WHERE event_type = 'token_revocation'
      AND request_id LIKE ${`${requestPrefix}%`}
  `;
  assert.equal(afterOracleAudits[0].count, beforeOracleAudits[0].count);
  assert.equal((await store.resolveAccessContext({ claims: family.claims })).kind, "active");

  const firstRevokeRequestId = `${requestPrefix}-direct-access`;
  assert.deepEqual(
    await store.revokeByTokenReference(revokeInput(family, firstRevokeRequestId)),
    { kind: "revoked" }
  );
  const directRow = await assertRevokedFamily(family, 0);
  const directAudits = await ownerSql`
    SELECT
      event_type,
      outcome,
      grant_id,
      principal_id,
      binding_id,
      oauth_client_id,
      request_id,
      metadata,
      created_at
    FROM public.oauth_audit_events
    WHERE grant_id = ${family.grant.sid}
      AND event_type = 'token_revocation'
    ORDER BY created_at, id
  `;
  assert.equal(directAudits.length, 1);
  assert.deepEqual({
    eventType: directAudits[0].event_type,
    outcome: directAudits[0].outcome,
    grantId: directAudits[0].grant_id,
    principalId: directAudits[0].principal_id,
    bindingId: directAudits[0].binding_id,
    oauthClientId: directAudits[0].oauth_client_id,
    requestId: directAudits[0].request_id,
    metadata: directAudits[0].metadata
  }, {
    eventType: "token_revocation",
    outcome: "revoked",
    grantId: family.grant.sid,
    principalId: null,
    bindingId: null,
    oauthClientId: null,
    requestId: firstRevokeRequestId,
    metadata: { token_use: "access" }
  });
  assert.equal(directAudits[0].created_at.getTime(), directRow.revoked_at.getTime());
  assert.deepEqual(await store.revokeByTokenReference(revokeInput(
    family,
    `${requestPrefix}-direct-refresh-repeat`,
    { reference: { tokenUse: "refresh" } }
  )), { kind: "no_change" });
  const repeatedAudits = await ownerSql`
    SELECT outcome, metadata
    FROM public.oauth_audit_events
    WHERE grant_id = ${family.grant.sid}
      AND event_type = 'token_revocation'
    ORDER BY created_at, id
  `;
  assert.deepEqual(repeatedAudits.map((row) => ({ ...row })), [
    { outcome: "revoked", metadata: { token_use: "access" } }
  ]);
  assert.equal((await store.resolveLoginSession({
    sessionDigest,
    ipFingerprint: sessionIpFingerprint
  })).kind, "active", "grant revocation must preserve the browser login session");
  assert.equal(
    (await store.resolveAccessContext({ claims: unrelatedFamily.claims })).kind,
    "active"
  );

  const rollbackFamily = await createFamily("audit-rollback");
  const rollbackBefore = await ownerSql`
    SELECT
      grant_row.status,
      grant_row.revoked_at,
      grant_row.revoked_reason,
      grant_row.updated_at,
      refresh.generation,
      refresh.expires_at
    FROM public.oauth_grants AS grant_row
    INNER JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
    WHERE grant_row.id = ${rollbackFamily.grant.sid}
    ORDER BY refresh.generation
  `;
  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice8_fail_revocation_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'token_revocation' THEN
        RAISE EXCEPTION 'injected Slice 8 revocation audit failure';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice8_fail_revocation_audit
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice8_fail_revocation_audit();
  `);
  const rollbackIp = randomBytes(32);
  const rollbackUserAgent = randomBytes(32);
  const rollbackRequestId = `${requestPrefix}-audit-rollback-revoke`;
  await assert.rejects(
    store.revokeByTokenReference(revokeInput(rollbackFamily, rollbackRequestId, {
      ipFingerprint: rollbackIp,
      userAgentFingerprint: rollbackUserAgent
    })),
    (error) => assertGenericStoreError(error, [rollbackIp, rollbackUserAgent])
  );
  await ownerSql`
    DROP TRIGGER slice8_fail_revocation_audit ON public.oauth_audit_events
  `;
  await ownerSql`DROP FUNCTION public.slice8_fail_revocation_audit()`;
  const rollbackAfter = await ownerSql`
    SELECT
      grant_row.status,
      grant_row.revoked_at,
      grant_row.revoked_reason,
      grant_row.updated_at,
      refresh.generation,
      refresh.expires_at
    FROM public.oauth_grants AS grant_row
    INNER JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
    WHERE grant_row.id = ${rollbackFamily.grant.sid}
    ORDER BY refresh.generation
  `;
  assert.deepEqual(rollbackAfter, rollbackBefore);
  assert.equal((await store.resolveAccessContext({ claims: rollbackFamily.claims })).kind, "active");
  const rollbackAudits = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_audit_events
    WHERE request_id = ${rollbackRequestId}
  `;
  assert.equal(rollbackAudits[0].count, 0);

  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice8_audit_barrier()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'refresh_rotation' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(7008001);
      ELSIF NEW.event_type = 'token_revocation' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(7008002);
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice8_audit_barrier
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice8_audit_barrier();
  `);

  const gatewayRole = decodeURIComponent(new URL(gatewayDatabaseUrl).username);
  async function waitForBlockedSessions(blockerPid, minimumTotal) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await ownerSql`
        SELECT
          pg_catalog.count(*) FILTER (
            WHERE ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
          )::integer AS directly_blocked,
          pg_catalog.count(*) FILTER (
            WHERE pg_catalog.cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
          )::integer AS total_blocked
        FROM pg_catalog.pg_stat_activity
        WHERE datname = pg_catalog.current_database()
          AND usename = ${gatewayRole}
      `;
      if (rows[0].directly_blocked >= 1 && rows[0].total_blocked >= minimumTotal) {
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`timed out waiting for ${minimumTotal} blocked Slice 8 transactions`);
  }

  async function runAuditBarrierRace(advisoryKey, firstAction, secondAction) {
    let announceBlocker;
    let releaseBlocker;
    const blockerReady = new Promise((resolvePromise) => {
      announceBlocker = resolvePromise;
    });
    const blockerReleased = new Promise((resolvePromise) => {
      releaseBlocker = resolvePromise;
    });
    const blocker = ownerSql.begin(async (transaction) => {
      const rows = await transaction`
        SELECT
          pg_catalog.pg_advisory_xact_lock(${advisoryKey}),
          pg_catalog.pg_backend_pid() AS pid
      `;
      announceBlocker(rows[0].pid);
      await blockerReleased;
    });
    const blockerPid = await blockerReady;
    let first;
    let second;
    let setupError;
    try {
      first = firstAction();
      await waitForBlockedSessions(blockerPid, 1);
      second = secondAction();
      await waitForBlockedSessions(blockerPid, 2);
    } catch (error) {
      setupError = error;
    } finally {
      releaseBlocker();
    }
    if (setupError) {
      await Promise.allSettled([blocker, first, second].filter(Boolean));
      throw setupError;
    }
    try {
      await blocker;
      return await Promise.all([first, second]);
    } catch (error) {
      await Promise.allSettled([blocker, first, second].filter(Boolean));
      throw error;
    }
  }

  const rotationFirstFamily = await createFamily("race-rotation-first");
  const rotationFirst = rotationInput(
    rotationFirstFamily.initialState,
    `${requestPrefix}-race-rotation-first-rotate`
  );
  const [rotationDecision, revokeAfterRotation] = await runAuditBarrierRace(
    7008001,
    () => store.rotateRefreshToken(rotationFirst.input),
    () => store.revokeByTokenReference(revokeInput(
      rotationFirstFamily,
      `${requestPrefix}-race-rotation-first-revoke`,
      { reference: { tokenUse: "refresh" } }
    ))
  );
  assert.equal(rotationDecision.kind, "rotated");
  assert.deepEqual(revokeAfterRotation, { kind: "revoked" });
  await assertRevokedFamily(rotationFirstFamily, 1);

  const revokeFirstFamily = await createFamily("race-revoke-first");
  const refreshAfterRevoke = rotationInput(
    revokeFirstFamily.initialState,
    `${requestPrefix}-race-revoke-first-refresh`
  );
  const [revokeDecision, refreshDecision] = await runAuditBarrierRace(
    7008002,
    () => store.revokeByTokenReference(revokeInput(
      revokeFirstFamily,
      `${requestPrefix}-race-revoke-first-revoke`
    )),
    () => store.rotateRefreshToken(refreshAfterRevoke.input)
  );
  assert.deepEqual(revokeDecision, { kind: "revoked" });
  assert.deepEqual(refreshDecision, { kind: "revoked" });
  await assertRevokedFamily(revokeFirstFamily, 0);

  await ownerSql`DROP TRIGGER slice8_audit_barrier ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice8_audit_barrier()`;
  assert.equal(
    (await store.resolveAccessContext({ claims: unrelatedFamily.claims })).kind,
    "active"
  );
  assert.equal((await store.resolveLoginSession({
    sessionDigest,
    ipFingerprint: sessionIpFingerprint
  })).kind, "active");
});

test("legacy import and DCR registration share one serialized client capacity", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const fillerName = `Slice 4 capacity filler ${suffix}`;
  const contenderName = `Slice 4 capacity contender ${suffix}`;
  const requestId = `slice4-capacity-${suffix}`;
  const importClientId = `chatgpt-${createHash("sha256")
    .update(`slice4-import-capacity-${suffix}`)
    .digest("base64url")
    .slice(0, 24)}`;
  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events WHERE request_id = ${requestId}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_state_migrations
        WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE client_name IN (${fillerName}, ${contenderName})
           OR client_id = ${importClientId}
      `,
      async () => store.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "legacy capacity integration cleanup failed");
    }
  });

  await ownerSql`
    DELETE FROM public.oauth_state_migrations
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
  const before = await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_kind = 'dynamic'
  `;
  assert.ok(before[0].count <= 999);
  const fillerCount = 999 - before[0].count;
  if (fillerCount > 0) {
    await ownerSql`
      INSERT INTO public.oauth_clients (
        id, client_id, client_kind, redirect_uris, client_name,
        token_endpoint_auth_method, status
      )
      SELECT
        pg_catalog.gen_random_uuid(),
        'chatgpt-' || pg_catalog.substring(
          pg_catalog.md5(${suffix} || '-' || series.value::text),
          1,
          24
        ),
        'dynamic',
        ARRAY['https://chatgpt.com/connector_platform_oauth_redirect']::text[],
        ${fillerName},
        'none',
        'active'
      FROM pg_catalog.generate_series(1, ${fillerCount}) AS series(value)
    `;
  }

  const importInput = {
    sourceVersion: 1,
    sourceChecksum: createHash("sha256").update(`slice4-capacity-${suffix}`).digest(),
    clients: [{
      clientId: importClientId,
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      clientName: `Slice 4 imported capacity ${suffix}`,
      createdAt: new Date(Math.floor((Date.now() - 60_000) / 1_000) * 1_000)
    }],
    codes: [],
    requestId
  };
  const [importResult, registrationResult] = await Promise.allSettled([
    store.importLegacyStateOnce(importInput),
    store.registerDynamicClient({
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      clientName: contenderName
    })
  ]);
  assert.equal(registrationResult.status, "fulfilled");
  const importSucceeded = importResult.status === "fulfilled";
  const registrationSucceeded = registrationResult.value !== null;
  assert.equal(Number(importSucceeded) + Number(registrationSucceeded), 1);
  if (importSucceeded) {
    assert.equal(importResult.value.kind, "imported");
    assert.equal(registrationResult.value, null);
  } else {
    assert.ok(importResult.reason instanceof OAuthLegacyStateImportError);
    assert.equal(importResult.reason.code, "client_capacity");
    assert.ok(registrationResult.value);
  }

  const finalState = await ownerSql`
    SELECT
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_clients
       WHERE client_kind = 'dynamic') AS dynamic_client_count,
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_state_migrations
       WHERE version = ${LEGACY_STATE_IMPORT_VERSION}) AS marker_count,
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_audit_events
       WHERE request_id = ${requestId}) AS audit_count
  `;
  assert.deepEqual({ ...finalState[0] }, {
    dynamic_client_count: 1_000,
    marker_count: importSucceeded ? 1 : 0,
    audit_count: importSucceeded ? 1 : 0
  });
});

test("legacy state import is immutable, one-time, principal-bound, and rollback-safe", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  let store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice4-${suffix}`;
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = "https://cortex.example.test/mcp";
  const scopes = ["cortex:read", "mcp"];
  const codeChallenge = "C".repeat(43);
  const clientIds = [];
  let failureTriggerInstalled = false;

  function clientDescriptor(
    label,
    createdAt = new Date(Math.floor((Date.now() - 60_000) / 1_000) * 1_000)
  ) {
    const clientId = `chatgpt-${createHash("sha256")
      .update(`${suffix}-${label}`)
      .digest("base64url")
      .slice(0, 24)}`;
    clientIds.push(clientId);
    return {
      clientId,
      redirectUris: [redirectUri],
      clientName: `Slice 4 ${label}`,
      createdAt
    };
  }

  function codeDescriptor(clientId, label, expiresAt) {
    return {
      codeDigest: createHash("sha256")
        .update(`raw-code-canary-${suffix}-${label}`)
        .digest(),
      clientId,
      redirectUri,
      scopes,
      codeChallenge,
      resource,
      subject,
      expiresAt
    };
  }

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`DROP TRIGGER IF EXISTS slice4_fail_state_marker ON public.oauth_state_migrations`,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice4_fail_state_marker()`,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes AS code
        USING public.oauth_clients AS client
        WHERE code.oauth_client_id = client.id
          AND client.client_id = ANY(${ownerSql.array(clientIds)}::text[])
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_state_migrations
        WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE client_id = ANY(${ownerSql.array(clientIds)}::text[])
      `,
      async () => store?.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "legacy state import integration cleanup failed");
    }
  });

  await ownerSql`
    DELETE FROM public.oauth_state_migrations
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;

  const disabledClient = clientDescriptor("disabled");
  await ownerSql`
    INSERT INTO public.oauth_clients (
      id, client_id, client_kind, redirect_uris, client_name,
      token_endpoint_auth_method, status, created_at, updated_at
    ) VALUES (
      ${randomUUID()},
      ${disabledClient.clientId},
      'dynamic',
      ${ownerSql.array(disabledClient.redirectUris)}::text[],
      ${disabledClient.clientName},
      'none',
      'disabled',
      ${disabledClient.createdAt},
      ${disabledClient.createdAt}
    )
  `;
  const rolledBackBeforeConflict = clientDescriptor("rolled-back-before-conflict");
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: createHash("sha256").update("slice4-disabled-conflict").digest(),
      clients: [rolledBackBeforeConflict, disabledClient],
      codes: [],
      requestId: `${requestPrefix}-disabled-conflict`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "client_conflict"
  );
  const disabledConflictState = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_clients
        WHERE client_id = ${rolledBackBeforeConflict.clientId}
      ) AS first_insert_rolled_back,
      (
        SELECT status = 'disabled' FROM public.oauth_clients
        WHERE client_id = ${disabledClient.clientId}
      ) AS disabled_not_revived,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_state_migrations
        WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
      ) AS no_marker
  `;
  assert.deepEqual({ ...disabledConflictState[0] }, {
    first_insert_rolled_back: true,
    disabled_not_revived: true,
    no_marker: true
  });

  const rawFieldClient = clientDescriptor("raw-field-rejected");
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: createHash("sha256").update("slice4-raw-field").digest(),
      clients: [rawFieldClient],
      codes: [{
        ...codeDescriptor(
          rawFieldClient.clientId,
          "raw-field",
          new Date(Date.now() + 5 * 60_000)
        ),
        code: `raw-code-canary-${suffix}`
      }],
      requestId: `${requestPrefix}-raw-field`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "invalid_input"
  );
  assert.equal((await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_clients
    WHERE client_id = ${rawFieldClient.clientId}
  `)[0].count, 0);

  const orphanClient = clientDescriptor("orphan-code-owner");
  const absentClient = clientDescriptor("absent-code-owner");
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: createHash("sha256").update("slice4-orphan-code").digest(),
      clients: [orphanClient],
      codes: [codeDescriptor(
        absentClient.clientId,
        "orphan",
        new Date(Date.now() + 5 * 60_000)
      )],
      requestId: `${requestPrefix}-orphan-code`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "invalid_input"
  );
  const fractionalTimestampClient = clientDescriptor(
    "fractional-created-at",
    new Date(Math.floor(Date.now() / 1_000) * 1_000 + 1)
  );
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: createHash("sha256").update("slice4-fractional-time").digest(),
      clients: [fractionalTimestampClient],
      codes: [],
      requestId: `${requestPrefix}-fractional-time`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "invalid_input"
  );

  const persistenceClient = clientDescriptor("persistence-rollback");
  const persistenceCode = codeDescriptor(
    persistenceClient.clientId,
    "persistence-rollback",
    new Date(Date.now() + 5 * 60_000)
  );
  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice4_fail_state_marker()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      RAISE EXCEPTION 'injected Slice 4 state marker failure';
    END
    $function$;

    CREATE TRIGGER slice4_fail_state_marker
    BEFORE INSERT ON public.oauth_state_migrations
    FOR EACH ROW EXECUTE FUNCTION public.slice4_fail_state_marker();
  `);
  failureTriggerInstalled = true;
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: createHash("sha256").update("slice4-persistence").digest(),
      clients: [persistenceClient],
      codes: [persistenceCode],
      requestId: `${requestPrefix}-persistence-failure`
    }),
    OAuthStoreUnavailableError
  );
  await ownerSql`DROP TRIGGER slice4_fail_state_marker ON public.oauth_state_migrations`;
  await ownerSql`DROP FUNCTION public.slice4_fail_state_marker()`;
  failureTriggerInstalled = false;
  assert.equal(failureTriggerInstalled, false);
  const persistenceRollback = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_clients
        WHERE client_id = ${persistenceClient.clientId}
      ) AS no_client,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_authorization_codes
        WHERE code_digest = ${persistenceCode.codeDigest}
      ) AS no_code,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_audit_events
        WHERE request_id = ${`${requestPrefix}-persistence-failure`}
      ) AS no_audit,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_state_migrations
        WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
      ) AS no_marker
  `;
  assert.deepEqual({ ...persistenceRollback[0] }, {
    no_client: true,
    no_code: true,
    no_audit: true,
    no_marker: true
  });

  const existingClient = clientDescriptor("existing-exact");
  const importedClient = clientDescriptor("imported");
  await ownerSql`
    INSERT INTO public.oauth_clients (
      id, client_id, client_kind, redirect_uris, client_name,
      token_endpoint_auth_method, status, created_at, updated_at
    ) VALUES (
      ${randomUUID()},
      ${existingClient.clientId},
      'dynamic',
      ${ownerSql.array(existingClient.redirectUris)}::text[],
      ${existingClient.clientName},
      'none',
      'active',
      ${existingClient.createdAt},
      ${existingClient.createdAt}
    )
  `;
  const liveCode = codeDescriptor(
    importedClient.clientId,
    "live",
    new Date(Date.now() + 5 * 60_000)
  );
  const expiredCode = codeDescriptor(
    importedClient.clientId,
    "expired",
    new Date(Date.now() - 60_000)
  );
  const sourceChecksum = createHash("sha256")
    .update(`production-shaped-state-${suffix}`)
    .digest();
  const importInput = {
    sourceVersion: 1,
    sourceChecksum,
    clients: [existingClient, importedClient],
    codes: [liveCode, expiredCode],
    requestId: `${requestPrefix}-success`
  };
  const concurrentResults = await Promise.all([
    store.importLegacyStateOnce(importInput),
    store.importLegacyStateOnce(importInput)
  ]);
  assert.deepEqual(
    concurrentResults.map((result) => result.kind).sort(),
    ["already_imported", "imported"]
  );
  for (const result of concurrentResults) {
    assert.equal(result.version, LEGACY_STATE_IMPORT_VERSION);
    assert.deepEqual(result.report, {
      clientsImported: 1,
      clientsExisting: 1,
      codesImported: 1,
      codesExpired: 1
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.report), true);
  }

  const importedAuthority = await ownerSql`
    SELECT
      marker.version,
      marker.source_checksum,
      marker.outcome,
      marker.report,
      client.client_kind,
      client.status AS client_status,
      code.code_digest,
      code.authentication_epoch,
      code.binding_version,
      code.expires_at,
      principal.id AS principal_id,
      principal.authentication_epoch AS principal_authentication_epoch,
      binding.id AS binding_id,
      binding.binding_version AS current_binding_version,
      agent.external_id AS agent_external_id
    FROM public.oauth_state_migrations AS marker
    CROSS JOIN public.oauth_clients AS client
    CROSS JOIN public.oauth_authorization_codes AS code
    INNER JOIN public.oauth_principals AS principal ON principal.id = code.principal_id
    INNER JOIN public.oauth_agent_bindings AS binding
      ON binding.id = code.binding_id
      AND binding.principal_id = principal.id
    INNER JOIN public.agents AS agent ON agent.id = binding.agent_id
    WHERE marker.version = ${LEGACY_STATE_IMPORT_VERSION}
      AND client.client_id = ${importedClient.clientId}
      AND code.code_digest = ${liveCode.codeDigest}
  `;
  assert.equal(importedAuthority.length, 1);
  assert.equal(importedAuthority[0].version, LEGACY_STATE_IMPORT_VERSION);
  assert.deepEqual(
    Buffer.from(importedAuthority[0].source_checksum),
    Buffer.from(sourceChecksum)
  );
  assert.equal(importedAuthority[0].outcome, "imported");
  assert.deepEqual(importedAuthority[0].report, {
    clientsImported: 1,
    clientsExisting: 1,
    codesImported: 1,
    codesExpired: 1
  });
  assert.equal(importedAuthority[0].client_kind, "dynamic");
  assert.equal(importedAuthority[0].client_status, "active");
  assert.deepEqual(
    Buffer.from(importedAuthority[0].code_digest),
    Buffer.from(liveCode.codeDigest)
  );
  assert.equal(
    importedAuthority[0].authentication_epoch,
    importedAuthority[0].principal_authentication_epoch
  );
  assert.equal(
    importedAuthority[0].binding_version,
    importedAuthority[0].current_binding_version
  );
  assert.equal(importedAuthority[0].agent_external_id, agentExternalId);
  assert.equal((await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_authorization_codes
    WHERE code_digest = ${expiredCode.codeDigest}
  `)[0].count, 0);

  await store.close();
  store = createPostgresOAuthStore({
    ...oauthStoreOptions(
      gatewayDatabaseUrl,
      migration,
      issuer,
      subject,
      agentExternalId
    ),
    expectedLegacyState: {
      sourceChecksum,
      clientCount: 2,
      codeCount: 2
    }
  });
  const afterRestart = await store.importLegacyStateOnce({
    ...importInput,
    requestId: `${requestPrefix}-restart-idempotence`
  });
  assert.deepEqual(afterRestart, {
    kind: "already_imported",
    version: LEGACY_STATE_IMPORT_VERSION,
    report: {
      clientsImported: 1,
      clientsExisting: 1,
      codesImported: 1,
      codesExpired: 1
    }
  });
  assert.deepEqual(await store.checkReadiness(), {
    ready: true,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: true
  });

  const alteredClient = clientDescriptor("altered-checksum-not-imported");
  await assert.rejects(
    store.importLegacyStateOnce({
      sourceVersion: 1,
      sourceChecksum: createHash("sha256").update("altered-state").digest(),
      clients: [alteredClient],
      codes: [],
      requestId: `${requestPrefix}-checksum-mismatch`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "checksum_mismatch"
  );
  const unchangedAfterChecksumMismatch = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_clients
        WHERE client_id = ${alteredClient.clientId}
      ) AS no_altered_client,
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_state_migrations
       WHERE version = ${LEGACY_STATE_IMPORT_VERSION}) AS marker_count,
      (SELECT pg_catalog.count(*)::integer FROM public.oauth_audit_events
       WHERE request_id = ${`${requestPrefix}-checksum-mismatch`}) AS mismatch_audit_count
  `;
  assert.deepEqual({ ...unchangedAfterChecksumMismatch[0] }, {
    no_altered_client: true,
    marker_count: 1,
    mismatch_audit_count: 0
  });

  await ownerSql`
    UPDATE public.oauth_state_migrations
    SET outcome = 'fresh_install'
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
  assert.deepEqual(await store.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });
  await ownerSql`
    UPDATE public.oauth_state_migrations
    SET outcome = 'imported'
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;

  await ownerSql`
    UPDATE public.oauth_state_migrations
    SET report = ${ownerSql.json({
      clientsImported: 0,
      clientsExisting: 0,
      codesImported: 1,
      codesExpired: 1
    })}
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
  await assert.rejects(
    store.importLegacyStateOnce({
      ...importInput,
      requestId: `${requestPrefix}-stored-count-conflict`
    }),
    (error) => error instanceof OAuthLegacyStateImportError &&
      error.code === "marker_conflict"
  );
  assert.deepEqual(await store.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });
  await ownerSql`
    UPDATE public.oauth_state_migrations
    SET report = ${ownerSql.json({
      clientsImported: 1,
      clientsExisting: 1,
      codesImported: 1,
      codesExpired: 1
    })}
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;

  await ownerSql`
    UPDATE public.oauth_state_migrations
    SET report = ${ownerSql.json({ clientsImported: 1 })}
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
  assert.deepEqual(await store.checkReadiness(), {
    ready: false,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: false,
    reason: "legacy_import"
  });
  await ownerSql`
    UPDATE public.oauth_state_migrations
    SET report = ${ownerSql.json({
      clientsImported: 1,
      clientsExisting: 1,
      codesImported: 1,
      codesExpired: 1
    })}
    WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
  `;
});

test("opaque login sessions are restart-durable, IP and epoch bound, grant independent, and audit atomic", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  let store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice5-session-${suffix}`;
  const sessionDigests = [];
  let client = null;
  let bootstrap = null;
  let originalAuthenticationEpoch = null;

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`DROP TRIGGER IF EXISTS slice5_fail_session_audit ON public.oauth_audit_events`,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice5_fail_session_audit()`,
      async () => bootstrap === null
        ? undefined
        : ownerSql`
            UPDATE public.oauth_principals
            SET status = 'active',
                disabled_at = NULL,
                disabled_reason = NULL
            WHERE id = ${bootstrap.principalId}
          `,
      async () => bootstrap === null
        ? undefined
        : ownerSql`
            UPDATE public.oauth_agent_bindings
            SET status = 'active',
                is_default = TRUE,
                revoked_at = NULL,
                revoked_reason = NULL
            WHERE id = ${bootstrap.bindingId}
          `,
      async () => originalAuthenticationEpoch === null || bootstrap === null
        ? undefined
        : ownerSql`
            UPDATE public.oauth_principals
            SET authentication_epoch = ${originalAuthenticationEpoch}
            WHERE id = ${bootstrap.principalId}
          `,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_grants
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_login_sessions
        WHERE pg_catalog.encode(session_digest, 'hex') = ANY(
          ${ownerSql.array(sessionDigests.map((digest) => Buffer.from(digest).toString("hex")))}::text[]
        )
      `,
      async () => store?.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "opaque login-session integration cleanup failed");
    }
  });

  bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);
  originalAuthenticationEpoch = bootstrap.authenticationEpoch;
  const ipFingerprint = randomBytes(32);
  const userAgentFingerprint = randomBytes(32);
  const primaryDigest = randomBytes(32);
  sessionDigests.push(primaryDigest);
  const primaryRequestId = `${requestPrefix}-primary`;
  const created = await store.createLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint,
    ttlSeconds: 60 * 60,
    requestId: primaryRequestId,
    userAgentFingerprint
  });
  assert.ok(created);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.context), true);
  assert.equal(Object.isFrozen(created.context.allowedScopes), true);
  assert.deepEqual(created.context, bootstrap);
  assert.equal(created.expiresAt.getTime() - created.issuedAt.getTime(), 60 * 60 * 1_000);

  await assert.rejects(
    store.createLoginSession({
      sessionDigest: primaryDigest,
      ipFingerprint,
      ttlSeconds: 60 * 60,
      requestId: `${requestPrefix}-duplicate-digest`,
      userAgentFingerprint
    }),
    (error) => assertGenericStoreError(error, [
      primaryDigest,
      ipFingerprint,
      userAgentFingerprint
    ])
  );

  assert.equal(await store.createLoginSession({
    sessionDigest: randomBytes(32),
    ipFingerprint,
    ttlSeconds: 60 * 60,
    requestId: `${requestPrefix}-raw-boundary`,
    userAgentFingerprint: null,
    rawCookie: `raw-cookie-${suffix}`
  }), null);
  assert.equal(await store.createLoginSession({
    sessionDigest: randomBytes(32),
    ipFingerprint,
    ttlSeconds: 90 * 24 * 60 * 60 + 1,
    requestId: `${requestPrefix}-oversized-ttl`,
    userAgentFingerprint: null
  }), null);

  const firstResolution = await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint
  });
  assert.equal(firstResolution.kind, "active");
  assert.deepEqual(firstResolution.session.context, bootstrap);
  assert.equal(
    firstResolution.session.expiresAt.getTime(),
    created.expiresAt.getTime(),
    "resolution must not slide the fixed session expiry"
  );
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint: randomBytes(32)
  }), { kind: "invalid" });
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: randomBytes(32),
    ipFingerprint
  }), { kind: "invalid" });
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint,
    rawCookie: "forbidden"
  }), { kind: "invalid" });

  await store.close();
  store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const afterRestart = await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint
  });
  assert.equal(afterRestart.kind, "active");
  assert.deepEqual(afterRestart.session.context, bootstrap);

  await ownerSql`
    UPDATE public.oauth_principals
    SET status = 'disabled',
        disabled_at = CURRENT_TIMESTAMP,
        disabled_reason = 'slice5_principal_disabled'
    WHERE id = ${bootstrap.principalId}
  `;
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint
  }), { kind: "invalid" });
  await ownerSql`
    UPDATE public.oauth_principals
    SET status = 'active',
        disabled_at = NULL,
        disabled_reason = NULL
    WHERE id = ${bootstrap.principalId}
  `;

  await ownerSql`
    UPDATE public.oauth_agent_bindings
    SET status = 'revoked',
        is_default = FALSE,
        revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = 'slice5_binding_revoked'
    WHERE id = ${bootstrap.bindingId}
  `;
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint
  }), { kind: "invalid" });
  await ownerSql`
    UPDATE public.oauth_agent_bindings
    SET status = 'active',
        is_default = TRUE,
        revoked_at = NULL,
        revoked_reason = NULL
    WHERE id = ${bootstrap.bindingId}
  `;

  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = "https://cortex.example.test/mcp";
  const scopes = ["cortex:read", "mcp"];
  client = await store.registerDynamicClient({
    redirectUris: [redirectUri],
    clientName: `Slice 5 session ${suffix}`
  });
  assert.ok(client);
  const grantId = randomUUID();
  await ownerSql`
    INSERT INTO public.oauth_grants (
      id, principal_id, binding_id, oauth_client_id, resource, scopes,
      authentication_epoch, binding_version, status,
      current_refresh_generation, inactivity_expires_at
    ) VALUES (
      ${grantId},
      ${bootstrap.principalId},
      ${bootstrap.bindingId},
      ${client.id},
      ${resource},
      ARRAY['cortex:read', 'mcp']::public.oauth_scope[],
      ${bootstrap.authenticationEpoch},
      ${bootstrap.bindingVersion},
      'active',
      0,
      CURRENT_TIMESTAMP + INTERVAL '1 hour'
    )
  `;
  await ownerSql`
    UPDATE public.oauth_grants
    SET status = 'revoked',
        revoked_at = CURRENT_TIMESTAMP,
        revoked_reason = 'slice5_grant_revoked'
    WHERE id = ${grantId}
  `;
  assert.equal((await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint
  })).kind, "active", "grant revocation must preserve the browser session");

  const expiredDigest = randomBytes(32);
  sessionDigests.push(expiredDigest);
  assert.ok(await store.createLoginSession({
    sessionDigest: expiredDigest,
    ipFingerprint,
    ttlSeconds: 60 * 60,
    requestId: `${requestPrefix}-expired`,
    userAgentFingerprint: null
  }));
  await ownerSql`
    UPDATE public.oauth_login_sessions
    SET issued_at = CURRENT_TIMESTAMP - INTERVAL '2 hours',
        expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour'
    WHERE session_digest = ${expiredDigest}
  `;
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: expiredDigest,
    ipFingerprint
  }), { kind: "invalid" });

  const revokedDigest = randomBytes(32);
  sessionDigests.push(revokedDigest);
  assert.ok(await store.createLoginSession({
    sessionDigest: revokedDigest,
    ipFingerprint,
    ttlSeconds: 60 * 60,
    requestId: `${requestPrefix}-revoked`,
    userAgentFingerprint: null
  }));
  await ownerSql`
    UPDATE public.oauth_login_sessions
    SET revoked_at = GREATEST(CURRENT_TIMESTAMP, issued_at),
        revoked_reason = 'slice5_session_revoked'
    WHERE session_digest = ${revokedDigest}
  `;
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: revokedDigest,
    ipFingerprint
  }), { kind: "invalid" });

  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice5_fail_session_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'browser_login_session' THEN
        RAISE EXCEPTION 'injected Slice 5 login-session audit failure';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice5_fail_session_audit
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice5_fail_session_audit();
  `);
  const rollbackDigest = randomBytes(32);
  sessionDigests.push(rollbackDigest);
  const rollbackRequestId = `${requestPrefix}-rollback`;
  await assert.rejects(
    store.createLoginSession({
      sessionDigest: rollbackDigest,
      ipFingerprint,
      ttlSeconds: 60 * 60,
      requestId: rollbackRequestId,
      userAgentFingerprint: null
    }),
    OAuthStoreUnavailableError
  );
  const creationRollback = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_login_sessions
        WHERE session_digest = ${rollbackDigest}
      ) AS no_session,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_audit_events
        WHERE request_id = ${rollbackRequestId}
      ) AS no_audit
  `;
  assert.deepEqual({ ...creationRollback[0] }, { no_session: true, no_audit: true });
  await ownerSql`DROP TRIGGER slice5_fail_session_audit ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice5_fail_session_audit()`;

  await ownerSql`
    UPDATE public.oauth_principals
    SET authentication_epoch = authentication_epoch + 1
    WHERE id = ${bootstrap.principalId}
  `;
  assert.deepEqual(await store.resolveLoginSession({
    sessionDigest: primaryDigest,
    ipFingerprint
  }), { kind: "invalid" });

  const staleCodeDigest = randomBytes(32);
  assert.equal(await store.createAuthorization({
    authenticatedContext: created.context,
    codeDigest: staleCodeDigest,
    clientId: client.clientId,
    redirectUri,
    scopes,
    codeChallenge: "A".repeat(43),
    resource,
    expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
    requestId: `${requestPrefix}-stale-epoch`,
    ipFingerprint,
    userAgentFingerprint
  }), null, "a pre-logout session context must not capture the new epoch");
  const staleAuthority = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_authorization_codes
        WHERE code_digest = ${staleCodeDigest}
      ) AS no_code,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_audit_events
        WHERE request_id = ${`${requestPrefix}-stale-epoch`}
      ) AS no_audit
  `;
  assert.deepEqual({ ...staleAuthority[0] }, { no_code: true, no_audit: true });

  await ownerSql`
    UPDATE public.oauth_principals
    SET authentication_epoch = ${originalAuthenticationEpoch}
    WHERE id = ${bootstrap.principalId}
  `;
  assert.equal(await store.createAuthorization({
    authenticatedContext: {
      ...created.context,
      bindingVersion: created.context.bindingVersion + 1
    },
    codeDigest: randomBytes(32),
    clientId: client.clientId,
    redirectUri,
    scopes,
    codeChallenge: "A".repeat(43),
    resource,
    expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
    requestId: `${requestPrefix}-stale-binding`,
    ipFingerprint,
    userAgentFingerprint
  }), null);

  const primaryAudit = await ownerSql`
    SELECT
      event_type,
      outcome,
      actor_type,
      principal_id,
      binding_id,
      ip_fingerprint,
      user_agent_fingerprint,
      metadata
    FROM public.oauth_audit_events
    WHERE request_id = ${primaryRequestId}
  `;
  assert.equal(primaryAudit.length, 1);
  assert.deepEqual({
    eventType: primaryAudit[0].event_type,
    outcome: primaryAudit[0].outcome,
    actorType: primaryAudit[0].actor_type,
    principalId: primaryAudit[0].principal_id,
    bindingId: primaryAudit[0].binding_id,
    ipFingerprint: Buffer.from(primaryAudit[0].ip_fingerprint),
    userAgentFingerprint: Buffer.from(primaryAudit[0].user_agent_fingerprint),
    metadata: primaryAudit[0].metadata
  }, {
    eventType: "browser_login_session",
    outcome: "created",
    actorType: "browser",
    principalId: bootstrap.principalId,
    bindingId: bootstrap.bindingId,
    ipFingerprint: Buffer.from(ipFingerprint),
    userAgentFingerprint: Buffer.from(userAgentFingerprint),
    metadata: {}
  });
  const rawCookieCanary = `raw-cookie-${suffix}`;
  const rawIpCanary = `203.0.113.${Number.parseInt(suffix.slice(0, 2), 16) % 200 + 1}`;
  const redactionRows = await ownerSql`
    SELECT
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.row_to_json(session_row)::text, ''), '')
       FROM public.oauth_login_sessions AS session_row
       WHERE pg_catalog.encode(session_row.session_digest, 'hex') = ANY(
         ${ownerSql.array(sessionDigests.map((digest) => Buffer.from(digest).toString("hex")))}::text[]
       )) AS sessions,
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.row_to_json(audit_row)::text, ''), '')
       FROM public.oauth_audit_events AS audit_row
       WHERE audit_row.request_id LIKE ${`${requestPrefix}%`}) AS audits
  `;
  for (const serialized of [redactionRows[0].sessions, redactionRows[0].audits]) {
    assert.equal(serialized.includes(rawCookieCanary), false);
    assert.equal(serialized.includes(rawIpCanary), false);
  }
});

test("verified v1 login cookies upgrade once without extension and serialize concurrent or failed upgrades", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  let store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice5-upgrade-${suffix}`;
  const sessionDigests = [];
  let bootstrap = null;
  let originalLegacyNotBefore = null;

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => ownerSql`DROP TRIGGER IF EXISTS slice5_fail_upgrade_audit ON public.oauth_audit_events`,
      async () => ownerSql`DROP FUNCTION IF EXISTS public.slice5_fail_upgrade_audit()`,
      async () => originalLegacyNotBefore === null || bootstrap === null
        ? undefined
        : ownerSql`
            UPDATE public.oauth_principals
            SET legacy_not_before = ${originalLegacyNotBefore}
            WHERE id = ${bootstrap.principalId}
          `,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_login_sessions
        WHERE pg_catalog.encode(session_digest, 'hex') = ANY(
          ${ownerSql.array(sessionDigests.map((digest) => Buffer.from(digest).toString("hex")))}::text[]
        )
      `,
      async () => store?.close(),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "legacy login-session upgrade cleanup failed");
    }
  });

  bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);
  const principalRows = await ownerSql`
    SELECT legacy_not_before
    FROM public.oauth_principals
    WHERE id = ${bootstrap.principalId}
  `;
  assert.equal(principalRows.length, 1);
  originalLegacyNotBefore = principalRows[0].legacy_not_before;

  const nowMilliseconds = Math.floor(Date.now() / 1_000) * 1_000;
  const legacyIssuedAt = new Date(nowMilliseconds - 60 * 1_000);
  const legacyExpiresAt = new Date(nowMilliseconds + 60 * 60 * 1_000);
  const ipFingerprint = randomBytes(32);
  const userAgentFingerprint = randomBytes(32);
  const firstLegacyDigest = randomBytes(32);
  const firstSessionDigest = randomBytes(32);
  sessionDigests.push(firstSessionDigest);
  const firstRequestId = `${requestPrefix}-first`;
  const firstInput = {
    legacyCookieDigest: firstLegacyDigest,
    legacySubject: subject,
    legacyIssuedAt,
    legacyExpiresAt,
    sessionDigest: firstSessionDigest,
    ipFingerprint,
    requestId: firstRequestId,
    userAgentFingerprint
  };
  const firstUpgrade = await store.upgradeLegacyLoginSession(firstInput);
  assert.equal(firstUpgrade.kind, "upgraded");
  assert.equal(Object.isFrozen(firstUpgrade), true);
  assert.equal(Object.isFrozen(firstUpgrade.session), true);
  assert.deepEqual(firstUpgrade.session.context, bootstrap);
  assert.equal(
    firstUpgrade.session.expiresAt.getTime(),
    legacyExpiresAt.getTime(),
    "the opaque replacement must not extend the verified v1 lifetime"
  );
  assert.equal((await store.resolveLoginSession({
    sessionDigest: firstSessionDigest,
    ipFingerprint
  })).kind, "active");

  await store.close();
  store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  assert.equal((await store.resolveLoginSession({
    sessionDigest: firstSessionDigest,
    ipFingerprint
  })).kind, "active");

  const retryDigest = randomBytes(32);
  sessionDigests.push(retryDigest);
  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    sessionDigest: retryDigest,
    requestId: `${requestPrefix}-first-retry`
  }), { kind: "already_upgraded" });
  const firstCounts = await ownerSql`
    SELECT
      (SELECT pg_catalog.count(*)::integer
       FROM public.oauth_login_sessions
       WHERE legacy_cookie_digest = ${firstLegacyDigest}) AS session_count,
      (SELECT pg_catalog.count(*)::integer
       FROM public.oauth_audit_events
       WHERE request_id LIKE ${`${requestPrefix}-first%`}
         AND event_type = 'legacy_login_session_upgrade') AS audit_count,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_login_sessions
        WHERE session_digest = ${retryDigest}
      ) AS no_retry_session
  `;
  assert.deepEqual({ ...firstCounts[0] }, {
    session_count: 1,
    audit_count: 1,
    no_retry_session: true
  });

  const conflictingLegacyDigest = randomBytes(32);
  await assert.rejects(
    store.upgradeLegacyLoginSession({
      ...firstInput,
      legacyCookieDigest: conflictingLegacyDigest,
      sessionDigest: firstSessionDigest,
      requestId: `${requestPrefix}-duplicate-session-digest`
    }),
    (error) => assertGenericStoreError(error, [
      conflictingLegacyDigest,
      firstSessionDigest,
      ipFingerprint
    ])
  );
  assert.equal((await ownerSql`
    SELECT pg_catalog.count(*)::integer AS count
    FROM public.oauth_login_sessions
    WHERE legacy_cookie_digest = ${conflictingLegacyDigest}
  `)[0].count, 0);

  await ownerSql`
    UPDATE public.oauth_login_sessions
    SET revoked_at = GREATEST(CURRENT_TIMESTAMP, issued_at),
        revoked_reason = 'slice5_upgraded_session_revoked'
    WHERE session_digest = ${firstSessionDigest}
  `;
  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    sessionDigest: randomBytes(32),
    requestId: `${requestPrefix}-first-revoked-retry`
  }), { kind: "already_upgraded" }, "revocation must not make a v1 source reusable");

  const concurrentLegacyDigest = randomBytes(32);
  const concurrentCandidates = Array.from({ length: 8 }, () => randomBytes(32));
  sessionDigests.push(...concurrentCandidates);
  const concurrentResults = await Promise.all(concurrentCandidates.map(
    (sessionDigest, index) => store.upgradeLegacyLoginSession({
      legacyCookieDigest: concurrentLegacyDigest,
      legacySubject: subject,
      legacyIssuedAt,
      legacyExpiresAt,
      sessionDigest,
      ipFingerprint,
      requestId: `${requestPrefix}-concurrent-${index}`,
      userAgentFingerprint: null
    })
  ));
  assert.equal(concurrentResults.filter((result) => result.kind === "upgraded").length, 1);
  assert.equal(
    concurrentResults.filter((result) => result.kind === "already_upgraded").length,
    7
  );
  const concurrentCounts = await ownerSql`
    SELECT
      (SELECT pg_catalog.count(*)::integer
       FROM public.oauth_login_sessions
       WHERE legacy_cookie_digest = ${concurrentLegacyDigest}) AS session_count,
      (SELECT pg_catalog.count(*)::integer
       FROM public.oauth_audit_events
       WHERE request_id LIKE ${`${requestPrefix}-concurrent-%`}
         AND event_type = 'legacy_login_session_upgrade') AS audit_count
  `;
  assert.deepEqual({ ...concurrentCounts[0] }, { session_count: 1, audit_count: 1 });

  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    legacyCookieDigest: randomBytes(32),
    legacySubject: `${subject}-wrong`,
    sessionDigest: randomBytes(32),
    requestId: `${requestPrefix}-wrong-subject`
  }), { kind: "invalid" });
  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    legacyCookieDigest: randomBytes(32),
    legacyIssuedAt: new Date(nowMilliseconds - 2 * 60 * 60 * 1_000),
    legacyExpiresAt: new Date(nowMilliseconds - 60 * 60 * 1_000),
    sessionDigest: randomBytes(32),
    requestId: `${requestPrefix}-expired`
  }), { kind: "invalid" });
  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    legacyCookieDigest: randomBytes(32),
    legacyIssuedAt: new Date(nowMilliseconds + 2 * 60 * 1_000),
    legacyExpiresAt: new Date(nowMilliseconds + 62 * 60 * 1_000),
    sessionDigest: randomBytes(32),
    requestId: `${requestPrefix}-future`
  }), { kind: "invalid" });
  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    legacyCookieDigest: randomBytes(32),
    sessionDigest: randomBytes(32),
    requestId: `${requestPrefix}-raw-boundary`,
    rawCookie: `signed-v1-cookie-${suffix}`
  }), { kind: "invalid" });

  await ownerSql`
    UPDATE public.oauth_principals
    SET legacy_not_before = CURRENT_TIMESTAMP
    WHERE id = ${bootstrap.principalId}
  `;
  assert.deepEqual(await store.upgradeLegacyLoginSession({
    ...firstInput,
    legacyCookieDigest: randomBytes(32),
    sessionDigest: randomBytes(32),
    requestId: `${requestPrefix}-legacy-not-before`
  }), { kind: "invalid" });
  await ownerSql`
    UPDATE public.oauth_principals
    SET legacy_not_before = ${originalLegacyNotBefore}
    WHERE id = ${bootstrap.principalId}
  `;

  await ownerSql.unsafe(`
    CREATE FUNCTION public.slice5_fail_upgrade_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NEW.event_type = 'legacy_login_session_upgrade' THEN
        RAISE EXCEPTION 'injected Slice 5 legacy-upgrade audit failure';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TRIGGER slice5_fail_upgrade_audit
    BEFORE INSERT ON public.oauth_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.slice5_fail_upgrade_audit();
  `);
  const rollbackLegacyDigest = randomBytes(32);
  const rollbackSessionDigest = randomBytes(32);
  sessionDigests.push(rollbackSessionDigest);
  const rollbackRequestId = `${requestPrefix}-rollback`;
  const rollbackInput = {
    legacyCookieDigest: rollbackLegacyDigest,
    legacySubject: subject,
    legacyIssuedAt,
    legacyExpiresAt,
    sessionDigest: rollbackSessionDigest,
    ipFingerprint,
    requestId: rollbackRequestId,
    userAgentFingerprint: null
  };
  await assert.rejects(
    store.upgradeLegacyLoginSession(rollbackInput),
    OAuthStoreUnavailableError
  );
  const rollbackState = await ownerSql`
    SELECT
      NOT EXISTS (
        SELECT 1 FROM public.oauth_login_sessions
        WHERE legacy_cookie_digest = ${rollbackLegacyDigest}
      ) AS no_source_consumption,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_audit_events
        WHERE request_id = ${rollbackRequestId}
      ) AS no_audit
  `;
  assert.deepEqual({ ...rollbackState[0] }, {
    no_source_consumption: true,
    no_audit: true
  });
  await ownerSql`DROP TRIGGER slice5_fail_upgrade_audit ON public.oauth_audit_events`;
  await ownerSql`DROP FUNCTION public.slice5_fail_upgrade_audit()`;
  assert.equal((await store.upgradeLegacyLoginSession(rollbackInput)).kind, "upgraded");

  const firstAudit = await ownerSql`
    SELECT
      event_type,
      outcome,
      actor_type,
      principal_id,
      binding_id,
      ip_fingerprint,
      user_agent_fingerprint,
      metadata
    FROM public.oauth_audit_events
    WHERE request_id = ${firstRequestId}
  `;
  assert.equal(firstAudit.length, 1);
  assert.deepEqual({
    eventType: firstAudit[0].event_type,
    outcome: firstAudit[0].outcome,
    actorType: firstAudit[0].actor_type,
    principalId: firstAudit[0].principal_id,
    bindingId: firstAudit[0].binding_id,
    ipFingerprint: Buffer.from(firstAudit[0].ip_fingerprint),
    userAgentFingerprint: Buffer.from(firstAudit[0].user_agent_fingerprint),
    metadata: firstAudit[0].metadata
  }, {
    eventType: "legacy_login_session_upgrade",
    outcome: "upgraded",
    actorType: "browser",
    principalId: bootstrap.principalId,
    bindingId: bootstrap.bindingId,
    ipFingerprint: Buffer.from(ipFingerprint),
    userAgentFingerprint: Buffer.from(userAgentFingerprint),
    metadata: { sourceVersion: 1 }
  });

  const rawCookieCanary = `signed-v1-cookie-${suffix}`;
  const rawIpCanary = `198.51.100.${Number.parseInt(suffix.slice(0, 2), 16) % 200 + 1}`;
  const redactionRows = await ownerSql`
    SELECT
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.row_to_json(session_row)::text, ''), '')
       FROM public.oauth_login_sessions AS session_row
       WHERE pg_catalog.encode(session_row.session_digest, 'hex') = ANY(
         ${ownerSql.array(sessionDigests.map((digest) => Buffer.from(digest).toString("hex")))}::text[]
       )) AS sessions,
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.row_to_json(audit_row)::text, ''), '')
       FROM public.oauth_audit_events AS audit_row
       WHERE audit_row.request_id LIKE ${`${requestPrefix}%`}) AS audits
  `;
  for (const serialized of [redactionRows[0].sessions, redactionRows[0].audits]) {
    assert.equal(serialized.includes(rawCookieCanary), false);
    assert.equal(serialized.includes(rawIpCanary), false);
  }
});

test("authorization creation serializes with security logout and redacts duplicate-code failures", async (t) => {
  const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  assertDisposableDatabaseUrls(ownerDatabaseUrl, gatewayDatabaseUrl);
  const migration = await requiredMigration();
  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const blockerSql = postgres(ownerDatabaseUrl, { max: 1 });
  const logoutSql = postgres(ownerDatabaseUrl, { max: 1 });
  const store = createPostgresOAuthStore(
    oauthStoreOptions(gatewayDatabaseUrl, migration, issuer, subject, agentExternalId)
  );
  const suffix = randomUUID().replaceAll("-", "");
  const requestPrefix = `slice5-order-${suffix}`;
  const logoutReason = `slice5-order-${suffix}`;
  let bootstrap = null;
  let client = null;
  let originalAuthenticationEpoch = null;
  let originalLegacyNotBefore = null;
  let releaseBlocker = null;
  let blockerPromise = null;
  let logoutPromise = null;

  t.after(async () => {
    const errors = [];
    for (const operation of [
      async () => releaseBlocker?.(),
      async () => blockerPromise === null ? undefined : blockerPromise,
      async () => logoutPromise === null ? undefined : logoutPromise,
      async () => bootstrap === null || originalAuthenticationEpoch === null ||
        originalLegacyNotBefore === null
        ? undefined
        : ownerSql`
            UPDATE public.oauth_principals
            SET authentication_epoch = ${originalAuthenticationEpoch},
                legacy_not_before = ${originalLegacyNotBefore}
            WHERE id = ${bootstrap.principalId}
          `,
      async () => ownerSql`
        DELETE FROM public.oauth_audit_events
        WHERE request_id LIKE ${`${requestPrefix}%`}
           OR metadata ->> 'reason' = ${logoutReason}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_authorization_codes
        WHERE oauth_client_id = ${client?.id ?? null}
      `,
      async () => ownerSql`
        DELETE FROM public.oauth_clients
        WHERE id = ${client?.id ?? null}
      `,
      async () => store.close(),
      async () => blockerSql.end({ timeout: 5 }),
      async () => logoutSql.end({ timeout: 5 }),
      async () => ownerSql.end({ timeout: 5 })
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "authorization/logout ordering cleanup failed");
    }
  });

  bootstrap = await store.resolveBootstrapBinding();
  assert.ok(bootstrap);
  originalAuthenticationEpoch = bootstrap.authenticationEpoch;
  const principalRows = await ownerSql`
    SELECT legacy_not_before
    FROM public.oauth_principals
    WHERE id = ${bootstrap.principalId}
  `;
  assert.equal(principalRows.length, 1);
  originalLegacyNotBefore = principalRows[0].legacy_not_before;

  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const resource = "https://cortex.example.test/mcp";
  const scopes = ["cortex:read", "mcp"];
  const codeChallenge = "A".repeat(43);
  const ipFingerprint = randomBytes(32);
  const userAgentFingerprint = randomBytes(32);
  client = await store.registerDynamicClient({
    redirectUris: [redirectUri],
    clientName: `Slice 5 ordering ${suffix}`
  });
  assert.ok(client);

  function authorizationInputFor(codeDigest, requestId) {
    return {
      authenticatedContext: bootstrap,
      codeDigest,
      clientId: client.clientId,
      redirectUri,
      scopes,
      codeChallenge,
      resource,
      expiresAt: new Date(Date.now() + 5 * 60 * 1_000),
      requestId,
      ipFingerprint,
      userAgentFingerprint
    };
  }

  const beforeLogoutDigest = randomBytes(32);
  assert.equal(await store.createAuthorization(authorizationInputFor(
    beforeLogoutDigest,
    `${requestPrefix}-before-logout`
  )), undefined);
  await assert.rejects(
    store.createAuthorization(authorizationInputFor(
      beforeLogoutDigest,
      `${requestPrefix}-duplicate-code`
    )),
    (error) => assertGenericStoreError(error, [
      beforeLogoutDigest,
      ipFingerprint,
      userAgentFingerprint
    ])
  );
  assert.equal(await store.createAuthorization({
    ...authorizationInputFor(randomBytes(32), `${requestPrefix}-raw-boundary`),
    rawCode: `raw-code-${suffix}`
  }), null);

  let markBlockerLocked;
  const blockerLocked = new Promise((resolve) => {
    markBlockerLocked = resolve;
  });
  let unblock;
  const unblockPromise = new Promise((resolve) => {
    unblock = resolve;
  });
  releaseBlocker = unblock;
  blockerPromise = blockerSql.begin(async (transaction) => {
    await transaction`
      LOCK TABLE public.oauth_authorization_codes IN SHARE ROW EXCLUSIVE MODE
    `;
    markBlockerLocked();
    await unblockPromise;
  });
  await blockerLocked;

  let publishLogoutPid;
  const logoutPidReady = new Promise((resolve) => {
    publishLogoutPid = resolve;
  });
  logoutPromise = logoutSql.begin(async (transaction) => {
    const pidRows = await transaction`SELECT pg_catalog.pg_backend_pid() AS pid`;
    publishLogoutPid(pidRows[0].pid);
    const rows = await transaction`
      SELECT public.oauth_operator_security_logout(
        ${issuer},
        ${subject},
        'slice5-test',
        ${logoutReason}
      ) AS result
    `;
    return rows[0].result;
  });
  const logoutPid = await logoutPidReady;
  let logoutWaiting = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await ownerSql`
      SELECT wait_event_type
      FROM pg_catalog.pg_stat_activity
      WHERE pid = ${logoutPid}
    `;
    if (rows[0]?.wait_event_type === "Lock") {
      logoutWaiting = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(logoutWaiting, true, "security logout must be waiting behind the code-table barrier");

  const afterLogoutDigest = randomBytes(32);
  const afterLogoutRequestId = `${requestPrefix}-after-logout`;
  const afterLogoutCreation = store.createAuthorization(
    authorizationInputFor(afterLogoutDigest, afterLogoutRequestId)
  );
  let gatewayWaiting = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await ownerSql`
      SELECT pg_catalog.count(*)::integer AS count
      FROM pg_catalog.pg_stat_activity
      WHERE usename = 'cortex_oauth_gateway'
        AND state = 'active'
        AND wait_event_type = 'Lock'
    `;
    if (rows[0].count > 0) {
      gatewayWaiting = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gatewayWaiting, true, "authorization creation must wait behind the same barrier");

  releaseBlocker();
  releaseBlocker = null;
  await blockerPromise;
  const [logoutResult, afterLogoutResult] = await Promise.all([
    logoutPromise,
    afterLogoutCreation
  ]);
  assert.equal(logoutResult.matched, true);
  assert.equal(afterLogoutResult, null);

  const orderedAuthority = await ownerSql`
    SELECT
      (SELECT consumed_at IS NOT NULL
       FROM public.oauth_authorization_codes
       WHERE code_digest = ${beforeLogoutDigest}) AS prior_code_consumed,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_authorization_codes
        WHERE code_digest = ${afterLogoutDigest}
      ) AS no_post_logout_code,
      NOT EXISTS (
        SELECT 1 FROM public.oauth_audit_events
        WHERE request_id = ${afterLogoutRequestId}
      ) AS no_post_logout_audit
  `;
  assert.deepEqual({ ...orderedAuthority[0] }, {
    prior_code_consumed: true,
    no_post_logout_code: true,
    no_post_logout_audit: true
  });
});
