import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  smallint,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
  uniqueIndex,
  customType,
  pgEnum,
  uuid,
  check,
  foreignKey,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Custom pgvector type for 1024-dim Voyage embeddings
const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    const str = value as string;
    return str
      .slice(1, -1)
      .split(",")
      .map(Number);
  },
});

const bytea = customType<{ data: Uint8Array; driverParam: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tsvector";
  },
});

function memoryNodeIdColumn(): AnyPgColumn {
  return memoryNodes.id;
}

function memoryNodeAgentIdColumn(): AnyPgColumn {
  return memoryNodes.agentId;
}

function memoryIngestEventIdColumn(): AnyPgColumn {
  return memoryIngestEvents.id;
}

function memoryIngestEventAgentIdColumn(): AnyPgColumn {
  return memoryIngestEvents.agentId;
}

// ─── Agents ─────────────────────────────────────────────
export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  externalId: varchar("external_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  ownerId: varchar("owner_id", { length: 255 }),
  config: jsonb("config").default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Memory Nodes ───────────────────────────────────────
export const memoryNodes = pgTable(
  "memory_nodes",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    source: text("source"), // file path, URL, etc.
    sourceType: varchar("source_type", { length: 64 }).default("markdown"), // markdown, telegram, limitless, api
    chunkIndex: integer("chunk_index").default(0),
    embedding: vector("embedding"),
    entities: text("entities")
      .array()
      .default(sql`'{}'::text[]`),
    semanticTags: text("semantic_tags")
      .array()
      .default(sql`'{}'::text[]`),
    priority: integer("priority").default(2), // P0 (critical) - P4 (ephemeral)
    resonanceScore: real("resonance_score").default(0.5),
    accessCount: integer("access_count").default(0),
    lastAccessedAt: timestamp("last_accessed_at"),
    lastRecalledAt: timestamp("last_recalled_at"),
    status: varchar("status", { length: 32 }).default("active"), // pending, active, superseded, archived, compressed, deleted
    // Temporal validity: when was this fact true?
    validFrom: timestamp("valid_from", { withTimezone: true }), // when this fact became true (null = since creation)
    validUntil: timestamp("valid_until", { withTimezone: true }), // when this fact stopped being true (null = still true)
    supersededBy: integer("superseded_by"), // ID of the memory that replaced this one
    noveltyScore: real("novelty_score"),
    ingestEventId: uuid("ingest_event_id"),
    ingestChunkIndex: integer("ingest_chunk_index"),
    contentHash: text("content_hash"),
    projectionFingerprint: text("projection_fingerprint"),
    embeddingProvider: varchar("embedding_provider", { length: 64 }),
    embeddingModel: varchar("embedding_model", { length: 128 }),
    derivationExpiresAt: timestamp("derivation_expires_at", {
      withTimezone: true,
    }),
    resonanceComponents: jsonb("resonance_components")
      .default({ version: "pending_recalculation" })
      .notNull(),
    searchDocument: tsvector("search_document")
      .notNull()
      .generatedAlwaysAs(
        sql`public.build_memory_search_document(content, summary, entities, semantic_tags)`
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_memory_nodes_agent").on(table.agentId),
    statusIdx: index("idx_memory_nodes_status").on(table.status),
    priorityIdx: index("idx_memory_nodes_priority").on(table.priority),
    resonanceIdx: index("idx_memory_nodes_resonance").on(table.resonanceScore),
    sourceTypeIdx: index("idx_memory_nodes_source_type").on(table.sourceType),
    createdAtIdx: index("idx_memory_nodes_created_at").on(table.createdAt),
    entitiesIdx: index("idx_memory_nodes_entities").using("gin", table.entities),
    semanticTagsIdx: index("idx_memory_nodes_semantic_tags").using(
      "gin",
      table.semanticTags
    ),
    idAgentKey: unique("memory_nodes_id_agent_key").on(
      table.id,
      table.agentId
    ),
    supersededByAgentFk: foreignKey({
      name: "memory_nodes_superseded_by_agent_fkey",
      columns: [table.supersededBy, table.agentId],
      foreignColumns: [table.id, table.agentId],
    }),
    ingestEventFk: foreignKey({
      name: "memory_nodes_ingest_event_fkey",
      columns: [table.ingestEventId, table.agentId],
      foreignColumns: [
        memoryIngestEventIdColumn(),
        memoryIngestEventAgentIdColumn(),
      ],
    }),
    ingestMetadataCheck: check(
      "memory_nodes_ingest_metadata_check",
      sql`(
        (${table.ingestEventId} IS NULL
          AND ${table.ingestChunkIndex} IS NULL
          AND ${table.contentHash} IS NULL
          AND ${table.projectionFingerprint} IS NULL
          AND ${table.embeddingProvider} IS NULL
          AND ${table.embeddingModel} IS NULL)
        OR
        (${table.ingestEventId} IS NOT NULL
          AND ${table.ingestChunkIndex} IS NOT NULL
          AND ${table.ingestChunkIndex} >= 0
          AND ${table.contentHash} IS NOT NULL
          AND ${table.contentHash} ~ '^[0-9a-f]{64}$'
          AND ${table.projectionFingerprint} IS NOT NULL
          AND ${table.projectionFingerprint} ~ '^[0-9a-f]{64}$'
          AND ${table.embeddingProvider} IS NOT NULL
          AND length(${table.embeddingProvider}) BETWEEN 1 AND 64
          AND ${table.embeddingModel} IS NOT NULL
          AND length(${table.embeddingModel}) BETWEEN 1 AND 128)
      )`
    ),
    ingestChunkIdx: uniqueIndex("memory_nodes_ingest_chunk_key")
      .on(table.ingestEventId, table.ingestChunkIndex)
      .where(sql`${table.ingestEventId} IS NOT NULL AND ${table.ingestChunkIndex} IS NOT NULL`),
    projectionFingerprintIdx: index("memory_nodes_projection_fingerprint_idx")
      .on(table.agentId, table.projectionFingerprint)
      .where(sql`${table.status} = 'active' AND ${table.projectionFingerprint} IS NOT NULL`),
    searchDocumentIdx: index("memory_nodes_search_document_idx").using(
      "gin",
      table.searchDocument
    ),
  })
);

