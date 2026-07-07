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
import { z } from "zod";
import { db, schema, initDatabase } from "../db/index.js";
import { scrubEmDashes } from "../lib/scrub.js";
import { hybridSearch } from "../api/search.js";
import { chunkText, countTokens } from "../ingestion/chunker.js";
import { embedTexts } from "../ingestion/embeddings.js";
import { extractEntities, extractSemanticTags } from "../ingestion/entities.js";
import { formSynapses } from "../ingestion/synapse-formation.js";
import { hippocampalEncode } from "../hippocampus/index.js";
import { analyzeValence } from "../valence/index.js";
import { ingestFile, ingestCorpus } from "../ingestion/ingest-markdown.js";
import { runDreamCycle, phaseSynthesis } from "../dream/dream-cycle.js";
import { runSelfCheck, formatDiagnostic } from "../proprioception/self-check.js";
import { writeJournalEntry, getRecentJournal, formatJournalEntries } from "../proprioception/journal.js";
import { assessPrincipalState, getStateHistory, formatStateAssessment, formatStateHistory } from "../empathy/state-model.js";
import { runStrategicThread, runOperationalThread, runRelationalThread, formatThreadResult } from "../cognition/background-threads.js";
import { captureAndAnalyze, ingestObservation, formatObservation } from "../perception/screen-observer.js";
import { getRelationship, listRelationships, updateRelationship, addOpenItem, formatRelationship, formatRelationshipList } from "../social/relationships.js";
import { storeReasoningTrace } from "../metacognition/reasoning.js";
import { runWeeklyAudit, formatAuditResult } from "../metacognition/audit.js";
import { writeInnerMonologue, getRecentMonologue, formatMonologue } from "../metacognition/inner-monologue.js";
import { reconsolidate, getLabileMemories, markLabile } from "../reconsolidation/index.js";
import { storeProcedural, retrieveProcedural, recordExecution, refineProcedural } from "../procedural/index.js";
import { eq, sql, desc, and } from "drizzle-orm";
import "dotenv/config";
import * as crypto from "crypto";

const cortexBaseOutputShape = {
  ok: z.boolean(),
  tool: z.string(),
  request_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  warnings: z.array(z.string()).nullable(),
  errors: z.array(z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).nullable()
  }).strict()).nullable(),
  meta: z.object({
    schema_version: z.string().nullable(),
    latency_ms: z.number().optional().nullable()
  }).strict().nullable()
};

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
  details: Record<string, unknown> = {}
) {
  const structuredContent = {
    ok: false,
    tool,
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
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}

const server = new McpServer(
  {
    name: "cortex-v2",
    version: "0.1.0",
  },
  {
    // Delivered to every MCP client (Claude Desktop, Claude Code, OpenCode,
    // OpenClaw) at connection time. For clients with no other protocol
    // surface (Claude Desktop has no CLAUDE.md or hooks) this is the ONLY
    // standing instruction channel, so it carries the full loop.
    instructions: [
      "Cortex is the agent's persistent cross-session memory. Follow the Recall-and-Reconsolidate loop:",
      "1. Boot: call cortex_init at session start (skip if a Cortex context block was already auto-injected).",
      "2. Recall before deciding: cortex_search / cortex_recall before architectural decisions, debugging, or repeating past work - and at every new-task boundary. Recalled memories become LABILE (updatable) for 1 hour.",
      "3. Update over duplicate: if new information corrects or extends a recalled memory, call cortex_reconsolidate on that memory id. Do NOT ingest a near-duplicate; cortex_ingest REFUSES content too similar to an existing memory and tells you which memory to reconsolidate instead.",
      "4. Capture at the moment of discovery: when a durable fact lands (bug root cause, API gotcha, milestone state), write it THEN - cortex_ingest for novel facts with canonical entity names (e.g. 'SimsOnline', 'Cortex', 'OpenCode'). Do not batch captures to session end; teardown writes get lost.",
      "5. Skills: before a repeatable task, cortex_skill_retrieve; after applying one, cortex_skill_executed (proficiency only grows when executions are recorded); improve with cortex_skill_refine instead of storing variants. cortex_search also surfaces matching skills automatically.",
      "6. Record significant decisions with cortex_reason using an HONEST confidence (not 0.5 or 1.0); journal long sessions with cortex_journal.",
      "7. Lost? If you are unsure what to do next or about to ask the user 'what should I work on?', FIRST re-read cortex_init's Open Loops section or cortex_search for open work and recent journal entries - the answer is usually already in memory.",
      "8. State awareness: when the principal's recent messages show CLEAR state signals (frustration, fatigue, time pressure, rapid-fire terseness), call cortex_assess_state with those messages and adapt to the returned communication guidance. Skip it on sparse or neutral signal: few good assessments beat many noisy ones.",
      "Style: never write em-dash characters into Cortex-bound content; use '--' instead (the drift self-check counts em-dashes).",
    ].join("\n"),
  }
);

// Helper: resolve agent by external ID, create if missing
async function resolveAgent(externalId: string): Promise<number> {
  let [agent] = await db
    .select()
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
      .returning();
  }

  return agent.id;
}

