import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { jest } from "@jest/globals";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";

const resultQueue: Array<{ rows: Array<Record<string, unknown>> }> = [];
const mockExecute = jest.fn<(...args: any[]) => any>(async () =>
  resultQueue.shift() ?? { rows: [] }
);

jest.unstable_mockModule("../db/index.js", () => ({
  db: { execute: mockExecute },
}));

const { healthRouter, loadCortexStatus } = await import("../api/health.js");

function queueStatusResults(input: {
  memories: string;
  synapses: string;
  resonance: string;
  statuses: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  dreams: Array<Record<string, unknown>>;
  agents: string;
}) {
  resultQueue.push(
    { rows: [{ count: input.memories }] },
    { rows: [{ count: input.synapses }] },
    { rows: [{ avg_resonance: input.resonance }] },
    { rows: input.statuses },
    { rows: input.sources },
    { rows: input.dreams },
    { rows: [{ count: input.agents }] },
  );
}

function compiledStatements() {
  const dialect = new PgDialect();
  return mockExecute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement));
}

describe("agent-scoped Cortex status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resultQueue.length = 0;
  });

  test("bound status scopes every memory synapse dream and agent statistic", async () => {
    const dream = {
      cycle_type: "agent-a-dream",
      stats: { private_canary: "agent-a-only" },
      started_at: new Date("2030-01-01T00:00:00Z"),
      completed_at: new Date("2030-01-01T00:01:00Z"),
    };
    queueStatusResults({
      memories: "2",
      synapses: "1",
      resonance: "7.25",
      statuses: [{ status: "active", count: "2" }],
      sources: [{ source_type: "conversation", count: "2" }],
      dreams: [dream],
      agents: "1",
    });

    const result = await loadCortexStatus("agent-a");
    expect(result.stats).toEqual({
      agents: "1",
      totalMemories: "2",
      totalSynapses: "1",
      avgResonance: "7.25",
      memoryByStatus: [{ status: "active", count: "2" }],
      memoryBySource: [{ source_type: "conversation", count: "2" }],
      lastDreamCycle: dream,
    });

    const statements = compiledStatements();
    expect(statements).toHaveLength(7);
    expect(statements.every((statement) => statement.params.includes("agent-a"))).toBe(true);

    const synapseSql = statements[1].sql.toLowerCase();
    expect(synapseSql).toContain("synapse.memory_a");
    expect(synapseSql).toContain("synapse.memory_b");
    expect(synapseSql).toMatch(/memory_a[\s\S]+and[\s\S]+memory_b/);
    expect(statements[5].sql.toLowerCase()).toMatch(/dream_cycle_logs[\s\S]+where agent_id/);
    expect(statements[6].sql.toLowerCase()).toMatch(/from agents[\s\S]+where external_id/);
  });

  test("unbound raw status retains aggregate admin behavior", async () => {
    const globalDream = {
      cycle_type: "global-latest",
      stats: { aggregate: true },
      started_at: new Date("2030-02-01T00:00:00Z"),
      completed_at: new Date("2030-02-01T00:01:00Z"),
    };
    queueStatusResults({
      memories: "9",
      synapses: "8",
      resonance: "4.5",
      statuses: [
        { status: "active", count: "9" },
        { status: "archived", count: "2" },
      ],
      sources: [{ source_type: "mixed", count: "9" }],
      dreams: [globalDream],
      agents: "2",
    });

    const result = await loadCortexStatus();
    expect(result.stats).toMatchObject({
      agents: "2",
      totalMemories: "9",
      totalSynapses: "8",
      avgResonance: "4.50",
      lastDreamCycle: globalDream,
    });
    expect(compiledStatements().every((statement) => statement.params.length === 0)).toBe(true);
  });

  test("empty and duplicate selectors never become aggregate status", async () => {
    const app = express();
    app.use("/api/v1", healthRouter);
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const duplicate = await fetch(
        `http://127.0.0.1:${port}/api/v1/status?agentId=agent-a&agentId=agent-b`
      );
      expect(duplicate.status).toBe(400);
      expect(mockExecute).not.toHaveBeenCalled();

      queueStatusResults({
        memories: "0",
        synapses: "0",
        resonance: "0",
        statuses: [],
        sources: [],
        dreams: [],
        agents: "0",
      });
      const empty = await fetch(
        `http://127.0.0.1:${port}/api/v1/status?agentId=`
      );
      expect(empty.status).toBe(200);
      const emptyBody = (await empty.json()) as {
        stats: Record<string, unknown>;
      };
      expect(emptyBody.stats).toMatchObject({
        agents: "0",
        totalMemories: "0",
        totalSynapses: "0",
        lastDreamCycle: null,
      });
      expect(compiledStatements().every((statement) => statement.params.includes(""))).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