// ─── Durable Memory Ingest Events ──────────────────────
export const memoryIngestEvents = pgTable(
  "memory_ingest_events",
  {
    id: uuid("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    rawContent: text("raw_content").notNull(),
    requestHash: text("request_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    source: text("source"),
    sourceVersion: text("source_version"),
    sourceType: varchar("source_type", { length: 64 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    observedAtWasDefaulted: boolean("observed_at_was_defaulted").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    requestedPriority: smallint("requested_priority").notNull(),
    effectivePriority: smallint("effective_priority").notNull(),
    providedEntities: text("provided_entities")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    providedSemanticTags: text("provided_semantic_tags")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    projectionMode: varchar("projection_mode", { length: 32 })
      .default("append")
      .notNull(),
    predecessorMemoryId: integer("predecessor_memory_id"),
    forceNewProjection: boolean("force_new_projection").default(false).notNull(),
    requestId: varchar("request_id", { length: 128 }),
    sessionId: varchar("session_id", { length: 128 }),
    status: varchar("status", { length: 32 }).default("accepted").notNull(),
    totalAttempts: integer("total_attempts").default(0).notNull(),
    cycleAttempts: integer("cycle_attempts").default(0).notNull(),
    manualRetryCount: integer("manual_retry_count").default(0).notNull(),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 64 }),
    failureMessage: varchar("failure_message", { length: 512 }),
    warningCodes: text("warning_codes")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    possibleUpdateIds: integer("possible_update_ids")
      .array()
      .default(sql`'{}'::integer[]`)
      .notNull(),
    projectionCount: integer("projection_count").default(0).notNull(),
    synapseCount: integer("synapse_count").default(0).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    projectedAt: timestamp("projected_at", { withTimezone: true }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    snapshotValidUntil: timestamp("snapshot_valid_until", {
      withTimezone: true,
    }),
    replacedByEventId: uuid("replaced_by_event_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    acceptanceBuildId: varchar("acceptance_build_id", { length: 128 }).notNull(),
    indexedBuildId: varchar("indexed_build_id", { length: 128 }),
    firstTerminalFailureAt: timestamp("first_terminal_failure_at", {
      withTimezone: true,
    }),
    firstTerminalFailureBuildId: varchar("first_terminal_failure_build_id", {
      length: 128,
    }),
    latestTerminalFailureAt: timestamp("latest_terminal_failure_at", {
      withTimezone: true,
    }),
    latestTerminalFailureBuildId: varchar("latest_terminal_failure_build_id", {
      length: 128,
    }),
    terminalFailureTransitionCount: integer(
      "terminal_failure_transition_count"
    )
      .default(0)
      .notNull(),
  },
  (table) => ({
    agentKey: unique("memory_ingest_events_agent_key").on(
      table.id,
      table.agentId
    ),
    replacedByFk: foreignKey({
      name: "memory_ingest_events_replaced_by_fkey",
      columns: [table.replacedByEventId, table.agentId],
      foreignColumns: [table.id, table.agentId],
    }),
    idempotencyKey: uniqueIndex("memory_ingest_events_idempotency_key").on(
      table.agentId,
      table.idempotencyKey
    ),
    claimIdx: index("memory_ingest_events_claim_idx")
      .on(
        table.status,
        table.nextAttemptAt,
        table.leaseExpiresAt,
        table.acceptedAt
      )
      .where(sql`${table.status} IN ('accepted', 'processing', 'failed')`),
    sourceIdx: index("memory_ingest_events_source_idx")
      .on(table.agentId, table.source, table.acceptedAt, table.id)
      .where(
        sql`${table.projectionMode} = 'replace_source' AND ${table.source} IS NOT NULL`
      ),
    predecessorFk: foreignKey({
      name: "memory_ingest_events_predecessor_fkey",
      columns: [table.predecessorMemoryId, table.agentId],
      foreignColumns: [memoryNodeIdColumn(), memoryNodeAgentIdColumn()],
    }),
    idempotencyCheck: check(
      "memory_ingest_events_idempotency_check",
      sql`${table.idempotencyKey} = btrim(${table.idempotencyKey})
        AND length(${table.idempotencyKey}) BETWEEN 1 AND 256`
    ),
    contentCheck: check(
      "memory_ingest_events_content_check",
      sql`length(btrim(${table.rawContent})) > 0`
    ),
    requestHashCheck: check(
      "memory_ingest_events_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`
    ),
    contentHashCheck: check(
      "memory_ingest_events_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`
    ),
    sourceTypeCheck: check(
      "memory_ingest_events_source_type_check",
      sql`${table.sourceType} = btrim(${table.sourceType})
        AND length(${table.sourceType}) BETWEEN 1 AND 64`
    ),
    priorityCheck: check(
      "memory_ingest_events_priority_check",
      sql`${table.requestedPriority} BETWEEN 0 AND 4
        AND ${table.effectivePriority} BETWEEN 0 AND 4`
    ),
    projectionModeCheck: check(
      "memory_ingest_events_projection_mode_check",
      sql`${table.projectionMode} IN ('append', 'replace_source', 'reconsolidate')`
    ),
    sourceSnapshotCheck: check(
      "memory_ingest_events_source_snapshot_check",
      sql`${table.projectionMode} <> 'replace_source'
        OR (
          ${table.source} IS NOT NULL
          AND ${table.source} = btrim(${table.source})
          AND length(${table.source}) > 0
          AND octet_length(${table.source}) <= 1024
          AND ${table.sourceVersion} IS NOT NULL
          AND ${table.sourceVersion} = btrim(${table.sourceVersion})
          AND length(${table.sourceVersion}) > 0
          AND octet_length(${table.sourceVersion}) <= 1024
        )`
    ),
    statusCheck: check(
      "memory_ingest_events_status_check",
      sql`${table.status} IN ('accepted', 'processing', 'indexed', 'failed', 'rejected')`
    ),
    validityCheck: check(
      "memory_ingest_events_validity_check",
      sql`${table.validFrom} IS NULL OR ${table.validUntil} IS NULL
        OR ${table.validUntil} > ${table.validFrom}`
    ),
    attemptsCheck: check(
      "memory_ingest_events_attempts_check",
      sql`${table.totalAttempts} >= 0
        AND ${table.cycleAttempts} >= 0
        AND ${table.manualRetryCount} >= 0
        AND ${table.cycleAttempts} <= ${table.totalAttempts}`
    ),
    countsCheck: check(
      "memory_ingest_events_counts_check",
      sql`${table.projectionCount} >= 0 AND ${table.synapseCount} >= 0`
    ),
    buildCheck: check(
      "memory_ingest_events_build_check",
      sql`${table.acceptanceBuildId} = btrim(${table.acceptanceBuildId})
        AND length(${table.acceptanceBuildId}) BETWEEN 1 AND 128
        AND (${table.indexedBuildId} IS NULL OR (
          ${table.indexedBuildId} = btrim(${table.indexedBuildId})
          AND length(${table.indexedBuildId}) BETWEEN 1 AND 128
        ))`
    ),
    leaseCheck: check(
      "memory_ingest_events_lease_check",
      sql`(
        (${table.status} = 'processing'
          AND ${table.leaseOwner} IS NOT NULL
          AND ${table.leaseToken} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.status} <> 'processing'
          AND ${table.leaseOwner} IS NULL
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL)
      )`
    ),
    retryCheck: check(
      "memory_ingest_events_retry_check",
      sql`${table.nextAttemptAt} IS NULL OR ${table.status} = 'failed'`
    ),
    projectionCheck: check(
      "memory_ingest_events_projection_check",
      sql`(${table.projectedAt} IS NULL AND ${table.projectionCount} = 0)
        OR (${table.projectedAt} IS NOT NULL AND ${table.projectionCount} > 0)`
    ),
    indexedCheck: check(
      "memory_ingest_events_indexed_check",
      sql`(${table.status} = 'indexed'
          AND ${table.projectedAt} IS NOT NULL
          AND ${table.indexedAt} IS NOT NULL
          AND ${table.indexedBuildId} IS NOT NULL)
        OR (${table.status} <> 'indexed'
          AND ${table.indexedAt} IS NULL
          AND ${table.indexedBuildId} IS NULL)`
    ),
    failureCheck: check(
      "memory_ingest_events_failure_check",
      sql`(${table.status} NOT IN ('failed', 'rejected')
          AND ${table.failureCode} IS NULL
          AND ${table.failureMessage} IS NULL)
        OR (${table.status} IN ('failed', 'rejected')
          AND ${table.failureCode} IS NOT NULL
          AND ${table.failureMessage} IS NOT NULL
          AND ${table.failureCode} = btrim(${table.failureCode})
          AND length(${table.failureCode}) BETWEEN 1 AND 64
          AND ${table.failureMessage} = btrim(${table.failureMessage})
          AND length(${table.failureMessage}) BETWEEN 1 AND 512)`
    ),
    terminalHistoryCheck: check(
      "memory_ingest_events_terminal_history_check",
      sql`(${table.terminalFailureTransitionCount} = 0
          AND ${table.firstTerminalFailureAt} IS NULL
          AND ${table.firstTerminalFailureBuildId} IS NULL
          AND ${table.latestTerminalFailureAt} IS NULL
          AND ${table.latestTerminalFailureBuildId} IS NULL)
        OR (${table.terminalFailureTransitionCount} > 0
          AND ${table.firstTerminalFailureAt} IS NOT NULL
          AND ${table.firstTerminalFailureBuildId} IS NOT NULL
          AND ${table.firstTerminalFailureBuildId} = btrim(${table.firstTerminalFailureBuildId})
          AND length(${table.firstTerminalFailureBuildId}) BETWEEN 1 AND 128
          AND ${table.latestTerminalFailureAt} IS NOT NULL
          AND ${table.latestTerminalFailureBuildId} IS NOT NULL
          AND ${table.latestTerminalFailureBuildId} = btrim(${table.latestTerminalFailureBuildId})
          AND length(${table.latestTerminalFailureBuildId}) BETWEEN 1 AND 128
          AND ${table.firstTerminalFailureAt} <= ${table.latestTerminalFailureAt})`
    ),
    terminalStateCheck: check(
      "memory_ingest_events_terminal_state_check",
      sql`${table.status} <> 'failed'
        OR ${table.nextAttemptAt} IS NOT NULL
        OR ${table.terminalFailureTransitionCount} > 0`
    ),
    snapshotCloseCheck: check(
      "memory_ingest_events_snapshot_close_check",
      sql`(
          ${table.snapshotValidUntil} IS NULL
          AND ${table.replacedByEventId} IS NULL
        ) OR (
          ${table.projectionMode} = 'replace_source'
          AND ${table.status} = 'indexed'
          AND ${table.indexedAt} IS NOT NULL
          AND ${table.snapshotValidUntil} IS NOT NULL
          AND ${table.snapshotValidUntil} >= ${table.indexedAt}
          AND ${table.replacedByEventId} IS NOT NULL
          AND ${table.replacedByEventId} <> ${table.id}
        )`
    ),
  })
);

// ─── Memory Provenance ─────────────────────────────────
export const memoryProvenance = pgTable(
  "memory_provenance",
  {
    id: uuid("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    memoryId: integer("memory_id").notNull(),
    ingestEventId: uuid("ingest_event_id"),
    sourceMemoryId: integer("source_memory_id"),
    relation: varchar("relation", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    memoryIdx: index("memory_provenance_memory_idx").on(
      table.agentId,
      table.memoryId
    ),
    eventIdx: index("memory_provenance_event_idx")
      .on(table.agentId, table.ingestEventId)
      .where(sql`${table.ingestEventId} IS NOT NULL`),
    memoryFk: foreignKey({
      name: "memory_provenance_memory_fkey",
      columns: [table.memoryId, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }).onDelete("cascade"),
    eventFk: foreignKey({
      name: "memory_provenance_event_fkey",
      columns: [table.ingestEventId, table.agentId],
      foreignColumns: [memoryIngestEvents.id, memoryIngestEvents.agentId],
    }),
    sourceMemoryFk: foreignKey({
      name: "memory_provenance_source_memory_fkey",
      columns: [table.sourceMemoryId, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }),
    sourceCheck: check(
      "memory_provenance_source_check",
      sql`${table.ingestEventId} IS NOT NULL OR ${table.sourceMemoryId} IS NOT NULL`
    ),
    selfCheck: check(
      "memory_provenance_self_check",
      sql`${table.sourceMemoryId} IS NULL OR ${table.sourceMemoryId} <> ${table.memoryId}`
    ),
    relationCheck: check(
      "memory_provenance_relation_check",
      sql`${table.relation} = btrim(${table.relation})
        AND length(${table.relation}) BETWEEN 1 AND 32`
    ),
    relationKey: unique("memory_provenance_relation_key")
      .on(
        table.agentId,
        table.memoryId,
        table.ingestEventId,
        table.sourceMemoryId,
        table.relation
      )
      .nullsNotDistinct(),
  })
);

// ─── Bounded Working Memory ────────────────────────────
export const workingMemoryItems = pgTable(
  "working_memory_items",
  {
    id: uuid("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    callerKey: varchar("caller_key", { length: 256 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    content: text("content").notNull(),
    sourceMemoryId: integer("source_memory_id"),
    sourceEventId: uuid("source_event_id"),
    status: varchar("status", { length: 32 }).notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    importance: real("importance").default(0.5).notNull(),
    lastConfirmedAt: timestamp("last_confirmed_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: varchar("resolution_reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    idAgentKey: unique("working_memory_items_id_agent_key").on(
      table.id,
      table.agentId
    ),
    agentCallerKey: unique("working_memory_items_agent_caller_key").on(
      table.agentId,
      table.callerKey
    ),
    sourceMemoryFk: foreignKey({
      name: "working_memory_items_source_memory_fkey",
      columns: [table.sourceMemoryId, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }),
    sourceEventFk: foreignKey({
      name: "working_memory_items_source_event_fkey",
      columns: [table.sourceEventId, table.agentId],
      foreignColumns: [memoryIngestEvents.id, memoryIngestEvents.agentId],
    }),
    callerKeyCheck: check(
      "working_memory_items_caller_key_check",
      sql`${table.callerKey} = btrim(${table.callerKey})
        AND octet_length(${table.callerKey}) BETWEEN 1 AND 256`
    ),
    kindCheck: check(
      "working_memory_items_kind_check",
      sql`${table.kind} IN (
        'current_task', 'open_loop', 'constraint', 'correction', 'preference'
      )`
    ),
    contentCheck: check(
      "working_memory_items_content_check",
      sql`length(btrim(${table.content})) > 0
        AND octet_length(${table.content}) <= 8192`
    ),
    statusCheck: check(
      "working_memory_items_status_check",
      sql`${table.status} IN ('active', 'resolved', 'expired')`
    ),
    displayOrderCheck: check(
      "working_memory_items_display_order_check",
      sql`${table.displayOrder} BETWEEN -1000000 AND 1000000`
    ),
    importanceCheck: check(
      "working_memory_items_importance_check",
      sql`${table.importance} BETWEEN 0 AND 1`
    ),
    correctionSourceCheck: check(
      "working_memory_items_correction_source_check",
      sql`${table.kind} <> 'correction' OR ${table.sourceMemoryId} IS NOT NULL`
    ),
    timeCheck: check(
      "working_memory_items_time_check",
      sql`${table.lastConfirmedAt} >= ${table.createdAt}
        AND ${table.expiresAt} > ${table.lastConfirmedAt}
        AND ${table.expiresAt} <= ${table.lastConfirmedAt} + INTERVAL '30 days'
        AND ${table.updatedAt} >= ${table.createdAt}
        AND ${table.updatedAt} >= ${table.lastConfirmedAt}
        AND (${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.createdAt})
        AND (${table.resolvedAt} IS NULL OR ${table.updatedAt} >= ${table.resolvedAt})`
    ),
    resolutionCheck: check(
      "working_memory_items_resolution_check",
      sql`(${table.status} = 'active'
          AND ${table.resolvedAt} IS NULL
          AND ${table.resolutionReason} IS NULL)
        OR (${table.status} IN ('resolved', 'expired')
          AND ${table.resolvedAt} IS NOT NULL
          AND ${table.resolutionReason} IS NOT NULL
          AND ${table.resolutionReason} = btrim(${table.resolutionReason})
          AND octet_length(${table.resolutionReason}) BETWEEN 1 AND 512)`
    ),
    activeIdx: index("working_memory_items_active_idx").on(
      table.agentId,
      table.status,
      table.expiresAt,
      table.displayOrder,
      table.importance.desc(),
      table.lastConfirmedAt.desc()
    ),
    sourceMemoryIdx: index("working_memory_items_source_memory_idx")
      .on(table.sourceMemoryId, table.agentId)
      .where(sql`${table.sourceMemoryId} IS NOT NULL`),
    sourceEventIdx: index("working_memory_items_source_event_idx")
      .on(table.sourceEventId, table.agentId)
      .where(sql`${table.sourceEventId} IS NOT NULL`),
  })
);

// ─── Retrieval Evidence ────────────────────────────────
export const memoryRetrievals = pgTable(
  "memory_retrievals",
  {
    id: uuid("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    requestId: varchar("request_id", { length: 128 }),
    sessionId: varchar("session_id", { length: 128 }),
    query: text("query"),
    queryHash: text("query_hash").notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    algorithmVersion: varchar("algorithm_version", { length: 128 }).notNull(),
    buildId: varchar("build_id", { length: 128 }).notNull(),
    tokenBudget: integer("token_budget"),
    candidateCount: integer("candidate_count").default(0).notNull(),
    returnedCount: integer("returned_count").default(0).notNull(),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => ({
    idAgentKey: unique("memory_retrievals_id_agent_key").on(
      table.id,
      table.agentId
    ),
    agentCreatedIdx: index("memory_retrievals_agent_created_idx").on(
      table.agentId,
      table.createdAt.desc()
    ),
    requestIdCheck: check(
      "memory_retrievals_request_id_check",
      sql`${table.requestId} IS NULL OR (
        ${table.requestId} = btrim(${table.requestId})
        AND octet_length(${table.requestId}) BETWEEN 1 AND 128
      )`
    ),
    sessionIdCheck: check(
      "memory_retrievals_session_id_check",
      sql`${table.sessionId} IS NULL OR (
        ${table.sessionId} = btrim(${table.sessionId})
        AND octet_length(${table.sessionId}) BETWEEN 1 AND 128
      )`
    ),
    queryCheck: check(
      "memory_retrievals_query_check",
      sql`(${table.query} IS NOT NULL
          AND length(btrim(${table.query})) > 0
          AND octet_length(${table.query}) <= 8192)
        OR (${table.query} IS NULL AND ${table.redactedAt} IS NOT NULL)`
    ),
    queryHashCheck: check(
      "memory_retrievals_query_hash_check",
      sql`${table.queryHash} ~ '^[0-9a-f]{64}$'`
    ),
    channelCheck: check(
      "memory_retrievals_channel_check",
      sql`${table.channel} IN ('search', 'recall', 'init', 'hook', 'gateway', 'evaluation')`
    ),
    statusCheck: check(
      "memory_retrievals_status_check",
      sql`${table.status} IN ('running', 'completed', 'failed')`
    ),
    errorCodeCheck: check(
      "memory_retrievals_error_code_check",
      sql`${table.errorCode} IS NULL OR (
        ${table.errorCode} = btrim(${table.errorCode})
        AND octet_length(${table.errorCode}) BETWEEN 1 AND 64
      )`
    ),
    identityCheck: check(
      "memory_retrievals_identity_check",
      sql`${table.algorithmVersion} = btrim(${table.algorithmVersion})
        AND octet_length(${table.algorithmVersion}) BETWEEN 1 AND 128
        AND ${table.buildId} = btrim(${table.buildId})
        AND octet_length(${table.buildId}) BETWEEN 1 AND 128`
    ),
    tokenBudgetCheck: check(
      "memory_retrievals_token_budget_check",
      sql`${table.tokenBudget} IS NULL OR ${table.tokenBudget} BETWEEN 1 AND 32000`
    ),
    countCheck: check(
      "memory_retrievals_count_check",
      sql`${table.candidateCount} BETWEEN 0 AND 500
        AND ${table.returnedCount} BETWEEN 0 AND 50
        AND ${table.returnedCount} <= ${table.candidateCount}`
    ),
    latencyCheck: check(
      "memory_retrievals_latency_check",
      sql`${table.latencyMs} IS NULL OR ${table.latencyMs} >= 0`
    ),
    timeCheck: check(
      "memory_retrievals_time_check",
      sql`(${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
        AND (${table.redactedAt} IS NULL OR ${table.redactedAt} >= ${table.createdAt})`
    ),
    stateCheck: check(
      "memory_retrievals_state_check",
      sql`(${table.status} = 'running'
          AND ${table.completedAt} IS NULL
          AND ${table.errorCode} IS NULL)
        OR (${table.status} = 'completed'
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NULL)
        OR (${table.status} = 'failed'
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NOT NULL)`
    ),
    redactionCheck: check(
      "memory_retrievals_redaction_check",
      sql`${table.redactedAt} IS NULL OR (
        ${table.query} IS NULL
        AND ${table.requestId} IS NULL
        AND ${table.sessionId} IS NULL
      )`
    ),
  })
);

export const memoryRetrievalItems = pgTable(
  "memory_retrieval_items",
  {
    id: uuid("id").primaryKey(),
    agentId: integer("agent_id").notNull(),
    retrievalId: uuid("retrieval_id").notNull(),
    memoryId: integer("memory_id"),
    workingItemId: uuid("working_item_id"),
    contentHash: text("content_hash").notNull(),
    candidateLanes: text("candidate_lanes").array().notNull(),
    componentRanks: jsonb("component_ranks").notNull(),
    finalScore: real("final_score").notNull(),
    finalRank: integer("final_rank").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
  },
  (table) => ({
    idAgentKey: unique("memory_retrieval_items_id_agent_key").on(
      table.id,
      table.agentId
    ),
    retrievalMemoryKey: unique(
      "memory_retrieval_items_retrieval_memory_key"
    ).on(table.retrievalId, table.memoryId),
    retrievalWorkingKey: unique(
      "memory_retrieval_items_retrieval_working_key"
    ).on(table.retrievalId, table.workingItemId),
    retrievalRankKey: unique(
      "memory_retrieval_items_retrieval_rank_key"
    ).on(table.retrievalId, table.finalRank),
    retrievalFk: foreignKey({
      name: "memory_retrieval_items_retrieval_fkey",
      columns: [table.retrievalId, table.agentId],
      foreignColumns: [memoryRetrievals.id, memoryRetrievals.agentId],
    }).onDelete("cascade"),
    memoryFk: foreignKey({
      name: "memory_retrieval_items_memory_fkey",
      columns: [table.memoryId, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }),
    workingItemFk: foreignKey({
      name: "memory_retrieval_items_working_item_fkey",
      columns: [table.workingItemId, table.agentId],
      foreignColumns: [workingMemoryItems.id, workingMemoryItems.agentId],
    }),
    referenceCheck: check(
      "memory_retrieval_items_reference_check",
      sql`num_nonnulls(${table.memoryId}, ${table.workingItemId}) = 1`
    ),
    contentHashCheck: check(
      "memory_retrieval_items_content_hash_check",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`
    ),
    candidateLanesCheck: check(
      "memory_retrieval_items_candidate_lanes_check",
      sql`cardinality(${table.candidateLanes}) BETWEEN 1 AND 6
        AND array_position(${table.candidateLanes}, NULL) IS NULL
        AND ${table.candidateLanes} <@ ARRAY[
          'working', 'lexical', 'vector', 'entity', 'graph', 'artifact'
        ]::text[]`
    ),
    componentRanksCheck: check(
      "memory_retrieval_items_component_ranks_check",
      sql`public.is_valid_memory_retrieval_components(
        ${table.candidateLanes},
        ${table.componentRanks}
      )`
    ),
    scoreCheck: check(
      "memory_retrieval_items_score_check",
      sql`${table.finalScore} BETWEEN 0 AND 1`
    ),
    rankCheck: check(
      "memory_retrieval_items_rank_check",
      sql`${table.finalRank} BETWEEN 1 AND 500`
    ),
    returnedTimeCheck: check(
      "memory_retrieval_items_returned_time_check",
      sql`${table.returnedAt} IS NULL OR ${table.returnedAt} >= ${table.createdAt}`
    ),
    memoryReturnedIdx: index("memory_retrieval_items_memory_returned_idx").on(
      table.memoryId,
      table.agentId,
      table.returnedAt.desc()
    ),
    workingReturnedIdx: index("memory_retrieval_items_working_returned_idx")
      .on(table.workingItemId, table.agentId, table.returnedAt.desc())
      .where(sql`${table.workingItemId} IS NOT NULL`),
    returnedIdx: index("memory_retrieval_items_returned_idx")
      .on(table.agentId, table.returnedAt.desc())
      .where(sql`${table.returnedAt} IS NOT NULL`),
  })
);

// ─── Operation Runs / Worker Heartbeats ────────────────
export const memoryOperationRuns = pgTable(
  "memory_operation_runs",
  {
    id: uuid("id").primaryKey(),
    agentId: integer("agent_id").references(() => agents.id),
    operation: varchar("operation", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    buildId: varchar("build_id", { length: 128 }).notNull(),
    workerId: varchar("worker_id", { length: 128 }).notNull(),
    counters: jsonb("counters").default({}).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    readinessIdx: index("memory_operation_runs_readiness_idx").on(
      table.operation,
      table.status,
      table.heartbeatAt.desc()
    ),
    operationCheck: check(
      "memory_operation_runs_operation_check",
      sql`${table.operation} IN ('ingest_worker', 'reflection')`
    ),
    statusCheck: check(
      "memory_operation_runs_status_check",
      sql`${table.status} IN ('running', 'succeeded', 'failed', 'stopped')`
    ),
    identityCheck: check(
      "memory_operation_runs_identity_check",
      sql`${table.buildId} = btrim(${table.buildId})
        AND length(${table.buildId}) BETWEEN 1 AND 128
        AND ${table.workerId} = btrim(${table.workerId})
        AND length(${table.workerId}) BETWEEN 1 AND 128`
    ),
    countersCheck: check(
      "memory_operation_runs_counters_check",
      sql`jsonb_typeof(${table.counters}) = 'object'
        AND octet_length(${table.counters}::text) <= 4096`
    ),
    timeCheck: check(
      "memory_operation_runs_time_check",
      sql`${table.heartbeatAt} >= ${table.startedAt}
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`
    ),
    completionCheck: check(
      "memory_operation_runs_completion_check",
      sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL)
        OR (${table.status} <> 'running' AND ${table.completedAt} IS NOT NULL)`
    ),
  })
);

// ─── Memory Synapses ────────────────────────────────────
export const memorySynapses = pgTable(
  "memory_synapses",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    memoryA: integer("memory_a").notNull(),
    memoryB: integer("memory_b").notNull(),
    connectionType: varchar("connection_type", { length: 32 }).notNull(), // causal, temporal, semantic, entity_shared
    connectionStrength: real("connection_strength").default(0.5).notNull(),
    activationCount: integer("activation_count").default(0),
    decayRate: real("decay_rate").default(0.01),
    lastActivatedAt: timestamp("last_activated_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_synapses_agent").on(table.agentId),
    memoryAIdx: index("idx_synapses_memory_a").on(table.memoryA),
    memoryBIdx: index("idx_synapses_memory_b").on(table.memoryB),
    typeIdx: index("idx_synapses_type").on(table.connectionType),
    strengthIdx: index("idx_synapses_strength").on(table.connectionStrength),
    pairIdx: uniqueIndex("idx_synapses_pair").on(
      table.agentId,
      table.memoryA,
      table.memoryB,
      table.connectionType
    ),
    memoryAAgentFk: foreignKey({
      name: "memory_synapses_memory_a_agent_fkey",
      columns: [table.memoryA, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }).onDelete("cascade"),
    memoryBAgentFk: foreignKey({
      name: "memory_synapses_memory_b_agent_fkey",
      columns: [table.memoryB, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }).onDelete("cascade"),
  })
);

// ─── Hippocampal Codes (DG Sparse Representations) ─────
export const hippocampalCodes = pgTable(
  "hippocampal_codes",
  {
    id: serial("id").primaryKey(),
    memoryId: integer("memory_id").notNull().unique(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    sparseIndices: integer("sparse_indices")
      .array()
      .notNull(),
    sparseValues: real("sparse_values")
      .array()
      .notNull(),
    sparseDim: integer("sparse_dim").default(4096),
    noveltyScore: real("novelty_score"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_hc_agent").on(table.agentId),
    memoryIdx: index("idx_hc_memory").on(table.memoryId),
    indicesIdx: index("idx_hc_indices").using("gin", table.sparseIndices),
    memoryAgentFk: foreignKey({
      name: "hippocampal_codes_memory_agent_fkey",
      columns: [table.memoryId, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }).onDelete("cascade"),
  })
);

// ─── Emotional Valence (Multi-Dimensional Emotional Context) ─
export const emotionalValence = pgTable(
  "emotional_valence",
  {
    id: serial("id").primaryKey(),
    memoryId: integer("memory_id").notNull().unique(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    valence: real("valence").default(0).notNull(), // -1 to 1
    arousal: real("arousal").default(0).notNull(), // -1 to 1
    dominance: real("dominance").default(0).notNull(), // -1 to 1
    certainty: real("certainty").default(0).notNull(), // -1 to 1
    relevance: real("relevance").default(0.3).notNull(), // 0 to 1
    urgency: real("urgency").default(0).notNull(), // 0 to 1
    intensity: real("intensity").default(0).notNull(), // derived: vector magnitude
    decayResistance: real("decay_resistance").default(0).notNull(), // 0 to 1
    recallBoost: real("recall_boost").default(0).notNull(), // 0 to 1
    dominantDimension: varchar("dominant_dimension", { length: 32 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_ev_agent").on(table.agentId),
    memoryIdx: index("idx_ev_memory").on(table.memoryId),
    intensityIdx: index("idx_ev_intensity").on(table.intensity),
    decayResistIdx: index("idx_ev_decay_resistance").on(table.decayResistance),
    memoryAgentFk: foreignKey({
      name: "emotional_valence_memory_agent_fkey",
      columns: [table.memoryId, table.agentId],
      foreignColumns: [memoryNodes.id, memoryNodes.agentId],
    }).onDelete("cascade"),
  })
);

// ─── Procedural Memories (Skills/Workflows/Habits) ──────
export const proceduralMemories = pgTable(
  "procedural_memories",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    proceduralType: varchar("procedural_type", { length: 32 }).notNull(), // skill, workflow, pattern, preference, heuristic
    triggerContext: text("trigger_context").notNull(), // when does this apply
    steps: text("steps").array().default(sql`'{}'::text[]`),
    embedding: vector("embedding"),
    proficiency: varchar("proficiency", { length: 32 }).default("novice"), // novice, competent, proficient, expert
    executionCount: integer("execution_count").default(0),
    successCount: integer("success_count").default(0),
    successRate: real("success_rate").default(0),
    domainTags: text("domain_tags").array().default(sql`'{}'::text[]`),
    sourceMemoryIds: integer("source_memory_ids").array().default(sql`'{}'::int[]`),
    version: integer("version").default(1),
    status: varchar("status", { length: 32 }).default("active"),
    lastExecutedAt: timestamp("last_executed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_proc_agent").on(table.agentId),
    typeIdx: index("idx_proc_type").on(table.proceduralType),
    proficiencyIdx: index("idx_proc_proficiency").on(table.proficiency),
    domainTagsIdx: index("idx_proc_domain_tags").using("gin", table.domainTags),
    statusIdx: index("idx_proc_status").on(table.status),
  })
);

// ─── Cognitive Artifacts ────────────────────────────────
export const cognitiveArtifacts = pgTable(
  "cognitive_artifacts",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    sessionId: varchar("session_id", { length: 128 }),
    artifactType: varchar("artifact_type", { length: 32 }).notNull(), // decision, learning, correction, insight
    content: jsonb("content").notNull(),
    embedding: vector("embedding"),
    resonanceScore: real("resonance_score").default(5.0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_artifacts_agent").on(table.agentId),
    typeIdx: index("idx_artifacts_type").on(table.artifactType),
    createdAtIdx: index("idx_artifacts_created_at").on(table.createdAt),
  })
);

// ─── Dream Cycle Logs ───────────────────────────────────
export const dreamCycleLogs = pgTable(
  "dream_cycle_logs",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    cycleType: varchar("cycle_type", { length: 32 }).notNull(), // full, resonance_only, pruning_only, consolidation_only
    stats: jsonb("stats").default({}),
    insightsDiscovered: jsonb("insights_discovered").default([]),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    agentIdx: index("idx_dream_logs_agent").on(table.agentId),
    startedAtIdx: index("idx_dream_logs_started_at").on(table.startedAt),
  })
);

// ─── Self Diagnostics (Phase 1: Proprioception) ────────
export const selfDiagnostics = pgTable(
  "self_diagnostics",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    skillsStatus: jsonb("skills_status").default({}),
    cronStatus: jsonb("cron_status").default({}),
    channelsStatus: jsonb("channels_status").default({}),
    driftScore: real("drift_score").default(0),
    driftDetails: jsonb("drift_details").default({}),
    alerts: text("alerts")
      .array()
      .default(sql`'{}'::text[]`),
    overallHealth: varchar("overall_health", { length: 32 }).default("healthy"), // healthy, degraded, critical
  },
  (table) => ({
    agentIdx: index("idx_self_diagnostics_agent").on(table.agentId),
    timestampIdx: index("idx_self_diagnostics_timestamp").on(table.timestamp),
    healthIdx: index("idx_self_diagnostics_health").on(table.overallHealth),
  })
);

// ─── Agent State Logs (Phase 1: Proprioception) ────────
export const agentStateLogs = pgTable(
  "agent_state_logs",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    sessionId: varchar("session_id", { length: 128 }),
    energyState: varchar("energy_state", { length: 32 }).default("normal"), // high, normal, low, depleted
    activeThreads: jsonb("active_threads").default([]),
    confidence: real("confidence").default(0.5),
    memoryQuality: real("memory_quality").default(0.5),
    concerns: text("concerns")
      .array()
      .default(sql`'{}'::text[]`),
    notes: text("notes"),
  },
  (table) => ({
    agentIdx: index("idx_agent_state_logs_agent").on(table.agentId),
    timestampIdx: index("idx_agent_state_logs_timestamp").on(table.timestamp),
    sessionIdx: index("idx_agent_state_logs_session").on(table.sessionId),
  })
);

// ─── Principal State (Phase 2: Empathic Modeling) ──────
export const principalState = pgTable(
  "principal_state",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
    energy: real("energy").default(0.5),
    stress: real("stress").default(0.3),
    focusState: varchar("focus_state", { length: 32 }).default("normal"), // hyperfocus, flow, normal, scattered, executive_dysfunction
    emotionalValence: real("emotional_valence").default(0), // -1 to 1
    adhdState: varchar("adhd_state", { length: 32 }).default("managed"), // hyperfocus, managed, restless, overwhelmed, shutdown
    rawSignals: jsonb("raw_signals").default({}),
    inferredFrom: text("inferred_from"),
    confidenceScore: real("confidence_score").default(0.5),
  },
  (table) => ({
    agentIdx: index("idx_principal_state_agent").on(table.agentId),
    timestampIdx: index("idx_principal_state_timestamp").on(table.timestamp),
  })
);

// ─── Background Threads (Phase 3: Autonomous Cognition) ─
export const backgroundThreads = pgTable(
  "background_threads",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    threadType: varchar("thread_type", { length: 32 }).notNull(), // strategic, operational, relational
    status: varchar("status", { length: 32 }).default("idle"), // idle, running, completed, error
    lastRun: timestamp("last_run"),
    findings: jsonb("findings").default({ insights: [], actions: [], questions: [] }),
    nextAction: text("next_action"),
    priority: integer("priority").default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("idx_bg_threads_agent").on(table.agentId),
    typeIdx: index("idx_bg_threads_type").on(table.threadType),
    statusIdx: index("idx_bg_threads_status").on(table.status),
  })
);

// ─── Relationship Graph (Phase 5: Social Intelligence) ──
export const relationshipGraph = pgTable(
  "relationship_graph",
  {
    id: serial("id").primaryKey(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    personName: varchar("person_name", { length: 255 }).notNull(),
    personEmail: varchar("person_email", { length: 255 }),
    relationshipType: varchar("relationship_type", { length: 32 }), // family, client, partner, vendor, friend, professional
    lastContact: timestamp("last_contact"),
    contactFrequency: varchar("contact_frequency", { length: 32 }).default("as_needed"), // daily, weekly, biweekly, monthly, quarterly, as_needed
    importanceScore: real("importance_score").default(5),
    personalityModel: jsonb("personality_model").default({}),
    openItems: jsonb("open_items").default([]),
    communicationPrefs: jsonb("communication_prefs").default({}),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    agentPersonIdx: uniqueIndex("idx_relationship_agent_person").on(
      table.agentId,
      table.personName
    ),
    agentIdx: index("idx_relationship_agent").on(table.agentId),
    personIdx: index("idx_relationship_person").on(table.personName),
    typeIdx: index("idx_relationship_type").on(table.relationshipType),
    importanceIdx: index("idx_relationship_importance").on(table.importanceScore),
  })
);

// ─── OAuth Authority ───────────────────────────────────
export const oauthScopeEnum = pgEnum("oauth_scope", [
  "cortex:read",
  "cortex:write",
  "mcp",
]);

export const oauthPrincipalStatusEnum = pgEnum("oauth_principal_status", [
  "active",
  "disabled",
]);

export const oauthBindingStatusEnum = pgEnum("oauth_binding_status", [
  "active",
  "revoked",
]);

export const oauthClientStatusEnum = pgEnum("oauth_client_status", [
  "active",
  "disabled",
]);

export const oauthClientKindEnum = pgEnum("oauth_client_kind", [
  "dynamic",
  "static",
  "legacy",
]);

export const oauthTokenEndpointAuthMethodEnum = pgEnum(
  "oauth_token_endpoint_auth_method",
  ["none", "client_secret_basic", "client_secret_post"]
);

export const oauthGrantStatusEnum = pgEnum("oauth_grant_status", [
  "active",
  "revoked",
  "expired",
  "superseded",
]);

export const oauthRefreshKindEnum = pgEnum("oauth_refresh_kind", [
  "v2",
  "legacy",
]);

export const oauthAuditActorTypeEnum = pgEnum("oauth_audit_actor_type", [
  "connector",
  "browser",
  "operator",
  "migration",
  "system",
]);

export const oauthStateMigrationOutcomeEnum = pgEnum(
  "oauth_state_migration_outcome",
  ["imported", "fresh_install"]
);

export const oauthPrincipals = pgTable(
  "oauth_principals",
  {
    id: uuid("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    status: oauthPrincipalStatusEnum("status").default("active").notNull(),
    authenticationEpoch: integer("authentication_epoch").default(0).notNull(),
    legacyNotBefore: timestamp("legacy_not_before", { withTimezone: true })
      .default(sql`'epoch'::timestamptz`)
      .notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    identityIdx: uniqueIndex("oauth_principals_identity_key").on(
      table.issuer,
      table.subject
    ),
    issuerCheck: check(
      "oauth_principals_issuer_check",
      sql`${table.issuer} = btrim(${table.issuer}) AND length(${table.issuer}) BETWEEN 1 AND 2048`
    ),
    subjectCheck: check(
      "oauth_principals_subject_check",
      sql`${table.subject} = btrim(${table.subject}) AND length(${table.subject}) BETWEEN 1 AND 512`
    ),
    authenticationEpochCheck: check(
      "oauth_principals_authentication_epoch_check",
      sql`${table.authenticationEpoch} >= 0`
    ),
    disabledStateCheck: check(
      "oauth_principals_disabled_state_check",
      sql`(
        (${table.status} = 'active' AND ${table.disabledAt} IS NULL AND ${table.disabledReason} IS NULL)
        OR
        (${table.status} = 'disabled' AND ${table.disabledAt} IS NOT NULL
          AND ${table.disabledReason} IS NOT NULL
          AND ${table.disabledReason} = btrim(${table.disabledReason})
          AND length(${table.disabledReason}) BETWEEN 1 AND 1024)
      )`
    ),
  })
);

export const oauthAgentBindings = pgTable(
  "oauth_agent_bindings",
  {
    id: uuid("id").primaryKey(),
    principalId: uuid("principal_id")
      .references(() => oauthPrincipals.id)
      .notNull(),
    agentId: integer("agent_id")
      .references(() => agents.id)
      .notNull(),
    status: oauthBindingStatusEnum("status").default("active").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    bindingVersion: integer("binding_version").default(1).notNull(),
    allowedScopes: oauthScopeEnum("allowed_scopes").array().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    principalAgentIdx: uniqueIndex(
      "oauth_agent_bindings_principal_agent_key"
    ).on(table.principalId, table.agentId),
    idPrincipalIdx: uniqueIndex(
      "oauth_agent_bindings_id_principal_key"
    ).on(table.id, table.principalId),
    activeDefaultIdx: uniqueIndex(
      "oauth_agent_bindings_one_active_default_idx"
    )
      .on(table.principalId)
      .where(sql`${table.status} = 'active' AND ${table.isDefault}`),
    liveLookupIdx: index("oauth_agent_bindings_live_lookup_idx").on(
      table.principalId,
      table.status,
      table.isDefault
    ),
    agentIdx: index("oauth_agent_bindings_agent_idx").on(table.agentId),
    agentIdCheck: check(
      "oauth_agent_bindings_agent_id_check",
      sql`${table.agentId} > 0`
    ),
    versionCheck: check(
      "oauth_agent_bindings_version_check",
      sql`${table.bindingVersion} >= 1`
    ),
    scopesCheck: check(
      "oauth_agent_bindings_scopes_check",
      sql`${table.allowedScopes} IN (
        ARRAY['cortex:read']::oauth_scope[],
        ARRAY['cortex:write']::oauth_scope[],
        ARRAY['mcp']::oauth_scope[],
        ARRAY['cortex:read', 'cortex:write']::oauth_scope[],
        ARRAY['cortex:read', 'mcp']::oauth_scope[],
        ARRAY['cortex:write', 'mcp']::oauth_scope[],
        ARRAY['cortex:read', 'cortex:write', 'mcp']::oauth_scope[]
      )`
    ),
    revokedStateCheck: check(
      "oauth_agent_bindings_revoked_state_check",
      sql`(
        (${table.status} = 'active' AND ${table.revokedAt} IS NULL AND ${table.revokedReason} IS NULL)
        OR
        (${table.status} = 'revoked' AND ${table.isDefault} = false
          AND ${table.revokedAt} IS NOT NULL AND ${table.revokedReason} IS NOT NULL
          AND ${table.revokedReason} = btrim(${table.revokedReason})
          AND length(${table.revokedReason}) BETWEEN 1 AND 1024)
      )`
    ),
  })
);

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientKind: oauthClientKindEnum("client_kind").notNull(),
    redirectUris: text("redirect_uris").array().notNull(),
    clientName: text("client_name"),
    tokenEndpointAuthMethod: oauthTokenEndpointAuthMethodEnum(
      "token_endpoint_auth_method"
    ).notNull(),
    status: oauthClientStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    clientIdIdx: uniqueIndex("oauth_clients_client_id_key").on(table.clientId),
    clientIdCheck: check(
      "oauth_clients_client_id_check",
      sql`${table.clientId} = btrim(${table.clientId}) AND length(${table.clientId}) BETWEEN 1 AND 512`
    ),
    redirectUrisCheck: check(
      "oauth_clients_redirect_uris_check",
      sql`oauth_redirect_uris_are_canonical(${table.redirectUris})`
    ),
    dynamicAuthMethodCheck: check(
      "oauth_clients_dynamic_auth_method_check",
      sql`${table.clientKind} <> 'dynamic' OR ${table.tokenEndpointAuthMethod} = 'none'`
    ),
    clientNameCheck: check(
      "oauth_clients_client_name_check",
      sql`${table.clientName} IS NULL OR (
        ${table.clientName} = btrim(${table.clientName})
        AND length(${table.clientName}) BETWEEN 1 AND 200
      )`
    ),
  })
);

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey(),
    codeDigest: bytea("code_digest").notNull(),
    oauthClientId: uuid("oauth_client_id")
      .references(() => oauthClients.id)
      .notNull(),
    principalId: uuid("principal_id")
      .references(() => oauthPrincipals.id)
      .notNull(),
    bindingId: uuid("binding_id")
      .references(() => oauthAgentBindings.id)
      .notNull(),
    authenticationEpoch: integer("authentication_epoch").notNull(),
    bindingVersion: integer("binding_version").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: oauthScopeEnum("scopes").array().notNull(),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    digestIdx: uniqueIndex("oauth_authorization_codes_digest_key").on(
      table.codeDigest
    ),
    expiryIdx: index("oauth_authorization_codes_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
    clientIdx: index("oauth_authorization_codes_client_idx").on(
      table.oauthClientId
    ),
    digestCheck: check(
      "oauth_authorization_codes_digest_check",
      sql`octet_length(${table.codeDigest}) = 32`
    ),
    authenticationEpochCheck: check(
      "oauth_authorization_codes_authentication_epoch_check",
      sql`${table.authenticationEpoch} >= 0`
    ),
    bindingVersionCheck: check(
      "oauth_authorization_codes_binding_version_check",
      sql`${table.bindingVersion} >= 1`
    ),
    redirectUriCheck: check(
      "oauth_authorization_codes_redirect_uri_check",
      sql`${table.redirectUri} = btrim(${table.redirectUri}) AND length(${table.redirectUri}) BETWEEN 1 AND 2048`
    ),
    scopesCheck: check(
      "oauth_authorization_codes_scopes_check",
      sql`${table.scopes} IN (
        ARRAY['cortex:read']::oauth_scope[], ARRAY['cortex:write']::oauth_scope[],
        ARRAY['mcp']::oauth_scope[], ARRAY['cortex:read', 'cortex:write']::oauth_scope[],
        ARRAY['cortex:read', 'mcp']::oauth_scope[], ARRAY['cortex:write', 'mcp']::oauth_scope[],
        ARRAY['cortex:read', 'cortex:write', 'mcp']::oauth_scope[]
      )`
    ),
    challengeCheck: check(
      "oauth_authorization_codes_challenge_check",
      sql`${table.codeChallenge} ~ '^[A-Za-z0-9_-]{43}$'`
    ),
    resourceCheck: check(
      "oauth_authorization_codes_resource_check",
      sql`${table.resource} = btrim(${table.resource}) AND length(${table.resource}) BETWEEN 1 AND 2048`
    ),
    expiryCheck: check(
      "oauth_authorization_codes_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    consumedCheck: check(
      "oauth_authorization_codes_consumed_check",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`
    ),
    bindingPrincipalFk: foreignKey({
      name: "oauth_authorization_codes_binding_principal_fkey",
      columns: [table.bindingId, table.principalId],
      foreignColumns: [oauthAgentBindings.id, oauthAgentBindings.principalId],
    }),
  })
);

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey(),
    principalId: uuid("principal_id")
      .references(() => oauthPrincipals.id)
      .notNull(),
    bindingId: uuid("binding_id")
      .references(() => oauthAgentBindings.id)
      .notNull(),
    oauthClientId: uuid("oauth_client_id")
      .references(() => oauthClients.id)
      .notNull(),
    resource: text("resource").notNull(),
    scopes: oauthScopeEnum("scopes").array().notNull(),
    authenticationEpoch: integer("authentication_epoch").notNull(),
    bindingVersion: integer("binding_version").notNull(),
    status: oauthGrantStatusEnum("status").default("active").notNull(),
    currentRefreshGeneration: integer("current_refresh_generation")
      .default(0)
      .notNull(),
    inactivityExpiresAt: timestamp("inactivity_expires_at", {
      withTimezone: true,
    }).notNull(),
    legacyTupleDigest: bytea("legacy_tuple_digest"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    // Migration 009 owns this self-FK as DEFERRABLE INITIALLY DEFERRED.
    // Drizzle 0.45 cannot express FK deferrability, so adding .references()
    // here would describe a materially different, immediate constraint.
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    activeTupleIdx: uniqueIndex("oauth_grants_one_active_tuple_idx")
      .on(
        table.principalId,
        table.bindingId,
        table.oauthClientId,
        table.resource
      )
      .where(sql`${table.status} = 'active'`),
    legacyTupleIdx: uniqueIndex("oauth_grants_legacy_tuple_digest_idx")
      .on(table.legacyTupleDigest)
      .where(sql`${table.legacyTupleDigest} IS NOT NULL`),
    liveLookupIdx: index("oauth_grants_live_lookup_idx").on(
      table.id,
      table.status,
      table.inactivityExpiresAt
    ),
    principalStatusIdx: index("oauth_grants_principal_status_idx").on(
      table.principalId,
      table.status
    ),
    bindingStatusIdx: index("oauth_grants_binding_status_idx").on(
      table.bindingId,
      table.status
    ),
    clientStatusIdx: index("oauth_grants_client_status_idx").on(
      table.oauthClientId,
      table.status
    ),
    authenticationEpochCheck: check(
      "oauth_grants_authentication_epoch_check",
      sql`${table.authenticationEpoch} >= 0`
    ),
    bindingVersionCheck: check(
      "oauth_grants_binding_version_check",
      sql`${table.bindingVersion} >= 1`
    ),
    refreshGenerationCheck: check(
      "oauth_grants_refresh_generation_check",
      sql`${table.currentRefreshGeneration} >= 0`
    ),
    resourceCheck: check(
      "oauth_grants_resource_check",
      sql`${table.resource} = btrim(${table.resource}) AND length(${table.resource}) BETWEEN 1 AND 2048`
    ),
    scopesCheck: check(
      "oauth_grants_scopes_check",
      sql`${table.scopes} IN (
        ARRAY['cortex:read']::oauth_scope[], ARRAY['cortex:write']::oauth_scope[],
        ARRAY['mcp']::oauth_scope[], ARRAY['cortex:read', 'cortex:write']::oauth_scope[],
        ARRAY['cortex:read', 'mcp']::oauth_scope[], ARRAY['cortex:write', 'mcp']::oauth_scope[],
        ARRAY['cortex:read', 'cortex:write', 'mcp']::oauth_scope[]
      )`
    ),
    inactivityExpiryCheck: check(
      "oauth_grants_inactivity_expiry_check",
      sql`${table.inactivityExpiresAt} > ${table.createdAt}`
    ),
    legacyTupleDigestCheck: check(
      "oauth_grants_legacy_tuple_digest_check",
      sql`${table.legacyTupleDigest} IS NULL OR octet_length(${table.legacyTupleDigest}) = 32`
    ),
    refreshedAtCheck: check(
      "oauth_grants_refreshed_at_check",
      sql`${table.refreshedAt} IS NULL OR ${table.refreshedAt} >= ${table.createdAt}`
    ),
    terminalStateCheck: check(
      "oauth_grants_terminal_state_check",
      sql`(
        (${table.status} IN ('active', 'expired') AND ${table.revokedAt} IS NULL
          AND ${table.revokedReason} IS NULL AND ${table.supersededBy} IS NULL)
        OR
        (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL
          AND ${table.revokedReason} IS NOT NULL
          AND ${table.revokedReason} = btrim(${table.revokedReason})
          AND length(${table.revokedReason}) BETWEEN 1 AND 1024
          AND ${table.supersededBy} IS NULL)
        OR
        (${table.status} = 'superseded' AND ${table.supersededBy} IS NOT NULL
          AND ${table.supersededBy} <> ${table.id} AND ${table.revokedAt} IS NULL
          AND ${table.revokedReason} IS NULL)
      )`
    ),
    bindingPrincipalFk: foreignKey({
      name: "oauth_grants_binding_principal_fkey",
      columns: [table.bindingId, table.principalId],
      foreignColumns: [oauthAgentBindings.id, oauthAgentBindings.principalId],
    }),
  })
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey(),
    grantId: uuid("grant_id")
      .references(() => oauthGrants.id, { onDelete: "cascade" })
      .notNull(),
    generation: integer("generation").notNull(),
    kind: oauthRefreshKindEnum("kind").notNull(),
    jtiDigest: bytea("jti_digest").notNull(),
    reconstructionNonce: bytea("reconstruction_nonce"),
    effectiveScopes: oauthScopeEnum("effective_scopes").array().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    replacementGeneration: integer("replacement_generation"),
    retryDeadline: timestamp("retry_deadline", { withTimezone: true }),
    requestFingerprint: bytea("request_fingerprint"),
  },
  (table) => ({
    grantGenerationIdx: uniqueIndex(
      "oauth_refresh_tokens_grant_generation_key"
    ).on(table.grantId, table.generation),
    grantJtiIdx: uniqueIndex("oauth_refresh_tokens_grant_jti_key").on(
      table.grantId,
      table.jtiDigest
    ),
    expiryIdx: index("oauth_refresh_tokens_expiry_idx").on(table.expiresAt),
    generationCheck: check(
      "oauth_refresh_tokens_generation_check",
      sql`${table.generation} >= -1`
    ),
    kindGenerationCheck: check(
      "oauth_refresh_tokens_kind_generation_check",
      sql`(
        (${table.kind} = 'legacy' AND ${table.generation} = -1 AND ${table.reconstructionNonce} IS NULL)
        OR
        (${table.kind} = 'v2' AND ${table.generation} >= 0
          AND ${table.reconstructionNonce} IS NOT NULL
          AND octet_length(${table.reconstructionNonce}) = 32)
      )`
    ),
    jtiDigestCheck: check(
      "oauth_refresh_tokens_jti_digest_check",
      sql`octet_length(${table.jtiDigest}) = 32`
    ),
    scopesCheck: check(
      "oauth_refresh_tokens_scopes_check",
      sql`${table.effectiveScopes} IN (
        ARRAY['cortex:read']::oauth_scope[], ARRAY['cortex:write']::oauth_scope[],
        ARRAY['mcp']::oauth_scope[], ARRAY['cortex:read', 'cortex:write']::oauth_scope[],
        ARRAY['cortex:read', 'mcp']::oauth_scope[], ARRAY['cortex:write', 'mcp']::oauth_scope[],
        ARRAY['cortex:read', 'cortex:write', 'mcp']::oauth_scope[]
      )`
    ),
    expiryCheck: check(
      "oauth_refresh_tokens_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt}`
    ),
    consumptionCheck: check(
      "oauth_refresh_tokens_consumption_check",
      sql`(
        (${table.consumedAt} IS NULL AND ${table.replacementGeneration} IS NULL
          AND ${table.retryDeadline} IS NULL AND ${table.requestFingerprint} IS NULL)
        OR
        (${table.consumedAt} IS NOT NULL AND ${table.consumedAt} >= ${table.issuedAt}
          AND ${table.replacementGeneration} = ${table.generation} + 1
          AND ${table.retryDeadline} IS NOT NULL AND ${table.retryDeadline} >= ${table.consumedAt}
          AND ${table.requestFingerprint} IS NOT NULL
          AND octet_length(${table.requestFingerprint}) = 32)
      )`
    ),
  })
);

