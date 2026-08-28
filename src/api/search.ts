import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  createMemoryServices,
  isValidRetrievalQuery,
} from "../memory/index.js";
import type {
  MemoryServices,
  RetrievalChannel,
  RetrievedItem,
} from "../memory/types.js";

type RetrievedMemoryItem = Extract<RetrievedItem, { kind: "memory" }>;

export interface SearchResult {
  id: number;
  content: string;
  source: string | null;
  sourceType: string | null;
  priority: number | null;
  resonanceScore: number | null;
  entities: string[] | null;
  semanticTags: string[] | null;
  createdAt: string;
  validFrom: string | null;
  validUntil: string | null;
  supersededBy: number | null;
  score: number;
  hybridScore: number;
  scoreBreakdown: {
    cosine: number;
    textMatch: number;
    recency: number;
    resonance: number;
    priorityBoost: number;
    emotionalBoost: number;
    ca3Activation: number;
  };
}

export interface HybridSearchOptions {
  agentId: number;
  query: string;
  limit?: number;
  /** Retained for source compatibility; persistence is bounded by shared config. */
  candidateLimit?: number;
  enableCA3?: boolean;
  /** Retained for deterministic legacy callers and disposable tests. */
  queryEmbedding?: number[];
  channel?: RetrievalChannel;
  requestId?: string | null;
  sessionId?: string | null;
}

export interface SearchRouterOptions {
  resolveAgentId?(externalId: string): Promise<number | null>;
}

const MAX_CORRELATION_BYTES = 128;

function isValidCorrelationId(value: string): boolean {
  return (
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= MAX_CORRELATION_BYTES &&
    !value.includes("\u0000")
  );
}

export function isRetrievedMemoryItem(
  item: RetrievedItem
): item is RetrievedMemoryItem {
  return item.kind === "memory";
}

export function toLegacySearchResult(item: RetrievedMemoryItem): SearchResult {
  const compatibility = item.compatibility;
  return {
    id: item.memoryId,
    content: item.content,
    source: item.source,
    sourceType: compatibility.sourceType,
    priority: item.priority,
    resonanceScore: item.resonance,
    entities: compatibility.entities,
    semanticTags: compatibility.semanticTags,
    createdAt: compatibility.createdAt,
    validFrom: compatibility.validFrom,
    validUntil: compatibility.validUntil,
    supersededBy: compatibility.supersededBy,
    score: item.score,
    hybridScore: compatibility.hybridScore,
    scoreBreakdown: { ...compatibility.scoreBreakdown },
  };
}

function toRestSearchResult(item: RetrievedMemoryItem) {
  return {
    ...toLegacySearchResult(item),
    retrievalItemId: item.retrievalItemId,
    kind: item.kind,
    currentness: item.currentness,
    finalRank: item.finalRank,
    componentRanks: item.componentRanks.map((rank) => ({ ...rank })),
    reasons: [...item.reasons],
    provenance: item.provenance.map((entry) => ({ ...entry })),
    provenanceTruncated: item.provenanceTruncated,
  };
}

let defaultLegacyServices: MemoryServices | undefined;

function servicesForLegacySearch(queryEmbedding?: number[]): MemoryServices {
  if (queryEmbedding === undefined) {
    defaultLegacyServices ??= createMemoryServices();
    return defaultLegacyServices;
  }

  if (
    queryEmbedding.length !== 1024 ||
    queryEmbedding.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError("queryEmbedding must contain 1024 finite values");
  }
  const norm = Math.sqrt(
    queryEmbedding.reduce((sum, value) => sum + value * value, 0)
  );
  if (!Number.isFinite(norm) || norm === 0) {
    throw new TypeError("queryEmbedding must have a finite non-zero norm");
  }
  const values = queryEmbedding.map((value) => value / norm);
  return createMemoryServices({
    embedQuery: async () => ({
      values,
      provider: "compatibility",
      model: "caller-provided-query",
      dimensions: values.length,
      normalized: true,
    }),
  });
}

