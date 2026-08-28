import type { Sql } from "postgres";
import type { db } from "../db/index.js";

export interface MemoryConfig {
  buildId: string;
  projectionVersion: string;
  retrievalVersion: string;
  ingestWorkerConcurrency: number;
  ingestMaxAttempts: number;
  embeddingTimeoutMs: number;
  retrievalCandidateLimit: number;
  retrievalTelemetryRetentionDays: number;
  synthesisEnabled: boolean;
  ca3Enabled: boolean;
}

export interface EmbeddedVector {
  values: number[];
  provider: string;
  model: string;
  dimensions: number;
  normalized: true;
}

export interface EmbeddedBatch {
  vectors: EmbeddedVector[];
  provider: string;
  model: string;
}

export interface EntityEnrichmentResult {
  entities: string[];
  warnings: string[];
}

export interface SynapseFormationOptions {
  replaySafe: boolean;
  ingestEventId?: string;
  sql?: Sql;
  currentAt?: string;
}

export interface SynapseCandidate {
  agentId: number;
  memoryA: number;
  memoryB: number;
  connectionType: "semantic" | "entity_shared" | "temporal";
  connectionStrength: number;
  decayRate: number;
}

export interface PreparedSynapseBatch {
  agentId: number;
  newNodeIds: number[];
  currentAt: string;
  candidates: SynapseCandidate[];
}

export interface SynapseDiscoveryOptions {
  sql?: Sql;
  currentAt?: string;
}

export interface SynapseInsertOptions {
  sql: Sql;
  replaySafe: boolean;
}

export interface PatternCompletionCandidate {
  memoryId: number;
  activationScore: number;
}

export type RetrievalChannel =
  | "search"
  | "recall"
  | "init"
  | "hook"
  | "gateway"
  | "evaluation";

export type RetrievalLane =
  | "working"
  | "lexical"
  | "vector"
  | "entity"
  | "graph"
  | "artifact";

export type RetrievalItemKind = "memory" | "working_item" | "artifact";

export interface RetrieveInput {
  agentId: number;
  query: string;
  channel: RetrievalChannel;
  requestId?: string | null;
  sessionId?: string | null;
  limit: number;
  tokenBudget?: number;
  enableCA3?: boolean;
}

export interface ComponentRank {
  lane: RetrievalLane;
  rank: number;
  sourceScore?: number;
}

interface LaneCandidateBase {
  lane: RetrievalLane;
  sourceRank: number;
  sourceScore?: number;
  content: string;
}

export type LaneCandidate = LaneCandidateBase &
  (
    | {
        kind: "memory";
        memoryId: number;
        workingItemId?: never;
        artifactId?: never;
      }
    | {
        kind: "working_item";
        memoryId?: never;
        workingItemId: string;
        artifactId?: never;
      }
    | {
        kind: "artifact";
        memoryId?: never;
        workingItemId?: never;
        artifactId: number;
      }
  );

interface FusedCandidateBase {
  content: string;
  fusedScore: number;
  componentRanks: ComponentRank[];
}

export type FusedCandidate = FusedCandidateBase &
  (
    | {
        kind: "memory";
        memoryId: number;
        workingItemId?: never;
        artifactId?: never;
      }
    | {
        kind: "working_item";
        memoryId?: never;
        workingItemId: string;
        artifactId?: never;
      }
    | {
        kind: "artifact";
        memoryId?: never;
        workingItemId?: never;
        artifactId: number;
      }
  );

export interface RetrievalProvenance {
  eventId: string;
  source: string | null;
  sourceType: string;
  relation:
    | "captured_from"
    | "corrects"
    | "derived_from"
    | "consolidates";
  confidence: number | null;
  acceptedAt: string;
}

export interface LegacySearchScoreBreakdown {
  cosine: number;
  textMatch: number;
  recency: number;
  resonance: number;
  priorityBoost: number;
  emotionalBoost: number;
  ca3Activation: number;
}

export interface RetrievedMemoryCompatibility {
  sourceType: string | null;
  entities: string[] | null;
  semanticTags: string[] | null;
  createdAt: string;
  lastRecalledAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  supersededBy: number | null;
  hybridScore: number;
  scoreBreakdown: LegacySearchScoreBreakdown;
}

interface RetrievedItemBase {
  retrievalItemId: string;
  content: string;
  source: string | null;
  priority: number | null;
  currentness: number;
  score: number;
  finalRank: number;
  componentRanks: ComponentRank[];
  reasons: string[];
  provenance: RetrievalProvenance[];
  provenanceTruncated: boolean;
}

