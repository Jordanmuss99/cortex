import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { readLegacyState } from "./legacy-state.js";
import { createOAuthCrypto } from "./oauth-crypto.js";
import { createPostgresOAuthStore } from "./oauth-store.js";
import { createLegacyImportInput } from "./server.js";
import { startGatewayV2 } from "./server-v2.js";

const runFile = promisify(execFile);
const FROZEN_MIGRATION_009_SHA256 =
  "e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80";
const CURRENT_MIGRATION_010_SHA256 =
  "c41cdcbd0bdef50d673dbb19bbdea47403d4b8e8981c7d2438f6a1ead8789df5";
const MIGRATION_009 = new URL("../db/migrations/009_oauth_authority.sql", import.meta.url);
const MIGRATION_010 = new URL("../db/migrations/010_memory_lifecycle.sql", import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for the release-image proof`);
  return value;
}

function assertDisposableEnvironment(ownerDatabaseUrl, gatewayDatabaseUrl) {
  assert.equal(requiredEnvironment("MCP_OAUTH_TEST_DISPOSABLE"), "1");
  for (const value of [ownerDatabaseUrl, gatewayDatabaseUrl]) {
    const url = new URL(value);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(decodeURIComponent(url.pathname), "/cortex_test");
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
  }
  assert.equal(new URL(ownerDatabaseUrl).host, new URL(gatewayDatabaseUrl).host);
}

async function docker(args, options = {}) {
  const result = await runFile("docker", args, {
    cwd: REPOSITORY_ROOT,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return result.stdout.trim();
}

async function removeContainer(name) {
  await docker(["rm", "--force", name], { timeout: 15_000 }).catch(() => {});
}

async function mappedPort(name) {
  const output = await docker(["port", name, "8080/tcp"]);
  const match = output.match(/^127\.0\.0\.1:([1-9][0-9]*)$/m);
  assert.ok(match, "release-image container must publish one IPv4 loopback port");
  return Number(match[1]);
}

async function waitForHttp(port, path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`container HTTP startup timed out: ${lastError?.message ?? "unavailable"}`);
}

async function waitForContainerExit(name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await docker([
      "inspect",
      "--format",
      "{{.State.Running}} {{.State.ExitCode}}",
      name
    ]);
    const match = state.match(/^(true|false) ([0-9]+)$/);
    assert.ok(match, "container state must be inspectable");
    if (match[1] === "false") return Number(match[2]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("expected-failure container did not exit within its deadline");
}

async function startContainer({ name, image, network, stateDirectory, readOnly, env }) {
  const mount = [
    "type=bind",
    `source=${stateDirectory}`,
    "target=/var/lib/cortex-oauth",
    ...(readOnly ? ["readonly"] : [])
  ].join(",");
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--network",
    network,
    "--publish",
    "127.0.0.1::8080",
    "--mount",
    mount
  ];
  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(image);
  await docker(args);
  return mappedPort(name);
}

function form(port, path, values, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers
    },
    body: new URLSearchParams(values)
  });
}

function challenge(verifier) {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

async function authorize({ port, clientId, callback, resource, subject, password, state }) {
  const verifier = randomBytes(32).toString("base64url");
  const response = await form(port, "/authorize", {
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: "cortex:read cortex:write mcp",
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    resource,
    username: subject,
    password
  });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.searchParams.get("state"), state);
  const code = location.searchParams.get("code");
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  return { code, verifier };
}

async function register(port, callback) {
  const response = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [callback],
      client_name: "Slice 13 rollback image proof",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.match(body.client_id, /^chatgpt-[A-Za-z0-9_-]{24}$/);
  return body.client_id;
}

async function availablePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function requiredMigration() {
  const [oauthBytes, memoryBytes] = await Promise.all([
    readFile(MIGRATION_009),
    readFile(MIGRATION_010)
  ]);
  const oauthSha256 = createHash("sha256").update(oauthBytes).digest("hex");
  const memorySha256 = createHash("sha256").update(memoryBytes).digest("hex");
  assert.equal(oauthSha256, FROZEN_MIGRATION_009_SHA256);
  assert.equal(memorySha256, CURRENT_MIGRATION_010_SHA256);
  return {
    id: "009_oauth_authority",
    sha256: oauthSha256,
    additionalMigrations: [{ id: "010_memory_lifecycle", sha256: memorySha256 }]
  };
}

function imageEnvironment({
  issuer,
  resource,
  subject,
  agentExternalId,
  password,
  jwtSecret,
  databaseUrl
}) {
  return {
    PORT: "8080",
    BASE_URL: issuer,
    ISSUER_URL: issuer,
    RESOURCE_URL: resource,
    MCP_TARGET: "http://127.0.0.1:1",
    REST_TARGET: "http://127.0.0.1:1",
    MCP_OAUTH_DATABASE_URL: databaseUrl,
    MCP_OAUTH_USERNAME: subject,
    MCP_OAUTH_AGENT_ID: agentExternalId,
    MCP_OAUTH_PASSWORD: password,
    MCP_OAUTH_JWT_SECRET: jwtSecret,
    MCP_OAUTH_STATE_FILE: "/var/lib/cortex-oauth/state.json",
    MCP_OAUTH_ACCEPT_LEGACY_UNTIL: new Date(
      Date.now() + 24 * 60 * 60 * 1_000
    ).toISOString(),
    MCP_OAUTH_FRESH_INSTALL: "0"
  };
}

test(
  "retained pre-v2 image rolls back before v2 issuance and the exact DB-aware image rotates an existing v2 family",
  { skip: process.env.MCP_OAUTH_TEST_RELEASE_IMAGES !== "1", timeout: 120_000 },
  async (t) => {
    const ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
    const gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
    assertDisposableEnvironment(ownerDatabaseUrl, gatewayDatabaseUrl);
    const network = requiredEnvironment("MCP_OAUTH_TEST_DOCKER_NETWORK");
    const candidateImage = requiredEnvironment("MCP_OAUTH_TEST_CANDIDATE_IMAGE");
    const preV2Image = requiredEnvironment("MCP_OAUTH_TEST_PRE_V2_IMAGE");
    const issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
    const subject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
    const agentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
    const password = requiredEnvironment("MCP_OAUTH_TEST_PASSWORD");
    const jwtSecret = requiredEnvironment("MCP_OAUTH_TEST_JWT_SECRET");
    const resource = `${issuer}/mcp`;
    const callback = `https://chatgpt.com/connector/oauth/slice13-${randomBytes(6).toString("hex")}`;
    const testId = `${process.pid}-${randomBytes(5).toString("hex")}`;
    const legacyName = `cortex-s13-v1-${testId}`;
    const failedCandidateName = `cortex-s13-fail-${testId}`;
    const compatibilityName = `cortex-s13-compat-${testId}`;
    const containers = new Set();
    const directory = await mkdtemp(join(tmpdir(), "cortex-slice13-images-"));
    const statePath = join(directory, "state.json");
    let runtime = null;

    t.after(async () => {
      await runtime?.close().catch(() => {});
      for (const name of containers) await removeContainer(name);
      await rm(directory, { recursive: true, force: true });
    });

    const internalDatabase = new URL(gatewayDatabaseUrl);
    internalDatabase.hostname = "db";
    internalDatabase.port = "5432";
    const commonEnvironment = imageEnvironment({
      issuer,
      resource,
      subject,
      agentExternalId,
      password,
      jwtSecret,
      databaseUrl: internalDatabase.toString()
    });

    containers.add(legacyName);
    const legacyPort = await startContainer({
      name: legacyName,
      image: preV2Image,
      network,
      stateDirectory: directory,
      readOnly: false,
      env: commonEnvironment
    });
    const legacyMetadata = await waitForHttp(
      legacyPort,
      "/.well-known/oauth-authorization-server"
    );
    assert.equal(legacyMetadata.status, 200);
    const clientId = await register(legacyPort, callback);
    const firstAuthorization = await authorize({
      port: legacyPort,
      clientId,
      callback,
      resource,
      subject,
      password,
      state: "pre-v2-rollback"
    });
    await removeContainer(legacyName);
    containers.delete(legacyName);

    const beforeFailureBytes = await readFile(statePath);
    const beforeFailureMode = (await stat(statePath)).mode & 0o7777;
    assert.equal(beforeFailureMode, 0o600);

    containers.add(failedCandidateName);
    await startContainer({
      name: failedCandidateName,
      image: candidateImage,
      network,
      stateDirectory: directory,
      readOnly: true,
      env: {
        ...commonEnvironment,
        MCP_OAUTH_DATABASE_URL:
          "postgresql://cortex_oauth_gateway:unreachable@db:1/cortex_test"
      }
    });
    const failedExitCode = await waitForContainerExit(failedCandidateName);
    assert.notEqual(failedExitCode, 0);
    assert.deepEqual(await readFile(statePath), beforeFailureBytes);
    assert.equal((await stat(statePath)).mode & 0o7777, beforeFailureMode);
    await removeContainer(failedCandidateName);
    containers.delete(failedCandidateName);

    containers.add(legacyName);
    const rollbackPort = await startContainer({
      name: legacyName,
      image: preV2Image,
      network,
      stateDirectory: directory,
      readOnly: false,
      env: commonEnvironment
    });
    await waitForHttp(rollbackPort, "/.well-known/oauth-authorization-server");
    const rollbackExchange = await form(rollbackPort, "/token", {
      grant_type: "authorization_code",
      code: firstAuthorization.code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: firstAuthorization.verifier
    });
    const rollbackTokens = await rollbackExchange.json();
    assert.equal(rollbackExchange.status, 200);
    const rollbackClaims = JSON.parse(
      Buffer.from(rollbackTokens.access_token.split(".")[1], "base64url").toString("utf8")
    );
    assert.equal(Object.hasOwn(rollbackClaims, "sid"), false);

    const importAuthorization = await authorize({
      port: rollbackPort,
      clientId,
      callback,
      resource,
      subject,
      password,
      state: "post-v2-candidate"
    });
    await removeContainer(legacyName);
    containers.delete(legacyName);

    const frozenBytes = await readFile(statePath);
    const frozenMode = (await stat(statePath)).mode & 0o7777;
    assert.equal(frozenMode, 0o600);
    const snapshot = await readLegacyState(statePath);
    assert.equal(snapshot.state.codes.length, 1);

    const port = await availablePort();
    const config = Object.freeze({
      port,
      baseUrl: issuer,
      issuerUrl: issuer,
      resourceUrl: resource,
      mcpTarget: "http://127.0.0.1:1",
      restTarget: "http://127.0.0.1:1",
      databaseUrl: gatewayDatabaseUrl,
      bootstrapSubject: subject,
      bootstrapAgentExternalId: agentExternalId,
      accessTokenTtlSeconds: 300,
      refreshTokenTtlSeconds: 3600,
      refreshRetryGraceSeconds: 30,
      authCodeTtlSeconds: 300,
      loginSessionTtlSeconds: 30 * 24 * 60 * 60,
      acceptLegacyUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      trustedIpHeader: "",
      trustedProxyCidrs: [],
      loginAttemptLimit: 10,
      loginAttemptWindowSeconds: 60,
      registrationAttemptLimit: 10,
      registrationAttemptWindowSeconds: 60
    });
    const secrets = Object.freeze({ jwtSecret, browserPassword: password });
    const crypto = createOAuthCrypto(config, secrets);
    const importInput = createLegacyImportInput(snapshot, crypto);
    const expectedLegacyState = Object.freeze({
      sourceChecksum: importInput.sourceChecksum,
      clientCount: importInput.clients.length,
      codeCount: importInput.codes.length
    });
    const migration = await requiredMigration();
    const store = createPostgresOAuthStore({
      databaseUrl: gatewayDatabaseUrl,
      requiredMigration: migration,
      bootstrap: { issuer, subject, agentExternalId },
      baseUrl: issuer,
      resourceUrl: resource,
      acceptLegacyUntil: config.acceptLegacyUntil,
      expectedLegacyState
    });
    await store.importLegacyStateOnce(importInput);
    runtime = await startGatewayV2({
      config,
      secrets,
      requiredMigration: migration,
      expectedLegacyState,
      storeFactory: () => store,
      host: "127.0.0.1"
    });

    const initialV2Exchange = await form(port, "/token", {
      grant_type: "authorization_code",
      code: importAuthorization.code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: importAuthorization.verifier
    });
    const initialV2Tokens = await initialV2Exchange.json();
    assert.equal(initialV2Exchange.status, 200);
    const initialAccessClaims = await runtime.crypto.verifyAccessToken(
      initialV2Tokens.access_token
    );
    const initialRefreshClaims = await runtime.crypto.verifyRefreshToken(
      initialV2Tokens.refresh_token
    );
    assert.equal(initialAccessClaims.sid, initialRefreshClaims.sid);
    assert.equal(initialAccessClaims.agent_id, agentExternalId);
    assert.equal(initialRefreshClaims.generation, 0);
    await runtime.close();
    runtime = null;

    containers.add(compatibilityName);
    const compatibilityPort = await startContainer({
      name: compatibilityName,
      image: candidateImage,
      network,
      stateDirectory: directory,
      readOnly: true,
      env: commonEnvironment
    });
    const live = await waitForHttp(compatibilityPort, "/livez");
    assert.equal(live.status, 200);

    const existingAccess = await fetch(
      `http://127.0.0.1:${compatibilityPort}/api/v1/status`,
      { headers: { authorization: `Bearer ${initialV2Tokens.access_token}` } }
    );
    assert.notEqual(existingAccess.status, 401);
    assert.notEqual(existingAccess.status, 403);

    const rotated = await form(compatibilityPort, "/token", {
      grant_type: "refresh_token",
      refresh_token: initialV2Tokens.refresh_token,
      client_id: clientId
    });
    const rotatedTokens = await rotated.json();
    assert.equal(rotated.status, 200);
    const rotatedAccessClaims = await crypto.verifyAccessToken(rotatedTokens.access_token);
    const rotatedRefreshClaims = await crypto.verifyRefreshToken(rotatedTokens.refresh_token);
    assert.equal(rotatedAccessClaims.sid, initialAccessClaims.sid);
    assert.equal(rotatedRefreshClaims.sid, initialAccessClaims.sid);
    assert.equal(rotatedRefreshClaims.generation, 1);
    assert.equal(rotatedAccessClaims.agent_id, agentExternalId);

    const candidateAuthorization = await authorize({
      port: compatibilityPort,
      clientId,
      callback,
      resource,
      subject,
      password,
      state: "candidate-new-family"
    });
    const candidateExchange = await form(compatibilityPort, "/token", {
      grant_type: "authorization_code",
      code: candidateAuthorization.code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: candidateAuthorization.verifier
    });
    const candidateTokens = await candidateExchange.json();
    assert.equal(candidateExchange.status, 200);
    const candidateClaims = await crypto.verifyAccessToken(candidateTokens.access_token);
    assert.match(candidateClaims.sid, /^[0-9a-f-]{36}$/);
    assert.equal(candidateClaims.agent_id, agentExternalId);

    assert.deepEqual(await readFile(statePath), frozenBytes);
    assert.equal((await stat(statePath)).mode & 0o7777, frozenMode);
  }
);
