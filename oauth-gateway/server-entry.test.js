import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadStaticClientConfiguration } from "./config.js";
import { startGateway } from "./server.js";
import { loadRequiredMigration } from "./server-v2.js";

function gatewayEnvironment(stateFile) {
  return {
    PORT: "8080",
    BASE_URL: "https://cortex.example.test",
    ISSUER_URL: "https://cortex.example.test",
    RESOURCE_URL: "https://cortex.example.test/mcp",
    MCP_TARGET: "http://mcp.internal:8000",
    REST_TARGET: "http://rest.internal:3100",
    MCP_OAUTH_DATABASE_URL:
      "postgresql://cortex_oauth_gateway:gateway@127.0.0.1/cortex",
    MCP_OAUTH_USERNAME: "slice13-user",
    MCP_OAUTH_AGENT_ID: "slice13-agent",
    MCP_OAUTH_PASSWORD: "slice13-password",
    MCP_OAUTH_JWT_SECRET: "slice13-jwt-secret-that-is-at-least-32-bytes",
    MCP_OAUTH_ACCEPT_LEGACY_UNTIL: "2026-09-05T00:00:00Z",
    MCP_OAUTH_STATE_FILE: stateFile,
    LINEAR_OAUTH_CLIENT_SECRET: "linear-secret",
  };
}

test("default entry synchronizes static clients, imports frozen state, then starts DB authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cortex-slice13-entry-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  const bytes = Buffer.from(JSON.stringify({ version: 1, clients: [], codes: [] }));
  await writeFile(stateFile, bytes, { mode: 0o600 });
  await chmod(stateFile, 0o600);
  const before = await stat(stateFile);
  const sequence = [];
  let closed = 0;
  let storeOptions;
  const store = {
    async synchronizeStaticClients(clients) {
      sequence.push("static");
      assert.equal(clients.length, 2);
      assert.equal(clients[0].clientId, "linear-cortex");
      assert.equal(clients[0].tokenEndpointAuthMethod, "client_secret_basic");
      assert.equal(Object.hasOwn(clients[0], "clientSecret"), false);
      return { inserted: 2, existing: 0 };
    },
    async importLegacyStateOnce(input) {
      sequence.push("import");
      assert.equal(input.clients.length, 0);
      assert.equal(input.codes.length, 0);
      return { kind: "imported" };
    },
    async close() {
      closed += 1;
    },
  };
  const runtime = await startGateway({
    env: gatewayEnvironment(stateFile),
    storeFactory(options) {
      storeOptions = options;
      return store;
    },
    async runtimeStarter(options) {
      sequence.push("start");
      assert.equal(options.storeFactory(), store);
      assert.equal(options.expectedLegacyState.clientCount, 0);
      assert.equal(options.expectedLegacyState.codeCount, 0);
      assert.equal(options.verifyStaticClientSecret("linear-cortex", "linear-secret"), true);
      assert.equal(options.verifyStaticClientSecret("linear-cortex", "wrong"), false);
      return { close: async () => {} };
    },
  });

  assert.ok(runtime);
  assert.deepEqual(sequence, ["static", "import", "start"]);
  assert.equal(closed, 0);
  assert.equal(storeOptions.expectedLegacyState.clientCount, 0);
  assert.deepEqual(await readFile(stateFile), bytes);
  const after = await stat(stateFile);
  assert.equal(after.mode & 0o7777, 0o600);
  assert.equal(after.size, before.size);
});

test("default entry closes the database store when import fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cortex-slice13-entry-fail-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "state.json");
  await writeFile(stateFile, JSON.stringify({ version: 1, clients: [], codes: [] }), {
    mode: 0o600,
  });
  let closed = 0;
  await assert.rejects(
    startGateway({
      env: gatewayEnvironment(stateFile),
      storeFactory() {
        return {
          async synchronizeStaticClients() {},
          async importLegacyStateOnce() {
            throw new Error("canary must not escape startup logs");
          },
          async close() {
            closed += 1;
          },
        };
      },
      async runtimeStarter() {
        throw new Error("runtime must not start");
      },
    }),
    /canary/
  );
  assert.equal(closed, 1);
});

test("static-client configuration validates metadata and keeps secrets in a verifier closure", () => {
  const configured = loadStaticClientConfiguration({
    LINEAR_OAUTH_CLIENT_ID: "linear-custom",
    LINEAR_OAUTH_CLIENT_SECRET: "  exact secret  ",
    LINEAR_OAUTH_REDIRECT_URI: "https://linear.example.test/callback",
  });
  assert.equal(configured.clients.length, 2);
  assert.deepEqual(Object.keys(configured.clients[0]), [
    "clientId",
    "redirectUris",
    "clientName",
    "tokenEndpointAuthMethod",
  ]);
  assert.equal(JSON.stringify(configured).includes("exact secret"), false);
  assert.equal(configured.verifyClientSecret("linear-custom", "  exact secret  "), true);
  assert.equal(configured.verifyClientSecret("linear-custom", "exact secret"), false);
  assert.throws(
    () => loadStaticClientConfiguration({
      LINEAR_OAUTH_REDIRECT_URI: "https://linear.example.test/callback?",
    }),
    /REDIRECT_URI/
  );
});

test("gateway rejects changed migration 009 bytes before database startup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cortex-slice13-migration-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const altered = join(directory, "009_oauth_authority.sql");
  await writeFile(altered, "-- changed release migration\n");
  await assert.rejects(
    loadRequiredMigration({ MCP_OAUTH_MIGRATION_FILE: altered }),
    /frozen release checksum/
  );
});

test("missing legacy state fails unless explicit fresh-install mode records authority", async () => {
  const missing = join(tmpdir(), `cortex-slice13-missing-${process.pid}.json`);
  await assert.rejects(
    startGateway({
      env: gatewayEnvironment(missing),
      storeFactory() {
        throw new Error("store must not open before state validation");
      },
    })
  );

  const sequence = [];
  const store = {
    async synchronizeStaticClients() {
      sequence.push("static");
    },
    async recordFreshInstall(input) {
      sequence.push("fresh");
      assert.equal(input.confirmation, "fresh_install");
    },
    async close() {},
  };
  await startGateway({
    env: { ...gatewayEnvironment(missing), MCP_OAUTH_FRESH_INSTALL: "1" },
    storeFactory(options) {
      assert.equal(options.freshInstall, true);
      assert.equal(Object.hasOwn(options, "expectedLegacyState"), false);
      return store;
    },
    async runtimeStarter(options) {
      sequence.push("start");
      assert.equal(options.expectedLegacyState, null);
      return { close: async () => {} };
    },
  });
  assert.deepEqual(sequence, ["static", "fresh", "start"]);
});
