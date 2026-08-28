import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { jest } from "@jest/globals";
import type { Sql } from "postgres";
import express from "express";
import { createProbeRouter } from "../api/probes.js";
import { loadMemoryConfig } from "../memory/config.js";
import { createMemoryServices } from "../memory/index.js";
import type {
  MemoryHealthService,
  MemoryServices,
} from "../memory/types.js";

async function startProbeServer(services?: MemoryServices): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const app = express();
  app.use(createProbeRouter(services));

  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for the Cortex REST process");
}

describe("memory runtime configuration", () => {
  it("uses the approved development defaults", () => {
    expect(loadMemoryConfig({})).toEqual({
      buildId: "dev",
      projectionVersion: "memory-projection-v1",
      retrievalVersion: "memory-retrieval-v1",
      ingestWorkerConcurrency: 4,
      ingestMaxAttempts: 5,
      embeddingTimeoutMs: 20_000,
      retrievalCandidateLimit: 100,
      retrievalTelemetryRetentionDays: 30,
      synthesisEnabled: false,
      ca3Enabled: false,
    });
  });

  it("fails closed for a missing headless build identity or invalid values", () => {
    expect(() => loadMemoryConfig({ CORTEX_HEADLESS: "true" })).toThrow(
      /CORTEX_BUILD_ID/
    );
    expect(() =>
      loadMemoryConfig({ CORTEX_INGEST_WORKER_CONCURRENCY: "33" })
    ).toThrow(/CORTEX_INGEST_WORKER_CONCURRENCY/);
    expect(() =>
      loadMemoryConfig({ CORTEX_SYNTHESIS_ENABLED: "yes" })
    ).toThrow(/CORTEX_SYNTHESIS_ENABLED/);
  });

  it("reads the approved provider and retrieval retention names", () => {
    expect(
      loadMemoryConfig({
        CORTEX_BUILD_ID: "config-test",
        EMBEDDING_TIMEOUT_MS: "1200",
        CORTEX_RETRIEVAL_EVENT_RETENTION_DAYS: "45",
      })
    ).toMatchObject({
      embeddingTimeoutMs: 1200,
      retrievalTelemetryRetentionDays: 45,
    });
  });

  it("bounds the build identity by the persisted UTF-8 byte contract", () => {
    expect(loadMemoryConfig({ CORTEX_BUILD_ID: "x".repeat(128) }).buildId)
      .toHaveLength(128);
    expect(loadMemoryConfig({ CORTEX_BUILD_ID: "é".repeat(64) }).buildId)
      .toBe("é".repeat(64));
    expect(() =>
      loadMemoryConfig({ CORTEX_BUILD_ID: "é".repeat(65) })
    ).toThrow(/128 printable UTF-8 bytes/);
    expect(() =>
      loadMemoryConfig({ CORTEX_BUILD_ID: "😀".repeat(64) })
    ).toThrow(/128 printable UTF-8 bytes/);
  });
});

describe("memory process probes", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps liveness independent and exposes the Slice 1 readiness mock", async () => {
    const readiness = jest
      .fn<MemoryHealthService["readiness"]>()
      .mockResolvedValue({
        ready: false,
        buildId: "slice-1-test",
        reasons: ["memory_lifecycle_not_installed"],
      });
    const services = {
      ingest: {},
      health: { readiness },
    } as unknown as MemoryServices;
    const readinessLog = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const server = await startProbeServer(services);

    try {
      const liveResponse = await fetch(`${server.baseUrl}/livez`);
      expect(liveResponse.status).toBe(200);
      expect(await liveResponse.json()).toEqual({ status: "ok" });
      expect(readiness).not.toHaveBeenCalled();

      const readyResponse = await fetch(`${server.baseUrl}/readyz`);
      expect(readyResponse.status).toBe(503);
      expect(await readyResponse.json()).toEqual({ status: "not_ready" });
      expect(readiness).toHaveBeenCalledTimes(1);
      expect(readinessLog).toHaveBeenCalledWith(
        "[cortex] Memory readiness check failed",
        {
          reasonCount: 1,
        }
      );
    } finally {
      await server.close();
    }
  });

  it("uses the shared default service bundle", async () => {
    const readinessLog = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const unreachableSql = (() =>
      Promise.reject(new Error("disposable unavailable database"))) as unknown as Sql;
    const services = createMemoryServices({
      config: loadMemoryConfig({ CORTEX_BUILD_ID: "shared-runtime-test" }),
      sql: unreachableSql,
    });
    const server = await startProbeServer(services);

    try {
      const response = await fetch(`${server.baseUrl}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "not_ready" });
      expect(readinessLog).toHaveBeenCalledWith(
        "[cortex] Memory readiness check failed",
        {
          reasonCount: 1,
        }
      );
    } finally {
      await server.close();
    }
  });

  it(
    "mounts probes in the real REST process while database startup fails closed",
    async () => {
      const port = await allocateLoopbackPort();
      const tsx = resolve(process.cwd(), "node_modules/.bin/tsx");
      const child = spawn(tsx, ["src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        CORTEX_BUILD_ID: "real-process-test",
        CORTEX_HEADLESS: "true",
        DATABASE_URL:
          "postgresql://cortex_test:unused@127.0.0.1:1/cortex_test?sslmode=verify-full",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
      let stderr = "";
      child.stdout.resume();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      try {
        await waitUntil(
          () =>
            (stderr.match(/Database\/schema initialization failed/g)?.length ??
              0) >= 2
        );
        expect(child.exitCode).toBeNull();

        const liveResponse = await fetch(`http://127.0.0.1:${port}/livez`);
        expect(liveResponse.status).toBe(200);
        expect(await liveResponse.json()).toEqual({ status: "ok" });

        const readyResponse = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(readyResponse.status).toBe(503);
        expect(await readyResponse.json()).toEqual({ status: "not_ready" });

        const memoryRouteResponse = await fetch(
          `http://127.0.0.1:${port}/api/v1/health`
        );
        expect(memoryRouteResponse.status).toBe(503);
        expect(await memoryRouteResponse.json()).toEqual({ status: "not_ready" });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await exited;
        }
      }
    },
    20_000
  );
});