export const oauthLoginSessions = pgTable(
  "oauth_login_sessions",
  {
    id: uuid("id").primaryKey(),
    sessionDigest: bytea("session_digest").notNull(),
    legacyCookieDigest: bytea("legacy_cookie_digest"),
    principalId: uuid("principal_id")
      .references(() => oauthPrincipals.id, { onDelete: "cascade" })
      .notNull(),
    ipFingerprint: bytea("ip_fingerprint").notNull(),
    authenticationEpoch: integer("authentication_epoch").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    sessionDigestIdx: uniqueIndex("oauth_login_sessions_digest_key").on(
      table.sessionDigest
    ),
    legacyCookieDigestIdx: uniqueIndex(
      "oauth_login_sessions_legacy_cookie_digest_idx"
    )
      .on(table.legacyCookieDigest)
      .where(sql`${table.legacyCookieDigest} IS NOT NULL`),
    principalExpiryIdx: index("oauth_login_sessions_principal_expiry_idx")
      .on(table.principalId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
    sessionDigestCheck: check(
      "oauth_login_sessions_session_digest_check",
      sql`octet_length(${table.sessionDigest}) = 32`
    ),
    legacyDigestCheck: check(
      "oauth_login_sessions_legacy_digest_check",
      sql`${table.legacyCookieDigest} IS NULL OR octet_length(${table.legacyCookieDigest}) = 32`
    ),
    ipFingerprintCheck: check(
      "oauth_login_sessions_ip_fingerprint_check",
      sql`octet_length(${table.ipFingerprint}) = 32`
    ),
    authenticationEpochCheck: check(
      "oauth_login_sessions_authentication_epoch_check",
      sql`${table.authenticationEpoch} >= 0`
    ),
    expiryCheck: check(
      "oauth_login_sessions_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt}`
    ),
    revokedStateCheck: check(
      "oauth_login_sessions_revoked_state_check",
      sql`(
        (${table.revokedAt} IS NULL AND ${table.revokedReason} IS NULL)
        OR
        (${table.revokedAt} IS NOT NULL AND ${table.revokedAt} >= ${table.issuedAt}
          AND ${table.revokedReason} IS NOT NULL
          AND ${table.revokedReason} = btrim(${table.revokedReason})
          AND length(${table.revokedReason}) BETWEEN 1 AND 1024)
      )`
    ),
  })
);

