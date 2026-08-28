/**
 * CA3 — Pattern Completion / Autoassociative Recall
 *
 * Biological CA3 is a recurrent autoassociative network. Given a partial
 * or degraded cue, it reconstructs the full memory by iteratively activating
 * a network of memories through their synaptic connections.
 *
 * Unlike cosine similarity search (nearest neighbor in vector space), CA3:
 *   1. Activates memories via sparse overlap (DG codes)
 *   2. Spreads activation through the synapse graph (recurrent connections)
 *   3. Converges on a coherent recalled pattern in 2 iterations
 *
 * Example: A query "that meeting about the roof thing with Ron" might not
 * be close in dense vector space to the detailed memory. But CA3 traverses:
 *   "Ron" entity → Ron-related memories
 *   "roof" → Best Roof memories
 *   Recurrent connections between those nodes → the specific meeting memory
 *
 * References:
 *   - Ramsauer et al. (2020) "Hopfield Networks is All You Need"
 *   - Rolls (2013) CA3 autoassociative recall model
 */

import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { dgEncode, sparseOverlap } from "./dentate-gyrus.js";
import type { SparseCode, CompletionResult } from "./types.js";

const RECURRENT_BETA = 0.3; // Synapse influence weight
const ITERATIONS = 2; // Convergence iterations (biological CA3 converges fast)
const INITIAL_TOP_N = 20; // Initial activation set size
const MIN_SYNAPSE_STRENGTH = 0.15; // Minimum synapse to propagate through
const MAX_EXPANDED_NEIGHBORS = 100;
const MAX_GRAPH_EDGES = MAX_EXPANDED_NEIGHBORS * 4;

/**
 * Run CA3 pattern completion given a query.
 *
 * @param agentId - Agent whose memory graph to search
 * @param queryEmbedding - Dense 1024-dim embedding of the query
 * @param limit - Max results to return
 * @returns Ranked memories by CA3 activation score
 */
export async function patternComplete(
  agentId: number,
  queryEmbedding: number[],
  limit: number = 10,
  currentAt?: string
): Promise<CompletionResult[]> {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new TypeError("CA3 agentId must be a positive integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("CA3 limit must be a positive integer");
  }
  if (
    queryEmbedding.length !== 1024 ||
    queryEmbedding.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError("CA3 query embedding must contain 1024 finite values");
  }
  const parsedCurrentAt = new Date(currentAt ?? new Date().toISOString());
  if (!Number.isFinite(parsedCurrentAt.getTime())) {
    throw new TypeError("CA3 currentAt must be an ISO-8601 instant");
  }
  const currentAtIso = parsedCurrentAt.toISOString();

  // Step 1: Encode query through DG
  const querySparse = dgEncode(queryEmbedding);

  // Step 2: Find initial activation set via sparse overlap
  const initialActivation = await findSparseOverlapMatches(
    agentId,
    querySparse,
    INITIAL_TOP_N,
    currentAtIso
  );

  if (initialActivation.length === 0) {
    return [];
  }

  // Step 3: Load synapse graph for activated memories
  const memoryIds = initialActivation.map((m) => m.memoryId);
  const expandedNeighborLimit = Math.min(
    Math.max(limit * 4, INITIAL_TOP_N),
    MAX_EXPANDED_NEIGHBORS
  );
  const synapseGraph = await loadSynapseGraph(
    agentId,
    memoryIds,
    Math.min(expandedNeighborLimit * 4, MAX_GRAPH_EDGES),
    currentAtIso
  );

  // Step 4: Recurrent activation spreading (2 iterations)
  let activationScores = new Map<number, number>();
  for (const m of initialActivation) {
    activationScores.set(m.memoryId, m.overlapScore);
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const newScores = new Map<number, number>();

    for (const [memId, score] of activationScores) {
      // Base activation from sparse overlap
      let activation = score;

      // Add recurrent synaptic input
      const connections = synapseGraph.get(memId) || [];
      for (const conn of connections) {
        const neighborScore = activationScores.get(conn.neighborId) || 0;
        activation += RECURRENT_BETA * conn.strength * neighborScore;
      }

      newScores.set(memId, activation);
    }

    // Check for new memories pulled in through strong synapses
    // (memories not in initial set but strongly connected to activated ones)
    if (iter === 0) {
      const expandedIds = new Set(memoryIds);
      const strongestPullByNeighbor = new Map<
        number,
        { memId: number; neighborId: number; strength: number }
      >();

      for (const [memId] of activationScores) {
        const connections = synapseGraph.get(memId) || [];
        for (const conn of connections) {
          if (!expandedIds.has(conn.neighborId) && conn.strength > 0.5) {
            const prior = strongestPullByNeighbor.get(conn.neighborId);
            if (
              !prior ||
              conn.strength > prior.strength ||
              (conn.strength === prior.strength && memId < prior.memId)
            ) {
              strongestPullByNeighbor.set(conn.neighborId, {
                memId,
                neighborId: conn.neighborId,
                strength: conn.strength,
              });
            }
          }
        }
      }

      const newNeighborsToPull = [...strongestPullByNeighbor.values()]
        .sort(
          (left, right) =>
            right.strength - left.strength ||
            left.neighborId - right.neighborId ||
            left.memId - right.memId
        )
        .slice(0, expandedNeighborLimit);

      if (newNeighborsToPull.length > 0) {
        const neighborIds = newNeighborsToPull.map(n => n.neighborId);
        const overlapMap = await computeBatchOverlap(
          agentId,
          neighborIds,
          querySparse,
          currentAtIso
        );

        for (const pull of newNeighborsToPull) {
          const neighborOverlap = overlapMap.get(pull.neighborId) || 0;
          newScores.set(
            pull.neighborId,
            neighborOverlap + RECURRENT_BETA * pull.strength * (activationScores.get(pull.memId) || 0)
          );
        }
      }
    }

    activationScores = newScores;
  }

  // Step 5: Rank by final activation score
  const results: CompletionResult[] = [];
  for (const [memId, score] of activationScores) {
    const initial = initialActivation.find((m) => m.memoryId === memId);
    results.push({
      memoryId: memId,
      activationScore: score,
      sparseOverlap: initial?.overlapScore || 0,
      synapticBoost: score - (initial?.overlapScore || 0),
    });
  }

  results.sort(
    (a, b) =>
      b.activationScore - a.activationScore || a.memoryId - b.memoryId
  );
  return results.slice(0, limit);
}

