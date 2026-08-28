/**
 * Procedural Memory Layer
 *
 * Stores and retrieves skill/habit/workflow knowledge separately from
 * episodic memory. Procedural memories:
 *   - Don't decay with time (skills persist)
 *   - Strengthen with repeated execution
 *   - Are retrieved by task context, not just semantic similarity
 *   - Can be refined/versioned as the agent improves
 */

import { db, schema } from "../db/index.js";
import { eq, sql, and, ilike, or, inArray } from "drizzle-orm";
import { embedTexts, embedQuery } from "../ingestion/embeddings.js";
import type {
  ProceduralType,
  ProficiencyLevel,
  ProceduralMemory,
  ProceduralMatch,
} from "./types.js";

export type { ProceduralType, ProficiencyLevel, ProceduralMemory, ProceduralMatch };

const MAX_POSTGRES_INTEGER = 2_147_483_647;

export class ProceduralMemoryNotFoundError extends Error {
  readonly code = "procedural_memory_not_found";

  constructor(readonly proceduralId: number) {
    super(`Procedural memory #${proceduralId} not found`);
    this.name = "ProceduralMemoryNotFoundError";
  }
}

export class InvalidSourceMemoryReferencesError extends Error {
  readonly code = "invalid_source_memory_references";

  constructor(readonly requestedCount: number) {
    super("One or more source memory references are invalid");
    this.name = "InvalidSourceMemoryReferencesError";
  }
}

// ─── Store ──────────────────────────────────────────────

export interface CreateProceduralInput {
  agentId: number;
  name: string;
  description: string;
  proceduralType: ProceduralType;
  triggerContext: string;
  steps: string[];
  domainTags: string[];
  sourceMemoryIds?: readonly number[];
}

export function normalizeSourceMemoryIds(
  ids: readonly number[] | undefined
): number[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) throw new InvalidSourceMemoryReferencesError(0);

  const unique = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_POSTGRES_INTEGER) {
      throw new InvalidSourceMemoryReferencesError(ids.length);
    }
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  if (unique.length > 100) {
    throw new InvalidSourceMemoryReferencesError(unique.length);
  }
  return unique;
}

export async function assertSourceMemoriesOwnedByAgent(
  agentId: number,
  ids: readonly number[]
): Promise<void> {
  if (ids.length === 0) return;
  const owned = await db
    .select({ id: schema.memoryNodes.id })
    .from(schema.memoryNodes)
    .where(and(
      eq(schema.memoryNodes.agentId, agentId),
      inArray(schema.memoryNodes.id, [...ids])
    ));
  if (owned.length !== ids.length) {
    throw new InvalidSourceMemoryReferencesError(ids.length);
  }
}

/**
 * Store a new procedural memory (skill, workflow, pattern, preference, heuristic).
 */
export async function storeProcedural(
  input: CreateProceduralInput
): Promise<number> {
  const sourceMemoryIds = normalizeSourceMemoryIds(input.sourceMemoryIds);
  await assertSourceMemoriesOwnedByAgent(input.agentId, sourceMemoryIds);

  // Embed the combined text for semantic retrieval
  const textForEmbedding = `${input.name}. ${input.triggerContext}. ${input.description}. ${input.steps.join(". ")}`;
  const [embedding] = await embedTexts([textForEmbedding]);

  const insertedId = await db.transaction(async (transaction) => {
    if (sourceMemoryIds.length > 0) {
      const owned = await transaction
        .select({ id: schema.memoryNodes.id })
        .from(schema.memoryNodes)
        .where(and(
          eq(schema.memoryNodes.agentId, input.agentId),
          inArray(schema.memoryNodes.id, sourceMemoryIds)
        ))
        .for("share");
      if (owned.length !== sourceMemoryIds.length) {
        throw new InvalidSourceMemoryReferencesError(sourceMemoryIds.length);
      }
    }

    const [inserted] = await transaction
      .insert(schema.proceduralMemories)
      .values({
        agentId: input.agentId,
        name: input.name,
        description: input.description,
        proceduralType: input.proceduralType,
        triggerContext: input.triggerContext,
        steps: input.steps,
        domainTags: input.domainTags,
        sourceMemoryIds,
        embedding,
        proficiency: "novice",
        executionCount: 0,
        successCount: 0,
        successRate: 0,
        version: 1,
      })
      .returning({ id: schema.proceduralMemories.id });
    return inserted.id;
  });

  console.error(
    `[procedural] Stored: "${input.name}" (${input.proceduralType}) → #${insertedId}`
  );

  return insertedId;
}

// ─── Retrieve ───────────────────────────────────────────

/**
 * Retrieve relevant procedural memories for a task context.
 * Uses three retrieval strategies:
 *   1. Trigger match: does the task context match a known trigger?
 *   2. Domain match: do the domain tags overlap?
 *   3. Semantic match: cosine similarity on the embedded description
 */