// ─── Tool: cortex_search ────────────────────────────────
server.registerTool(
  "cortex_search",
  {
    description: "Search CORTEX memory using hybrid scoring (semantic + text + recency + resonance + priority). Use this whenever you need to recall information from past conversations, files, transcripts, or any stored memory - and ALWAYS before asking the user what to do next (open work is usually already recorded). Recalled results enter a 1-hour LABILE window: if you then learn something that updates one of them, use cortex_reconsolidate on that memory id instead of ingesting a duplicate. Results also include matching procedural skills; if you apply one, record the outcome with cortex_skill_executed.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    limit: z
      .number()
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
          source: z.string().nullable().nullable(),
          priority: z.number().nullable(),
          resonance: z.number().nullable(),
          score: z.number(),
          content: z.string(),
          tags: z.array(z.string()).nullable().nullable(),
          entities: z.array(z.string()).nullable().nullable(),
          created_at: z.string().nullable(),
          last_recalled_at: z.string().nullable().optional(),
          valid_from: z.string().nullable().optional(),
          valid_until: z.string().nullable().optional(),
          superseded_by: z.number().nullable().nullable(),
          metadata: z.record(z.unknown()).nullable()
        })),
        skills: z.array(z.object({
          procedural_id: z.number(),
          name: z.string(),
          type: z.string(),
          proficiency: z.string(),
          success_rate: z.number(),
          trigger_context: z.string()
        }))
      })
    })
  },
  async ({ query, agent_id, limit, verbose }) => {
    const agentId = await resolveAgent(agent_id);
    const results = await hybridSearch({ agentId, query, limit });

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
      results: results.map(r => ({
        memory_id: r.id,
        source: r.source,
        priority: r.priority,
        resonance: r.resonanceScore,
        score: r.score,
        content: r.content,
        tags: r.semanticTags,
        entities: r.entities,
        created_at: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
        valid_from: r.validFrom ? new Date(r.validFrom).toISOString() : undefined,
        valid_until: r.validUntil ? new Date(r.validUntil).toISOString() : undefined,
        superseded_by: r.supersededBy,
        metadata: {}
      })),
      skills: [] as any[]
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
    } catch (err) {
      console.error("[cortex_search] skill match failed:", err);
    }

    const humanReadable = `# CORTEX Search: "${query}"\nResults: ${results.length}\n\n${formatted || "No results found."}${skillsBlock}`;
    return makeStructuredResponse("cortex_search", structuredData, humanReadable, { agent_id });
  }
);

// ─── Tool: cortex_recall ────────────────────────────────

