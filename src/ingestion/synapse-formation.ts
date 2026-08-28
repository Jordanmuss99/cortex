import type { Sql } from "postgres";
import { sqlClient } from "../db/index.js";
import type {
  PreparedSynapseBatch,
  SynapseCandidate,
  SynapseDiscoveryOptions,
  SynapseFormationOptions,
  SynapseInsertOptions,
} from "../memory/types.js";

/**
 * Bounded synapse discovery and replay-safe insertion.
 *
 * Durable ingest passes its final postgres transaction through `options.sql`,
 * so graph mutation, pending-node activation, and event indexing commit or
 * roll back together. Legacy callers receive a dedicated graph transaction.
 */

const SEMANTIC_THRESHOLD = Number.parseFloat(
  process.env.CORTEX_SEMANTIC_THRESHOLD ?? "0.85"
);
const SEMANTIC_LIMIT_PER_NODE = 10;
const ENTITY_LIMIT_PER_NODE = 40;
const TEMPORAL_LIMIT_PER_NODE = 5;
const INSERT_CHUNK = 400;

interface DiscoveredPair {
  new_id: number;
  match_id: number;
  similarity?: number;
}

function normalizeNodeIds(values: readonly number[]): number[] {
  const ids = [...new Set(values)];
  if (ids.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Synapse node IDs must be positive integers");
  }
  return ids.sort((left, right) => left - right);
}

function dedupePairs(
  agentId: number,
  pairs: readonly DiscoveredPair[],
  connectionType: SynapseCandidate["connectionType"],
  strengthOf: (pair: DiscoveredPair) => number,
  decayRate: number
): SynapseCandidate[] {
  const best = new Map<string, SynapseCandidate>();
  for (const pair of pairs) {
    const memoryA = Math.min(Number(pair.new_id), Number(pair.match_id));
    const memoryB = Math.max(Number(pair.new_id), Number(pair.match_id));
    if (memoryA === memoryB) continue;
    const connectionStrength = strengthOf(pair);
    if (!Number.isFinite(connectionStrength)) {
      throw new Error("Synapse candidate strength was invalid");
    }
    const key = `${connectionType}:${memoryA}:${memoryB}`;
    const previous = best.get(key);
    if (!previous || connectionStrength > previous.connectionStrength) {
      best.set(key, {
        agentId,
        memoryA,
        memoryB,
        connectionType,
        connectionStrength,
        decayRate,
      });
    }
  }
  return [...best.values()];
}

