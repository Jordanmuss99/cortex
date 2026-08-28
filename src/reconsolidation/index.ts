/**
 * Memory Reconsolidation
 *
 * When a memory is retrieved, it enters a labile (malleable) state where
 * it can be updated with new information. This is how beliefs get corrected,
 * knowledge evolves, and outdated information gets replaced.
 *
 * Biological basis:
 *   - Nader et al. (2000): Retrieved memories require protein synthesis
 *     to restabilize. During this window, they can be modified.
 *   - Lee (2009): Reconsolidation is triggered by prediction error at
 *     recall. The memory must be activated AND new information present.
 *
 * Implementation:
 *   1. On recall, mark memories as "labile" with a timestamp
 *   2. During the labile window (~1 hour), the memory can be updated
 *   3. Update re-embeds, re-encodes through DG, and adjusts synapses
 *   4. The original content is preserved as a cognitive artifact (audit trail)
 *   5. After the window closes, the memory restabilizes
 *
 * This replaces the old model where memories were write-once/read-only.
 */

import { db, schema } from "../db/index.js";
import { scrubEmDashes } from "../lib/scrub.js";
import { eq, sql, and, gt } from "drizzle-orm";
import { embedTexts } from "../ingestion/embeddings.js";
import { extractEntitiesSync as extractEntities, extractSemanticTags } from "../ingestion/entities.js";
import { hippocampalEncode } from "../hippocampus/index.js";

/** How long a recalled memory remains labile (modifiable) */
const LABILE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface ReconsolidationResult {
  memoryId: number;
  status: "reconsolidated" | "window_closed" | "not_found" | "not_labile";
  previousContent?: string;
  newContent?: string;
  artifactId?: number;
  resonanceBoost: number;
}

/**
 * Mark memories as labile after recall.
 * Called automatically when memories are retrieved via search/recall.
 *
 * Uses the existing `last_recalled_at` column (added in Build 3 migration).
 *
 * NOTE (2026-04-10): Standardized on sql.raw with an explicit PostgreSQL
 * ARRAY literal (matches cortex-v2 pattern). Previously used a text-array
 * literal workaround `{1,2,3}::int[]` that relied on drizzle's string-parameter
 * binding, which worked in practice but was brittle. The sql.raw ARRAY[]
 * constructor is the canonical fix for drizzle-orm's composite-ROW serialization
 * of JS number arrays that Postgres refuses to cast to int[] ("cannot cast
 * type record to integer[]"). memoryIds are typed as number[] from upstream
 * SELECT results, so there is no injection risk from the string join.
 */
export async function markLabile(memoryIds: number[]): Promise<void> {
  if (memoryIds.length === 0) return;

  const idsLiteral = `ARRAY[${memoryIds.join(",")}]::int[]`;
  await db.execute(sql`
    UPDATE memory_nodes
    SET last_recalled_at = NOW()
    WHERE id = ANY(${sql.raw(idsLiteral)})
  `);
}

/**
 * Check if a memory is currently in its labile window.
 */
