import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { jwtVerify } from "jose";

const TEST_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
const TEST_RESOURCE = "https://cortex.example.test/mcp";
const TEST_ISSUER = "https://cortex.example.test";
const TEST_REDIRECT = "https://chatgpt.com/connector/oauth/test-callback";
const TEST_STABLE_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

let port;
let mcpPort;
let restPort;
let gateway;
let mockMcp;
let mockRest;
let refreshToken;
let clientId;
let stateDirectory;
let stateFile;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

function startGateway(environmentOverrides = {}) {
  const child = spawn(process.execPath, ["server-v1.js"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      BASE_URL: TEST_ISSUER,
      RESOURCE_URL: TEST_RESOURCE,
      ISSUER_URL: TEST_ISSUER,
      MCP_OAUTH_USERNAME: "test-user",
      MCP_OAUTH_PASSWORD: "test-password",
      MCP_OAUTH_JWT_SECRET: TEST_SECRET,
      MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "60",
      MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "3600",
      MCP_OAUTH_STATE_FILE: stateFile,
      MCP_OAUTH_TRUSTED_IP_HEADER: "x-test-client-ip",
      MCP_OAUTH_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
      MCP_OAUTH_LOGIN_ATTEMPT_LIMIT: "1000",
      MCP_OAUTH_REGISTRATION_ATTEMPT_LIMIT: "1000",
      MCP_TARGET: `http://127.0.0.1:${mcpPort}`,
      REST_TARGET: `http://127.0.0.1:${restPort}`,
      ...environmentOverrides
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  return new Promise((resolve, reject) => {
    let stderr = "";
    const onExit = (code) => reject(new Error(`Gateway exited before startup with code ${code}: ${stderr}`));

    child.once("exit", onExit);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes(`[oauth-gateway] listening on :${port}`)) {
        child.off("exit", onExit);
        resolve(child);
      }
    });
  });
}

function startMockMcpServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/mcp") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      res.flushHeaders();
      res.write('event: message\ndata: {"jsonrpc":"2.0","method":"mock/ready"}\n\n');
      setTimeout(() => res.end(), 1000);
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let message = {};
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}

      if (message.method === "mock/compressed") {
        const compressed = gzipSync(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: { decoded: true }
        }));
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(compressed.length)
        });
        res.end(compressed);
        return;
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          method: message.method ?? "unknown",
          received_authorization: Boolean(req.headers.authorization),
          received_cookie: Boolean(req.headers.cookie),
          received_cf_access_token: Boolean(req.headers["cf-access-jwt-assertion"]),
          received_cf_access_client_secret: Boolean(req.headers["cf-access-client-secret"]),
          received_api_key: Boolean(req.headers["x-api-key"]),
          received_auth_token: Boolean(req.headers["x-auth-token"]),
          received_session_id: req.headers["mcp-session-id"] ?? null,
          received_protocol_version: req.headers["mcp-protocol-version"] ?? null,
          received_arguments: message.params?.arguments ?? null
        }
      }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(mcpPort, "127.0.0.1", () => resolve(server));
  });
}

function startMockRestServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = rawBody;
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        body,
        received_authorization: Boolean(req.headers.authorization),
        received_cookie: Boolean(req.headers.cookie),
        received_cf_access_token: Boolean(req.headers["cf-access-jwt-assertion"]),
        received_cf_access_client_secret: Boolean(req.headers["cf-access-client-secret"]),
        received_api_key: Boolean(req.headers["x-api-key"]),
        received_auth_token: Boolean(req.headers["x-auth-token"])
      }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(restPort, "127.0.0.1", () => resolve(server));
  });
}

function stopGateway(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function postForm(path, values, headers = {}) {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(values),
    redirect: "manual"
  });
}

