import { createHash } from "node:crypto";
import type postgres from "postgres";
import type {
  JournalWorkingUpdate,
  MemoryServiceDependencies,
  UpsertWorkingItemInput,
  WorkingItem,
  WorkingItemKind,
  WorkingSetService,
} from "./types.js";
import { WorkingSetValidationError } from "./types.js";

export const MAX_ACTIVE_WORKING_ITEMS = 12;
export const MAX_BOOT_WORKING_ITEMS = 8;
export const DEFAULT_WORKING_EXPIRY_DAYS = 14;
export const MAX_WORKING_EXPIRY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;
const WORKING_LOCK_NAMESPACE = 1_129_794_387;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set<WorkingItemKind>([
  "current_task",
  "open_loop",
  "constraint",
  "correction",
  "preference",
]);

type WorkingSql = postgres.TransactionSql;

interface WorkingItemRow {
  id: string;
  agent_id: number | string;
  caller_key: string;
  kind: WorkingItemKind;
  content: string;
  importance: number | string;
  display_order: number | string;
  status: "active" | "resolved" | "expired";
  source_memory_id: number | string | null;
  source_event_id: string | null;
  last_confirmed_at: string | Date;
  expires_at: string | Date;
  resolved_at: string | Date | null;
  resolution_reason: string | null;
}

interface NormalizedWorkingInput {
  agentId: number;
  callerKey: string;
  kind: WorkingItemKind;
  content: string;
  importance: number;
  displayOrder: number;
  expiresAt: string;
  sourceMemoryId: number | null;
  sourceEventId: string | null;
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

function validInstant(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new WorkingSetValidationError(
      "invalid_persisted_time",
      "Working item contains an invalid timestamp"
    );
  }
  return parsed.toISOString();
}

function toWorkingItem(row: WorkingItemRow): WorkingItem {
  return {
    id: row.id,
    agentId: Number(row.agent_id),
    callerKey: row.caller_key,
    kind: row.kind,
    content: row.content,
    importance: Number(row.importance),
    displayOrder: Number(row.display_order),
    status: row.status,
    sourceMemoryId:
      row.source_memory_id === null ? null : Number(row.source_memory_id),
    sourceEventId: row.source_event_id,
    lastConfirmedAt: validInstant(row.last_confirmed_at),
    expiresAt: validInstant(row.expires_at),
    resolvedAt:
      row.resolved_at === null ? null : validInstant(row.resolved_at),
    resolutionReason: row.resolution_reason,
  };
}

function dependencyNow(deps: MemoryServiceDependencies): Date {
  const now = deps.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new WorkingSetValidationError(
      "invalid_clock",
      "Working-set clock must return a valid instant"
    );
  }
  return now;
}

function validateAgentId(agentId: number): void {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new WorkingSetValidationError(
      "invalid_agent",
      "agentId must be a positive integer"
    );
  }
}

function boundedTrimmed(
  value: unknown,
  field: string,
  maxBytes: number
): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new WorkingSetValidationError(
      `invalid_${field}`,
      `${field} must be 1 to ${maxBytes} trimmed UTF-8 bytes`
    );
  }
  return value;
}

function validateId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new WorkingSetValidationError(
      "invalid_working_item_id",
      "Working item id must be a UUID"
    );
  }
}

function normalizedExpiry(
  value: string | undefined,
  now: Date
): string {
  const expiresAt =
    value === undefined
      ? new Date(now.getTime() + DEFAULT_WORKING_EXPIRY_DAYS * DAY_MS)
      : new Date(value);
  const delta = expiresAt.getTime() - now.getTime();
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    delta <= 0 ||
    delta > MAX_WORKING_EXPIRY_DAYS * DAY_MS
  ) {
    throw new WorkingSetValidationError(
      "invalid_expires_at",
      `expiresAt must be later than now and no more than ${MAX_WORKING_EXPIRY_DAYS} days away`
    );
  }
  return expiresAt.toISOString();
}

