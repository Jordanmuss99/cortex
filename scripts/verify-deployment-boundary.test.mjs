import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createGatewayApp } from "../oauth-gateway/app.js";
import { HOSTED_REST_ROUTES } from "../oauth-gateway/agent-policy.js";
import {
  renderCompose,
  verifyDeploymentBoundary,
} from "./verify-deployment-boundary.mjs";

const EXPECTED_HOSTED_REST_ROUTES = Object.freeze([
  ["GET", String.raw`^\/api\/v1\/status$`, ["cortex:read"], "query"],
  ["GET", String.raw`^\/api\/v1\/graph$`, ["cortex:read"], "query"],
  ["GET", String.raw`^\/api\/v1\/cognition$`, ["cortex:read"], "query"],
  ["GET", String.raw`^\/api\/v1\/vitals$`, ["cortex:read"], "query"],
  ["GET", String.raw`^\/api\/v1\/reconsolidate\/labile$`, ["cortex:read"], "query"],
  ["GET", String.raw`^\/api\/v1\/procedural$`, ["cortex:read"], "query"],
  ["POST", String.raw`^\/api\/v1\/search$`, ["cortex:read", "cortex:write"], "body"],
  ["POST", String.raw`^\/api\/v1\/recall$`, ["cortex:read", "cortex:write"], "body"],
  ["POST", String.raw`^\/api\/v1\/ingest$`, ["cortex:write"], "body"],
  ["POST", String.raw`^\/api\/v1\/reconsolidate$`, ["cortex:read", "cortex:write"], "body"],
  ["POST", String.raw`^\/api\/v1\/dream$`, ["cortex:read", "cortex:write"], "body"],
  ["POST", String.raw`^\/api\/v1\/procedural$`, ["cortex:write"], "body"],
  ["POST", String.raw`^\/api\/v1\/procedural\/retrieve$`, ["cortex:read"], "body"],
  ["POST", String.raw`^\/api\/v1\/procedural\/([1-9]\d*)\/execute$`, ["cortex:write"], "body"],
  ["PATCH", String.raw`^\/api\/v1\/procedural\/([1-9]\d*)$`, ["cortex:read", "cortex:write"], "body"],
]);

function clone(value) {
  return structuredClone(value);
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
    server.closeAllConnections?.();
  });
}

function requestGateway(port, method) {
  const malformedJson = "{";
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: "/api/v1/working-set",
      headers: {
        authorization: "Bearer must-not-be-verified",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(malformedJson)),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          body: body.length === 0 ? null : JSON.parse(body),
        });
      });
    });
    request.once("error", reject);
    request.end(malformedJson);
  });
}

test("checked-in base and admin Compose preserve the deployment boundary", () => {
  assert.equal(verifyDeploymentBoundary(renderCompose()), true);
  assert.equal(
    verifyDeploymentBoundary(renderCompose({ admin: true }), { admin: true }),
    true
  );
});

test("boundary rejects raw exposure, network crossing, and migration bypass", () => {
  const base = renderCompose();
  const raw = clone(base);
  raw.services.cortex.ports = [{ host_ip: "0.0.0.0", target: 3100, published: "3100", protocol: "tcp" }];
  assert.throws(() => verifyDeploymentBoundary(raw), /privileged port/);

  const crossed = clone(base);
  crossed.services["cortex-mcp"].networks.edge = null;
  assert.throws(() => verifyDeploymentBoundary(crossed), /only the private network/);

  const bypass = clone(base);
  delete bypass.services["cortex-oauth-gateway"].depends_on["cortex-migrate"];
  assert.throws(() => verifyDeploymentBoundary(bypass), /one-shot migration/);
});

test("boundary rejects secret crossing, writable state, and non-loopback admin", () => {
  const base = renderCompose();
  const leaked = clone(base);
  leaked.services["cortex-oauth-gateway"].environment.MCP_OAUTH_OPERATOR_DATABASE_URL = "redacted";
  assert.throws(() => verifyDeploymentBoundary(leaked), /forbidden/);

  const writable = clone(base);
  writable.services["cortex-oauth-gateway"].volumes.find(
    (volume) => volume.target === "/var/lib/cortex-oauth"
  ).read_only = false;
  assert.throws(() => verifyDeploymentBoundary(writable), /read-only/);

  const admin = renderCompose({ admin: true });
  admin.services.db.ports[0].host_ip = "0.0.0.0";
  assert.throws(
    () => verifyDeploymentBoundary(admin, { admin: true }),
    /IPv4 loopback/
  );
});

test("hosted OAuth boundary keeps working-set outside the exact REST allowlist", async (t) => {
  assert.deepEqual(
    HOSTED_REST_ROUTES.map((route) => [
      route.method,
      route.path.source,
      [...route.requiredScopes],
      route.agentLocation,
    ]),
    EXPECTED_HOSTED_REST_ROUTES,
  );

  let accessTokenVerifications = 0;
  let accessContextResolutions = 0;
  let upstreamFetchCalls = 0;
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      restTarget: "http://cortex.internal:3100",
      mcpTarget: "http://cortex-mcp.internal:8000",
    },
    crypto: {
      async verifyAccessToken() {
        accessTokenVerifications += 1;
        throw new Error("working-set must be rejected before authentication");
      },
      async verifyRevocationReference() {
        return null;
      },
    },
    verifyBrowserCredentials() {
      return false;
    },
    store: {
      async checkReadiness() {
        return { ready: true };
      },
      async resolveAccessContext() {
        accessContextResolutions += 1;
        throw new Error("working-set must be rejected before context resolution");
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      },
    },
    async fetchImpl() {
      upstreamFetchCalls += 1;
      throw new Error("working-set must never reach the hosted upstream");
    },
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  t.after(async () => await closeServer(server));

  for (const method of ["GET", "POST", "PATCH"]) {
    const response = await requestGateway(port, method);
    assert.equal(response.status, 404, `${method} /api/v1/working-set`);
    assert.deepEqual(response.body, { error: "not_found" });
  }

  // Each request carries both an invalid bearer token and malformed JSON. A
  // 404 plus zero dependency calls proves route denial happens before auth,
  // JSON parsing, context lookup, and proxying.
  assert.equal(accessTokenVerifications, 0);
  assert.equal(accessContextResolutions, 0);
  assert.equal(upstreamFetchCalls, 0);
});
