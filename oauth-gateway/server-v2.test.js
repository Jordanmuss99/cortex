import assert from "node:assert/strict";
import test from "node:test";
import { createSecurityLogger } from "./security-log.js";
import { startGatewayV2 } from "./server-v2.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("gateway pruning is single-flight and shutdown waits for an in-flight prune", async () => {
  const secondPruneStarted = deferred();
  const releaseSecondPrune = deferred();
  const upstreamStarted = deferred();
  const logs = [];
  let pruneCalls = 0;
  let activePrunes = 0;
  let maximumActivePrunes = 0;
  let storeCloseCalls = 0;
  const store = {
    async checkReadiness() {
      return {
        ready: true,
        database: true,
        schema: true,
        bootstrap: true,
        legacyImport: true,
      };
    },
    async pruneExpired(_now, batchSize) {
      assert.equal(batchSize, 1000);
      pruneCalls += 1;
      activePrunes += 1;
      maximumActivePrunes = Math.max(maximumActivePrunes, activePrunes);
      if (pruneCalls === 2) {
        secondPruneStarted.resolve();
        await releaseSecondPrune.promise;
      }
      activePrunes -= 1;
      return {
        audit_event_count: 0,
        authorization_code_count: 0,
        grant_count: 0,
        login_session_count: 0,
        refresh_token_count: 0,
      };
    },
    async close() {
      storeCloseCalls += 1;
    },
    async resolveAccessContext() {
      return { kind: "invalid" };
    },
    async revokeByTokenReference() {
      return { kind: "not_found" };
    },
  };
  const runtime = await startGatewayV2({
    config: {
      port: 0,
      baseUrl: "https://cortex.example.test",
      issuerUrl: "https://cortex.example.test",
      resourceUrl: "https://cortex.example.test/mcp",
      restTarget: "http://core.internal:3100",
      mcpTarget: "http://mcp.internal:8000",
      databaseUrl: "postgresql://unused:unused@localhost/unused",
      bootstrapSubject: "slice12-user",
      bootstrapAgentExternalId: "slice12-agent",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      loginSessionTtlSeconds: 86400,
      acceptLegacyUntil: new Date(0),
      trustedIpHeader: "",
      trustedProxyCidrs: [],
    },
    secrets: {
      jwtSecret: "slice12-test-secret-that-is-at-least-32-bytes",
      browserPassword: "slice12-password-canary",
    },
    requiredMigration: {
      id: "009_oauth_authority",
      sha256: "0".repeat(64),
      additionalMigrations: [],
    },
    expectedLegacyState: {
      sourceChecksum: new Uint8Array(32),
      clientCount: 0,
      codeCount: 0,
    },
    storeFactory() {
      return store;
    },
    logger: createSecurityLogger((entry) => logs.push(entry)),
    pruneIntervalMilliseconds: 5,
    shutdownGraceMilliseconds: 30,
    async fetchImpl(_target, options) {
      upstreamStarted.resolve();
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });

  const pendingRequest = fetch(`http://127.0.0.1:${runtime.port}/api/v1/health`)
    .catch(() => null);
  await Promise.all([secondPruneStarted.promise, upstreamStarted.promise]);

  let closed = false;
  const closePromise = runtime.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  releaseSecondPrune.resolve();
  await closePromise;
  await pendingRequest;

  assert.equal(maximumActivePrunes, 1);
  assert.equal(pruneCalls, 2);
  assert.equal(storeCloseCalls, 1);
  await runtime.close();
  assert.equal(storeCloseCalls, 1);
  assert.equal(logs.some((entry) => entry.event === "gateway_started"), true);
  assert.equal(logs.some((entry) => entry.event === "gateway_shutdown"), true);
  assert.equal(JSON.stringify(logs).includes("slice12-password-canary"), false);
});

test("gateway shutdown reaches a fixed deadline when prune and store close never settle", async () => {
  const secondPruneStarted = deferred();
  const never = new Promise(() => {});
  const sequence = [];
  let pruneCalls = 0;
  let storeCloseCalls = 0;
  const store = {
    async checkReadiness() {
      return {
        ready: true,
        database: true,
        schema: true,
        bootstrap: true,
        legacyImport: true,
      };
    },
    async pruneExpired() {
      pruneCalls += 1;
      if (pruneCalls === 1) {
        return {
          audit_event_count: 0,
          authorization_code_count: 0,
          grant_count: 0,
          login_session_count: 0,
          refresh_token_count: 0,
        };
      }
      sequence.push("prune_started");
      secondPruneStarted.resolve();
      return await never;
    },
    async close() {
      storeCloseCalls += 1;
      sequence.push("store_close_started");
      return await never;
    },
    async resolveAccessContext() {
      return { kind: "invalid" };
    },
    async revokeByTokenReference() {
      return { kind: "not_found" };
    },
  };
  const runtime = await startGatewayV2({
    config: {
      port: 0,
      baseUrl: "https://cortex.example.test",
      issuerUrl: "https://cortex.example.test",
      resourceUrl: "https://cortex.example.test/mcp",
      restTarget: "http://core.internal:3100",
      mcpTarget: "http://mcp.internal:8000",
      databaseUrl: "postgresql://unused:unused@localhost/unused",
      bootstrapSubject: "slice12-user",
      bootstrapAgentExternalId: "slice12-agent",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      loginSessionTtlSeconds: 86400,
      acceptLegacyUntil: new Date(0),
      trustedIpHeader: "",
      trustedProxyCidrs: [],
    },
    secrets: {
      jwtSecret: "slice12-test-secret-that-is-at-least-32-bytes",
      browserPassword: "slice12-password-canary",
    },
    requiredMigration: {
      id: "009_oauth_authority",
      sha256: "0".repeat(64),
      additionalMigrations: [],
    },
    expectedLegacyState: {
      sourceChecksum: new Uint8Array(32),
      clientCount: 0,
      codeCount: 0,
    },
    storeFactory(options) {
      assert.equal(options.maintenanceTimeoutMilliseconds, 20);
      return store;
    },
    logger: createSecurityLogger(() => {}),
    pruneIntervalMilliseconds: 5,
    maintenanceTimeoutMilliseconds: 20,
    shutdownGraceMilliseconds: 40,
  });

  await secondPruneStarted.promise;
  const startedAt = Date.now();
  const closePromise = runtime.close();
  await assert.rejects(closePromise, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /Gateway pruning deadline exceeded/);
    assert.match(error.errors[1].message, /Gateway store close deadline exceeded/);
    return true;
  });
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(sequence, ["prune_started", "store_close_started"]);
  assert.equal(pruneCalls, 2);
  assert.equal(storeCloseCalls, 1);
  assert.equal(runtime.close(), closePromise);
});