function normalizeUpsert(
  input: UpsertWorkingItemInput,
  now: Date
): NormalizedWorkingInput {
  validateAgentId(input.agentId);
  if (!KINDS.has(input.kind)) {
    throw new WorkingSetValidationError(
      "invalid_kind",
      "Working item kind is invalid"
    );
  }
  const callerKey = boundedTrimmed(input.callerKey, "caller_key", 256);
  const content = boundedTrimmed(input.content, "content", 8192);
  const importance = input.importance ?? 0.5;
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw new WorkingSetValidationError(
      "invalid_importance",
      "importance must be between 0 and 1"
    );
  }
  const displayOrder = input.displayOrder ?? 0;
  if (
    !Number.isSafeInteger(displayOrder) ||
    displayOrder < -1_000_000 ||
    displayOrder > 1_000_000
  ) {
    throw new WorkingSetValidationError(
      "invalid_display_order",
      "displayOrder must be an integer from -1000000 to 1000000"
    );
  }
  const sourceMemoryId = input.sourceMemoryId ?? null;
  if (
    sourceMemoryId !== null &&
    (!Number.isSafeInteger(sourceMemoryId) || sourceMemoryId <= 0)
  ) {
    throw new WorkingSetValidationError(
      "invalid_source_memory_id",
      "sourceMemoryId must be a positive integer"
    );
  }
  if (input.kind === "correction" && sourceMemoryId === null) {
    throw new WorkingSetValidationError(
      "correction_source_required",
      "Correction working items require a sourceMemoryId"
    );
  }
  const sourceEventId = input.sourceEventId ?? null;
  if (sourceEventId !== null && !UUID_PATTERN.test(sourceEventId)) {
    throw new WorkingSetValidationError(
      "invalid_source_event_id",
      "sourceEventId must be a UUID"
    );
  }

  return {
    agentId: input.agentId,
    callerKey,
    kind: input.kind,
    content,
    importance,
    displayOrder,
    expiresAt: normalizedExpiry(input.expiresAt, now),
    sourceMemoryId,
    sourceEventId,
  };
}

