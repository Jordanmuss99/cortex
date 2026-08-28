import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  createMemoryServices,
  MAX_ACTIVE_WORKING_ITEMS,
  MAX_WORKING_EXPIRY_DAYS,
} from "../memory/index.js";
import type {
  MemoryServices,
  UpsertWorkingItemInput,
  WorkingItem,
  WorkingItemKind,
} from "../memory/types.js";
import { WorkingSetValidationError } from "../memory/types.js";

export interface WorkingSetRouterOptions {
  resolveAgentId?(externalId: string): Promise<number | null>;
}

const WORKING_KINDS = new Set<WorkingItemKind>([
  "current_task",
  "open_loop",
  "constraint",
  "correction",
  "preference",
]);
const POST_FIELDS = new Set([
  "agentId",
  "callerKey",
  "kind",
  "content",
  "importance",
  "displayOrder",
  "expiresAt",
  "sourceMemoryId",
  "sourceEventId",
]);
const PATCH_FIELDS = new Set(["agentId", "action", "reason", "expiresAt"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1_000;

async function resolveExternalAgentId(
  externalId: string
): Promise<number | null> {
  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.externalId, externalId));
  return agent?.id ?? null;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkingSetValidationError(
      "invalid_body",
      "A JSON object is required"
    );
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>
): void {
  const unexpected = Object.keys(body).find((field) => !allowed.has(field));
  if (unexpected) {
    throw new WorkingSetValidationError(
      "invalid_body",
      `Unexpected field: ${unexpected}`
    );
  }
}

function publicItem(item: WorkingItem) {
  const { agentId: _agentId, ...safe } = item;
  return safe;
}

function requiredAgent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > 64
  ) {
    throw new WorkingSetValidationError(
      "invalid_agent",
      "agentId must be 1 to 64 trimmed UTF-8 bytes"
    );
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkingSetValidationError(
      `invalid_${field}`,
      `${field} must be a finite number`
    );
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  const parsed = optionalNumber(value, field);
  if (parsed === undefined) return undefined;
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkingSetValidationError(
      `invalid_${field}`,
      `${field} must be an integer`
    );
  }
  return parsed;
}

function optionalString(
  value: unknown,
  field: string
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new WorkingSetValidationError(
      `invalid_${field}`,
      `${field} must be a string`
    );
  }
  return value;
}