/**
 * Compatibility wrapper for pre-retrieval internal callers.
 *
 * It prepares ranked candidates, closes the retrieval with an empty delivered
 * set, and projects the historical SearchResult array. This is deliberately
 * candidate-only so pre-Slice-8 recall packing cannot make every inspected
 * candidate labile before deciding which records were actually exposed.
 */
export async function hybridSearch(
  options: HybridSearchOptions,
  services?: MemoryServices
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const sharedServices =
    services ?? servicesForLegacySearch(options.queryEmbedding);
  const prepared = await sharedServices.retrieval.prepare({
    agentId: options.agentId,
    query: options.query,
    channel: options.channel ?? "search",
    requestId: options.requestId,
    sessionId: options.sessionId,
    limit,
    enableCA3: options.enableCA3,
  });

  // Finalize the evidence header without marking any candidate returned or
  // touching a memory node. Recall gains selected delivery in Slice 8.
  await sharedServices.retrieval.deliver(prepared, []);

  return prepared.candidates
    .slice(0, limit)
    .filter(isRetrievedMemoryItem)
    .map(toLegacySearchResult);
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

export function createSearchRouter(
  services: MemoryServices = createMemoryServices(),
  options: SearchRouterOptions = {}
): Router {
  const router = Router();
  const resolveAgentId = options.resolveAgentId ?? resolveExternalAgentId;

  router.post("/", async (req: Request, res: Response) => {
    try {
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const query = body.query;
      const externalAgentId = body.agentId;
      const limit = body.limit === undefined ? 10 : body.limit;

      if (
        typeof query !== "string" ||
        query.trim().length === 0 ||
        typeof externalAgentId !== "string" ||
        externalAgentId.trim().length === 0
      ) {
        res.status(400).json({ error: "query and agentId required" });
        return;
      }
      if (!isValidRetrievalQuery(query)) {
        res.status(400).json({
          error: "query must be at most 8192 UTF-8 bytes and contain no NUL",
        });
        return;
      }
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) {
        res.status(400).json({
          error: "limit must be an integer from 1 to 50",
        });
        return;
      }

      const requestIdHeader = req.get("x-request-id");
      if (
        requestIdHeader !== undefined &&
        !isValidCorrelationId(requestIdHeader)
      ) {
        res.status(400).json({
          error: "x-request-id must be 1 to 128 trimmed UTF-8 bytes",
        });
        return;
      }
      if (
        body.sessionId !== undefined &&
        body.sessionId !== null &&
        (typeof body.sessionId !== "string" ||
          !isValidCorrelationId(body.sessionId))
      ) {
        res.status(400).json({
          error: "sessionId must be 1 to 128 trimmed UTF-8 bytes",
        });
        return;
      }
      const requestId = requestIdHeader ?? null;
      const sessionId =
        typeof body.sessionId === "string" ? body.sessionId : null;

      const agentId = await resolveAgentId(externalAgentId);
      if (agentId === null) {
        res.status(404).json({ error: `Agent '${externalAgentId}' not found` });
        return;
      }

      const retrieval = await services.retrieval.search({
        agentId,
        query,
        channel: "search",
        requestId,
        sessionId,
        limit: Number(limit),
      });
      const memoryResults = retrieval.results.filter(isRetrievedMemoryItem);

      res.json({
        query,
        agentId: externalAgentId,
        resultCount: memoryResults.length,
        results: memoryResults.map(toRestSearchResult),
        retrievalId: retrieval.retrievalId,
        algorithmVersion: retrieval.algorithmVersion,
        buildId: retrieval.buildId,
        candidateCount: retrieval.candidateCount,
        returnedCount: retrieval.returnedCount,
        elapsedMs: retrieval.elapsedMs,
        warnings: [...retrieval.warnings],
      });
    } catch (error) {
      console.error("[search] Search failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      res.status(500).json({ error: "Search failed" });
    }
  });

  return router;
}