/**
 * Find memories with highest sparse overlap using GIN-indexed array intersection.
 */
async function findSparseOverlapMatches(
  agentId: number,
  querySparse: SparseCode,
  topN: number,
  currentAt: string
): Promise<Array<{ memoryId: number; overlapScore: number }>> {
  // Use GIN index on sparse_indices for fast pre-filtering,
  // then compute overlap score in SQL
  //
  // NOTE (2026-04-10): Two defects were fixed in this block:
  //
  //   1. The CTE was originally named `overlaps`, which collides with
  //      PostgreSQL's OVERLAPS temporal predicate and triggered a parser
  //      error ("syntax error at or near overlaps") on some Postgres
  //      versions. Renamed to `overlap_scores`.
  //
  //   2. The `${queryIndices}::int[]` and `${queryValues}::real[]` template
  //      interpolations used drizzle-orm's sql tag on raw JS arrays, which
  //      get serialized as composite ROW(...) types and fail the ::int[]/
  //      ::real[] cast ("cannot cast type record to integer[]"). Both are
  //      now built as explicit PostgreSQL ARRAY literals and interpolated
  //      via sql.raw(), matching the pattern used in markLabile() and
  //      loadSynapseGraph(). Sparse indices/values are plain number arrays
  //      from the caller's SparseCode, no injection surface.
  //
  // The combination of these two defects silently disabled the entire CA3
  // pattern completion path (patternComplete() caught the thrown errors in
  // its outer try/catch and returned an empty result set), which masked the
  // fact that the "hippocampal pattern completion boost" had not been
  // contributing to hybrid search scores. With both defects fixed, CA3
  // recurrent activation spread is live again.
  const queryIndicesLiteral = `ARRAY[${querySparse.indices.join(",")}]::int[]`;
  const queryValuesLiteral = `ARRAY[${querySparse.values.join(",")}]::real[]`;

  const result = await db.execute(sql`
    WITH query_entries AS (
      SELECT
        pg_catalog.unnest(${sql.raw(queryIndicesLiteral)}) AS idx,
        pg_catalog.unnest(${sql.raw(queryValuesLiteral)}) AS val
    ),
    candidates AS (
      SELECT hc.memory_id, hc.sparse_indices, hc.sparse_values
      FROM public.hippocampal_codes hc
      JOIN public.memory_nodes mn
        ON mn.id = hc.memory_id
       AND mn.agent_id = hc.agent_id
      WHERE hc.agent_id = ${agentId}
        AND mn.status = 'active'
        AND (mn.valid_from IS NULL OR mn.valid_from <= ${currentAt}::timestamptz)
        AND (mn.valid_until IS NULL OR mn.valid_until > ${currentAt}::timestamptz)
        AND (
          mn.derivation_expires_at IS NULL
          OR mn.derivation_expires_at > ${currentAt}::timestamptz
        )
        AND (
          mn.ingest_event_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.memory_provenance support
            JOIN public.memory_ingest_events support_event
              ON support_event.id = support.ingest_event_id
             AND support_event.agent_id = support.agent_id
            WHERE support.agent_id = ${agentId}
              AND support.memory_id = mn.id
              AND support.relation = 'captured_from'
              AND support_event.status = 'indexed'
              AND (
                support_event.snapshot_valid_until IS NULL
                OR support_event.snapshot_valid_until > ${currentAt}::timestamptz
              )
          )
        )
        AND hc.sparse_indices && ${sql.raw(queryIndicesLiteral)}
    ),
    expanded AS (
      SELECT
        c.memory_id,
        pg_catalog.unnest(c.sparse_indices) AS idx,
        pg_catalog.unnest(c.sparse_values) AS val
      FROM candidates c
    ),
    overlap_scores AS (
      SELECT
        e.memory_id,
        pg_catalog.sum(q.val * e.val) AS overlap_score
      FROM expanded e
      JOIN query_entries q ON q.idx = e.idx
      GROUP BY e.memory_id
    )
    SELECT memory_id, overlap_score
    FROM overlap_scores
    ORDER BY overlap_score DESC, memory_id ASC
    LIMIT ${topN}
  `);

  return (result.rows as Array<{ memory_id: number; overlap_score: number }>).map(
    (r) => ({
      memoryId: Number(r.memory_id),
      overlapScore: Number(r.overlap_score),
    })
  );
}

