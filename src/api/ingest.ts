import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createMemoryServices } from "../memory/index.js";
import {
  IdempotencyConflictError,
  IngestValidationError,
  type AcceptIngestInput,
  type IngestReceipt,
  type MemoryServices,
} from "../memory/types.js";

export interface IngestRouterOptions {
  resolveAgentId?(externalId: string): Promise<number | null>;
}

async function resolveExternalAgentId(
  externalId: string
): Promise<number | null> {
  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.externalId, externalId));
  return agent?.id ?? null;
}

function hasInternalProvenance(body: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(body, "externalProvenance") ||
    Object.hasOwn(body, "derivedProvenance")
  );
}

function stringArray(
  value: unknown,
  field: string
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new IngestValidationError(
      `invalid_${field}`,
      `${field} must be an array of strings`
    );
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new IngestValidationError(`invalid_${field}`, `${field} must be a string`);
  }
  return value;
}

function boundedOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  allowNull = true
): string | null | undefined {
  const parsed = optionalString(value, field);
  if (parsed === null && !allowNull) {
    throw new IngestValidationError(
      `invalid_${field}`,
      `${field} must be a string`
    );
  }
  if (typeof parsed === "string" && parsed.length > maxLength) {
    throw new IngestValidationError(
      `invalid_${field}`,
      `${field} must be at most ${maxLength} characters`
    );
  }
  return parsed;
}

function optionalProjectionMode(value: unknown): AcceptIngestInput["projectionMode"] {
  if (value === undefined) return undefined;
  if (
    value !== "append" &&
    value !== "replace_source" &&
    value !== "reconsolidate"
  ) {
    throw new IngestValidationError(
      "invalid_projection_mode",
      "projectionMode is invalid"
    );
  }
  return value;
}

function optionalPredecessorMemoryId(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new IngestValidationError(
      "invalid_predecessor_memory_id",
      "predecessorMemoryId must be a positive integer"
    );
  }
  return Number(value);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new IngestValidationError(
      `invalid_${field}`,
      `${field} must be a boolean`
    );
  }
  return value;
}

function optionalWaitMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 20_000) {
    throw new IngestValidationError(
      "invalid_wait",
      "waitMs must be an integer from 0 to 20000"
    );
  }
  return Number(value);
}

function parseRequest(body: unknown, agentId: number): AcceptIngestInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IngestValidationError("invalid_body", "A JSON object is required");
  }
  const value = body as Record<string, unknown>;
  if (hasInternalProvenance(value)) {
    throw new IngestValidationError(
      "internal_provenance_forbidden",
      "Internal provenance fields are not accepted by the public API"
    );
  }
  if (typeof value.content !== "string" || value.content.trim().length === 0) {
    throw new IngestValidationError(
      "invalid_content",
      "agentId and content required"
    );
  }
  const sourceType = value.sourceType === undefined ? "api" : value.sourceType;
  if (
    typeof sourceType !== "string" ||
    sourceType !== sourceType.trim() ||
    sourceType.length < 1 ||
    sourceType.length > 64
  ) {
    throw new IngestValidationError(
      "invalid_source_type",
      "sourceType must be 1 to 64 trimmed characters"
    );
  }
  const priority = value.priority === undefined ? 2 : value.priority;
  if (
    !Number.isInteger(priority) ||
    Number(priority) < 0 ||
    Number(priority) > 4
  ) {
    throw new IngestValidationError(
      "invalid_priority",
      "priority must be an integer from 0 to 4"
    );
  }

  return {
    agentId,
    content: value.content,
    idempotencyKey: boundedOptionalString(
      value.idempotencyKey,
      "idempotencyKey",
      256,
      false
    ) ?? undefined,
    source: optionalString(value.source, "source"),
    sourceVersion: optionalString(value.sourceVersion, "sourceVersion"),
    sourceType,
    observedAt: optionalString(value.observedAt, "observedAt"),
    validFrom: optionalString(value.validFrom, "validFrom"),
    validUntil: optionalString(value.validUntil, "validUntil"),
    requestedPriority: Number(priority) as 0 | 1 | 2 | 3 | 4,
    providedEntities: stringArray(value.entities, "entities"),
    providedSemanticTags: stringArray(value.semanticTags, "semanticTags"),
    requestId: boundedOptionalString(value.requestId, "requestId", 128),
    sessionId: boundedOptionalString(value.sessionId, "sessionId", 128),
    projectionMode: optionalProjectionMode(value.projectionMode),
    predecessorMemoryId: optionalPredecessorMemoryId(value.predecessorMemoryId),
    forceNewProjection: optionalBoolean(
      value.forceNewProjection,
      "forceNewProjection"
    ),
  };
}

