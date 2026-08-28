import { jest } from "@jest/globals";
import { createIngestWorker } from "../memory/ingest-worker.js";
import type { EmbeddedBatch, MemoryServiceDependencies } from "../memory/types.js";

const EVENT_ID = "5e1f3b2a-0b89-4f79-9ed6-1a55b445d08a";
const OPERATION_ID = "8f519251-3b18-4be1-9294-f0b8308073da";
const LEASE_ID = "6c29d891-34cc-4972-bf6a-edce4fa8a026";
const NOW = new Date("2026-08-28T12:00:00.000Z");

describe("durable ingest worker operation health", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("heartbeats while provider work remains in flight", async () => {
    jest.useFakeTimers();
    let claimAvailable = true;
    let rejectProvider!: (error: Error) => void;
    const providerPending = new Promise<EmbeddedBatch>((_resolve, reject) => {
      rejectProvider = reject;
    });
    let heartbeatUpdates = 0;
    let leaseRenewals = 0;

    const transaction = Object.assign(
      jest.fn(async (strings: TemplateStringsArray) => {
        const statement = strings.join(" ");
        if (statement.includes("SELECT id, agent_id, cycle_attempts")) {
          if (!claimAvailable) return [];
          claimAvailable = false;
          return [
            {
              id: EVENT_ID,
              agent_id: 7,
              cycle_attempts: 0,
              projected_at: null,
            },
          ];
        }
        if (statement.includes("UPDATE public.memory_ingest_events")) return [];
        throw new Error(`Unexpected transaction statement: ${statement}`);
      }),
      { array: (values: readonly unknown[]) => values }
    );

    const rootSql = Object.assign(
      jest.fn(async (strings: TemplateStringsArray) => {
        const statement = strings.join(" ");
        if (statement.includes("INSERT INTO public.memory_operation_runs")) return [];
        if (
          statement.includes("SELECT") &&
          statement.includes("raw_content") &&
          statement.includes("FROM public.memory_ingest_events")
        ) {
          return [
            {
              id: EVENT_ID,
              agent_id: 7,
              raw_content: "Provider work remains deliberately pending.",
              source: null,
              source_type: "api",
              observed_at: NOW,
              valid_from: null,
              valid_until: null,
              effective_priority: 2,
              provided_entities: [],
              provided_semantic_tags: [],
              projected_at: null,
              lease_token: LEASE_ID,
              status: "processing",
            },
          ];
        }
        if (
          statement.includes("UPDATE public.memory_operation_runs") &&
          statement.includes("SET heartbeat_at")
        ) {
          heartbeatUpdates += 1;
          return [];
        }
        if (
          statement.includes("UPDATE public.memory_ingest_events") &&
          statement.includes("SET lease_expires_at")
        ) {
          leaseRenewals += 1;
          return [{ id: EVENT_ID }];
        }
        if (
          statement.includes("UPDATE public.memory_ingest_events") &&
          statement.includes("SET status = 'failed'")
        ) {
          return [];
        }
        if (
          statement.includes("LEFT JOIN public.memory_nodes") &&
          statement.includes("FROM public.memory_ingest_events")
        ) {
          return [
            {
              id: EVENT_ID,
              status: "failed",
              total_attempts: 1,
              cycle_attempts: 1,
              manual_retry_count: 0,
              possible_update_ids: [],
              projection_count: 0,
              synapse_count: 0,
              accepted_at: NOW,
              started_at: NOW,
              indexed_at: null,
              next_attempt_at: new Date(NOW.getTime() + 60_000),
              failure_code: "projection_failed",
              warning_codes: [],
              node_ids: [],
              effective_priorities: [],
            },
          ];
        }
        if (
          statement.includes("UPDATE public.memory_operation_runs") &&
          statement.includes("SET status =")
        ) {
          return [];
        }
        throw new Error(`Unexpected root statement: ${statement}`);
      }),
      {
        begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }
    );

    const ids = [OPERATION_ID, LEASE_ID];
    const dependencies = {
      sql: rootSql,
      config: {
        buildId: "slice2-worker-test",
        ingestWorkerConcurrency: 1,
        ingestMaxAttempts: 5,
      },
      now: () => NOW,
      newId: () => ids.shift() ?? LEASE_ID,
      embedTexts: jest.fn(async () => providerPending),
    } as unknown as MemoryServiceDependencies;
    const worker = createIngestWorker(dependencies);
    const shutdown = new AbortController();
    const run = worker.run(shutdown.signal);

    await jest.advanceTimersByTimeAsync(0);
    expect(dependencies.embedTexts).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_001);
    expect(heartbeatUpdates).toBeGreaterThanOrEqual(1);
    expect(leaseRenewals).toBeGreaterThanOrEqual(1);

    shutdown.abort();
    rejectProvider(new Error("end the deliberately pending provider call"));
    await run;
  });

  it("discards a lease-lost claim without terminating the worker loop", async () => {
    jest.useFakeTimers();
    let claimAvailable = true;
    let operationFinishedAs: string | null = null;

    const transaction = Object.assign(
      jest.fn(async (strings: TemplateStringsArray) => {
        const statement = strings.join(" ");
        if (statement.includes("SELECT id, agent_id, cycle_attempts")) {
          if (!claimAvailable) return [];
          claimAvailable = false;
          return [
            {
              id: EVENT_ID,
              agent_id: 7,
              cycle_attempts: 0,
              projected_at: null,
            },
          ];
        }
        if (statement.includes("UPDATE public.memory_ingest_events")) return [];
        throw new Error(`Unexpected transaction statement: ${statement}`);
      }),
      { array: (values: readonly unknown[]) => values }
    );

    const rootSql = Object.assign(
      jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join(" ");
        if (statement.includes("INSERT INTO public.memory_operation_runs")) return [];
        if (
          statement.includes("raw_content") &&
          statement.includes("FROM public.memory_ingest_events")
        ) {
          return [];
        }
        if (
          statement.includes("UPDATE public.memory_operation_runs") &&
          statement.includes("SET heartbeat_at")
        ) {
          return [];
        }
        if (
          statement.includes("UPDATE public.memory_operation_runs") &&
          statement.includes("SET status =")
        ) {
          operationFinishedAs = String(values[0]);
          return [];
        }
        throw new Error(`Unexpected root statement: ${statement}`);
      }),
      {
        begin: async (callback: (sql: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }
    );

    const ids = [OPERATION_ID, LEASE_ID];
    const worker = createIngestWorker({
      sql: rootSql,
      config: {
        buildId: "slice3-lease-loss-test",
        ingestWorkerConcurrency: 1,
        ingestMaxAttempts: 5,
      },
      now: () => NOW,
      newId: () => ids.shift() ?? LEASE_ID,
    } as unknown as MemoryServiceDependencies);
    const shutdown = new AbortController();
    const run = worker.run(shutdown.signal);

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(101);
    shutdown.abort();
    await expect(run).resolves.toBeUndefined();
    expect(operationFinishedAs).toBe("stopped");
  });
});
