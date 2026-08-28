import { randomUUID } from "node:crypto";
import { db, sqlClient } from "../db/index.js";
import {
  embedQueryWithMetadata,
  embedTextsWithMetadata,
} from "../ingestion/embeddings.js";
import { extractEntitiesWithDiagnostics } from "../ingestion/entities.js";
import {
  discoverSynapseCandidates,
  formSynapses,
  insertSynapseCandidates,
} from "../ingestion/synapse-formation.js";
import { patternComplete } from "../hippocampus/index.js";
import { loadMemoryConfig } from "./config.js";
import { createMemoryHealthService } from "./health.js";
import { createIngestService } from "./ingest.js";
import { createRetrievalService } from "./retrieval.js";
import { createWorkingSetService } from "./working-set.js";
import type {
  MemoryServiceDependencies,
  MemoryServices,
  PatternCompletionCandidate,
  PreparedSynapseBatch,
  SynapseDiscoveryOptions,
  SynapseFormationOptions,
  SynapseInsertOptions,
} from "./types.js";

export function createMemoryServiceDependencies(
  overrides: Partial<MemoryServiceDependencies> = {}
): MemoryServiceDependencies {
  return Object.freeze({
    db: overrides.db ?? db,
    sql: overrides.sql ?? sqlClient,
    config: overrides.config ?? loadMemoryConfig(),
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? randomUUID,
    embedTexts: overrides.embedTexts ?? embedTextsWithMetadata,
    embedQuery: overrides.embedQuery ?? embedQueryWithMetadata,
    enrichEntities:
      overrides.enrichEntities ?? extractEntitiesWithDiagnostics,
    formSynapses:
      overrides.formSynapses ??
      (async (
        agentId: number,
        memoryIds: readonly number[],
        options: SynapseFormationOptions
      ) =>
        formSynapses(agentId, memoryIds, options)),
    discoverSynapses:
      overrides.discoverSynapses ??
      ((
        agentId: number,
        memoryIds: readonly number[],
        options: SynapseDiscoveryOptions
      ) =>
        discoverSynapseCandidates(agentId, memoryIds, options)),
    insertSynapses:
      overrides.insertSynapses ??
      ((
        prepared: PreparedSynapseBatch,
        options: SynapseInsertOptions
      ) =>
        insertSynapseCandidates(prepared, options)),
    patternComplete:
      overrides.patternComplete ??
      (async (
        agentId: number,
        embedding: readonly number[],
        limit: number,
        currentAt?: string
      ): Promise<readonly PatternCompletionCandidate[]> =>
        patternComplete(agentId, [...embedding], limit, currentAt)),
  });
}

export function createMemoryServices(
  overrides: Partial<MemoryServiceDependencies> = {}
): MemoryServices {
  const dependencies = createMemoryServiceDependencies(overrides);

  return Object.freeze({
    ingest: createIngestService(dependencies),
    retrieval: createRetrievalService(dependencies),
    workingSet: createWorkingSetService(dependencies),
    health: createMemoryHealthService(dependencies),
  });
}

export { loadMemoryConfig } from "./config.js";
export type {
  MemoryConfig,
  EmbeddedBatch,
  EmbeddedVector,
  EntityEnrichmentResult,
  PreparedSynapseBatch,
  SynapseCandidate,
  SynapseDiscoveryOptions,
  SynapseInsertOptions,
  AcceptIngestInput,
  ClaimedIngestEvent,
  IngestReceipt,
  IngestService,
  IngestStatus,
  IngestWorker,
  MemoryHealthService,
  MemoryServiceDependencies,
  MemoryServices,
  OperationCompletion,
  OperationName,
  OperationRunHandle,
  OperationStatus,
  ProjectionMode,
  ComponentRank,
  FusedCandidate,
  LaneCandidate,
  LegacySearchScoreBreakdown,
  PreparedRetrieval,
  RankFusionOptions,
  RetrieveInput,
  RetrievedItem,
  RetrievedMemoryCompatibility,
  RetrievalChannel,
  RetrievalItemKind,
  RetrievalLane,
  RetrievalProvenance,
  RetrievalResponse,
  RetrievalService,
  WorkingItem,
  WorkingItemKind,
  WorkingItemStatus,
  WorkingItemUpsertBase,
  UpsertWorkingItemInput,
  JournalWorkingUpdate,
  WorkingSetService,
} from "./types.js";

export {
  createRetrievalService,
  fuseCandidateRanks,
  isValidRetrievalQuery,
  MAX_RETRIEVAL_QUERY_BYTES,
  SEARCH_RANK_FUSION_OPTIONS,
} from "./retrieval.js";

export {
  createWorkingSetService,
  DEFAULT_WORKING_EXPIRY_DAYS,
  journalCallerKey,
  MAX_ACTIVE_WORKING_ITEMS,
  MAX_BOOT_WORKING_ITEMS,
  MAX_WORKING_EXPIRY_DAYS,
  normalizeJournalText,
  reconcileJournalInTransaction,
} from "./working-set.js";