async function discoverCandidates(
  connection: Sql,
  agentId: number,
  nodeIds: readonly number[],
  currentAt: string
): Promise<SynapseCandidate[]> {
  const ids = connection.array([...nodeIds]);
  const semantic = (await connection`
    SELECT a.id AS new_id, match.id AS match_id, match.similarity
    FROM public.memory_nodes AS a
    CROSS JOIN LATERAL (
      SELECT b.id, 1 - (a.embedding <=> b.embedding) AS similarity
      FROM public.memory_nodes AS b
      WHERE b.agent_id = ${agentId}
        AND b.id <> a.id
        AND b.status = 'active'
        AND (b.valid_from IS NULL OR b.valid_from <= ${currentAt}::timestamptz)
        AND (b.valid_until IS NULL OR b.valid_until > ${currentAt}::timestamptz)
        AND (
          b.derivation_expires_at IS NULL
          OR b.derivation_expires_at > ${currentAt}::timestamptz
        )
        AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) > ${SEMANTIC_THRESHOLD}
      ORDER BY a.embedding <=> b.embedding ASC, b.id ASC
      LIMIT ${SEMANTIC_LIMIT_PER_NODE}
    ) AS match
    WHERE a.agent_id = ${agentId}
      AND a.id = ANY(${ids}::integer[])
      AND a.embedding IS NOT NULL
  `) as unknown as DiscoveredPair[];

  const entity = (await connection`
    WITH entity_df AS (
      SELECT pg_catalog.unnest(entities) AS entity,
             pg_catalog.count(*) AS df
      FROM public.memory_nodes
      WHERE agent_id = ${agentId}
        AND status = 'active'
        AND (valid_from IS NULL OR valid_from <= ${currentAt}::timestamptz)
        AND (valid_until IS NULL OR valid_until > ${currentAt}::timestamptz)
        AND (
          derivation_expires_at IS NULL
          OR derivation_expires_at > ${currentAt}::timestamptz
        )
      GROUP BY 1
    ), pairs AS (
      SELECT new_id, match_id
      FROM (
        SELECT n.id AS new_id,
               m.id AS match_id,
               pg_catalog.row_number() OVER (
                 PARTITION BY n.id ORDER BY m.id DESC
               ) AS candidate_rank
        FROM public.memory_nodes AS n
        JOIN public.memory_nodes AS m
          ON m.agent_id = n.agent_id
         AND m.id <> n.id
         AND m.status = 'active'
         AND (m.valid_from IS NULL OR m.valid_from <= ${currentAt}::timestamptz)
         AND (m.valid_until IS NULL OR m.valid_until > ${currentAt}::timestamptz)
         AND (
           m.derivation_expires_at IS NULL
           OR m.derivation_expires_at > ${currentAt}::timestamptz
         )
         AND m.entities && n.entities
        WHERE n.agent_id = ${agentId}
          AND n.id = ANY(${ids}::integer[])
          AND n.entities IS NOT NULL
          AND pg_catalog.array_length(n.entities, 1) > 0
      ) AS ranked
      WHERE candidate_rank <= ${ENTITY_LIMIT_PER_NODE}
    )
    SELECT pairs.new_id,
           pairs.match_id,
           pg_catalog.max(
             GREATEST(
               0.3,
               LEAST(
                 0.8,
                 0.8 - 0.1 * pg_catalog.ln(1 + entity_df.df)
               )
             )
           ) AS similarity
    FROM pairs
    JOIN public.memory_nodes AS new_node ON new_node.id = pairs.new_id
    JOIN public.memory_nodes AS matched_node ON matched_node.id = pairs.match_id
    JOIN entity_df
      ON entity_df.entity = ANY(new_node.entities)
     AND entity_df.entity = ANY(matched_node.entities)
    GROUP BY pairs.new_id, pairs.match_id
  `) as unknown as DiscoveredPair[];

  const temporal = (await connection`
    SELECT new_id, match_id
    FROM (
      SELECT n.id AS new_id,
             matched.id AS match_id,
             pg_catalog.row_number() OVER (
               PARTITION BY n.id ORDER BY matched.id ASC
             ) AS candidate_rank
      FROM public.memory_nodes AS n
      JOIN public.memory_nodes AS matched
        ON matched.agent_id = n.agent_id
       AND matched.id <> n.id
       AND (
         (
           matched.ingest_event_id IS NULL
           AND matched.source = n.source
         )
         OR EXISTS (
           SELECT 1
           FROM public.memory_provenance AS source_support
           JOIN public.memory_ingest_events AS source_event
             ON source_event.agent_id = source_support.agent_id
            AND source_event.id = source_support.ingest_event_id
           WHERE source_support.agent_id = matched.agent_id
             AND source_support.memory_id = matched.id
             AND source_support.relation = 'captured_from'
             AND source_event.source = n.source
             AND source_event.status = 'indexed'
             AND source_event.snapshot_valid_until IS NULL
         )
       )
       AND matched.status = 'active'
       AND (matched.valid_from IS NULL OR matched.valid_from <= ${currentAt}::timestamptz)
       AND (matched.valid_until IS NULL OR matched.valid_until > ${currentAt}::timestamptz)
       AND (
         matched.derivation_expires_at IS NULL
         OR matched.derivation_expires_at > ${currentAt}::timestamptz
       )
      WHERE n.agent_id = ${agentId}
        AND n.id = ANY(${ids}::integer[])
        AND n.source IS NOT NULL
    ) AS ranked
    WHERE candidate_rank <= ${TEMPORAL_LIMIT_PER_NODE}
  `) as unknown as DiscoveredPair[];

  return [
    ...dedupePairs(
      agentId,
      semantic,
      "semantic",
      (pair) => Math.min(Math.max(Number(pair.similarity ?? 0), 0), 1),
      0.005
    ),
    ...dedupePairs(
      agentId,
      entity,
      "entity_shared",
      (pair) =>
        Math.min(Math.max(Number(pair.similarity ?? 0.3), 0.3), 0.8),
      0.01
    ),
    ...dedupePairs(
      agentId,
      temporal,
      "temporal",
      () => 0.4,
      0.02
    ),
  ];
}

function validatePreparedBatch(
  prepared: PreparedSynapseBatch
): PreparedSynapseBatch {
  if (!Number.isSafeInteger(prepared?.agentId) || prepared.agentId <= 0) {
    throw new Error("Synapse batch agent ID is invalid");
  }
  const ids = normalizeNodeIds(prepared.newNodeIds);
  if (
    ids.length !== prepared.newNodeIds.length ||
    ids.some((id, index) => id !== prepared.newNodeIds[index]) ||
    !Number.isFinite(new Date(prepared.currentAt).getTime()) ||
    !Array.isArray(prepared.candidates) ||
    prepared.candidates.length >
      ids.length *
        (SEMANTIC_LIMIT_PER_NODE +
          ENTITY_LIMIT_PER_NODE +
          TEMPORAL_LIMIT_PER_NODE)
  ) {
    throw new Error("Synapse batch metadata is invalid");
  }
  const newNodeIds = new Set(ids);
  const keys = new Set<string>();
  for (const candidate of prepared.candidates) {
    const key = `${candidate.connectionType}:${candidate.memoryA}:${candidate.memoryB}`;
    if (
      candidate.agentId !== prepared.agentId ||
      !Number.isSafeInteger(candidate.memoryA) ||
      !Number.isSafeInteger(candidate.memoryB) ||
      candidate.memoryA <= 0 ||
      candidate.memoryB <= candidate.memoryA ||
      (!newNodeIds.has(candidate.memoryA) &&
        !newNodeIds.has(candidate.memoryB)) ||
      !new Set(["semantic", "entity_shared", "temporal"]).has(
        candidate.connectionType
      ) ||
      !Number.isFinite(candidate.connectionStrength) ||
      candidate.connectionStrength < 0 ||
      candidate.connectionStrength > 1 ||
      !Number.isFinite(candidate.decayRate) ||
      candidate.decayRate < 0 ||
      candidate.decayRate > 1 ||
      keys.has(key)
    ) {
      throw new Error("Synapse candidate is invalid");
    }
    keys.add(key);
  }
  return prepared;
}