function httpStatusFor(receipt: IngestReceipt): number {
  if (receipt.status === "indexed") return 200;
  if (receipt.status === "rejected") return 422;
  if (receipt.status === "failed" && !receipt.failure?.retryable) return 503;
  return 202;
}

function publicReceipt(agentId: string, receipt: IngestReceipt) {
  return { agentId, ...receipt };
}

function validEventId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function createIngestRouter(
  services: MemoryServices = createMemoryServices(),
  options: IngestRouterOptions = {}
): Router {
  const router = Router();
  const resolveAgentId = options.resolveAgentId ?? resolveExternalAgentId;

  router.post("/", async (req: Request, res: Response) => {
    try {
      const body = req.body as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new IngestValidationError("invalid_body", "A JSON object is required");
      }
      const raw = body as Record<string, unknown>;
      if (hasInternalProvenance(raw)) {
        throw new IngestValidationError(
          "internal_provenance_forbidden",
          "Internal provenance fields are not accepted by the public API"
        );
      }
      if (typeof raw.agentId !== "string" || !raw.agentId.trim()) {
        throw new IngestValidationError(
          "invalid_agent",
          "agentId and content required"
        );
      }
      const waitMs = optionalWaitMs(raw.waitMs);
      const externalAgentId = raw.agentId;
      const numericAgentId = await resolveAgentId(externalAgentId);
      if (numericAgentId === null) {
        res.status(404).json({ error: `Agent '${externalAgentId}' not found` });
        return;
      }

      const input = parseRequest(raw, numericAgentId);
      const acceptanceReceipt = await services.ingest.accept(input);
      let receipt = acceptanceReceipt;
      if (waitMs !== undefined && waitMs > 0) {
        try {
          const waitedReceipt = await services.ingest.wait(
            numericAgentId,
            acceptanceReceipt.eventId,
            waitMs
          );
          receipt = {
            ...waitedReceipt,
            replayed: acceptanceReceipt.replayed,
          };
        } catch {
          console.error(
            "[ingest] Optional status wait failed after durable acceptance",
            {
              eventId: acceptanceReceipt.eventId,
              code: "ingest_wait_failed",
            }
          );
        }
      }

      res
        .status(httpStatusFor(receipt))
        .json(publicReceipt(externalAgentId, receipt));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        res.status(409).json({
          error: error.code,
          eventId: error.existingId,
        });
        return;
      }
      if (error instanceof IngestValidationError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      console.error("[ingest] Durable acceptance failed", {
        code: "ingest_acceptance_failed",
      });
      res.status(500).json({ error: "Ingestion failed" });
    }
  });

  router.get("/:eventId", async (req: Request, res: Response) => {
    try {
      const eventId = Array.isArray(req.params.eventId)
        ? req.params.eventId[0] ?? ""
        : req.params.eventId;
      const externalAgentId =
        typeof req.query.agentId === "string" ? req.query.agentId : "";
      if (!externalAgentId || !validEventId(eventId)) {
        res.status(404).json({ error: "Ingest event not found" });
        return;
      }
      const numericAgentId = await resolveAgentId(externalAgentId);
      if (numericAgentId === null) {
        res.status(404).json({ error: "Ingest event not found" });
        return;
      }
      const receipt = await services.ingest.get(
        numericAgentId,
        eventId
      );
      if (!receipt) {
        res.status(404).json({ error: "Ingest event not found" });
        return;
      }
      res.json(publicReceipt(externalAgentId, receipt));
    } catch {
      console.error("[ingest] Status lookup failed", {
        code: "ingest_status_lookup_failed",
      });
      res.status(500).json({ error: "Ingest status lookup failed" });
    }
  });

  return router;
}
