import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import * as schema from "../db/schema.js";

const memory = {
  id: 7, content: "Project decision stored by agent-one", source: "notes/decision.md",
  source_type: "markdown", priority: 1, resonance_score: 5, entities: [],
  semantic_tags: [], created_at: "2026-11-01T00:00:00Z", valid_from: null,
  valid_until: null, superseded_by: null, hybrid_score: 0.8, cosine_sim: 0.8,
  text_match: 1, recency: 1,
};
let agentExists = true;
const agentLookup = jest.fn(async () => agentExists ? [{ id: 42, externalId: "agent-one" }] : []);
const execute = jest.fn(async () => ({ rows: [memory], rowCount: 1 }));
const insert = jest.fn(() => { throw new Error("Unexpected agent creation"); });
// An import must not invoke initialization. On the broken path, keep it from
// progressing to real stdio startup while retaining the observable invocation.
const initDatabase = jest.fn(() => new Promise<void>(() => {}));

jest.unstable_mockModule("../db/index.js", () => ({
  schema,
  initDatabase,
  db: {
    execute,
    insert,
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.agents) throw new Error("Unexpected table lookup");
        return { where: agentLookup };
      },
    }),
  },
}));
jest.unstable_mockModule("../ingestion/embeddings.js", () => ({
  embedQuery: async () => [0, 1],
  embedTexts: async () => [],
  EMBEDDING_DIM: 2,
  EMBEDDING_MODEL: "synthetic",
  EMBEDDING_PROVIDER: "synthetic",
}));

let createServer: typeof import("../mcp/server.js").createServer;
let registerTools: typeof import("../mcp/server.js").registerTools;
let allowedTools: ReadonlySet<string>;
let bootstrapCallsOnImport = -1;
let server: McpServer;
let client: Client;
let savedBridgeUrl: string | undefined;
let savedBridgeToken: string | undefined;

beforeAll(async () => {
  ({ createServer, registerTools } = await import("../mcp/server.js"));
  ({ CORTEX_READ_ONLY_TOOLS: allowedTools } = await import("../mcp/http-server.js"));
  bootstrapCallsOnImport = initDatabase.mock.calls.length;
});

beforeEach(async () => {
  agentExists = true;
  agentLookup.mockClear();
  execute.mockClear();
  insert.mockClear();
  savedBridgeUrl = process.env.AGENTBRIDGE_MCP_URL;
  savedBridgeToken = process.env.AGENTBRIDGE_MCP_TOKEN;
  process.env.AGENTBRIDGE_MCP_URL = "https://sessions.test/api/mcp";
  process.env.AGENTBRIDGE_MCP_TOKEN = "synthetic-test-token";
  server = createServer();
  registerTools(server, { only: allowedTools });
  client = new Client({ name: "memory-boundary-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  jest.restoreAllMocks();
  if (savedBridgeUrl === undefined) delete process.env.AGENTBRIDGE_MCP_URL;
  else process.env.AGENTBRIDGE_MCP_URL = savedBridgeUrl;
  if (savedBridgeToken === undefined) delete process.env.AGENTBRIDGE_MCP_TOKEN;
  else process.env.AGENTBRIDGE_MCP_TOKEN = savedBridgeToken;
});

describe("curated memory MCP boundary", () => {
  it("does not initialize the database when imported by the HTTP adapter", () => {
    expect(bootstrapCallsOnImport).toBe(0);
  });

  it("exposes only the curated tools without live-session selectors", async () => {
    const { tools } = await client.listTools();
    expect(new Set(tools.map(tool => tool.name))).toEqual(allowedTools);
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map(tool => tool.name)).not.toContain("cortex_ingest");
    const context = tools.find(tool => tool.name === "cortex_prompt_context");
    expect(context?.inputSchema.properties).not.toHaveProperty("include_session");
    expect(context?.inputSchema.properties).not.toHaveProperty("session_target");
  });

  it("returns stored memory without contacting configured session services", async () => {
    const fetch = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
    const result = await client.callTool({
      name: "cortex_prompt_context",
      arguments: { query: "project decision", agent_id: "agent-one" },
    });
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining(memory.content) }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not mutate access counters through the curated search surface", async () => {
    await client.callTool({ name: "cortex_search", arguments: { query: "decision", agent_id: "agent-one" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 1.5])("rejects invalid token count %s before memory access", async tokenBudget => {
    const result = await client.callTool({
      name: "cortex_prompt_context",
      arguments: { query: "decision", agent_id: "agent-one", token_budget: tokenBudget },
    });
    expect(result.isError).toBe(true);
    expect(agentLookup).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

for (const name of ["cortex_search", "cortex_recall", "cortex_init", "cortex_prompt_context"]) {
  it(`${name} rejects unknown agents without provisioning them`, async () => {
    agentExists = false;
    const args = name === "cortex_init"
      ? { agent_id: "unregistered" }
      : { agent_id: "unregistered", query: "decision" };
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(agentLookup).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });
}

async function withHttpEndpoint(run: (url: string) => Promise<void>): Promise<void> {
  const keys = ["CORTEX_MCP_TOKEN", "CORTEX_MCP_PUBLIC_URL", "CORTEX_OAUTH_ISSUER", "CORTEX_OAUTH_JWKS_URI"] as const;
  const saved = keys.map(key => ({ key, value: process.env[key] }));
  process.env.CORTEX_MCP_TOKEN = "synthetic-memory-test-token";
  for (const key of keys.slice(1)) delete process.env[key];
  try {
    const { handleMcpRequest } = await import("../mcp/http-server.js");
    const app = express();
    app.use(express.json());
    app.all("/mcp", (req, res) => { void handleMcpRequest(req, res); });
    await using listener = createHttpServer(app);
    const listening = once(listener, "listening", { signal: AbortSignal.timeout(5000) });
    listener.listen(0, "127.0.0.1");
    await listening;
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener");
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    for (const { key, value } of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

it("rejects unauthenticated HTTP requests before memory access", async () => {
  await withHttpEndpoint(async url => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(agentLookup).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

it("serves authenticated memory-only tool calls over actual Streamable HTTP", async () => {
  await withHttpEndpoint(async url => {
    const origin = new URL(url).origin;
    const realFetch = globalThis.fetch;
    const network = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (target.origin !== origin) throw new Error("Non-loopback request denied");
      return realFetch(input, init);
    });
    const remote = new Client({ name: "http-memory-test", version: "1" });
    try {
      await remote.connect(new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: "Bearer synthetic-memory-test-token" } },
      }));
      const { tools } = await remote.listTools();
      expect(new Set(tools.map(tool => tool.name))).toEqual(allowedTools);
      const result = await remote.callTool({
        name: "cortex_prompt_context",
        arguments: { query: "project decision", agent_id: "agent-one" },
      });
      expect(result.isError).not.toBe(true);
      expect(result).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining(memory.content) }],
      });
      expect(network.mock.calls.every(([input]) =>
        new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).origin === origin,
      )).toBe(true);
    } finally {
      await remote.close();
    }
  });
});
