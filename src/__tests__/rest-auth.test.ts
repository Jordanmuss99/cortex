import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { once } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import * as schema from "../db/schema.js";

// The REAL wiring (createApp, as used by src/index.ts) is exercised. The DB and embedding
// modules are mocked so no database or network is needed; any call to them is recorded.
const execute = jest.fn(async () => ({ rows: [], rowCount: 0 }));
const dbTouched = jest.fn();
const trap = () => { dbTouched(); throw new Error("DB must not be touched"); };
jest.unstable_mockModule("../db/index.js", () => ({
  schema,
  initDatabase: jest.fn(async () => undefined),
  db: { execute, insert: trap, select: trap, update: trap, delete: trap },
}));
jest.unstable_mockModule("../ingestion/embeddings.js", () => ({
  embedQuery: async () => [0, 1],
  embedTexts: async () => [],
  EMBEDDING_DIM: 2,
  EMBEDDING_MODEL: "synthetic",
  EMBEDDING_PROVIDER: "synthetic",
}));

const ENV_KEYS = ["CORTEX_MCP_TOKEN", "CORTEX_MCP_PUBLIC_URL", "CORTEX_OAUTH_ISSUER", "CORTEX_OAUTH_JWKS_URI"] as const;
const TOKEN = "synthetic-rest-auth-token";
const saved = new Map<string, string | undefined>();
let listener: Server | undefined;
let base: string;

async function start(): Promise<void> {
  const { createApp } = await import("../app.js");
  listener = createHttpServer(createApp());
  const listening = once(listener, "listening", { signal: AbortSignal.timeout(5000) });
  listener.listen(0, "127.0.0.1");
  await listening;
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
  base = `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  for (const key of ENV_KEYS) { saved.set(key, process.env[key]); delete process.env[key]; }
  dbTouched.mockClear();
  execute.mockClear();
});

afterEach(async () => {
  if (listener) {
    listener.closeAllConnections();
    const closed = once(listener, "close");
    listener.close();
    await closed;
    listener = undefined;
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const routes: Array<[string, string]> = [
  ["POST", "/api/v1/search"],
  ["POST", "/api/v1/recall"],
  ["POST", "/api/v1/ingest"],
  ["POST", "/api/v1/reconsolidate"],
  ["GET", "/api/v1/reconsolidate/labile"],
  ["GET", "/api/v1/procedural"],
  ["POST", "/api/v1/procedural"],
  ["GET", "/api/v1/graph"],
  ["POST", "/api/v1/dream"],
  ["GET", "/api/v1/health"],
  ["GET", "/api/v1/status"],
];

const call = (method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}",
  });

describe("REST /api/v1 authentication", () => {
  describe("with a static bearer configured", () => {
    beforeEach(async () => {
      process.env.CORTEX_MCP_TOKEN = TOKEN;
      await start();
    });

    for (const [method, path] of routes) {
      it(`${method} ${path} rejects a missing Authorization header`, async () => {
        const res = await call(method, path);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=/);
        expect(await res.json()).toEqual({ error: "missing or invalid access token" });
        expect(dbTouched).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      });

      it(`${method} ${path} rejects a wrong bearer`, async () => {
        const res = await call(method, path, { Authorization: "Bearer wrong-token" });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
        expect(dbTouched).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      });

      it(`${method} ${path} reaches the router with the correct bearer`, async () => {
        const res = await call(method, path, { Authorization: `Bearer ${TOKEN}` });
        expect(res.status).not.toBe(401);
        expect(res.headers.get("www-authenticate")).toBeNull();
      });
    }

    it("authenticated health is served by the router (200, no DB needed)", async () => {
      const res = await call("GET", "/api/v1/health", { Authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok" });
    });

    it("rejects a non-Bearer scheme", async () => {
      const res = await call("GET", "/api/v1/health", { Authorization: `Basic ${TOKEN}` });
      expect(res.status).toBe(401);
    });

    it("/mcp is unchanged: 401 without a token, not 401 with the token", async () => {
      const noAuth = await call("POST", "/mcp");
      expect(noAuth.status).toBe(401);
      expect(noAuth.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=/);
      const withAuth = await call("POST", "/mcp", {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json, text/event-stream",
      });
      expect(withAuth.status).not.toBe(401);
    });

    it("the unauthenticated root route is unchanged", async () => {
      const res = await call("GET", "/");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ service: "CORTEX V2" });
    });
  });

  describe("with no auth configured at all (fail closed)", () => {
    beforeEach(async () => { await start(); });

    it("rejects every route, even with a bearer, and /mcp stays closed", async () => {
      for (const [method, path] of [...routes, ["POST", "/mcp"] as [string, string]]) {
        const res = await call(method, path, { Authorization: `Bearer ${TOKEN}` });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
      }
      expect(dbTouched).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