async function issueAccessTokenForScope(scope) {
  const redirectUri = `${TEST_REDIRECT}-${crypto.randomBytes(4).toString("hex")}`;
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "ChatGPT scope test" })
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizationResponse = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope,
    state: "scope-test",
    code_challenge: challenge,
    resource: TEST_RESOURCE
  });
  assert.equal(authorizationResponse.status, 302);

  const redirect = new URL(authorizationResponse.headers.get("location"));
  const tokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code"),
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200);
  return tokens.access_token;
}

before(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "cortex-oauth-test-"));
  stateFile = join(stateDirectory, "state.json");
  port = await getAvailablePort();
  mcpPort = await getAvailablePort();
  restPort = await getAvailablePort();
  mockMcp = await startMockMcpServer();
  mockRest = await startMockRestServer();
  gateway = await startGateway();
});

after(async () => {
  await stopGateway(gateway);
  await new Promise((resolve) => mockMcp.close(resolve));
  await new Promise((resolve) => mockRest.close(resolve));
  await rm(stateDirectory, { recursive: true, force: true });
});

test("advertises and completes a restart-safe refresh-token flow", async () => {
  const metadataResponse = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
  const metadata = await metadataResponse.json();

  assert.equal(metadataResponse.status, 200);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);

  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [TEST_REDIRECT], client_name: "ChatGPT test" })
  });
  const registration = await registrationResponse.json();

  assert.equal(registrationResponse.status, 201);
  assert.deepEqual(registration.grant_types, ["authorization_code", "refresh_token"]);
  clientId = registration.client_id;

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizationResponse = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: clientId,
    redirect_uri: TEST_REDIRECT,
    scope: "cortex:read cortex:write mcp",
    state: "test-state",
    code_challenge: challenge,
    resource: TEST_RESOURCE
  });

  assert.equal(authorizationResponse.status, 302);
  const redirect = new URL(authorizationResponse.headers.get("location"));
  assert.equal(redirect.searchParams.get("state"), "test-state");
  assert.ok(redirect.searchParams.get("code"));

  const tokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code"),
    redirect_uri: TEST_REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });
  const tokens = await tokenResponse.json();

  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 60);
  assert.equal(tokens.refresh_token_expires_in, 3600);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const secretKey = new TextEncoder().encode(TEST_SECRET);
  const { payload: accessPayload } = await jwtVerify(tokens.access_token, secretKey, {
    issuer: TEST_ISSUER,
    audience: TEST_RESOURCE
  });
  assert.equal(accessPayload.client_id, clientId);
  assert.equal(accessPayload.scope, "cortex:read cortex:write mcp");
  assert.equal(accessPayload.token_use, "access");

  const refreshAsAccessResponse = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { authorization: `Bearer ${tokens.refresh_token}` }
  });
  assert.equal(refreshAsAccessResponse.status, 401);

  const firstRefreshResponse = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource: TEST_RESOURCE
  });
  const firstRefresh = await firstRefreshResponse.json();

  assert.equal(firstRefreshResponse.status, 200);
  assert.ok(firstRefresh.access_token);
  assert.ok(firstRefresh.refresh_token);
  assert.notEqual(firstRefresh.refresh_token, tokens.refresh_token);
  refreshToken = firstRefresh.refresh_token;

  await stopGateway(gateway);
  gateway = await startGateway();

  const afterRestartResponse = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: TEST_RESOURCE
  });
  const afterRestart = await afterRestartResponse.json();

  assert.equal(afterRestartResponse.status, 200);
  assert.ok(afterRestart.access_token);
  assert.ok(afterRestart.refresh_token);
});

