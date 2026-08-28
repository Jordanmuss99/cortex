#!/usr/bin/env node
/**
 * CORTEX V2 MCP Server
 *
 * Exposes CORTEX memory operations as native tools for Claude Code.
 * Any agent gets: cortex_search, cortex_recall, cortex_init,
 * cortex_ingest, cortex_dream, cortex_status as tool calls.
 *
 * Run via: npx tsx src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PassThrough } from "node:stream";
import { z } from "zod";
import {
  closeDatabaseConnection,
  db,
  schema,
  initDatabase,
} from "../db/index.js";
import { scrubEmDashes } from "../lib/scrub.js";
import {
  hybridSearch,
  isRetrievedMemoryItem,
  toLegacySearchResult,
} from "../api/search.js";
import { countTokens } from "../ingestion/chunker.js";
import {
  ingestCorpus,
  submitFileSnapshot,
} from "../ingestion/ingest-markdown.js";
import { indexedProjectionFields } from "../memory/ingest.js";
import {
  createMemoryServices,
  isValidRetrievalQuery,
  MAX_RETRIEVAL_QUERY_BYTES,
} from "../memory/index.js";
import {
  IdempotencyConflictError,
  IngestValidationError,
  type IngestReceipt,
  type IngestService,
  type IngestStatus,
} from "../memory/types.js";
import { runDreamCycle, phaseSynthesis } from "../dream/dream-cycle.js";
import { runSelfCheck, formatDiagnostic } from "../proprioception/self-check.js";
import { writeJournalEntry, getRecentJournal, formatJournalEntries } from "../proprioception/journal.js";
import { assessPrincipalState, getStateHistory, formatStateAssessment, formatStateHistory } from "../empathy/state-model.js";
import { runStrategicThread, runOperationalThread, runRelationalThread, formatThreadResult } from "../cognition/background-threads.js";
import { captureAndAnalyze, ingestObservation, formatObservation, ScreenCaptureUnavailableError, shouldStoreScreenObservation } from "../perception/screen-observer.js";
import { getRelationship, listRelationships, updateRelationship, addOpenItem, formatRelationship, formatRelationshipList } from "../social/relationships.js";
import { storeReasoningTrace } from "../metacognition/reasoning.js";
import { runWeeklyAudit, formatAuditResult } from "../metacognition/audit.js";
import { writeInnerMonologue, getRecentMonologue, formatMonologue } from "../metacognition/inner-monologue.js";
import { reconsolidate, getLabileMemories } from "../reconsolidation/index.js";
import { storeProcedural, retrieveProcedural, recordExecution, refineProcedural, InvalidSourceMemoryReferencesError, ProceduralMemoryNotFoundError } from "../procedural/index.js";
import { resolveImportFile } from "./import-security.js";
import { eq, sql, desc, and } from "drizzle-orm";
import "dotenv/config";
import * as crypto from "crypto";

const cortexBaseOutputShape = {
  ok: z.literal(true),
  tool: z.string(),
  request_id: z.string().uuid(),
  agent_id: z.string().min(1).max(128),
  warnings: z.array(z.string()),
  errors: z.array(z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).nullable()
  }).strict()),
  meta: z.object({
    schema_version: z.literal("cortex.mcp.v1"),
    latency_ms: z.number().nullable().optional()
  }).strict()
};

const ingestStatusOutputSchema = z.enum([
  "accepted",
  "processing",
  "indexed",
  "failed",
  "rejected",
]);

const ingestFailureOutputSchema = z.object({
  code: z.string(),
  retryable: z.boolean(),
}).strict();

const proceduralSourceMemoryIdsInputSchema = z.preprocess(
  (value) => Array.isArray(value) ? [...new Set(value)] : value,
  z.array(z.number().int().positive().max(2_147_483_647)).max(100)
);

const MCP_INGEST_WAIT_MS = 20_000;

function isIngestInFlight(status: IngestStatus): boolean {
  return status === "accepted" || status === "processing";
}

function isRetryableIngest(receipt: IngestReceipt): boolean {
  return receipt.status === "failed" && receipt.failure?.retryable === true;
}

async function waitForIngestReceipt(
  ingest: IngestService,
  agentId: number,
  accepted: IngestReceipt,
  failureCode: string
): Promise<IngestReceipt> {
  if (!isIngestInFlight(accepted.status)) return accepted;
  try {
    const waited = await ingest.wait(
      agentId,
      accepted.eventId,
      MCP_INGEST_WAIT_MS
    );
    return { ...waited, replayed: accepted.replayed };
  } catch {
    console.error("[cortex-mcp] Optional ingest wait failed", {
      eventId: accepted.eventId,
      code: failureCode,
    });
    return accepted;
  }
}

function ingestLifecycleSummary(
  receipt: IngestReceipt,
  indexedSummary: string
): string {
  if (receipt.status === "indexed") return indexedSummary;
  if (receipt.status === "rejected") {
    return `Ingest event ${receipt.eventId} was rejected (${receipt.failure?.code ?? "rejected"}).`;
  }
  if (receipt.status === "failed" && !receipt.failure?.retryable) {
    return `Ingest event ${receipt.eventId} failed (${receipt.failure?.code ?? "projection_failed"}).`;
  }
  const retry = isRetryableIngest(receipt)
    ? `; retry scheduled${receipt.nextAttemptAt ? ` for ${receipt.nextAttemptAt}` : ""}`
    : "";
  return `Durably accepted ingest event ${receipt.eventId}; indexing is not complete (status ${receipt.status}${retry}).`;
}

function makeStructuredResponse<TData>(
  tool: string,
  data: TData,
  humanReadable?: string,
  options: {
    agent_id?: string;
    request_id?: string;
    warnings?: string[];
    meta?: Record<string, unknown>;
  } = {}
) {
  const structuredContent = {
    ok: true,
    tool,
    request_id: options.request_id ?? crypto.randomUUID(),
    agent_id: options.agent_id ?? "arlo",
    data,
    warnings: options.warnings ?? [],
    errors: [],
    meta: {
      schema_version: "cortex.mcp.v1",
      ...options.meta
    }
  };

  return {
    content: [
      {
        type: "text" as const,
        text: humanReadable ?? JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}

function makeErrorResponse(
  tool: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  options: {
    agent_id?: string;
    request_id?: string;
  } = {}
) {
  const errorContent = {
    ok: false,
    tool,
    request_id: options.request_id ?? crypto.randomUUID(),
    agent_id: options.agent_id ?? "arlo",
    data: {},
    warnings: [],
    errors: [
      {
        code,
        message,
        details
      }
    ],
    meta: {
      schema_version: "cortex.mcp.v1"
    }
  };

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(errorContent, null, 2)
      }
    ]
  };
}

const server = new McpServer(
  {
    name: "cortex-v2",
    version: "2.4.0",
  },
  {
    // Delivered to every MCP client (Claude Desktop, Claude Code, OpenCode,
    // OpenClaw) at connection time. For clients with no other protocol
    // surface (Claude Desktop has no CLAUDE.md or hooks) this is the ONLY
    // standing instruction channel, so it carries the full loop.
    instructions: [
      "Cortex is the agent's persistent cross-session memory. Follow the Recall-and-Reconsolidate loop:",
      "1. Boot: call cortex_init at session start (skip if a Cortex context block was already auto-injected).",
      "2. Recall before deciding: cortex_search / cortex_recall before architectural decisions, debugging, or repeating past work - and at every new-task boundary. Delivered cortex_search memories become LABILE (updatable) for 1 hour; use cortex_search before reconsolidating a memory.",
      "3. Update over duplicate: if new information corrects or extends a recalled memory, call cortex_reconsolidate on that memory id. cortex_ingest durably accepts distinct captures; semantic similarity is only an update hint and never suppresses the raw event.",
      "4. Capture at the moment of discovery: when a durable fact lands (bug root cause, API gotcha, milestone state), write it THEN - cortex_ingest for novel facts with canonical entity names (e.g. 'SimsOnline', 'Cortex', 'OpenCode'). Do not batch captures to session end; teardown writes get lost.",
      "5. Skills: before a repeatable task, cortex_skill_retrieve; after applying one, cortex_skill_executed (proficiency only grows when executions are recorded); improve with cortex_skill_refine instead of storing variants. cortex_search also surfaces matching skills automatically.",
      "6. Record significant decisions with cortex_reason using an HONEST confidence (not 0.5 or 1.0); journal long sessions with cortex_journal.",
      "7. Lost? If you are unsure what to do next or about to ask the user 'what should I work on?', FIRST re-read cortex_init's Open Loops section or cortex_search for open work and recent journal entries - the answer is usually already in memory.",
      "8. State awareness: when the principal's recent messages show CLEAR state signals (frustration, fatigue, time pressure, rapid-fire terseness), call cortex_assess_state with those messages and adapt to the returned communication guidance. Skip it on sparse or neutral signal: few good assessments beat many noisy ones.",
      "9. Health: call cortex_vitals at boot (and when something feels off) to check memory-system health -- it surfaces early warnings (degraded self-check, duplicate formation, stale reflect/threads, growth imbalance) that you should act on or report.",
      "Style: never write em-dash characters into Cortex-bound content; use '--' instead (the drift self-check counts em-dashes).",
    ].join("\n"),
  }
);

// One immutable service bundle is shared by every durable MCP writer in this
// process. Provider work remains owned by the ingest worker, never the adapter.
const memoryServices = createMemoryServices();

const searchQueryInputSchema = z
  .string()
  .min(1)
  .max(MAX_RETRIEVAL_QUERY_BYTES)
  .refine(isValidRetrievalQuery, {
    message: "query must be nonblank, contain no NUL, and fit in 8192 UTF-8 bytes",
  });

const initContextHintInputSchema = z
  .string()
  .max(MAX_RETRIEVAL_QUERY_BYTES)
  .refine(
    (value) => value === value.trim() && isValidRetrievalQuery(value),
    {
      message:
        "context_hint must be trimmed, nonblank, contain no NUL, and fit in 8192 UTF-8 bytes",
    }
  );

const INIT_COMPATIBILITY_TOKEN_BUDGET = 800;

// Helper: resolve agent by external ID, create if missing
async function resolveAgent(externalId: string): Promise<number> {
  let [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.externalId, externalId));

  if (!agent) {
    [agent] = await db
      .insert(schema.agents)
      .values({
        externalId,
        name: externalId.charAt(0).toUpperCase() + externalId.slice(1),
        ownerId: "rez",
      })
      .returning({ id: schema.agents.id });
  }

  return agent.id;
}

// Read-only tools must never create database state. Callers that need to
// provision an agent use resolveAgent explicitly through a write-capable tool.
async function resolveExistingAgent(externalId: string): Promise<number | null> {
  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.externalId, externalId))
    .limit(1);

  return agent?.id ?? null;
}

const relationshipPublicSchema = z.object({
  person_name: z.string(),
  person_email: z.string().nullable(),
  relationship_type: z.string().nullable(),
  last_contact: z.string().nullable(),
  contact_frequency: z.string().nullable(),
  importance: z.number().nullable(),
  personality_model: z.record(z.unknown()),
  communication_preferences: z.record(z.unknown()),
  open_items: z.array(z.object({
    text: z.string(),
    done: z.boolean(),
    added_at: z.string().nullable(),
  }).strict()),
  notes: z.string().nullable(),
}).strict();

function toPublicRelationship(rel: typeof schema.relationshipGraph.$inferSelect) {
  const openItems = Array.isArray(rel.openItems)
    ? rel.openItems as Array<Record<string, unknown>>
    : [];

  return {
    person_name: rel.personName,
    person_email: rel.personEmail ?? null,
    relationship_type: rel.relationshipType ?? null,
    last_contact: rel.lastContact?.toISOString() ?? null,
    contact_frequency: rel.contactFrequency ?? null,
    importance: rel.importanceScore ?? null,
    personality_model: (rel.personalityModel ?? {}) as Record<string, unknown>,
    communication_preferences: (rel.communicationPrefs ?? {}) as Record<string, unknown>,
    open_items: openItems.map((item) => ({
      text: String(item.text ?? ""),
      done: Boolean(item.done),
      added_at: typeof item.addedAt === "string" ? item.addedAt : null,
    })),
    notes: rel.notes ?? null,
  };
}

// ─── Tool: cortex_search ────────────────────────────────
server.registerTool(
  "cortex_search",
  {
    description: "Search CORTEX memory with independently ranked lexical, semantic-vector, entity/tag, and optional graph evidence fused deterministically. Use this whenever you need to recall information from past conversations, files, transcripts, or any stored memory - and ALWAYS before asking the user what to do next (open work is usually already recorded). Delivered results enter a 1-hour LABILE window: if you then learn something that updates one of them, use cortex_reconsolidate on that memory id instead of ingesting a duplicate. Results also include matching procedural skills; if you apply one, record the outcome with cortex_skill_executed.",
    inputSchema: z.object({
      query: searchQueryInputSchema.describe("The search query, for example 'current Cortex authentication work'"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Max results to return (default: 10)"),
    verbose: z
      .boolean()
      .default(false)
      .describe("Include temporal validity, priority, resonance details (default: false)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        query: z.string(),
        results: z.array(z.object({
          memory_id: z.number(),
          source: z.string().nullable(),
          priority: z.number().nullable(),
          resonance: z.number().nullable(),
          score: z.number(),
          content: z.string(),
          tags: z.array(z.string()).nullable(),
          entities: z.array(z.string()).nullable(),
          created_at: z.string().nullable(),
          last_recalled_at: z.string().nullable().optional(),
          valid_from: z.string().nullable().optional(),
          valid_until: z.string().nullable().optional(),
          superseded_by: z.number().nullable(),
          metadata: z.record(z.unknown()).nullable(),
          retrieval_item_id: z.string().uuid(),
          kind: z.literal("memory"),
          currentness: z.number(),
          final_rank: z.number().int().positive(),
          component_ranks: z.array(z.object({
            lane: z.enum(["working", "lexical", "vector", "entity", "graph", "artifact"]),
            rank: z.number().int().positive(),
            source_score: z.number().optional()
          }).strict()),
          reasons: z.array(z.string()),
          provenance: z.array(z.object({
            event_id: z.string().uuid(),
            source: z.string().nullable(),
            source_type: z.string(),
            relation: z.enum(["captured_from", "corrects", "derived_from", "consolidates"]),
            confidence: z.number().nullable(),
            accepted_at: z.string()
          }).strict()),
          provenance_truncated: z.boolean()
        })),
        skills: z.array(z.object({
          procedural_id: z.number(),
          name: z.string(),
          type: z.string(),
          proficiency: z.string(),
          success_rate: z.number(),
          trigger_context: z.string()
        })),
        retrieval_id: z.string().uuid(),
        algorithm_version: z.string(),
        build_id: z.string(),
        candidate_count: z.number().int().nonnegative(),
        returned_count: z.number().int().nonnegative(),
        elapsed_ms: z.number().nonnegative(),
        warnings: z.array(z.string())
      })
    })
  },
  async ({ query, agent_id, limit, verbose }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse(
        "cortex_search",
        "agent_not_found",
        "The requested Cortex agent does not exist",
        {},
        { agent_id }
      );
    }
    const requestId = crypto.randomUUID();
    const retrieval = await memoryServices.retrieval.search({
      agentId,
      query,
      channel: "search",
      requestId,
      limit,
    });
    const memoryItems = retrieval.results.filter(isRetrievedMemoryItem);
    const results = memoryItems.map(toLegacySearchResult);

    const formatted = results
      .map((r) => {
        const src = r.source?.split("/").pop() || "unknown";
        const entities =
          r.entities?.length ? `\nEntities: ${r.entities.join(", ")}` : "";
        const tags =
          r.semanticTags?.length
            ? `\nTags: ${r.semanticTags.join(", ")}`
            : "";

        let verboseInfo = "";
        if (verbose) {
          const validity = [];
          if (r.validFrom) validity.push(`valid from ${r.validFrom}`);
          if (r.validUntil) validity.push(`valid until ${r.validUntil}`);
          if (r.supersededBy) validity.push(`superseded by #${r.supersededBy}`);
          verboseInfo = `\nPriority: P${r.priority ?? "?"} | Resonance: ${(r.resonanceScore ?? 0).toFixed(2)} | Score: ${r.score.toFixed(3)}${validity.length ? ` | ${validity.join(" | ")}` : ""}`;
        }

        return `### Memory #${r.id} [${src}] (score: ${r.score.toFixed(3)})${verboseInfo}\n${r.content}`;
      })
      .join("\n\n---\n\n");

    const structuredData = {
      query,
      results: memoryItems.map((item, index) => {
        const legacy = results[index];
        return {
          memory_id: legacy.id,
          source: legacy.source,
          priority: legacy.priority,
          resonance: legacy.resonanceScore,
          score: legacy.score,
          content: legacy.content,
          tags: legacy.semanticTags,
          entities: legacy.entities,
          created_at: legacy.createdAt
            ? new Date(legacy.createdAt).toISOString()
            : null,
          ...(legacy.validFrom
            ? { valid_from: new Date(legacy.validFrom).toISOString() }
            : {}),
          ...(legacy.validUntil
            ? { valid_until: new Date(legacy.validUntil).toISOString() }
            : {}),
          superseded_by: legacy.supersededBy ?? null,
          metadata: {},
          retrieval_item_id: item.retrievalItemId,
          kind: item.kind,
          currentness: item.currentness,
          final_rank: item.finalRank,
          component_ranks: item.componentRanks.map((rank) => ({
            lane: rank.lane,
            rank: rank.rank,
            ...(rank.sourceScore === undefined
              ? {}
              : { source_score: rank.sourceScore }),
          })),
          reasons: [...item.reasons],
          provenance: item.provenance.map((entry) => ({
            event_id: entry.eventId,
            source: entry.source,
            source_type: entry.sourceType,
            relation: entry.relation,
            confidence: entry.confidence,
            accepted_at: entry.acceptedAt,
          })),
          provenance_truncated: item.provenanceTruncated,
        };
      }),
      skills: [] as Array<{
        procedural_id: number;
        name: string;
        type: string;
        proficiency: string;
        success_rate: number;
        trigger_context: string;
      }>,
      retrieval_id: retrieval.retrievalId,
      algorithm_version: retrieval.algorithmVersion,
      build_id: retrieval.buildId,
      candidate_count: retrieval.candidateCount,
      returned_count: retrieval.returnedCount,
      elapsed_ms: retrieval.elapsedMs,
      warnings: [...retrieval.warnings],
    };

    // Skill discovery rides every search (utilization research 2026-06-12:
    // agents never call cortex_skill_retrieve unprompted - 15 skills, 1
    // recorded execution - so matching skills must surface here, where the
    // agent already is). Best-effort: a skills failure never breaks search.
    let skillsBlock = "";
    try {
      // 0.40 floor calibrated 2026-06-12: direct task matches score 0.55+,
      // related workflows 0.40-0.45, noise falls below 0.35.
      const skillMatches = (await retrieveProcedural(agentId, query, 3)).filter(
        (m) => m.matchType === "trigger" || m.relevanceScore >= 0.4
      );
      if (skillMatches.length > 0) {
        const lines = skillMatches.map((m) => {
          const sm = m.memory;
          const runs =
            sm.executionCount > 0
              ? `${(sm.successRate * 100).toFixed(0)}% over ${sm.executionCount} runs`
              : "never executed yet";
          structuredData.skills.push({
            procedural_id: sm.id,
            name: sm.name,
            type: sm.proceduralType,
            proficiency: sm.proficiency,
            success_rate: sm.successRate,
            trigger_context: sm.triggerContext
          });
          return `- Skill #${sm.id} "${sm.name}" (${sm.proceduralType}, ${sm.proficiency}, ${runs}) - trigger: ${sm.triggerContext.slice(0, 140)}`;
        });
        skillsBlock =
          `\n\n---\n\n## Matching skills (procedural memory)\n${lines.join("\n")}\n` +
          `If one applies: follow it, then call cortex_skill_executed(procedural_id, success) - proficiency only grows when executions are recorded. Full steps via cortex_skill_retrieve.`;
      }
    } catch {
      console.error("[cortex_search] skill match failed");
    }

    const humanReadable = `# CORTEX Search: "${query}"\nResults: ${results.length}\n\n${formatted || "No results found."}${skillsBlock}`;
    return makeStructuredResponse("cortex_search", structuredData, humanReadable, {
      agent_id,
      request_id: requestId,
      warnings: [...retrieval.warnings],
      meta: { latency_ms: retrieval.elapsedMs },
    });
  }
);

// ─── Tool: cortex_recall ────────────────────────────────

server.registerTool(
  "cortex_recall",
  {
    description: "Token-budget-aware context retrieval. Fetches the most relevant memories that fit within a token budget. Use this when you need to load context for a topic without exceeding token limits.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What to recall context about"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    token_budget: z
      .number()
      .int()
      .min(256)
      .max(32000)
      .default(4000)
      .describe("Max tokens to return (default: 4000)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        query: z.string(),
        token_budget: z.number(),
        tokens_used: z.number(),
        memories: z.array(z.object({
          memory_id: z.number(),
          source: z.string().nullable(),
          priority: z.number().nullable(),
          resonance: z.number().nullable(),
          score: z.number(),
          content: z.string()
        }))
      })
    })
  },
  async ({ query, agent_id, token_budget }) => {
    const agentId = await resolveAgent(agent_id);
    const results = await hybridSearch({ agentId, query, limit: 50, candidateLimit: 50 });

    // Also fetch recent cognitive artifacts
    const artifacts = await db
      .select()
      .from(schema.cognitiveArtifacts)
      .where(eq(schema.cognitiveArtifacts.agentId, agentId))
      .orderBy(desc(schema.cognitiveArtifacts.createdAt))
      .limit(5);

    // Fill context within budget
    const parts: string[] = [];
    let usedTokens = 0;
    const memoryBudget = Math.floor(token_budget * 0.8);

    parts.push("## Relevant Memories\n");
    usedTokens += countTokens("## Relevant Memories\n");

    const structuredData = {
      query,
      token_budget,
      tokens_used: 0,
      memories: [] as any[]
    };

    for (const row of results) {
      const src = row.source?.split("/").pop() || "unknown";
      const block = `### Memory #${row.id} [${src}] (score: ${row.score.toFixed(3)})\n${row.content}\n`;
      const blockTokens = countTokens(block);

      if (usedTokens + blockTokens > memoryBudget) {
        if (row.score > 0.6 && usedTokens + 150 < memoryBudget) {
          const truncated = `### Memory #${row.id} [${src}] (score: ${row.score.toFixed(3)})\n${row.content.slice(0, 400)}...\n`;
          const truncTokens = countTokens(truncated);
          if (usedTokens + truncTokens <= memoryBudget) {
            parts.push(truncated);
            usedTokens += truncTokens;
            structuredData.memories.push({
              memory_id: row.id,
              source: row.source,
              priority: row.priority,
              resonance: row.resonanceScore,
              score: row.score,
              content: row.content.slice(0, 400) + "..."
            });
          }
        }
        continue;
      }
      parts.push(block);
      usedTokens += blockTokens;
      structuredData.memories.push({
        memory_id: row.id,
        source: row.source,
        priority: row.priority,
        resonance: row.resonanceScore,
        score: row.score,
        content: row.content
      });
    }

    if (artifacts.length > 0) {
      parts.push("\n## Recent Cognitive Artifacts\n");
      for (const art of artifacts) {
        const block = `### ${art.artifactType} #${art.id}\n${JSON.stringify(art.content, null, 2)}\n`;
        const blockTokens = countTokens(block);
        if (usedTokens + blockTokens > token_budget) break;
        parts.push(block);
        usedTokens += blockTokens;
      }
    }

    structuredData.tokens_used = usedTokens;

    const humanReadable = `# CORTEX Recall: "${query}"\nTokens used: ${usedTokens} / ${token_budget}\n\n${parts.join("\n")}`;
    return makeStructuredResponse("cortex_recall", structuredData, humanReadable, { agent_id });
  }
);

// ─── Tool: cortex_init ──────────────────────────────────

server.registerTool(
  "cortex_init",
  {
    description: "Initialize a CORTEX session from the bounded current working set, then retrieve only relevant current long-term memory. With no working item or context hint, arbitrary memories are not loaded. Use this at session start and work the returned open loops before asking what to do next.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      context_hint: initContextHintInputSchema
        .nullable()
        .optional()
        .describe("Optional bounded context for topic-specific boot retrieval"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        loaded_at: z.string(),
        system_status: z.object({
          active_memories: z.number(),
          synapses: z.number(),
          avg_resonance: z.number(),
          last_dream_cycle: z.string().nullable()
        }),
        active_entities: z.array(z.object({
          name: z.string(),
          mentions: z.number()
        })),
        top_context: z.array(z.object({
          memory_id: z.number(),
          source: z.string().nullable(),
          priority: z.number(),
          resonance: z.number(),
          content: z.string()
        })),
        recent_artifacts: z.array(z.object({
          artifact_id: z.number().int().positive(),
          artifact_type: z.string(),
          content: z.record(z.unknown()),
          resonance: z.number().nullable(),
          created_at: z.string()
        }).strict()),
        open_loops: z.array(z.string()),
        working_items: z.array(z.object({
          working_item_id: z.string().uuid(),
          caller_key: z.string(),
          kind: z.enum(["current_task", "open_loop", "constraint", "correction", "preference"]),
          content: z.string(),
          importance: z.number().min(0).max(1),
          display_order: z.number().int(),
          source_memory_id: z.number().int().positive().nullable(),
          source_event_id: z.string().uuid().nullable(),
          last_confirmed_at: z.string(),
          expires_at: z.string(),
        }).strict()),
        results: z.array(z.discriminatedUnion("kind", [
          z.object({
            retrieval_item_id: z.string().uuid(),
            kind: z.literal("memory"),
            memory_id: z.number().int().positive(),
            source: z.string().nullable(),
            priority: z.number().nullable(),
            resonance: z.number().nullable(),
            content: z.string(),
            score: z.number(),
            final_rank: z.number().int().positive(),
          }).strict(),
          z.object({
            retrieval_item_id: z.string().uuid(),
            kind: z.literal("working_item"),
            working_item_id: z.string().uuid(),
            content: z.string(),
            score: z.number(),
            final_rank: z.number().int().positive(),
          }).strict(),
        ])),
        retrieval_id: z.string().uuid(),
        algorithm_version: z.string(),
        build_id: z.string(),
        candidate_count: z.number().int().nonnegative(),
        returned_count: z.number().int().nonnegative(),
        elapsed_ms: z.number().nonnegative(),
        tokens: z.object({
          working: z.number().int().min(0).max(800),
          retrieval: z.number().int().min(0).max(800),
          evidence: z.number().int().min(0).max(1600),
          compatibility: z.number().int().min(0).max(800),
        }).strict(),
        warnings: z.array(z.string()),
      })
    })
  },
  async ({ agent_id, context_hint }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse("cortex_init", "agent_not_found", `Agent "${agent_id}" does not exist.`, {}, { agent_id });
    }

    const initContext = await memoryServices.retrieval.init(
      agentId,
      undefined,
      context_hint ?? undefined
    );

    // Get system stats
    const memoryCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
    `);
    const synapseCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_synapses
      WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
         OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
    `);
    const avgResonanceResult = await db.execute(sql`
      SELECT COALESCE(AVG(resonance_score), 0) as avg FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
    `);
    const lastDreamResult = await db.execute(sql`
      SELECT cycle_type, stats, started_at, completed_at
      FROM dream_cycle_logs WHERE agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT 1
    `);

    // Recent artifacts
    const recentArtifacts = await db
      .select({
        id: schema.cognitiveArtifacts.id,
        artifactType: schema.cognitiveArtifacts.artifactType,
        content: schema.cognitiveArtifacts.content,
        resonanceScore: schema.cognitiveArtifacts.resonanceScore,
        createdAt: schema.cognitiveArtifacts.createdAt,
      })
      .from(schema.cognitiveArtifacts)
      .where(eq(schema.cognitiveArtifacts.agentId, agentId))
      .orderBy(desc(schema.cognitiveArtifacts.createdAt))
      .limit(5);

    // Active entities (most mentioned across active memories)
    const activeEntities = await db.execute(sql`
      SELECT unnest(entities) as entity, COUNT(*) as mentions
      FROM memory_nodes
      WHERE agent_id = ${agentId} AND status = 'active' AND entities != '{}'
      GROUP BY entity ORDER BY mentions DESC LIMIT 15
    `);

    const memCount = (memoryCountResult.rows[0] as { count: string })?.count || "0";
    const synCount = (synapseCountResult.rows[0] as { count: string })?.count || "0";
    const avgRes = Number(
      (avgResonanceResult.rows[0] as { avg: string })?.avg || 0
    ).toFixed(2);

    const now = new Date();
    const lastDreamCycle = lastDreamResult.rows.length > 0
      ? String((lastDreamResult.rows[0] as { cycle_type: string }).cycle_type)
      : null;
    const systemStatus = {
      active_memories: parseInt(memCount, 10),
      synapses: parseInt(synCount, 10),
      avg_resonance: parseFloat(avgRes),
      last_dream_cycle: lastDreamCycle,
    };
    const rawEntities = (
      activeEntities.rows as Array<{ entity: string; mentions: string }>
    ).map((entry) => ({
      name: entry.entity,
      mentions: parseInt(entry.mentions, 10),
    }));
    const rawArtifacts = recentArtifacts.map((artifact) => ({
      artifact_id: artifact.id,
      artifact_type: artifact.artifactType,
      content: artifact.content as Record<string, unknown>,
      resonance: artifact.resonanceScore,
      created_at: artifact.createdAt.toISOString(),
    }));

    const packedEntities: typeof rawEntities = [];
    const packedArtifacts: typeof rawArtifacts = [];
    let compatibilitySkipped = false;
    const compatibilityPayload = () => ({
      loaded_at: now.toISOString(),
      system_status: systemStatus,
      active_entities: packedEntities,
      recent_artifacts: packedArtifacts,
    });
    for (const entity of rawEntities) {
      packedEntities.push(entity);
      if (
        countTokens(JSON.stringify(compatibilityPayload())) >
        INIT_COMPATIBILITY_TOKEN_BUDGET
      ) {
        packedEntities.pop();
        compatibilitySkipped = true;
      }
    }
    for (const artifact of rawArtifacts) {
      packedArtifacts.push(artifact);
      if (
        countTokens(JSON.stringify(compatibilityPayload())) >
        INIT_COMPATIBILITY_TOKEN_BUDGET
      ) {
        packedArtifacts.pop();
        compatibilitySkipped = true;
      }
    }
    const compatibilityTokens = countTokens(
      JSON.stringify(compatibilityPayload())
    );

    const memoryResults = initContext.retrieval.results.filter(
      isRetrievedMemoryItem
    );
    const publicResults: Array<
      | {
          retrieval_item_id: string;
          kind: "memory";
          memory_id: number;
          source: string | null;
          priority: number | null;
          resonance: number | null;
          content: string;
          score: number;
          final_rank: number;
        }
      | {
          retrieval_item_id: string;
          kind: "working_item";
          working_item_id: string;
          content: string;
          score: number;
          final_rank: number;
        }
    > = [];
    for (const item of initContext.retrieval.results) {
      if (item.kind === "memory") {
        publicResults.push({
          retrieval_item_id: item.retrievalItemId,
          kind: item.kind,
          memory_id: item.memoryId,
          source: item.source,
          priority: item.priority,
          resonance: item.resonance,
          content: item.content,
          score: item.score,
          final_rank: item.finalRank,
        });
      }
      if (item.kind === "working_item") {
        publicResults.push({
          retrieval_item_id: item.retrievalItemId,
          kind: item.kind,
          working_item_id: item.workingItemId,
          content: item.content,
          score: item.score,
          final_rank: item.finalRank,
        });
      }
    }
    const workingItems = initContext.workingItems.map((item) => ({
      working_item_id: item.id,
      caller_key: item.callerKey,
      kind: item.kind,
      content: item.content,
      importance: item.importance,
      display_order: item.displayOrder,
      source_memory_id: item.sourceMemoryId ?? null,
      source_event_id: item.sourceEventId ?? null,
      last_confirmed_at: item.lastConfirmedAt,
      expires_at: item.expiresAt,
    }));
    const initWarnings = [
      ...initContext.retrieval.warnings,
      ...(compatibilitySkipped
        ? ["compatibility_item_skipped_token_budget"]
        : []),
    ];

    const timeZone = process.env.CORTEX_TIME_ZONE || process.env.TZ || "UTC";
    const loadedLocal = new Intl.DateTimeFormat("en-AU", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(now);
    let output = `# CORTEX V2 Session Context\n`;
    output += `*Loaded: ${loadedLocal} (${timeZone})*\n\n`;

    output += `## Working Set\n\n`;
    if (initContext.workingItems.length === 0) {
      output += `No active working items.\n\n`;
    } else {
      for (const item of initContext.workingItems) {
        output += `### ${item.kind} | ${item.callerKey}\n`;
        output += `${item.content}\n\n`;
      }
    }

    output += `## Relevant Long-Term Memory\n\n`;
    if (memoryResults.length === 0) {
      output += `No long-term memory was selected for this boot context.\n\n`;
    } else {
      for (const memory of memoryResults) {
        const source = memory.source?.split("/").pop() || "unknown";
        output += `### Memory #${memory.memoryId} [${source}]\n`;
        output += `${memory.content}\n\n`;
      }
    }

    output += `## System Status\n`;
    output += `- Active Memories: ${memCount}\n`;
    output += `- Synapses: ${synCount}\n`;
    output += `- Avg Resonance: ${avgRes}\n`;

    if (lastDreamResult.rows.length > 0) {
      const dream = lastDreamResult.rows[0] as {
        cycle_type: string;
        completed_at: string;
      };
      output += `- Last Dream Cycle: ${dream.cycle_type} (${dream.completed_at || "in progress"})\n`;
    }
    output += "\n";

    if (packedEntities.length > 0) {
      output += `## Active Entities\n`;
      for (const entity of packedEntities) {
        output += `- ${entity.name} (${entity.mentions} mentions)\n`;
      }
      output += "\n";
    }

    if (packedArtifacts.length > 0) {
      output += `## Recent Cognitive Artifacts\n\n`;
      for (const artifact of packedArtifacts) {
        output += `### ${artifact.artifact_type} #${artifact.artifact_id}\n`;
        output += `${JSON.stringify(artifact.content, null, 2)}\n\n`;
      }
    }

    output += `---\n*CORTEX V2 ready. Use cortex_search for recall, cortex_recall for budget-aware context. If you are unsure what to do next, work the Working Set above or cortex_search for open work BEFORE asking the user.*`;

    const structuredData = {
      loaded_at: now.toISOString(),
      system_status: systemStatus,
      active_entities: packedEntities,
      top_context: memoryResults.map((memory) => ({
        memory_id: memory.memoryId,
        source: memory.source,
        priority: Number.isFinite(Number(memory.priority))
          ? Number(memory.priority)
          : 2,
        resonance: Number.isFinite(Number(memory.resonance))
          ? Number(memory.resonance)
          : 0,
        content: memory.content,
      })),
      recent_artifacts: packedArtifacts,
      open_loops: initContext.workingItems.map((item) => item.content),
      working_items: workingItems,
      results: publicResults,
      retrieval_id: initContext.retrieval.retrievalId,
      algorithm_version: initContext.retrieval.algorithmVersion,
      build_id: initContext.retrieval.buildId,
      candidate_count: initContext.retrieval.candidateCount,
      returned_count: initContext.retrieval.returnedCount,
      elapsed_ms: initContext.retrieval.elapsedMs,
      tokens: {
        working: initContext.workingTokensUsed,
        retrieval: initContext.retrievalTokensUsed,
        evidence: initContext.tokensUsed,
        compatibility: compatibilityTokens,
      },
      warnings: initWarnings,
    };

    return makeStructuredResponse("cortex_init", structuredData, output, {
      agent_id,
      warnings: initWarnings,
      meta: { latency_ms: initContext.retrieval.elapsedMs },
    });
  }
);

// ─── Tool: cortex_ingest ────────────────────────────────
server.registerTool(
  "cortex_ingest",
  {
    description: "Durably accept content into CORTEX memory. Provider-backed indexing continues through the shared worker and may still be queued when this call returns. Use cortex_reconsolidate when the content corrects or replaces a recalled memory; semantic similarity alone never suppresses a distinct capture.",
    inputSchema: z.object({
      content: z.string().min(1).max(250000).describe("The durable content to capture in memory"),
      force: z
        .boolean()
        .default(false)
        .describe("Force a fresh projection instead of reusing an exact current projection. An exact retry still replays its original event."),
      idempotency_key: z
        .string()
        .min(1)
        .max(256)
        .refine((value) => value === value.trim(), {
          message: "idempotency_key must not have leading or trailing whitespace",
        })
        .optional()
        .describe("Stable caller key for exact retries. Omit to derive one from the exact request payload."),
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      source: z
        .string()
        .max(512)
        .nullable()
        .optional()
        .describe("Source label (e.g. 'session', 'telegram', file path)"),
      priority: z
        .number()
        .int()
        .min(0)
        .max(4)
        .default(2)
        .describe("Priority: 0=critical, 1=high, 2=normal, 3=low, 4=ephemeral"),
      source_type: z
        .string()
        .min(1)
        .max(64)
        .refine((value) => value === value.trim(), {
          message: "source_type must not have leading or trailing whitespace",
        })
        .default("api")
        .describe("Source type used to classify the memory"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        event_id: z.string().uuid(),
        status: ingestStatusOutputSchema,
        replayed: z.boolean(),
        failure: ingestFailureOutputSchema.nullable(),
        next_attempt_at: z.string().nullable(),
        accepted_at: z.string(),
        indexed_at: z.string().nullable(),
        memory_id: z.number().nullable(),
        memory_ids: z.array(z.number()),
        duplicate: z.boolean(),
        similar_memory_id: z.number().nullable(),
        source: z.string().nullable(),
        priority: z.number(),
        effective_priorities: z.array(z.number()),
        chunks_created: z.number(),
        entities: z.array(z.string()),
        synapses_created: z.number()
      })
    })
  },
  async ({ content, force, idempotency_key, agent_id, source, priority, source_type }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse(
        "cortex_ingest",
        "agent_not_found",
        `Agent "${agent_id}" does not exist.`,
        {},
        { agent_id }
      );
    }

    try {
      const accepted = await memoryServices.ingest.accept({
        agentId,
        content,
        idempotencyKey: idempotency_key,
        source: source ?? null,
        sourceType: source_type,
        requestedPriority: priority as 0 | 1 | 2 | 3 | 4,
        projectionMode: "append",
        forceNewProjection: force,
      });
      const receipt = await waitForIngestReceipt(
        memoryServices.ingest,
        agentId,
        accepted,
        "mcp_ingest_wait_failed"
      );
      const projection = indexedProjectionFields(receipt);
      const similarMemoryId = receipt.status === "indexed"
        ? receipt.possibleUpdateOf[0] ?? null
        : null;
      const summary = ingestLifecycleSummary(
        receipt,
        `Indexed ${projection.chunksStored} memory chunks (IDs: ${projection.nodeIds.join(", ")}). Formed ${projection.synapsesFormed} synapses.`
      );

      return makeStructuredResponse("cortex_ingest", {
        event_id: receipt.eventId,
        status: receipt.status,
        replayed: receipt.replayed,
        failure: receipt.failure ?? null,
        next_attempt_at: receipt.nextAttemptAt ?? null,
        accepted_at: receipt.acceptedAt,
        indexed_at: receipt.indexedAt ?? null,
        memory_id: projection.nodeIds[0] ?? null,
        memory_ids: projection.nodeIds,
        duplicate: false,
        similar_memory_id: similarMemoryId,
        source: source ?? null,
        priority,
        effective_priorities: projection.effectivePriorities,
        chunks_created: projection.chunksCreated,
        entities: [],
        synapses_created: projection.synapsesFormed,
      }, summary, {
        agent_id,
        warnings: receipt.warnings,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return makeErrorResponse(
          "cortex_ingest",
          error.code,
          error.message,
          { existing_event_id: error.existingId },
          { agent_id }
        );
      }
      if (error instanceof IngestValidationError) {
        return makeErrorResponse(
          "cortex_ingest",
          error.code,
          error.message,
          {},
          { agent_id }
        );
      }
      console.error("[cortex-mcp] Durable ingest acceptance failed", {
        code: "mcp_ingest_acceptance_failed",
      });
      return makeErrorResponse(
        "cortex_ingest",
        "ingest_acceptance_failed",
        "Cortex could not durably accept this ingest request.",
        {},
        { agent_id }
      );
    }
  }
);

// ─── Tool: cortex_ingest_file ───────────────────────────
server.registerTool(
  "cortex_ingest_file",
  {
    description: "Ingest a text file that an administrator has staged in Cortex's configured import directory. The path cannot access the rest of the server filesystem. Use cortex_ingest for content already present in the conversation.",
    inputSchema: z.object({
      file_path: z.string().min(1).describe("Path relative to the configured import directory, or an absolute path inside it"),
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      source_type: z
        .string()
        .min(1)
        .max(64)
        .refine((value) => value === value.trim(), {
          message: "source_type must not have leading or trailing whitespace",
        })
        .default("markdown")
        .describe("Source type used to label the imported content"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        file_path: z.string(),
        chunks_stored: z.number(),
        event_id: z.string().uuid(),
        status: z.enum(["accepted", "processing", "indexed", "failed", "rejected"]),
        replayed: z.boolean(),
        failure: z.object({
          code: z.string(),
          retryable: z.boolean(),
        }).strict().nullable(),
        next_attempt_at: z.string().nullable()
      })
    })
  },
  async ({ file_path, agent_id, source_type }) => {
    let importPath: string;
    try {
      importPath = resolveImportFile(file_path);
    } catch (error) {
      return makeErrorResponse(
        "cortex_ingest_file",
        "invalid_import_path",
        (error as Error).message,
        {},
        { agent_id }
      );
    }
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse(
        "cortex_ingest_file",
        "agent_not_found",
        `Agent "${agent_id}" does not exist.`,
        {},
        { agent_id }
      );
    }

    const receipt = await submitFileSnapshot({
      agentId,
      sourcePath: importPath,
      sourceType: source_type,
    }, {
      allowedRoot: process.env.CORTEX_IMPORT_ROOT,
      ingest: memoryServices.ingest,
    });

    const chunksStored = receipt.status === "indexed" ? receipt.chunksStored : 0;
    const lifecycleSummary = receipt.status === "indexed"
      ? `Indexed ${file_path}: ${chunksStored} chunks available (event ${receipt.eventId}).`
      : receipt.status === "rejected"
        ? `Rejected ${file_path} (event ${receipt.eventId}, code ${receipt.failure?.code ?? "rejected"}).`
        : receipt.status === "failed" && !receipt.failure?.retryable
          ? `Failed to index ${file_path} (event ${receipt.eventId}, code ${receipt.failure?.code ?? "projection_failed"}).`
          : `Durably queued ${file_path} for indexing (event ${receipt.eventId}, status ${receipt.status}).`;

    return makeStructuredResponse("cortex_ingest_file", {
      file_path,
      chunks_stored: chunksStored,
      event_id: receipt.eventId,
      status: receipt.status,
      replayed: receipt.replayed,
      failure: receipt.failure ?? null,
      next_attempt_at: receipt.nextAttemptAt ?? null,
    }, lifecycleSummary, { agent_id });
  }
);

// ─── Tool: cortex_ingest_corpus ─────────────────────────
server.registerTool(
  "cortex_ingest_corpus",
  {
    description: "Bulk-import the administrator-staged Cortex corpus from the configured read-only import directory. This replaces prior chunks for the same source files and can create many persistent records.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        memories_created: z.number(),
        synapses_created: z.number(),
        chunks_stored: z.number(),
        files_processed: z.number(),
        files_failed: z.number(),
        queued: z.number(),
        indexed: z.number(),
        failed: z.number(),
        rejected: z.number(),
        read_failed: z.number(),
        submission_failed: z.number(),
        replayed: z.number(),
        active_memories_total: z.number(),
        synapses_total: z.number()
      })
    })
  },
  async ({ agent_id }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse(
        "cortex_ingest_corpus",
        "agent_not_found",
        `Agent "${agent_id}" does not exist.`,
        {},
        { agent_id }
      );
    }
    let ingestResult;
    try {
      ingestResult = await ingestCorpus(agentId, {
        ingest: memoryServices.ingest,
      });
    } catch (error) {
      return makeErrorResponse("cortex_ingest_corpus", "corpus_unavailable", (error as Error).message, {}, { agent_id });
    }

    // Get final counts
    const [memCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
      `)
    ).rows as Array<{ count: string }>;

    const [synCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_synapses
        WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
           OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
      `)
    ).rows as Array<{ count: string }>;

    return makeStructuredResponse("cortex_ingest_corpus", {
      memories_created: ingestResult.memoriesCreated,
      synapses_created: ingestResult.synapsesCreated,
      chunks_stored: ingestResult.chunksStored,
      files_processed: ingestResult.filesProcessed,
      files_failed: ingestResult.filesFailed,
      queued: ingestResult.queued,
      indexed: ingestResult.indexed,
      failed: ingestResult.failed,
      rejected: ingestResult.rejected,
      read_failed: ingestResult.readFailed,
      submission_failed: ingestResult.submissionFailed,
      replayed: ingestResult.replayed,
      active_memories_total: parseInt(memCount.count, 10),
      synapses_total: parseInt(synCount.count, 10)
    }, `Corpus snapshot submissions settled: ${ingestResult.indexed} indexed, ${ingestResult.queued} durably queued, ${ingestResult.failed} failed, ${ingestResult.rejected} rejected, ${ingestResult.readFailed} unreadable, and ${ingestResult.submissionFailed} submission failures. ${ingestResult.chunksStored} chunks are now indexed; Cortex has ${memCount.count} active memories and ${synCount.count} synapses for this agent.`, { agent_id });
  }
);

// ─── Tool: cortex_dream ─────────────────────────────────
server.registerTool(
  "cortex_dream",
  {
    description: "Run memory maintenance. Full/SWS/pruning cycles can archive or delete memories and prune synapses; REM can synthesize and prune weak connections. Failures are reported instead of being presented as completed cycles.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      cycle_type: z
        .enum(["full", "sws_only", "rem_only", "resonance_only", "pruning_only", "consolidation_only"])
        .default("full")
        .describe("Type of dream cycle to run"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        cycle_type: z.enum(["full", "sws_only", "rem_only", "resonance_only", "pruning_only", "consolidation_only"]),
        duration_ms: z.number(),
        stats: z.object({
          phase1_resonance_updated: z.number(),
          phase1b_priorities_reconciled: z.number(),
          phase2_memories_deleted: z.number(),
          phase2_memories_archived: z.number(),
          phase2_synapses_pruned: z.number(),
          phase2_observations_pruned: z.number(),
          phase3_clusters_found: z.number(),
          phase3_consolidations: z.number(),
          phase3_synapses_strengthened: z.number(),
          phase4_nodes_activated: z.number(),
          phase4_novel_synapses: z.number(),
          phase5_syntheses_created: z.number(),
          phase5_synapses_pruned: z.number(),
        }).strict()
      })
    })
  },
  async ({ agent_id, cycle_type }) => {
    const agentId = await resolveAgent(agent_id);
    const stats = await runDreamCycle(agentId, cycle_type);

    return makeStructuredResponse("cortex_dream", {
      cycle_type,
      duration_ms: stats.totalDurationMs,
      stats: {
        phase1_resonance_updated: stats.phase1_resonanceUpdated,
        phase1b_priorities_reconciled: stats.phase1b_prioritiesReconciled,
        phase2_memories_deleted: stats.phase2_memoriesDeleted,
        phase2_memories_archived: stats.phase2_memoriesArchived,
        phase2_synapses_pruned: stats.phase2_synapsesPruned,
        phase2_observations_pruned: stats.phase2_observationsPruned ?? 0,
        phase3_clusters_found: stats.phase3_clustersFound,
        phase3_consolidations: stats.phase3_consolidations,
        phase3_synapses_strengthened: stats.phase3_synapsesStrengthened,
        phase4_nodes_activated: stats.phase4_nodesActivated,
        phase4_novel_synapses: stats.phase4_novelSynapses,
        phase5_syntheses_created: stats.phase5_synthesesCreated ?? 0,
        phase5_synapses_pruned: stats.phase5_synapsesPruned ?? 0,
      }
    }, `Dream cycle (${cycle_type}) complete in ${(stats.totalDurationMs / 1000).toFixed(1)}s.\n\nResults:\n- Resonance updated: ${stats.phase1_resonanceUpdated}\n- Memories deleted: ${stats.phase2_memoriesDeleted}\n- Memories archived: ${stats.phase2_memoriesArchived}\n- Synapses pruned: ${stats.phase2_synapsesPruned}\n- Clusters found: ${stats.phase3_clustersFound}\n- Consolidations: ${stats.phase3_consolidations}\n- Synapses strengthened: ${stats.phase3_synapsesStrengthened}\n- Nodes activated: ${stats.phase4_nodesActivated}\n- Novel synapses: ${stats.phase4_novelSynapses}`, { agent_id });
  }
);

// ─── Tool: cortex_status ────────────────────────────────
server.registerTool(
  "cortex_status",
  {
    description: "Get CORTEX system status including memory count, synapse count, resonance stats, and last dream cycle info.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        active_memories: z.number(),
        synapses: z.number(),
        avg_resonance: z.number(),
        status_breakdown: z.array(z.object({ status: z.string(), count: z.number() })),
        source_breakdown: z.array(z.object({ source_type: z.string(), count: z.number() })),
        last_dream: z.object({
          cycle_type: z.string(),
          started_at: z.string(),
          completed_at: z.string().nullable(),
          stats: z.record(z.unknown()),
        }).strict().nullable()
      })
    })
  },
  async ({ agent_id }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse("cortex_status", "agent_not_found", `Agent "${agent_id}" does not exist.`, {}, { agent_id });
    }

    const [memCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
      `)
    ).rows as Array<{ count: string }>;

    const [synCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_synapses
        WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
           OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
      `)
    ).rows as Array<{ count: string }>;

    const [avgRes] = (
      await db.execute(sql`
        SELECT COALESCE(AVG(resonance_score), 0) as avg FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
      `)
    ).rows as Array<{ avg: string }>;

    const statusBreakdown = await db.execute(sql`
      SELECT status, COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} GROUP BY status
    `);

    const sourceBreakdown = await db.execute(sql`
      SELECT source_type, COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active' GROUP BY source_type
    `);

    const lastDream = await db.execute(sql`
      SELECT cycle_type, stats, started_at, completed_at FROM dream_cycle_logs WHERE agent_id = ${agentId} ORDER BY started_at DESC LIMIT 1
    `);

    const structuredData = {
      active_memories: parseInt(memCount.count, 10),
      synapses: parseInt(synCount.count, 10),
      avg_resonance: parseFloat(avgRes.avg),
      status_breakdown: (statusBreakdown.rows as any[]).map(r => ({ status: r.status, count: parseInt(r.count, 10) })),
      source_breakdown: (sourceBreakdown.rows as any[]).map(r => ({ source_type: r.source_type ?? "unknown", count: parseInt(r.count, 10) })),
      last_dream: lastDream.rows.length > 0 ? (() => {
        const dream = lastDream.rows[0] as any;
        return {
          cycle_type: String(dream.cycle_type),
          started_at: new Date(dream.started_at).toISOString(),
          completed_at: dream.completed_at ? new Date(dream.completed_at).toISOString() : null,
          stats: (dream.stats ?? {}) as Record<string, unknown>,
        };
      })() : null
    };

    let output = `# CORTEX V2 Status\n\n`;
    output += `- Active Memories: ${memCount.count}\n`;
    output += `- Synapses: ${synCount.count}\n`;
    output += `- Avg Resonance: ${Number(avgRes.avg).toFixed(2)}\n\n`;

    output += `## Memory by Status\n`;
    for (const row of statusBreakdown.rows as Array<{
      status: string;
      count: string;
    }>) {
      output += `- ${row.status}: ${row.count}\n`;
    }

    output += `\n## Memory by Source\n`;
    for (const row of sourceBreakdown.rows as Array<{
      source_type: string;
      count: string;
    }>) {
      output += `- ${row.source_type}: ${row.count}\n`;
    }

    if (lastDream.rows.length > 0) {
      const dream = lastDream.rows[0] as {
        cycle_type: string;
        completed_at: string;
        stats: Record<string, unknown>;
      };
      output += `\n## Last Dream Cycle\n`;
      output += `- Type: ${dream.cycle_type}\n`;
      output += `- Completed: ${dream.completed_at || "in progress"}\n`;
      output += `- Stats: ${JSON.stringify(dream.stats)}\n`;
    }

    return makeStructuredResponse("cortex_status", structuredData, output, { agent_id });
  }
);

// ─── Tool: cortex_vitals ───────────────────────────────
server.registerTool(
  "cortex_vitals",
  {
    description: "Check CORTEX memory-system health and early warnings. Returns active warnings (degraded self-check, duplicate formation, stale reflect/threads, growth imbalance, drift, etc.), current integrity metrics, and recent activity series. Call at boot or when something feels off -- this is the system's own health signal. Act on warnings or report them to the user.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        generated_at: z.string(),
        thresholds: z.record(z.number()),
        series: z.object({
          daily: z.array(z.object({
            day: z.string(),
            agent_writes: z.number(),
            reflections: z.number(),
            other_writes: z.number(),
            total: z.number(),
            reconsolidations: z.number(),
            traces: z.number(),
            journals: z.number(),
          }).strict()),
          diagnostics: z.array(z.object({
            at: z.string(),
            health: z.string(),
            drift: z.number(),
          }).strict()),
          dreams: z.array(z.object({
            at: z.string(),
            cycle_type: z.string(),
            hours_ago: z.number(),
            resonance_updated: z.number(),
            pruned: z.number(),
            novel_synapses: z.number(),
            syntheses: z.number(),
          }).strict()),
        }).strict(),
        warnings: z.array(z.object({
          id: z.string(),
          severity: z.enum(["info", "warn", "critical"]),
          title: z.string(),
          detail: z.string(),
        }).strict()),
        ok_checks: z.array(z.string()),
        current: z.object({
          active_memories: z.number(),
          synapses: z.number(),
          avg_resonance: z.number().nullable(),
          avg_synapse_strength: z.number().nullable(),
          orphans: z.number(),
          missing_hippocampal: z.number(),
          missing_valence: z.number(),
          labile_now: z.number(),
          expired_active: z.number(),
          em_dash_recent: z.number(),
          skills_total: z.number(),
          skill_executions: z.number(),
          dream_hours_ago: z.number().nullable(),
          reflect_hours_ago: z.number().nullable(),
          threads_hours_ago: z.number().nullable(),
          journal_hours_ago: z.number().nullable(),
          agent_ingests_7d: z.number(),
          reconsolidations_7d: z.number(),
          duplicate_pairs: z.array(z.object({
            memory_a: z.number(),
            memory_b: z.number(),
            similarity: z.number(),
          }).strict()),
          duplicate_scan_truncated: z.boolean(),
        }).strict(),
      }).strict()
    }).strict()
  },
  async ({ agent_id }) => {
    // Delegate to the REST vitals endpoint (canonical logic lives in
    // src/api/vitals.ts -- avoids duplicating the warning engine here).
    const restBase = process.env.CORTEX_REST_URL || `http://localhost:${process.env.PORT || 3100}`;
    let vitalsData: any = null;
    let fetchError: string | null = null;
    try {
      const resp = await fetch(`${restBase}/api/v1/vitals?agentId=${encodeURIComponent(agent_id)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        vitalsData = await resp.json();
      } else {
        fetchError = `REST vitals returned ${resp.status}`;
      }
    } catch (e) {
      fetchError = (e as Error)?.message || String(e);
    }

    if (fetchError || !vitalsData) {
      return makeErrorResponse("cortex_vitals", "vitals_unavailable", `Could not fetch vitals: ${fetchError}`, {}, { agent_id });
    }

    const warnings = vitalsData.warnings || [];
    const okChecks = vitalsData.okChecks || [];
    const current = vitalsData.current || {};
    const numeric = (value: unknown, fallback: number | null = 0): number | null => {
      if (value === null || value === undefined) return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const series = vitalsData.series || {};
    const publicSeries = {
      daily: (Array.isArray(series.daily) ? series.daily : []).map((row: any) => ({
        day: String(row.day ?? ""),
        agent_writes: numeric(row.agentWrites) ?? 0,
        reflections: numeric(row.reflections) ?? 0,
        other_writes: numeric(row.otherWrites) ?? 0,
        total: numeric(row.total) ?? 0,
        reconsolidations: numeric(row.reconsolidations) ?? 0,
        traces: numeric(row.traces) ?? 0,
        journals: numeric(row.journals) ?? 0,
      })),
      diagnostics: (Array.isArray(series.diagnostics) ? series.diagnostics : []).map((row: any) => ({
        at: String(row.at ?? ""),
        health: String(row.health ?? "unknown"),
        drift: numeric(row.drift) ?? 0,
      })),
      dreams: (Array.isArray(series.dreams) ? series.dreams : []).map((row: any) => ({
        at: String(row.at ?? ""),
        cycle_type: String(row.cycleType ?? "unknown"),
        hours_ago: numeric(row.hoursAgo) ?? 0,
        resonance_updated: numeric(row.resonanceUpdated) ?? 0,
        pruned: numeric(row.pruned) ?? 0,
        novel_synapses: numeric(row.novelSynapses) ?? 0,
        syntheses: numeric(row.syntheses) ?? 0,
      })),
    };
    const publicCurrent = {
      active_memories: numeric(current.activeMemories) ?? 0,
      synapses: numeric(current.synapses) ?? 0,
      avg_resonance: numeric(current.avgResonance, null),
      avg_synapse_strength: numeric(current.avgSynapseStrength, null),
      orphans: numeric(current.orphans) ?? 0,
      missing_hippocampal: numeric(current.missingHippocampal) ?? 0,
      missing_valence: numeric(current.missingValence) ?? 0,
      labile_now: numeric(current.labileNow) ?? 0,
      expired_active: numeric(current.expiredActive) ?? 0,
      em_dash_recent: numeric(current.emDashRecent) ?? 0,
      skills_total: numeric(current.skillsTotal) ?? 0,
      skill_executions: numeric(current.skillExecutions) ?? 0,
      dream_hours_ago: numeric(current.dreamHoursAgo, null),
      reflect_hours_ago: numeric(current.reflectHoursAgo, null),
      threads_hours_ago: numeric(current.threadsHoursAgo, null),
      journal_hours_ago: numeric(current.journalHoursAgo, null),
      agent_ingests_7d: numeric(current.agentIngests7d) ?? 0,
      reconsolidations_7d: numeric(current.reconsolidations7d) ?? 0,
      duplicate_pairs: (Array.isArray(current.dupPairs) ? current.dupPairs : []).map((pair: any) => ({
        memory_a: numeric(pair.a) ?? 0,
        memory_b: numeric(pair.b) ?? 0,
        similarity: numeric(pair.sim) ?? 0,
      })),
      duplicate_scan_truncated: Boolean(current.dupScanTruncated),
    };

    let output = `# CORTEX Vitals\n\n`;
    if (warnings.length > 0) {
      output += `## Warnings (${warnings.length})\n`;
      for (const w of warnings) {
        output += `- [${w.severity.toUpperCase()}] ${w.title}: ${w.detail}\n`;
      }
      output += "\n";
    }
    if (okChecks.length > 0) {
      output += `## OK\n`;
      for (const ok of okChecks.slice(0, 10)) output += `- ${ok}\n`;
      output += "\n";
    }
    output += `## Current\n`;
    output += `- Active memories: ${current.activeMemories ?? "?"}\n`;
    output += `- Synapses: ${current.synapses ?? "?"}\n`;
    output += `- Avg synapse strength: ${current.avgSynapseStrength ?? "?"}\n`;
    output += `- Dream: ${current.dreamHoursAgo != null ? Math.round(current.dreamHoursAgo) + "h ago" : "?"}\n`;
    output += `- Reflect: ${current.reflectHoursAgo != null ? Math.round(current.reflectHoursAgo) + "h ago" : "?"}\n`;
    output += `- Background threads: ${current.threadsHoursAgo != null ? Math.round(current.threadsHoursAgo) + "h ago" : "?"}\n`;
    output += `- Near-duplicate pairs: ${current.dupPairs?.length ?? 0}\n`;

    return makeStructuredResponse("cortex_vitals", {
      generated_at: String(vitalsData.generatedAt ?? new Date().toISOString()),
      thresholds: vitalsData.thresholds ?? {},
      series: publicSeries,
      warnings,
      ok_checks: okChecks,
      current: publicCurrent,
    }, output, { agent_id });
  }
);

// ─── Tool: cortex_artifact ──────────────────────────────
server.registerTool(
  "cortex_artifact",
  {
    description: "Store a cognitive artifact (decision, learning, correction, or insight). Use this to record significant decisions with reasoning, lessons learned, corrections made, or insights discovered.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      artifact_type: z
        .enum(["decision", "learning", "correction", "insight"])
        .describe("Type of cognitive artifact"),
      content: z.record(z.unknown()).describe("Artifact content as JSON object"),
      session_id: z
        .string()
        .nullable()
        .optional()
        .describe("Session identifier"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        artifact_id: z.number(),
        artifact_type: z.string()
      })
    })
  },
  async ({ agent_id, artifact_type, content, session_id }) => {
    const agentId = await resolveAgent(agent_id);

    const [artifact] = await db
      .insert(schema.cognitiveArtifacts)
      .values({
        agentId,
        artifactType: artifact_type,
        content: scrubEmDashes(content),
        sessionId: session_id,
        resonanceScore: 5.0,
      })
      .returning();

    return makeStructuredResponse("cortex_artifact", {
      artifact_id: artifact.id,
      artifact_type
    }, `Cognitive artifact stored (${artifact_type} #${artifact.id}).`, { agent_id });
  }
);

// ─── Tool: cortex_self_check (Phase 1) ─────────────────
server.registerTool(
  "cortex_self_check",
  {
    description: "Run a Cortex self-diagnostic. Hosted/headless deployments check database integrity and behavioral drift; desktop deployments additionally check local skills, cron jobs, and channels.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      verbose: z.boolean().default(false).describe("Include detailed drift indicators"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        result: z.object({
          skills_status: z.record(z.object({ exists: z.boolean(), valid: z.boolean() }).strict()),
          cron_status: z.object({
            total: z.number(),
            enabled: z.number(),
            overdue: z.array(z.string()),
            failed: z.array(z.string()),
            last_checked: z.string(),
          }).strict(),
          channels_status: z.record(z.object({ enabled: z.boolean(), configured: z.boolean() }).strict()),
          drift_score: z.number(),
          drift_details: z.object({
            indicators: z.array(z.string()),
            sycophancy_flags: z.number(),
            em_dash_count: z.number(),
            unauthorized_actions: z.number(),
          }).strict(),
          alerts: z.array(z.string()),
          overall_health: z.enum(["healthy", "degraded", "critical"]),
        }).strict()
      })
    })
  },
  async ({ agent_id, verbose }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await runSelfCheck(agentId, verbose);
    const publicResult = {
      skills_status: result.skillsStatus,
      cron_status: {
        total: result.cronStatus.total,
        enabled: result.cronStatus.enabled,
        overdue: result.cronStatus.overdue,
        failed: result.cronStatus.failed,
        last_checked: result.cronStatus.lastChecked,
      },
      channels_status: result.channelsStatus,
      drift_score: result.driftScore,
      drift_details: {
        indicators: result.driftDetails.indicators,
        sycophancy_flags: result.driftDetails.sycophancyFlags,
        em_dash_count: result.driftDetails.emDashCount,
        unauthorized_actions: result.driftDetails.unauthorizedActions,
      },
      alerts: result.alerts,
      overall_health: result.overallHealth,
    };
    return makeStructuredResponse("cortex_self_check", { result: publicResult }, formatDiagnostic(result, verbose), { agent_id });
  }
);

// ─── Tool: cortex_journal (Phase 1) ────────────────────
server.registerTool(
  "cortex_journal",
  {
    description: "Log an agent state journal entry. Record current energy, confidence, concerns, and notes for self-awareness tracking.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      energy_state: z.enum(["high", "normal", "low", "depleted"]).default("normal").describe("Current energy level"),
      confidence: z.number().min(0).max(1).default(0.5).describe("Current confidence (0-1)"),
      active_threads: z.array(z.string()).default([]).describe("Currently active work threads"),
      concerns: z.array(z.string()).default([]).describe("Current concerns"),
      notes: z.string().nullable().optional().describe("Free-form notes"),
      session_id: z.string().nullable().optional().describe("Session identifier"),
      resolved_thread_keys: z.array(
        z.string().min(1).max(256).refine(
          (value) =>
            value === value.trim() &&
            !value.includes("\u0000") &&
            Buffer.byteLength(value, "utf8") <= 256,
          { message: "resolved thread keys must be trimmed UTF-8 text" }
        )
      ).max(50).optional().describe(
        "Exact caller keys returned by an earlier journal/init item to resolve explicitly"
      ),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        journal_id: z.number(),
        working_items: z.array(z.object({
          working_item_id: z.string().uuid(),
          caller_key: z.string(),
          kind: z.enum(["current_task", "open_loop", "constraint", "correction", "preference"]),
          content: z.string(),
          status: z.enum(["active", "resolved", "expired"]),
          expires_at: z.string(),
        }).strict())
      })
    })
  },
async ({ agent_id, energy_state, confidence, active_threads, concerns, notes, session_id, resolved_thread_keys }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const result = await writeJournalEntry(agentId, {
      energyState: energy_state ?? "normal",
      confidence: confidence ?? 0.5,
      activeThreads: active_threads ?? [],
      concerns: concerns ?? [],
      notes: notes ?? undefined,
      sessionId: session_id ?? undefined,
      resolvedCallerKeys: resolved_thread_keys ?? [],
    });
    const workingItems = result.workingItems.map((item) => ({
      working_item_id: item.id,
      caller_key: item.callerKey,
      kind: item.kind,
      content: item.content,
      status: item.status,
      expires_at: item.expiresAt,
    }));
    return makeStructuredResponse(
      "cortex_journal",
      { journal_id: result.journalId, working_items: workingItems },
      `Journal entry stored (ID: ${result.journalId}); ${workingItems.length} working item(s) reconciled.`,
      { agent_id: agent_id ?? "arlo" }
    );
  }
);

// ─── Tool: cortex_assess_state (Phase 2) ──────────────
server.registerTool(
  "cortex_assess_state",
  {
    description: "Assess the principal's current state (energy, stress, focus) from recent message patterns and context. Returns communication guidance the CALLING session should immediately adapt to (pacing, brevity, decision load), and records the assessment for trend history. Call this when the principal's recent messages show CLEAR state signals (frustration, fatigue, time pressure, rapid-fire terseness) - pass their messages verbatim in recent_messages. Do NOT call it on sparse or neutral signal: few good assessments beat many noisy ones.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      recent_messages: z.array(z.string().min(1)).min(1).max(50).describe("Recent messages from the principal to analyze, oldest to newest"),
      time_of_day: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional().describe("Current local time in HH:MM format, for example '14:30'"),
      calendar_context: z.string().nullable().optional().describe("Relevant upcoming calendar context"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        assessment: z.object({
          energy: z.number().min(0).max(1),
          stress: z.number().min(0).max(1),
          focus_state: z.enum(["hyperfocus", "flow", "normal", "scattered", "executive_dysfunction"]),
          emotional_valence: z.number().min(-1).max(1),
          adhd_state: z.enum(["hyperfocus", "managed", "restless", "overwhelmed", "shutdown"]),
          confidence: z.number().min(0).max(1),
          inferred_from: z.string(),
          communication_guidance: z.string(),
        }).strict()
      }).strict()
    }).strict()
  },
  async ({ agent_id, recent_messages, time_of_day, calendar_context }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const result = await assessPrincipalState(agentId, recent_messages, time_of_day ?? undefined, undefined, calendar_context ?? undefined);
    return makeStructuredResponse("cortex_assess_state", { assessment: {
      energy: result.energy,
      stress: result.stress,
      focus_state: result.focusState,
      emotional_valence: result.emotionalValence,
      adhd_state: result.adhdState,
      confidence: result.confidenceScore,
      inferred_from: result.inferredFrom,
      communication_guidance: result.communicationGuidance,
    } }, formatStateAssessment(result), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_state_history (Phase 2) ─────────────
server.registerTool(
  "cortex_state_history",
  {
    description: "Get recent history of the principal's assessed states. Useful for understanding trends and patterns.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      hours: z.number().int().min(1).max(8760).default(24).describe("How many hours back to look (default: 24)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        history: z.array(z.object({
          assessed_at: z.string(),
          energy: z.number().nullable(),
          stress: z.number().nullable(),
          focus_state: z.string().nullable(),
          adhd_state: z.string().nullable(),
          confidence: z.number().nullable(),
        }).strict())
      }).strict()
    }).strict()
  },
  async ({ agent_id, hours }) => {
    const agentId = await resolveExistingAgent(agent_id ?? "arlo");
    if (agentId === null) {
      return makeErrorResponse("cortex_state_history", "agent_not_found", `Agent "${agent_id ?? "arlo"}" does not exist.`, {}, { agent_id: agent_id ?? "arlo" });
    }
    const entries = await getStateHistory(agentId, hours ?? 24);
    return makeStructuredResponse("cortex_state_history", { history: entries.map((entry) => ({
      assessed_at: entry.timestamp.toISOString(),
      energy: entry.energy,
      stress: entry.stress,
      focus_state: entry.focusState,
      adhd_state: entry.adhdState,
      confidence: entry.confidenceScore,
    })) }, formatStateHistory(entries), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_bg_thread (Phase 3) ─────────────────
server.registerTool(
  "cortex_bg_thread",
  {
    description: "Run a background reasoning thread. Strategic analyzes gaps and alignment. Operational checks system health. Relational tracks contact freshness.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      thread_type: z.enum(["strategic", "operational", "relational"]).describe("Type of reasoning thread"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        thread_type: z.enum(["strategic", "operational", "relational"]),
        result: z.object({
          insights: z.array(z.string()),
          actions: z.array(z.string()),
          questions: z.array(z.string()),
        }).strict()
      }).strict()
    }).strict()
  },
  async ({ agent_id, thread_type }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const result = thread_type === "strategic"
      ? await runStrategicThread(agentId, {
          workingSet: memoryServices.workingSet,
        })
      : thread_type === "operational"
        ? await runOperationalThread(agentId)
        : await runRelationalThread(agentId);
    return makeStructuredResponse("cortex_bg_thread", { thread_type, result }, formatThreadResult(thread_type, result), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_synthesize (Phase 3) ────────────────
server.registerTool(
  "cortex_synthesize",
  {
    description: "Analyze recent novel synapses, generate insights, and prune low-confidence synapses rejected by synthesis. Pruning is difficult to reverse.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      hours: z.number().int().min(1).max(8760).default(24).describe("How many hours of novel synapses to analyze (default: 24)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        syntheses_created: z.number(),
        synapses_pruned: z.number(),
        insights: z.array(z.object({
          type: z.string(),
          description: z.string(),
        }).strict())
      }).strict()
    }).strict()
  },
  async ({ agent_id, hours }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const result = await phaseSynthesis(agentId, hours ?? 24);
    let text = `Synthesis complete: ${result.synthesesCreated} insights generated; ${result.synapsesPruned} low-confidence synapses pruned.`;
    if (result.insights.length > 0) {
      text += "\n\nInsights:\n" + result.insights.map(i => `- ${i.description}`).join("\n");
    }
    return makeStructuredResponse("cortex_synthesize", {
      syntheses_created: result.synthesesCreated,
      synapses_pruned: result.synapsesPruned,
      insights: result.insights
    }, text, { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_observe (Phase 4) ───────────────────
server.registerTool(
  "cortex_observe",
  {
    description: "Capture the screen of the machine running Cortex on supported Windows/macOS desktop installations. Hosted/headless Cortex cannot capture the ChatGPT user's device and returns screen_capture_unavailable. For compatibility, storage is enabled unless store=false.",
    inputSchema: z.object({
      agent_id: z.string().nullable().default("arlo").describe("Agent ID (default: arlo)"),
      store: z.boolean().nullable().optional().describe("Store the observation in memory (default: true; false = describe only)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        observation: z.object({
          activeApp: z.string(),
          windowTitle: z.string(),
          description: z.string(),
          entities: z.array(z.string()),
          timestamp: z.string(),
          screenshotPath: z.string().nullable(),
        }).strict(),
        memory_ids: z.array(z.number()),
        event_id: z.string().uuid().nullable(),
        status: ingestStatusOutputSchema.nullable(),
        replayed: z.boolean(),
        failure: ingestFailureOutputSchema.nullable(),
        next_attempt_at: z.string().nullable(),
        accepted_at: z.string().nullable(),
        indexed_at: z.string().nullable(),
      }).strict()
    }).strict()
  },
  async ({ agent_id, store }) => {
    const externalAgentId = agent_id ?? "arlo";
    let observation;
    try {
      observation = await captureAndAnalyze();
    } catch (error) {
      if (error instanceof ScreenCaptureUnavailableError) {
        return makeErrorResponse("cortex_observe", error.code, error.message, {
          platform: error.platform,
          reason: error.reason,
        }, { agent_id: externalAgentId });
      }
      throw error;
    }
    let text = formatObservation(observation);
    let receipt: IngestReceipt | null = null;
    if (shouldStoreScreenObservation(store)) {
      const agentId = await resolveExistingAgent(externalAgentId);
      if (agentId === null) {
        return makeErrorResponse(
          "cortex_observe",
          "agent_not_found",
          `Agent "${externalAgentId}" does not exist.`,
          {},
          { agent_id: externalAgentId }
        );
      }
      try {
        receipt = await ingestObservation(agentId, observation, {
          ingest: memoryServices.ingest,
        });
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          return makeErrorResponse(
            "cortex_observe",
            error.code,
            error.message,
            { existing_event_id: error.existingId },
            { agent_id: externalAgentId }
          );
        }
        if (error instanceof IngestValidationError) {
          return makeErrorResponse(
            "cortex_observe",
            error.code,
            error.message,
            {},
            { agent_id: externalAgentId }
          );
        }
        console.error("[cortex-mcp] Durable observation acceptance failed", {
          code: "mcp_observation_acceptance_failed",
        });
        return makeErrorResponse(
          "cortex_observe",
          "observation_acceptance_failed",
          "Cortex could not durably accept this observation.",
          {},
          { agent_id: externalAgentId }
        );
      }
      text += `\n${ingestLifecycleSummary(
        receipt,
        `Indexed observation as ${receipt.chunksStored} memory chunks (event ${receipt.eventId}).`
      )}`;
    }
    const projection = receipt
      ? indexedProjectionFields(receipt)
      : {
          nodeIds: [],
          effectivePriorities: [],
          chunksStored: 0,
          chunksCreated: 0,
          synapsesFormed: 0,
        };
    return makeStructuredResponse("cortex_observe", {
      observation: {
        activeApp: observation.activeApp,
        windowTitle: observation.windowTitle,
        description: observation.description,
        entities: observation.entities,
        timestamp: observation.timestamp,
        screenshotPath: observation.screenshotPath,
      },
      memory_ids: projection.nodeIds,
      event_id: receipt?.eventId ?? null,
      status: receipt?.status ?? null,
      replayed: receipt?.replayed ?? false,
      failure: receipt?.failure ?? null,
      next_attempt_at: receipt?.nextAttemptAt ?? null,
      accepted_at: receipt?.acceptedAt ?? null,
      indexed_at: receipt?.indexedAt ?? null,
    }, text, {
      agent_id: externalAgentId,
      warnings: receipt?.warnings ?? [],
    });
  }
);

// ─── Tool: cortex_relationship (Phase 5) ──────────────
server.registerTool(
  "cortex_relationship",
  {
    description: "Look up a person's relationship profile. Returns communication preferences, open items, contact history, and personality model.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      name: z.string().min(1).describe("Person's name (fuzzy matched)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        person_name: z.string(),
        relationship: relationshipPublicSchema.nullable()
      }).strict()
    }).strict()
  },
  async ({ agent_id, name }) => {
    const agentId = await resolveExistingAgent(agent_id ?? "arlo");
    if (agentId === null) {
      return makeErrorResponse("cortex_relationship", "agent_not_found", `Agent "${agent_id ?? "arlo"}" does not exist.`, {}, { agent_id: agent_id ?? "arlo" });
    }
    const rel = await getRelationship(agentId, name);
    if (!rel) return makeStructuredResponse("cortex_relationship", { person_name: name, relationship: null }, `No relationship found for "${name}".`, { agent_id: agent_id ?? "arlo" });
    return makeStructuredResponse("cortex_relationship", { person_name: rel.personName, relationship: toPublicRelationship(rel) }, formatRelationship(rel), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_relationships (Phase 5) ─────────────
server.registerTool(
  "cortex_relationships",
  {
    description: "List all relationships, optionally filtered by type or showing only overdue contacts.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      type: z.enum(["family", "client", "partner", "vendor", "friend", "professional"]).nullable().optional().describe("Optional relationship type filter"),
      overdue_only: z.boolean().default(false).describe("Only show overdue contacts (default: false)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        relationships: z.array(relationshipPublicSchema)
      }).strict()
    }).strict()
  },
  async ({ agent_id, type, overdue_only }) => {
    const agentId = await resolveExistingAgent(agent_id ?? "arlo");
    if (agentId === null) {
      return makeErrorResponse("cortex_relationships", "agent_not_found", `Agent "${agent_id ?? "arlo"}" does not exist.`, {}, { agent_id: agent_id ?? "arlo" });
    }
    const rels = await listRelationships(agentId, { type: type ?? undefined, overdueOnly: overdue_only ?? false });
    return makeStructuredResponse("cortex_relationships", { relationships: rels.map(toPublicRelationship) }, formatRelationshipList(rels), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_relationship_update (Phase 5) ───────
server.registerTool(
  "cortex_relationship_update",
  {
    description: "Perform one relationship change: replace notes/set last contact, add one open item, or resolve one open item. Open-item resolution and note replacement are not automatically reversible.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID (default: arlo)"),
      name: z.string().min(1).describe("Person's name"),
      last_contact: z.string().nullable().optional().describe("Set last contact to 'now' or an ISO 8601 date"),
      note: z.string().nullable().optional().describe("Replace the relationship notes"),
      add_item: z.string().nullable().optional().describe("Add one open item"),
      resolve_item: z.number().int().min(0).nullable().optional().describe("Resolve an open item by its zero-based index"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        person_name: z.string(),
        action: z.string()
      }).strict()
    }).strict()
  },
  async ({ agent_id, name, last_contact, note, add_item, resolve_item }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");

    const operationCount = [
      add_item !== null && add_item !== undefined,
      resolve_item !== null && resolve_item !== undefined,
      (last_contact !== null && last_contact !== undefined) || (note !== null && note !== undefined),
    ].filter(Boolean).length;
    if (operationCount !== 1) {
      return makeErrorResponse(
        "cortex_relationship_update",
        "invalid_operation",
        "Specify exactly one change: add_item, resolve_item, or profile fields (last_contact/note).",
        {},
        { agent_id: agent_id ?? "arlo" },
      );
    }

    if (add_item) {
      await addOpenItem(agentId, name, add_item);
      return makeStructuredResponse("cortex_relationship_update", { person_name: name, action: "added_item" }, `Added open item for ${name}.`, { agent_id: agent_id ?? "arlo" });
    }

    if (resolve_item !== null && resolve_item !== undefined) {
      const { resolveOpenItem } = await import("../social/relationships.js");
      await resolveOpenItem(agentId, name, resolve_item);
      return makeStructuredResponse("cortex_relationship_update", { person_name: name, action: "resolved_item" }, `Resolved open item #${resolve_item} for ${name}.`, { agent_id: agent_id ?? "arlo" });
    }

    const updates: Record<string, unknown> = {};
    if (last_contact !== null && last_contact !== undefined) {
      const parsed = last_contact === "now" ? "now" : new Date(last_contact);
      if (parsed !== "now" && Number.isNaN(parsed.getTime())) {
        return makeErrorResponse("cortex_relationship_update", "invalid_date", "last_contact must be 'now' or a valid ISO 8601 date.", {}, { agent_id: agent_id ?? "arlo" });
      }
      updates.lastContact = parsed;
    }
    if (note !== null && note !== undefined) updates.notes = note;

    const updated = await updateRelationship(agentId, name, updates);
    return makeStructuredResponse("cortex_relationship_update", { person_name: updated.personName, action: "updated" }, `Updated ${updated.personName}.`, { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_reason (Phase 6) ────────────────────
server.registerTool(
  "cortex_reason",
  {
    description: "Store a reasoning trace for a significant decision. Records the decision, options considered, rationale, and confidence.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      decision: z.string().describe("What was decided"),
      context: z.string().describe("Context/situation"),
      options: z.array(z.object({
        name: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
      })).nullable().optional().describe("Options that were considered, if alternatives were evaluated"),
      chosen: z.string().describe("Which option was chosen"),
      rationale: z.string().describe("Why this option was chosen"),
      confidence: z.number().min(0).max(1).describe("HONEST Confidence in the decision (0.0 to 1.0). DO NOT default to 0.5 or 1.0. Cortex uses this to audit your metacognitive bias."),
      reversible: z.boolean().default(true).describe("Is this decision easily reversible?"),
      impacts: z.array(z.string()).default([]).describe("Expected impacts"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        reasoning_id: z.number()
      })
    })
  },
  async ({ agent_id, decision, context, options, chosen, rationale, confidence, reversible, impacts }) => {
    const agentId = await resolveAgent(agent_id);
    const id = await storeReasoningTrace(agentId, {
      decision, context, options: options ?? undefined, chosen, rationale, confidence, reversible, impacts,
    });
    return makeStructuredResponse("cortex_reason", { reasoning_id: id }, `Reasoning trace stored (artifact #${id}).`, { agent_id });
  }
);

// ─── Tool: cortex_audit (Phase 6) ─────────────────────
server.registerTool(
  "cortex_audit",
  {
    description: "Run a weekly reasoning audit. Analyzes recent reasoning traces for consistency, confidence calibration, bias, and alignment with core values.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      period: z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/).nullable().optional().describe("Optional ISO week label, for example '2026-W07'"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        audit_result: z.object({
          period: z.string(),
          traces_analyzed: z.number(),
          average_confidence: z.number(),
          confidence_distribution: z.record(z.number()),
          patterns: z.array(z.string()),
          bias_indicators: z.array(z.string()),
          alignment_notes: z.array(z.string()),
          recommendations: z.array(z.string()),
        }).strict()
      })
    })
  },
  async ({ agent_id, period }) => {
    const agentId = await resolveAgent(agent_id);
    // Manual/on-demand audit always runs (force=true); the scheduled weekly
    // runner dedups against recent audits.
    const result = await runWeeklyAudit(agentId, period ?? undefined, true);
    return makeStructuredResponse("cortex_audit", { audit_result: {
      period: result.period,
      traces_analyzed: result.tracesAnalyzed,
      average_confidence: result.avgConfidence,
      confidence_distribution: result.confidenceDistribution,
      patterns: result.patterns,
      bias_indicators: result.biasIndicators,
      alignment_notes: result.alignmentNotes,
      recommendations: result.recommendations,
    } }, formatAuditResult(result), { agent_id });
  }
);

// ─── Tool: cortex_monologue (Phase 6) ─────────────────
server.registerTool(
  "cortex_monologue",
  {
    description: "Record an inner monologue entry - a self-directed thought that is not yet a conclusion. Concrete triggers: you abandoned an approach (record why), you noticed a pattern recurring across sessions, you formed a hypothesis worth testing later, or something felt off but you cannot prove it yet. Cheaper and looser than cortex_artifact; these entries feed future recall and the weekly audit.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      content: z.string().describe("The thought or observation"),
      context: z.string().nullable().optional().describe("What triggered this thought"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        monologue_id: z.number()
      })
    })
  },
  async ({ agent_id, content, context }) => {
    const agentId = await resolveAgent(agent_id);
    const id = await writeInnerMonologue(agentId, content, context ?? undefined);
    return makeStructuredResponse("cortex_monologue", { monologue_id: id }, `Inner monologue stored (artifact #${id}).`, { agent_id });
  }
);

// ─── Tool: cortex_reconsolidate ─────────────────────────
server.registerTool(
  "cortex_reconsolidate",
  {
    description: "Update a previously recalled memory with new information. The memory must have been recalled within the last hour (labile window) - cortex_search/cortex_recall open the window, and cortex_labile lists current candidates. PREFER this over cortex_ingest whenever the new information updates, corrects, or extends something CORTEX already knows. The original content is preserved as an audit trail.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      memory_id: z.number().int().positive().describe("ID of the memory to update (must have been recently recalled)"),
      new_content: z.string().min(1).describe("The complete updated memory content"),
      reason: z.string().default("belief_update").describe("Why the memory is being updated (e.g., correction, expansion, refinement, belief_update)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        memory_id: z.number(),
        status: z.enum(["updated", "not_found", "not_labile", "window_closed"]),
        reason: z.string(),
        artifact_id: z.number().nullable().optional(),
        resonance_boost: z.number().nullable().optional()
      })
    })
  },
  async ({ agent_id, memory_id, new_content, reason }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await reconsolidate(agentId, memory_id, new_content, reason);

    if (result.status === "not_found") {
      return makeStructuredResponse("cortex_reconsolidate", { memory_id, status: "not_found" as const, reason }, `Memory #${memory_id} not found.`, { agent_id });
    }
    if (result.status === "not_labile") {
      return makeStructuredResponse("cortex_reconsolidate", { memory_id, status: "not_labile" as const, reason }, `Memory #${memory_id} has not been recalled recently. Search or recall it first to open the reconsolidation window.`, { agent_id });
    }
    if (result.status === "window_closed") {
      return makeStructuredResponse("cortex_reconsolidate", { memory_id, status: "window_closed" as const, reason }, `Labile window for memory #${memory_id} has closed (>1 hour since recall). Recall it again to reopen.`, { agent_id });
    }

    const humanReadable = `Memory #${memory_id} reconsolidated.\nReason: ${reason}\nResonance boost: +${result.resonanceBoost.toFixed(1)}\nOriginal preserved as artifact #${result.artifactId}.\n\nPrevious: "${result.previousContent?.slice(0, 200)}..."\nUpdated: "${result.newContent?.slice(0, 200)}..."`;
    return makeStructuredResponse("cortex_reconsolidate", {
      memory_id,
      status: "updated" as const,
      reason,
      artifact_id: result.artifactId,
      resonance_boost: result.resonanceBoost
    }, humanReadable, { agent_id });
  }
);

// ─── Tool: cortex_labile ────────────────────────────────
server.registerTool(
  "cortex_labile",
  {
    description: "List all currently labile (modifiable) memories. These are memories recalled in the last hour that can be updated via cortex_reconsolidate.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        labile_memories: z.array(z.object({
          memory_id: z.number(),
          recalled_at: z.string(),
          content: z.string()
        }))
      })
    })
  },
  async ({ agent_id }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse("cortex_labile", "agent_not_found", `Agent "${agent_id}" does not exist.`, {}, { agent_id });
    }
    const labile = await getLabileMemories(agentId);

    if (labile.length === 0) {
      return makeStructuredResponse("cortex_labile", { labile_memories: [] }, "No labile memories. Recall or search for memories first to open reconsolidation windows.", { agent_id });
    }

    const formatted = labile
      .map((m) => `- Memory #${m.id} (recalled ${new Date(m.recalledAt).toLocaleTimeString()}): "${m.content.slice(0, 120)}..."`)
      .join("\n");

    const structuredData = {
      labile_memories: labile.map(m => ({
        memory_id: m.id,
        recalled_at: new Date(m.recalledAt).toISOString(),
        content: m.content
      }))
    };

    return makeStructuredResponse("cortex_labile", structuredData, `# Labile Memories (${labile.length})\nThese can be updated via cortex_reconsolidate:\n\n${formatted}`, { agent_id });
  }
);

// ─── Tool: cortex_skill_store ────────────────────────────
server.registerTool(
  "cortex_skill_store",
  {
    description: "Store a new procedural memory (skill, workflow, pattern, preference, or heuristic). Use this when you learn HOW to do something, identify a repeatable process, or discover a pattern that should be remembered as a capability. FIRST check cortex_skill_retrieve: if a similar skill exists, improve it with cortex_skill_refine instead of storing a variant. After applying any skill, record the outcome with cortex_skill_executed so proficiency tracking works.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      name: z.string().describe("Short name for the skill/workflow (e.g., 'Client proposal writing')"),
      description: z.string().describe("Detailed description of how to execute this"),
      procedural_type: z.enum(["skill", "workflow", "pattern", "preference", "heuristic"]).describe("Type of procedural knowledge"),
      trigger_context: z.string().describe("When does this apply? What triggers it?"),
      steps: z.array(z.string()).default([]).describe("Step-by-step execution or key principles"),
      domain_tags: z.array(z.string()).default([]).describe("Domain tags for retrieval (e.g., ['sales', 'outreach'])"),
      source_memory_ids: proceduralSourceMemoryIdsInputSchema.nullable().optional().describe("IDs of episodic memories where this was learned (maximum 100 unique positive PostgreSQL integer IDs; duplicates are normalized)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        procedural_id: z.number(),
        status: z.literal("stored"),
        name: z.string(),
        type: z.string()
      })
    })
  },
  async ({ agent_id, name, description, procedural_type, trigger_context, steps, domain_tags, source_memory_ids }) => {
    const agentId = await resolveAgent(agent_id);
    let id;
    try {
      id = await storeProcedural({
        agentId, name, description, proceduralType: procedural_type,
        triggerContext: trigger_context, steps, domainTags: domain_tags,
        sourceMemoryIds: source_memory_ids ?? undefined,
      });
    } catch (error) {
      if (error instanceof InvalidSourceMemoryReferencesError) {
        return makeErrorResponse(
          "cortex_skill_store",
          error.code,
          "One or more source memory references are invalid.",
          {},
          { agent_id }
        );
      }
      throw error;
    }
    return makeStructuredResponse("cortex_skill_store", {
      procedural_id: id,
      status: "stored",
      name,
      type: procedural_type
    }, `Procedural memory stored: "${name}" (${procedural_type}) → #${id}`, { agent_id });
  }
);

// ─── Tool: cortex_skill_retrieve ────────────────────────
server.registerTool(
  "cortex_skill_retrieve",
  {
    description: "Retrieve relevant skills, workflows, or patterns for a given task. Use this BEFORE starting a task to check if you already know how to do it.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      task_context: z.string().min(1).describe("Describe the task you're about to do"),
      limit: z.number().int().min(1).max(20).default(5).describe("Maximum results (default: 5)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        task_context: z.string(),
        skills: z.array(z.object({
          procedural_id: z.number(),
          name: z.string(),
          type: z.string(),
          proficiency: z.string(),
          success_rate: z.number(),
          execution_count: z.number(),
          relevance_score: z.number(),
          match_type: z.enum(["trigger", "semantic"]),
          trigger_context: z.string(),
          description: z.string(),
          steps: z.array(z.string())
        }))
      })
    })
  },
  async ({ agent_id, task_context, limit }) => {
    const agentId = await resolveExistingAgent(agent_id);
    if (agentId === null) {
      return makeErrorResponse("cortex_skill_retrieve", "agent_not_found", `Agent "${agent_id}" does not exist.`, {}, { agent_id });
    }
    const results = await retrieveProcedural(agentId, task_context, limit);

    if (results.length === 0) {
      return makeStructuredResponse("cortex_skill_retrieve", { task_context, skills: [] }, "No matching procedural memories found. This may be a new task type.", { agent_id });
    }

    const structuredData = {
      task_context,
      skills: results.map(r => ({
        procedural_id: r.memory.id,
        name: r.memory.name,
        type: r.memory.proceduralType,
        proficiency: r.memory.proficiency,
        success_rate: r.memory.successRate,
        execution_count: r.memory.executionCount,
        relevance_score: r.relevanceScore,
        match_type: r.matchType,
        trigger_context: r.memory.triggerContext,
        description: r.memory.description,
        steps: r.memory.steps
      }))
    };

    const formatted = results.map((r) => {
      const steps = r.memory.steps.length > 0
        ? `\nSteps:\n${r.memory.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
        : "";
      return `## Skill #${r.memory.id} "${r.memory.name}" (${r.memory.proceduralType}) [${r.memory.proficiency}]\nMatch: ${r.matchType} (${r.relevanceScore.toFixed(3)})\nTrigger: ${r.memory.triggerContext}\nSuccess rate: ${(r.memory.successRate * 100).toFixed(0)}% (${r.memory.executionCount} executions)${steps}\n\n${r.memory.description}`;
    }).join("\n\n---\n\n");

    return makeStructuredResponse("cortex_skill_retrieve", structuredData, `# Procedural Memories for: "${task_context}"\n\n${formatted}\n\n---\nAfter applying a skill, record the outcome: cortex_skill_executed(procedural_id=<Skill #>, success=true|false).`, { agent_id });
  }
);

// ─── Tool: cortex_skill_executed ────────────────────────
server.registerTool(
  "cortex_skill_executed",
  {
    description: "Record that you applied a procedural memory and whether it was successful. This is how skills improve over time.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      procedural_id: z.number().int().positive().describe("ID of the procedural memory that was applied"),
      success: z.boolean().describe("Was the outcome successful?"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        procedural_id: z.number(),
        success: z.boolean(),
        new_proficiency: z.string(),
        new_success_rate: z.number()
      })
    })
  },
  async ({ agent_id, procedural_id, success }) => {
    const agentId = await resolveAgent(agent_id);
    let result;
    try {
      result = await recordExecution(agentId, procedural_id, success);
    } catch (error) {
      if (error instanceof ProceduralMemoryNotFoundError) {
        return makeErrorResponse(
          "cortex_skill_executed",
          error.code,
          "Procedural memory not found.",
          {},
          { agent_id }
        );
      }
      throw error;
    }
    return makeStructuredResponse("cortex_skill_executed", {
      procedural_id,
      success,
      new_proficiency: result.proficiency,
      new_success_rate: result.successRate
    }, `Execution recorded for #${procedural_id}. Proficiency: ${result.proficiency}. Success rate: ${(result.successRate * 100).toFixed(0)}%.`, { agent_id });
  }
);

// ─── Tool: cortex_skill_refine ──────────────────────────
server.registerTool(
  "cortex_skill_refine",
  {
    description: "Replace selected fields on an existing procedural memory and regenerate its embedding. The previous active version is not automatically restorable.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      procedural_id: z.number().int().positive().describe("ID of the procedural memory to refine"),
      description: z.string().min(1).nullable().optional().describe("Updated description"),
      steps: z.array(z.string().min(1)).nullable().optional().describe("Updated steps"),
      trigger_context: z.string().min(1).nullable().optional().describe("Updated trigger context"),
      domain_tags: z.array(z.string().min(1)).nullable().optional().describe("Updated domain tags"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        procedural_id: z.number(),
        status: z.literal("refined"),
        new_version: z.number()
      })
    })
  },
  async ({ agent_id, procedural_id, description, steps, trigger_context, domain_tags }) => {
    if ([description, steps, trigger_context, domain_tags].every((value) => value === null || value === undefined)) {
      return makeErrorResponse("cortex_skill_refine", "empty_refinement", "At least one refinement field is required.", { procedural_id }, { agent_id });
    }
    const agentId = await resolveAgent(agent_id);
    let newVersion;
    try {
      newVersion = await refineProcedural(agentId, procedural_id, {
        description: description ?? undefined,
        steps: steps ?? undefined,
        triggerContext: trigger_context ?? undefined,
        domainTags: domain_tags ?? undefined,
      });
    } catch (error) {
      if (error instanceof ProceduralMemoryNotFoundError) {
        return makeErrorResponse(
          "cortex_skill_refine",
          error.code,
          "Procedural memory not found.",
          {},
          { agent_id }
        );
      }
      throw error;
    }
    return makeStructuredResponse("cortex_skill_refine", {
      procedural_id,
      status: "refined",
      new_version: newVersion
    }, `Procedural memory #${procedural_id} refined → v${newVersion}`, { agent_id });
  }
);

// ─── Start Server ───────────────────────────────────────
type McpShutdownReason =
  | "SIGINT"
  | "SIGTERM"
  | "stdin_end"
  | "stdin_close"
  | "stdin_error"
  | "fatal_startup";

const MCP_SHUTDOWN_TIMEOUT_MS = 10_000;
const bufferedStdin = new PassThrough();
let activeTransport: StdioServerTransport | null = null;
let connectionAttempted = false;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let requestedExitCode = 0;

function recordMcpFailure(): void {
  requestedExitCode = 1;
  process.exitCode = 1;
}

function requestMcpShutdown(
  reason: McpShutdownReason,
  exitCode: 0 | 1
): Promise<void> {
  if (exitCode !== 0) recordMcpFailure();
  if (shutdownPromise) return shutdownPromise;

  shuttingDown = true;
  shutdownPromise = (async () => {
    process.stdin.unpipe(bufferedStdin);
    const deadline = setTimeout(() => {
      console.error("[cortex-mcp] Shutdown deadline reached");
      process.exit(1);
    }, MCP_SHUTDOWN_TIMEOUT_MS);

    try {
      try {
        if (connectionAttempted) {
          await server.close();
        } else if (activeTransport) {
          await activeTransport.close();
        }
      } catch {
        console.error("[cortex-mcp] MCP transport close failed");
        recordMcpFailure();
      } finally {
        bufferedStdin.destroy();
      }

      try {
        await closeDatabaseConnection();
      } catch {
        console.error("[cortex-mcp] Database connection close failed");
        recordMcpFailure();
      }
    } finally {
      clearTimeout(deadline);
    }

    process.exitCode = requestedExitCode;
    console.error("[cortex-mcp] Shutdown complete", { reason });
    // A database handshake already in flight can retain a socket even after the
    // pool has closed. Cleanup is complete, so terminate with the recorded code.
    process.exit(requestedExitCode);
  })();

  return shutdownPromise;
}

// Register lifecycle hooks before database initialization so a signal or stdin
// disconnect cannot race startup and leave a pool or transport behind.
process.once("SIGINT", () => {
  void requestMcpShutdown("SIGINT", 0);
});
process.once("SIGTERM", () => {
  void requestMcpShutdown("SIGTERM", 0);
});
process.stdin.once("end", () => {
  void requestMcpShutdown("stdin_end", 0);
});
process.stdin.once("close", () => {
  void requestMcpShutdown("stdin_close", 0);
});
process.stdin.once("error", () => {
  console.error("[cortex-mcp] Standard input failed");
  void requestMcpShutdown("stdin_error", 1);
});
// Buffer early protocol bytes without losing them while schema readiness is
// checked. Piping also makes EOF observable before transport construction.
process.stdin.pipe(bufferedStdin);

async function main() {
  await initDatabase();
  if (shuttingDown) return;

  activeTransport = new StdioServerTransport(bufferedStdin, process.stdout);
  connectionAttempted = true;
  await server.connect(activeTransport);
  if (shuttingDown) {
    await requestMcpShutdown("stdin_close", 0);
    return;
  }

  console.error("[cortex-mcp] CORTEX V2 MCP server running");
}

main().catch(() => {
  if (shuttingDown) return;
  console.error("[cortex-mcp] Fatal:", {
    errorType: "McpStartupError",
  });
  void requestMcpShutdown("fatal_startup", 1);
});
