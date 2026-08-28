import {
  readSchemaReadiness,
  REQUIRED_MIGRATIONS,
  type SchemaReadiness,
} from "../db/migrations.js";
import type {
  MemoryHealthService,
  MemoryServiceDependencies,
  OperationCompletion,
  OperationName,
  OperationRunHandle,
  OperationStatus,
} from "./types.js";

const WORKER_HEARTBEAT_MAX_AGE_MS = 90_000;
const READINESS_STATEMENT_TIMEOUT_MS = 1_000;

export interface ReadinessWorkerEvidence {
  buildId: string;
  status: OperationStatus;
  heartbeatAt: string | Date;
}

export interface ReadinessAssessmentInput {
  buildId: string;
  now: Date;
  schema: Pick<SchemaReadiness, "ready" | "reason">;
  worker: ReadinessWorkerEvidence | null;
}

export function assessMemoryReadiness(input: ReadinessAssessmentInput): {
  ready: boolean;
  buildId: string;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (!input.schema.ready) {
    reasons.push(`schema_${input.schema.reason ?? "missing"}`);
  } else if (!input.buildId.trim()) {
    reasons.push("build_id_missing");
  } else if (!input.worker) {
    reasons.push("ingest_worker_missing");
  } else if (input.worker.status !== "running") {
    reasons.push("ingest_worker_not_running");
  } else if (input.worker.buildId !== input.buildId) {
    reasons.push("ingest_worker_build_mismatch");
  } else {
    const heartbeatAt = new Date(input.worker.heartbeatAt).getTime();
    const ageMs = input.now.getTime() - heartbeatAt;
    if (
      !Number.isFinite(heartbeatAt) ||
      ageMs < 0 ||
      ageMs > WORKER_HEARTBEAT_MAX_AGE_MS
    ) {
      reasons.push("ingest_worker_stale");
    }
  }

  return {
    ready: reasons.length === 0,
    buildId: input.buildId,
    reasons,
  };
}

interface OperationRow {
  build_id: string;
  status: OperationStatus;
  heartbeat_at: string | Date;
}

export function createMemoryHealthService(
  deps: MemoryServiceDependencies
): MemoryHealthService {
  return Object.freeze({
    async startOperation(
      operation: OperationName,
      agentId?: number
    ): Promise<OperationRunHandle> {
      const id = deps.newId();
      const now = deps.now();
      const nowIso = now.toISOString();
      await deps.sql`
        INSERT INTO public.memory_operation_runs (
          id,
          agent_id,
          operation,
          status,
          build_id,
          worker_id,
          counters,
          started_at,
          heartbeat_at
        ) VALUES (
          ${id}::uuid,
          ${agentId ?? null},
          ${operation},
          'running',
          ${deps.config.buildId},
          ${id},
          '{}'::jsonb,
          ${nowIso},
          ${nowIso}
        )
      `;
      return { id, operation, agentId, buildId: deps.config.buildId };
    },

    async heartbeat(
      handle: OperationRunHandle,
      counters: Record<string, number> = {}
    ): Promise<void> {
      const heartbeatAt = deps.now().toISOString();
      await deps.sql`
        UPDATE public.memory_operation_runs
        SET heartbeat_at = ${heartbeatAt},
            counters = ${JSON.stringify(counters)}::jsonb
        WHERE id = ${handle.id}::uuid
          AND operation = ${handle.operation}
          AND build_id = ${handle.buildId}
          AND status = 'running'
      `;
    },

    async finishOperation(
      handle: OperationRunHandle,
      status: Exclude<OperationStatus, "running">,
      details: OperationCompletion = {}
    ): Promise<void> {
      const now = deps.now();
      const nowIso = now.toISOString();
      await deps.sql`
        UPDATE public.memory_operation_runs
        SET status = ${status},
            counters = ${JSON.stringify(details.counters ?? {})}::jsonb,
            error_code = ${details.errorCode ?? null},
            heartbeat_at = ${nowIso},
            completed_at = ${nowIso}
        WHERE id = ${handle.id}::uuid
          AND operation = ${handle.operation}
          AND build_id = ${handle.buildId}
          AND status = 'running'
      `;
    },

    async readiness() {
      try {
        // Scope the timeout to this read-only readiness transaction. Applying a
        // global statement timeout would also terminate legitimate ingestion,
        // retrieval, and maintenance work that shares the process pool.
        return await deps.sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.set_config(
              'statement_timeout',
              ${String(READINESS_STATEMENT_TIMEOUT_MS)},
              true
            )
          `;

          const schema = await readSchemaReadiness(
            transaction as unknown as Parameters<typeof readSchemaReadiness>[0],
            REQUIRED_MIGRATIONS
          );
          if (!schema.ready) {
            return assessMemoryReadiness({
              buildId: deps.config.buildId,
              now: deps.now(),
              schema,
              worker: null,
            });
          }

          const rows = (await transaction`
            SELECT build_id, status, heartbeat_at
            FROM public.memory_operation_runs
            WHERE operation = 'ingest_worker'
              AND status = 'running'
              AND build_id = ${deps.config.buildId}
            ORDER BY heartbeat_at DESC
            LIMIT 1
          `) as unknown as OperationRow[];
          const row = rows[0];
          return assessMemoryReadiness({
            buildId: deps.config.buildId,
            now: deps.now(),
            schema,
            worker: row
              ? {
                  buildId: row.build_id,
                  status: row.status,
                  heartbeatAt: row.heartbeat_at,
                }
              : null,
          });
        });
      } catch {
        return {
          ready: false,
          buildId: deps.config.buildId,
          reasons: ["database_unreachable"],
        };
      }
    },
  });
}
