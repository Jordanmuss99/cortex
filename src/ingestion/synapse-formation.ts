import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";

/**
 * Automatic synapse formation after ingestion.
 *
 * Three connection types:
 * 1. Semantic: cosine similarity > 0.85 between node embeddings
 * 2. Entity: shared entity mentions between nodes
 * 3. Temporal: same source file (co-located content)
 *
 * Batched: one discovery query per connection type for the whole ingest
 * batch, then chunked multi-row upserts. Previously this ran one pgvector
 * query per node (semantic), one query per node PER ENTITY (entity), and one
 * query per node (temporal), plus one INSERT per pair -- the same N+1 shape
 * CA3's computeBatchOverlap eliminated at recall time.
 */

const SEMANTIC_THRESHOLD = 0.85;
const SEMANTIC_LIMIT_PER_NODE = 10;
const ENTITY_LIMIT_PER_NODE = 40;
const TEMPORAL_LIMIT_PER_NODE = 5;
const INSERT_CHUNK = 400;

interface DiscoveredPair {
  new_id: number;
  match_id: number;
  similarity?: number;
}

interface SynapseRow {
  memoryA: number;
  memoryB: number;
  connectionType: string;
  connectionStrength: number;
  decayRate: number;
}

/** Normalize (a < b) and dedupe pairs, keeping the strongest strength seen. */
function dedupePairs(
  pairs: DiscoveredPair[],
  connectionType: string,
  strengthOf: (p: DiscoveredPair) => number,
  decayRate: number
): SynapseRow[] {
  const best = new Map<string, SynapseRow>();
  for (const p of pairs) {
    const a = Math.min(p.new_id, p.match_id);
    const b = Math.max(p.new_id, p.match_id);
    const strength = strengthOf(p);
    const key = `${a}|${b}`;
    const prev = best.get(key);
    if (!prev || strength > prev.connectionStrength) {
      best.set(key, {
        memoryA: a,
        memoryB: b,
        connectionType,
        connectionStrength: strength,
        decayRate,
      });
    }
  }
  return [...best.values()];
}

async function upsertSynapses(
  rows: SynapseRow[],
  conflictSet: Record<string, unknown>
): Promise<number> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db
      .insert(schema.memorySynapses)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoUpdate({
        target: [
          schema.memorySynapses.memoryA,
          schema.memorySynapses.memoryB,
          schema.memorySynapses.connectionType,
        ],
        set: conflictSet,
      });
  }
  return rows.length;
}

export async function formSynapses(
  agentId: number,
  newNodeIds: number[]
): Promise<number> {
  if (newNodeIds.length === 0) return 0;

  // sql.raw with an explicit ARRAY literal: drizzle serializes JS number
  // arrays as composite ROW(...) types that Postgres refuses to cast to
  // int[]. IDs come from our own inserts, so there is no injection risk.
  const idsLiteral = `ARRAY[${newNodeIds.join(",")}]::int[]`;

  let synapsesCreated = 0;

  // 1. Semantic synapses -- one LATERAL top-K query for the whole batch.
  try {
    const results = await db.execute(sql`
      SELECT a.id AS new_id, m.id AS match_id, m.similarity
      FROM memory_nodes a
      CROSS JOIN LATERAL (
        SELECT b.id, 1 - (a.embedding <=> b.embedding) AS similarity
        FROM memory_nodes b
        WHERE b.agent_id = ${agentId}
          AND b.id != a.id
          AND b.status = 'active'
          AND b.embedding IS NOT NULL
          AND 1 - (a.embedding <=> b.embedding) > ${SEMANTIC_THRESHOLD}
        ORDER BY a.embedding <=> b.embedding ASC
        LIMIT ${SEMANTIC_LIMIT_PER_NODE}
      ) m
      WHERE a.id = ANY(${sql.raw(idsLiteral)})
        AND a.embedding IS NOT NULL
    `);

    const rows = dedupePairs(
      results.rows as unknown as DiscoveredPair[],
      "semantic",
      (p) => Math.min(Number(p.similarity ?? 0), 1.0),
      0.005
    );

    synapsesCreated += await upsertSynapses(rows, {
      connectionStrength: sql`GREATEST(memory_synapses.connection_strength, excluded.connection_strength)`,
      lastActivatedAt: sql`NOW()`,
    });
  } catch (err) {
    console.error("[synapses] Semantic batch error:", err);
  }

  // 2. Entity-based synapses -- one array-overlap query, capped per node.
  try {
    const results = await db.execute(sql`
      SELECT new_id, match_id FROM (
        SELECT n.id AS new_id, m.id AS match_id,
               ROW_NUMBER() OVER (PARTITION BY n.id ORDER BY m.id DESC) AS rn
        FROM memory_nodes n
        JOIN memory_nodes m
          ON m.agent_id = ${agentId}
         AND m.id != n.id
         AND m.status = 'active'
         AND m.entities && n.entities
        WHERE n.id = ANY(${sql.raw(idsLiteral)})
          AND n.entities IS NOT NULL
          AND array_length(n.entities, 1) > 0
      ) t
      WHERE rn <= ${ENTITY_LIMIT_PER_NODE}
    `);

    const rows = dedupePairs(
      results.rows as unknown as DiscoveredPair[],
      "entity_shared",
      () => 0.6,
      0.01
    );

    synapsesCreated += await upsertSynapses(rows, {
      activationCount: sql`memory_synapses.activation_count + 1`,
      lastActivatedAt: sql`NOW()`,
    });
  } catch (err) {
    console.error("[synapses] Entity batch error:", err);
  }

  // 3. Temporal synapses -- nodes from the same source file
  //    (co-located content is likely related).
  try {
    const results = await db.execute(sql`
      SELECT new_id, match_id FROM (
        SELECT n.id AS new_id, s.id AS match_id,
               ROW_NUMBER() OVER (PARTITION BY n.id ORDER BY s.id ASC) AS rn
        FROM memory_nodes n
        JOIN memory_nodes s
          ON s.agent_id = ${agentId}
         AND s.id != n.id
         AND s.source = n.source
        WHERE n.id = ANY(${sql.raw(idsLiteral)})
          AND n.source IS NOT NULL
      ) t
      WHERE rn <= ${TEMPORAL_LIMIT_PER_NODE}
    `);

    const rows = dedupePairs(
      results.rows as unknown as DiscoveredPair[],
      "temporal",
      () => 0.4,
      0.02
    );

    synapsesCreated += await upsertSynapses(rows, {
      lastActivatedAt: sql`NOW()`,
    });
  } catch (err) {
    console.error("[synapses] Temporal batch error:", err);
  }

  if (synapsesCreated > 0) {
    console.error(
      `[synapses] Formed ${synapsesCreated} synapses for ${newNodeIds.length} new nodes (batched)`
    );
  }

  return synapsesCreated;
}