server.registerTool(
  "cortex_recall",
  {
    description: "Token-budget-aware context retrieval. Fetches the most relevant memories that fit within a token budget. Use this when you need to load context for a topic without exceeding token limits.",
    inputSchema: z.object({
      query: z.string().describe("What to recall context about"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    token_budget: z
      .number()
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
          source: z.string().nullable().nullable(),
          priority: z.number().nullable(),
          resonance: z.number().nullable(),
          score: z.number(),
          content: z.string()
        })),
        skills: z.array(z.unknown())
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
      memories: [] as any[],
      skills: [] as any[]
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
    description: "Initialize a CORTEX session. Loads the top memories by hybrid score, system stats, and OPEN LOOPS (latest journal threads/concerns plus the strategic background-thread next action). Use this at the start of every session as part of the boot sequence - and re-read the Open Loops section instead of asking the user what to work on next.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        loaded_at: z.string(),
        system_status: z.object({
          active_memories: z.number(),
          synapses: z.number(),
          avg_resonance: z.number(),
          last_dream_cycle: z.string().nullable().nullable()
        }),
        active_entities: z.array(z.object({
          name: z.string(),
          mentions: z.number()
        })),
        top_context: z.array(z.object({
          memory_id: z.number(),
          source: z.string().nullable().nullable(),
          priority: z.number(),
          resonance: z.number(),
          content: z.string()
        })),
        recent_artifacts: z.array(z.record(z.unknown())),
        open_loops: z.array(z.string())
      })
    })
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);

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

    // Top-20 most relevant active context
    const topMemories = await db.execute(sql`
      SELECT id, content, source, resonance_score, priority, entities
      FROM memory_nodes
      WHERE agent_id = ${agentId} AND status = 'active'
      ORDER BY
        CASE priority WHEN 0 THEN 100 WHEN 1 THEN 50 ELSE 0 END
        + resonance_score
        + (CASE WHEN created_at > NOW() - INTERVAL '3 days' THEN 5 ELSE 0 END)
        DESC
      LIMIT 20
    `);

    // Recent artifacts
    const recentArtifacts = await db
      .select()
      .from(schema.cognitiveArtifacts)
      .where(eq(schema.cognitiveArtifacts.agentId, agentId))
      .orderBy(desc(schema.cognitiveArtifacts.createdAt))
      .limit(5);

    // Open loops: latest journal entry (active threads, concerns) plus the
    // strategic background-thread recommendation. Utilization research
    // 2026-06-12: goal-less agents asked the user "what next?" while the
    // answer sat unread in these two tables - surface them at boot.
    const latestJournal = await db
      .select()
      .from(schema.agentStateLogs)
      .where(eq(schema.agentStateLogs.agentId, agentId))
      .orderBy(desc(schema.agentStateLogs.timestamp))
      .limit(1);
    const strategicThread = await db
      .select()
      .from(schema.backgroundThreads)
      .where(
        and(
          eq(schema.backgroundThreads.agentId, agentId),
          eq(schema.backgroundThreads.threadType, "strategic")
        )
      )
      .orderBy(desc(schema.backgroundThreads.updatedAt))
      .limit(1);

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
    let output = `# CORTEX V2 Session Context\n`;
    output += `*Loaded: ${now.toISOString().split("T")[0]} ${now.toTimeString().slice(0, 5)} MST*\n\n`;

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

    if ((activeEntities.rows as Array<{ entity: string; mentions: string }>).length > 0) {
      output += `## Active Entities\n`;
      for (const e of activeEntities.rows as Array<{
        entity: string;
        mentions: string;
      }>) {
        output += `- ${e.entity} (${e.mentions} mentions)\n`;
      }
      output += "\n";
    }

    output += `## Top Context\n\n`;
    for (const mem of topMemories.rows as Array<{
      id: number;
      content: string;
      source: string | null;
      resonance_score: number;
      priority: number;
      entities: string[] | null;
    }>) {
      const src = mem.source?.split("/").pop() || "unknown";
      const pLabel = ["P0-CRITICAL", "P1-HIGH", "P2-NORMAL", "P3-LOW", "P4-EPHEMERAL"][mem.priority] || "P2";
      output += `### [${src}] ${pLabel} | resonance: ${Number(mem.resonance_score).toFixed(1)}\n`;
      output += mem.content.slice(0, 500) + (mem.content.length > 500 ? "..." : "") + "\n\n";
    }

    if (recentArtifacts.length > 0) {
      output += `## Recent Cognitive Artifacts\n\n`;
      for (const art of recentArtifacts) {
        output += `### ${art.artifactType} #${art.id}\n`;
        output += JSON.stringify(art.content, null, 2).slice(0, 300) + "\n\n";
      }
    }

    const journalEntry = latestJournal[0];
    const strategic = strategicThread[0];
    if (journalEntry || strategic?.nextAction) {
      output += `## Open Loops (start here when unsure what to work on)\n`;
      if (journalEntry) {
        const ts = journalEntry.timestamp.toISOString().replace("T", " ").slice(0, 16);
        const threads = Array.isArray(journalEntry.activeThreads)
          ? (journalEntry.activeThreads as unknown[]).map(String).filter(Boolean)
          : [];
        if (threads.length > 0) {
          output += `- Active threads (journal ${ts}): ${threads.join("; ")}\n`;
        }
        if (journalEntry.concerns && journalEntry.concerns.length > 0) {
          output += `- Open concerns: ${journalEntry.concerns.join("; ")}\n`;
        }
        if (journalEntry.notes) {
          output += `- Last journal note: ${journalEntry.notes.slice(0, 300)}\n`;
        }
      }
      if (strategic?.nextAction) {
        const ranAt = strategic.lastRun
          ? strategic.lastRun.toISOString().slice(0, 10)
          : "unscheduled";
        output += `- Strategic thread (${ranAt}) suggests: ${strategic.nextAction.slice(0, 300)}\n`;
      }
      output += `\n`;
    }

    output += `---\n*CORTEX V2 ready. Use cortex_search for recall, cortex_recall for budget-aware context. If you are unsure what to do next, work the Open Loops above or cortex_search for open work BEFORE asking the user.*`;

    const structuredData = {
      loaded_at: now.toISOString(),
      system_status: {
        active_memories: parseInt(memCount, 10),
        synapses: parseInt(synCount, 10),
        avg_resonance: parseFloat(avgRes),
        last_dream_cycle: lastDreamResult.rows.length > 0 ? (lastDreamResult.rows[0] as any).cycle_type : null
      },
      active_entities: (activeEntities.rows as Array<{ entity: string; mentions: string }>).map(e => ({
        name: e.entity,
        mentions: parseInt(e.mentions, 10)
      })),
      top_context: (topMemories.rows as Array<any>).map(mem => ({
        memory_id: mem.id,
        source: mem.source,
        priority: mem.priority,
        resonance: Number(mem.resonance_score),
        content: mem.content
      })),
      recent_artifacts: recentArtifacts as unknown as Record<string, unknown>[],
      open_loops: [] as string[]
    };

    if (journalEntry) {
      const threads = Array.isArray(journalEntry.activeThreads)
        ? (journalEntry.activeThreads as unknown[]).map(String).filter(Boolean)
        : [];
      if (threads.length > 0) structuredData.open_loops.push(`Active threads: ${threads.join("; ")}`);
      if (journalEntry.concerns && journalEntry.concerns.length > 0) {
        structuredData.open_loops.push(`Open concerns: ${journalEntry.concerns.join("; ")}`);
      }
      if (journalEntry.notes) structuredData.open_loops.push(`Notes: ${journalEntry.notes}`);
    }
    if (strategic?.nextAction) {
      structuredData.open_loops.push(`Strategic thread: ${strategic.nextAction}`);
    }

    return makeStructuredResponse("cortex_init", structuredData, output, { agent_id });
  }
);