export type RetrievedItem = RetrievedItemBase &
  (
    | {
        kind: "memory";
        memoryId: number;
        resonance: number | null;
        compatibility: RetrievedMemoryCompatibility;
        workingItemId?: never;
        artifactId?: never;
        artifactType?: never;
        artifactContent?: never;
      }
    | {
        kind: "working_item";
        memoryId?: never;
        resonance?: never;
        compatibility?: never;
        workingItemId: string;
        artifactId?: never;
        artifactType?: never;
        artifactContent?: never;
      }
    | {
        kind: "artifact";
        memoryId?: never;
        resonance?: never;
        compatibility?: never;
        workingItemId?: never;
        artifactId: number;
        artifactType: string;
        artifactContent: unknown;
      }
  );

export interface PreparedRetrieval {
  retrievalId: string;
  algorithmVersion: string;
  buildId: string;
  candidates: RetrievedItem[];
  elapsedMs: number;
  warnings: string[];
}

export interface RetrievalResponse {
  retrievalId: string;
  algorithmVersion: string;
  buildId: string;
  results: RetrievedItem[];
  candidateCount: number;
  returnedCount: number;
  elapsedMs: number;
  warnings: string[];
}

export type WorkingItemKind =
  | "current_task"
  | "open_loop"
  | "constraint"
  | "correction"
  | "preference";
export type WorkingItemStatus = "active" | "resolved" | "expired";

export interface WorkingItem {
  id: string;
  agentId: number;
  callerKey: string;
  kind: WorkingItemKind;
  content: string;
  importance: number;
  displayOrder: number;
  status: WorkingItemStatus;
  sourceMemoryId?: number | null;
  sourceEventId?: string | null;
  lastConfirmedAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  resolutionReason?: string | null;
}

export interface WorkingItemUpsertBase {
  agentId: number;
  callerKey: string;
  content: string;
  importance?: number;
  displayOrder?: number;
  expiresAt?: string;
  sourceEventId?: string | null;
}

export type UpsertWorkingItemInput =
  | (WorkingItemUpsertBase & {
      kind: "correction";
      sourceMemoryId: number;
    })
  | (WorkingItemUpsertBase & {
      kind: Exclude<WorkingItemKind, "correction">;
      sourceMemoryId?: number | null;
    });

export interface JournalWorkingUpdate {
  activeThreads: readonly string[];
  concerns: readonly string[];
  resolvedCallerKeys?: readonly string[];
  sessionId?: string | null;
}

export interface WorkingSetService {
  list(agentId: number, limit?: number): Promise<WorkingItem[]>;
  upsert(input: UpsertWorkingItemInput): Promise<WorkingItem>;
  resolve(agentId: number, id: string, reason: string): Promise<WorkingItem | null>;
  expire(agentId: number, id: string, reason: string): Promise<WorkingItem | null>;
  reconfirm(
    agentId: number,
    id: string,
    expiresAt?: string
  ): Promise<WorkingItem | null>;
  reconcileJournal(
    agentId: number,
    update: JournalWorkingUpdate
  ): Promise<WorkingItem[]>;
}

export class WorkingSetValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkingSetValidationError";
  }
}

export interface InitMemoryContext {
  workingItems: WorkingItem[];
  retrieval: RetrievalResponse;
  context: string;
  tokensUsed: number;
  workingTokensUsed: number;
  retrievalTokensUsed: number;
}

export interface RetrievalService {
  prepare(input: RetrieveInput): Promise<PreparedRetrieval>;
  deliver(
    prepared: PreparedRetrieval,
    selected: readonly RetrievedItem[]
  ): Promise<RetrievalResponse>;
  search(input: RetrieveInput): Promise<RetrievalResponse>;
  init(
    agentId: number,
    sessionId?: string,
    queryHint?: string
  ): Promise<InitMemoryContext>;
}

export interface RankFusionOptions {
  k: 60;
  weights: Readonly<Record<RetrievalLane, number>>;
}

export type IngestStatus =
  | "accepted"
  | "processing"
  | "indexed"
  | "failed"
  | "rejected";
export type ProjectionMode = "append" | "replace_source" | "reconsolidate";

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_key_reused" as const;
  readonly resourceType = "ingest" as const;

  constructor(readonly existingId: string) {
    super("The idempotency key was already used for a different ingest request");
    this.name = "IdempotencyConflictError";
  }
}

export class IngestValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

export interface ExternalProvenanceReceipt {
  kind: "authorized_transfer";
  transferReceiptId: string;
  originContentHash: string;
}

