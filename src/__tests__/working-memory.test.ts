import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { jest } from "@jest/globals";
import { createWorkingSetRouter } from "../api/working-set.js";
import {
  reconcileStrategicWorkingSet,
  runStrategicThread,
} from "../cognition/background-threads.js";
import { createWorkingSetService } from "../memory/working-set.js";
import {
  journalCallerKey,
  normalizeJournalText,
} from "../memory/working-set.js";
import type {
  MemoryServiceDependencies,
  MemoryServices,
  WorkingItem,
  WorkingSetService,
} from "../memory/types.js";

const ITEM: WorkingItem = {
  id: "00000000-0000-4000-8000-000000000701",
  agentId: 7,
  callerKey: "journal:thread:abc",
  kind: "current_task",
  content: "Finish Slice 7",
  importance: 0.8,
  displayOrder: 0,
  status: "active",
  sourceMemoryId: null,
  sourceEventId: null,
  lastConfirmedAt: "2026-08-29T00:00:00.000Z",
  expiresAt: "2026-09-12T00:00:00.000Z",
  resolvedAt: null,
  resolutionReason: null,
};

function workingSetStub(
  overrides: Partial<WorkingSetService> = {}
): WorkingSetService {
  return {
    list: jest.fn<WorkingSetService["list"]>().mockResolvedValue([ITEM]),
    upsert: jest.fn<WorkingSetService["upsert"]>().mockResolvedValue(ITEM),
    resolve: jest.fn<WorkingSetService["resolve"]>().mockResolvedValue({
      ...ITEM,
      status: "resolved",
      resolvedAt: "2026-08-29T01:00:00.000Z",
      resolutionReason: "done",
    }),
    expire: jest.fn<WorkingSetService["expire"]>().mockResolvedValue({
      ...ITEM,
      status: "expired",
      resolvedAt: "2026-08-29T01:00:00.000Z",
      resolutionReason: "stale",
    }),
    reconfirm: jest.fn<WorkingSetService["reconfirm"]>().mockResolvedValue(ITEM),
    reconcileJournal: jest
      .fn<WorkingSetService["reconcileJournal"]>()
      .mockResolvedValue([ITEM]),
    ...overrides,
  };
}