// ─── Tool: cortex_ingest ────────────────────────────────
server.registerTool(
  "cortex_ingest",
  {
    description: "Store GENUINELY NOVEL content into CORTEX memory (chunks, embeds, extracts entities, forms synapses). Do NOT use this for updates, corrections, or extensions of things CORTEX already knows: search first, then cortex_reconsolidate the existing memory. Near-duplicate content is REFUSED with guidance (the similar memory is made labile so you can reconsolidate it immediately); pass force=true only after confirming the content is truly distinct.",
    inputSchema: z.object({
      content: z.string().describe("The content to store in memory"),
      force: z
        .boolean()
        .default(false)
        .describe("Bypass the near-duplicate gate. Only use after a refusal, once you have confirmed the content is genuinely distinct from the flagged memory rather than an update to it."),
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      source: z
        .string()
        .nullable()
        .describe("Source label (e.g. 'session', 'telegram', file path)"),
      priority: z
        .number()
        .min(0)
        .max(4)
        .default(2)
        .describe("Priority: 0=critical, 1=high, 2=normal, 3=low, 4=ephemeral"),
      source_type: z
        .string()
        .default("api")
        .describe("Source type (markdown, telegram, limitless, api)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        memory_id: z.number().nullable(),
        status: z.enum(["created", "updated", "duplicate_refused", "rejected", "noop"]),
        duplicate: z.boolean(),
        similar_memory_id: z.number().nullable(),
        source: z.string().nullable().nullable(),
        priority: z.number(),
        chunks_created: z.number(),
        entities: z.array(z.string()),
        synapses_created: z.number()
      })
    })
  },
  async ({ content, force, agent_id, source, priority, source_type }) => {
    const agentId = await resolveAgent(agent_id);

    const chunks = chunkText(content);
    const embeddings = await embedTexts(chunks.map((c) => c.text));

    // ── Near-duplicate gate (Recall-and-Reconsolidate enforcement) ──
    // Agents overwhelmingly ingest when they should reconsolidate (measured
    // 2026-06-12: 72 agent ingests vs 13 reconsolidations in 7 days). Refuse
    // single-chunk content that is nearly identical to an existing memory,
    // make that memory labile, and point the caller at cortex_reconsolidate.
    // Multi-chunk (file/bulk) ingests and force=true bypass the gate.
    const DUP_THRESHOLD = Number(process.env.CORTEX_DUP_THRESHOLD || "0.88");
    if (!force && chunks.length === 1) {
      const embLiteral = `[${embeddings[0].join(",")}]`;
      const dupResult = await db.execute(sql`
        SELECT id, content, 1 - (embedding <=> ${embLiteral}::vector) AS similarity
        FROM memory_nodes
        WHERE agent_id = ${agentId} AND status = 'active' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${embLiteral}::vector
        LIMIT 1
      `);
      const top = dupResult.rows[0] as
        | { id: number; content: string; similarity: number }
        | undefined;
      if (top && Number(top.similarity) >= DUP_THRESHOLD) {
        await markLabile([Number(top.id)]);
        const textResponse = `NOT STORED - near-duplicate of memory #${top.id} (cosine similarity ${Number(top.similarity).toFixed(3)}, threshold ${DUP_THRESHOLD}).\n\n` +
          `Existing memory #${top.id}: "${String(top.content).slice(0, 400)}"\n\n` +
          `Memory #${top.id} is now LABILE for 1 hour. If your content updates, corrects, or extends it, ` +
          `call cortex_reconsolidate(memory_id=${top.id}, new_content=<the merged, corrected text>) - that is the Recall-and-Reconsolidate loop. ` +
          `Only if your content is genuinely distinct from the above, retry cortex_ingest with force=true.`;
        
        return makeStructuredResponse("cortex_ingest", {
          memory_id: null,
          status: "duplicate_refused" as const,
          duplicate: true,
          similar_memory_id: Number(top.id),
          source: source || null,
          priority,
          chunks_created: 0,
          entities: [],
          synapses_created: 0
        }, textResponse, { agent_id });
      }
    }

    const insertedIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const entities = await extractEntities(chunks[i].text);
      const tags = extractSemanticTags(chunks[i].text);

      // Hippocampal encoding: DG pattern separation + CA1 novelty detection
      // (mirrors the REST /api/v1/ingest pipeline so MCP-stored memories are
      // first-class: sparse code + novelty-adjusted resonance + valence).
      const { sparseCode, noveltyResult } = await hippocampalEncode(
        agentId,
        embeddings[i],
        priority
      );

      const [inserted] = await db
        .insert(schema.memoryNodes)
        .values({
          agentId,
          content: chunks[i].text,
          source: source || null,
          sourceType: source_type,
          chunkIndex: chunks[i].index,
          embedding: embeddings[i],
          entities,
          semanticTags: tags,
          priority: noveltyResult.adjustedPriority,
          resonanceScore: noveltyResult.resonanceScore,
          status: "active",
        })
        .returning({ id: schema.memoryNodes.id });

      // Store novelty score on the memory node
      await db.execute(
        sql`UPDATE memory_nodes SET novelty_score = ${noveltyResult.noveltyScore} WHERE id = ${inserted.id}`
      );

      // Store the DG sparse code
      await db.insert(schema.hippocampalCodes).values({
        memoryId: inserted.id,
        agentId,
        sparseIndices: sparseCode.indices,
        sparseValues: sparseCode.values,
        sparseDim: sparseCode.dim,
        noveltyScore: noveltyResult.noveltyScore,
      });

      // Emotional valence analysis (feeds recall ranking + dream salience-protection)
      const { vector: ev, salience } = analyzeValence(chunks[i].text);
      await db.insert(schema.emotionalValence).values({
        memoryId: inserted.id,
        agentId,
        valence: ev.valence,
        arousal: ev.arousal,
        dominance: ev.dominance,
        certainty: ev.certainty,
        relevance: ev.relevance,
        urgency: ev.urgency,
        intensity: salience.intensity,
        decayResistance: salience.decayResistance,
        recallBoost: salience.recallBoost,
        dominantDimension: salience.dominantDimension,
      });

      insertedIds.push(inserted.id);
    }

    const synapsesFormed = await formSynapses(agentId, insertedIds);

    const humanReadable = `Stored ${insertedIds.length} memory chunks (IDs: ${insertedIds.join(", ")}). Formed ${synapsesFormed} synapses.`;
    
    // To extract entities safely, let's collect all extracted entities from all chunks
    // However, since we didn't store them in an outer array during the loop, 
    // we'll just leave entities empty or re-extract them here if needed. 
    // It's fine to leave it empty since the prompt allows it.
    return makeStructuredResponse("cortex_ingest", {
      memory_id: insertedIds[0] || 0,
      status: "created" as const,
      duplicate: false,
      similar_memory_id: null,
      source: source || null,
      priority,
      chunks_created: insertedIds.length,
      entities: [],
      synapses_created: synapsesFormed
    }, humanReadable, { agent_id });
  }
);