export interface DerivedProvenanceInput {
  relation: "derived_from" | "consolidates";
  sourceMemoryIds: readonly [number, ...number[]];
  confidence: number;
  expiresAt: string;
}

export interface AcceptIngestInput {
  agentId: number;
  content: string;
  idempotencyKey?: string;
  source?: string | null;
  sourceVersion?: string | null;
  sourceType: string;
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  requestedPriority: 0 | 1 | 2 | 3 | 4;
  providedEntities?: readonly string[];
  providedSemanticTags?: readonly string[];
  requestId?: string | null;
  sessionId?: string | null;
  projectionMode?: ProjectionMode;
  predecessorMemoryId?: number | null;
  forceNewProjection?: boolean;
  externalProvenance?: ExternalProvenanceReceipt | null;
  derivedProvenance?: DerivedProvenanceInput | null;
}

export interface IngestReceipt {
  eventId: string;
  status: IngestStatus;
  replayed: boolean;
  nodeIds: number[];
  effectivePriorities: number[];
  chunksStored: number;
  /** Projections inserted by this event; reused projections are excluded. */
  chunksCreated: number;
  synapsesFormed: number;
  totalAttempts: number;
  manualRetryCount: number;
  possibleUpdateOf: number[];
  acceptedAt: string;
  startedAt?: string;
  indexedAt?: string;
  nextAttemptAt?: string;
  failure?: { code: string; retryable: boolean };
  warnings: string[];
}

export interface ClaimedIngestEvent {
  eventId: string;
  agentId: number;
  attempt: number;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  projectionAlreadyCommitted: boolean;
}

export interface IngestService {
  accept(input: AcceptIngestInput): Promise<IngestReceipt>;
  get(agentId: number, eventId: string): Promise<IngestReceipt | null>;
  wait(agentId: number, eventId: string, timeoutMs: number): Promise<IngestReceipt>;
  retryTerminalFailure(agentId: number, eventId: string): Promise<IngestReceipt | null>;
  deriveLegacyKey(input: Omit<AcceptIngestInput, "idempotencyKey">): string;
}

export interface IngestWorker {
  claim(workerId: string): Promise<ClaimedIngestEvent | null>;
  process(claim: ClaimedIngestEvent): Promise<IngestReceipt>;
  run(signal: AbortSignal): Promise<void>;
}

export type OperationName = "ingest_worker" | "reflection";
export type OperationStatus = "running" | "succeeded" | "failed" | "stopped";

export interface OperationCompletion {
  counters?: Record<string, number>;
  errorCode?: string;
}

export interface OperationRunHandle {
  id: string;
  operation: OperationName;
  agentId?: number;
  buildId: string;
}

export interface MemoryHealthService {
  startOperation(
    operation: OperationName,
    agentId?: number
  ): Promise<OperationRunHandle>;
  heartbeat(
    handle: OperationRunHandle,
    counters?: Record<string, number>
  ): Promise<void>;
  finishOperation(
    handle: OperationRunHandle,
    status: Exclude<OperationStatus, "running">,
    details?: OperationCompletion
  ): Promise<void>;
  readiness(): Promise<{
    ready: boolean;
    buildId: string;
    reasons: string[];
  }>;
}

// Slice 2 extends the Slice 1 dependency boundary only with dependencies used
// by the now-runnable durable acceptance and projection path.
export interface MemoryServiceDependencies {
  db: typeof db;
  sql: Sql;
  config: MemoryConfig;
  now(): Date;
  newId(): string;
  embedTexts(input: readonly string[]): Promise<EmbeddedBatch>;
  embedQuery(input: string): Promise<EmbeddedVector>;
  enrichEntities(input: string): Promise<EntityEnrichmentResult>;
  formSynapses(
    agentId: number,
    memoryIds: readonly number[],
    options: SynapseFormationOptions
  ): Promise<number>;
  discoverSynapses(
    agentId: number,
    memoryIds: readonly number[],
    options: SynapseDiscoveryOptions
  ): Promise<PreparedSynapseBatch>;
  insertSynapses(
    prepared: PreparedSynapseBatch,
    options: SynapseInsertOptions
  ): Promise<number>;
  patternComplete(
    agentId: number,
    embedding: readonly number[],
    limit: number,
    currentAt?: string
  ): Promise<readonly PatternCompletionCandidate[]>;
}

// Later slices add feedback and evaluation services when each becomes usable
// end to end.
export interface MemoryServices {
  ingest: IngestService;
  retrieval: RetrievalService;
  workingSet: WorkingSetService;
  health: MemoryHealthService;
}