export async function isLabile(memoryId: number): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT last_recalled_at
    FROM memory_nodes
    WHERE id = ${memoryId}
      AND status = 'active'
      AND last_recalled_at IS NOT NULL
      AND last_recalled_at > NOW() - INTERVAL '1 hour'
    LIMIT 1
  `);

  return result.rows.length > 0;
}

/**
 * Reconsolidate a memory: update its content while preserving the original.
 *
 * The memory must have been recalled within the labile window.
 * The original content is stored as a cognitive artifact for audit.
 *
 * @param memoryId - ID of the memory to reconsolidate
 * @param newContent - Updated content (can be a correction, expansion, or refinement)
 * @param reason - Why the memory is being updated (for audit trail)
 * @returns ReconsolidationResult
 */
export async function reconsolidate(
  agentId: number,
  memoryId: number,
  newContent: string,
  reason: string = "belief_update"
): Promise<ReconsolidationResult> {
  // Step 1: Verify memory exists and is labile
  const memResult = await db.execute(sql`
    SELECT id, agent_id, content, source, priority, resonance_score, last_recalled_at,
           EXTRACT(EPOCH FROM (NOW() - last_recalled_at)) * 1000 AS ms_since_recall
    FROM memory_nodes
    WHERE id = ${memoryId}
      AND agent_id = ${agentId}
      AND status = 'active'
    LIMIT 1
  `);

  const rows = memResult.rows as Array<{
    id: number;
    agent_id: number;
    content: string;
    source: string | null;
    priority: number;
    resonance_score: number;
    last_recalled_at: Date | null;
    ms_since_recall: string | number | null;
  }>;

  if (rows.length === 0) {
    return { memoryId, status: "not_found", resonanceBoost: 0 };
  }

  const memory = rows[0];

  // Check labile window
  if (!memory.last_recalled_at || memory.ms_since_recall === null) {
    return { memoryId, status: "not_labile", resonanceBoost: 0 };
  }

  const msSinceRecall = Number(memory.ms_since_recall);
  if (msSinceRecall > LABILE_WINDOW_MS || msSinceRecall < -60000) {
    // If it's negative (due to minor clock skew), allow it. If > 1hr, window closed.
    return { memoryId, status: "window_closed", resonanceBoost: 0 };
  }

  // Complete provider work before opening the mutation transaction. A provider
  // outage must leave the active memory and its audit history untouched.
  const [newEmbedding] = await embedTexts([newContent]);

  // Run through hippocampal encoding (DG + CA1).
  const { sparseCode, noveltyResult } = await hippocampalEncode(
    memory.agent_id,
    newEmbedding,
    memory.priority
  );

  // Reconsolidated memories get a resonance boost (they've been validated/corrected)
  const resonanceBoost = 1.5;
  const newResonance = Math.min(
    (memory.resonance_score || 5) + resonanceBoost,
    10
  );

  const newEntities = extractEntities(newContent);
  const newTags = extractSemanticTags(newContent);
  const entitiesLiteral = `{${newEntities.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",")}}`;
  const tagsLiteral = `{${newTags.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(",")}}`;

  let artifactId = 0;
  await db.transaction(async (tx) => {
    const [artifact] = await tx
      .insert(schema.cognitiveArtifacts)
      .values({
        agentId,
        artifactType: "correction",
        content: scrubEmDashes({
          memoryId: memory.id,
          originalContent: memory.content,
          newContent,
          reason,
          reconsolidatedAt: new Date().toISOString(),
        }),
        resonanceScore: 3.0,
      })
      .returning({ id: schema.cognitiveArtifacts.id });
    artifactId = artifact.id;

    await tx.execute(sql`
      UPDATE memory_nodes
      SET content = ${newContent},
          embedding = ${`[${newEmbedding.join(",")}]`}::vector,
          resonance_score = ${newResonance},
          novelty_score = ${noveltyResult.noveltyScore},
          entities = ${entitiesLiteral}::text[],
          semantic_tags = ${tagsLiteral}::text[],
          valid_from = NOW(),
          valid_until = NULL,
          updated_at = NOW(),
          last_recalled_at = NULL
      WHERE id = ${memoryId} AND agent_id = ${agentId}
    `);

    await tx.execute(sql`
      DELETE FROM hippocampal_codes
      WHERE memory_id = ${memoryId} AND agent_id = ${agentId}
    `);

    await tx.insert(schema.hippocampalCodes).values({
      memoryId,
      agentId,
      sparseIndices: sparseCode.indices,
      sparseValues: sparseCode.values,
      sparseDim: sparseCode.dim,
      noveltyScore: noveltyResult.noveltyScore,
    });
  });

  // Step 7: Clear labile state (memory has restabilized with new content)
  // Already done above by setting last_recalled_at = NULL

  console.error(
    `[reconsolidation] Memory #${memoryId} reconsolidated. Reason: ${reason}. Resonance: ${memory.resonance_score?.toFixed(1)} → ${newResonance.toFixed(1)}`
  );

  return {
    memoryId,
    status: "reconsolidated",
    previousContent: memory.content,
    newContent,
    artifactId,
    resonanceBoost,
  };
}

/**
 * Get all currently labile memories for an agent.
 * Useful for agents to know what they can update.
 */
export async function getLabileMemories(
  agentId: number
): Promise<Array<{ id: number; content: string; recalledAt: Date }>> {
  const result = await db.execute(sql`
    SELECT id, content, last_recalled_at
    FROM memory_nodes
    WHERE agent_id = ${agentId}
      AND status = 'active'
      AND last_recalled_at IS NOT NULL
      AND last_recalled_at > NOW() - INTERVAL '1 hour'
    ORDER BY last_recalled_at DESC
  `);

  return (
    result.rows as Array<{
      id: number;
      content: string;
      last_recalled_at: Date;
    }>
  ).map((r) => ({
    id: r.id,
    content: r.content,
    recalledAt: r.last_recalled_at,
  }));
}