test("persists a DCR client and outstanding authorization code across restarts", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const redirectUri = `${TEST_REDIRECT}-restart-${suffix}`;
  const unregisteredRedirectUri = `${TEST_REDIRECT}-unregistered-${suffix}`;
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Restart persistence test" })
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizationResponse = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "cortex:read cortex:write mcp",
    state: "restart-persistence",
    code_challenge: challenge,
    resource: TEST_RESOURCE
  });
  assert.equal(authorizationResponse.status, 302);
  const code = new URL(authorizationResponse.headers.get("location")).searchParams.get("code");
  assert.ok(code);

  const storedState = await readFile(stateFile, "utf8");
  assert.equal(storedState.includes(TEST_SECRET), false);
  assert.equal(storedState.includes("test-password"), false);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

  await stopGateway(gateway);
  gateway = await startGateway();

  const mismatchedCallbackResponse = await fetch(
    `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: unregisteredRedirectUri,
      scope: "cortex:read cortex:write mcp",
      state: "must-not-redirect",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: TEST_RESOURCE
    })}`
  );
  assert.equal(mismatchedCallbackResponse.status, 400);

  const tokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });
  assert.equal(tokenResponse.status, 200);
  assert.ok((await tokenResponse.json()).refresh_token);

  await stopGateway(gateway);
  gateway = await startGateway();

  const replayResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });
  assert.equal(replayResponse.status, 400);
  assert.equal((await replayResponse.json()).error, "invalid_grant");
});

test("prunes expired authorization codes when the gateway restarts", async () => {
  await stopGateway(gateway);
  gateway = await startGateway({ MCP_OAUTH_AUTH_CODE_TTL_SECONDS: "1" });

  const redirectUri = `${TEST_REDIRECT}-expiring-${crypto.randomBytes(4).toString("hex")}`;
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] })
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorizationResponse = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "cortex:read mcp",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    resource: TEST_RESOURCE
  });
  assert.equal(authorizationResponse.status, 302);
  const code = new URL(authorizationResponse.headers.get("location")).searchParams.get("code");

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await stopGateway(gateway);
  gateway = await startGateway();

  const prunedState = await readFile(stateFile, "utf8");
  assert.equal(prunedState.includes(code), false);

  const tokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: TEST_RESOURCE
  });
  assert.equal(tokenResponse.status, 400);
  assert.equal((await tokenResponse.json()).error, "invalid_grant");
});

test("reuses a signed login cookie only from the same client IP", async () => {
  const clientIp = "203.0.113.10";
  const redirectUri = `${TEST_REDIRECT}-login-session-${crypto.randomBytes(4).toString("hex")}`;
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] })
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201);

  const firstVerifier = crypto.randomBytes(32).toString("base64url");
  const firstAuthorization = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "cortex:read cortex:write mcp",
    state: "initial-login",
    code_challenge: crypto.createHash("sha256").update(firstVerifier).digest("base64url"),
    resource: TEST_RESOURCE
  }, { "x-test-client-ip": clientIp });
  assert.equal(firstAuthorization.status, 302);

  const setCookie = firstAuthorization.headers.get("set-cookie") || "";
  assert.equal(setCookie.startsWith("__Host-cortex_oauth_session="), true);
  assert.equal(/; HttpOnly/i.test(setCookie), true);
  assert.equal(/; Secure/i.test(setCookie), true);
  assert.equal(/; SameSite=Lax/i.test(setCookie), true);
  assert.equal(/; Path=\//i.test(setCookie), true);
  assert.equal(/; Max-Age=2592000/i.test(setCookie), true);
  assert.equal(setCookie.includes(clientIp), false);
  const cookie = setCookie.split(";", 1)[0];

  const firstCode = new URL(firstAuthorization.headers.get("location")).searchParams.get("code");
  const firstTokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code: firstCode,
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: firstVerifier,
    resource: TEST_RESOURCE
  });
  assert.equal(firstTokenResponse.status, 200);

  await stopGateway(gateway);
  gateway = await startGateway();

  const secondVerifier = crypto.randomBytes(32).toString("base64url");
  const secondChallenge = crypto.createHash("sha256").update(secondVerifier).digest("base64url");
  const sameIpResponse = await fetch(
    `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: "cortex:read cortex:write mcp",
      state: "cookie-reuse",
      code_challenge: secondChallenge,
      code_challenge_method: "S256",
      resource: TEST_RESOURCE
    })}`,
    {
      headers: { cookie, "x-test-client-ip": clientIp },
      redirect: "manual"
    }
  );
  assert.equal(sameIpResponse.status, 302);
  const sameIpRedirect = new URL(sameIpResponse.headers.get("location"));
  assert.equal(sameIpRedirect.searchParams.get("state"), "cookie-reuse");

  const secondTokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code: sameIpRedirect.searchParams.get("code"),
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: secondVerifier,
    resource: TEST_RESOURCE
  });
  assert.equal(secondTokenResponse.status, 200);

  const differentIpResponse = await fetch(
    `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: "cortex:read cortex:write mcp",
      state: "ip-mismatch",
      code_challenge: crypto.createHash("sha256").update("different-ip-verifier").digest("base64url"),
      code_challenge_method: "S256",
      resource: TEST_RESOURCE
    })}`,
    {
      headers: { cookie, "x-test-client-ip": "203.0.113.11" },
      redirect: "manual"
    }
  );
  assert.equal(differentIpResponse.status, 200);
  assert.equal(
    (differentIpResponse.headers.get("set-cookie") || "")
      .startsWith("__Host-cortex_oauth_session=;"),
    true
  );
  assert.match(await differentIpResponse.text(), /Cortex Login/);
});