async function startRouter(
  workingSet: WorkingSetService,
  resolveAgentId: (externalId: string) => Promise<number | null>
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/working-set",
    createWorkingSetRouter(
      { workingSet } as unknown as MemoryServices,
      { resolveAgentId }
    )
  );
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1/working-set`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

describe("working-memory identity", () => {
  test("journal keys are namespaced stable hashes of normalized content", () => {
    expect(normalizeJournalText("  Finish\tSLICE 7  ")).toBe("finish slice 7");
    expect(journalCallerKey("thread", " Finish\tSLICE 7 ")).toBe(
      journalCallerKey("thread", "finish slice 7")
    );
    expect(journalCallerKey("thread", "finish slice 7")).not.toBe(
      journalCallerKey("concern", "finish slice 7")
    );
  });

  test("rejects an overlong expiry before acquiring a database transaction", async () => {
    const begin = jest.fn();
    const deps = {
      sql: { begin } as unknown as MemoryServiceDependencies["sql"],
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    } as unknown as MemoryServiceDependencies;
    const service = createWorkingSetService(deps);

    await expect(
      service.upsert({
        agentId: 7,
        callerKey: "task:too-long",
        kind: "current_task",
        content: "This expiry is outside the bounded window.",
        expiresAt: "2026-09-29T00:00:00.001Z",
      })
    ).rejects.toMatchObject({ code: "invalid_expires_at" });
    expect(begin).not.toHaveBeenCalled();
  });
});

describe("private working-set REST adapter", () => {
  test("keeps reads bounded, private, no-store, and free of internal agent ids", async () => {
    const service = workingSetStub();
    const resolveAgentId = jest.fn(async () => 7);
    const server = await startRouter(service, resolveAgentId);
    try {
      const response = await fetch(`${server.baseUrl}?agentId=arlo&limit=8`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        agentId: "arlo",
        itemCount: 1,
        items: [{
          id: ITEM.id,
          callerKey: ITEM.callerKey,
          kind: ITEM.kind,
          content: ITEM.content,
          importance: ITEM.importance,
          displayOrder: ITEM.displayOrder,
          status: ITEM.status,
          sourceMemoryId: null,
          sourceEventId: null,
          lastConfirmedAt: ITEM.lastConfirmedAt,
          expiresAt: ITEM.expiresAt,
          resolvedAt: null,
          resolutionReason: null,
        }],
      });
      expect(service.list).toHaveBeenCalledWith(7, 8);
    } finally {
      await server.close();
    }
  });

  test("upserts through the injected shared service and rejects extra fields before lookup", async () => {
    const service = workingSetStub();
    const resolveAgentId = jest.fn(async () => 7);
    const server = await startRouter(service, resolveAgentId);
    try {
      const response = await fetch(server.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          callerKey: "task:slice-7",
          kind: "current_task",
          content: "Finish Slice 7",
        }),
      });
      expect(response.status).toBe(200);
      expect(service.upsert).toHaveBeenCalledWith({
        agentId: 7,
        callerKey: "task:slice-7",
        kind: "current_task",
        content: "Finish Slice 7",
        importance: undefined,
        displayOrder: undefined,
        expiresAt: undefined,
        sourceEventId: undefined,
        sourceMemoryId: undefined,
      });

      resolveAgentId.mockClear();
      const invalid = await fetch(server.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          callerKey: "task:slice-7",
          kind: "current_task",
          content: "Finish Slice 7",
          surprise: true,
        }),
      });
      expect(invalid.status).toBe(400);
      expect(resolveAgentId).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  test("uses explicit actions and makes malformed or unknown PATCH scope indistinguishable", async () => {
    const service = workingSetStub();
    const resolveAgentId = jest
      .fn<(externalId: string) => Promise<number | null>>()
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(null);
    const server = await startRouter(service, resolveAgentId);
    try {
      const resolved = await fetch(`${server.baseUrl}/${ITEM.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          action: "resolve",
          reason: "completed",
        }),
      });
      expect(resolved.status).toBe(200);
      expect(service.resolve).toHaveBeenCalledWith(7, ITEM.id, "completed");

      const malformed = await fetch(`${server.baseUrl}/not-a-uuid`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "arlo",
          action: "resolve",
          reason: "completed",
        }),
      });
      expect(malformed.status).toBe(404);

      const unknown = await fetch(`${server.baseUrl}/${ITEM.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "foreign",
          action: "resolve",
          reason: "completed",
        }),
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "working_item_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("strategic working reconciliation", () => {
  test("upserts one stable seven-day key on nonempty success", async () => {
    const service = workingSetStub();
    const now = new Date("2026-08-29T00:00:00.000Z");
    await reconcileStrategicWorkingSet(
      7,
      { insights: [], actions: ["Review the memory rollout"], questions: [] },
      service,
      now
    );
    expect(service.upsert).toHaveBeenCalledWith({
      agentId: 7,
      callerKey: "background:strategic",
      kind: "open_loop",
      content: "Review the memory rollout",
      importance: 0.8,
      displayOrder: 20_000,
      expiresAt: "2026-09-05T00:00:00.000Z",
    });
  });

  test("resolves the stable key only on explicit empty success", async () => {
    const strategic = { ...ITEM, callerKey: "background:strategic" };
    const service = workingSetStub({
      list: jest.fn<WorkingSetService["list"]>().mockResolvedValue([strategic]),
    });
    await reconcileStrategicWorkingSet(
      7,
      { insights: [], actions: [], questions: [] },
      service
    );
    expect(service.resolve).toHaveBeenCalledWith(
      7,
      strategic.id,
      "strategic_empty_success"
    );
    expect(service.upsert).not.toHaveBeenCalled();
  });

  test("an already-aborted run cannot query or mutate strategic state", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = workingSetStub();
    await expect(
      runStrategicThread(7, { workingSet: service, signal: controller.signal })
    ).rejects.toThrow(/cancelled/);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.upsert).not.toHaveBeenCalled();
    expect(service.resolve).not.toHaveBeenCalled();
  });
});