export const oauthAuditEvents = pgTable(
  "oauth_audit_events",
  {
    id: uuid("id").primaryKey(),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    principalId: uuid("principal_id").references(() => oauthPrincipals.id, {
      onDelete: "set null",
    }),
    bindingId: uuid("binding_id").references(() => oauthAgentBindings.id, {
      onDelete: "set null",
    }),
    grantId: uuid("grant_id").references(() => oauthGrants.id, {
      onDelete: "restrict",
    }),
    oauthClientId: uuid("oauth_client_id").references(() => oauthClients.id, {
      onDelete: "set null",
    }),
    requestId: text("request_id").notNull(),
    actorType: oauthAuditActorTypeEnum("actor_type").notNull(),
    ipFingerprint: bytea("ip_fingerprint"),
    userAgentFingerprint: bytea("user_agent_fingerprint"),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("oauth_audit_events_created_at_idx").on(table.createdAt),
    principalCreatedIdx: index("oauth_audit_events_principal_created_idx").on(
      table.principalId,
      table.createdAt
    ),
    grantCreatedIdx: index("oauth_audit_events_grant_created_idx").on(
      table.grantId,
      table.createdAt
    ),
    eventTypeCheck: check(
      "oauth_audit_events_event_type_check",
      sql`${table.eventType} = btrim(${table.eventType}) AND length(${table.eventType}) BETWEEN 1 AND 128`
    ),
    outcomeCheck: check(
      "oauth_audit_events_outcome_check",
      sql`${table.outcome} = btrim(${table.outcome}) AND length(${table.outcome}) BETWEEN 1 AND 64`
    ),
    requestIdCheck: check(
      "oauth_audit_events_request_id_check",
      sql`${table.requestId} = btrim(${table.requestId}) AND length(${table.requestId}) BETWEEN 1 AND 128`
    ),
    ipFingerprintCheck: check(
      "oauth_audit_events_ip_fingerprint_check",
      sql`${table.ipFingerprint} IS NULL OR octet_length(${table.ipFingerprint}) = 32`
    ),
    userAgentFingerprintCheck: check(
      "oauth_audit_events_user_agent_fingerprint_check",
      sql`${table.userAgentFingerprint} IS NULL OR octet_length(${table.userAgentFingerprint}) = 32`
    ),
    metadataCheck: check(
      "oauth_audit_events_metadata_check",
      sql`public.oauth_audit_metadata_is_safe(${table.metadata})`
    ),
  })
);