function boundedTrimmedString(
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

function validatedExpiry(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const expiresAt = optionalString(value, "expires_at");
  if (typeof expiresAt !== "string") {
    throw new WorkingSetValidationError(
      "invalid_expires_at",
      "expiresAt must be a string"
    );
  }
  const parsed = new Date(expiresAt);
  const delta = parsed.getTime() - Date.now();
  if (
    !Number.isFinite(parsed.getTime()) ||
    delta <= 0 ||
    delta > MAX_WORKING_EXPIRY_DAYS * DAY_MS
  ) {
    throw new WorkingSetValidationError(
      "invalid_expires_at",
      `expiresAt must be later than now and no more than ${MAX_WORKING_EXPIRY_DAYS} days away`
    );
  }
  return parsed.toISOString();
}

function parseUpsert(
  body: Record<string, unknown>,
  agentId: number
): UpsertWorkingItemInput {
  if (typeof body.kind !== "string" || !WORKING_KINDS.has(body.kind as WorkingItemKind)) {
    throw new WorkingSetValidationError(
      "invalid_kind",
      "kind must be current_task, open_loop, constraint, correction, or preference"
    );
  }
  if (typeof body.callerKey !== "string" || typeof body.content !== "string") {
    throw new WorkingSetValidationError(
      "invalid_working_item",
      "callerKey and content are required"
    );
  }
  const sourceMemoryId = optionalInteger(
    body.sourceMemoryId,
    "source_memory_id"
  );
  if (
    sourceMemoryId !== undefined &&
    (sourceMemoryId <= 0 || sourceMemoryId > 2_147_483_647)
  ) {
    throw new WorkingSetValidationError(
      "invalid_source_memory_id",
      "sourceMemoryId must be a positive PostgreSQL integer"
    );
  }
  const sourceEventId = optionalString(body.sourceEventId, "source_event_id");
  if (sourceEventId !== undefined && sourceEventId !== null && !UUID_PATTERN.test(sourceEventId)) {
    throw new WorkingSetValidationError(
      "invalid_source_event_id",
      "sourceEventId must be a UUID"
    );
  }
  const importance = optionalNumber(body.importance, "importance");
  if (importance !== undefined && (importance < 0 || importance > 1)) {
    throw new WorkingSetValidationError(
      "invalid_importance",
      "importance must be between 0 and 1"
    );
  }
  const displayOrder = optionalInteger(body.displayOrder, "display_order");
  if (
    displayOrder !== undefined &&
    (displayOrder < -1_000_000 || displayOrder > 1_000_000)
  ) {
    throw new WorkingSetValidationError(
      "invalid_display_order",
      "displayOrder must be an integer from -1000000 to 1000000"
    );
  }
  const expiresAt = validatedExpiry(body.expiresAt);
  const base = {
    agentId,
    callerKey: boundedTrimmedString(body.callerKey, "caller_key", 256),
    content: boundedTrimmedString(body.content, "content", 8192),
    importance,
    displayOrder,
    expiresAt,
    sourceEventId,
  };
  if (body.kind === "correction") {
    if (sourceMemoryId === undefined) {
      throw new WorkingSetValidationError(
        "correction_source_required",
        "Correction working items require sourceMemoryId"
      );
    }
    return { ...base, kind: "correction", sourceMemoryId };
  }
  return {
    ...base,
    kind: body.kind as Exclude<WorkingItemKind, "correction">,
    sourceMemoryId,
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof WorkingSetValidationError) {
    const code = new Set([
      "source_memory_not_current",
      "source_event_not_indexed",
    ]).has(error.code)
      ? "invalid_working_item_source"
      : error.code;
    const status = error.code === "agent_not_found" ? 404 : 400;
    const message = code === "invalid_working_item_source"
      ? "Working item source is invalid"
      : error.message;
    res.status(status).json({ error: code, message });
    return;
  }
  console.error("[working-set] Request failed", {
    errorType: error instanceof Error ? error.name : "unknown",
  });
  res.status(500).json({ error: "working_set_failed" });
}

export function createWorkingSetRouter(
  services: MemoryServices = createMemoryServices(),
  options: WorkingSetRouterOptions = {}
): Router {
  const router = Router();
  const resolveAgentId = options.resolveAgentId ?? resolveExternalAgentId;
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req: Request, res: Response) => {
    try {
      const unexpectedQuery = Object.keys(req.query).find(
        (field) => field !== "agentId" && field !== "limit"
      );
      if (unexpectedQuery) {
        throw new WorkingSetValidationError(
          "invalid_query",
          `Unexpected query field: ${unexpectedQuery}`
        );
      }
      const externalAgentId = requiredAgent(req.query.agentId);
      const limitValue = req.query.limit;
      const limit =
        limitValue === undefined
          ? undefined
          : Number.parseInt(String(limitValue), 10);
      if (
        limitValue !== undefined &&
        (!/^(?:[1-9]|1[0-2])$/.test(String(limitValue)) ||
          !Number.isSafeInteger(limit) ||
          limit === undefined ||
          limit < 1 ||
          limit > MAX_ACTIVE_WORKING_ITEMS)
      ) {
        throw new WorkingSetValidationError(
          "invalid_limit",
          "limit must be an integer"
        );
      }
      const agentId = await resolveAgentId(externalAgentId);
      if (agentId === null) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      const items = await services.workingSet.list(agentId, limit);
      res.json({
        agentId: externalAgentId,
        itemCount: items.length,
        items: items.map(publicItem),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/", async (req: Request, res: Response) => {
    try {
      const body = bodyObject(req.body);
      assertOnlyFields(body, POST_FIELDS);
      const externalAgentId = requiredAgent(body.agentId);
      const validated = parseUpsert(body, 1);
      const agentId = await resolveAgentId(externalAgentId);
      if (agentId === null) {
        res.status(404).json({ error: "agent_not_found" });
        return;
      }
      const item = await services.workingSet.upsert({
        ...validated,
        agentId,
      } as UpsertWorkingItemInput);
      res.status(200).json({ agentId: externalAgentId, item: publicItem(item) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/:id", async (req: Request, res: Response) => {
    try {
      const body = bodyObject(req.body);
      assertOnlyFields(body, PATCH_FIELDS);
      const externalAgentId = requiredAgent(body.agentId);
      const operation = body.action;
      if (
        operation !== "resolve" &&
        operation !== "expire" &&
        operation !== "reconfirm"
      ) {
        throw new WorkingSetValidationError(
          "invalid_operation",
          "action must be resolve, expire, or reconfirm"
        );
      }
      const itemId = Array.isArray(req.params.id)
        ? req.params.id[0]
        : req.params.id;
      if (typeof itemId !== "string" || !UUID_PATTERN.test(itemId)) {
        res.status(404).json({ error: "working_item_not_found" });
        return;
      }
      const expiresAt = operation === "reconfirm"
        ? validatedExpiry(body.expiresAt)
        : undefined;
      const reason = operation === "reconfirm"
        ? undefined
        : boundedTrimmedString(body.reason, "reason", 512);
      if (operation === "reconfirm" && body.reason !== undefined) {
        throw new WorkingSetValidationError(
          "invalid_reason",
          "reason is not accepted for reconfirm"
        );
      }
      if (operation !== "reconfirm" && body.expiresAt !== undefined) {
        throw new WorkingSetValidationError(
          "invalid_expires_at",
          "expiresAt is accepted only for reconfirm"
        );
      }
      const agentId = await resolveAgentId(externalAgentId);
      if (agentId === null) {
        res.status(404).json({ error: "working_item_not_found" });
        return;
      }
      let item;
      if (operation === "reconfirm") {
        item = await services.workingSet.reconfirm(
          agentId,
          itemId,
          expiresAt
        );
      } else {
        item =
          operation === "resolve"
            ? await services.workingSet.resolve(
                agentId,
                itemId,
                reason!
              )
            : await services.workingSet.expire(
                agentId,
                itemId,
                reason!
              );
      }
      if (!item) {
        res.status(404).json({ error: "working_item_not_found" });
        return;
      }
      res.json({ agentId: externalAgentId, item: publicItem(item) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
