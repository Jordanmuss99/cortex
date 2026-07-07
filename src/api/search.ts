import { Router, Request, Response } from "express";
import { db, schema } from "../db/index.js";
import { embedQuery } from "../ingestion/embeddings.js";
import { patternComplete } from "../hippocampus/index.js";
import { markLabile } from "../reconsolidation/index.js";
import { eq, sql, and, ilike, or } from "drizzle-orm";

const CA3_WEIGHT = 0.25;
const CA3_ENABLED_DEFAULT = process.env.CORTEX_CA3 !== "off";

const router = Router();

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

/**
 * Hybrid search scoring:
 *   score = 0.45 * cosine_similarity
 *       + 0.18 * text_match
 *       + 0.12 * recency
 *       + 0.10 * resonance
 *       + 0.05 * priority_boost
 *       + 0.10 * emotional_boost
 */
export interface HybridSearchOptions {
  agentId: number;
  query: string;
  limit?: number;
  candidateLimit?: number;
  enableCA3?: boolean;
  queryEmbedding?: number[];
}

export async function hybridSearch(options: HybridSearchOptions): Promise<SearchResult[]> {
  const {
    agentId,
    query,
    limit = 10,
    candidateLimit = Math.max(limit * 4, 50),
    enableCA3 = CA3_ENABLED_DEFAULT,
    queryEmbedding: providedEmbedding,
  } = options;
  const queryEmbedding = providedEmbedding ?? (await embedQuery(query));
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const results = await db.execute(sql`
    WITH vector_scores AS (
      SELECT
        id,
        content,
        source,
        source_type,
        priority,
        resonance_score,
        entities,
        semantic_tags,
        created_at,
        valid_from,
        valid_until,
        superseded_by,
        1 - (embedding <=> ${embeddingStr}::vector) AS cosine_sim,
        CASE
          WHEN content ILIKE ${"%" + query + "%"} THEN 1.0
          ELSE 0.0
        END AS text_match,
        EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS recency,
        LEAST(resonance_score / 10.0, 1.0) AS norm_resonance,
        CASE priority
          WHEN 0 THEN 1.0
          WHEN 1 THEN 0.8
          WHEN 2 THEN 0.5
          WHEN 3 THEN 0.3
          WHEN 4 THEN 0.1
          ELSE 0.5
        END AS priority_boost
      FROM memory_nodes
      WHERE agent_id = ${agentId}
        AND status = 'active'
        AND embedding IS NOT NULL
        AND (valid_from IS NULL OR valid_from <= NOW())
        AND (valid_until IS NULL OR valid_until > NOW())
    )
    SELECT vs.*,
      COALESCE(ev.recall_boost, 0) AS emotional_boost,
      (0.45 * vs.cosine_sim
     + 0.18 * vs.text_match
     + 0.12 * vs.recency
     + 0.10 * vs.norm_resonance
     + 0.05 * vs.priority_boost
     + 0.10 * COALESCE(ev.recall_boost, 0)) AS hybrid_score
    FROM vector_scores vs
    LEFT JOIN emotional_valence ev ON ev.memory_id = vs.id
    ORDER BY hybrid_score DESC
    LIMIT ${candidateLimit}
  `);

  // CA3 Pattern Completion -- gated by enableCA3 so A/B comparisons are clean.
  let ca3Results: Map<number, number> = new Map();
  if (enableCA3) {
    try {
      const completions = await patternComplete(agentId, queryEmbedding, limit);
      for (const c of completions) {
        ca3Results.set(c.memoryId, c.activationScore);
      }
    } catch {
      // CA3 is additive -- if it fails (e.g., no hippocampal codes yet), hybrid still works
    }
  }

  // markLabile and access-count updates for all candidate IDs (hybrid + CA3).
  // Failure here is loud because silent markLabile failure caused the 2026-04
  // procedural-memory stall.
  const allResultIds = (results.rows as Array<{ id: number }>).map((r) => r.id);
  const allAccessIds = [...new Set([...allResultIds, ...ca3Results.keys()])];
  if (allAccessIds.length > 0) {
    try {
      const idsLiteral = `ARRAY[${allAccessIds.join(",")}]::int[]`;
      await db.execute(sql`
        UPDATE memory_nodes
        SET access_count = access_count + 1,
            last_accessed_at = NOW()
        WHERE id = ANY(${sql.raw(idsLiteral)})
      `);
    } catch (err) {
      console.error("[hybridSearch] access-count telemetry failed:", err);
    }
    await markLabile(allAccessIds);
  }

  // Inject CA3-only candidates so pattern completion can surface memories
  // the semantic prefilter missed.
  const hybridIds = new Set(allResultIds);
  const ca3OnlyIds = [...ca3Results.keys()].filter((id) => !hybridIds.has(id));
  if (ca3OnlyIds.length > 0 && enableCA3) {
    const idsLiteral = `ARRAY[${ca3OnlyIds.join(",")}]::int[]`;
    const ca3OnlyResults = await db.execute(sql`
      WITH vector_scores AS (
        SELECT
          id,
          content,
          source,
          source_type,
          priority,
          resonance_score,
          entities,
          semantic_tags,
          created_at,
          valid_from,
          valid_until,
          superseded_by,
          1 - (embedding <=> ${embeddingStr}::vector) AS cosine_sim,
          CASE
            WHEN content ILIKE ${"%" + query + "%"} THEN 1.0
            ELSE 0.0
          END AS text_match,
          EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS recency,
          LEAST(resonance_score / 10.0, 1.0) AS norm_resonance,
          CASE priority
            WHEN 0 THEN 1.0
            WHEN 1 THEN 0.8
            WHEN 2 THEN 0.5
            WHEN 3 THEN 0.3
            WHEN 4 THEN 0.1
            ELSE 0.5
          END AS priority_boost
        FROM memory_nodes
        WHERE agent_id = ${agentId}
          AND status = 'active'
          AND embedding IS NOT NULL
          AND id = ANY(${sql.raw(idsLiteral)})
          AND (valid_from IS NULL OR valid_from <= NOW())
          AND (valid_until IS NULL OR valid_until > NOW())
      )
      SELECT vs.*,
        COALESCE(ev.recall_boost, 0) AS emotional_boost,
        (0.45 * vs.cosine_sim
       + 0.18 * vs.text_match
       + 0.12 * vs.recency
       + 0.10 * vs.norm_resonance
       + 0.05 * vs.priority_boost
       + 0.10 * COALESCE(ev.recall_boost, 0)) AS hybrid_score
      FROM vector_scores vs
      LEFT JOIN emotional_valence ev ON ev.memory_id = vs.id
    `);
    (results.rows as Array<unknown>).push(...ca3OnlyResults.rows);
  }

  // Normalize CA3 activation to [0,1] and blend with hybrid score.
  let maxCa3 = 0;
  for (const score of ca3Results.values()) {
    if (score > maxCa3) maxCa3 = score;
  }

  const scored = (results.rows as Array<{
    id: number;
    content: string;
    source: string | null;
    source_type: string | null;
    priority: number | null;
    resonance_score: number | null;
    entities: string[] | null;
    semantic_tags: string[] | null;
    created_at: string;
    valid_from: string | null;
    valid_until: string | null;
    superseded_by: number | null;
    cosine_sim: number;
    text_match: number;
    recency: number;
    norm_resonance: number;
    priority_boost: number;
    emotional_boost: number;
    hybrid_score: number;
  }>).map((row) => {
    const ca3Score = ca3Results.get(row.id);
    const ca3Activation = ca3Score && maxCa3 > 0 ? ca3Score / maxCa3 : 0;
    const ca3Boost = enableCA3 ? ca3Activation * CA3_WEIGHT : 0;
    const blendedScore = row.hybrid_score + ca3Boost;

    return {
      id: row.id,
      content: row.content,
      source: row.source,
      sourceType: row.source_type,
      priority: row.priority,
      resonanceScore: row.resonance_score,
      entities: row.entities,
      semanticTags: row.semantic_tags,
      createdAt: row.created_at,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      supersededBy: row.superseded_by,
      score: blendedScore,
      hybridScore: row.hybrid_score,
      scoreBreakdown: {
        cosine: row.cosine_sim,
        textMatch: row.text_match,
        recency: row.recency,
        resonance: row.norm_resonance,
        priorityBoost: row.priority_boost,
        emotionalBoost: row.emotional_boost,
        ca3Activation,
      },
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * POST /api/v1/search
 * Body: { query, agentId, limit? }
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { query, agentId, limit = 10 } = req.body;

    if (!query || !agentId) {
      res.status(400).json({ error: "query and agentId required" });
      return;
    }

    // Resolve agent
    const [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.externalId, agentId));

    if (!agent) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const results = await hybridSearch({ agentId: agent.id, query, limit });

    res.json({
      query,
      agentId,
      resultCount: results.length,
      results,
    });
  } catch (err) {
    console.error("[search] Error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

export { router as searchRouter };