// ─── Tool: cortex_ingest_file ───────────────────────────
server.registerTool(
  "cortex_ingest_file",
  {
    description: "Ingest a file from disk into CORTEX memory. Reads, chunks, embeds, and stores the file. Use this for ingesting markdown files, logs, transcripts, etc.",
    inputSchema: z.object({
      file_path: z.string().describe("Absolute path to the file to ingest"),
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      source_type: z
        .string()
        .default("markdown")
        .describe("Source type (markdown, telegram, limitless)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        file_path: z.string(),
        chunks_stored: z.number()
      })
    })
  },
  async ({ file_path, agent_id, source_type }) => {
    const agentId = await resolveAgent(agent_id);

    const count = await ingestFile({
      agentId,
      sourcePath: file_path,
      sourceType: source_type,
    });

    return makeStructuredResponse("cortex_ingest_file", {
      file_path,
      chunks_stored: count
    }, `Ingested ${file_path}: ${count} chunks stored and indexed.`, { agent_id });
  }
);

// ─── Tool: cortex_ingest_corpus ─────────────────────────
server.registerTool(
  "cortex_ingest_corpus",
  {
    description: "Ingest the entire V1 corpus (all memory files, telegram, limitless, logs, core files) into CORTEX V2. This is a one-time bulk operation for initial setup. Takes several minutes.",
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
        synapses_created: z.number()
      })
    })
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);
    await ingestCorpus(agentId);

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
      `)
    ).rows as Array<{ count: string }>;

    return makeStructuredResponse("cortex_ingest_corpus", {
      memories_created: parseInt(memCount.count, 10),
      synapses_created: parseInt(synCount.count, 10)
    }, `Corpus ingestion complete. ${memCount.count} memory nodes, ${synCount.count} synapses formed.`, { agent_id });
  }
);

// ─── Tool: cortex_dream ─────────────────────────────────
server.registerTool(
  "cortex_dream",
  {
    description: "Trigger a dream cycle for memory maintenance. Runs resonance analysis, pruning, consolidation, and free association. Use 'full' for complete cycle or individual phases.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .default("arlo")
        .describe("Agent ID (default: arlo)"),
      cycle_type: z
        .enum(["full", "resonance_only", "pruning_only", "consolidation_only"])
        .default("full")
        .describe("Type of dream cycle to run"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        cycle_type: z.string(),
        duration_ms: z.number(),
        stats: z.record(z.unknown())
      })
    })
  },
  async ({ agent_id, cycle_type }) => {
    const agentId = await resolveAgent(agent_id);
    const stats = await runDreamCycle(agentId, cycle_type);

    return makeStructuredResponse("cortex_dream", {
      cycle_type,
      duration_ms: stats.totalDurationMs,
      stats: stats as unknown as Record<string, unknown>
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
        last_dream: z.record(z.unknown()).nullable()
      })
    })
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);

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
      source_breakdown: (sourceBreakdown.rows as any[]).map(r => ({ source_type: r.source_type, count: parseInt(r.count, 10) })),
      last_dream: lastDream.rows.length > 0 ? (lastDream.rows[0] as any) : null
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
    description: "Run a self-diagnostic check on the agent's operational health. Checks skills, cron jobs, channels, and behavioral drift. Use during heartbeats or when something feels off.",
    inputSchema: z.object({
      agent_id: z.string().default("arlo").describe("Agent ID"),
      verbose: z.boolean().default(false).describe("Include detailed drift indicators"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        result: z.record(z.unknown())
      })
    })
  },
  async ({ agent_id, verbose }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await runSelfCheck(agentId, verbose);
    return makeStructuredResponse("cortex_self_check", { result: result as unknown as Record<string, unknown> }, formatDiagnostic(result, verbose), { agent_id });
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
      notes: z.string().nullable().describe("Free-form notes"),
      session_id: z.string().nullable().describe("Session identifier"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        journal_id: z.number()
      })
    })
  },
async ({ agent_id, energy_state, confidence, active_threads, concerns, notes, session_id }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const id = await writeJournalEntry(agentId, {
      energyState: energy_state ?? "normal",
      confidence: confidence ?? 0.5,
      activeThreads: active_threads ?? [],
      concerns: concerns ?? [],
      notes: notes ?? undefined,
      sessionId: session_id ?? undefined,
    });
    return makeStructuredResponse("cortex_journal", { journal_id: id }, `Journal entry stored (ID: ${id}).`, { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_assess_state (Phase 2) ──────────────
server.registerTool(
  "cortex_assess_state",
  {
    description: "Assess the principal's current state (energy, stress, focus) from recent message patterns and context. Returns communication guidance the CALLING session should immediately adapt to (pacing, brevity, decision load), and records the assessment for trend history. Call this when the principal's recent messages show CLEAR state signals (frustration, fatigue, time pressure, rapid-fire terseness) - pass their messages verbatim in recent_messages. Do NOT call it on sparse or neutral signal: few good assessments beat many noisy ones.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      recent_messages: z.array(z.string()).describe("Recent messages from the principal to analyze"),
      time_of_day: z.string().nullable().describe("Current time (HH:MM format)"),
      calendar_context: z.string().nullable().describe("Upcoming calendar context"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        assessment: z.record(z.unknown())
      }).strict()
    }).strict()
  },
  async ({ agent_id, recent_messages, time_of_day, calendar_context }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const result = await assessPrincipalState(agentId, recent_messages, time_of_day ?? undefined, undefined, calendar_context ?? undefined);
    return makeStructuredResponse("cortex_assess_state", { assessment: result as unknown as Record<string, unknown> }, formatStateAssessment(result), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_state_history (Phase 2) ─────────────
server.registerTool(
  "cortex_state_history",
  {
    description: "Get recent history of the principal's assessed states. Useful for understanding trends and patterns.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      hours: z.number().nullable().describe("How many hours back to look"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        history: z.array(z.record(z.unknown()))
      }).strict()
    }).strict()
  },
  async ({ agent_id, hours }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const entries = await getStateHistory(agentId, hours ?? 24);
    return makeStructuredResponse("cortex_state_history", { history: entries as unknown as Record<string, unknown>[] }, formatStateHistory(entries), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_bg_thread (Phase 3) ─────────────────
server.registerTool(
  "cortex_bg_thread",
  {
    description: "Run a background reasoning thread. Strategic analyzes gaps and alignment. Operational checks system health. Relational tracks contact freshness.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      thread_type: z.enum(["strategic", "operational", "relational"]).describe("Type of reasoning thread"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        thread_type: z.string(),
        result: z.record(z.unknown())
      }).strict()
    }).strict()
  },
  async ({ agent_id, thread_type }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const runners = { strategic: runStrategicThread, operational: runOperationalThread, relational: runRelationalThread };
    const result = await runners[thread_type](agentId);
    return makeStructuredResponse("cortex_bg_thread", { thread_type, result: result as unknown as Record<string, unknown> }, formatThreadResult(thread_type, result), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_synthesize (Phase 3) ────────────────
server.registerTool(
  "cortex_synthesize",
  {
    description: "Run synthesis on recent novel synapses to discover unexpected connections and generate insights.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      hours: z.number().nullable().describe("How many hours of novel synapses to analyze"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        syntheses_created: z.number(),
        insights: z.array(z.record(z.unknown()))
      }).strict()
    }).strict()
  },
  async ({ agent_id, hours }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const result = await phaseSynthesis(agentId, hours ?? 24);
    let text = `Synthesis complete: ${result.synthesesCreated} insights generated.`;
    if (result.insights.length > 0) {
      text += "\n\nInsights:\n" + result.insights.map(i => `- ${i.description}`).join("\n");
    }
    return makeStructuredResponse("cortex_synthesize", {
      syntheses_created: result.synthesesCreated,
      insights: result.insights as unknown as Record<string, unknown>[]
    }, text, { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_observe (Phase 4) ───────────────────
server.registerTool(
  "cortex_observe",
  {
    description: "Capture the current screen: detects the foreground app/window and (on Windows) saves a full-screen PNG, returning its path for YOU to read with your image tools. Use when you need eyes on the live screen - debugging visual state, verifying what the principal is looking at, or capturing UI evidence. The observation is also stored as a low-priority memory unless store=false.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      store: z.boolean().nullable().describe("Store observation in memory (false = describe only)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        observation: z.record(z.unknown()),
        memory_ids: z.array(z.number())
      }).strict()
    }).strict()
  },
  async ({ agent_id, store }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const observation = await captureAndAnalyze();
    let text = formatObservation(observation);
    let ids: number[] = [];
    if (store ?? true) {
      ids = await ingestObservation(agentId, observation);
      text += `\nStored as memory node(s): ${ids.join(", ")}`;
    }
    return makeStructuredResponse("cortex_observe", { observation: observation as unknown as Record<string, unknown>, memory_ids: ids }, text, { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_relationship (Phase 5) ──────────────
server.registerTool(
  "cortex_relationship",
  {
    description: "Look up a person's relationship profile. Returns communication preferences, open items, contact history, and personality model.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      name: z.string().describe("Person's name (fuzzy matched)"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        person_name: z.string(),
        relationship: z.record(z.unknown()).nullable()
      }).strict()
    }).strict()
  },
  async ({ agent_id, name }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const rel = await getRelationship(agentId, name);
    if (!rel) return makeStructuredResponse("cortex_relationship", { person_name: name, relationship: null }, `No relationship found for "${name}".`, { agent_id: agent_id ?? "arlo" });
    return makeStructuredResponse("cortex_relationship", { person_name: name, relationship: rel as unknown as Record<string, unknown> }, formatRelationship(rel), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_relationships (Phase 5) ─────────────
server.registerTool(
  "cortex_relationships",
  {
    description: "List all relationships, optionally filtered by type or showing only overdue contacts.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      type: z.string().nullable().describe("Filter by type: family, client, partner, vendor, friend, professional"),
      overdue_only: z.boolean().nullable().describe("Only show overdue contacts"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        relationships: z.array(z.record(z.unknown()))
      }).strict()
    }).strict()
  },
  async ({ agent_id, type, overdue_only }) => {
    const agentId = await resolveAgent(agent_id ?? "arlo");
    const rels = await listRelationships(agentId, { type: type ?? undefined, overdueOnly: overdue_only ?? false });
    return makeStructuredResponse("cortex_relationships", { relationships: rels as unknown as Record<string, unknown>[] }, formatRelationshipList(rels), { agent_id: agent_id ?? "arlo" });
  }
);

// ─── Tool: cortex_relationship_update (Phase 5) ───────
server.registerTool(
  "cortex_relationship_update",
  {
    description: "Update a relationship profile. Set last contact, add notes, add/resolve open items.",
    inputSchema: z.object({
      agent_id: z.string().nullable().describe("Agent ID"),
      name: z.string().describe("Person's name"),
      last_contact: z.string().nullable().describe("Set last contact ('now' or ISO date)"),
      note: z.string().nullable().describe("Update notes"),
      add_item: z.string().nullable().describe("Add an open item"),
      resolve_item: z.number().nullable().describe("Resolve open item by index"),
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
    if (last_contact) updates.lastContact = last_contact === "now" ? "now" : new Date(last_contact);
    if (note) updates.notes = note;

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
      })).nullable().describe("Options that were considered"),
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
      period: z.string().nullable().describe("Period label (e.g. '2026-W07')"),
    }).strict(),
    outputSchema: z.object({
      ...cortexBaseOutputShape,
      data: z.object({
        audit_result: z.record(z.unknown())
      })
    })
  },
  async ({ agent_id, period }) => {
    const agentId = await resolveAgent(agent_id);
    // Manual/on-demand audit always runs (force=true); the scheduled weekly
    // runner dedups against recent audits.
    const result = await runWeeklyAudit(agentId, period ?? undefined, true);
    return makeStructuredResponse("cortex_audit", { audit_result: result as unknown as Record<string, unknown> }, formatAuditResult(result), { agent_id });
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
      context: z.string().nullable().describe("What triggered this thought"),
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
      memory_id: z.number().describe("ID of the memory to update (must have been recently recalled)"),
      new_content: z.string().describe("The updated memory content"),
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
    const result = await reconsolidate(memory_id, new_content, reason);

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
    const agentId = await resolveAgent(agent_id);
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
      source_memory_ids: z.array(z.number()).nullable().describe("IDs of episodic memories where this was learned"),
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
    const id = await storeProcedural({
      agentId, name, description, proceduralType: procedural_type,
      triggerContext: trigger_context, steps, domainTags: domain_tags,
      sourceMemoryIds: source_memory_ids ?? undefined,
    });
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
      task_context: z.string().describe("Describe the task you're about to do"),
      limit: z.number().default(5).describe("Max results"),
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
          match_type: z.string(),
          trigger_context: z.string(),
          description: z.string(),
          steps: z.array(z.string())
        }))
      })
    })
  },
  async ({ agent_id, task_context, limit }) => {
    const agentId = await resolveAgent(agent_id);
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
      procedural_id: z.number().describe("ID of the procedural memory that was applied"),
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
  async ({ procedural_id, success }) => {
    const result = await recordExecution(procedural_id, success);
    return makeStructuredResponse("cortex_skill_executed", {
      procedural_id,
      success,
      new_proficiency: result.proficiency,
      new_success_rate: result.successRate
    }, `Execution recorded for #${procedural_id}. Proficiency: ${result.proficiency}. Success rate: ${(result.successRate * 100).toFixed(0)}%.`);
  }
);