test("ignores client-IP headers from callers outside the trusted proxy networks", async () => {
  await stopGateway(gateway);
  gateway = await startGateway({ MCP_OAUTH_TRUSTED_PROXY_CIDRS: "192.0.2.0/24" });

  const redirectUri = `${TEST_REDIRECT}-untrusted-proxy-${crypto.randomBytes(4).toString("hex")}`;
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] })
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201);

  const firstVerifier = crypto.randomBytes(32).toString("base64url");
  const firstAuthorization = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "cortex:read mcp",
    state: "untrusted-proxy-login",
    code_challenge: crypto.createHash("sha256").update(firstVerifier).digest("base64url"),
    resource: TEST_RESOURCE
  }, { "x-test-client-ip": "203.0.113.10" });
  assert.equal(firstAuthorization.status, 302);
  const cookie = (firstAuthorization.headers.get("set-cookie") || "").split(";", 1)[0];

  const secondVerifier = crypto.randomBytes(32).toString("base64url");
  const secondAuthorization = await fetch(
    `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: "cortex:read mcp",
      state: "spoofed-header-ignored",
      code_challenge: crypto.createHash("sha256").update(secondVerifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: TEST_RESOURCE
    })}`,
    {
      headers: { cookie, "x-test-client-ip": "203.0.113.11" },
      redirect: "manual"
    }
  );

  assert.equal(secondAuthorization.status, 302);
  assert.equal(
    new URL(secondAuthorization.headers.get("location")).searchParams.get("state"),
    "spoofed-header-ignored"
  );

  await stopGateway(gateway);
  gateway = await startGateway();
});

test("rate limits public client registration and login attempts by trusted client IP", async () => {
  await stopGateway(gateway);
  gateway = await startGateway({
    MCP_OAUTH_LOGIN_ATTEMPT_LIMIT: "2",
    MCP_OAUTH_LOGIN_ATTEMPT_WINDOW_SECONDS: "60",
    MCP_OAUTH_REGISTRATION_ATTEMPT_LIMIT: "2",
    MCP_OAUTH_REGISTRATION_ATTEMPT_WINDOW_SECONDS: "60"
  });

  const clientIp = "203.0.113.40";
  let registration;
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-client-ip": clientIp
      },
      body: JSON.stringify({
        redirect_uris: [`${TEST_REDIRECT}-rate-limit-${index}-${crypto.randomBytes(4).toString("hex")}`]
      })
    });
    assert.equal(response.status, 201);
    registration = await response.json();
  }

  const blockedRegistration = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-client-ip": clientIp
    },
    body: JSON.stringify({ redirect_uris: [TEST_STABLE_REDIRECT] })
  });
  assert.equal(blockedRegistration.status, 429);
  assert.match(blockedRegistration.headers.get("retry-after"), /^\d+$/);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorizationValues = {
    username: "wrong-user",
    password: "wrong-password",
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    scope: "cortex:read mcp",
    state: "rate-limit",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    resource: TEST_RESOURCE
  };

  for (let index = 0; index < 2; index += 1) {
    const response = await postForm("/authorize", authorizationValues, {
      "x-test-client-ip": clientIp
    });
    assert.equal(response.status, 401);
  }

  const blockedLogin = await postForm("/authorize", {
    ...authorizationValues,
    username: "test-user",
    password: "test-password"
  }, { "x-test-client-ip": clientIp });
  assert.equal(blockedLogin.status, 429);
  assert.match(blockedLogin.headers.get("retry-after"), /^\d+$/);

  await stopGateway(gateway);
  gateway = await startGateway();
});