export const oauthStateMigrations = pgTable(
  "oauth_state_migrations",
  {
    id: uuid("id").primaryKey(),
    version: text("version").notNull(),
    sourceChecksum: bytea("source_checksum").notNull(),
    outcome: oauthStateMigrationOutcomeEnum("outcome").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    report: jsonb("report").$type<Record<string, number>>().notNull(),
  },
  (table) => ({
    versionIdx: uniqueIndex("oauth_state_migrations_version_key").on(
      table.version
    ),
    versionCheck: check(
      "oauth_state_migrations_version_check",
      sql`${table.version} = btrim(${table.version}) AND length(${table.version}) BETWEEN 1 AND 128`
    ),
    checksumCheck: check(
      "oauth_state_migrations_checksum_check",
      sql`octet_length(${table.sourceChecksum}) = 32`
    ),
    timeCheck: check(
      "oauth_state_migrations_time_check",
      sql`${table.completedAt} >= ${table.startedAt}`
    ),
    reportCheck: check(
      "oauth_state_migrations_report_check",
      sql`jsonb_typeof(${table.report}) = 'object' AND octet_length(${table.report}::text) <= 4096`
    ),
  })
);

// ─── Type exports ───────────────────────────────────────
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type MemoryNode = typeof memoryNodes.$inferSelect;
export type NewMemoryNode = typeof memoryNodes.$inferInsert;
export type WorkingMemoryItem = typeof workingMemoryItems.$inferSelect;
export type NewWorkingMemoryItem = typeof workingMemoryItems.$inferInsert;
export type MemorySynapse = typeof memorySynapses.$inferSelect;
export type NewMemorySynapse = typeof memorySynapses.$inferInsert;
export type HippocampalCode = typeof hippocampalCodes.$inferSelect;
export type EmotionalValenceRow = typeof emotionalValence.$inferSelect;
export type NewEmotionalValenceRow = typeof emotionalValence.$inferInsert;
export type ProceduralMemoryRow = typeof proceduralMemories.$inferSelect;
export type NewProceduralMemoryRow = typeof proceduralMemories.$inferInsert;
export type NewHippocampalCode = typeof hippocampalCodes.$inferInsert;
export type CognitiveArtifact = typeof cognitiveArtifacts.$inferSelect;
export type NewCognitiveArtifact = typeof cognitiveArtifacts.$inferInsert;
export type DreamCycleLog = typeof dreamCycleLogs.$inferSelect;
export type NewDreamCycleLog = typeof dreamCycleLogs.$inferInsert;
export type SelfDiagnostic = typeof selfDiagnostics.$inferSelect;
export type NewSelfDiagnostic = typeof selfDiagnostics.$inferInsert;
export type AgentStateLog = typeof agentStateLogs.$inferSelect;
export type NewAgentStateLog = typeof agentStateLogs.$inferInsert;
export type PrincipalState = typeof principalState.$inferSelect;
export type NewPrincipalState = typeof principalState.$inferInsert;
export type BackgroundThread = typeof backgroundThreads.$inferSelect;
export type NewBackgroundThread = typeof backgroundThreads.$inferInsert;
export type RelationshipEntry = typeof relationshipGraph.$inferSelect;
export type NewRelationshipEntry = typeof relationshipGraph.$inferInsert;
export type OAuthScope = (typeof oauthScopeEnum.enumValues)[number];
export type OAuthPrincipalStatus =
  (typeof oauthPrincipalStatusEnum.enumValues)[number];
