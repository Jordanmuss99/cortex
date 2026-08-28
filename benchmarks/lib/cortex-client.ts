/**
 * CORTEX Benchmark Client
 *
 * Interfaces with CORTEX's search, recall, and ingest APIs for benchmark evaluation.
 * Uses the database directly (not REST/MCP) for maximum throughput during bulk operations.
 */
import { db, schema, initDatabase } from "../../src/db/index.js";
import { sql, eq } from "drizzle-orm";
import { embedTexts } from "../../src/ingestion/embeddings.js";
import { hybridSearch } from "../../src/api/search.js";
import { chunkText } from "../../src/ingestion/chunker.js";
import { extractEntitiesSync, extractSemanticTags } from "../../src/ingestion/entities.js";
import { hippocampalEncode } from "../../src/hippocampus/index.js";
import { formSynapses } from "../../src/ingestion/synapse-formation.js";
import "dotenv/config";

export interface IngestResult {
  memoryIds: number[];
  chunks: number;
  duration: number;
}

export interface SearchResult {
  id: number;
  content: string;
  source: string | null;
  score: number;
  sessionId?: string;
}

/**
 * Initialize the benchmark environment.
 * Creates a dedicated benchmark agent to isolate from production data.
 */
export async function initBenchmark(benchmarkName: string): Promise<number> {
  await initDatabase();

  const agentExternalId = `benchmark-${benchmarkName}`;

  // Check if agent exists
  let [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.externalId, agentExternalId))
    .limit(1);

  if (!agent) {
    [agent] = await db
      .insert(schema.agents)
      .values({
        externalId: agentExternalId,
        name: `Benchmark: ${benchmarkName}`,
        ownerId: "benchmark",
      })
      .returning();
  }

  console.log(`[benchmark] Agent "${agentExternalId}" ready (id: ${agent.id})`);
  return agent.id;
}

/**
 * Clear all memories for a benchmark agent (clean slate between runs).
 */
export async function clearBenchmarkData(agentId: number): Promise<void> {
  // Single cascading delete — memory_nodes ON DELETE CASCADE handles synapses, hippocampal codes, valence
  await db.execute(sql`DELETE FROM memory_nodes WHERE agent_id = ${agentId}`);
}

/**
 * Ingest a conversation session into CORTEX.
 * Fast mode (default for benchmarks): skip hippocampal encoding + synapse formation.
 * Full mode: complete cognitive pipeline (slower, production-grade).
 */
export async function ingestSession(
  agentId: number,
  sessionId: string,
  content: string,
  source: string = "benchmark",
  fastMode: boolean = true
): Promise<IngestResult> {
  const start = Date.now();
  const chunks = chunkText(content);

  if (chunks.length === 0) {
    return { memoryIds: [], chunks: 0, duration: Date.now() - start };
  }

  const embeddings = await embedTexts(chunks.map((c) => c.text));

  // Batch insert all chunks at once (much faster than one-by-one)
  const values = chunks.map((chunk, i) => ({
    agentId,
    content: chunk.text,
    source: `${source}/${sessionId}`,
    sourceType: "benchmark" as const,
    chunkIndex: i,
    embedding: embeddings[i],
    entities: extractEntitiesSync(chunk.text),
    semanticTags: extractSemanticTags(chunk.text),
    priority: 2,
    resonanceScore: 5.0,
    noveltyScore: 0.5,
    status: "active" as const,
  }));

  const inserted = await db
    .insert(schema.memoryNodes)
    .values(values)
    .returning({ id: schema.memoryNodes.id });

  const insertedIds = inserted.map((r) => r.id);

  // Full mode: hippocampal encoding + synapse formation (slow but production-grade)
  if (!fastMode) {
    for (let i = 0; i < insertedIds.length; i++) {
      try {
        const { sparseCode, noveltyResult } = await hippocampalEncode(agentId, embeddings[i], 2);
        // Persist the DG sparse code so CA3 pattern completion has substrate to seed
        // from. Previously the encode result was discarded -> hippocampal_codes stayed
        // empty -> patternComplete returned nothing -> CA3 was a no-op in benchmarks
        // (the cause of the identical CA3-on/off A/B). Mirrors src/api/ingest.ts.
        await db.insert(schema.hippocampalCodes).values({
          memoryId: insertedIds[i],
          agentId,
          sparseIndices: sparseCode.indices,
          sparseValues: sparseCode.values,
          sparseDim: sparseCode.dim,
          noveltyScore: noveltyResult.noveltyScore,
        });
      } catch {
        // Skip encoding errors
      }
    }
    if (insertedIds.length > 1) {
      try {
        await formSynapses(agentId, insertedIds);
      } catch {
        // Non-critical
      }
    }
  }

  return {
    memoryIds: insertedIds,
    chunks: chunks.length,
    duration: Date.now() - start,
  };
}

/**
 * Search CORTEX and return ranked results.
 * Uses the same hybrid 7-factor scoring as production.
 */
export async function search(
  agentId: number,
  query: string,
  topK: number = 5
): Promise<SearchResult[]> {
  const results = await hybridSearch({ agentId, query, limit: topK });
  return results.map((r) => ({
    id: r.id,
    content: r.content,
    source: r.source,
    score: r.score,
    sessionId: r.source?.split("/").pop(),
  }));
}

/**
 * Extract the session ID from a source path.
 */
export function extractSessionId(source: string | null): string | null {
  if (!source) return null;
  return source.split("/").pop() || null;
}
