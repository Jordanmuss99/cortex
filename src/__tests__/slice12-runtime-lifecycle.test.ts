import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { jest } from "@jest/globals";
import { createProbeRouter } from "../api/probes.js";
import type { MemoryHealthService, MemoryServices } from "../memory/types.js";

async function listen(server: HttpServer | TcpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: HttpServer | TcpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 15_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("child process did not exit")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForText(
  read: () => string,
  marker: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(marker)) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${marker}`);
}

async function waitForTcpConnection(
  server: TcpServer,
  timeoutMs = 15_000
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(server, "connection").then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP did not begin database initialization")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("Slice 12 runtime lifecycle", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("liveness is process-only while readiness also requires the application gate", async () => {
    const readiness = jest
      .fn<MemoryHealthService["readiness"]>()
      .mockResolvedValue({ ready: true, buildId: "slice-12", reasons: [] });
    const services = {
      ingest: {},
      health: { readiness },
    } as unknown as MemoryServices;
    let applicationReady = false;
    const readinessLog = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const app = express();
    app.use(
      createProbeRouter(services, {
        isApplicationReady: () => applicationReady,
      })
    );
    const server = createHttpServer(app);
    const port = await listen(server);

    try {
      const live = await fetch(`http://127.0.0.1:${port}/livez`);
      expect(live.status).toBe(200);
      expect(live.headers.get("cache-control")).toBe("no-store");
      expect(await live.json()).toEqual({ status: "ok" });
      expect(readiness).not.toHaveBeenCalled();

      const gated = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(gated.status).toBe(503);
      expect(gated.headers.get("cache-control")).toBe("no-store");
      expect(await gated.json()).toEqual({ status: "not_ready" });
      expect(readiness).not.toHaveBeenCalled();

      applicationReady = true;
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      expect(ready.headers.get("cache-control")).toBe("no-store");
      expect(await ready.json()).toEqual({ status: "ok" });
      expect(readiness).toHaveBeenCalledTimes(1);

      readiness.mockResolvedValueOnce({
        ready: false,
        buildId: "slice12_build_canary",
        reasons: ["slice12_reason_canary"],
      });
      const unavailable = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(unavailable.status).toBe(503);
      expect(readinessLog).toHaveBeenLastCalledWith(
        "[cortex] Memory readiness check failed",
        { reasonCount: 1 }
      );
      expect(JSON.stringify(readinessLog.mock.calls)).not.toContain("slice12_build_canary");
      expect(JSON.stringify(readinessLog.mock.calls)).not.toContain("slice12_reason_canary");
    } finally {
      await closeServer(server);
    }
  });

  test("readiness has a fixed deadline and coalesces a stalled dependency check", async () => {
    const stalledReadiness = new Promise<{
      ready: boolean;
      buildId: string;
      reasons: string[];
    }>(() => undefined);
    const readiness = jest
      .fn<MemoryHealthService["readiness"]>()
      .mockImplementation(() => stalledReadiness);
    const services = {
      ingest: {},
      health: { readiness },
    } as unknown as MemoryServices;
    const readinessLog = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const app = express();
    app.use(
      createProbeRouter(
        services,
        { isApplicationReady: () => true },
        { readinessTimeoutMs: 50 }
      )
    );
    const server = createHttpServer(app);
    const port = await listen(server);

    try {
      const startedAt = Date.now();
      const firstPair = await Promise.all([
        fetch(`http://127.0.0.1:${port}/readyz`),
        fetch(`http://127.0.0.1:${port}/readyz`),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      for (const response of firstPair) {
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ status: "not_ready" });
      }
      expect(readiness).toHaveBeenCalledTimes(1);

      const repeated = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(repeated.status).toBe(503);
      expect(await repeated.json()).toEqual({ status: "not_ready" });
      expect(readiness).toHaveBeenCalledTimes(1);
      expect(readinessLog).toHaveBeenCalledWith(
        "[cortex] Memory readiness check timed out",
        { errorType: "MemoryReadinessTimeout" }
      );
      expect(JSON.stringify(readinessLog.mock.calls)).not.toContain(
        "slice12_stalled_dependency_canary"
      );
    } finally {
      await closeServer(server);
    }
  });

  test("Core cancels database retry and shares one clean SIGINT/SIGTERM shutdown", async () => {
    const portAllocator = createHttpServer();
    const port = await listen(portAllocator);
    await closeServer(portAllocator);

    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        CORTEX_BUILD_ID: "slice-12-core",
        CORTEX_HEADLESS: "true",
        DATABASE_URL:
          "postgresql://slice12:secret@127.0.0.1:1/cortex?sslmode=verify-full",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForText(() => stderr, "REST probes listening");
      const live = await fetch(`http://127.0.0.1:${port}/livez`);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(live.status).toBe(200);
      expect(live.headers.get("cache-control")).toBe("no-store");
      expect(ready.status).toBe(503);
      expect(ready.headers.get("cache-control")).toBe("no-store");

      child.kill("SIGINT");
      child.kill("SIGTERM");
      await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
      expect(stderr).toContain("Shutdown complete");
      expect(stderr.match(/Shutdown complete/g)).toHaveLength(1);
      expect(stderr).not.toContain("HOT RELOAD");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);

  test("Core binds process liveness before a blackholed database handshake settles", async () => {
    const sockets = new Set<Socket>();
    const databaseServer = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const databasePort = await listen(databaseServer);
    const databaseAttempt = waitForTcpConnection(databaseServer);
    const portAllocator = createHttpServer();
    const port = await listen(portAllocator);
    await closeServer(portAllocator);

    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        CORTEX_BUILD_ID: "slice-12-core-blackhole",
        CORTEX_HEADLESS: "true",
        DATABASE_URL:
          `postgresql://slice12:slice12_blackhole_secret@127.0.0.1:${databasePort}/cortex`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForText(() => stderr, "REST probes listening");
      await databaseAttempt;
      const live = await fetch(`http://127.0.0.1:${port}/livez`);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok" });
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "not_ready" });
      expect(child.exitCode).toBeNull();
      expect(stderr).not.toContain("slice12_blackhole_secret");

      child.kill("SIGTERM");
      await expect(waitForExit(child)).resolves.toEqual({ code: 0, signal: null });
      expect(stderr.match(/Shutdown complete/g)).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      await closeServer(databaseServer);
    }
  }, 25_000);

  test("Core routes HTTP bind failure through redacted lifecycle cleanup", async () => {
    const occupiedPort = createHttpServer((_req, res) => res.end("occupied"));
    const port = await listen(occupiedPort);
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        CORTEX_BUILD_ID: "slice-12-core-bind-failure",
        CORTEX_HEADLESS: "true",
        DATABASE_URL:
          "postgresql://slice12:slice12_bind_secret@127.0.0.1:1/cortex?sslmode=verify-full",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await expect(waitForExit(child)).resolves.toEqual({ code: 1, signal: null });
      expect(stderr).toContain("Fatal HTTP listener failure");
      expect(stderr).toContain("Shutdown complete");
      expect(stderr.match(/Shutdown complete/g)).toHaveLength(1);
      expect(stderr).not.toContain("EADDRINUSE");
      expect(stderr).not.toContain("slice12_bind_secret");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closeServer(occupiedPort);
    }
  }, 20_000);

  test.each([
    ["SIGINT", (child: ChildProcess) => child.kill("SIGINT")],
    ["SIGTERM", (child: ChildProcess) => child.kill("SIGTERM")],
    ["stdin EOF", (child: ChildProcess) => child.stdin!.end()],
  ])("MCP handles %s during database initialization as a clean shutdown", async (_name, stop) => {
    const sockets = new Set<Socket>();
    const databaseServer = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const port = await listen(databaseServer);
    const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://slice12:secret@127.0.0.1:${port}/cortex`,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForTcpConnection(databaseServer);
      stop(child);
      const exit = await waitForExit(child).catch((error) => {
        throw new Error(`${String(error)}; stderr: ${stderr}`);
      });
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      await closeServer(databaseServer);
    }
  }, 25_000);

  test("MCP registers signal and stdin lifecycle hooks before database initialization", async () => {
    const source = await readFile("src/mcp/server.ts", "utf8");
    const initialization = source.indexOf("async function main()");
    expect(initialization).toBeGreaterThan(0);
    for (const hook of [
      'process.once("SIGINT"',
      'process.once("SIGTERM"',
      'process.stdin.once("end"',
      'process.stdin.once("close"',
      'process.stdin.once("error"',
    ]) {
      expect(source.indexOf(hook)).toBeGreaterThan(0);
      expect(source.indexOf(hook)).toBeLessThan(initialization);
    }
  });

  test("MCP startup failures are nonzero and do not log raw connection data", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL:
          "postgresql://slice12:slice12_secret_canary@127.0.0.1:1/cortex?sslmode=verify-full",
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await expect(waitForExit(child)).resolves.toEqual({ code: 1, signal: null });
      expect(stderr).toContain("[cortex-mcp] Fatal:");
      expect(stderr).not.toContain("slice12_secret_canary");
      expect(stderr).not.toContain("ECONNREFUSED");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});