/**
 * Compute sparse overlap for a batch of stored memories against a query.
 * Used for pulling in neighbors during recurrent activation without N+1 queries.
 */
async function computeBatchOverlap(
  agentId: number,
  memoryIds: number[],
  querySparse: SparseCode,
  currentAt: string
): Promise<Map<number, number>> {
  const overlapMap = new Map<number, number>();
  if (memoryIds.length === 0) return overlapMap;

  const idsLiteral = `ARRAY[${memoryIds.join(",")}]::int[]`;
  const result = await db.execute(sql`
    SELECT hc.memory_id, hc.sparse_indices, hc.sparse_values
    FROM public.hippocampal_codes hc
    JOIN public.memory_nodes mn
      ON mn.id = hc.memory_id
     AND mn.agent_id = hc.agent_id
    WHERE hc.agent_id = ${agentId}
      AND hc.memory_id = ANY(${sql.raw(idsLiteral)})
      AND mn.status = 'active'
      AND (mn.valid_from IS NULL OR mn.valid_from <= ${currentAt}::timestamptz)
      AND (mn.valid_until IS NULL OR mn.valid_until > ${currentAt}::timestamptz)
      AND (
        mn.derivation_expires_at IS NULL
        OR mn.derivation_expires_at > ${currentAt}::timestamptz
      )
      AND (
        mn.ingest_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_provenance support
          JOIN public.memory_ingest_events support_event
            ON support_event.id = support.ingest_event_id
           AND support_event.agent_id = support.agent_id
          WHERE support.agent_id = ${agentId}
            AND support.memory_id = mn.id
            AND support.relation = 'captured_from'
            AND support_event.status = 'indexed'
            AND (
              support_event.snapshot_valid_until IS NULL
              OR support_event.snapshot_valid_until > ${currentAt}::timestamptz
            )
        )
      )
  `);

  for (const row of result.rows as Array<{
    memory_id: number;
    sparse_indices: number[];
    sparse_values: number[];
  }>) {
    const stored: SparseCode = {
      indices: row.sparse_indices,
      values: row.sparse_values,
      dim: querySparse.dim,
    };
    overlapMap.set(Number(row.memory_id), sparseOverlap(querySparse, stored));
  }

  return overlapMap;
}