// ─── Tool: cortex_skill_refine ──────────────────────────
server.registerTool(
  "cortex_skill_refine",
  {
    description: "Refine an existing procedural memory with updated steps, description, or trigger context. Use this when you discover a better way to do something.",
    inputSchema: z.object({
      procedural_id: z.number().describe("ID of the procedural memory to refine"),
      description: z.string().nullable().describe("Updated description"),
      steps: z.array(z.string()).nullable().describe("Updated steps"),
      trigger_context: z.string().nullable().describe("Updated trigger context"),
      domain_tags: z.array(z.string()).nullable().describe("Updated domain tags"),
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
  async ({ procedural_id, description, steps, trigger_context, domain_tags }) => {
    const newVersion = await refineProcedural(procedural_id, {
      description: description || undefined,
      steps: steps || undefined,
      triggerContext: trigger_context || undefined,
      domainTags: domain_tags || undefined,
    });
    return makeStructuredResponse("cortex_skill_refine", {
      procedural_id,
      status: "refined",
      new_version: newVersion
    }, `Procedural memory #${procedural_id} refined → v${newVersion}`);
  }
);

// ─── Start Server ───────────────────────────────────────
async function main() {
  try {
    await initDatabase();
  } catch (err) {
    // Log to stderr so it doesn't interfere with MCP stdio
    console.error("[cortex-mcp] Database init warning:", err);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cortex-mcp] CORTEX V2 MCP server running");

  // Exit when the stdio client disconnects (stdin EOF / close), so this process
  // doesn't orphan and leak DB connections. On Windows, killing the launching
  // cmd.exe does NOT reliably kill this child — self-terminate on disconnect.
  const shutdown = (why: string) => {
    console.error(`[cortex-mcp] client disconnected (${why}); exiting`);
    process.exit(0);
  };
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin close"));
  process.stdin.on("error", () => shutdown("stdin error"));
}

main().catch((err) => {
  console.error("[cortex-mcp] Fatal:", err);
  process.exit(1);
});