export async function retrieveProcedural(
  agentId: number,
  taskContext: string,
  limit: number = 5
): Promise<ProceduralMatch[]> {
  const queryEmbedding = await embedQuery(taskContext);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const results = await db.execute(sql`
    SELECT
      id, name, description, procedural_type, trigger_context,
      steps, proficiency, execution_count, success_count, success_rate,
      domain_tags, source_memory_ids, version,
      1 - (embedding <=> ${embeddingStr}::vector) AS cosine_sim,
      CASE WHEN trigger_context ILIKE ${"%" + taskContext.slice(0, 80) + "%"} THEN 1.0 ELSE 0.0 END AS trigger_match
    FROM procedural_memories
    WHERE agent_id = ${agentId}
      AND status = 'active'
      AND embedding IS NOT NULL
    ORDER BY
      trigger_match DESC,
      cosine_sim DESC
    LIMIT ${Math.min(Math.max(limit * 3, limit), 60)}
  `);

  return (
    results.rows as Array<{
      id: number;
      name: string;
      description: string;
      procedural_type: ProceduralType;
      trigger_context: string;
      steps: string[];
      proficiency: ProficiencyLevel;
      execution_count: number;
      success_count: number;
      success_rate: number;
      domain_tags: string[];
      source_memory_ids: number[];
      version: number;
      cosine_sim: number;
      trigger_match: number;
    }>
  ).map((row) => {
    const matchType =
      row.trigger_match > 0
        ? "trigger"
        : "semantic";

    return {
      memory: {
        id: row.id,
        agentId,
        name: row.name,
        description: row.description,
        proceduralType: row.procedural_type,
        triggerContext: row.trigger_context,
        steps: row.steps || [],
        proficiency: row.proficiency,
        executionCount: row.execution_count,
        successCount: row.success_count,
        successRate: row.success_rate,
        domainTags: row.domain_tags || [],
        sourceMemoryIds: row.source_memory_ids || [],
        version: row.version,
      },
      relevanceScore:
        row.trigger_match > 0
          ? 1.0
          : Number(row.cosine_sim),
      matchType: matchType as "trigger" | "semantic",
    };
  }).filter((match) => match.matchType === "trigger" || match.relevanceScore >= 0.35)
    .slice(0, limit);
}

// ─── Execute (Record Outcome) ───────────────────────────

/**
 * Record that a procedural memory was executed and its outcome.
 * This is how skills improve: repeated execution with feedback.
 */
export async function recordExecution(
  agentId: number,
  proceduralId: number,
  success: boolean
): Promise<{ proficiency: ProficiencyLevel; successRate: number }> {
  // Increment and fetch in one statement so nonexistent/cross-agent IDs can
  // never be reported as a successful execution.
  const updated = await db.execute(sql`
    UPDATE procedural_memories
    SET execution_count = execution_count + 1,
        success_count = success_count + ${success ? 1 : 0},
        success_rate = (success_count + ${success ? 1 : 0})::real / (execution_count + 1)::real,
        last_executed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${proceduralId} AND agent_id = ${agentId}
    RETURNING execution_count, success_count, success_rate, proficiency
  `);

  const [current] = updated.rows as Array<{
    execution_count: number;
    success_count: number;
    success_rate: number;
    proficiency: ProficiencyLevel;
  }>;

  if (!current) {
    throw new ProceduralMemoryNotFoundError(proceduralId);
  }

  // Proficiency advancement rules
  let newProficiency = current.proficiency;
  if (
    current.execution_count >= 20 &&
    current.success_rate >= 0.9
  ) {
    newProficiency = "expert";
  } else if (
    current.execution_count >= 10 &&
    current.success_rate >= 0.8
  ) {
    newProficiency = "proficient";
  } else if (
    current.execution_count >= 3 &&
    current.success_rate >= 0.6
  ) {
    newProficiency = "competent";
  }

  if (newProficiency !== current.proficiency) {
    await db.execute(sql`
      UPDATE procedural_memories
      SET proficiency = ${newProficiency}
      WHERE id = ${proceduralId} AND agent_id = ${agentId}
    `);
    console.error(
      `[procedural] #${proceduralId} proficiency: ${current.proficiency} → ${newProficiency}`
    );
  }

  return { proficiency: newProficiency, successRate: current.success_rate };
}

// ─── Refine ─────────────────────────────────────────────

/**
 * Refine a procedural memory with updated steps or description.
 * Increments version and re-embeds.
 */
export async function refineProcedural(
  agentId: number,
  proceduralId: number,
  updates: {
    description?: string;
    steps?: string[];
    triggerContext?: string;
    domainTags?: string[];
  }
): Promise<number> {
  // Get current state
  const [current] = (
    await db.execute(sql`
      SELECT name, description, trigger_context, steps, domain_tags, version
      FROM procedural_memories WHERE id = ${proceduralId} AND agent_id = ${agentId}
    `)
  ).rows as Array<{
    name: string;
    description: string;
    trigger_context: string;
    steps: string[];
    domain_tags: string[];
    version: number;
  }>;

  if (!current) throw new ProceduralMemoryNotFoundError(proceduralId);

  const newDesc = updates.description || current.description;
  const newSteps = updates.steps || current.steps;
  const newTrigger = updates.triggerContext || current.trigger_context;
  const newTags = updates.domainTags || current.domain_tags;
  const newVersion = current.version + 1;

  // Re-embed with updated content
  const textForEmbedding = `${current.name}. ${newTrigger}. ${newDesc}. ${newSteps.join(". ")}`;
  const [embedding] = await embedTexts([textForEmbedding]);

  // Drizzle serializes JS arrays in raw sql`` as composite ROW(...) which
  // Postgres refuses to cast to text[] ("syntax error at or near )"). Build
  // explicit array literals instead (same pattern as reconsolidation's
  // entities/tags). Found 2026-06-12 on the first-ever real skill_refine call.
  const toTextArrayLiteral = (arr: string[]) =>
    `{${arr.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  const stepsLiteral = toTextArrayLiteral(newSteps);
  const tagsLiteral = toTextArrayLiteral(newTags);

  await db.execute(sql`
    UPDATE procedural_memories
    SET description = ${newDesc},
        steps = ${stepsLiteral}::text[],
        trigger_context = ${newTrigger},
        domain_tags = ${tagsLiteral}::text[],
        embedding = ${`[${embedding.join(",")}]`}::vector,
        version = ${newVersion},
        updated_at = NOW()
    WHERE id = ${proceduralId} AND agent_id = ${agentId}
  `);

  console.error(`[procedural] #${proceduralId} refined → v${newVersion}`);
  return newVersion;
}
