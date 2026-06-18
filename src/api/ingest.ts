import { Router, Request, Response } from "express";
import { db, schema } from "../db/index.js";
import { chunkText } from "../ingestion/chunker.js";
import { embedTexts } from "../ingestion/embeddings.js";
import { extractEntities, extractSemanticTags } from "../ingestion/entities.js";
import { formSynapses } from "../ingestion/synapse-formation.js";
import { hippocampalEncode } from "../hippocampus/index.js";
import { analyzeValence } from "../valence/index.js";
import { eq, sql } from "drizzle-orm";

const router = Router();

/**
 * POST /api/v1/ingest
 * Body: { agentId, content, source?, sourceType?, priority?, entities?, semanticTags? }
 *
 * Ingests new content: chunks → embeds → stores → forms synapses.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      agentId,
      content,
      source,
      sourceType = "api",
      priority: reqPriority = 2,
      entities: providedEntities,
      semanticTags: providedTags,
    } = req.body;

    let priority = reqPriority;

    if (!agentId || !content) {
      res.status(400).json({ error: "agentId and content required" });
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

    // Chunk content
    const chunks = chunkText(content);

    // ── Priority floor for ephemeral content ──
    // Observations and other ephemeral context should age out quickly.
    // Force them to P3 minimum so the 7-day observation prune catches them
    // and the dream cycle's resonance decay keeps them low.
    if (sourceType === "observation" && priority < 3) {
      priority = 3;
    }

    // Embed all chunks
    const embeddings = await embedTexts(chunks.map((c) => c.text));

    // ── Near-duplicate SKIP gate (machine path: skip, don't refuse) ──
    // Checks ALL chunk embeddings against existing memories. If ANY chunk
    // is a near-duplicate (cosine >= DUP_THRESHOLD), skip the entire ingest.
    // This prevents the gateway capture path from creating near-duplicates
    // when different captures of the same conversation overlap partially.
    const DUP_THRESHOLD = Number(process.env.CORTEX_DUP_THRESHOLD || "0.88");
    if (!req.body.force) {
      let foundDup: { id: number; similarity: number } | null = null;
      // Check each chunk's embedding (limit to first 5 chunks for performance)
      const chunksToCheck = Math.min(embeddings.length, 5);
      for (let ci = 0; ci < chunksToCheck && !foundDup; ci++) {
        const embLiteral = `[${embeddings[ci].join(",")}]`;
        const dup = await db.execute(sql`
          SELECT id, 1 - (embedding <=> ${embLiteral}::vector) AS similarity
          FROM memory_nodes
          WHERE agent_id = ${agent.id} AND status = 'active' AND embedding IS NOT NULL
          ORDER BY embedding <=> ${embLiteral}::vector
          LIMIT 1
        `);
        const top = dup.rows[0] as { id: number; similarity: number } | undefined;
        if (top && Number(top.similarity) >= DUP_THRESHOLD) {
          foundDup = { id: Number(top.id), similarity: Number(top.similarity) };
        }
      }
      if (foundDup) {
        console.error(
          `[ingest] skipped near-duplicate of #${foundDup.id} (sim ${foundDup.similarity.toFixed(3)}) from ${sourceType}:${source || "?"}`
        );
        res.json({
          agentId,
          chunksStored: 0,
          nodeIds: [],
          synapsesFormed: 0,
          skipped: true,
          duplicateOf: foundDup.id,
          similarity: foundDup.similarity,
        });
        return;
      }
    }

    // Store chunks with surprise-gated resonance
    const insertedIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const autoEntities = await extractEntities(chunks[i].text);
      const autoTags = extractSemanticTags(chunks[i].text);

      // Hippocampal encoding: DG pattern separation + CA1 novelty detection
      const { sparseCode, noveltyResult } =
        await hippocampalEncode(agent.id, embeddings[i], priority);

      const [inserted] = await db
        .insert(schema.memoryNodes)
        .values({
          agentId: agent.id,
          content: chunks[i].text,
          source: source || null,
          sourceType,
          chunkIndex: chunks[i].index,
          embedding: embeddings[i],
          entities: providedEntities
            ? [...new Set([...providedEntities, ...autoEntities])]
            : autoEntities,
          semanticTags: providedTags
            ? [...new Set([...providedTags, ...autoTags])]
            : autoTags,
          priority: noveltyResult.adjustedPriority,
          resonanceScore: noveltyResult.resonanceScore,
          status: "active",
        })
        .returning({ id: schema.memoryNodes.id });

      // Store novelty score on memory node
      await db.execute(
        sql`UPDATE memory_nodes SET novelty_score = ${noveltyResult.noveltyScore} WHERE id = ${inserted.id}`
      );

      // Store hippocampal code (DG sparse representation)
      await db.insert(schema.hippocampalCodes).values({
        memoryId: inserted.id,
        agentId: agent.id,
        sparseIndices: sparseCode.indices,
        sparseValues: sparseCode.values,
        sparseDim: sparseCode.dim,
        noveltyScore: noveltyResult.noveltyScore,
      });

      // Emotional valence analysis
      const { vector: ev, salience } = analyzeValence(chunks[i].text);
      await db.insert(schema.emotionalValence).values({
        memoryId: inserted.id,
        agentId: agent.id,
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

    // Form synapses
    const synapsesFormed = await formSynapses(agent.id, insertedIds);

    res.json({
      agentId,
      chunksStored: insertedIds.length,
      nodeIds: insertedIds,
      synapsesFormed,
    });
  } catch (err) {
    console.error("[ingest] Error:", err);
    res.status(500).json({ error: "Ingestion failed" });
  }
});

export { router as ingestRouter };