test("allows only exact legacy ChatGPT client IDs and callbacks", async () => {
  const challenge = crypto.createHash("sha256").update("legacy-client-verifier").digest("base64url");
  const plausibleLegacyId = `chatgpt-${crypto.randomBytes(18).toString("base64url")}`;
  const authorizationQuery = (clientIdValue, redirectUri) => new URLSearchParams({
    response_type: "code",
    client_id: clientIdValue,
    redirect_uri: redirectUri,
    scope: "cortex:read cortex:write mcp",
    state: "legacy-compatibility",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: TEST_RESOURCE
  });

  const legacyResponse = await fetch(
    `http://127.0.0.1:${port}/authorize?${authorizationQuery(plausibleLegacyId, TEST_STABLE_REDIRECT)}`
  );
  assert.equal(legacyResponse.status, 200);

  for (const [unknownClientId, redirectUri] of [
    [`other-${crypto.randomBytes(18).toString("base64url")}`, TEST_STABLE_REDIRECT],
    ["chatgpt-too-short", TEST_STABLE_REDIRECT],
    [plausibleLegacyId, "https://linear.app/connect/mcp/callback"],
    [plausibleLegacyId, `${TEST_STABLE_REDIRECT}?unexpected=1`]
  ]) {
    const rejected = await fetch(
      `http://127.0.0.1:${port}/authorize?${authorizationQuery(unknownClientId, redirectUri)}`
    );
    assert.equal(rejected.status, 400);
  }
});

test("echoes the issuer-base resource used by ChatGPT through authorization and refresh", async () => {
  const redirectUri = `${TEST_REDIRECT}-base-resource`;
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "ChatGPT base resource test" })
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 201);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizationPage = await fetch(`http://127.0.0.1:${port}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "mcp cortex:write cortex:read",
    state: "base-resource-test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: TEST_ISSUER
  })}`);
  assert.equal(authorizationPage.status, 200);
  assert.match(await authorizationPage.text(), new RegExp(`name="resource" value="${TEST_ISSUER}"`));

  const authorizationResponse = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    scope: "mcp cortex:write cortex:read",
    state: "base-resource-test",
    code_challenge: challenge,
    resource: TEST_ISSUER
  });
  assert.equal(authorizationResponse.status, 302);

  const redirect = new URL(authorizationResponse.headers.get("location"));
  const tokenResponse = await postForm("/token", {
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code"),
    redirect_uri: redirectUri,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: TEST_ISSUER
  });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200);

  const secretKey = new TextEncoder().encode(TEST_SECRET);
  const { payload } = await jwtVerify(tokens.access_token, secretKey, {
    issuer: TEST_ISSUER,
    audience: TEST_ISSUER
  });
  assert.equal(payload.aud, TEST_ISSUER);

  const refreshResponse = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: registration.client_id,
    resource: TEST_ISSUER
  });
  assert.equal(refreshResponse.status, 200);
  assert.ok((await refreshResponse.json()).refresh_token);
});

