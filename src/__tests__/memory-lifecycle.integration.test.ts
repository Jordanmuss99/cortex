import { afterAll, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import postgres, { type Sql } from "postgres";
import { createIngestService } from "../memory/ingest.js";
import { createIngestWorker } from "../memory/ingest-worker.js";
import { createMemoryServiceDependencies } from "../memory/index.js";
import { createRetrievalService } from "../memory/retrieval.js";
import { createWorkingSetService } from "../memory/working-set.js";
import { loadMemoryConfig } from "../memory/config.js";
import { formSynapses } from "../ingestion/synapse-formation.js";
import {
  dgEncode,
  patternComplete,
  sparseOverlap,
} from "../hippocampus/index.js";
import { hybridSearch } from "../api/search.js";
import { loadCortexStatus } from "../api/health.js";
import { runDreamCycle } from "../dream/dream-cycle.js";
import {
  InvalidSourceMemoryReferencesError,
  assertSourceMemoriesOwnedByAgent,
} from "../procedural/index.js";
import type {
  EmbeddedBatch,
  MemoryServiceDependencies,
  PreparedSynapseBatch,
  WorkingItem,
} from "../memory/types.js";
import {
  DEFAULT_MIGRATION_DIRECTORY,
  MutableMigrationSafetyError,
  REQUIRED_MIGRATIONS,
  discoverMigrations,
  runCheckedInMigrations,
} from "../db/migrations.js";
import { closeDatabaseConnection } from "../db/index.js";

type DatabaseClient = ReturnType<typeof postgres>;

interface ManagedChild {
  child: ChildProcess;
  stderr(): string;
}

interface CompletedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let databaseUrl: string;
let ownerSql: DatabaseClient;
let preflightSql: DatabaseClient;
let runtimeDatabaseUrl: string;
const UNIT_VECTOR = [1, ...Array.from({ length: 1023 }, () => 0)];

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the disposable memory suite`);
  return value;
}

function assertDisposableEnvironment(): void {
  if (requiredEnvironment("CORTEX_MEMORY_TEST_DISPOSABLE") !== "1") {
    throw new Error("Refusing to run memory integration tests without the disposable guard");
  }
  databaseUrl = requiredEnvironment("CORTEX_MEMORY_TEST_DATABASE_URL");
  const url = new URL(databaseUrl);
  if (
    !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    decodeURIComponent(url.pathname) !== "/cortex_test" ||
    decodeURIComponent(url.username) !== "cortex_test" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Refusing to run memory integration tests outside the loopback cortex_test owner database"
    );
  }
  if (process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("Disposable memory DATABASE_URL must match the guarded test URL exactly");
  }

  const preflightUrl = new URL(
    requiredEnvironment("CORTEX_MEMORY_TEST_PREFLIGHT_DATABASE_URL")
  );
  if (
    !new Set(["postgres:", "postgresql:"]).has(preflightUrl.protocol) ||
    preflightUrl.hostname !== "127.0.0.1" ||
    decodeURIComponent(preflightUrl.pathname) !== "/cortex_test" ||
    decodeURIComponent(preflightUrl.username) !== "cortex_test" ||
    preflightUrl.search ||
    preflightUrl.hash ||
    preflightUrl.port === url.port
  ) {
    throw new Error(
      "Migration preflight proof requires a second loopback cortex_test owner cluster"
    );
  }
}

function validEmbeddingBatch(count: number): EmbeddedBatch {
  return {
    provider: "slice3-test-provider",
    model: "slice3-test-model",
    vectors: Array.from({ length: count }, () => ({
      values: [...UNIT_VECTOR],
      provider: "slice3-test-provider",
      model: "slice3-test-model",
      dimensions: 1024,
      normalized: true as const,
    })),
  };
}

function testDependencies(
  overrides: Partial<MemoryServiceDependencies> & {
    buildId?: string;
    maxAttempts?: number;
  } = {}
): MemoryServiceDependencies {
  const config = loadMemoryConfig({
    ...process.env,
    CORTEX_BUILD_ID: overrides.buildId ?? "slice3-integration",
    CORTEX_INGEST_MAX_ATTEMPTS: String(overrides.maxAttempts ?? 5),
  });
  const {
    buildId: _buildId,
    maxAttempts: _maxAttempts,
    ...dependencyOverrides
  } = overrides;
  return createMemoryServiceDependencies({
    sql: ownerSql as unknown as Sql,
    config,
    newId: randomUUID,
    embedTexts: async (texts) => validEmbeddingBatch(texts.length),
    enrichEntities: async () => ({ entities: [], warnings: [] }),
    ...dependencyOverrides,
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

function startChild(entrypoint: string, env: NodeJS.ProcessEnv): ManagedChild {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

async function runRetryCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<CompletedChild> {
  const child = spawn(
    "npm",
    ["run", "--silent", "memory:retry-ingest", "--", ...args],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  return { code, signal, stdout, stderr };
}

async function stopChild(managed: ManagedChild | undefined): Promise<void> {
  if (!managed || managed.child.exitCode !== null || managed.child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const forceKill = setTimeout(() => {
      if (managed.child.exitCode === null && managed.child.signalCode === null) {
        managed.child.kill("SIGKILL");
      }
    }, 5_000);
    managed.child.once("exit", () => {
      clearTimeout(forceKill);
      resolvePromise();
    });
    managed.child.kill("SIGTERM");
  });
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function curlJson(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "5",
    "--write-out",
    "\n%{http_code}",
  ];
  if (options.method) args.push("--request", options.method);
  if (options.body !== undefined) {
    args.push(
      "--header",
      "content-type: application/json",
      "--data-binary",
      JSON.stringify(options.body)
    );
  }
  args.push(url);

  const output = await new Promise<string>((resolvePromise, reject) => {
    execFile("curl", args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout);
    });
  });
  const separator = output.lastIndexOf("\n");
  if (separator < 0) throw new Error("curl response did not include an HTTP status");
  return {
    status: Number(output.slice(separator + 1)),
    body: JSON.parse(output.slice(0, separator)) as Record<string, unknown>,
  };
}

async function startFakeEmbeddingServer(): Promise<{
  url: string;
  server: Server;
  calls(): number;
}> {
  const embedding = [3, 4, ...Array.from({ length: 1022 }, () => 0)];
  let callCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === "POST" && request.url === "/api/embeddings") {
      callCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ embedding }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    calls: () => callCount,
  };
}

beforeAll(async () => {
  assertDisposableEnvironment();
  ownerSql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  preflightSql = postgres(
    requiredEnvironment("CORTEX_MEMORY_TEST_PREFLIGHT_DATABASE_URL"),
    { max: 2, onnotice: () => {} }
  );
  const identity = await ownerSql`
    SELECT pg_catalog.current_database() AS database_name,
           SESSION_USER::text AS session_user
  `;
  if (
    identity.length !== 1 ||
    identity[0].database_name !== "cortex_test" ||
    identity[0].session_user !== "cortex_test"
  ) {
    throw new Error(
      "Refusing memory integration setup without the cortex_test owner identity"
    );
  }

  const preflightIdentity = await preflightSql`
    SELECT pg_catalog.current_database() AS database_name,
           SESSION_USER::text AS session_user
  `;
  if (
    preflightIdentity.length !== 1 ||
    preflightIdentity[0].database_name !== "cortex_test" ||
    preflightIdentity[0].session_user !== "cortex_test"
  ) {
    throw new Error("Migration preflight proof lacks the disposable owner identity");
  }

  await ownerSql.unsafe(
    "CREATE ROLE cortex_memory_test_login LOGIN PASSWORD 'slice3-runtime-password'"
  );
  await ownerSql`GRANT cortex_memory_runtime TO cortex_memory_test_login`;
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = "cortex_memory_test_login";
  runtimeUrl.password = "slice3-runtime-password";
  runtimeDatabaseUrl = runtimeUrl.toString();
});

afterAll(async () => {
  await Promise.all([
    ownerSql?.end({ timeout: 5 }),
    preflightSql?.end({ timeout: 5 }),
    closeDatabaseConnection(),
  ]);
});

describe("disposable durable memory lifecycle", () => {
  test("bound status and procedural source ownership isolate real agent rows", async () => {
    const suffix = randomUUID().slice(0, 8);
    const leftExternalId = `slice11-status-left-${suffix}`;
    const rightExternalId = `slice11-status-right-${suffix}`;
    const agents = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${leftExternalId}, 'Slice 11 Status Left'),
             (${rightExternalId}, 'Slice 11 Status Right')
      RETURNING id, external_id
    `;
    const leftAgentId = Number(
      agents.find((agent) => agent.external_id === leftExternalId)?.id
    );
    const rightAgentId = Number(
      agents.find((agent) => agent.external_id === rightExternalId)?.id
    );
    const leftMemories = await ownerSql`
      INSERT INTO public.memory_nodes (
        agent_id, content, source_type, status, resonance_score
      ) VALUES
        (${leftAgentId}, 'slice11 left active', 'slice11-left', 'active', 0.75),
        (${leftAgentId}, 'slice11 left archived', 'slice11-left', 'archived', 0.25)
      RETURNING id
    `;
    const rightMemories = await ownerSql`
      INSERT INTO public.memory_nodes (
        agent_id, content, source_type, status, resonance_score
      ) VALUES
        (${rightAgentId}, 'slice11 right active', 'slice11-right', 'active', 0.10),
        (${rightAgentId}, 'slice11 right archived', 'slice11-right', 'archived', 0.20)
      RETURNING id
    `;

    try {
      await ownerSql`
        INSERT INTO public.memory_synapses (
          agent_id, memory_a, memory_b, connection_type, connection_strength
        ) VALUES
          (${leftAgentId}, ${Number(leftMemories[0].id)}, ${Number(leftMemories[1].id)}, 'semantic', 0.8),
          (${rightAgentId}, ${Number(rightMemories[0].id)}, ${Number(rightMemories[1].id)}, 'semantic', 0.7)
      `;
      await ownerSql`
        INSERT INTO public.dream_cycle_logs (
          agent_id, cycle_type, stats, started_at, completed_at
        ) VALUES
          (${leftAgentId}, 'slice11-left', '{"agent":"left"}'::jsonb, '2099-01-01T00:00:00Z', '2099-01-01T00:01:00Z'),
          (${rightAgentId}, 'slice11-right', '{"agent":"right"}'::jsonb, '2099-01-02T00:00:00Z', '2099-01-02T00:01:00Z')
      `;

      const bound = await loadCortexStatus(leftExternalId);
      expect(bound.stats).toMatchObject({
        agents: "1",
        totalMemories: "1",
        totalSynapses: "1",
        avgResonance: "0.75",
        lastDreamCycle: expect.objectContaining({ cycle_type: "slice11-left" }),
      });
      expect(bound.stats.memoryByStatus).toEqual(expect.arrayContaining([
        { status: "active", count: "1" },
        { status: "archived", count: "1" },
      ]));
      expect(bound.stats.memoryBySource).toEqual([
        { source_type: "slice11-left", count: "1" },
      ]);
      expect(JSON.stringify(bound)).not.toContain("slice11-right");

      const aggregate = await loadCortexStatus();
      expect(Number(aggregate.stats.agents)).toBeGreaterThanOrEqual(2);
      expect(Number(aggregate.stats.totalMemories)).toBeGreaterThanOrEqual(2);
      expect(Number(aggregate.stats.totalSynapses)).toBeGreaterThanOrEqual(2);
      expect(aggregate.stats.lastDreamCycle).toEqual(
        expect.objectContaining({ cycle_type: "slice11-right" })
      );

      const leftIds = leftMemories.map((memory) => Number(memory.id));
      await expect(
        assertSourceMemoriesOwnedByAgent(leftAgentId, leftIds)
      ).resolves.toBeUndefined();

      const failures = [];
      for (const ids of [
        [leftIds[0], Number(rightMemories[0].id)],
        [leftIds[0], 2_147_483_647],
      ]) {
        try {
          await assertSourceMemoriesOwnedByAgent(leftAgentId, ids);
          throw new Error("expected source ownership rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidSourceMemoryReferencesError);
          const ownedError = error as InvalidSourceMemoryReferencesError;
          failures.push({
            name: ownedError.name,
            code: ownedError.code,
            message: ownedError.message,
          });
        }
      }
      expect(failures[0]).toEqual(failures[1]);
      expect(JSON.stringify(failures)).not.toMatch(
        new RegExp(`${rightMemories[0].id}|2147483647`)
      );
    } finally {
      await ownerSql`
        DELETE FROM public.memory_synapses
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.dream_cycle_logs
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_nodes
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.agents
        WHERE id IN (${leftAgentId}, ${rightAgentId})
      `;
    }
  }, 30_000);

  test("REST and MCP procedural adapters hide foreign source and record IDs", async () => {
    const suffix = randomUUID().slice(0, 8);
    const leftExternalId = `slice11-adapter-left-${suffix}`;
    const rightExternalId = `slice11-adapter-right-${suffix}`;
    const agents = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${leftExternalId}, 'Slice 11 Adapter Left'),
             (${rightExternalId}, 'Slice 11 Adapter Right')
      RETURNING id, external_id
    `;
    const leftAgentId = Number(
      agents.find((agent) => agent.external_id === leftExternalId)?.id
    );
    const rightAgentId = Number(
      agents.find((agent) => agent.external_id === rightExternalId)?.id
    );
    const memories = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${leftAgentId}, 'slice11 adapter left source'),
             (${rightAgentId}, 'slice11 adapter right source')
      RETURNING id, agent_id
    `;
    const leftMemoryId = Number(
      memories.find((memory) => Number(memory.agent_id) === leftAgentId)?.id
    );
    const rightMemoryId = Number(
      memories.find((memory) => Number(memory.agent_id) === rightAgentId)?.id
    );
    const rightProceduralRows = await ownerSql`
      INSERT INTO public.procedural_memories (
        agent_id, name, description, procedural_type, trigger_context
      ) VALUES (
        ${rightAgentId}, 'Foreign workflow', 'Must remain private',
        'workflow', 'When owned by the other agent'
      )
      RETURNING id
    `;
    const rightProceduralId = Number(rightProceduralRows[0].id);
    const embeddingServer = await startFakeEmbeddingServer();
    const restPort = await allocateLoopbackPort();
    const restProcess = startChild(resolve("src/index.ts"), {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl,
      PORT: String(restPort),
      CORTEX_BUILD_ID: "slice11-adapter-proof",
      CORTEX_HEADLESS: "true",
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "mxbai-embed-large",
      OLLAMA_URL: embeddingServer.url,
      VOYAGE_API_KEY: "",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/mcp/server.ts")],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: runtimeDatabaseUrl,
        CORTEX_BUILD_ID: "slice11-adapter-proof",
        CORTEX_HEADLESS: "true",
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "mxbai-embed-large",
        OLLAMA_URL: embeddingServer.url,
        VOYAGE_API_KEY: "",
      } as Record<string, string>,
    });
    const client = new Client(
      { name: "slice11-adapter-proof", version: "1.0.0" },
      { capabilities: {} }
    );
    let mcpStderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      mcpStderr += chunk.toString();
    });

    const parseToolError = (result: Awaited<ReturnType<Client["callTool"]>>) => {
      expect(result.isError).toBe(true);
      const content = result.content as Array<{
        type: string;
        text?: string;
      }>;
      const text = content.find((item) => item.type === "text");
      if (!text || text.type !== "text") {
        throw new Error("Expected a textual MCP error response");
      }
      return JSON.parse(text.text ?? "") as {
        errors: Array<{
          code: string;
          message: string;
          details: Record<string, unknown>;
        }>;
      };
    };

    try {
      await waitUntil(async () => {
        try {
          return (await fetch(
            `http://127.0.0.1:${restPort}/api/v1/health`
          )).status === 200;
        } catch {
          return false;
        }
      }, "Slice 11 REST adapter readiness");

      const foreignSourceRest = await curlJson(
        `http://127.0.0.1:${restPort}/api/v1/procedural`,
        {
          method: "POST",
          body: {
            agentId: leftExternalId,
            name: "Rejected foreign provenance",
            description: "Must not be stored",
            proceduralType: "workflow",
            triggerContext: "Never",
            steps: [],
            domainTags: [],
            sourceMemoryIds: [rightMemoryId],
          },
        }
      );
      const outOfRangeRest = await curlJson(
        `http://127.0.0.1:${restPort}/api/v1/procedural`,
        {
          method: "POST",
          body: {
            agentId: leftExternalId,
            name: "Rejected out-of-range provenance",
            description: "Must not reach PostgreSQL",
            proceduralType: "workflow",
            triggerContext: "Never",
            steps: [],
            domainTags: [],
            sourceMemoryIds: [2_147_483_648],
          },
        }
      );
      for (const response of [foreignSourceRest, outOfRangeRest]) {
        expect(response).toEqual({
          status: 400,
          body: {
            error: "Invalid source memory references",
            code: "invalid_source_memory_references",
          },
        });
      }

      const executeRest = await curlJson(
        `http://127.0.0.1:${restPort}/api/v1/procedural/${rightProceduralId}/execute`,
        {
          method: "POST",
          body: { agentId: leftExternalId, success: true },
        }
      );
      const refineRest = await curlJson(
        `http://127.0.0.1:${restPort}/api/v1/procedural/${rightProceduralId}`,
        {
          method: "PATCH",
          body: { agentId: leftExternalId, description: "foreign update" },
        }
      );
      for (const response of [executeRest, refineRest]) {
        expect(response).toEqual({
          status: 404,
          body: {
            error: "Procedural memory not found",
            code: "procedural_memory_not_found",
          },
        });
      }

      await client.connect(transport);
      const searchResult = await client.callTool({
        name: "cortex_search",
        arguments: {
          agent_id: leftExternalId,
          query: "slice11 adapter left source",
          limit: 3,
          verbose: true,
        },
      });
      expect(searchResult.isError).not.toBe(true);
      expect(searchResult.structuredContent).toMatchObject({
        ok: true,
        tool: "cortex_search",
        agent_id: leftExternalId,
        data: {
          query: "slice11 adapter left source",
          results: [{
            memory_id: leftMemoryId,
            content: "slice11 adapter left source",
            metadata: {},
            retrieval_item_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            kind: "memory",
            currentness: 1,
            final_rank: 1,
            component_ranks: expect.arrayContaining([
              expect.objectContaining({ lane: "lexical", rank: 1 }),
            ]),
            reasons: expect.arrayContaining(["current", "lexical_rank_1"]),
            provenance: [],
            provenance_truncated: false,
          }],
          skills: [],
          retrieval_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          algorithm_version: "memory-retrieval-v1",
          build_id: "slice11-adapter-proof",
          candidate_count: 1,
          returned_count: 1,
          elapsed_ms: expect.any(Number),
          warnings: [],
        },
      });
      const searchData = (searchResult.structuredContent as {
        data: {
          retrieval_id: string;
          results: Array<Record<string, unknown>>;
        };
      }).data;
      expect(searchData.results[0]).not.toHaveProperty("valid_from");
      expect(searchData.results[0]).not.toHaveProperty("valid_until");
      expect(searchData.results[0]).not.toHaveProperty("last_recalled_at");

      const searchEvidence = await ownerSql`
        SELECT
          retrieval.status,
          retrieval.build_id,
          retrieval.candidate_count,
          retrieval.returned_count,
          item.memory_id,
          item.returned_at IS NOT NULL AS returned,
          node.last_recalled_at IS NOT NULL AS recalled,
          node.access_count,
          node.last_accessed_at
        FROM public.memory_retrievals AS retrieval
        JOIN public.memory_retrieval_items AS item
          ON item.retrieval_id = retrieval.id
         AND item.agent_id = retrieval.agent_id
        JOIN public.memory_nodes AS node
          ON node.id = item.memory_id
         AND node.agent_id = item.agent_id
        WHERE retrieval.id = ${searchData.retrieval_id}::uuid
      `;
      expect(searchEvidence).toEqual([{
        status: "completed",
        build_id: "slice11-adapter-proof",
        candidate_count: 1,
        returned_count: 1,
        memory_id: leftMemoryId,
        returned: true,
        recalled: true,
        access_count: 0,
        last_accessed_at: null,
      }]);

      const unknownExternalId = `slice6-search-missing-${suffix}`;
      const searchError = parseToolError(await client.callTool({
        name: "cortex_search",
        arguments: {
          agent_id: unknownExternalId,
          query: "must not create an agent",
          limit: 3,
        },
      }));
      expect(searchError.errors).toEqual([{
        code: "agent_not_found",
        message: "The requested Cortex agent does not exist",
        details: {},
      }]);
      await expect(ownerSql`
        SELECT pg_catalog.count(*)::integer AS agents
        FROM public.agents
        WHERE external_id = ${unknownExternalId}
      `).resolves.toEqual([{ agents: 0 }]);
      const embeddingCallsAfterSearch = embeddingServer.calls();
      expect(embeddingCallsAfterSearch).toBeGreaterThanOrEqual(1);

      const sourceError = parseToolError(await client.callTool({
        name: "cortex_skill_store",
        arguments: {
          agent_id: leftExternalId,
          name: "Rejected MCP foreign provenance",
          description: "Must not be stored",
          procedural_type: "workflow",
          trigger_context: "Never",
          steps: [],
          domain_tags: [],
          source_memory_ids: [rightMemoryId],
        },
      }));
      expect(sourceError.errors).toEqual([{
        code: "invalid_source_memory_references",
        message: "One or more source memory references are invalid.",
        details: {},
      }]);

      const duplicateNormalized = await client.callTool({
        name: "cortex_skill_store",
        arguments: {
          agent_id: leftExternalId,
          name: "Normalized MCP provenance",
          description: "More than 100 duplicate entries normalize to one ID",
          procedural_type: "workflow",
          trigger_context: "When proving the unique cap",
          steps: ["Normalize", "Store"],
          domain_tags: ["security"],
          source_memory_ids: Array.from({ length: 101 }, () => leftMemoryId),
        },
      });
      expect(duplicateNormalized.isError).not.toBe(true);
      expect(duplicateNormalized.structuredContent).toMatchObject({
        ok: true,
        tool: "cortex_skill_store",
        data: { status: "stored" },
      });
      expect(embeddingServer.calls()).toBe(embeddingCallsAfterSearch + 1);

      const executeError = parseToolError(await client.callTool({
        name: "cortex_skill_executed",
        arguments: {
          agent_id: leftExternalId,
          procedural_id: rightProceduralId,
          success: true,
        },
      }));
      const refineError = parseToolError(await client.callTool({
        name: "cortex_skill_refine",
        arguments: {
          agent_id: leftExternalId,
          procedural_id: rightProceduralId,
          description: "foreign update",
        },
      }));
      for (const error of [executeError, refineError]) {
        expect(error.errors).toEqual([{
          code: "procedural_memory_not_found",
          message: "Procedural memory not found.",
          details: {},
        }]);
      }
    } catch (error) {
      throw new Error(
        `Slice 11 adapter proof failed: ${(error as Error).message}; ` +
        `rest=${restProcess.stderr().slice(-1_500)}; mcp=${mcpStderr.slice(-1_500)}`
      );
    } finally {
      await client.close().catch(() => undefined);
      await stopChild(restProcess);
      embeddingServer.server.close();
      await once(embeddingServer.server, "close");
      await ownerSql`
        DELETE FROM public.procedural_memories
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_retrievals
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_nodes
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.agents
        WHERE id IN (${leftAgentId}, ${rightAgentId})
      `;
    }
  }, 45_000);

  test("migration refuses dangling or cross-agent successor graph code or valence links", async () => {
    const preflightUrl = requiredEnvironment(
      "CORTEX_MEMORY_TEST_PREFLIGHT_DATABASE_URL"
    );
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = preflightUrl;
    try {
      const agents = await preflightSql`
        INSERT INTO public.agents (external_id, name)
        VALUES ('slice3-preflight-a', 'Slice 3 Preflight A'),
               ('slice3-preflight-b', 'Slice 3 Preflight B')
        RETURNING id
      `;
      const left = await preflightSql`
        INSERT INTO public.memory_nodes (agent_id, content)
        VALUES (${Number(agents[0].id)}, 'left preflight node')
        RETURNING id
      `;
      const right = await preflightSql`
        INSERT INTO public.memory_nodes (agent_id, content)
        VALUES (${Number(agents[1].id)}, 'right preflight node')
        RETURNING id
      `;

      await preflightSql`
        UPDATE public.memory_nodes
        SET superseded_by = ${Number(right[0].id)}
        WHERE id = ${Number(left[0].id)}
      `;
      await preflightSql`
        INSERT INTO public.memory_synapses (
          memory_a, memory_b, connection_type, connection_strength
        ) VALUES (
          ${Number(left[0].id)}, ${Number(right[0].id)}, 'semantic', 0.9
        )
      `;
      await preflightSql`
        INSERT INTO public.hippocampal_codes (
          memory_id, agent_id, sparse_indices, sparse_values
        ) VALUES (
          ${Number(left[0].id)}, ${Number(agents[1].id)},
          ARRAY[1]::integer[], ARRAY[1]::real[]
        )
      `;
      await preflightSql`
        INSERT INTO public.emotional_valence (memory_id, agent_id)
        VALUES (${Number(left[0].id)}, ${Number(agents[1].id)})
      `;

      await expect(
        runCheckedInMigrations(
          preflightSql as unknown as Sql,
          DEFAULT_MIGRATION_DIRECTORY,
          REQUIRED_MIGRATIONS
        )
      ).rejects.toMatchObject({
        code: "23514",
        message:
          "memory lifecycle preflight failed: successors=1 synapses=1 codes=1 valence=1",
      });

      const rollbackEvidence = await preflightSql`
        SELECT
          pg_catalog.to_regclass('public.memory_ingest_events') IS NULL AS no_event_table,
          pg_catalog.to_regclass('public.cortex_schema_migrations') IS NULL AS no_ledger,
          NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_roles
            WHERE rolname IN ('cortex_oauth_runtime', 'cortex_memory_runtime')
          ) AS no_protected_roles,
          (SELECT pg_catalog.count(*)::integer FROM public.memory_synapses) AS synapses,
          (SELECT pg_catalog.count(*)::integer FROM public.hippocampal_codes) AS codes,
          (SELECT pg_catalog.count(*)::integer FROM public.emotional_valence) AS valence
      `;
      expect(rollbackEvidence).toEqual([
        {
          no_event_table: true,
          no_ledger: true,
          no_protected_roles: true,
          synapses: 1,
          codes: 1,
          valence: 1,
        },
      ]);

      await preflightSql`DELETE FROM public.emotional_valence`;
      await preflightSql`DELETE FROM public.hippocampal_codes`;
      await preflightSql`DELETE FROM public.memory_synapses`;
      await preflightSql`UPDATE public.memory_nodes SET superseded_by = NULL`;
      await preflightSql`DELETE FROM public.memory_nodes`;
      await preflightSql`DELETE FROM public.agents`;

      await expect(
        runCheckedInMigrations(
          preflightSql as unknown as Sql,
          DEFAULT_MIGRATION_DIRECTORY,
          REQUIRED_MIGRATIONS
        )
      ).resolves.toMatchObject({ applied: [...REQUIRED_MIGRATIONS] });
    } finally {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  test("applies migration 010 once and records its checksum", async () => {
    const migrations = await discoverMigrations(DEFAULT_MIGRATION_DIRECTORY);
    expect(migrations.map((migration) => migration.id)).toEqual([
      "009_oauth_authority",
      "010_memory_lifecycle",
    ]);

    const ledger = await ownerSql`
      SELECT id, sha256
      FROM public.cortex_schema_migrations
      ORDER BY id
    `;
    expect(ledger.map((row) => row.id)).toEqual(REQUIRED_MIGRATIONS);
    expect(ledger.every((row) => /^[0-9a-f]{64}$/.test(String(row.sha256).trim()))).toBe(
      true
    );

    const rerun = await runCheckedInMigrations(
      ownerSql as unknown as Sql,
      DEFAULT_MIGRATION_DIRECTORY,
      REQUIRED_MIGRATIONS
    );
    expect(rerun.applied).toEqual([]);
    expect(rerun.alreadyApplied).toEqual(REQUIRED_MIGRATIONS);

    const memoryMarker = process.env.CORTEX_MEMORY_TEST_DISPOSABLE;
    const oauthMarker = process.env.MCP_OAUTH_TEST_DISPOSABLE;
    delete process.env.CORTEX_MEMORY_TEST_DISPOSABLE;
    delete process.env.MCP_OAUTH_TEST_DISPOSABLE;
    try {
      await expect(
        runCheckedInMigrations(
          ownerSql as unknown as Sql,
          DEFAULT_MIGRATION_DIRECTORY,
          REQUIRED_MIGRATIONS
        )
      ).rejects.toBeInstanceOf(MutableMigrationSafetyError);
    } finally {
      if (memoryMarker === undefined) delete process.env.CORTEX_MEMORY_TEST_DISPOSABLE;
      else process.env.CORTEX_MEMORY_TEST_DISPOSABLE = memoryMarker;
      if (oauthMarker === undefined) delete process.env.MCP_OAUTH_TEST_DISPOSABLE;
      else process.env.MCP_OAUTH_TEST_DISPOSABLE = oauthMarker;
    }

    const runtimePrivileges = await ownerSql`
      SELECT
        has_table_privilege(
          'cortex_memory_runtime',
          'public.memory_ingest_events',
          'DELETE'
        ) AS can_delete_events,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_ingest_events',
          'raw_content',
          'UPDATE'
        ) AS can_update_raw_content,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_ingest_events',
          'status',
          'UPDATE'
        ) AS can_update_status,
        has_table_privilege(
          'cortex_memory_runtime',
          'public.memory_retrievals',
          'SELECT, INSERT'
        ) AS can_read_insert_retrievals,
        has_table_privilege(
          'cortex_memory_runtime',
          'public.memory_retrievals',
          'DELETE'
        ) AS can_delete_retrievals,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_retrievals',
          'query',
          'UPDATE'
        ) AS can_update_retrieval_query,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_retrievals',
          'status',
          'UPDATE'
        ) AS can_update_retrieval_status,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_retrievals',
          'redacted_at',
          'UPDATE'
        ) AS can_redact_retrieval,
        has_table_privilege(
          'cortex_memory_runtime',
          'public.memory_retrieval_items',
          'SELECT, INSERT'
        ) AS can_read_insert_retrieval_items,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_retrieval_items',
          'returned_at',
          'UPDATE'
        ) AS can_mark_returned,
        has_column_privilege(
          'cortex_memory_runtime',
          'public.memory_retrieval_items',
          'final_score',
          'UPDATE'
        ) AS can_rewrite_final_score,
        has_table_privilege(
          'cortex_oauth_runtime',
          'public.memory_retrievals',
          'SELECT'
        ) AS oauth_can_read_retrievals,
        has_function_privilege(
          'cortex_memory_runtime',
          'public.build_memory_search_document(text,text,text[],text[])',
          'EXECUTE'
        ) AS can_build_search_document,
        has_function_privilege(
          'cortex_oauth_runtime',
          'public.build_memory_search_document(text,text,text[],text[])',
          'EXECUTE'
        ) AS oauth_can_build_search_document,
        has_function_privilege(
          'cortex_memory_runtime',
          'public.enforce_memory_retrieval_history()',
          'EXECUTE'
        ) AS can_call_retrieval_history_trigger,
        has_function_privilege(
          'cortex_memory_runtime',
          'public.enforce_memory_retrieval_item_history()',
          'EXECUTE'
        ) AS can_call_retrieval_item_history_trigger
    `;
    expect(runtimePrivileges).toEqual([
      {
        can_delete_events: false,
        can_update_raw_content: false,
        can_update_status: true,
        can_read_insert_retrievals: true,
        can_delete_retrievals: false,
        can_update_retrieval_query: false,
        can_update_retrieval_status: true,
        can_redact_retrieval: false,
        can_read_insert_retrieval_items: true,
        can_mark_returned: true,
        can_rewrite_final_score: false,
        oauth_can_read_retrievals: false,
        can_build_search_document: true,
        oauth_can_build_search_document: false,
        can_call_retrieval_history_trigger: false,
        can_call_retrieval_item_history_trigger: false,
      },
    ]);
  });

  test("generated search documents cover every lexical field and refresh on update", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice6-search-document-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 6 Search Document')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);

    try {
      const memoryRows = await ownerSql`
        INSERT INTO public.memory_nodes (
          agent_id,
          content,
          summary,
          entities,
          semantic_tags
        ) VALUES (
          ${agentId},
          'Orion navigation notes',
          'Apollo launch schedule',
          ARRAY['Artemis']::text[],
          ARRAY['release-planning']::text[]
        )
        RETURNING id
      `;
      const memoryId = Number(memoryRows[0].id);

      const initial = await ownerSql`
        SELECT
          search_document @@ pg_catalog.websearch_to_tsquery(
            'english'::regconfig,
            'Orion Apollo Artemis'
          ) AS matches_all_fields,
          search_document @@ pg_catalog.websearch_to_tsquery(
            'english'::regconfig,
            'comet'
          ) AS matches_future_tag
        FROM public.memory_nodes
        WHERE id = ${memoryId}
      `;
      expect(initial).toEqual([
        { matches_all_fields: true, matches_future_tag: false },
      ]);

      await ownerSql`
        UPDATE public.memory_nodes
        SET semantic_tags = ARRAY['comet']::text[]
        WHERE id = ${memoryId}
      `;
      const refreshed = await ownerSql`
        SELECT
          search_document @@ pg_catalog.websearch_to_tsquery(
            'english'::regconfig,
            'comet'
          ) AS matches_updated_tag,
          is_generated
        FROM public.memory_nodes
        CROSS JOIN information_schema.columns
        WHERE memory_nodes.id = ${memoryId}
          AND table_schema = 'public'
          AND table_name = 'memory_nodes'
          AND column_name = 'search_document'
      `;
      expect(refreshed).toEqual([
        { matches_updated_tag: true, is_generated: "ALWAYS" },
      ]);

      const ginIndex = await ownerSql`
        SELECT indexdef
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'memory_nodes'
          AND indexname = 'memory_nodes_search_document_idx'
      `;
      expect(ginIndex).toHaveLength(1);
      expect(String(ginIndex[0].indexdef)).toContain(
        "USING gin (search_document)"
      );
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("retrieval evidence enforces ownership, bounds, uniqueness, and append-only delivery", async () => {
    const suffix = randomUUID().slice(0, 8);
    const leftExternalId = `slice6-retrieval-left-${suffix}`;
    const rightExternalId = `slice6-retrieval-right-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${leftExternalId}, 'Slice 6 Retrieval Left'),
             (${rightExternalId}, 'Slice 6 Retrieval Right')
      RETURNING id, external_id
    `;
    const leftAgentId = Number(
      agentRows.find((agent) => agent.external_id === leftExternalId)?.id
    );
    const rightAgentId = Number(
      agentRows.find((agent) => agent.external_id === rightExternalId)?.id
    );
    const leftMemoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${leftAgentId}, 'slice6 left candidate one'),
             (${leftAgentId}, 'slice6 left candidate two')
      RETURNING id
    `;
    const rightMemoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${rightAgentId}, 'slice6 right candidate')
      RETURNING id
    `;
    const leftMemoryId = Number(leftMemoryRows[0].id);
    const secondLeftMemoryId = Number(leftMemoryRows[1].id);
    const rightMemoryId = Number(rightMemoryRows[0].id);
    const retrievalId = randomUUID();
    const itemId = randomUUID();
    const createdAt = "2026-08-29T02:00:00.000Z";

    try {
      await expect(
        ownerSql`
          INSERT INTO public.memory_retrievals (
            id, agent_id, query, query_hash, channel, status,
            algorithm_version, build_id, candidate_count,
            returned_count, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${leftAgentId}, ${"é".repeat(4097)},
            ${"f".repeat(64)}, 'search', 'running',
            'memory-retrieval-v1', 'slice6-db-proof', 0, 0, ${createdAt}
          )
        `
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        ownerSql`
          INSERT INTO public.memory_retrievals (
            id, agent_id, query, query_hash, channel, status,
            algorithm_version, build_id, candidate_count,
            returned_count, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${leftAgentId}, 'unbounded',
            ${"0".repeat(64)}, 'search', 'running',
            'memory-retrieval-v1', 'slice6-db-proof', 501, 0, ${createdAt}
          )
        `
      ).rejects.toMatchObject({ code: "23514" });

      await ownerSql`
        INSERT INTO public.memory_retrievals (
          id, agent_id, request_id, session_id, query, query_hash,
          channel, status, algorithm_version, build_id,
          candidate_count, returned_count, created_at
        ) VALUES (
          ${retrievalId}::uuid, ${leftAgentId}, 'slice6-request',
          'slice6-session', 'candidate proof', ${"1".repeat(64)},
          'search', 'running', 'memory-retrieval-v1', 'slice6-db-proof',
          0, 0, ${createdAt}
        )
      `;

      const insertItem = (
        id: string,
        agentId: number,
        memoryId: number,
        rank: number,
        lanes: readonly string[] = ["lexical"]
      ) => ownerSql`
        INSERT INTO public.memory_retrieval_items (
          id, agent_id, retrieval_id, memory_id, content_hash,
          candidate_lanes, component_ranks, final_score,
          final_rank, created_at
        ) VALUES (
          ${id}::uuid, ${agentId}, ${retrievalId}::uuid, ${memoryId},
          ${"2".repeat(64)}, ${lanes as string[]},
          ${ownerSql.json([{ lane: "lexical", rank: 1, sourceScore: 0.75 }])},
          0.75, ${rank}, ${createdAt}
        )
      `;

      await expect(
        ownerSql`
          INSERT INTO public.memory_retrieval_items (
            id, agent_id, retrieval_id, memory_id, content_hash,
            candidate_lanes, component_ranks, final_score,
            final_rank, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${leftAgentId}, ${retrievalId}::uuid,
            ${leftMemoryId}, ${"b".repeat(64)},
            ARRAY['lexical', 'lexical']::text[],
            '[{"lane":"lexical","rank":1,"sourceScore":1}]'::jsonb,
            1, 1, ${createdAt}
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        ownerSql`
          INSERT INTO public.memory_retrieval_items (
            id, agent_id, retrieval_id, memory_id, content_hash,
            candidate_lanes, component_ranks, final_score,
            final_rank, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${leftAgentId}, ${retrievalId}::uuid,
            ${leftMemoryId}, ${"c".repeat(64)}, ARRAY['lexical']::text[],
            '[null]'::jsonb, 1, 1, ${createdAt}
          )
        `
      ).rejects.toMatchObject({ code: "23514" });

      await insertItem(itemId, leftAgentId, leftMemoryId, 1);
      await expect(
        insertItem(randomUUID(), leftAgentId, rightMemoryId, 2)
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        insertItem(randomUUID(), rightAgentId, rightMemoryId, 2)
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        insertItem(randomUUID(), leftAgentId, leftMemoryId, 2)
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        insertItem(randomUUID(), leftAgentId, secondLeftMemoryId, 1)
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        insertItem(randomUUID(), leftAgentId, secondLeftMemoryId, 501)
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        insertItem(
          randomUUID(),
          leftAgentId,
          secondLeftMemoryId,
          2,
          ["unbounded-lane"]
        )
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        ownerSql`
          UPDATE public.memory_retrievals
          SET candidate_count = 2
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await ownerSql`
        UPDATE public.memory_retrievals
        SET candidate_count = 1
        WHERE id = ${retrievalId}::uuid
      `;

      await expect(
        ownerSql`
          UPDATE public.memory_retrieval_items
          SET final_score = 0.5
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      const returnedAt = "2026-08-29T02:00:01.000Z";
      await ownerSql`
        UPDATE public.memory_retrieval_items
        SET returned_at = ${returnedAt}
        WHERE id = ${itemId}::uuid
      `;
      await expect(
        ownerSql`
          UPDATE public.memory_retrieval_items
          SET returned_at = '2026-08-29T02:00:02.000Z'
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      await ownerSql`
        UPDATE public.memory_retrievals
        SET status = 'completed',
            returned_count = 1,
            latency_ms = 1,
            completed_at = ${returnedAt}
        WHERE id = ${retrievalId}::uuid
      `;
      await expect(
        ownerSql`
          UPDATE public.memory_retrieval_items
          SET returned_at = NULL
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      const persisted = await ownerSql`
        SELECT
          final_rank,
          returned_at = ${returnedAt}::timestamptz AS returned_once
        FROM public.memory_retrieval_items
        WHERE id = ${itemId}::uuid
      `;
      expect(persisted).toEqual([{ final_rank: 1, returned_once: true }]);
    } finally {
      await ownerSql`
        DELETE FROM public.memory_retrievals WHERE id = ${retrievalId}::uuid
      `;
      await ownerSql`
        DELETE FROM public.memory_nodes
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.agents
        WHERE id IN (${leftAgentId}, ${rightAgentId})
      `;
    }
  });

  test("runtime grants preserve one-way retrieval candidacy and delivery evidence", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice6-runtime-retrieval-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 6 Runtime Retrieval')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const memoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${agentId}, 'slice6 runtime delivery one'),
             (${agentId}, 'slice6 runtime delivery two'),
             (${agentId}, 'slice6 runtime delivery three')
      RETURNING id
    `;
    const memoryId = Number(memoryRows[0].id);
    const secondMemoryId = Number(memoryRows[1].id);
    const thirdMemoryId = Number(memoryRows[2].id);
    const retrievalId = randomUUID();
    const itemId = randomUUID();
    const secondItemId = randomUUID();
    const createdAt = "2026-08-29T03:00:00.000Z";
    const returnedAt = "2026-08-29T03:00:01.000Z";
    const completedAt = "2026-08-29T03:00:02.000Z";
    const redactedAt = "2026-08-29T03:00:03.000Z";
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });

    try {
      await runtimeSql`
        INSERT INTO public.memory_retrievals (
          id, agent_id, request_id, session_id, query, query_hash,
          channel, status, algorithm_version, build_id, candidate_count,
          returned_count, created_at
        ) VALUES (
          ${retrievalId}::uuid, ${agentId}, 'slice6-runtime-request',
          'slice6-runtime-session', 'runtime proof', ${"3".repeat(64)},
          'search', 'running', 'memory-retrieval-v1',
          'slice6-runtime-proof', 0, 0, ${createdAt}
        )
      `;
      await runtimeSql`
        INSERT INTO public.memory_retrieval_items (
          id, agent_id, retrieval_id, memory_id, content_hash,
          candidate_lanes, component_ranks, final_score,
          final_rank, created_at
        ) VALUES (
          ${itemId}::uuid, ${agentId}, ${retrievalId}::uuid, ${memoryId},
          ${"4".repeat(64)}, ARRAY['lexical']::text[],
          '[{"lane":"lexical","rank":1,"sourceScore":1}]'::jsonb,
          1, 1, ${createdAt}
        ), (
          ${secondItemId}::uuid, ${agentId}, ${retrievalId}::uuid,
          ${secondMemoryId}, ${"5".repeat(64)}, ARRAY['vector']::text[],
          '[{"lane":"vector","rank":2,"sourceScore":0.9}]'::jsonb,
          0.9, 2, ${createdAt}
        )
      `;
      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET candidate_count = 3
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await runtimeSql`
        UPDATE public.memory_retrievals
        SET candidate_count = 2
        WHERE id = ${retrievalId}::uuid
      `;
      await runtimeSql`
        UPDATE public.memory_retrieval_items
        SET returned_at = ${returnedAt}
        WHERE id = ${itemId}::uuid
      `;
      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET status = 'completed',
              returned_count = 0,
              latency_ms = 2,
              completed_at = ${completedAt}
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await runtimeSql`
        UPDATE public.memory_retrievals
        SET status = 'completed',
            returned_count = 1,
            latency_ms = 2,
            completed_at = ${completedAt}
        WHERE id = ${retrievalId}::uuid
      `;

      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET status = 'running',
              returned_count = 0,
              latency_ms = NULL,
              completed_at = NULL
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET candidate_count = 1
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        runtimeSql`
          UPDATE public.memory_retrieval_items
          SET returned_at = ${completedAt}
          WHERE id = ${secondItemId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        runtimeSql`
          INSERT INTO public.memory_retrieval_items (
            id, agent_id, retrieval_id, memory_id, content_hash,
            candidate_lanes, component_ranks, final_score,
            final_rank, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${agentId}, ${retrievalId}::uuid,
            ${thirdMemoryId}, ${"6".repeat(64)}, ARRAY['entity']::text[],
            '[{"lane":"entity","rank":3,"sourceScore":0.8}]'::jsonb,
            0.8, 3, ${createdAt}
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        runtimeSql`
          UPDATE public.memory_retrieval_items
          SET final_score = 0.5
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql`
          DELETE FROM public.memory_retrieval_items
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET redacted_at = ${redactedAt}
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "42501" });

      await ownerSql`
        UPDATE public.memory_retrievals
        SET request_id = NULL,
            session_id = NULL,
            query = NULL,
            redacted_at = ${redactedAt}
        WHERE id = ${retrievalId}::uuid
      `;
      await expect(
        ownerSql`
          UPDATE public.memory_retrievals
          SET query_hash = ${"7".repeat(64)}
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      const evidence = await ownerSql`
        SELECT
          retrieval.status,
          retrieval.candidate_count,
          retrieval.returned_count,
          retrieval.query IS NULL AS query_redacted,
          retrieval.redacted_at = ${redactedAt}::timestamptz AS redacted_once,
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_retrieval_items AS item
           WHERE item.retrieval_id = retrieval.id
             AND item.returned_at IS NOT NULL) AS returned_items,
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_retrieval_items AS item
           WHERE item.retrieval_id = retrieval.id
             AND item.returned_at IS NULL) AS candidate_only_items
        FROM public.memory_retrievals AS retrieval
        WHERE retrieval.id = ${retrievalId}::uuid
      `;
      expect(evidence).toEqual([{
        status: "completed",
        candidate_count: 2,
        returned_count: 1,
        query_redacted: true,
        redacted_once: true,
        returned_items: 1,
        candidate_only_items: 1,
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`
        DELETE FROM public.memory_retrievals WHERE id = ${retrievalId}::uuid
      `;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("retrieval evidence timestamps form one chronological history", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice6-retrieval-time-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 6 Retrieval Timeline')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const memoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${agentId}, 'slice6 retrieval timeline candidate')
      RETURNING id
    `;
    const memoryId = Number(memoryRows[0].id);
    const retrievalId = randomUUID();
    const itemId = randomUUID();
    const retrievalCreatedAt = "2026-08-29T04:00:00.000Z";
    const itemCreatedAt = "2026-08-29T04:00:02.000Z";
    const returnedAt = "2026-08-29T04:00:03.000Z";
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });

    try {
      await runtimeSql`
        INSERT INTO public.memory_retrievals (
          id, agent_id, query, query_hash, channel, status,
          algorithm_version, build_id, candidate_count,
          returned_count, created_at
        ) VALUES (
          ${retrievalId}::uuid, ${agentId}, 'timeline proof',
          ${"8".repeat(64)}, 'search', 'running',
          'memory-retrieval-v1', 'slice6-timeline-proof', 0, 0,
          ${retrievalCreatedAt}
        )
      `;
      await expect(
        runtimeSql`
          INSERT INTO public.memory_retrieval_items (
            id, agent_id, retrieval_id, memory_id, content_hash,
            candidate_lanes, component_ranks, final_score,
            final_rank, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${agentId}, ${retrievalId}::uuid,
            ${memoryId}, ${"9".repeat(64)}, ARRAY['lexical']::text[],
            '[{"lane":"lexical","rank":1,"sourceScore":1}]'::jsonb,
            1, 1, '2026-08-29T03:59:59.000Z'
          )
        `
      ).rejects.toMatchObject({ code: "23514" });

      await runtimeSql`
        INSERT INTO public.memory_retrieval_items (
          id, agent_id, retrieval_id, memory_id, content_hash,
          candidate_lanes, component_ranks, final_score,
          final_rank, created_at
        ) VALUES (
          ${itemId}::uuid, ${agentId}, ${retrievalId}::uuid,
          ${memoryId}, ${"a".repeat(64)}, ARRAY['lexical']::text[],
          '[{"lane":"lexical","rank":1,"sourceScore":1}]'::jsonb,
          1, 1, ${itemCreatedAt}
        )
      `;
      await runtimeSql`
        UPDATE public.memory_retrievals
        SET candidate_count = 1
        WHERE id = ${retrievalId}::uuid
      `;
      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET status = 'completed',
              returned_count = 0,
              latency_ms = 1,
              completed_at = '2026-08-29T04:00:01.000Z'
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      await runtimeSql`
        UPDATE public.memory_retrieval_items
        SET returned_at = ${returnedAt}
        WHERE id = ${itemId}::uuid
      `;
      await expect(
        runtimeSql`
          UPDATE public.memory_retrievals
          SET status = 'completed',
              returned_count = 1,
              latency_ms = 2,
              completed_at = ${itemCreatedAt}
          WHERE id = ${retrievalId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });
      await runtimeSql`
        UPDATE public.memory_retrievals
        SET status = 'completed',
            returned_count = 1,
            latency_ms = 3,
            completed_at = ${returnedAt}
        WHERE id = ${retrievalId}::uuid
      `;

      const evidence = await ownerSql`
        SELECT
          retrieval.status,
          retrieval.candidate_count,
          retrieval.returned_count,
          retrieval.completed_at = ${returnedAt}::timestamptz AS completed_last,
          item.created_at = ${itemCreatedAt}::timestamptz AS candidate_after_start,
          item.returned_at = ${returnedAt}::timestamptz AS returned_at_completion
        FROM public.memory_retrievals AS retrieval
        JOIN public.memory_retrieval_items AS item
          ON item.retrieval_id = retrieval.id
         AND item.agent_id = retrieval.agent_id
        WHERE retrieval.id = ${retrievalId}::uuid
      `;
      expect(evidence).toEqual([{
        status: "completed",
        candidate_count: 1,
        returned_count: 1,
        completed_last: true,
        candidate_after_start: true,
        returned_at_completion: true,
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`
        DELETE FROM public.memory_retrievals WHERE id = ${retrievalId}::uuid
      `;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("retrieval service persists candidacy without mutation and marks only delivery labile", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice6-service-retrieval-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 6 Service Retrieval')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const memoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content, priority)
      VALUES (${agentId}, 'slice6 delivery alpha evidence', 2),
             (${agentId}, 'slice6 delivery beta evidence', 2)
      RETURNING id
    `;
    const memoryIds = memoryRows.map((row) => Number(row.id));
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });

    try {
      const dependencies = testDependencies({
        embedQuery: async () => validEmbeddingBatch(1).vectors[0],
        patternComplete: async () => [],
      });
      const retrieval = createRetrievalService({
        ...dependencies,
        sql: runtimeSql as unknown as Sql,
      });
      const prepared = await retrieval.prepare({
        agentId,
        query: "slice6 delivery evidence",
        channel: "search",
        requestId: `slice6-service-${suffix}`,
        limit: 2,
      });

      expect(prepared.candidates).toHaveLength(2);
      const candidateEvidence = await ownerSql`
        SELECT
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_retrieval_items
           WHERE retrieval_id = ${prepared.retrievalId}::uuid) AS candidates,
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_retrieval_items
           WHERE retrieval_id = ${prepared.retrievalId}::uuid
             AND returned_at IS NOT NULL) AS returned,
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_nodes
           WHERE id = ANY(${ownerSql.array(memoryIds)}::integer[])
             AND (access_count <> 0
               OR last_accessed_at IS NOT NULL
               OR last_recalled_at IS NOT NULL)) AS mutated_nodes
      `;
      expect(candidateEvidence).toEqual([
        { candidates: 2, returned: 0, mutated_nodes: 0 },
      ]);

      const delivered = await retrieval.deliver(prepared, [
        prepared.candidates[0],
      ]);
      expect(delivered).toMatchObject({
        retrievalId: prepared.retrievalId,
        candidateCount: 2,
        returnedCount: 1,
      });
      expect(delivered.results).toHaveLength(1);

      const deliveredMemoryId = delivered.results[0].kind === "memory"
        ? delivered.results[0].memoryId
        : null;
      const deliveryEvidence = await ownerSql`
        SELECT
          retrieval.status,
          retrieval.candidate_count,
          retrieval.returned_count,
          pg_catalog.count(*) FILTER (
            WHERE item.returned_at IS NOT NULL
          )::integer AS returned_items,
          pg_catalog.count(*) FILTER (
            WHERE item.returned_at IS NULL
          )::integer AS candidate_only_items,
          pg_catalog.count(*) FILTER (
            WHERE node.id = ${deliveredMemoryId}
              AND node.last_recalled_at IS NOT NULL
          )::integer AS labile_delivered_nodes,
          pg_catalog.count(*) FILTER (
            WHERE node.id <> ${deliveredMemoryId}
              AND node.last_recalled_at IS NOT NULL
          )::integer AS labile_candidate_only_nodes,
          pg_catalog.max(node.access_count)::integer AS max_access_count
        FROM public.memory_retrievals AS retrieval
        JOIN public.memory_retrieval_items AS item
          ON item.retrieval_id = retrieval.id
         AND item.agent_id = retrieval.agent_id
        JOIN public.memory_nodes AS node
          ON node.id = item.memory_id
         AND node.agent_id = item.agent_id
        WHERE retrieval.id = ${prepared.retrievalId}::uuid
        GROUP BY
          retrieval.status,
          retrieval.candidate_count,
          retrieval.returned_count
      `;
      expect(deliveryEvidence).toEqual([{
        status: "completed",
        candidate_count: 2,
        returned_count: 1,
        returned_items: 1,
        candidate_only_items: 1,
        labile_delivered_nodes: 1,
        labile_candidate_only_nodes: 0,
        max_access_count: 0,
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`DELETE FROM public.memory_retrievals WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("two deliveries never move a memory's recall window backward", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice6-monotonic-recall-${suffix}`;
    const content = `slice6 monotonic recall evidence ${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 6 Monotonic Recall')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const memoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content, priority)
      VALUES (${agentId}, ${content}, 2)
      RETURNING id
    `;
    const memoryId = Number(memoryRows[0].id);
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 2,
      onnotice: () => {},
    });
    let olderClock = "2026-08-29T10:00:00.000Z";
    let newerClock = "2026-08-29T10:02:00.000Z";

    try {
      const sharedOverrides = {
        embedQuery: async () => validEmbeddingBatch(1).vectors[0],
        patternComplete: async () => [],
      };
      const olderRetrieval = createRetrievalService({
        ...testDependencies({
          ...sharedOverrides,
          now: () => new Date(olderClock),
        }),
        sql: runtimeSql as unknown as Sql,
      });
      const newerRetrieval = createRetrievalService({
        ...testDependencies({
          ...sharedOverrides,
          now: () => new Date(newerClock),
        }),
        sql: runtimeSql as unknown as Sql,
      });

      const olderPrepared = await olderRetrieval.prepare({
        agentId,
        query: content,
        channel: "search",
        limit: 1,
      });
      const newerPrepared = await newerRetrieval.prepare({
        agentId,
        query: content,
        channel: "search",
        limit: 1,
      });
      expect(olderPrepared.candidates).toHaveLength(1);
      expect(newerPrepared.candidates).toHaveLength(1);

      newerClock = "2026-08-29T10:03:00.000Z";
      const newerDelivery = await newerRetrieval.deliver(newerPrepared, [
        newerPrepared.candidates[0],
      ]);
      olderClock = "2026-08-29T10:01:00.000Z";
      const olderDelivery = await olderRetrieval.deliver(olderPrepared, [
        olderPrepared.candidates[0],
      ]);
      expect(newerDelivery.returnedCount).toBe(1);
      expect(olderDelivery.returnedCount).toBe(1);

      const evidence = await ownerSql`
        SELECT
          last_recalled_at = '2026-08-29T10:03:00.000Z'::timestamptz
            AS retained_newer_recall,
          access_count,
          last_accessed_at
        FROM public.memory_nodes
        WHERE id = ${memoryId}
          AND agent_id = ${agentId}
      `;
      expect(evidence).toEqual([{
        retained_newer_recall: true,
        access_count: 0,
        last_accessed_at: null,
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`DELETE FROM public.memory_retrievals WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("concurrent opposite-rank deliveries share one global node lock order", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice6-lock-order-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 6 Delivery Lock Order')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const memoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content, priority, entities)
      VALUES
        (
          ${agentId}, ${`alpha alpha alpha beta shared ${suffix}`}, 2,
          ARRAY['alpha']::text[]
        ),
        (
          ${agentId}, ${`alpha beta beta beta shared ${suffix}`}, 2,
          ARRAY['beta']::text[]
        )
      RETURNING id
    `;
    const memoryIds = memoryRows.map((row) => Number(row.id));
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 4,
      onnotice: () => {},
    });

    try {
      const retrieval = createRetrievalService({
        ...testDependencies({
          embedQuery: async () => validEmbeddingBatch(1).vectors[0],
          patternComplete: async () => [],
        }),
        sql: runtimeSql as unknown as Sql,
      });
      const alphaPrepared = await retrieval.prepare({
        agentId,
        query: "alpha shared",
        channel: "search",
        limit: 2,
      });
      const betaPrepared = await retrieval.prepare({
        agentId,
        query: "beta shared",
        channel: "search",
        limit: 2,
      });
      const alphaOrder = alphaPrepared.candidates.map((candidate) =>
        candidate.kind === "memory" ? candidate.memoryId : null
      );
      const betaOrder = betaPrepared.candidates.map((candidate) =>
        candidate.kind === "memory" ? candidate.memoryId : null
      );
      expect(alphaOrder).toEqual(memoryIds);
      expect(betaOrder).toEqual([...memoryIds].reverse());

      const [alphaDelivery, betaDelivery] = await Promise.all([
        retrieval.deliver(alphaPrepared, alphaPrepared.candidates),
        retrieval.deliver(betaPrepared, betaPrepared.candidates),
      ]);
      expect(alphaDelivery.returnedCount).toBe(2);
      expect(betaDelivery.returnedCount).toBe(2);

      const evidence = await ownerSql`
        SELECT
          pg_catalog.count(DISTINCT retrieval.id)::integer AS retrievals,
          pg_catalog.count(item.id)::integer AS returned_items,
          pg_catalog.count(DISTINCT node.id) FILTER (
            WHERE node.last_recalled_at IS NOT NULL
          )::integer AS recalled_nodes,
          pg_catalog.max(node.access_count)::integer AS max_access_count
        FROM public.memory_retrievals AS retrieval
        JOIN public.memory_retrieval_items AS item
          ON item.retrieval_id = retrieval.id
         AND item.agent_id = retrieval.agent_id
         AND item.returned_at IS NOT NULL
        JOIN public.memory_nodes AS node
          ON node.id = item.memory_id
         AND node.agent_id = item.agent_id
        WHERE retrieval.id IN (
          ${alphaPrepared.retrievalId}::uuid,
          ${betaPrepared.retrievalId}::uuid
        )
          AND retrieval.status = 'completed'
      `;
      expect(evidence).toEqual([{
        retrievals: 2,
        returned_items: 4,
        recalled_nodes: 2,
        max_access_count: 0,
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`DELETE FROM public.memory_retrievals WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("CA3-on filters stronger historical, expired, and foreign candidates before graph bounds", async () => {
    const suffix = randomUUID().slice(0, 8);
    const leftExternalId = `slice6-ca3-left-${suffix}`;
    const rightExternalId = `slice6-ca3-right-${suffix}`;
    const asOf = new Date("2026-08-29T09:00:00.000Z");
    const expiredAt = new Date(asOf.getTime() - 60_000).toISOString();
    const distractorsPerClass = 21;
    const query = "quartz heliotrope";
    const querySparse = dgEncode([...UNIT_VECTOR]);
    const targetSparseValues = querySparse.values.map((value) => value * 0.5);
    const agents = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${leftExternalId}, 'Slice 6 CA3 Left'),
             (${rightExternalId}, 'Slice 6 CA3 Right')
      RETURNING id, external_id
    `;
    const leftAgentId = Number(
      agents.find((agent) => agent.external_id === leftExternalId)?.id
    );
    const rightAgentId = Number(
      agents.find((agent) => agent.external_id === rightExternalId)?.id
    );
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });

    try {
      const currentRows = await ownerSql`
        INSERT INTO public.memory_nodes (agent_id, content, status, priority)
        VALUES
          (${leftAgentId}, ${`opaque current seed ${suffix}`}, 'active', 2),
          (${leftAgentId}, ${`opaque current graph neighbor ${suffix}`}, 'active', 2)
        RETURNING id, content
      `;
      const targetId = Number(
        currentRows.find(
          (row) => row.content === `opaque current seed ${suffix}`
        )?.id
      );
      const neighborId = Number(
        currentRows.find(
          (row) => row.content === `opaque current graph neighbor ${suffix}`
        )?.id
      );
      const historicalRows = await ownerSql`
        INSERT INTO public.memory_nodes (
          agent_id,
          content,
          status,
          valid_until,
          superseded_by,
          derivation_expires_at,
          priority
        )
        SELECT
          ${leftAgentId}::integer,
          ${`opaque superseded ${suffix} `} || ordinal::text,
          'superseded'::varchar(32),
          NULL::timestamptz,
          ${targetId}::integer,
          NULL::timestamptz,
          2::integer
        FROM pg_catalog.generate_series(1, ${distractorsPerClass}) AS series(ordinal)
        UNION ALL
        SELECT
          ${leftAgentId}::integer,
          ${`opaque archived ${suffix} `} || ordinal::text,
          'archived'::varchar(32),
          NULL::timestamptz,
          NULL::integer,
          NULL::timestamptz,
          2::integer
        FROM pg_catalog.generate_series(1, ${distractorsPerClass}) AS series(ordinal)
        UNION ALL
        SELECT
          ${leftAgentId}::integer,
          ${`opaque validity-expired ${suffix} `} || ordinal::text,
          'active'::varchar(32),
          ${expiredAt}::timestamptz,
          NULL::integer,
          NULL::timestamptz,
          2::integer
        FROM pg_catalog.generate_series(1, ${distractorsPerClass}) AS series(ordinal)
        UNION ALL
        SELECT
          ${leftAgentId}::integer,
          ${`opaque derivation-expired ${suffix} `} || ordinal::text,
          'active'::varchar(32),
          NULL::timestamptz,
          NULL::integer,
          ${expiredAt}::timestamptz,
          2::integer
        FROM pg_catalog.generate_series(1, ${distractorsPerClass}) AS series(ordinal)
        RETURNING id, content
      `;
      const foreignRows = await ownerSql`
        INSERT INTO public.memory_nodes (agent_id, content, status, priority)
        SELECT
          ${rightAgentId}::integer,
          ${`opaque foreign ${suffix} `} || ordinal::text,
          'active'::varchar(32),
          2::integer
        FROM pg_catalog.generate_series(1, ${distractorsPerClass}) AS series(ordinal)
        RETURNING id
      `;
      const historicalIds = historicalRows.map((row) => Number(row.id));
      const foreignIds = foreignRows.map((row) => Number(row.id));
      const strongerCandidateIds = [...historicalIds, ...foreignIds];
      await ownerSql`
        INSERT INTO public.hippocampal_codes (
          memory_id,
          agent_id,
          sparse_indices,
          sparse_values
        ) VALUES (
          ${targetId},
          ${leftAgentId},
          ${ownerSql.array(querySparse.indices)}::integer[],
          ${ownerSql.array(targetSparseValues)}::real[]
        )
      `;
      await ownerSql`
        INSERT INTO public.hippocampal_codes (
          memory_id,
          agent_id,
          sparse_indices,
          sparse_values
        )
        SELECT
          node.id,
          node.agent_id,
          ${ownerSql.array(querySparse.indices)}::integer[],
          ${ownerSql.array(querySparse.values)}::real[]
        FROM public.memory_nodes AS node
        WHERE node.id = ANY(
          ${ownerSql.array(strongerCandidateIds)}::integer[]
        )
      `;

      const edgeRows = await ownerSql`
        INSERT INTO public.memory_synapses (
          agent_id,
          memory_a,
          memory_b,
          connection_type,
          connection_strength
        )
        SELECT
          ${leftAgentId}::integer,
          ${targetId}::integer,
          node.id,
          'semantic'::varchar(32),
          1.0::real
        FROM public.memory_nodes AS node
        WHERE node.id = ANY(${ownerSql.array(historicalIds)}::integer[])
        UNION ALL
        SELECT
          ${leftAgentId}::integer,
          ${targetId}::integer,
          ${neighborId}::integer,
          'semantic'::varchar(32),
          0.75::real
        RETURNING id
      `;
      const edgeIds = edgeRows.map((row) => Number(row.id));
      expect(historicalIds).toHaveLength(distractorsPerClass * 4);
      expect(foreignIds).toHaveLength(distractorsPerClass);
      // limit=2 bounds CA3 graph loading at 80 edges. The weaker current edge
      // can only survive when invalid endpoints are filtered before that cap.
      expect(historicalIds.length).toBeGreaterThan(80);
      expect(
        sparseOverlap(querySparse, {
          ...querySparse,
          values: targetSparseValues,
        })
      ).toBeLessThan(sparseOverlap(querySparse, querySparse));

      const nodeIds = [targetId, neighborId, ...strongerCandidateIds];
      const beforeNodes = await ownerSql`
        SELECT id, access_count, last_accessed_at, last_recalled_at
        FROM public.memory_nodes
        WHERE id = ANY(${ownerSql.array(nodeIds)}::integer[])
        ORDER BY id ASC
      `;
      const beforeEdges = await ownerSql`
        SELECT id, activation_count
        FROM public.memory_synapses
        WHERE id = ANY(${ownerSql.array(edgeIds)}::integer[])
        ORDER BY id ASC
      `;
      expect(beforeNodes).toHaveLength(nodeIds.length);
      expect(
        beforeNodes.every(
          (node) =>
            node.access_count === 0 &&
            node.last_accessed_at === null &&
            node.last_recalled_at === null
        )
      ).toBe(true);
      expect(beforeEdges).toHaveLength(edgeIds.length);
      expect(
        beforeEdges.every((edge) => edge.activation_count === 0)
      ).toBe(true);

      const graphResults = await patternComplete(
        leftAgentId,
        [...UNIT_VECTOR],
        2,
        asOf.toISOString()
      );
      expect(graphResults.map((result) => result.memoryId)).toEqual([
        targetId,
        neighborId,
      ]);
      expect(graphResults[0]).toMatchObject({
        memoryId: targetId,
        sparseOverlap: expect.any(Number),
      });
      expect(graphResults[1]).toMatchObject({
        memoryId: neighborId,
        sparseOverlap: 0,
        synapticBoost: expect.any(Number),
      });
      expect(graphResults[0].sparseOverlap).toBeGreaterThan(0);
      expect(graphResults[1].synapticBoost).toBeGreaterThan(0);

      const dependencies = testDependencies({
        now: () => asOf,
        embedQuery: async () => validEmbeddingBatch(1).vectors[0],
      });
      const retrieval = createRetrievalService({
        ...dependencies,
        sql: runtimeSql as unknown as Sql,
      });
      const prepared = await retrieval.prepare({
        agentId: leftAgentId,
        query,
        channel: "search",
        requestId: `slice6-ca3-${suffix}`,
        limit: 2,
        enableCA3: true,
      });
      expect(prepared.warnings).toEqual([]);
      expect(
        prepared.candidates.map((candidate) =>
          candidate.kind === "memory" ? candidate.memoryId : null
        )
      ).toEqual([targetId, neighborId]);
      expect(
        prepared.candidates.map((candidate) => candidate.componentRanks)
      ).toEqual([
        [expect.objectContaining({ lane: "graph", rank: 1 })],
        [expect.objectContaining({ lane: "graph", rank: 2 })],
      ]);
      expect(
        prepared.candidates.some(
          (candidate) =>
            candidate.kind === "memory" &&
            strongerCandidateIds.includes(candidate.memoryId)
        )
      ).toBe(false);

      const persistedEvidence = await ownerSql`
        SELECT
          retrieval.status,
          retrieval.candidate_count,
          retrieval.returned_count,
          item.memory_id,
          item.candidate_lanes,
          item.returned_at
        FROM public.memory_retrievals AS retrieval
        JOIN public.memory_retrieval_items AS item
          ON item.retrieval_id = retrieval.id
         AND item.agent_id = retrieval.agent_id
        WHERE retrieval.id = ${prepared.retrievalId}::uuid
        ORDER BY item.final_rank ASC
      `;
      expect(persistedEvidence).toEqual([
        {
          status: "running",
          candidate_count: 2,
          returned_count: 0,
          memory_id: targetId,
          candidate_lanes: ["graph"],
          returned_at: null,
        },
        {
          status: "running",
          candidate_count: 2,
          returned_count: 0,
          memory_id: neighborId,
          candidate_lanes: ["graph"],
          returned_at: null,
        },
      ]);

      const afterNodes = await ownerSql`
        SELECT id, access_count, last_accessed_at, last_recalled_at
        FROM public.memory_nodes
        WHERE id = ANY(${ownerSql.array(nodeIds)}::integer[])
        ORDER BY id ASC
      `;
      const afterEdges = await ownerSql`
        SELECT id, activation_count
        FROM public.memory_synapses
        WHERE id = ANY(${ownerSql.array(edgeIds)}::integer[])
        ORDER BY id ASC
      `;
      expect(afterNodes).toEqual(beforeNodes);
      expect(afterEdges).toEqual(beforeEdges);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`
        DELETE FROM public.memory_retrievals
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_synapses
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.hippocampal_codes
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_nodes
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.agents
        WHERE id IN (${leftAgentId}, ${rightAgentId})
      `;
    }
  }, 45_000);

  test("database bounds source snapshot identities by UTF-8 bytes", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-source-byte-bound', 'Slice 4 Source Byte Bound')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T01:00:00.000Z").toISOString();

    try {
      await expect(
        ownerSql`
          INSERT INTO public.memory_ingest_events (
            id, agent_id, idempotency_key, raw_content, request_hash,
            content_hash, source, source_version, source_type, observed_at,
            observed_at_was_defaulted, requested_priority, effective_priority,
            projection_mode, accepted_at, updated_at, acceptance_build_id
          ) VALUES (
            ${randomUUID()}::uuid, ${agentId}, 'slice4-long-source',
            'bounded source proof', ${"0".repeat(64)}, ${"1".repeat(64)},
            ${"é".repeat(513)}, 'version-1', 'markdown', ${now}, false,
            1, 1, 'replace_source', ${now}, ${now}, 'slice4-db-bound'
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        ownerSql`
          INSERT INTO public.memory_ingest_events (
            id, agent_id, idempotency_key, raw_content, request_hash,
            content_hash, source, source_version, source_type, observed_at,
            observed_at_was_defaulted, requested_priority, effective_priority,
            projection_mode, accepted_at, updated_at, acceptance_build_id
          ) VALUES (
            ${randomUUID()}::uuid, ${agentId}, 'slice4-long-source-version',
            'bounded source version proof', ${"2".repeat(64)}, ${"3".repeat(64)},
            '/source/bounded.md', ${"é".repeat(513)}, 'markdown', ${now}, false,
            1, 1, 'replace_source', ${now}, ${now}, 'slice4-db-bound'
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("runtime role performs lifecycle DML but cannot run DDL or read OAuth authority", async () => {
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });
    try {
      await expect(
        runtimeSql`
          SELECT pg_catalog.count(*)::integer AS events
          FROM public.memory_ingest_events
        `
      ).resolves.toEqual([{ events: 0 }]);
      await expect(
        runtimeSql`
          CREATE TABLE public.slice3_runtime_forbidden (id integer)
        `
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql`
          SELECT id
          FROM public.oauth_authorization_codes
          LIMIT 1
        `
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`
        DROP TABLE IF EXISTS public.slice3_runtime_forbidden
      `;
    }
  });

  test("stdio MCP file and corpus tools return truthful durable source receipts", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-mcp-file-proof', 'Slice 4 MCP File Proof')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const existingNodes = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES
        (${agentId}, 'Pre-existing corpus total A'),
        (${agentId}, 'Pre-existing corpus total B')
      RETURNING id
    `;
    await ownerSql`
      INSERT INTO public.memory_synapses (
        agent_id, memory_a, memory_b, connection_type
      ) VALUES (
        ${agentId}, ${Number(existingNodes[0].id)},
        ${Number(existingNodes[1].id)}, 'semantic'
      )
    `;
    const importRoot = mkdtempSync(join(tmpdir(), "cortex-slice4-mcp-"));
    writeFileSync(
      join(importRoot, "MEMORY.md"),
      "A direct MCP file snapshot remains durably queued without a worker.",
      "utf8"
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/mcp/server.ts")],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: runtimeDatabaseUrl,
        CORTEX_BUILD_ID: "slice4-mcp-proof",
        CORTEX_HEADLESS: "false",
        CORTEX_IMPORT_ROOT: importRoot,
        CORTEX_WORKSPACE: importRoot,
      } as Record<string, string>,
    });
    const client = new Client(
      { name: "slice4-mcp-proof", version: "1.0.0" },
      { capabilities: {} }
    );
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await client.connect(transport);
      const fileResult = await client.callTool({
        name: "cortex_ingest_file",
        arguments: {
          agent_id: "slice4-mcp-file-proof",
          file_path: "MEMORY.md",
          source_type: "markdown",
        },
      });
      expect(fileResult.isError).not.toBe(true);
      expect(fileResult.structuredContent).toMatchObject({
        ok: true,
        tool: "cortex_ingest_file",
        data: {
          file_path: "MEMORY.md",
          chunks_stored: 0,
          status: "accepted",
          replayed: false,
          failure: null,
          next_attempt_at: null,
        },
      });
      const fileEventId = String(
        (fileResult.structuredContent as { data: { event_id: string } }).data
          .event_id
      );
      expect(fileEventId).toMatch(/^[0-9a-f-]{36}$/);

      const corpusResult = await client.callTool({
        name: "cortex_ingest_corpus",
        arguments: { agent_id: "slice4-mcp-file-proof" },
      });
      expect(corpusResult.isError).not.toBe(true);
      expect(corpusResult.structuredContent).toMatchObject({
        ok: true,
        tool: "cortex_ingest_corpus",
        data: {
          memories_created: 0,
          synapses_created: 0,
          chunks_stored: 0,
          files_processed: 1,
          files_failed: 0,
          queued: 1,
          indexed: 0,
          failed: 0,
          rejected: 0,
          read_failed: 0,
          submission_failed: 0,
          replayed: 1,
          active_memories_total: 2,
          synapses_total: 1,
        },
      });
      await expect(
        ownerSql`
          SELECT id::text, status, source_type, projection_mode,
                 source_version IS NOT NULL AS versioned
          FROM public.memory_ingest_events
          WHERE agent_id = ${agentId}
        `
      ).resolves.toEqual([
        {
          id: fileEventId,
          status: "accepted",
          source_type: "markdown",
          projection_mode: "replace_source",
          versioned: true,
        },
      ]);
    } catch (error) {
      throw new Error(
        `Direct MCP source receipt proof failed: ${(error as Error).message}; stderr=${stderr.slice(-2_000)}`
      );
    } finally {
      await client.close().catch(() => undefined);
      rmSync(importRoot, { recursive: true, force: true });
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 40_000);

  test("stdio MCP generic ingest retains distinct facts and replays exact retries", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice5-mcp-ingest-proof', 'Slice 5 MCP Ingest Proof')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/mcp/server.ts")],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: runtimeDatabaseUrl,
        CORTEX_BUILD_ID: "slice5-mcp-proof",
        CORTEX_HEADLESS: "false",
        CORTEX_ALLOW_HIGH_PRIORITY_INGEST: "false",
      } as Record<string, string>,
    });
    const client = new Client(
      { name: "slice5-mcp-proof", version: "1.0.0" },
      { capabilities: {} }
    );
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const firstContent = "The amber retry budget is exactly five attempts.";
    const secondContent = "The indigo retry budget is exactly seven attempts.";
    const source = "slice5:shared-source";
    const argumentsFor = (content: string, sourceType = "session") => ({
      agent_id: "slice5-mcp-ingest-proof",
      content,
      source,
      source_type: sourceType,
      priority: 0,
    });

    try {
      await client.connect(transport);
      const worker = createIngestWorker(
        testDependencies({ buildId: "slice5-mcp-proof" })
      );

      const firstCall = client.callTool({
        name: "cortex_ingest",
        arguments: argumentsFor(firstContent),
      });
      await waitUntil(
        async () => {
          const rows = await ownerSql`
            SELECT status
            FROM public.memory_ingest_events
            WHERE agent_id = ${agentId} AND raw_content = ${firstContent}
          `;
          return rows[0]?.status === "accepted";
        },
        "generic MCP ingest durable acceptance"
      );
      await expect(
        ownerSql`
          SELECT
            (
              SELECT pg_catalog.count(*)::integer
              FROM public.memory_ingest_events
              WHERE agent_id = ${agentId}
            ) AS events,
            (
              SELECT pg_catalog.count(*)::integer
              FROM public.memory_nodes
              WHERE agent_id = ${agentId}
            ) AS nodes
        `
      ).resolves.toEqual([{ events: 1, nodes: 0 }]);

      const firstClaim = await worker.claim("slice5-mcp-worker-1");
      expect(firstClaim).not.toBeNull();
      await expect(worker.process(firstClaim!)).resolves.toMatchObject({
        eventId: firstClaim!.eventId,
        status: "indexed",
      });
      const firstResult = await firstCall;
      expect(firstResult.isError).not.toBe(true);
      const firstData = (
        firstResult.structuredContent as {
          data: {
            event_id: string;
            status: string;
            replayed: boolean;
            memory_ids: number[];
            effective_priorities: number[];
            chunks_created: number;
          };
        }
      ).data;
      expect(firstData).toMatchObject({
        event_id: firstClaim!.eventId,
        status: "indexed",
        replayed: false,
        effective_priorities: [2],
        chunks_created: 1,
      });
      expect(firstData.memory_ids).toHaveLength(1);

      const replayResult = await client.callTool({
        name: "cortex_ingest",
        arguments: argumentsFor(firstContent),
      });
      expect(replayResult.isError).not.toBe(true);
      expect(replayResult.structuredContent).toMatchObject({
        data: {
          event_id: firstData.event_id,
          status: "indexed",
          replayed: true,
          memory_ids: firstData.memory_ids,
          chunks_created: 1,
        },
      });

      const secondCall = client.callTool({
        name: "cortex_ingest",
        arguments: argumentsFor(secondContent, "autoresearch"),
      });
      await waitUntil(
        async () => {
          const rows = await ownerSql`
            SELECT pg_catalog.count(*)::integer AS events
            FROM public.memory_ingest_events
            WHERE agent_id = ${agentId}
          `;
          return Number(rows[0]?.events) === 2;
        },
        "distinct generic MCP event"
      );
      const secondClaim = await worker.claim("slice5-mcp-worker-2");
      expect(secondClaim).not.toBeNull();
      expect(secondClaim!.eventId).not.toBe(firstData.event_id);
      await expect(worker.process(secondClaim!)).resolves.toMatchObject({
        eventId: secondClaim!.eventId,
        status: "indexed",
      });
      const secondResult = await secondCall;
      expect(secondResult.isError).not.toBe(true);
      expect(secondResult.structuredContent).toMatchObject({
        data: {
          event_id: secondClaim!.eventId,
          status: "indexed",
          replayed: false,
          chunks_created: 1,
        },
      });

      const durableRows = await ownerSql`
        SELECT id::text, raw_content, idempotency_key, source_type, status
        FROM public.memory_ingest_events
        WHERE agent_id = ${agentId}
        ORDER BY accepted_at, id
      `;
      expect(durableRows.map((row) => row.raw_content)).toEqual([
        firstContent,
        secondContent,
      ]);
      expect(new Set(durableRows.map((row) => row.idempotency_key)).size).toBe(2);
      expect(durableRows.map((row) => row.source_type)).toEqual([
        "session",
        "autoresearch",
      ]);
      expect(durableRows.every((row) => row.status === "indexed")).toBe(true);

      const conflict = await client.callTool({
        name: "cortex_ingest",
        arguments: {
          ...argumentsFor("A conflicting replacement must not overwrite evidence."),
          idempotency_key: String(durableRows[0].idempotency_key),
        },
      });
      expect(conflict.isError).toBe(true);
      const conflictContent = (
        conflict as { content: Array<{ text?: string }> }
      ).content;
      const conflictBody = JSON.parse(
        String(conflictContent[0]?.text)
      );
      expect(conflictBody.errors[0]).toMatchObject({
        code: "idempotency_key_reused",
      });
      await expect(
        ownerSql`
          SELECT pg_catalog.count(*)::integer AS events
          FROM public.memory_ingest_events
          WHERE agent_id = ${agentId}
        `
      ).resolves.toEqual([{ events: 2 }]);
    } catch (error) {
      throw new Error(
        `Direct MCP generic ingest proof failed: ${(error as Error).message}; stderr=${stderr.slice(-2_000)}`
      );
    } finally {
      await client.close().catch(() => undefined);
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 60_000);

  test("readiness chooses a recent worker from its own build", async () => {
    const { createMemoryHealthService } = await import("../memory/health.js");
    const now = new Date("2026-08-28T12:00:00.000Z");
    const matchingId = "9a4dbe6a-239e-4d4b-b8cd-d70dcfbe1721";
    const foreignId = "38a90bf4-848c-40c9-8dd4-795920616e72";
    try {
      await ownerSql`
        INSERT INTO public.memory_operation_runs (
          id, operation, status, build_id, worker_id, counters,
          started_at, heartbeat_at
        ) VALUES
          (
            ${matchingId}::uuid, 'ingest_worker', 'running', 'build-a',
            'matching-worker', '{}'::jsonb,
            ${new Date(now.getTime() - 60_000).toISOString()},
            ${new Date(now.getTime() - 10_000).toISOString()}
          ),
          (
            ${foreignId}::uuid, 'ingest_worker', 'running', 'build-b',
            'newer-foreign-worker', '{}'::jsonb,
            ${new Date(now.getTime() - 60_000).toISOString()},
            ${new Date(now.getTime() - 1_000).toISOString()}
          )
      `;
      const health = createMemoryHealthService({
        sql: ownerSql,
        config: { buildId: "build-a" },
        now: () => now,
      } as never);
      await expect(health.readiness()).resolves.toEqual({
        ready: true,
        buildId: "build-a",
        reasons: [],
      });
    } finally {
      await ownerSql`
        DELETE FROM public.memory_operation_runs
        WHERE id IN (${matchingId}::uuid, ${foreignId}::uuid)
      `;
    }
  });

  test("graph code and valence inserts require matching memory ownership", async () => {
    const agents = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-owner-a', 'Slice 3 Owner A'),
             ('slice3-owner-b', 'Slice 3 Owner B')
      RETURNING id
    `;
    const left = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${Number(agents[0].id)}, 'owned by A')
      RETURNING id
    `;
    const right = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content)
      VALUES (${Number(agents[1].id)}, 'owned by B')
      RETURNING id
    `;

    try {
      await expect(
        ownerSql`
          UPDATE public.memory_nodes
          SET superseded_by = ${Number(right[0].id)}
          WHERE id = ${Number(left[0].id)}
        `
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        ownerSql`
          INSERT INTO public.memory_synapses (
            agent_id, memory_a, memory_b, connection_type
          ) VALUES (
            ${Number(agents[0].id)}, ${Number(left[0].id)},
            ${Number(right[0].id)}, 'semantic'
          )
        `
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        ownerSql`
          INSERT INTO public.hippocampal_codes (
            memory_id, agent_id, sparse_indices, sparse_values
          ) VALUES (
            ${Number(left[0].id)}, ${Number(agents[1].id)},
            ARRAY[1]::integer[], ARRAY[1]::real[]
          )
        `
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        ownerSql`
          INSERT INTO public.emotional_valence (memory_id, agent_id)
          VALUES (${Number(left[0].id)}, ${Number(agents[1].id)})
        `
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await ownerSql`
        DELETE FROM public.memory_nodes
        WHERE id IN (${Number(left[0].id)}, ${Number(right[0].id)})
      `;
      await ownerSql`
        DELETE FROM public.agents
        WHERE id IN (${Number(agents[0].id)}, ${Number(agents[1].id)})
      `;
    }
  });

  test("runtime lifecycle state and failure evidence remain coherent", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-state-guard', 'Slice 3 State Guard Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T02:30:00.000Z");
    const dependencies = testDependencies({ now: () => now });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });

    try {
      const accepted = await service.accept({
        agentId,
        content: "Lifecycle transitions require complete durable evidence.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-state-guard",
      });
      await expect(
        runtimeSql`
          UPDATE public.memory_ingest_events
          SET updated_at = updated_at
          WHERE id = ${accepted.eventId}::uuid
          RETURNING id::text
        `
      ).resolves.toEqual([{ id: accepted.eventId }]);
      await expect(
        runtimeSql`
          UPDATE public.memory_ingest_events
          SET status = 'indexed',
              projected_at = ${now.toISOString()},
              projection_count = 1,
              indexed_at = ${now.toISOString()},
              indexed_build_id = 'forged-runtime-build',
              updated_at = ${now.toISOString()}
          WHERE id = ${accepted.eventId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      const claim = await worker.claim("slice3-state-guard-worker");
      expect(claim).not.toBeNull();
      const retryAt = new Date(now.getTime() + 60_000).toISOString();
      const partialFailures = [
        { code: "partial_code", message: null },
        { code: null, message: "Partial failure message" },
        { code: null, message: null },
      ] as const;
      for (const partial of partialFailures) {
        await expect(
          runtimeSql`
            UPDATE public.memory_ingest_events
            SET status = 'failed',
                next_attempt_at = ${retryAt},
                failure_code = ${partial.code},
                failure_message = ${partial.message},
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = ${now.toISOString()}
            WHERE id = ${accepted.eventId}::uuid
          `
        ).rejects.toMatchObject({ code: "23514" });
      }

      const unchanged = await ownerSql`
        SELECT status, lease_owner, lease_token::text,
               failure_code, failure_message
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(unchanged).toEqual([
        {
          status: "processing",
          lease_owner: "slice3-state-guard-worker",
          lease_token: claim!.leaseToken,
          failure_code: null,
          failure_message: null,
        },
      ]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("CA1 novelty remains diagnostic during resonance policy recomputation", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-novelty-policy', 'Slice 3 Novelty Policy Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const createdAt = "2026-08-28T00:00:00.000Z";
    const safeLog = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      await ownerSql`
        INSERT INTO public.memory_nodes (
          agent_id, content, status, priority, resonance_score,
          novelty_score, access_count, created_at, updated_at
        ) VALUES
          (
            ${agentId}, 'low novelty policy twin', 'active', 2, 0.5,
            0.0, 0, ${createdAt}, ${createdAt}
          ),
          (
            ${agentId}, 'high novelty policy twin', 'active', 2, 0.5,
            1.0, 0, ${createdAt}, ${createdAt}
          )
      `;
      await expect(
        runDreamCycle(agentId, "resonance_only")
      ).resolves.toMatchObject({ phase1_resonanceUpdated: 2 });
      const policy = await ownerSql`
        SELECT content, resonance_score
        FROM public.memory_nodes
        WHERE agent_id = ${agentId}
        ORDER BY content ASC
      `;
      expect(policy).toHaveLength(2);
      expect(Number(policy[0].resonance_score)).toBeCloseTo(
        Number(policy[1].resonance_score),
        7
      );
    } finally {
      safeLog.mockRestore();
      await ownerSql`DELETE FROM public.dream_cycle_logs WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("worker leases prevent double processing and recover after expiry", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-lease', 'Slice 3 Lease Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T02:00:00.000Z");
    const dependencies = testDependencies({
      now: () => now,
    });
    const service = createIngestService(dependencies);
    const workerA = createIngestWorker(dependencies);
    const workerB = createIngestWorker(dependencies);

    try {
      const accepted = await service.accept({
        agentId,
        content: "A lease may be recovered but never shared.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-lease-recovery",
      });
      const claims = await Promise.all([
        workerA.claim("slice3-worker-a"),
        workerB.claim("slice3-worker-b"),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const firstClaim = claims.find(Boolean)!;

      await ownerSql`
        UPDATE public.memory_ingest_events
        SET lease_expires_at = ${new Date(now.getTime() - 1).toISOString()}
        WHERE id = ${accepted.eventId}::uuid
      `;
      const recovered = await workerB.claim("slice3-worker-recovery");
      expect(recovered).toMatchObject({
        eventId: accepted.eventId,
        attempt: 2,
      });
      expect(recovered!.leaseToken).not.toBe(firstClaim.leaseToken);

      const evidence = await ownerSql`
        SELECT status, total_attempts, cycle_attempts, lease_owner
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(evidence).toEqual([
        {
          status: "processing",
          total_attempts: 2,
          cycle_attempts: 2,
          lease_owner: "slice3-worker-recovery",
        },
      ]);
    } finally {
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("worker attempt ceiling surfaces dead letter without deleting event", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-dead-letter', 'Slice 3 Dead Letter Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T03:00:00.000Z");
    const dependencies = testDependencies({
      now: () => now,
      maxAttempts: 1,
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const accepted = await service.accept({
        agentId,
        content: "Raw evidence survives a final expired lease.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-expired-at-ceiling",
      });
      await ownerSql`
        UPDATE public.memory_ingest_events
        SET status = 'processing',
            total_attempts = 1,
            cycle_attempts = 1,
            lease_owner = 'crashed-worker',
            lease_token = ${randomUUID()}::uuid,
            lease_expires_at = ${new Date(now.getTime() - 1).toISOString()}
        WHERE id = ${accepted.eventId}::uuid
      `;

      await expect(worker.claim("replacement-worker")).resolves.toBeNull();
      const evidence = await ownerSql`
        SELECT status, total_attempts, cycle_attempts, next_attempt_at,
               failure_code, raw_content,
               first_terminal_failure_at,
               first_terminal_failure_build_id,
               latest_terminal_failure_at,
               latest_terminal_failure_build_id,
               terminal_failure_transition_count
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(evidence).toEqual([
        expect.objectContaining({
          status: "failed",
          total_attempts: 1,
          cycle_attempts: 1,
          next_attempt_at: null,
          failure_code: "lease_expired",
          raw_content: "Raw evidence survives a final expired lease.",
          first_terminal_failure_build_id: "slice3-integration",
          latest_terminal_failure_build_id: "slice3-integration",
          terminal_failure_transition_count: 1,
        }),
      ]);
      expect(evidence[0].first_terminal_failure_at).not.toBeNull();
      expect(evidence[0].latest_terminal_failure_at).not.toBeNull();
    } finally {
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("lowered attempt ceiling terminalizes previously retryable failures", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-lowered-ceiling', 'Slice 3 Lowered Ceiling Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let now = new Date("2026-08-29T03:30:00.000Z");
    const safeLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const originalBuild = testDependencies({
      buildId: "slice3-max-five",
      maxAttempts: 5,
      now: () => now,
      embedTexts: async () => {
        throw new Error("private provider failure");
      },
    });
    const service = createIngestService(originalBuild);
    const originalWorker = createIngestWorker(originalBuild);

    try {
      const accepted = await service.accept({
        agentId,
        content: "A rollout must not strand this retryable event.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-lowered-attempt-ceiling",
      });
      const firstClaim = await originalWorker.claim("slice3-max-five-worker");
      expect(firstClaim).not.toBeNull();
      await expect(originalWorker.process(firstClaim!)).resolves.toMatchObject({
        status: "failed",
        failure: { retryable: true },
      });

      now = new Date("2026-08-29T03:31:00.000Z");
      const loweredBuild = testDependencies({
        buildId: "slice3-max-one",
        maxAttempts: 1,
        now: () => now,
      });
      const loweredWorker = createIngestWorker(loweredBuild);
      await expect(
        loweredWorker.claim("slice3-max-one-worker")
      ).resolves.toBeNull();

      const terminal = await ownerSql`
        SELECT status, next_attempt_at, failure_code, total_attempts,
               cycle_attempts, first_terminal_failure_build_id,
               latest_terminal_failure_build_id,
               terminal_failure_transition_count, raw_content
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(terminal).toEqual([
        {
          status: "failed",
          next_attempt_at: null,
          failure_code: "embedding_provider_unavailable",
          total_attempts: 1,
          cycle_attempts: 1,
          first_terminal_failure_build_id: "slice3-max-one",
          latest_terminal_failure_build_id: "slice3-max-one",
          terminal_failure_transition_count: 1,
          raw_content: "A rollout must not strand this retryable event.",
        },
      ]);
      await expect(
        createIngestService(loweredBuild).retryTerminalFailure(
          agentId,
          accepted.eventId
        )
      ).resolves.toMatchObject({
        eventId: accepted.eventId,
        status: "accepted",
        totalAttempts: 1,
        manualRetryCount: 1,
      });
    } finally {
      safeLog.mockRestore();
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("operator retry preserves first failure history and raw evidence", async () => {
    const providerCanary = "Bearer slice3-secret-provider-body";
    const rawCanary = "raw-memory-canary";
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-operator', 'Slice 3 Operator Agent')
      RETURNING id
    `;
    const foreignRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-operator-foreign', 'Slice 3 Operator Foreign Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const foreignAgentId = Number(foreignRows[0].id);
    let now = new Date("2026-08-29T04:00:00.000Z");
    const safeLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const buildA = testDependencies({
      buildId: "slice3-build-a",
      maxAttempts: 1,
      now: () => now,
      embedTexts: async () => {
        const error = new Error(providerCanary);
        error.name = providerCanary;
        throw error;
      },
    });
    const serviceA = createIngestService(buildA);
    const workerA = createIngestWorker(buildA);

    try {
      const accepted = await serviceA.accept({
        agentId,
        content: `The operator must preserve ${rawCanary}.`,
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-operator-retry",
      });
      const claimA = await workerA.claim("slice3-build-a-worker");
      expect(claimA).not.toBeNull();
      const failedA = await workerA.process(claimA!);
      expect(failedA).toMatchObject({
        eventId: accepted.eventId,
        status: "failed",
        failure: {
          code: "embedding_provider_unavailable",
          retryable: false,
        },
      });

      const firstFailure = await ownerSql`
        SELECT raw_content, idempotency_key, total_attempts,
               failure_code, failure_message,
               first_terminal_failure_at,
               first_terminal_failure_build_id,
               latest_terminal_failure_at,
               latest_terminal_failure_build_id,
               terminal_failure_transition_count
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(JSON.stringify(firstFailure)).not.toContain(
        "slice3-secret-provider-body"
      );
      expect(firstFailure[0]).toMatchObject({
        idempotency_key: "slice3-operator-retry",
        total_attempts: 1,
        failure_code: "embedding_provider_unavailable",
        failure_message: "Embedding provider unavailable",
        first_terminal_failure_build_id: "slice3-build-a",
        latest_terminal_failure_build_id: "slice3-build-a",
        terminal_failure_transition_count: 1,
      });
      expect(String(firstFailure[0].raw_content)).toContain("raw-memory-canary");
      const firstTerminalAt = new Date(
        firstFailure[0].first_terminal_failure_at as string | Date
      ).toISOString();

      await expect(
        serviceA.retryTerminalFailure(foreignAgentId, accepted.eventId)
      ).resolves.toBeNull();
      const concurrentRetries = await Promise.all([
        serviceA.retryTerminalFailure(agentId, accepted.eventId),
        serviceA.retryTerminalFailure(agentId, accepted.eventId),
      ]);
      expect(concurrentRetries.filter(Boolean)).toHaveLength(1);

      now = new Date("2026-08-30T04:00:00.000Z");
      const buildB = testDependencies({
        buildId: "slice3-build-b",
        maxAttempts: 1,
        now: () => now,
        embedTexts: async () => {
          const error = new Error(`${providerCanary} second failure`);
          error.name = `${providerCanary}-second-name`;
          throw error;
        },
      });
      const workerB = createIngestWorker(buildB);
      const claimB = await workerB.claim("slice3-build-b-worker");
      expect(claimB).not.toBeNull();
      await workerB.process(claimB!);

      const secondFailure = await ownerSql`
        SELECT raw_content, idempotency_key, total_attempts, cycle_attempts,
               manual_retry_count, first_terminal_failure_at,
               first_terminal_failure_build_id, latest_terminal_failure_at,
               latest_terminal_failure_build_id,
               terminal_failure_transition_count
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(secondFailure[0]).toMatchObject({
        idempotency_key: "slice3-operator-retry",
        total_attempts: 2,
        cycle_attempts: 1,
        manual_retry_count: 1,
        first_terminal_failure_build_id: "slice3-build-a",
        latest_terminal_failure_build_id: "slice3-build-b",
        terminal_failure_transition_count: 2,
      });
      expect(
        new Date(
          secondFailure[0].first_terminal_failure_at as string | Date
        ).toISOString()
      ).toBe(firstTerminalAt);
      expect(
        new Date(
          secondFailure[0].latest_terminal_failure_at as string | Date
        ).toISOString()
      ).toBe(now.toISOString());
      const secondLatestAt = new Date(
        secondFailure[0].latest_terminal_failure_at as string | Date
      ).toISOString();

      const runtimeSql = postgres(runtimeDatabaseUrl, {
        max: 1,
        onnotice: () => {},
      });
      try {
        await expect(
          runtimeSql`
            UPDATE public.memory_ingest_events
            SET first_terminal_failure_at = ${new Date(
              now.getTime() + 1_000
            ).toISOString()}
            WHERE id = ${accepted.eventId}::uuid
          `
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await runtimeSql.end({ timeout: 5 });
      }

      await expect(
        createIngestService(buildB).retryTerminalFailure(
          agentId,
          accepted.eventId
        )
      ).resolves.toMatchObject({ status: "accepted", manualRetryCount: 2 });
      now = new Date("2026-08-29T12:00:00.000Z");
      const buildC = testDependencies({
        buildId: "slice3-build-c-regressed-clock",
        maxAttempts: 1,
        now: () => now,
        embedTexts: async () => {
          throw new Error("regressed clock provider failure");
        },
      });
      const workerC = createIngestWorker(buildC);
      const claimC = await workerC.claim("slice3-build-c-worker");
      expect(claimC).not.toBeNull();
      await expect(workerC.process(claimC!)).resolves.toMatchObject({
        status: "failed",
        failure: { retryable: false },
      });
      const regressedClockEvidence = await ownerSql`
        SELECT first_terminal_failure_at,
               first_terminal_failure_build_id,
               latest_terminal_failure_at,
               latest_terminal_failure_build_id,
               terminal_failure_transition_count,
               total_attempts, manual_retry_count
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(regressedClockEvidence[0]).toMatchObject({
        first_terminal_failure_build_id: "slice3-build-a",
        latest_terminal_failure_build_id: "slice3-build-b",
        terminal_failure_transition_count: 3,
        total_attempts: 3,
        manual_retry_count: 2,
      });
      expect(
        new Date(
          regressedClockEvidence[0].first_terminal_failure_at as string | Date
        ).toISOString()
      ).toBe(firstTerminalAt);
      expect(
        new Date(
          regressedClockEvidence[0].latest_terminal_failure_at as string | Date
        ).toISOString()
      ).toBe(secondLatestAt);

      expect(JSON.stringify(safeLog.mock.calls)).not.toContain(
        "slice3-secret-provider-body"
      );
    } finally {
      safeLog.mockRestore();
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`
        DELETE FROM public.agents WHERE id IN (${agentId}, ${foreignAgentId})
      `;
    }
  });

  test("operator retry command is agent-scoped and requeues only one terminal event", async () => {
    const rawCanary = "slice3-cli-private-memory";
    const providerCanary = "slice3-cli-private-provider-response";
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-cli', 'Slice 3 CLI Agent')
      RETURNING id
    `;
    const foreignRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-cli-foreign', 'Slice 3 CLI Foreign Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const foreignAgentId = Number(foreignRows[0].id);
    const now = new Date("2026-08-29T04:30:00.000Z");
    const safeLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const dependencies = testDependencies({
      buildId: "slice3-cli-build",
      maxAttempts: 1,
      now: () => now,
      embedTexts: async () => {
        const error = new Error(providerCanary);
        error.name = providerCanary;
        throw error;
      },
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);
    const commandEnvironment = {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl,
      CORTEX_BUILD_ID: "slice3-cli-command",
      CORTEX_HEADLESS: "true",
    };

    try {
      const usage = await runRetryCommand(
        ["--agent"],
        {
          ...commandEnvironment,
          DATABASE_URL: undefined,
          DOTENV_CONFIG_PATH: "/tmp/cortex-slice3-no-env-file",
        }
      );
      expect(usage).toMatchObject({ code: 2, signal: null, stdout: "" });
      expect(usage.stderr).toContain("Usage: memory:retry-ingest");

      const accepted = await service.accept({
        agentId,
        content: `Retry ${rawCanary} without disclosing it.`,
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-cli-retry",
      });
      const claim = await worker.claim("slice3-cli-failing-worker");
      expect(claim).not.toBeNull();
      await worker.process(claim!);

      const foreign = await runRetryCommand(
        ["--agent", "slice3-cli-foreign", "--event", accepted.eventId],
        commandEnvironment
      );
      expect(foreign).toMatchObject({ code: 3, signal: null, stdout: "" });
      expect(foreign.stderr).toContain(
        "The event was not found or is not eligible for retry"
      );

      const retried = await runRetryCommand(
        ["--event", accepted.eventId, "--agent", "slice3-cli"],
        commandEnvironment
      );
      expect(retried).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(JSON.parse(retried.stdout)).toEqual({
        agent: "slice3-cli",
        eventId: accepted.eventId,
        status: "accepted",
        manualRetryCount: 1,
        totalAttempts: 1,
        acceptedAt: accepted.acceptedAt,
      });

      const noSecondRetry = await runRetryCommand(
        ["--agent", "slice3-cli", "--event", accepted.eventId],
        commandEnvironment
      );
      expect(noSecondRetry).toMatchObject({ code: 3, signal: null, stdout: "" });

      const missing = await runRetryCommand(
        ["--agent", "slice3-cli", "--event", randomUUID()],
        commandEnvironment
      );
      expect(missing).toMatchObject({ code: 3, signal: null, stdout: "" });

      const commandEvidence = JSON.stringify({ foreign, retried, noSecondRetry, missing });
      expect(commandEvidence).not.toContain(rawCanary);
      expect(commandEvidence).not.toContain(providerCanary);

      const durableEvidence = await ownerSql`
        SELECT status, raw_content, idempotency_key, total_attempts,
               cycle_attempts, manual_retry_count
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(durableEvidence).toEqual([
        {
          status: "accepted",
          raw_content: `Retry ${rawCanary} without disclosing it.`,
          idempotency_key: "slice3-cli-retry",
          total_attempts: 1,
          cycle_attempts: 0,
          manual_retry_count: 1,
        },
      ]);

      const indexingDependencies = testDependencies({
        buildId: "slice3-cli-index-build",
        maxAttempts: 1,
        now: () => new Date("2026-08-29T04:31:00.000Z"),
      });
      const indexingWorker = createIngestWorker(indexingDependencies);
      const indexingClaim = await indexingWorker.claim(
        "slice3-cli-index-worker"
      );
      expect(indexingClaim).not.toBeNull();
      await expect(indexingWorker.process(indexingClaim!)).resolves.toMatchObject({
        eventId: accepted.eventId,
        status: "indexed",
      });
      const indexedRefusal = await runRetryCommand(
        ["--agent", "slice3-cli", "--event", accepted.eventId],
        commandEnvironment
      );
      expect(indexedRefusal).toMatchObject({
        code: 3,
        signal: null,
        stdout: "",
      });

      const retryableDependencies = testDependencies({
        buildId: "slice3-cli-retryable-build",
        maxAttempts: 5,
        now: () => new Date("2026-08-29T04:32:00.000Z"),
        embedTexts: async () => {
          throw new Error(providerCanary);
        },
      });
      const retryableService = createIngestService(retryableDependencies);
      const retryableEvent = await retryableService.accept({
        agentId,
        content: "A retryable failure is not operator-terminal.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-cli-retryable-refusal",
      });
      const retryableWorker = createIngestWorker(retryableDependencies);
      const retryableClaim = await retryableWorker.claim(
        "slice3-cli-retryable-worker"
      );
      expect(retryableClaim).not.toBeNull();
      await retryableWorker.process(retryableClaim!);
      const retryableRefusal = await runRetryCommand(
        ["--agent", "slice3-cli", "--event", retryableEvent.eventId],
        commandEnvironment
      );
      expect(retryableRefusal).toMatchObject({
        code: 3,
        signal: null,
        stdout: "",
      });
      expect(
        JSON.stringify({ indexedRefusal, retryableRefusal })
      ).not.toContain(providerCanary);
    } finally {
      safeLog.mockRestore();
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`
        DELETE FROM public.agents WHERE id IN (${agentId}, ${foreignAgentId})
      `;
    }
  }, 60_000);

  test("worker that loses its lease cannot commit prepared provider output", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-stale-worker', 'Slice 3 Stale Worker Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let releaseEmbedding!: (value: EmbeddedBatch) => void;
    let markEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolvePromise) => {
      markEmbeddingStarted = resolvePromise;
    });
    const embeddingPending = new Promise<EmbeddedBatch>((resolvePromise) => {
      releaseEmbedding = resolvePromise;
    });
    const now = new Date("2026-08-29T05:00:00.000Z");
    const dependencies = testDependencies({
      now: () => now,
      embedTexts: async () => {
        markEmbeddingStarted();
        return embeddingPending;
      },
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const accepted = await service.accept({
        agentId,
        content: "Prepared output from a stale worker must be discarded.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-stale-worker",
      });
      const claim = await worker.claim("slice3-original-worker");
      expect(claim).not.toBeNull();
      const processing = worker.process(claim!);
      await embeddingStarted;

      const winnerLease = randomUUID();
      await ownerSql`
        UPDATE public.memory_ingest_events
        SET lease_owner = 'slice3-winning-worker',
            lease_token = ${winnerLease}::uuid,
            lease_expires_at = ${new Date(now.getTime() + 60_000).toISOString()}
        WHERE id = ${accepted.eventId}::uuid
      `;
      releaseEmbedding(validEmbeddingBatch(1));

      await expect(processing).rejects.toMatchObject({ name: "LeaseLostError" });
      const evidence = await ownerSql`
        SELECT status, lease_owner, lease_token::text,
               (SELECT pg_catalog.count(*)::integer
                FROM public.memory_nodes
                WHERE ingest_event_id = ${accepted.eventId}::uuid) AS nodes
        FROM public.memory_ingest_events
        WHERE id = ${accepted.eventId}::uuid
      `;
      expect(evidence).toEqual([
        {
          status: "processing",
          lease_owner: "slice3-winning-worker",
          lease_token: winnerLease,
          nodes: 0,
        },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("malformed embedding batches fail before any projection SQL", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-invalid-embeddings', 'Slice 3 Invalid Embeddings Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T05:15:00.000Z");
    const vector = (values: number[], dimensions = 1024): EmbeddedBatch => ({
      provider: "slice3-test-provider",
      model: "slice3-test-model",
      vectors: [
        {
          values,
          provider: "slice3-test-provider",
          model: "slice3-test-model",
          dimensions,
          normalized: true,
        },
      ],
    });
    const invalidCases: Array<{
      name: string;
      expectedCode: string;
      batch: EmbeddedBatch;
    }> = [
      {
        name: "count",
        expectedCode: "embedding_batch_mismatch",
        batch: {
          provider: "slice3-test-provider",
          model: "slice3-test-model",
          vectors: [],
        },
      },
      {
        name: "dimension",
        expectedCode: "embedding_dimension_invalid",
        batch: vector(UNIT_VECTOR.slice(0, 1023), 1023),
      },
      {
        name: "nan",
        expectedCode: "embedding_non_finite",
        batch: vector([1, Number.NaN, ...UNIT_VECTOR.slice(2)]),
      },
      {
        name: "infinity",
        expectedCode: "embedding_non_finite",
        batch: vector([1, Number.POSITIVE_INFINITY, ...UNIT_VECTOR.slice(2)]),
      },
      {
        name: "zero-norm",
        expectedCode: "embedding_zero_norm",
        batch: vector(Array.from({ length: 1024 }, () => 0)),
      },
      {
        name: "not-normalized",
        expectedCode: "embedding_not_normalized",
        batch: vector([2, ...UNIT_VECTOR.slice(1)]),
      },
    ];
    const enrichEntities = jest.fn(async () => ({ entities: [], warnings: [] }));
    const safeLog = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (const invalid of invalidCases) {
        const dependencies = testDependencies({
          now: () => now,
          maxAttempts: 2,
          embedTexts: async () => invalid.batch,
          enrichEntities,
        });
        const accepted = await createIngestService(dependencies).accept({
          agentId,
          content: `Reject the ${invalid.name} embedding before projection.`,
          sourceType: "api",
          requestedPriority: 2,
          idempotencyKey: `slice3-invalid-embedding-${invalid.name}`,
        });
        const worker = createIngestWorker(dependencies);
        const claim = await worker.claim(`slice3-invalid-${invalid.name}`);
        expect(claim).toMatchObject({ eventId: accepted.eventId, attempt: 1 });
        await expect(worker.process(claim!)).resolves.toMatchObject({
          eventId: accepted.eventId,
          status: "failed",
          failure: { code: invalid.expectedCode, retryable: true },
        });

        const evidence = await ownerSql`
          SELECT event.status, event.failure_code, event.next_attempt_at,
                 event.projected_at, event.projection_count,
                 (SELECT pg_catalog.count(*)::integer
                  FROM public.memory_nodes AS node
                  WHERE node.ingest_event_id = event.id) AS nodes
          FROM public.memory_ingest_events AS event
          WHERE event.id = ${accepted.eventId}::uuid
        `;
        expect(evidence).toEqual([
          {
            status: "failed",
            failure_code: invalid.expectedCode,
            next_attempt_at: expect.any(Date),
            projected_at: null,
            projection_count: 0,
            nodes: 0,
          },
        ]);
      }
      expect(enrichEntities).not.toHaveBeenCalled();
    } finally {
      safeLog.mockRestore();
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("expired graph discovery is reclaimable and stale graph output cannot commit", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-graph-lease', 'Slice 3 Graph Lease Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let now = new Date("2026-08-29T05:30:00.000Z");
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolvePromise) => {
      markDiscoveryStarted = resolvePromise;
    });
    let releaseDiscovery!: () => void;
    const discoverSynapses = jest.fn<MemoryServiceDependencies["discoverSynapses"]>(
      async (candidateAgentId, memoryIds, options) =>
        new Promise<PreparedSynapseBatch>((resolvePromise) => {
          const prepared: PreparedSynapseBatch = {
            agentId: candidateAgentId,
            newNodeIds: [...memoryIds].sort((left, right) => left - right),
            currentAt: options.currentAt!,
            candidates: [],
          };
          releaseDiscovery = () => resolvePromise(prepared);
          markDiscoveryStarted();
        })
    );
    const insertSynapses = jest
      .fn<MemoryServiceDependencies["insertSynapses"]>()
      .mockResolvedValue(0);
    const dependencies = testDependencies({
      now: () => now,
      discoverSynapses,
      insertSynapses,
    });
    const service = createIngestService(dependencies);
    const originalWorker = createIngestWorker(dependencies);
    const recoveryWorker = createIngestWorker(dependencies);

    try {
      const accepted = await service.accept({
        agentId,
        content: "A slow graph query must not hold the event lock.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-graph-lease-recovery",
      });
      const originalClaim = await originalWorker.claim("slice3-graph-original");
      expect(originalClaim).not.toBeNull();
      const originalProcessing = originalWorker.process(originalClaim!);
      await discoveryStarted;

      now = new Date(now.getTime() + 60_001);
      const recoveredClaim = await recoveryWorker.claim("slice3-graph-recovery");
      expect(recoveredClaim).toMatchObject({
        eventId: accepted.eventId,
        attempt: 2,
        leaseOwner: "slice3-graph-recovery",
        projectionAlreadyCommitted: true,
      });
      expect(recoveredClaim!.leaseToken).not.toBe(originalClaim!.leaseToken);

      releaseDiscovery();
      await expect(originalProcessing).rejects.toMatchObject({
        name: "LeaseLostError",
      });
      expect(insertSynapses).not.toHaveBeenCalled();

      const evidence = await ownerSql`
        SELECT event.status, event.lease_owner, event.lease_token::text,
               event.total_attempts, event.cycle_attempts,
               pg_catalog.count(node.id)::integer AS nodes,
               pg_catalog.count(node.id) FILTER (
                 WHERE node.status = 'pending'
               )::integer AS pending_nodes
        FROM public.memory_ingest_events AS event
        LEFT JOIN public.memory_nodes AS node
          ON node.ingest_event_id = event.id
        WHERE event.id = ${accepted.eventId}::uuid
        GROUP BY event.id
      `;
      expect(evidence).toEqual([
        {
          status: "processing",
          lease_owner: "slice3-graph-recovery",
          lease_token: recoveredClaim!.leaseToken,
          total_attempts: 2,
          cycle_attempts: 2,
          nodes: 1,
          pending_nodes: 1,
        },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("replay-safe graph formation does not duplicate edges or inflate activation", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-graph-replay', 'Slice 3 Graph Replay Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const embedding = JSON.stringify([
      0.6,
      0.8,
      ...Array.from({ length: 1022 }, () => 0),
    ]);

    try {
      const nodes = await ownerSql`
        INSERT INTO public.memory_nodes (
          agent_id, content, source, status, entities, embedding
        ) VALUES
          (
            ${agentId}, 'active graph seed', 'slice3-replay-source', 'active',
            ARRAY['slice3-replay-entity']::text[], ${embedding}::vector
          ),
          (
            ${agentId}, 'pending graph projection', 'slice3-replay-source', 'pending',
            ARRAY['slice3-replay-entity']::text[], ${embedding}::vector
          )
        RETURNING id, status
      `;
      const pendingId = Number(
        nodes.find((node) => node.status === "pending")?.id
      );
      expect(Number.isSafeInteger(pendingId)).toBe(true);
      const currentAt = "2026-08-29T05:30:00.000Z";

      await expect(
        formSynapses(agentId, [pendingId], {
          replaySafe: true,
          sql: ownerSql as unknown as Sql,
          currentAt,
        })
      ).resolves.toBe(3);
      await expect(
        formSynapses(agentId, [pendingId], {
          replaySafe: true,
          sql: ownerSql as unknown as Sql,
          currentAt,
        })
      ).resolves.toBe(0);

      const edges = await ownerSql`
        SELECT connection_type, activation_count
        FROM public.memory_synapses
        WHERE agent_id = ${agentId}
        ORDER BY connection_type ASC
      `;
      expect(edges).toEqual([
        { connection_type: "entity_shared", activation_count: 0 },
        { connection_type: "semantic", activation_count: 0 },
        { connection_type: "temporal", activation_count: 0 },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("crash after projection resumes graph phase without duplicate nodes or activation inflation", async () => {
    const embeddingServer = await startFakeEmbeddingServer();
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-crash', 'Slice 3 Crash Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const embedding = JSON.stringify([
      0.6,
      0.8,
      ...Array.from({ length: 1022 }, () => 0),
    ]);
    let crashedWorker: ManagedChild | undefined;
    let recoveryWorker: ManagedChild | undefined;
    let triggerInstalled = false;
    const runtimeEnvironment = {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl,
      CORTEX_BUILD_ID: "slice3-crash-proof",
      CORTEX_HEADLESS: "true",
      CORTEX_INGEST_WORKER_CONCURRENCY: "1",
      CORTEX_INGEST_MAX_ATTEMPTS: "5",
      CORTEX_LLM_ENTITIES: "false",
      CORTEX_CA3: "off",
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "slice3-crash-model",
      OLLAMA_URL: embeddingServer.url,
    };

    try {
      await ownerSql`
        INSERT INTO public.memory_nodes (
          agent_id, content, source, source_type, status, embedding
        ) VALUES (
          ${agentId}, 'active crash graph seed', 'slice3-crash-source',
          'api', 'active', ${embedding}::vector
        )
      `;
      const service = createIngestService(testDependencies());
      const accepted = await service.accept({
        agentId,
        content: "A committed projection must survive its worker process.",
        source: "slice3-crash-source",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-crash-after-projection",
      });

      await ownerSql.unsafe(`
        CREATE OR REPLACE FUNCTION public.slice3_pause_activation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF OLD.status = 'pending'
             AND NEW.status = 'active'
             AND NEW.agent_id = (
               SELECT id FROM public.agents
               WHERE external_id = 'slice3-crash'
             ) THEN
            PERFORM pg_catalog.pg_sleep(10);
          END IF;
          RETURN NEW;
        END;
        $function$;

        CREATE TRIGGER slice3_pause_activation
        BEFORE UPDATE OF status ON public.memory_nodes
        FOR EACH ROW
        EXECUTE FUNCTION public.slice3_pause_activation();
      `);
      triggerInstalled = true;

      crashedWorker = startChild("src/worker.ts", runtimeEnvironment);
      await waitUntil(
        async () => {
          const evidence = await ownerSql`
            SELECT event.projected_at,
                   event.status,
                   pg_catalog.count(node.id)::integer AS nodes,
                   pg_catalog.count(node.id) FILTER (
                     WHERE node.status = 'active'
                   )::integer AS active_nodes
            FROM public.memory_ingest_events AS event
            LEFT JOIN public.memory_nodes AS node
              ON node.ingest_event_id = event.id
            WHERE event.id = ${accepted.eventId}::uuid
            GROUP BY event.id
          `;
          const sleeping = await ownerSql`
            SELECT pg_catalog.count(*)::integer AS workers
            FROM pg_catalog.pg_stat_activity
            WHERE usename = 'cortex_memory_test_login'
              AND state = 'active'
              AND wait_event = 'PgSleep'
          `;
          return (
            evidence[0]?.projected_at !== null &&
            evidence[0]?.status === "processing" &&
            Number(evidence[0]?.nodes) === 1 &&
            Number(evidence[0]?.active_nodes) === 0 &&
            Number(sleeping[0]?.workers) === 1
          );
        },
        "the child worker to commit projection and pause inside finalization",
        30_000
      );

      crashedWorker.child.kill("SIGKILL");
      await once(crashedWorker.child, "exit");
      expect(crashedWorker.child.signalCode).toBe("SIGKILL");

      const rolledBack = await ownerSql`
        SELECT event.status, event.projected_at,
               pg_catalog.count(node.id)::integer AS nodes,
               pg_catalog.count(node.id) FILTER (
                 WHERE node.status = 'pending'
               )::integer AS pending_nodes
        FROM public.memory_ingest_events AS event
        LEFT JOIN public.memory_nodes AS node
          ON node.ingest_event_id = event.id
        WHERE event.id = ${accepted.eventId}::uuid
        GROUP BY event.id
      `;
      expect(rolledBack).toEqual([
        expect.objectContaining({
          status: "processing",
          projected_at: expect.any(Date),
          nodes: 1,
          pending_nodes: 1,
        }),
      ]);
      expect(embeddingServer.calls()).toBe(1);

      await ownerSql`DROP TRIGGER slice3_pause_activation ON public.memory_nodes`;
      await ownerSql`DROP FUNCTION public.slice3_pause_activation()`;
      triggerInstalled = false;
      await ownerSql`
        UPDATE public.memory_ingest_events
        SET lease_expires_at = ${new Date(Date.now() - 1_000).toISOString()}
        WHERE id = ${accepted.eventId}::uuid
      `;

      recoveryWorker = startChild("src/worker.ts", runtimeEnvironment);
      await waitUntil(
        async () => {
          const rows = await ownerSql`
            SELECT status, failure_code
            FROM public.memory_ingest_events
            WHERE id = ${accepted.eventId}::uuid
          `;
          if (rows[0]?.status === "failed") {
            throw new Error(`Recovery failed with ${String(rows[0].failure_code)}`);
          }
          return rows[0]?.status === "indexed";
        },
        "a replacement worker to finish the graph checkpoint",
        30_000
      );

      const recovered = await ownerSql`
        SELECT event.status, event.total_attempts,
               pg_catalog.count(DISTINCT node.id)::integer AS nodes,
               pg_catalog.count(DISTINCT node.id) FILTER (
                 WHERE node.status = 'active'
               )::integer AS active_nodes,
               pg_catalog.count(DISTINCT synapse.id)::integer AS synapses,
               pg_catalog.min(synapse.activation_count)::integer AS min_activation,
               pg_catalog.max(synapse.activation_count)::integer AS max_activation
        FROM public.memory_ingest_events AS event
        LEFT JOIN public.memory_nodes AS node
          ON node.ingest_event_id = event.id
        LEFT JOIN public.memory_synapses AS synapse
          ON synapse.agent_id = event.agent_id
         AND (synapse.memory_a = node.id OR synapse.memory_b = node.id)
        WHERE event.id = ${accepted.eventId}::uuid
        GROUP BY event.id
      `;
      expect(recovered).toEqual([
        {
          status: "indexed",
          total_attempts: 2,
          nodes: 1,
          active_nodes: 1,
          synapses: 2,
          min_activation: 0,
          max_activation: 0,
        },
      ]);
      expect(embeddingServer.calls()).toBe(1);
    } finally {
      await stopChild(crashedWorker);
      await stopChild(recoveryWorker);
      if (triggerInstalled) {
        await ownerSql`
          DROP TRIGGER IF EXISTS slice3_pause_activation ON public.memory_nodes
        `;
        await ownerSql`DROP FUNCTION IF EXISTS public.slice3_pause_activation()`;
      }
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
      embeddingServer.server.close();
      await once(embeddingServer.server, "close");
    }
  }, 90_000);

  test("projection checkpoint retries graph without duplicate nodes or provider calls", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice3-checkpoint', 'Slice 3 Checkpoint Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let now = new Date("2026-08-29T06:00:00.000Z");
    const embedTexts = jest.fn(async (texts: readonly string[]) =>
      validEmbeddingBatch(texts.length)
    );
    const discoverSynapses = jest
      .fn<MemoryServiceDependencies["discoverSynapses"]>()
      .mockRejectedValueOnce(new Error("graph provider private body"))
      .mockImplementationOnce(async (candidateAgentId, memoryIds, options) => ({
        agentId: candidateAgentId,
        newNodeIds: [...memoryIds].sort((left, right) => left - right),
        currentAt: options.currentAt!,
        candidates: [],
      }));
    const insertSynapses = jest
      .fn<MemoryServiceDependencies["insertSynapses"]>()
      .mockResolvedValue(2);
    const dependencies = testDependencies({
      now: () => now,
      embedTexts,
      discoverSynapses,
      insertSynapses,
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const accepted = await service.accept({
        agentId,
        content: "Projection checkpoints survive graph failure.",
        sourceType: "api",
        requestedPriority: 2,
        idempotencyKey: "slice3-checkpoint-recovery",
      });
      const firstClaim = await worker.claim("slice3-checkpoint-first");
      expect(firstClaim).not.toBeNull();
      const firstResult = await worker.process(firstClaim!);
      expect(firstResult).toMatchObject({
        status: "failed",
        failure: { code: "graph_projection_failed", retryable: true },
      });

      const pending = await ownerSql`
        SELECT event.projected_at,
               event.projection_count,
               pg_catalog.count(node.id)::integer AS nodes,
               pg_catalog.count(node.id) FILTER (
                 WHERE node.status = 'active'
               )::integer AS active_nodes
        FROM public.memory_ingest_events AS event
        LEFT JOIN public.memory_nodes AS node
          ON node.ingest_event_id = event.id
        WHERE event.id = ${accepted.eventId}::uuid
        GROUP BY event.id
      `;
      expect(pending).toEqual([
        expect.objectContaining({
          projected_at: expect.any(Date),
          projection_count: 1,
          nodes: 1,
          active_nodes: 0,
        }),
      ]);

      const pendingBeforeSearch = await ownerSql`
        SELECT id, content, access_count, last_accessed_at, last_recalled_at
        FROM public.memory_nodes
        WHERE ingest_event_id = ${accepted.eventId}::uuid
      `;
      const pendingId = Number(pendingBeforeSearch[0].id);
      const searchWhilePending = await hybridSearch({
        agentId,
        query: "Projection checkpoints survive graph failure.",
        limit: 5,
        enableCA3: true,
        queryEmbedding: [...UNIT_VECTOR],
      });
      expect(searchWhilePending.map((result) => result.id)).not.toContain(
        pendingId
      );
      const pendingAfterSearch = await ownerSql`
        SELECT id, content, access_count, last_accessed_at, last_recalled_at
        FROM public.memory_nodes
        WHERE ingest_event_id = ${accepted.eventId}::uuid
      `;
      expect(pendingAfterSearch).toEqual(pendingBeforeSearch);

      now = new Date("2026-08-29T06:02:00.000Z");
      await ownerSql`
        UPDATE public.memory_ingest_events
        SET next_attempt_at = ${new Date(now.getTime() - 1).toISOString()}
        WHERE id = ${accepted.eventId}::uuid
      `;
      const retryClaim = await worker.claim("slice3-checkpoint-retry");
      expect(retryClaim).toMatchObject({
        eventId: accepted.eventId,
        projectionAlreadyCommitted: true,
      });
      const indexed = await worker.process(retryClaim!);
      expect(indexed).toMatchObject({
        status: "indexed",
        chunksStored: 1,
        synapsesFormed: 2,
        totalAttempts: 2,
      });
      expect(embedTexts).toHaveBeenCalledTimes(1);
      expect(discoverSynapses).toHaveBeenCalledTimes(2);
      expect(discoverSynapses).toHaveBeenNthCalledWith(
        2,
        agentId,
        expect.any(Array),
        expect.objectContaining({
          sql: ownerSql,
          currentAt: expect.any(String),
        })
      );
      expect(insertSynapses).toHaveBeenCalledTimes(1);
      expect(insertSynapses).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          candidates: [],
        }),
        expect.objectContaining({
          replaySafe: true,
          sql: expect.anything(),
        })
      );

      const finalRows = await ownerSql`
        SELECT pg_catalog.count(*)::integer AS nodes,
               pg_catalog.count(*) FILTER (
                 WHERE status = 'active'
               )::integer AS active_nodes
        FROM public.memory_nodes
        WHERE ingest_event_id = ${accepted.eventId}::uuid
      `;
      expect(finalRows).toEqual([{ nodes: 1, active_nodes: 1 }]);
    } finally {
      await ownerSql`DELETE FROM public.memory_retrievals WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test(
    "one durable curl request indexes exactly once and becomes searchable",
    async () => {
      const embeddingServer = await startFakeEmbeddingServer();
      const restPort = await allocateLoopbackPort();
      const runtimeEnvironment = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(restPort),
        CORTEX_BUILD_ID: "slice2-integration",
        CORTEX_HEADLESS: "true",
        CORTEX_INGEST_WORKER_CONCURRENCY: "1",
        CORTEX_ALLOW_HIGH_PRIORITY_INGEST: "false",
        CORTEX_LLM_ENTITIES: "false",
        CORTEX_CA3: "off",
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "slice2-deterministic-1024",
        OLLAMA_URL: embeddingServer.url,
      };
      let rest: ManagedChild | undefined;
      let worker: ManagedChild | undefined;

      try {
        await ownerSql`
          INSERT INTO public.agents (external_id, name)
          VALUES ('slice2', 'Slice 2 Disposable Agent')
          ON CONFLICT (external_id) DO NOTHING
        `;
        runtimeEnvironment.DATABASE_URL = runtimeDatabaseUrl;

        rest = startChild("src/index.ts", runtimeEnvironment);
        await waitUntil(
          () => rest!.stderr().includes("application routes enabled"),
          "the REST process to enable application routes"
        );
        if (rest.child.exitCode !== null) {
          throw new Error(`REST exited early: ${rest.stderr().slice(0, 1200)}`);
        }
        expect(
          await curlJson(`http://127.0.0.1:${restPort}/readyz`)
        ).toEqual({ status: 503, body: { status: "not_ready" } });

        const content = "The quartz platypus token is QP-2048.";
        const first = await curlJson(
          `http://127.0.0.1:${restPort}/api/v1/ingest`,
          {
            method: "POST",
            body: {
              agentId: "slice2",
              content,
              sourceType: "api",
              priority: 0,
              idempotencyKey: "slice2-curl-1",
            },
          }
        );
        if (first.status !== 202) {
          throw new Error(
            `Durable acceptance returned ${first.status}: ${JSON.stringify(first.body)}; REST stderr: ${rest.stderr().slice(-4000)}`
          );
        }
        expect(first.body).toMatchObject({
          agentId: "slice2",
          status: "accepted",
          replayed: false,
          chunksStored: 0,
          nodeIds: [],
        });
        const eventId = String(first.body.eventId);

        const committedBeforeProvider = await ownerSql`
          SELECT
            (SELECT pg_catalog.count(*)::integer
             FROM public.memory_ingest_events
             WHERE id = ${eventId}::uuid) AS events,
            (SELECT pg_catalog.count(*)::integer
             FROM public.memory_nodes
             WHERE ingest_event_id = ${eventId}::uuid) AS nodes
        `;
        expect(committedBeforeProvider).toEqual([{ events: 1, nodes: 0 }]);
        expect(embeddingServer.calls()).toBe(0);

        await expect(
          ownerSql`
            INSERT INTO public.memory_nodes (
              agent_id, content, status, ingest_event_id, ingest_chunk_index
            ) VALUES (
              (SELECT id FROM public.agents WHERE external_id = 'slice2'),
              'invalid incomplete projection',
              'pending',
              ${eventId}::uuid,
              0
            )
          `
        ).rejects.toMatchObject({ code: "23514" });

        worker = startChild("src/worker.ts", runtimeEnvironment);
        await waitUntil(
          async () => {
            const ready = await curlJson(`http://127.0.0.1:${restPort}/readyz`);
            return ready.status === 200;
          },
          "a matching recent worker heartbeat"
        );

        let indexed: { status: number; body: Record<string, unknown> } | null = null;
        try {
          await waitUntil(
            async () => {
              indexed = await curlJson(
                `http://127.0.0.1:${restPort}/api/v1/ingest/${eventId}?agentId=slice2`
              );
              if (indexed.body.status === "failed") {
                throw new Error("Projection entered failed state");
              }
              return indexed.body.status === "indexed";
            },
            "the accepted event to become indexed"
          );
        } catch (error) {
          const eventDiagnostic = await ownerSql`
            SELECT status, failure_code, cycle_attempts, projected_at
            FROM public.memory_ingest_events
            WHERE id = ${eventId}::uuid
          `;
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; status=${JSON.stringify(indexed)}; event=${JSON.stringify(eventDiagnostic)}; worker stderr=${worker.stderr().slice(-5000)}`
          );
        }
        expect(indexed).not.toBeNull();
        expect(indexed!.status).toBe(200);
        expect(indexed!.body).toMatchObject({
          eventId,
          status: "indexed",
          chunksStored: 1,
          totalAttempts: 1,
          effectivePriorities: [2],
        });
        expect(embeddingServer.calls()).toBeGreaterThan(0);

        const search = await curlJson(
          `http://127.0.0.1:${restPort}/api/v1/search`,
          {
            method: "POST",
            body: {
              agentId: "slice2",
              query: "quartz platypus QP-2048",
              limit: 5,
            },
          }
        );
        if (search.status !== 200) {
          throw new Error(
            `Search failed: response=${JSON.stringify(search)}; rest stderr=${rest.stderr().slice(-5000)}`
          );
        }
        expect(search.status).toBe(200);
        expect(search.body).toMatchObject({ agentId: "slice2", resultCount: 1 });
        expect(search.body.results).toEqual([
          expect.objectContaining({ content }),
        ]);

        const replay = await curlJson(
          `http://127.0.0.1:${restPort}/api/v1/ingest`,
          {
            method: "POST",
            body: {
              agentId: "slice2",
              content,
              sourceType: "api",
              priority: 0,
              idempotencyKey: "slice2-curl-1",
            },
          }
        );
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({
          eventId,
          status: "indexed",
          replayed: true,
          chunksStored: 1,
        });

        const evidence = await ownerSql`
          SELECT
            event.status,
            event.projection_count,
            event.total_attempts,
            pg_catalog.count(DISTINCT node.id)::integer AS nodes,
            pg_catalog.count(DISTINCT provenance.id)::integer AS provenance,
            pg_catalog.count(DISTINCT code.id)::integer AS hippocampal_codes,
            pg_catalog.count(DISTINCT valence.id)::integer AS valence_rows,
            pg_catalog.max(node.embedding_provider) AS embedding_provider,
            pg_catalog.max(node.embedding_model) AS embedding_model,
            pg_catalog.max(
              pg_catalog.sqrt(-1 * (node.embedding <#> node.embedding))
            )::double precision AS embedding_norm
          FROM public.memory_ingest_events AS event
          LEFT JOIN public.memory_nodes AS node
            ON node.ingest_event_id = event.id
           AND node.status = 'active'
          LEFT JOIN public.memory_provenance AS provenance
            ON provenance.ingest_event_id = event.id
          LEFT JOIN public.hippocampal_codes AS code
            ON code.memory_id = node.id
          LEFT JOIN public.emotional_valence AS valence
            ON valence.memory_id = node.id
          WHERE event.id = ${eventId}::uuid
          GROUP BY event.id
        `;
        expect(evidence).toEqual([
          {
            status: "indexed",
            projection_count: 1,
            total_attempts: 1,
            nodes: 1,
            provenance: 1,
            hippocampal_codes: 1,
            valence_rows: 1,
            embedding_provider: "ollama",
            embedding_model: "slice2-deterministic-1024",
            embedding_norm: expect.closeTo(1, 6),
          },
        ]);

        const ready = await curlJson(`http://127.0.0.1:${restPort}/readyz`);
        expect(ready).toEqual({ status: 200, body: { status: "ok" } });
      } finally {
        await stopChild(worker);
        await stopChild(rest);
        embeddingServer.server.close();
        await once(embeddingServer.server, "close");
      }
    },
    60_000
  );

  test("concurrent exact events reuse one current projection and retain both provenances", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-exact-race', 'Slice 4 Exact Race Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T12:00:00.000Z");
    let discoveries = 0;
    let releaseDiscoveries!: () => void;
    const bothDiscoveries = new Promise<void>((resolvePromise) => {
      releaseDiscoveries = resolvePromise;
    });
    const dependencies = testDependencies({
      now: () => now,
      discoverSynapses: async (
        discoveredAgentId,
        memoryIds,
        options
      ): Promise<PreparedSynapseBatch> => {
        discoveries += 1;
        if (discoveries === 2) releaseDiscoveries();
        await bothDiscoveries;
        return {
          agentId: discoveredAgentId,
          newNodeIds: [...memoryIds].sort((left, right) => left - right),
          currentAt: options.currentAt ?? now.toISOString(),
          candidates: [],
        };
      },
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const first = await service.accept({
        agentId,
        content: "An exact projection can carry two independent source facts.",
        source: "/source/alpha.md",
        sourceVersion: "alpha-v1",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-exact-alpha",
      });
      const second = await service.accept({
        agentId,
        content: "An exact projection can carry two independent source facts.",
        source: "/source/beta.md",
        sourceVersion: "beta-v1",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-exact-beta",
      });
      const firstClaim = await worker.claim("slice4-exact-worker-a");
      const secondClaim = await worker.claim("slice4-exact-worker-b");
      expect(firstClaim).not.toBeNull();
      expect(secondClaim).not.toBeNull();

      const receipts = await Promise.all([
        worker.process(firstClaim!),
        worker.process(secondClaim!),
      ]);
      expect(receipts.map((receipt) => receipt.status)).toEqual([
        "indexed",
        "indexed",
      ]);
      expect(receipts[0].nodeIds).toHaveLength(1);
      expect(receipts[1].nodeIds).toEqual(receipts[0].nodeIds);
      expect(receipts.map((receipt) => receipt.chunksCreated).sort()).toEqual([
        0,
        1,
      ]);

      const evidence = await ownerSql`
        SELECT
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_nodes
           WHERE agent_id = ${agentId} AND status = 'active') AS active_nodes,
          (SELECT pg_catalog.count(*)::integer
           FROM public.memory_provenance
           WHERE agent_id = ${agentId}
             AND ingest_event_id IN (${first.eventId}::uuid, ${second.eventId}::uuid)) AS provenances,
          (SELECT pg_catalog.count(*)::integer
           FROM public.hippocampal_codes
           WHERE agent_id = ${agentId}) AS codes,
          (SELECT pg_catalog.count(*)::integer
           FROM public.emotional_valence
           WHERE agent_id = ${agentId}) AS valence_rows
      `;
      expect(evidence).toEqual([
        { active_nodes: 1, provenances: 2, codes: 1, valence_rows: 1 },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("replace source keeps the last good snapshot until final success and preserves shared support", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-source-safety', 'Slice 4 Source Safety Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let now = new Date("2026-08-29T13:00:00.000Z");
    let failGraph = false;
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 4,
      onnotice: () => {},
    });
    const embedTexts = jest.fn(async (texts: readonly string[]) =>
      validEmbeddingBatch(texts.length)
    );
    const dependencies = testDependencies({
      sql: runtimeSql as unknown as Sql,
      now: () => now,
      embedTexts,
      discoverSynapses: async (discoveredAgentId, memoryIds, options) => {
        if (failGraph) throw new Error("deliberate graph failure");
        return {
          agentId: discoveredAgentId,
          newNodeIds: [...memoryIds].sort((left, right) => left - right),
          currentAt: options.currentAt ?? now.toISOString(),
          candidates: [],
        };
      },
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);
    const submit = async (
      source: string,
      sourceVersion: string,
      content: string,
      key: string
    ) => {
      const accepted = await service.accept({
        agentId,
        content,
        source,
        sourceVersion,
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: key,
      });
      const claim = await worker.claim(`worker-${key}`);
      expect(claim?.eventId).toBe(accepted.eventId);
      return { accepted, receipt: await worker.process(claim!) };
    };

    try {
      const alpha1 = await submit(
        "/source/alpha.md",
        "alpha-v1",
        "The shared source projection remains current.",
        "slice4-alpha-v1"
      );
      const sharedNodeId = alpha1.receipt.nodeIds[0];
      now = new Date(now.getTime() + 1_000);
      const beta1 = await submit(
        "/source/beta.md",
        "beta-v1",
        "The shared source projection remains current.",
        "slice4-beta-v1"
      );
      expect(beta1.receipt.nodeIds).toEqual([sharedNodeId]);

      now = new Date(now.getTime() + 1_000);
      const alpha2 = await submit(
        "/source/alpha.md",
        "alpha-v2",
        "The shared source projection remains current.",
        "slice4-alpha-v2"
      );
      expect(alpha2.receipt.nodeIds).toEqual([sharedNodeId]);

      now = new Date(now.getTime() + 1_000);
      failGraph = true;
      const failedRefresh = await submit(
        "/source/alpha.md",
        "alpha-v3",
        "Alpha now has a genuinely different current fact.",
        "slice4-alpha-v3"
      );
      expect(failedRefresh.receipt).toMatchObject({
        status: "failed",
        failure: { code: "graph_projection_failed", retryable: true },
      });
      const beforeRetry = await ownerSql`
        SELECT event.status, event.snapshot_valid_until, node.status AS node_status
        FROM public.memory_ingest_events AS event
        JOIN public.memory_provenance AS provenance
          ON provenance.ingest_event_id = event.id
        JOIN public.memory_nodes AS node ON node.id = provenance.memory_id
        WHERE event.id = ${alpha2.accepted.eventId}::uuid
      `;
      expect(beforeRetry).toEqual([
        { status: "indexed", snapshot_valid_until: null, node_status: "active" },
      ]);

      failGraph = false;
      now = new Date(now.getTime() + 61_000);
      const retryClaim = await worker.claim("slice4-alpha-v3-retry");
      expect(retryClaim?.eventId).toBe(failedRefresh.accepted.eventId);
      const retried = await worker.process(retryClaim!);
      expect(retried.status).toBe("indexed");
      const retriedIndexedAt = new Date(retried.indexedAt!);
      expect(embedTexts).toHaveBeenCalledTimes(4);

      const afterRetry = await ownerSql`
        SELECT id::text, snapshot_valid_until, replaced_by_event_id::text
        FROM public.memory_ingest_events
        WHERE id IN (
          ${alpha2.accepted.eventId}::uuid,
          ${failedRefresh.accepted.eventId}::uuid
        )
        ORDER BY accepted_at, id
      `;
      expect(afterRetry).toEqual([
        {
          id: alpha2.accepted.eventId,
          snapshot_valid_until: retriedIndexedAt,
          replaced_by_event_id: failedRefresh.accepted.eventId,
        },
        {
          id: failedRefresh.accepted.eventId,
          snapshot_valid_until: null,
          replaced_by_event_id: null,
        },
      ]);
      expect(
        await ownerSql`
          SELECT status FROM public.memory_nodes WHERE id = ${sharedNodeId}
        `
      ).toEqual([{ status: "active" }]);

      now = new Date(now.getTime() + 1_000);
      const beta2 = await submit(
        "/source/beta.md",
        "beta-v2",
        "Beta now has a genuinely different current fact.",
        "slice4-beta-v2"
      );
      expect(
        await ownerSql`
          SELECT status, valid_until FROM public.memory_nodes WHERE id = ${sharedNodeId}
        `
      ).toEqual([
        {
          status: "superseded",
          valid_until: new Date(beta2.receipt.indexedAt!),
        },
      ]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("source replacement finalization survives an application clock rollback", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-clock-rollback', 'Slice 4 Clock Rollback Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const databaseClock = await ownerSql`
      SELECT pg_catalog.transaction_timestamp() AS current_at
    `;
    const databaseNow = new Date(databaseClock[0].current_at as Date);
    let applicationNow = new Date(databaseNow.getTime() - 60 * 60 * 1_000);
    const dependencies = testDependencies({ now: () => applicationNow });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const firstAccepted = await service.accept({
        agentId,
        content: "The first snapshot remains valid until a later commit.",
        source: "/source/clock-rollback.md",
        sourceVersion: "clock-v1",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-clock-v1",
      });
      const firstClaim = await worker.claim("slice4-clock-worker-v1");
      expect(firstClaim?.eventId).toBe(firstAccepted.eventId);
      const firstReceipt = await worker.process(firstClaim!);
      expect(firstReceipt.status).toBe("indexed");

      applicationNow = new Date(applicationNow.getTime() + 1_000);
      const secondAccepted = await service.accept({
        agentId,
        content: "The second snapshot wins despite the host clock rollback.",
        source: "/source/clock-rollback.md",
        sourceVersion: "clock-v2",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-clock-v2",
      });
      applicationNow = new Date(databaseNow.getTime() - 2 * 60 * 60 * 1_000);
      const secondClaim = await worker.claim("slice4-clock-worker-v2");
      expect(secondClaim?.eventId).toBe(secondAccepted.eventId);
      const secondReceipt = await worker.process(secondClaim!);

      expect(secondReceipt.status).toBe("indexed");
      expect(new Date(secondReceipt.indexedAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(firstReceipt.indexedAt!).getTime()
      );
      expect(new Date(secondReceipt.indexedAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(secondAccepted.acceptedAt).getTime()
      );
      await expect(
        ownerSql`
          SELECT snapshot_valid_until, replaced_by_event_id::text
          FROM public.memory_ingest_events
          WHERE id = ${firstAccepted.eventId}::uuid
        `
      ).resolves.toEqual([
        {
          snapshot_valid_until: new Date(secondReceipt.indexedAt!),
          replaced_by_event_id: secondAccepted.eventId,
        },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("an older source snapshot finishing late is rejected without evicting the newer indexed snapshot", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-obsolete-order', 'Slice 4 Obsolete Order Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let now = new Date("2026-08-29T14:00:00.000Z");
    const dependencies = testDependencies({ now: () => now });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const older = await service.accept({
        agentId,
        content: "This older source snapshot must never return late.",
        source: "/source/ordered.md",
        sourceVersion: "z-lexically-later",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-ordered-old",
      });
      now = new Date(now.getTime() + 1_000);
      const newer = await service.accept({
        agentId,
        content: "This newer source snapshot is the only current value.",
        source: "/source/ordered.md",
        sourceVersion: "a-lexically-earlier",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-ordered-new",
      });
      const olderClaim = await worker.claim("slice4-held-older");
      const newerClaim = await worker.claim("slice4-winning-newer");
      expect(olderClaim?.eventId).toBe(older.eventId);
      expect(newerClaim?.eventId).toBe(newer.eventId);

      const newerReceipt = await worker.process(newerClaim!);
      const olderReceipt = await worker.process(olderClaim!);
      expect(newerReceipt.status).toBe("indexed");
      expect(olderReceipt).toMatchObject({
        status: "rejected",
        failure: { code: "obsolete_source_snapshot", retryable: false },
        synapsesFormed: 0,
      });

      const evidence = await ownerSql`
        SELECT event.id::text,
               event.status,
               event.failure_code,
               node.status AS node_status
        FROM public.memory_ingest_events AS event
        LEFT JOIN public.memory_provenance AS provenance
          ON provenance.ingest_event_id = event.id
        LEFT JOIN public.memory_nodes AS node ON node.id = provenance.memory_id
        WHERE event.id IN (${older.eventId}::uuid, ${newer.eventId}::uuid)
        ORDER BY event.accepted_at, event.id
      `;
      expect(evidence).toEqual([
        {
          id: older.eventId,
          status: "rejected",
          failure_code: "obsolete_source_snapshot",
          node_status: "superseded",
        },
        {
          id: newer.eventId,
          status: "indexed",
          failure_code: null,
          node_status: "active",
        },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("exact reuse excludes forced, metadata-mismatched, foreign-agent, and legacy projections", async () => {
    const agents = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-fingerprint-a', 'Slice 4 Fingerprint A'),
             ('slice4-fingerprint-b', 'Slice 4 Fingerprint B')
      RETURNING id
    `;
    const agentId = Number(agents[0].id);
    const foreignAgentId = Number(agents[1].id);
    const now = new Date("2026-08-29T15:00:00.000Z");
    const dependencies = testDependencies({ now: () => now });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);
    const capture = async (
      input: Omit<Parameters<typeof service.accept>[0], "sourceType"> & {
        sourceType?: string;
      },
      selectedWorker = worker
    ) => {
      const accepted = await service.accept({ sourceType: "manual", ...input });
      const claim = await selectedWorker.claim(
        `slice4-fingerprint-${accepted.eventId}`
      );
      expect(claim?.eventId).toBe(accepted.eventId);
      return selectedWorker.process(claim!);
    };
    const projectionVersionWorker = createIngestWorker({
      ...dependencies,
      config: {
        ...dependencies.config,
        projectionVersion: "slice4-distinct-projection-version",
      },
    });
    const embeddingWorker = (provider: string, model: string) =>
      createIngestWorker({
        ...dependencies,
        embedTexts: async (texts) => ({
          provider,
          model,
          vectors: texts.map(() => ({
            values: [...UNIT_VECTOR],
            provider,
            model,
            dimensions: 1024,
            normalized: true as const,
          })),
        }),
      });

    try {
      const base = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        idempotencyKey: "slice4-fingerprint-base",
      });
      const exact = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        idempotencyKey: "slice4-fingerprint-exact",
      });
      const forced = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        forceNewProjection: true,
        idempotencyKey: "slice4-fingerprint-forced",
      });
      const differentPriority = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 2,
        idempotencyKey: "slice4-fingerprint-priority",
      });
      const differentValidity = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        validFrom: "2026-08-29T15:00:01.000Z",
        idempotencyKey: "slice4-fingerprint-validity",
      });
      const differentEntities = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        providedEntities: ["Distinct projection entity"],
        idempotencyKey: "slice4-fingerprint-entities",
      });
      const differentTags = await capture({
        agentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        providedSemanticTags: ["distinct-projection-tag"],
        idempotencyKey: "slice4-fingerprint-tags",
      });
      const differentProjectionVersion = await capture(
        {
          agentId,
          content: "Fingerprint identity is stricter than content identity.",
          requestedPriority: 1,
          idempotencyKey: "slice4-fingerprint-projection-version",
        },
        projectionVersionWorker
      );
      const differentEmbeddingProvider = await capture(
        {
          agentId,
          content: "Fingerprint identity is stricter than content identity.",
          requestedPriority: 1,
          idempotencyKey: "slice4-fingerprint-embedding-provider",
        },
        embeddingWorker("slice4-other-provider", "slice3-test-model")
      );
      const differentEmbeddingModel = await capture(
        {
          agentId,
          content: "Fingerprint identity is stricter than content identity.",
          requestedPriority: 1,
          idempotencyKey: "slice4-fingerprint-embedding-model",
        },
        embeddingWorker("slice3-test-provider", "slice4-other-model")
      );
      const foreign = await capture({
        agentId: foreignAgentId,
        content: "Fingerprint identity is stricter than content identity.",
        requestedPriority: 1,
        idempotencyKey: "slice4-fingerprint-foreign",
      });

      expect(exact.nodeIds).toEqual(base.nodeIds);
      expect(forced.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentPriority.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentValidity.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentEntities.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentTags.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentProjectionVersion.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentEmbeddingProvider.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(differentEmbeddingModel.nodeIds[0]).not.toBe(base.nodeIds[0]);
      expect(foreign.nodeIds[0]).not.toBe(base.nodeIds[0]);

      const legacy = await ownerSql`
        INSERT INTO public.memory_nodes (
          agent_id, content, source, source_type, priority, status
        ) VALUES (
          ${agentId},
          'Legacy identity must remain unknown.',
          '/source/legacy.md',
          'manual',
          1,
          'active'
        )
        RETURNING id
      `;
      const managedLegacyTwin = await capture({
        agentId,
        content: "Legacy identity must remain unknown.",
        source: "/source/legacy.md",
        requestedPriority: 1,
        idempotencyKey: "slice4-fingerprint-legacy",
      });
      expect(managedLegacyTwin.nodeIds[0]).not.toBe(Number(legacy[0].id));
    } finally {
      await ownerSql`
        DELETE FROM public.memory_nodes
        WHERE agent_id IN (${agentId}, ${foreignAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_ingest_events
        WHERE agent_id IN (${agentId}, ${foreignAgentId})
      `;
      await ownerSql`
        DELETE FROM public.agents WHERE id IN (${agentId}, ${foreignAgentId})
      `;
    }
  }, 30_000);

  test("the first managed source refresh retires legacy rows only after its final commit", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-legacy-refresh', 'Slice 4 Legacy Refresh Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const legacyRows = await ownerSql`
      INSERT INTO public.memory_nodes (
        agent_id, content, source, source_type, priority, status
      ) VALUES (
        ${agentId},
        'Legacy content remains current through a failed first refresh.',
        '/source/legacy-refresh.md',
        'markdown',
        1,
        'active'
      )
      RETURNING id
    `;
    const legacyId = Number(legacyRows[0].id);
    let now = new Date("2026-08-29T15:30:00.000Z");
    let failGraph = true;
    const dependencies = testDependencies({
      now: () => now,
      discoverSynapses: async (discoveredAgentId, memoryIds, options) => {
        if (failGraph) throw new Error("deliberate first-refresh graph failure");
        return {
          agentId: discoveredAgentId,
          newNodeIds: [...memoryIds].sort((left, right) => left - right),
          currentAt: options.currentAt ?? now.toISOString(),
          candidates: [],
        };
      },
    });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);

    try {
      const accepted = await service.accept({
        agentId,
        content: "The first lifecycle-managed source snapshot is ready.",
        source: "/source/legacy-refresh.md",
        sourceVersion: "legacy-refresh-v1",
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: "slice4-legacy-refresh-v1",
      });
      const firstClaim = await worker.claim("slice4-legacy-refresh-failed");
      expect(firstClaim?.eventId).toBe(accepted.eventId);
      await expect(worker.process(firstClaim!)).resolves.toMatchObject({
        status: "failed",
        failure: { code: "graph_projection_failed", retryable: true },
      });
      await expect(
        ownerSql`
          SELECT status, valid_until
          FROM public.memory_nodes
          WHERE id = ${legacyId}
        `
      ).resolves.toEqual([{ status: "active", valid_until: null }]);

      failGraph = false;
      now = new Date(now.getTime() + 61_000);
      const retryClaim = await worker.claim("slice4-legacy-refresh-success");
      expect(retryClaim?.eventId).toBe(accepted.eventId);
      const indexed = await worker.process(retryClaim!);
      expect(indexed.status).toBe("indexed");
      await expect(
        ownerSql`
          SELECT id, status, valid_until
          FROM public.memory_nodes
          WHERE agent_id = ${agentId}
          ORDER BY id
        `
      ).resolves.toEqual([
        {
          id: legacyId,
          status: "superseded",
          valid_until: new Date(indexed.indexedAt!),
        },
        {
          id: indexed.nodeIds[0],
          status: "active",
          valid_until: null,
        },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("restoring older byte-identical content creates a fresh current projection", async () => {
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('slice4-restored-file', 'Slice 4 Restored File Agent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    let now = new Date("2026-08-29T16:00:00.000Z");
    const dependencies = testDependencies({ now: () => now });
    const service = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);
    const capture = async (content: string, version: string) => {
      const accepted = await service.accept({
        agentId,
        content,
        source: "/source/restored.md",
        sourceVersion: version,
        sourceType: "markdown",
        requestedPriority: 1,
        projectionMode: "replace_source",
        idempotencyKey: `slice4-restored-${version}`,
      });
      const claim = await worker.claim(`slice4-restored-${version}`);
      expect(claim?.eventId).toBe(accepted.eventId);
      return { accepted, receipt: await worker.process(claim!) };
    };

    try {
      const firstA = await capture("Restored body A.", "file-v1:first-a");
      now = new Date(now.getTime() + 1_000);
      await capture("Intermediate body B.", "file-v1:body-b");
      now = new Date(now.getTime() + 1_000);
      const restoredA = await capture("Restored body A.", "file-v1:restored-a");

      expect(restoredA.accepted.eventId).not.toBe(firstA.accepted.eventId);
      expect(restoredA.receipt.nodeIds[0]).not.toBe(firstA.receipt.nodeIds[0]);
      const nodes = await ownerSql`
        SELECT id, status
        FROM public.memory_nodes
        WHERE agent_id = ${agentId}
        ORDER BY id
      `;
      expect(nodes).toEqual([
        { id: firstA.receipt.nodeIds[0], status: "superseded" },
        expect.objectContaining({ status: "superseded" }),
        { id: restoredA.receipt.nodeIds[0], status: "active" },
      ]);
    } finally {
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.memory_ingest_events WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("working-memory migration fixes the durable shape and exposes only narrow runtime DML", async () => {
    const suffix = randomUUID().slice(0, 8);
    const externalId = `slice7-working-schema-${suffix}`;
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${externalId}, 'Slice 7 Working Schema')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 1,
      onnotice: () => {},
    });
    const itemId = randomUUID();
    const now = new Date("2026-08-29T17:00:00.000Z");
    const updatedAt = new Date(now.getTime() + 1_000);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

    try {
      const shape = await ownerSql`
        SELECT
          (
            SELECT pg_catalog.array_agg(column_name::text ORDER BY ordinal_position)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'working_memory_items'
          ) AS columns,
          (
            SELECT pg_catalog.array_agg(constraint_name::text ORDER BY constraint_name)
            FROM information_schema.table_constraints
            WHERE table_schema = 'public'
              AND table_name = 'working_memory_items'
          ) AS constraints,
          (
            SELECT pg_catalog.array_agg(indexname::text ORDER BY indexname)
            FROM pg_catalog.pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'working_memory_items'
          ) AS indexes,
          EXISTS (
            SELECT 1
            FROM pg_catalog.pg_trigger AS trigger
            WHERE trigger.tgrelid = 'public.working_memory_items'::regclass
              AND trigger.tgname = 'working_memory_items_history_guard'
              AND NOT trigger.tgisinternal
              AND trigger.tgenabled = 'O'
          ) AS history_trigger_enabled
      `;
      expect(shape).toHaveLength(1);
      expect(shape[0].columns).toEqual([
        "id",
        "agent_id",
        "caller_key",
        "kind",
        "content",
        "source_memory_id",
        "source_event_id",
        "status",
        "display_order",
        "importance",
        "last_confirmed_at",
        "expires_at",
        "resolved_at",
        "resolution_reason",
        "created_at",
        "updated_at",
      ]);
      expect(shape[0].constraints).toEqual(
        expect.arrayContaining([
          "working_memory_items_pkey",
          "working_memory_items_id_agent_key",
          "working_memory_items_agent_caller_key",
          "working_memory_items_agent_id_fkey",
          "working_memory_items_source_memory_fkey",
          "working_memory_items_source_event_fkey",
          "working_memory_items_correction_source_check",
          "working_memory_items_time_check",
          "working_memory_items_resolution_check",
        ])
      );
      expect(shape[0].indexes).toEqual(
        expect.arrayContaining([
          "working_memory_items_active_idx",
          "working_memory_items_source_memory_idx",
          "working_memory_items_source_event_idx",
        ])
      );
      expect(shape[0].history_trigger_enabled).toBe(true);

      const privileges = await ownerSql`
        SELECT
          pg_catalog.has_table_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'SELECT, INSERT'
          ) AS runtime_can_read_insert,
          pg_catalog.has_table_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'UPDATE'
          ) AS runtime_has_broad_update,
          pg_catalog.has_table_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'DELETE'
          ) AS runtime_can_delete,
          pg_catalog.has_column_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'content',
            'UPDATE'
          ) AS runtime_can_update_content,
          pg_catalog.has_column_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'status',
            'UPDATE'
          ) AS runtime_can_update_status,
          pg_catalog.has_column_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'id',
            'UPDATE'
          ) AS runtime_can_update_id,
          pg_catalog.has_column_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'agent_id',
            'UPDATE'
          ) AS runtime_can_update_agent,
          pg_catalog.has_column_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'caller_key',
            'UPDATE'
          ) AS runtime_can_update_caller_key,
          pg_catalog.has_column_privilege(
            'cortex_memory_runtime',
            'public.working_memory_items',
            'created_at',
            'UPDATE'
          ) AS runtime_can_update_created_at,
          pg_catalog.has_table_privilege(
            'cortex_oauth_runtime',
            'public.working_memory_items',
            'SELECT'
          ) AS oauth_runtime_can_read,
          pg_catalog.has_table_privilege(
            'cortex_oauth_operator',
            'public.working_memory_items',
            'SELECT'
          ) AS oauth_operator_can_read,
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS relation
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                relation.relacl,
                pg_catalog.acldefault('r', relation.relowner)
              )
            ) AS privilege
            WHERE relation.oid = 'public.working_memory_items'::regclass
              AND privilege.grantee = 0
              AND privilege.privilege_type IN (
                'SELECT', 'INSERT', 'UPDATE', 'DELETE'
              )
          ) AS public_dml_denied,
          pg_catalog.has_function_privilege(
            'cortex_memory_runtime',
            'public.enforce_working_memory_item_history()',
            'EXECUTE'
          ) AS runtime_can_call_history_trigger
      `;
      expect(privileges).toEqual([{
        runtime_can_read_insert: true,
        runtime_has_broad_update: false,
        runtime_can_delete: false,
        runtime_can_update_content: true,
        runtime_can_update_status: true,
        runtime_can_update_id: false,
        runtime_can_update_agent: false,
        runtime_can_update_caller_key: false,
        runtime_can_update_created_at: false,
        oauth_runtime_can_read: false,
        oauth_operator_can_read: false,
        public_dml_denied: true,
        runtime_can_call_history_trigger: false,
      }]);

      await runtimeSql`
        INSERT INTO public.working_memory_items (
          id,
          agent_id,
          caller_key,
          kind,
          content,
          status,
          display_order,
          importance,
          last_confirmed_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (
          ${itemId}::uuid,
          ${agentId},
          ${`slice7-schema:${suffix}`},
          'current_task',
          'Initial runtime-owned working item',
          'active',
          0,
          0.5,
          ${now.toISOString()}::timestamptz,
          ${expiresAt.toISOString()}::timestamptz,
          ${now.toISOString()}::timestamptz,
          ${now.toISOString()}::timestamptz
        )
      `;
      await runtimeSql`
        UPDATE public.working_memory_items
        SET content = 'Runtime may update mutable working content',
            updated_at = ${updatedAt.toISOString()}::timestamptz
        WHERE id = ${itemId}::uuid
          AND agent_id = ${agentId}
      `;
      await expect(
        runtimeSql`
          DELETE FROM public.working_memory_items
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtimeSql`
          UPDATE public.working_memory_items
          SET caller_key = caller_key
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        ownerSql`
          UPDATE public.working_memory_items
          SET caller_key = ${`slice7-rewritten:${suffix}`},
              updated_at = ${updatedAt.toISOString()}::timestamptz
          WHERE id = ${itemId}::uuid
        `
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        ownerSql`
          INSERT INTO public.working_memory_items (
            id, agent_id, caller_key, kind, content, status,
            last_confirmed_at, expires_at, created_at, updated_at
          ) VALUES (
            ${randomUUID()}::uuid,
            ${agentId},
            ${`slice7-source-less-correction:${suffix}`},
            'correction',
            'A correction without durable support must fail',
            'active',
            ${now.toISOString()}::timestamptz,
            ${expiresAt.toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        ownerSql`
          INSERT INTO public.working_memory_items (
            id, agent_id, caller_key, kind, content, status,
            last_confirmed_at, expires_at, created_at, updated_at
          ) VALUES (
            ${randomUUID()}::uuid,
            ${agentId},
            ${`slice7-overlong-expiry:${suffix}`},
            'open_loop',
            'A working item cannot live beyond the retention bound',
            'active',
            ${now.toISOString()}::timestamptz,
            ${new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000 + 1).toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`
        DELETE FROM public.working_memory_items WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  });

  test("working-set lifecycle enforces bounds, source ownership, and correction-last eviction", async () => {
    const suffix = randomUUID().slice(0, 8);
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES
        (${`slice7-working-left-${suffix}`}, 'Slice 7 Working Left'),
        (${`slice7-working-right-${suffix}`}, 'Slice 7 Working Right')
      RETURNING id
    `;
    const leftAgentId = Number(agentRows[0].id);
    const rightAgentId = Number(agentRows[1].id);
    let now = new Date("2026-08-29T18:00:00.000Z");
    const dependencies = testDependencies({ now: () => now });
    const ingest = createIngestService(dependencies);
    const worker = createIngestWorker(dependencies);
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 3,
      onnotice: () => {},
    });
    const workingSet = createWorkingSetService({
      ...dependencies,
      sql: runtimeSql as unknown as Sql,
    });

    try {
      const accepted = await ingest.accept({
        agentId: leftAgentId,
        content: `Durable correction source ${suffix}`,
        source: `/slice7/working-source-${suffix}.md`,
        sourceVersion: "v1",
        sourceType: "markdown",
        requestedPriority: 2,
        projectionMode: "replace_source",
        idempotencyKey: `slice7-working-source-${suffix}`,
      });
      const claim = await worker.claim(`slice7-working-worker-${suffix}`);
      expect(claim?.eventId).toBe(accepted.eventId);
      const indexed = await worker.process(claim!);
      expect(indexed.status).toBe("indexed");
      expect(indexed.nodeIds).toHaveLength(1);
      const sourceMemoryId = indexed.nodeIds[0];

      const correction = await workingSet.upsert({
        agentId: leftAgentId,
        callerKey: `slice7-protected-correction:${suffix}`,
        kind: "correction",
        content: "Keep the durable correction ahead of ordinary tasks.",
        importance: 0,
        sourceMemoryId,
      });
      const lowTask = await workingSet.upsert({
        agentId: leftAgentId,
        callerKey: `slice7-low-task:${suffix}`,
        kind: "current_task",
        content: "This low-importance task should be evicted first.",
        importance: 0.01,
      });
      const retainedTasks: WorkingItem[] = [];
      for (let index = 0; index < 10; index += 1) {
        retainedTasks.push(await workingSet.upsert({
          agentId: leftAgentId,
          callerKey: `slice7-retained-task-${index}:${suffix}`,
          kind: "open_loop",
          content: `Retained working task ${index}`,
          importance: 0.8,
          displayOrder: index,
        }));
      }

      now = new Date(now.getTime() + 1_000);
      const newestTask = await workingSet.upsert({
        agentId: leftAgentId,
        callerKey: `slice7-newest-task:${suffix}`,
        kind: "constraint",
        content: "The thirteenth item must retain the active-set bound.",
        importance: 0.7,
      });
      const bounded = await workingSet.list(leftAgentId);
      expect(bounded).toHaveLength(12);
      expect(bounded.map((item) => item.id)).toContain(correction.id);
      expect(bounded.map((item) => item.id)).toContain(newestTask.id);
      expect(bounded.map((item) => item.id)).not.toContain(lowTask.id);
      await expect(
        ownerSql`
          SELECT status, resolution_reason
          FROM public.working_memory_items
          WHERE id = ${lowTask.id}::uuid
        `
      ).resolves.toEqual([{
        status: "expired",
        resolution_reason: "active_bound_eviction",
      }]);

      await expect(workingSet.list(rightAgentId)).resolves.toEqual([]);
      await expect(
        workingSet.resolve(rightAgentId, correction.id, "cross-agent resolution")
      ).resolves.toBeNull();
      await expect(
        workingSet.upsert({
          agentId: rightAgentId,
          callerKey: `slice7-cross-agent-source:${suffix}`,
          kind: "correction",
          content: "A foreign durable source must not cross the agent boundary.",
          sourceMemoryId,
        })
      ).rejects.toMatchObject({ code: "source_memory_not_current" });
      await expect(
        ownerSql`
          INSERT INTO public.working_memory_items (
            id, agent_id, caller_key, kind, content, source_memory_id,
            status, last_confirmed_at, expires_at, created_at, updated_at
          ) VALUES (
            ${randomUUID()}::uuid,
            ${rightAgentId},
            ${`slice7-cross-agent-fk:${suffix}`},
            'correction',
            'Composite ownership is enforced in PostgreSQL too.',
            ${sourceMemoryId},
            'active',
            ${now.toISOString()}::timestamptz,
            ${new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz,
            ${now.toISOString()}::timestamptz
          )
        `
      ).rejects.toMatchObject({ code: "23503" });

      now = new Date(now.getTime() + 1_000);
      const reconfirmed = await workingSet.reconfirm(
        leftAgentId,
        retainedTasks[0].id,
        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString()
      );
      expect(reconfirmed).toMatchObject({
        id: retainedTasks[0].id,
        status: "active",
        lastConfirmedAt: now.toISOString(),
      });
      const resolved = await workingSet.resolve(
        leftAgentId,
        newestTask.id,
        "completed by integration proof"
      );
      expect(resolved).toMatchObject({ status: "resolved" });
      await expect(
        workingSet.resolve(
          leftAgentId,
          newestTask.id,
          "completed by integration proof"
        )
      ).resolves.toMatchObject({ status: "resolved" });
      const expired = await workingSet.expire(
        leftAgentId,
        retainedTasks[1].id,
        "explicit integration expiry"
      );
      expect(expired).toMatchObject({ status: "expired" });

      now = new Date(now.getTime() + 1_000);
      const shortLived = await workingSet.upsert({
        agentId: leftAgentId,
        callerKey: `slice7-short-lived:${suffix}`,
        kind: "open_loop",
        content: "This item expires on the next working-set read.",
        expiresAt: new Date(now.getTime() + 1_000).toISOString(),
      });
      now = new Date(now.getTime() + 2_000);
      const afterExpiry = await workingSet.list(leftAgentId);
      expect(afterExpiry.map((item) => item.id)).not.toContain(shortLived.id);
      expect(afterExpiry.map((item) => item.id)).not.toContain(newestTask.id);
      expect(afterExpiry.map((item) => item.id)).not.toContain(retainedTasks[1].id);
      await expect(
        ownerSql`
          SELECT status, resolution_reason
          FROM public.working_memory_items
          WHERE id = ${shortLived.id}::uuid
        `
      ).resolves.toEqual([{
        status: "expired",
        resolution_reason: "expired_by_time",
      }]);

      for (const item of afterExpiry) {
        now = new Date(now.getTime() + 1);
        await workingSet.resolve(leftAgentId, item.id, "reset before correction bound proof");
      }
      const correctionIds: string[] = [];
      for (let index = 0; index < 13; index += 1) {
        now = new Date(now.getTime() + 1_000);
        const item = await workingSet.upsert({
          agentId: leftAgentId,
          callerKey: `slice7-correction-${index}:${suffix}`,
          kind: "correction",
          content: `Durable correction reminder ${index}`,
          sourceMemoryId,
          importance: 0,
        });
        correctionIds.push(item.id);
      }
      const activeCorrections = await workingSet.list(leftAgentId);
      expect(activeCorrections).toHaveLength(12);
      expect(activeCorrections.every((item) => item.kind === "correction")).toBe(true);
      expect(activeCorrections.map((item) => item.id)).not.toContain(correctionIds[0]);
      expect(activeCorrections.map((item) => item.id)).toContain(correctionIds[12]);
      await expect(
        ownerSql`
          SELECT status, resolution_reason
          FROM public.working_memory_items
          WHERE id = ${correctionIds[0]}::uuid
        `
      ).resolves.toEqual([{
        status: "expired",
        resolution_reason: "active_bound_eviction",
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`
        DELETE FROM public.memory_retrievals
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.working_memory_items
        WHERE agent_id IN (${leftAgentId}, ${rightAgentId})
      `;
      await ownerSql`
        DELETE FROM public.memory_nodes WHERE agent_id = ${leftAgentId}
      `;
      await ownerSql`
        DELETE FROM public.memory_ingest_events WHERE agent_id = ${leftAgentId}
      `;
      await ownerSql`
        DELETE FROM public.agents WHERE id IN (${leftAgentId}, ${rightAgentId})
      `;
    }
  }, 45_000);

  test("concurrent working-set upserts serialize the active bound and caller identity", async () => {
    const suffix = randomUUID().slice(0, 8);
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${`slice7-working-concurrent-${suffix}`}, 'Slice 7 Working Concurrent')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const now = new Date("2026-08-29T19:00:00.000Z");
    const leftSql = postgres(runtimeDatabaseUrl, { max: 3, onnotice: () => {} });
    const rightSql = postgres(runtimeDatabaseUrl, { max: 3, onnotice: () => {} });
    const baseDependencies = testDependencies({ now: () => now });
    const leftService = createWorkingSetService({
      ...baseDependencies,
      sql: leftSql as unknown as Sql,
    });
    const rightService = createWorkingSetService({
      ...baseDependencies,
      sql: rightSql as unknown as Sql,
    });

    try {
      await expect(
        Promise.all(
          Array.from({ length: 13 }, (_, index) =>
            (index % 2 === 0 ? leftService : rightService).upsert({
              agentId,
              callerKey: `slice7-concurrent-${index}:${suffix}`,
              kind: "current_task",
              content: `Concurrent working item ${index}`,
              importance: index / 12,
            })
          )
        )
      ).resolves.toHaveLength(13);

      const bounded = await ownerSql`
        SELECT caller_key, status, resolution_reason
        FROM public.working_memory_items
        WHERE agent_id = ${agentId}
        ORDER BY caller_key
      `;
      expect(bounded).toHaveLength(13);
      expect(bounded.filter((item) => item.status === "active")).toHaveLength(12);
      expect(bounded.filter((item) => item.status === "expired")).toEqual([
        {
          caller_key: `slice7-concurrent-0:${suffix}`,
          status: "expired",
          resolution_reason: "active_bound_eviction",
        },
      ]);

      await expect(
        Promise.all([
          leftService.upsert({
            agentId,
            callerKey: `slice7-shared-caller:${suffix}`,
            kind: "open_loop",
            content: "Concurrent shared caller from the left service",
            importance: 1,
          }),
          rightService.upsert({
            agentId,
            callerKey: `slice7-shared-caller:${suffix}`,
            kind: "constraint",
            content: "Concurrent shared caller from the right service",
            importance: 1,
          }),
        ])
      ).resolves.toHaveLength(2);
      const sharedEvidence = await ownerSql`
        SELECT
          pg_catalog.count(*)::integer AS rows,
          pg_catalog.count(*) FILTER (WHERE status = 'active')::integer AS active_rows,
          pg_catalog.count(*) FILTER (WHERE status = 'active' AND expires_at > ${now.toISOString()}::timestamptz)::integer
            AS total_active_rows
        FROM public.working_memory_items
        WHERE agent_id = ${agentId}
          AND (
            caller_key = ${`slice7-shared-caller:${suffix}`}
            OR status = 'active'
          )
      `;
      expect(sharedEvidence).toEqual([{
        rows: 12,
        active_rows: 12,
        total_active_rows: 12,
      }]);
      await expect(
        ownerSql`
          SELECT pg_catalog.count(*)::integer AS rows
          FROM public.working_memory_items
          WHERE agent_id = ${agentId}
            AND caller_key = ${`slice7-shared-caller:${suffix}`}
        `
      ).resolves.toEqual([{ rows: 1 }]);
    } finally {
      await Promise.all([
        leftSql.end({ timeout: 5 }),
        rightSql.end({ timeout: 5 }),
      ]);
      await ownerSql`
        DELETE FROM public.working_memory_items WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);

  test("retrieval persists and delivers mixed durable and working evidence without mutating working state", async () => {
    const suffix = randomUUID().slice(0, 8);
    const agentRows = await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES (${`slice7-mixed-retrieval-${suffix}`}, 'Slice 7 Mixed Retrieval')
      RETURNING id
    `;
    const agentId = Number(agentRows[0].id);
    const content = `slice7 mixed durable evidence ${suffix}`;
    const memoryRows = await ownerSql`
      INSERT INTO public.memory_nodes (agent_id, content, priority)
      VALUES (${agentId}, ${content}, 2)
      RETURNING id
    `;
    const memoryId = Number(memoryRows[0].id);
    const now = new Date("2026-08-29T20:00:00.000Z");
    const runtimeSql = postgres(runtimeDatabaseUrl, {
      max: 3,
      onnotice: () => {},
    });
    const dependencies = testDependencies({
      now: () => now,
      embedQuery: async () => validEmbeddingBatch(1).vectors[0],
      patternComplete: async () => [],
    });
    const workingSet = createWorkingSetService({
      ...dependencies,
      sql: runtimeSql as unknown as Sql,
    });
    const retrieval = createRetrievalService({
      ...dependencies,
      sql: runtimeSql as unknown as Sql,
    });

    try {
      const workingItem = await workingSet.upsert({
        agentId,
        callerKey: `slice7-mixed-working:${suffix}`,
        kind: "current_task",
        content: `Current working evidence ${suffix}`,
        importance: 0.9,
      });
      const beforeWorking = await ownerSql`
        SELECT
          status,
          last_confirmed_at,
          expires_at,
          resolved_at,
          resolution_reason,
          updated_at
        FROM public.working_memory_items
        WHERE id = ${workingItem.id}::uuid
          AND agent_id = ${agentId}
      `;

      const prepared = await retrieval.prepare({
        agentId,
        query: content,
        channel: "search",
        requestId: `slice7-mixed-${suffix}`,
        limit: 2,
      });
      expect(prepared.candidates).toHaveLength(2);
      expect(prepared.candidates.map((item) => item.kind).sort()).toEqual([
        "memory",
        "working_item",
      ]);
      const delivered = await retrieval.deliver(prepared, prepared.candidates);
      expect(delivered).toMatchObject({
        retrievalId: prepared.retrievalId,
        candidateCount: 2,
        returnedCount: 2,
      });
      expect(delivered.results.map((item) => item.kind).sort()).toEqual([
        "memory",
        "working_item",
      ]);

      const persisted = await ownerSql`
        SELECT
          retrieval.status,
          retrieval.candidate_count,
          retrieval.returned_count,
          item.memory_id,
          item.working_item_id::text AS working_item_id,
          item.candidate_lanes,
          item.returned_at IS NOT NULL AS was_returned
        FROM public.memory_retrievals AS retrieval
        JOIN public.memory_retrieval_items AS item
          ON item.retrieval_id = retrieval.id
         AND item.agent_id = retrieval.agent_id
        WHERE retrieval.id = ${prepared.retrievalId}::uuid
        ORDER BY item.final_rank
      `;
      expect(persisted).toHaveLength(2);
      expect(persisted.every((item) =>
        item.status === "completed" &&
        item.candidate_count === 2 &&
        item.returned_count === 2 &&
        item.was_returned === true
      )).toBe(true);
      expect(persisted).toEqual(expect.arrayContaining([
        expect.objectContaining({
          memory_id: memoryId,
          working_item_id: null,
        }),
        expect.objectContaining({
          memory_id: null,
          working_item_id: workingItem.id,
          candidate_lanes: ["working"],
        }),
      ]));

      const afterWorking = await ownerSql`
        SELECT
          status,
          last_confirmed_at,
          expires_at,
          resolved_at,
          resolution_reason,
          updated_at
        FROM public.working_memory_items
        WHERE id = ${workingItem.id}::uuid
          AND agent_id = ${agentId}
      `;
      expect(afterWorking).toEqual(beforeWorking);
      await expect(
        ownerSql`
          SELECT
            access_count,
            last_accessed_at,
            last_recalled_at IS NOT NULL AS recalled
          FROM public.memory_nodes
          WHERE id = ${memoryId}
            AND agent_id = ${agentId}
        `
      ).resolves.toEqual([{
        access_count: 0,
        last_accessed_at: null,
        recalled: true,
      }]);
    } finally {
      await runtimeSql.end({ timeout: 5 });
      await ownerSql`DELETE FROM public.memory_retrievals WHERE agent_id = ${agentId}`;
      await ownerSql`
        DELETE FROM public.working_memory_items WHERE agent_id = ${agentId}
      `;
      await ownerSql`DELETE FROM public.memory_nodes WHERE agent_id = ${agentId}`;
      await ownerSql`DELETE FROM public.agents WHERE id = ${agentId}`;
    }
  }, 30_000);
});