/**
 * Load synapse graph for a set of memory IDs.
 * Returns adjacency list: memoryId → [{neighborId, strength}]
 */
async function loadSynapseGraph(
  agentId: number,
  memoryIds: number[],
  edgeLimit: number,
  currentAt: string
): Promise<Map<number, Array<{ neighborId: number; strength: number }>>> {
  const graph = new Map<number, Array<{ neighborId: number; strength: number }>>();

  if (memoryIds.length === 0) return graph;

  // NOTE (2026-04-10): sql.raw with an explicit ARRAY literal bypasses
  // drizzle-orm's composite-ROW serialization of JS number arrays, which
  // Postgres refuses to cast to int[]. Before this fix, loadSynapseGraph
  // threw on every patternComplete() call, CA3's recurrent activation spread
  // was disabled, and the "hippocampal pattern completion boost" advertised
  // in the README was dead. memoryIds are typed as number[] from the caller,
  // no injection risk.
  const idsLiteral = `ARRAY[${memoryIds.join(",")}]::int[]`;
  const result = await db.execute(sql`
    SELECT edge.memory_a, edge.memory_b, edge.connection_strength
    FROM public.memory_synapses edge
    JOIN public.memory_nodes left_node
      ON left_node.id = edge.memory_a
     AND left_node.agent_id = edge.agent_id
    JOIN public.memory_nodes right_node
      ON right_node.id = edge.memory_b
     AND right_node.agent_id = edge.agent_id
    WHERE edge.agent_id = ${agentId}
      AND (
        edge.memory_a = ANY(${sql.raw(idsLiteral)})
        OR edge.memory_b = ANY(${sql.raw(idsLiteral)})
      )
      AND edge.connection_strength >= ${MIN_SYNAPSE_STRENGTH}
      AND left_node.status = 'active'
      AND right_node.status = 'active'
      AND (left_node.valid_from IS NULL OR left_node.valid_from <= ${currentAt}::timestamptz)
      AND (left_node.valid_until IS NULL OR left_node.valid_until > ${currentAt}::timestamptz)
      AND (
        left_node.derivation_expires_at IS NULL
        OR left_node.derivation_expires_at > ${currentAt}::timestamptz
      )
      AND (right_node.valid_from IS NULL OR right_node.valid_from <= ${currentAt}::timestamptz)
      AND (right_node.valid_until IS NULL OR right_node.valid_until > ${currentAt}::timestamptz)
      AND (
        right_node.derivation_expires_at IS NULL
        OR right_node.derivation_expires_at > ${currentAt}::timestamptz
      )
      AND (
        left_node.ingest_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_provenance left_support
          JOIN public.memory_ingest_events left_event
            ON left_event.id = left_support.ingest_event_id
           AND left_event.agent_id = left_support.agent_id
          WHERE left_support.agent_id = ${agentId}
            AND left_support.memory_id = left_node.id
            AND left_support.relation = 'captured_from'
            AND left_event.status = 'indexed'
            AND (
              left_event.snapshot_valid_until IS NULL
              OR left_event.snapshot_valid_until > ${currentAt}::timestamptz
            )
        )
      )
      AND (
        right_node.ingest_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_provenance right_support
          JOIN public.memory_ingest_events right_event
            ON right_event.id = right_support.ingest_event_id
           AND right_event.agent_id = right_support.agent_id
          WHERE right_support.agent_id = ${agentId}
            AND right_support.memory_id = right_node.id
            AND right_support.relation = 'captured_from'
            AND right_event.status = 'indexed'
            AND (
              right_event.snapshot_valid_until IS NULL
              OR right_event.snapshot_valid_until > ${currentAt}::timestamptz
            )
        )
      )
    ORDER BY edge.connection_strength DESC,
             LEAST(edge.memory_a, edge.memory_b) ASC,
             GREATEST(edge.memory_a, edge.memory_b) ASC,
             edge.connection_type ASC,
             edge.id ASC
    LIMIT ${edgeLimit}
  `);

  for (const row of result.rows as Array<{
    memory_a: number;
    memory_b: number;
    connection_strength: number;
  }>) {
    const a = Number(row.memory_a);
    const b = Number(row.memory_b);
    const strength = Number(row.connection_strength);

    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a)!.push({ neighborId: b, strength });
    graph.get(b)!.push({ neighborId: a, strength });
  }

  return graph;
}