test("rejects refresh attempts that expand scope or change client", async () => {
  const expandedScopeResponse = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: TEST_RESOURCE,
    scope: "cortex:read cortex:write mcp admin"
  });
  assert.equal(expandedScopeResponse.status, 400);
  assert.equal((await expandedScopeResponse.json()).error, "invalid_scope");

  const wrongClientResponse = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: "different-client",
    resource: TEST_RESOURCE
  });
  assert.equal(wrongClientResponse.status, 401);
  assert.equal((await wrongClientResponse.json()).error, "invalid_client");
});

test("enforces the per-tool scopes advertised to ChatGPT", async () => {
  const readToken = await issueAccessTokenForScope("cortex:read mcp");
  const writeAttempt = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cortex_artifact", arguments: {} }
    })
  });

  assert.equal(writeAttempt.status, 403);
  assert.match(writeAttempt.headers.get("www-authenticate"), /cortex:write mcp/);
  assert.equal((await writeAttempt.json()).error, "insufficient_scope");

  const noMcpToken = await issueAccessTokenForScope("cortex:read");
  const initializeAttempt = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${noMcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    })
  });

  assert.equal(initializeAttempt.status, 403);
  assert.match(initializeAttempt.headers.get("www-authenticate"), /scope="mcp"/);
});

test("accepts both current ChatGPT callback forms and rejects lookalikes", async () => {
  const stableResponse = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [TEST_STABLE_REDIRECT], client_name: "Stable ChatGPT callback" })
  });
  const stableClient = await stableResponse.json();
  assert.equal(stableResponse.status, 201);

  const challenge = crypto.createHash("sha256").update("stable-verifier").digest("base64url");
  const page = await fetch(`http://127.0.0.1:${port}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: stableClient.client_id,
    redirect_uri: TEST_STABLE_REDIRECT,
    scope: "cortex:read cortex:write mcp",
    state: "stable-callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: TEST_RESOURCE
  })}`);
  assert.equal(page.status, 200);

  for (const redirectUri of [
    `${TEST_STABLE_REDIRECT}/extra`,
    `${TEST_STABLE_REDIRECT}?next=evil`,
    "https://chatgpt.com:444/connector/oauth/test-callback",
    "https://attacker@chatgpt.com/connector/oauth/test-callback"
  ]) {
    const lookalikeResponse = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] })
    });
    assert.equal(lookalikeResponse.status, 400, redirectUri);
  }
});

test("escapes OAuth state and sends login-page security headers", async () => {
  const challenge = crypto.createHash("sha256").update("xss-verifier").digest("base64url");
  const state = '\"><img src=x onerror=alert(1)>';
  const response = await fetch(`http://127.0.0.1:${port}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: TEST_REDIRECT,
    scope: "cortex:read cortex:write mcp",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: TEST_RESOURCE
  })}`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("enforces REST read/write scopes before proxying", async () => {
  const mcpOnlyToken = await issueAccessTokenForScope("mcp");
  const readAttempt = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { authorization: `Bearer ${mcpOnlyToken}` }
  });
  assert.equal(readAttempt.status, 403);
  assert.match(readAttempt.headers.get("www-authenticate"), /cortex:read/);

  const readToken = await issueAccessTokenForScope("cortex:read mcp");
  const allowedRead = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { authorization: `Bearer ${readToken}` }
  });
  const proxiedRead = await allowedRead.json();
  assert.equal(allowedRead.status, 200);
  assert.equal(proxiedRead.url, "/api/v1/status");

  const writeAttempt = await fetch(`http://127.0.0.1:${port}/api/v1/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ content: "not proxied" })
  });
  assert.equal(writeAttempt.status, 403);
  assert.match(writeAttempt.headers.get("www-authenticate"), /cortex:write/);

  const writeToken = await issueAccessTokenForScope("cortex:write mcp");
  const requestBody = {
    content: "forward this exact body",
    nested: { enabled: true },
    tags: ["oauth", "proxy"]
  };
  const allowedWrite = await fetch(`http://127.0.0.1:${port}/api/v1/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${writeToken}`,
      cookie: "connector_session=secret",
      "cf-access-jwt-assertion": "cloudflare-secret",
      "cf-access-client-secret": "cloudflare-service-secret",
      "x-api-key": "api-secret",
      "x-auth-token": "auth-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });
  const proxied = await allowedWrite.json();

  assert.equal(allowedWrite.status, 200);
  assert.equal(proxied.url, "/api/v1/ingest");
  assert.deepEqual(proxied.body, requestBody);
  assert.equal(proxied.received_authorization, false);
  assert.equal(proxied.received_cookie, false);
  assert.equal(proxied.received_cf_access_token, false);
  assert.equal(proxied.received_cf_access_client_secret, false);
  assert.equal(proxied.received_api_key, false);
  assert.equal(proxied.received_auth_token, false);

  const publicHealth = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    headers: {
      authorization: "Bearer must-not-reach-rest",
      cookie: "health_session=secret",
      "x-api-key": "health-secret"
    }
  });
  const healthPayload = await publicHealth.json();
  assert.equal(publicHealth.status, 200);
  assert.equal(healthPayload.received_authorization, false);
  assert.equal(healthPayload.received_cookie, false);
  assert.equal(healthPayload.received_api_key, false);
});