async function insertCandidates(
  connection: Sql,
  prepared: PreparedSynapseBatch,
  replaySafe: boolean
): Promise<number> {
  const rows = prepared.candidates.map((candidate) => ({
    agent_id: candidate.agentId,
    memory_a: candidate.memoryA,
    memory_b: candidate.memoryB,
    connection_type: candidate.connectionType,
    connection_strength: candidate.connectionStrength,
    activation_count: 0,
    decay_rate: candidate.decayRate,
    last_activated_at: prepared.currentAt,
    created_at: prepared.currentAt,
  }));
  let affectedRows = 0;
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK);
    const values = connection(
      chunk,
      "agent_id",
      "memory_a",
      "memory_b",
      "connection_type",
      "connection_strength",
      "activation_count",
      "decay_rate",
      "last_activated_at",
      "created_at"
    );
    if (replaySafe) {
      const inserted = await connection`
        INSERT INTO public.memory_synapses ${values}
        ON CONFLICT (agent_id, memory_a, memory_b, connection_type)
        DO NOTHING
        RETURNING id
      `;
      affectedRows += inserted.length;
    } else {
      const insertedOrUpdated = await connection`
        INSERT INTO public.memory_synapses ${values}
        ON CONFLICT (agent_id, memory_a, memory_b, connection_type)
        DO UPDATE SET
          connection_strength = GREATEST(
            public.memory_synapses.connection_strength,
            excluded.connection_strength
          ),
          activation_count = public.memory_synapses.activation_count
            + CASE
                WHEN excluded.connection_type = 'entity_shared' THEN 1
                ELSE 0
              END,
          last_activated_at = excluded.last_activated_at
        RETURNING id
      `;
      affectedRows += insertedOrUpdated.length;
    }
  }
  return affectedRows;
}

export async function discoverSynapseCandidates(
  agentId: number,
  nodeIds: readonly number[],
  options: SynapseDiscoveryOptions = {}
): Promise<PreparedSynapseBatch> {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    throw new Error("Synapse agent ID must be a positive integer");
  }
  const ids = normalizeNodeIds(nodeIds);
  const currentAt = options.currentAt ?? new Date().toISOString();
  if (!Number.isFinite(new Date(currentAt).getTime())) {
    throw new Error("Synapse currentness instant is invalid");
  }
  const candidates =
    ids.length === 0
      ? []
      : await discoverCandidates(
          options.sql ?? sqlClient,
          agentId,
          ids,
          currentAt
        );
  return validatePreparedBatch({
    agentId,
    newNodeIds: ids,
    currentAt,
    candidates,
  });
}

export async function insertSynapseCandidates(
  prepared: PreparedSynapseBatch,
  options: SynapseInsertOptions
): Promise<number> {
  const validated = validatePreparedBatch(prepared);
  return insertCandidates(options.sql, validated, options.replaySafe);
}

async function formInTransaction(
  connection: Sql,
  agentId: number,
  nodeIds: readonly number[],
  options: SynapseFormationOptions
): Promise<number> {
  const prepared = await discoverSynapseCandidates(
    agentId,
    nodeIds,
    { sql: connection, currentAt: options.currentAt }
  );
  return insertSynapseCandidates(prepared, {
    sql: connection,
    replaySafe: options.replaySafe,
  });
}

export async function formSynapses(
  agentId: number,
  newNodeIds: readonly number[],
  options: SynapseFormationOptions = { replaySafe: false }
): Promise<number> {
  try {
    if (options.sql) {
      return await formInTransaction(options.sql, agentId, newNodeIds, options);
    }
    return await sqlClient.begin((transaction) =>
      formInTransaction(
        transaction as unknown as Sql,
        agentId,
        newNodeIds,
        options
      )
    );
  } catch (error) {
    if (options.replaySafe) throw error;
    console.error("[synapses] Graph formation degraded", {
      code: "graph_formation_degraded",
    });
    return 0;
  }
}
