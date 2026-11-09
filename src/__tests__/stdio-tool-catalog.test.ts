import { beforeAll, describe, expect, it, jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as schema from "../db/schema.js";

// The full stdio catalog was previously guarded only by source review; this
// snapshot keeps a renamed/removed tool from shipping silently and pins the
// contract fixes (skill_* names, complete dream cycle enum, agent-scoped
// reconsolidate) against regressions.
jest.unstable_mockModule("../db/index.js", () => ({
  schema,
  initDatabase: async () => undefined,
  db: {
    execute: async () => ({ rows: [], rowCount: 0 }),
    select: () => ({ from: () => ({ where: () => [] }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 1 }] }) }),
  },
}));

let createServer: typeof import("../mcp/server.js").createServer;
let registerTools: typeof import("../mcp/server.js").registerTools;

const FULL_SURFACE = [
  "cortex_artifact",
  "cortex_assess_state",
  "cortex_audit",
  "cortex_bg_thread",
  "cortex_dream",
  "cortex_init",
  "cortex_ingest",
  "cortex_ingest_corpus",
  "cortex_ingest_file",
  "cortex_journal",
  "cortex_labile",
  "cortex_monologue",
  "cortex_observe",
  "cortex_prompt_context",
  "cortex_reason",
  "cortex_recall",
  "cortex_reconsolidate",
  "cortex_relationship",
  "cortex_relationship_update",
  "cortex_relationships",
  "cortex_search",
  "cortex_self_check",
  "cortex_skill_executed",
  "cortex_skill_refine",
  "cortex_skill_retrieve",
  "cortex_skill_store",
  "cortex_state_history",
  "cortex_status",
  "cortex_synthesize",
].sort();

beforeAll(async () => {
  ({ createServer, registerTools } = await import("../mcp/server.js"));
});

async function connectFullSurface() {
  const server = createServer();
  registerTools(server); // no `only` — the stdio trust level
  const client = new Client({ name: "catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("stdio MCP tool catalog", () => {
  it("registers exactly the documented 29 cortex_* tools", async () => {
    const { client, server } = await connectFullSurface();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(FULL_SURFACE);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes the full engine cycle vocabulary on cortex_dream", async () => {
    const { client, server } = await connectFullSurface();
    try {
      const { tools } = await client.listTools();
      const dream = tools.find((t) => t.name === "cortex_dream");
      const enumValues = (
        (dream?.inputSchema as { properties?: { cycle_type?: { enum?: string[] } } })
          ?.properties?.cycle_type?.enum ?? []
      );
      expect(enumValues).toEqual(
        expect.arrayContaining([
          "full",
          "sws_only",
          "rem_only",
          "resonance_only",
          "pruning_only",
          "consolidation_only",
        ]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("annotates only the four curated read-only tools with readOnlyHint", async () => {
    const { client, server } = await connectFullSurface();
    try {
      const { tools } = await client.listTools();
      const annotated = tools
        .filter((t) => t.annotations?.readOnlyHint === true)
        .map((t) => t.name)
        .sort();
      expect(annotated).toEqual([
        "cortex_init",
        "cortex_prompt_context",
        "cortex_recall",
        "cortex_search",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