export type OAuthBindingStatus =
  (typeof oauthBindingStatusEnum.enumValues)[number];
export type OAuthClientStatus = (typeof oauthClientStatusEnum.enumValues)[number];
export type OAuthClientKind = (typeof oauthClientKindEnum.enumValues)[number];
export type OAuthTokenEndpointAuthMethod =
  (typeof oauthTokenEndpointAuthMethodEnum.enumValues)[number];
export type OAuthGrantStatus = (typeof oauthGrantStatusEnum.enumValues)[number];
export type OAuthRefreshKind = (typeof oauthRefreshKindEnum.enumValues)[number];
export type OAuthAuditActorType =
  (typeof oauthAuditActorTypeEnum.enumValues)[number];
export type OAuthStateMigrationOutcome =
  (typeof oauthStateMigrationOutcomeEnum.enumValues)[number];
export type OAuthPrincipal = typeof oauthPrincipals.$inferSelect;
export type OAuthPrincipalRow = OAuthPrincipal;
export type NewOAuthPrincipal = typeof oauthPrincipals.$inferInsert;
export type OAuthAgentBinding = typeof oauthAgentBindings.$inferSelect;
export type OAuthAgentBindingRow = OAuthAgentBinding;
export type NewOAuthAgentBinding = typeof oauthAgentBindings.$inferInsert;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthClientRow = OAuthClient;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
export type OAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type OAuthAuthorizationCodeRow = OAuthAuthorizationCode;
export type NewOAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferInsert;
export type OAuthGrant = typeof oauthGrants.$inferSelect;
export type OAuthGrantRow = OAuthGrant;
export type NewOAuthGrant = typeof oauthGrants.$inferInsert;
export type OAuthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type OAuthRefreshTokenRow = OAuthRefreshToken;
export type NewOAuthRefreshToken = typeof oauthRefreshTokens.$inferInsert;
export type OAuthLoginSession = typeof oauthLoginSessions.$inferSelect;
export type OAuthLoginSessionRow = OAuthLoginSession;
export type NewOAuthLoginSession = typeof oauthLoginSessions.$inferInsert;
export type OAuthAuditEvent = typeof oauthAuditEvents.$inferSelect;
export type OAuthAuditEventRow = OAuthAuditEvent;
export type NewOAuthAuditEvent = typeof oauthAuditEvents.$inferInsert;
export type OAuthStateMigration = typeof oauthStateMigrations.$inferSelect;
export type OAuthStateMigrationRow = OAuthStateMigration;
export type NewOAuthStateMigration = typeof oauthStateMigrations.$inferInsert;
