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
      priority = 2,
      entities: providedEntities,
      semanticTags: providedTags,
    } = req.body;

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

    // Embed all chunks
    const embeddings = await embedTexts(chunks.map((c) => c.text));

    // ── Near-duplicate SKIP gate (machine path: skip, don't refuse) ──
    // The nightly reflect pipeline re-mines resumed transcripts and re-POSTs
    // the same insights (8 verbatim dup pairs landed 06-10/06-11 this way),
    // and the bridge can re-mirror a breadcrumb across sessions. Automation
    // cannot act on refusal guidance, so unlike the MCP gate this silently
    // returns the existing memory id as the canonical target. Body force:true
    // bypasses; multi-chunk (file/bulk) ingests are exempt.
    //
    // NOTE (2026-06-18): The original gate only ran for chunks.length === 1,
    // which meant any content > 256 tokens (the chunk size) bypassed the gate
    // entirely. This caused 12+ near-duplicate pairs from the Hermes gateway
    // capture path (which sends full exchanges that are often multi-chunk).
    // Fix: check the FIRST chunk's embedding against existing memories even
    // for multi-chunk content. The first chunk is the most representative
    // because it contains the beginning of the user turn.
    const DUP_THRESHOLD = Number(process.env.CORTEX_DUP_THRESHOLD || "0.88");
    if (!req.body.force) {
      // Check the first chunk's embedding for near-duplicates.
      // For single-chunk content, this is the whole content.
      // For multi-chunk content, the first chunk is a representative sample.
      const embLiteral = `[${embeddings[0].join(",")}]`;
      const dup = await db.execute(sql`
        SELECT id, 1 - (embedding <=> ${embLiteral}::vector) AS similarity
        FROM memory_nodes
        WHERE agent_id = ${agent.id} AND status = 'active' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${embLiteral}::vector
        LIMIT 1
      `);
      const top = dup.rows[0] as { id: number; similarity: number } | undefined;
      if (top && Number(top.similarity) >= DUP_THRESHOLD) {
        console.error(
          `[ingest] skipped near-duplicate of #${top.id} (sim ${Number(top.similarity).toFixed(3)}) from ${sourceType}:${source || "?"}`
        );
        res.json({
          agentId,
          chunksStored: 0,
          nodeIds: [],
          synapsesFormed: 0,
          skipped: true,
          duplicateOf: Number(top.id),
          similarity: Number(top.similarity),
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