test("rejects JSON-RPC batches before scope evaluation", async () => {
  const token = await issueAccessTokenForScope("mcp");
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cortex_dream", arguments: {} } }])
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_request");
});

test("rejects non-JSON MCP POST bodies before buffering or proxying", async () => {
  const token = await issueAccessTokenForScope("mcp");
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain"
    },
    body: "not-json"
  });

  assert.equal(response.status, 415);
  assert.equal((await response.json()).error, "unsupported_media_type");
});

test("streams MCP event responses without waiting for the upstream to close", async () => {
  const token = await issueAccessTokenForScope("mcp");
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 200);
  assert.equal(firstChunk.done, false);
  assert.match(Buffer.from(firstChunk.value).toString("utf8"), /mock\/ready/);
  assert.ok(elapsed < 700, `first SSE chunk took ${elapsed}ms`);
  await reader.cancel();
});

test("streams decoded MCP responses without stale compression headers", async () => {
  const token = await issueAccessTokenForScope("mcp");
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "mock/compressed", params: {} })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(payload.result.decoded, true);
});

test("does not forward connector credentials to the raw MCP worker", async () => {
  const token = await issueAccessTokenForScope("mcp");
  const expectedArguments = {
    nested: { enabled: true },
    values: [1, 2, 3]
  };
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      cookie: "connector_session=secret",
      "cf-access-jwt-assertion": "cloudflare-secret",
      "cf-access-client-secret": "cloudflare-service-secret",
      "x-api-key": "api-secret",
      "x-auth-token": "auth-secret",
      "mcp-session-id": "session-must-be-forwarded",
      "mcp-protocol-version": "2025-06-18",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 91,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        arguments: expectedArguments
      }
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.result.received_authorization, false);
  assert.equal(payload.result.received_cookie, false);
  assert.equal(payload.result.received_cf_access_token, false);
  assert.equal(payload.result.received_cf_access_client_secret, false);
  assert.equal(payload.result.received_api_key, false);
  assert.equal(payload.result.received_auth_token, false);
  assert.equal(payload.result.received_session_id, "session-must-be-forwarded");
  assert.equal(payload.result.received_protocol_version, "2025-06-18");
  assert.deepEqual(payload.result.received_arguments, expectedArguments);
});

test("rejects unsupported OAuth scopes", async () => {
  const response = await postForm("/authorize", {
    username: "test-user",
    password: "test-password",
    client_id: clientId,
    redirect_uri: TEST_REDIRECT,
    scope: "cortex:read mcp admin",
    code_challenge: crypto.createHash("sha256").update("unsupported-scope-verifier").digest("base64url"),
    resource: TEST_RESOURCE
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /unsupported scope/);
});