async function lockWorkingSet(
  transaction: WorkingSql,
  agentId: number
): Promise<void> {
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock(
      ${WORKING_LOCK_NAMESPACE},
      ${agentId}
    )
  `;
  const agents = rows<{ id: number | string }>(await transaction`
    SELECT id
    FROM public.agents
    WHERE id = ${agentId}
  `);
  if (agents.length !== 1) {
    throw new WorkingSetValidationError(
      "agent_not_found",
      "The requested Cortex agent does not exist"
    );
  }
}

async function assertCurrentSources(
  transaction: WorkingSql,
  input: NormalizedWorkingInput,
  now: string
): Promise<void> {
  if (input.sourceMemoryId !== null) {
    const memories = rows<{ id: number | string }>(await transaction`
      SELECT node.id
      FROM public.memory_nodes AS node
      WHERE node.id = ${input.sourceMemoryId}
        AND node.agent_id = ${input.agentId}
        AND node.status = 'active'
        AND (node.valid_from IS NULL OR node.valid_from <= ${now}::timestamptz)
        AND (node.valid_until IS NULL OR node.valid_until > ${now}::timestamptz)
        AND (
          node.derivation_expires_at IS NULL
          OR node.derivation_expires_at > ${now}::timestamptz
        )
        AND (
          ${input.kind} <> 'correction'
          OR (
            node.ingest_event_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.memory_provenance AS provenance
              JOIN public.memory_ingest_events AS event
                ON event.id = provenance.ingest_event_id
               AND event.agent_id = provenance.agent_id
              WHERE provenance.agent_id = ${input.agentId}
                AND provenance.memory_id = node.id
                AND provenance.relation = 'captured_from'
                AND event.status = 'indexed'
                AND (
                  event.snapshot_valid_until IS NULL
                  OR event.snapshot_valid_until > ${now}::timestamptz
                )
            )
          )
        )
      FOR KEY SHARE OF node
    `);
    if (memories.length !== 1) {
      throw new WorkingSetValidationError(
        "source_memory_not_current",
        "sourceMemoryId must reference a current same-agent durable memory"
      );
    }
  }

  if (input.sourceEventId !== null) {
    const events = rows<{ id: string }>(await transaction`
      SELECT id::text AS id
      FROM public.memory_ingest_events
      WHERE id = ${input.sourceEventId}::uuid
        AND agent_id = ${input.agentId}
        AND status = 'indexed'
      FOR KEY SHARE
    `);
    if (events.length !== 1) {
      throw new WorkingSetValidationError(
        "source_event_not_indexed",
        "sourceEventId must reference an indexed same-agent event"
      );
    }
  }
}

async function closeStaleItems(
  transaction: WorkingSql,
  agentId: number,
  now: string
): Promise<void> {
  await transaction`
    UPDATE public.working_memory_items AS item
    SET status = 'expired',
        resolved_at = ${now}::timestamptz,
        resolution_reason = CASE
          WHEN item.expires_at <= ${now}::timestamptz THEN 'expired_by_time'
          ELSE 'source_memory_not_current'
        END,
        updated_at = ${now}::timestamptz
    WHERE item.agent_id = ${agentId}
      AND item.status = 'active'
      AND (
        item.expires_at <= ${now}::timestamptz
        OR (
          item.source_memory_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.memory_nodes AS node
            WHERE node.id = item.source_memory_id
              AND node.agent_id = item.agent_id
              AND node.status = 'active'
              AND (node.valid_from IS NULL OR node.valid_from <= ${now}::timestamptz)
              AND (node.valid_until IS NULL OR node.valid_until > ${now}::timestamptz)
              AND (
                node.derivation_expires_at IS NULL
                OR node.derivation_expires_at > ${now}::timestamptz
              )
              AND (
                item.kind <> 'correction'
                OR (
                  node.ingest_event_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM public.memory_provenance AS provenance
                    JOIN public.memory_ingest_events AS event
                      ON event.id = provenance.ingest_event_id
                     AND event.agent_id = provenance.agent_id
                    WHERE provenance.agent_id = item.agent_id
                      AND provenance.memory_id = node.id
                      AND provenance.relation = 'captured_from'
                      AND event.status = 'indexed'
                      AND (
                        event.snapshot_valid_until IS NULL
                        OR event.snapshot_valid_until > ${now}::timestamptz
                      )
                  )
                )
              )
          )
        )
      )
  `;
}

async function enforceBound(
  transaction: WorkingSql,
  agentId: number,
  now: string
): Promise<void> {
  await transaction`
    WITH ranked AS (
      SELECT
        id,
        pg_catalog.row_number() OVER (
          ORDER BY
            CASE WHEN kind = 'correction' THEN 0 ELSE 1 END ASC,
            CASE WHEN kind <> 'correction' THEN importance END DESC NULLS LAST,
            last_confirmed_at DESC,
            id DESC
        ) AS keep_rank
      FROM public.working_memory_items
      WHERE agent_id = ${agentId}
        AND status = 'active'
        AND expires_at > ${now}::timestamptz
    )
    UPDATE public.working_memory_items AS item
    SET status = 'expired',
        resolved_at = ${now}::timestamptz,
        resolution_reason = 'active_bound_eviction',
        updated_at = ${now}::timestamptz
    FROM ranked
    WHERE ranked.id = item.id
      AND ranked.keep_rank > ${MAX_ACTIVE_WORKING_ITEMS}
  `;
}

async function upsertInTransaction(
  deps: MemoryServiceDependencies,
  transaction: WorkingSql,
  input: UpsertWorkingItemInput,
  now: Date
): Promise<WorkingItem> {
  const normalized = normalizeUpsert(input, now);
  const nowIso = now.toISOString();
  await assertCurrentSources(transaction, normalized, nowIso);
  const result = rows<WorkingItemRow>(await transaction`
    INSERT INTO public.working_memory_items (
      id,
      agent_id,
      caller_key,
      kind,
      content,
      source_memory_id,
      source_event_id,
      status,
      display_order,
      importance,
      last_confirmed_at,
      expires_at,
      resolved_at,
      resolution_reason,
      created_at,
      updated_at
    ) VALUES (
      ${deps.newId()}::uuid,
      ${normalized.agentId},
      ${normalized.callerKey},
      ${normalized.kind},
      ${normalized.content},
      ${normalized.sourceMemoryId},
      ${normalized.sourceEventId}::uuid,
      'active',
      ${normalized.displayOrder},
      ${normalized.importance},
      ${nowIso}::timestamptz,
      ${normalized.expiresAt}::timestamptz,
      NULL,
      NULL,
      ${nowIso}::timestamptz,
      ${nowIso}::timestamptz
    )
    ON CONFLICT (agent_id, caller_key) DO UPDATE
    SET kind = EXCLUDED.kind,
        content = EXCLUDED.content,
        source_memory_id = EXCLUDED.source_memory_id,
        source_event_id = EXCLUDED.source_event_id,
        status = 'active',
        display_order = EXCLUDED.display_order,
        importance = EXCLUDED.importance,
        last_confirmed_at = EXCLUDED.last_confirmed_at,
        expires_at = EXCLUDED.expires_at,
        resolved_at = NULL,
        resolution_reason = NULL,
        updated_at = EXCLUDED.updated_at
    RETURNING *
  `);
  if (result.length !== 1) {
    throw new Error("Working-set upsert did not return one row");
  }
  return toWorkingItem(result[0]);
}

async function loadById(
  transaction: WorkingSql,
  agentId: number,
  id: string
): Promise<WorkingItem | null> {
  const result = rows<WorkingItemRow>(await transaction`
    SELECT *
    FROM public.working_memory_items
    WHERE id = ${id}::uuid
      AND agent_id = ${agentId}
  `);
  return result[0] ? toWorkingItem(result[0]) : null;
}

export function normalizeJournalText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function journalCallerKey(
  category: "thread" | "concern",
  content: string
): string {
  const normalized = normalizeJournalText(content);
  const digest = createHash("sha256").update(normalized).digest("hex");
  return `journal:${category}:${digest}`;
}

export async function reconcileJournalInTransaction(
  deps: MemoryServiceDependencies,
  transaction: WorkingSql,
  agentId: number,
  update: JournalWorkingUpdate,
  now: Date = dependencyNow(deps)
): Promise<WorkingItem[]> {
  validateAgentId(agentId);
  if (!Array.isArray(update.activeThreads) || !Array.isArray(update.concerns)) {
    throw new WorkingSetValidationError(
      "invalid_journal_update",
      "Journal working updates require thread and concern arrays"
    );
  }
  await lockWorkingSet(transaction, agentId);
  const nowIso = now.toISOString();
  await closeStaleItems(transaction, agentId, nowIso);

  const pending = new Map<
    string,
    { kind: "current_task" | "constraint"; content: string; order: number }
  >();
  for (const [index, raw] of update.activeThreads.entries()) {
    const content = boundedTrimmed(raw, "active_thread", 8192);
    const normalized = normalizeJournalText(content);
    if (!normalized) continue;
    const callerKey = journalCallerKey("thread", content);
    if (!pending.has(callerKey)) {
      pending.set(callerKey, {
        kind: "current_task",
        content,
        order: index,
      });
    }
  }
  for (const [index, raw] of update.concerns.entries()) {
    const content = boundedTrimmed(raw, "concern", 8192);
    const normalized = normalizeJournalText(content);
    if (!normalized) continue;
    const callerKey = journalCallerKey("concern", content);
    if (!pending.has(callerKey)) {
      pending.set(callerKey, {
        kind: "constraint",
        content,
        order: 10_000 + index,
      });
    }
  }

  for (const [callerKey, item] of pending) {
    await upsertInTransaction(
      deps,
      transaction,
      {
        agentId,
        callerKey,
        kind: item.kind,
        content: item.content,
        importance: item.kind === "constraint" ? 0.9 : 0.8,
        displayOrder: item.order,
      },
      now
    );
  }

  const resolvedKeys = [
    ...new Set(
      (update.resolvedCallerKeys ?? []).map((key) =>
        boundedTrimmed(key, "resolved_caller_key", 256)
      )
    ),
  ];
  if (resolvedKeys.length > 0) {
    await transaction`
      UPDATE public.working_memory_items
      SET status = 'resolved',
          resolved_at = ${nowIso}::timestamptz,
          resolution_reason = 'journal_explicit_resolution',
          updated_at = ${nowIso}::timestamptz
      WHERE agent_id = ${agentId}
        AND caller_key = ANY(${transaction.array(resolvedKeys)}::text[])
        AND status = 'active'
    `;
  }

  await enforceBound(transaction, agentId, nowIso);
  const touchedKeys = [...new Set([...pending.keys(), ...resolvedKeys])];
  if (touchedKeys.length === 0) return [];
  return rows<WorkingItemRow>(await transaction`
    SELECT *
    FROM public.working_memory_items
    WHERE agent_id = ${agentId}
      AND caller_key = ANY(${transaction.array(touchedKeys)}::text[])
    ORDER BY display_order ASC, importance DESC, last_confirmed_at DESC, id ASC
  `).map(toWorkingItem);
}

export function createWorkingSetService(
  deps: MemoryServiceDependencies
): WorkingSetService {
  async function list(agentId: number, limit = MAX_ACTIVE_WORKING_ITEMS) {
    validateAgentId(agentId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVE_WORKING_ITEMS) {
      throw new WorkingSetValidationError(
        "invalid_limit",
        `limit must be an integer from 1 to ${MAX_ACTIVE_WORKING_ITEMS}`
      );
    }
    const now = dependencyNow(deps).toISOString();
    return deps.sql.begin(async (transaction) => {
      await lockWorkingSet(transaction, agentId);
      await closeStaleItems(transaction, agentId, now);
      return rows<WorkingItemRow>(await transaction`
        SELECT item.*
        FROM public.working_memory_items AS item
        WHERE item.agent_id = ${agentId}
          AND item.status = 'active'
          AND item.expires_at > ${now}::timestamptz
        ORDER BY
          item.display_order ASC,
          item.importance DESC,
          item.last_confirmed_at DESC,
          item.id ASC
        LIMIT ${limit}
      `).map(toWorkingItem);
    });
  }

  async function upsert(input: UpsertWorkingItemInput): Promise<WorkingItem> {
    const now = dependencyNow(deps);
    // Validate before acquiring a connection or revealing whether an agent
    // exists. The transaction repeats normalization at the mutation boundary.
    normalizeUpsert(input, now);
    return deps.sql.begin(async (transaction) => {
      await lockWorkingSet(transaction, input.agentId);
      await closeStaleItems(transaction, input.agentId, now.toISOString());
      const inserted = await upsertInTransaction(deps, transaction, input, now);
      await enforceBound(transaction, input.agentId, now.toISOString());
      return (await loadById(transaction, input.agentId, inserted.id)) ?? inserted;
    });
  }

  async function terminalize(
    agentId: number,
    id: string,
    status: "resolved" | "expired",
    reason: string
  ): Promise<WorkingItem | null> {
    validateAgentId(agentId);
    validateId(id);
    const boundedReason = boundedTrimmed(reason, "reason", 512);
    const now = dependencyNow(deps).toISOString();
    return deps.sql.begin(async (transaction) => {
      await lockWorkingSet(transaction, agentId);
      const updated = rows<WorkingItemRow>(await transaction`
        UPDATE public.working_memory_items
        SET status = ${status},
            resolved_at = ${now}::timestamptz,
            resolution_reason = ${boundedReason},
            updated_at = ${now}::timestamptz
        WHERE id = ${id}::uuid
          AND agent_id = ${agentId}
          AND status = 'active'
        RETURNING *
      `);
      if (updated[0]) return toWorkingItem(updated[0]);
      const existing = await loadById(transaction, agentId, id);
      return existing?.status === status ? existing : null;
    });
  }

  async function resolve(agentId: number, id: string, reason: string) {
    return terminalize(agentId, id, "resolved", reason);
  }

  async function expire(agentId: number, id: string, reason: string) {
    return terminalize(agentId, id, "expired", reason);
  }

  async function reconfirm(
    agentId: number,
    id: string,
    expiresAt?: string
  ): Promise<WorkingItem | null> {
    validateAgentId(agentId);
    validateId(id);
    const nowDate = dependencyNow(deps);
    const now = nowDate.toISOString();
    const expiry = normalizedExpiry(expiresAt, nowDate);
    return deps.sql.begin(async (transaction) => {
      await lockWorkingSet(transaction, agentId);
      await closeStaleItems(transaction, agentId, now);
      const existing = await loadById(transaction, agentId, id);
      if (!existing || existing.status !== "active") return null;
      const normalized = normalizeUpsert(
        {
          agentId,
          callerKey: existing.callerKey,
          kind: existing.kind,
          content: existing.content,
          importance: existing.importance,
          displayOrder: existing.displayOrder,
          sourceMemoryId: existing.sourceMemoryId,
          sourceEventId: existing.sourceEventId,
          expiresAt: expiry,
        } as UpsertWorkingItemInput,
        nowDate
      );
      await assertCurrentSources(transaction, normalized, now);
      const updated = rows<WorkingItemRow>(await transaction`
        UPDATE public.working_memory_items
        SET last_confirmed_at = ${now}::timestamptz,
            expires_at = ${expiry}::timestamptz,
            updated_at = ${now}::timestamptz
        WHERE id = ${id}::uuid
          AND agent_id = ${agentId}
          AND status = 'active'
        RETURNING *
      `);
      await enforceBound(transaction, agentId, now);
      return updated[0] ? (await loadById(transaction, agentId, id)) : null;
    });
  }

  async function reconcileJournal(
    agentId: number,
    update: JournalWorkingUpdate
  ): Promise<WorkingItem[]> {
    const now = dependencyNow(deps);
    return deps.sql.begin((transaction) =>
      reconcileJournalInTransaction(deps, transaction, agentId, update, now)
    );
  }

  return Object.freeze({
    list,
    upsert,
    resolve,
    expire,
    reconfirm,
    reconcileJournal,
  });
}
