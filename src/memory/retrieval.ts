import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { countTokens } from "../ingestion/chunker.js";
import {
  extractEntitiesSync,
  extractSemanticTags,
} from "../ingestion/entities.js";
import type {
  ComponentRank,
  FusedCandidate,
  LaneCandidate,
  MemoryServiceDependencies,
  PreparedRetrieval,
  RankFusionOptions,
  RetrieveInput,
  RetrievedItem,
  RetrievalLane,
  RetrievalProvenance,
  RetrievalResponse,
  RetrievalService,
  WorkingItem,
  WorkingItemKind,
} from "./types.js";
import {
  createWorkingSetService,
  MAX_ACTIVE_WORKING_ITEMS,
  MAX_BOOT_WORKING_ITEMS,
} from "./working-set.js";

const MEMORY_SEARCH_LANES = ["lexical", "vector", "entity", "graph"] as const;
const SEARCH_LANES = ["working", ...MEMORY_SEARCH_LANES] as const;
const FUSION_LANE_ORDER: readonly RetrievalLane[] = [
  "working",
  "lexical",
  "vector",
  "entity",
  "graph",
  "artifact",
];
const PRIORITY_FACTORS = new Map<number, number>([
  [0, 1.05],
  [1, 1.04],
  [2, 1.025],
  [3, 1.01],
  [4, 1],
]);
const MAX_PRIORITY_FACTOR = 1.05;
const MAX_RESULT_LIMIT = 50;
const MAX_CORRELATION_LENGTH = 128;
export const MAX_RETRIEVAL_QUERY_BYTES = 8192;
const PROVENANCE_LIMIT = 5;
const MAX_ELAPSED_MS = 2_147_483_647;
const INIT_WORKING_TOKEN_BUDGET = 800;
const INIT_RETRIEVAL_TOKEN_BUDGET = 800;
const INIT_TOTAL_TOKEN_BUDGET =
  INIT_WORKING_TOKEN_BUDGET + INIT_RETRIEVAL_TOKEN_BUDGET;
const INIT_EMPTY_QUERY = "cortex init without current context";

export const SEARCH_RANK_FUSION_OPTIONS: RankFusionOptions = Object.freeze({
  k: 60,
  weights: Object.freeze({
    working: 1.2,
    lexical: 1,
    vector: 1,
    entity: 0.8,
    graph: 0.5,
    artifact: 0,
  }),
});

const MAX_MEMORY_SEARCH_RRF = MEMORY_SEARCH_LANES.reduce(
  (total, lane) =>
    total +
    SEARCH_RANK_FUSION_OPTIONS.weights[lane] /
      (SEARCH_RANK_FUSION_OPTIONS.k + 1),
  0
);
const MAX_WORKING_SEARCH_RRF =
  SEARCH_RANK_FUSION_OPTIONS.weights.working /
  (SEARCH_RANK_FUSION_OPTIONS.k + 1);

interface LaneRow {
  id: number | string;
  content: string;
  source_score: number | string;
}

interface HydratedMemoryRow {
  id: number | string;
  content: string;
  source: string | null;
  source_type: string | null;
  priority: number | string | null;
  resonance_score: number | string | null;
  entities: string[] | null;
  semantic_tags: string[] | null;
  created_at: string | Date;
  last_recalled_at: string | Date | null;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  superseded_by: number | string | null;
}

interface HydratedWorkingRow {
  id: string;
  content: string;
  kind: WorkingItemKind;
  importance: number | string;
  display_order: number | string;
  last_confirmed_at: string | Date;
  expires_at: string | Date;
  source_memory_id: number | string | null;
  source_event_id: string | null;
}

interface ProvenanceRow {
  memory_id: number | string;
  event_id: string;
  source: string | null;
  source_type: string;
  relation: string;
  accepted_at: string | Date;
}

interface RetrievalHeaderRow {
  agent_id: number | string;
  algorithm_version: string;
  build_id: string;
  candidate_count: number | string;
  returned_count: number | string;
  latency_ms: number | string | null;
  status: string;
  created_at: string | Date;
}

interface DeliveryCandidateRow {
  retrieval_item_id: string;
  memory_id: number | string | null;
  working_item_id: string | null;
  content_hash: string;
  content: string;
  final_rank: number | string;
}

interface ReturnedCandidateRow {
  id: string;
  memory_id: number | string | null;
  working_item_id: string | null;
  content_hash: string;
  final_rank: number | string;
}

interface MarkedCandidateRow {
  id: string;
  memory_id: number | string | null;
  working_item_id: string | null;
}

interface DeliveryReplayRecord {
  selectedIds: readonly string[];
  returnedIds: readonly string[];
  selectedFingerprints: ReadonlyMap<string, string>;
  elapsedMs: number;
  warnings: readonly string[];
}

interface PreparedRetrievalSnapshot {
  retrievalId: string;
  algorithmVersion: string;
  buildId: string;
  candidates: readonly RetrievedItem[];
  elapsedMs: number;
  warnings: readonly string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function retrievedItemFingerprint(item: RetrievedItem): string {
  return sha256(JSON.stringify(item));
}

function cloneRetrievedItem(item: RetrievedItem): RetrievedItem {
  return structuredClone(item);
}

function assertPreparedRetrievalUnchanged(
  prepared: PreparedRetrieval,
  snapshot: PreparedRetrievalSnapshot
): void {
  if (
    prepared.retrievalId !== snapshot.retrievalId ||
    prepared.algorithmVersion !== snapshot.algorithmVersion ||
    prepared.buildId !== snapshot.buildId ||
    prepared.elapsedMs !== snapshot.elapsedMs ||
    prepared.warnings.length !== snapshot.warnings.length ||
    prepared.warnings.some(
      (warning, index) => warning !== snapshot.warnings[index]
    ) ||
    prepared.candidates.length !== snapshot.candidates.length ||
    prepared.candidates.some(
      (candidate, index) =>
        retrievedItemFingerprint(candidate) !==
        retrievedItemFingerprint(snapshot.candidates[index])
    )
  ) {
    throw new TypeError("Prepared retrieval was mutated before delivery");
  }
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.min(
    Math.max(Math.round(performance.now() - startedAt), 0),
    MAX_ELAPSED_MS
  );
}

function dependencyInstant(deps: MemoryServiceDependencies): string {
  const instant = deps.now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TypeError("Retrieval clock must return a valid instant");
  }
  return instant.toISOString();
}

function failureInstant(deps: MemoryServiceDependencies): string {
  try {
    return dependencyInstant(deps);
  } catch {
    return new Date().toISOString();
  }
}

function candidateIdentity(candidate: LaneCandidate | FusedCandidate): string {
  if (candidate.kind === "memory") return `memory:${candidate.memoryId}`;
  if (candidate.kind === "working_item") {
    return `working_item:${candidate.workingItemId}`;
  }
  return `artifact:${candidate.artifactId}`;
}

function compareCandidateIdentity(
  left: LaneCandidate | FusedCandidate,
  right: LaneCandidate | FusedCandidate
): number {
  const kindOrder: Record<typeof left.kind, number> = {
    memory: 0,
    working_item: 1,
    artifact: 2,
  };
  const kindDifference = kindOrder[left.kind] - kindOrder[right.kind];
  if (kindDifference !== 0) return kindDifference;
  if (left.kind === "memory" && right.kind === "memory") {
    return left.memoryId - right.memoryId;
  }
  if (left.kind === "artifact" && right.kind === "artifact") {
    return left.artifactId - right.artifactId;
  }
  if (left.kind === "working_item" && right.kind === "working_item") {
    return left.workingItemId < right.workingItemId
      ? -1
      : left.workingItemId > right.workingItemId
        ? 1
        : 0;
  }
  return 0;
}

export function isValidRetrievalQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_RETRIEVAL_QUERY_BYTES &&
    !value.includes("\u0000")
  );
}

function copyFusedIdentity(
  candidate: LaneCandidate,
  fusedScore: number,
  componentRanks: ComponentRank[]
): FusedCandidate {
  const base = {
    content: candidate.content,
    fusedScore,
    componentRanks,
  };
  if (candidate.kind === "memory") {
    return { ...base, kind: "memory", memoryId: candidate.memoryId };
  }
  if (candidate.kind === "working_item") {
    return {
      ...base,
      kind: "working_item",
      workingItemId: candidate.workingItemId,
    };
  }
  return { ...base, kind: "artifact", artifactId: candidate.artifactId };
}

/**
 * Pure reciprocal-rank fusion. Source scores are retained for diagnostics but
 * never enter the fused value, so changing a provider's score scale cannot
 * change a result while that provider's ordering stays the same.
 */
export function fuseCandidateRanks(
  lanes: ReadonlyMap<RetrievalLane, readonly LaneCandidate[]>,
  options: RankFusionOptions = SEARCH_RANK_FUSION_OPTIONS
): FusedCandidate[] {
  if (options.k !== 60) {
    throw new TypeError("Cortex retrieval requires reciprocal-rank k=60");
  }

  type Accumulator = {
    representative: LaneCandidate;
    fusedScore: number;
    componentRanks: ComponentRank[];
  };
  const accumulated = new Map<string, Accumulator>();

  for (const lane of FUSION_LANE_ORDER) {
    const weight = options.weights[lane];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new TypeError(`Invalid reciprocal-rank weight for ${lane}`);
    }
    if (weight === 0) continue;

    const laneCandidates = [...(lanes.get(lane) ?? [])].sort((left, right) => {
      const rankDifference = left.sourceRank - right.sourceRank;
      if (rankDifference !== 0) return rankDifference;
      return compareCandidateIdentity(left, right);
    });
    const seenInLane = new Set<string>();

    for (const candidate of laneCandidates) {
      if (candidate.lane !== lane) {
        throw new TypeError(`Candidate lane mismatch for ${lane}`);
      }
      if (!Number.isSafeInteger(candidate.sourceRank) || candidate.sourceRank < 1) {
        throw new TypeError("Candidate source rank must be a positive integer");
      }
      const identity = candidateIdentity(candidate);
      if (seenInLane.has(identity)) continue;
      seenInLane.add(identity);

      const component: ComponentRank = {
        lane,
        rank: candidate.sourceRank,
        ...(candidate.sourceScore !== undefined &&
        Number.isFinite(candidate.sourceScore)
          ? { sourceScore: candidate.sourceScore }
          : {}),
      };
      const contribution = weight / (options.k + candidate.sourceRank);
      const existing = accumulated.get(identity);
      if (existing) {
        existing.fusedScore += contribution;
        existing.componentRanks.push(component);
      } else {
        accumulated.set(identity, {
          representative: candidate,
          fusedScore: contribution,
          componentRanks: [component],
        });
      }
    }
  }

  return [...accumulated.values()]
    .map(({ representative, fusedScore, componentRanks }) =>
      copyFusedIdentity(representative, fusedScore, componentRanks)
    )
    .sort((left, right) => {
      const scoreDifference = right.fusedScore - left.fusedScore;
      if (scoreDifference !== 0) return scoreDifference;
      return compareCandidateIdentity(left, right);
    });
}

function validateInput(input: RetrieveInput): void {
  if (!Number.isSafeInteger(input.agentId) || input.agentId <= 0) {
    throw new TypeError("agentId must be a positive integer");
  }
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new TypeError("query must not be blank");
  }
  if (!isValidRetrievalQuery(input.query)) {
    throw new TypeError("query must be at most 8192 UTF-8 bytes");
  }
  if (
    input.channel !== "search" &&
    input.channel !== "recall" &&
    input.channel !== "init"
  ) {
    throw new TypeError(
      "Only search, candidate-only legacy recall, and init are available"
    );
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_RESULT_LIMIT
  ) {
    throw new TypeError("limit must be an integer from 1 to 50");
  }
  for (const [field, value] of [
    ["requestId", input.requestId],
    ["sessionId", input.sessionId],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" ||
        value !== value.trim() ||
        Buffer.byteLength(value, "utf8") < 1 ||
        Buffer.byteLength(value, "utf8") > MAX_CORRELATION_LENGTH ||
        value.includes("\u0000"))
    ) {
      throw new TypeError(
        `${field} must be 1 to 128 trimmed UTF-8 bytes and contain no NUL`
      );
    }
  }
  if (input.enableCA3 !== undefined && typeof input.enableCA3 !== "boolean") {
    throw new TypeError("enableCA3 must be a boolean");
  }
  if (
    input.tokenBudget !== undefined &&
    (input.channel !== "init" ||
      input.tokenBudget !== INIT_RETRIEVAL_TOKEN_BUDGET)
  ) {
    throw new TypeError("tokenBudget is fixed at 800 for init retrieval");
  }
}

function rowsToLane(
  lane: "lexical" | "vector" | "entity",
  rows: readonly LaneRow[]
): LaneCandidate[] {
  return rows.map((row, index) => ({
    kind: "memory",
    memoryId: Number(row.id),
    lane,
    sourceRank: index + 1,
    sourceScore: Number(row.source_score),
    content: row.content,
  }));
}

async function workingLane(
  deps: MemoryServiceDependencies,
  agentId: number,
  asOf: string,
  limit: number
): Promise<LaneCandidate[]> {
  const rows = (await deps.sql`
    SELECT
      item.id::text AS id,
      item.content,
      item.importance::double precision AS source_score
    FROM public.working_memory_items AS item
    WHERE item.agent_id = ${agentId}
      AND item.status = 'active'
      AND item.expires_at > ${asOf}::timestamptz
      AND (
        item.source_memory_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_nodes AS source_node
          WHERE source_node.id = item.source_memory_id
            AND source_node.agent_id = item.agent_id
            AND source_node.status = 'active'
            AND (
              source_node.valid_from IS NULL
              OR source_node.valid_from <= ${asOf}::timestamptz
            )
            AND (
              source_node.valid_until IS NULL
              OR source_node.valid_until > ${asOf}::timestamptz
            )
            AND (
              source_node.derivation_expires_at IS NULL
              OR source_node.derivation_expires_at > ${asOf}::timestamptz
            )
            AND (
              item.kind <> 'correction'
              OR (
                source_node.ingest_event_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM public.memory_provenance AS source_provenance
                  JOIN public.memory_ingest_events AS source_event
                    ON source_event.id = source_provenance.ingest_event_id
                   AND source_event.agent_id = source_provenance.agent_id
                  WHERE source_provenance.agent_id = item.agent_id
                    AND source_provenance.memory_id = source_node.id
                    AND source_provenance.relation = 'captured_from'
                    AND source_event.status = 'indexed'
                    AND (
                      source_event.snapshot_valid_until IS NULL
                      OR source_event.snapshot_valid_until > ${asOf}::timestamptz
                    )
                )
              )
            )
        )
      )
      AND (
        item.source_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_ingest_events AS item_event
          WHERE item_event.id = item.source_event_id
            AND item_event.agent_id = item.agent_id
            AND item_event.status = 'indexed'
            AND (
              item_event.snapshot_valid_until IS NULL
              OR item_event.snapshot_valid_until > ${asOf}::timestamptz
            )
        )
      )
    ORDER BY
      item.display_order ASC,
      item.importance DESC,
      item.last_confirmed_at DESC,
      item.id ASC
    LIMIT ${limit}
  `) as unknown as LaneRow[];
  return rows.map((row, index) => ({
    kind: "working_item",
    workingItemId: String(row.id),
    lane: "working",
    sourceRank: index + 1,
    sourceScore: Number(row.source_score),
    content: row.content,
  }));
}

async function lexicalLane(
  deps: MemoryServiceDependencies,
  agentId: number,
  query: string,
  asOf: string,
  limit: number
): Promise<LaneCandidate[]> {
  const rows = (await deps.sql`
    WITH lexical_query AS (
      SELECT pg_catalog.websearch_to_tsquery(
        'english'::pg_catalog.regconfig,
        ${query}
      ) AS query
    )
    SELECT
      node.id,
      node.content,
      pg_catalog.ts_rank_cd(node.search_document, lexical_query.query)::double precision
        AS source_score
    FROM public.memory_nodes AS node
    CROSS JOIN lexical_query
    WHERE node.agent_id = ${agentId}
      AND node.status = 'active'
      AND (node.valid_from IS NULL OR node.valid_from <= ${asOf}::timestamptz)
      AND (node.valid_until IS NULL OR node.valid_until > ${asOf}::timestamptz)
      AND (
        node.derivation_expires_at IS NULL
        OR node.derivation_expires_at > ${asOf}::timestamptz
      )
      AND (
        node.ingest_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_provenance AS support
          JOIN public.memory_ingest_events AS support_event
            ON support_event.id = support.ingest_event_id
           AND support_event.agent_id = support.agent_id
          WHERE support.agent_id = ${agentId}
            AND support.memory_id = node.id
            AND support.relation = 'captured_from'
            AND support_event.status = 'indexed'
            AND (
              support_event.snapshot_valid_until IS NULL
              OR support_event.snapshot_valid_until > ${asOf}::timestamptz
            )
        )
      )
      AND node.search_document @@ lexical_query.query
    ORDER BY source_score DESC, node.id ASC
    LIMIT ${limit}
  `) as unknown as LaneRow[];
  return rowsToLane("lexical", rows);
}

async function vectorLane(
  deps: MemoryServiceDependencies,
  agentId: number,
  embedding: readonly number[],
  asOf: string,
  limit: number
): Promise<LaneCandidate[]> {
  const vector = `[${embedding.join(",")}]`;
  const rows = (await deps.sql`
    SELECT
      node.id,
      node.content,
      (1 - (node.embedding <=> ${vector}::vector))::double precision AS source_score
    FROM public.memory_nodes AS node
    WHERE node.agent_id = ${agentId}
      AND node.status = 'active'
      AND node.embedding IS NOT NULL
      AND (node.valid_from IS NULL OR node.valid_from <= ${asOf}::timestamptz)
      AND (node.valid_until IS NULL OR node.valid_until > ${asOf}::timestamptz)
      AND (
        node.derivation_expires_at IS NULL
        OR node.derivation_expires_at > ${asOf}::timestamptz
      )
      AND (
        node.ingest_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_provenance AS support
          JOIN public.memory_ingest_events AS support_event
            ON support_event.id = support.ingest_event_id
           AND support_event.agent_id = support.agent_id
          WHERE support.agent_id = ${agentId}
            AND support.memory_id = node.id
            AND support.relation = 'captured_from'
            AND support_event.status = 'indexed'
            AND (
              support_event.snapshot_valid_until IS NULL
              OR support_event.snapshot_valid_until > ${asOf}::timestamptz
            )
        )
      )
    ORDER BY node.embedding <=> ${vector}::vector ASC, node.id ASC
    LIMIT ${limit}
  `) as unknown as LaneRow[];
  return rowsToLane("vector", rows);
}

async function entityLane(
  deps: MemoryServiceDependencies,
  agentId: number,
  terms: readonly string[],
  asOf: string,
  limit: number
): Promise<LaneCandidate[]> {
  if (terms.length === 0) return [];
  const rows = (await deps.sql`
    SELECT
      node.id,
      node.content,
      matches.source_score::double precision AS source_score
    FROM public.memory_nodes AS node
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(DISTINCT pg_catalog.lower(stored.term)) AS source_score
      FROM pg_catalog.unnest(
        COALESCE(node.entities, '{}'::text[])
        || COALESCE(node.semantic_tags, '{}'::text[])
      ) AS stored(term)
      JOIN pg_catalog.unnest(${deps.sql.array([...terms])}::text[]) AS wanted(term)
        ON pg_catalog.lower(wanted.term) = pg_catalog.lower(stored.term)
    ) AS matches
    WHERE node.agent_id = ${agentId}
      AND node.status = 'active'
      AND matches.source_score > 0
      AND (node.valid_from IS NULL OR node.valid_from <= ${asOf}::timestamptz)
      AND (node.valid_until IS NULL OR node.valid_until > ${asOf}::timestamptz)
      AND (
        node.derivation_expires_at IS NULL
        OR node.derivation_expires_at > ${asOf}::timestamptz
      )
      AND (
        node.ingest_event_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.memory_provenance AS support
          JOIN public.memory_ingest_events AS support_event
            ON support_event.id = support.ingest_event_id
           AND support_event.agent_id = support.agent_id
          WHERE support.agent_id = ${agentId}
            AND support.memory_id = node.id
            AND support.relation = 'captured_from'
            AND support_event.status = 'indexed'
            AND (
              support_event.snapshot_valid_until IS NULL
              OR support_event.snapshot_valid_until > ${asOf}::timestamptz
            )
        )
      )
    ORDER BY matches.source_score DESC, node.id ASC
    LIMIT ${limit}
  `) as unknown as LaneRow[];
  return rowsToLane("entity", rows);
}

function normalizeTerms(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(
          (value) =>
            value.length > 0 &&
            Buffer.byteLength(value, "utf8") <= 256 &&
            !/[\u0000-\u001f\u007f]/.test(value)
        )
    ),
  ]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, 128);
}

function deterministicQueryTerms(query: string): string[] {
  const normalized = query
    .slice(0, 4096)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const tokens = (
    normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_&.'-]*/gu) ?? []
  ).slice(0, 32);
  const bigrams = tokens.slice(0, -1).map(
    (token, index) => `${token} ${tokens[index + 1]}`
  );
  return normalizeTerms([
    ...extractEntitiesSync(query),
    ...extractSemanticTags(query),
    ...tokens,
    ...bigrams,
    normalized,
  ]);
}

function optionalIso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function numeric(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function relation(value: string): RetrievalProvenance["relation"] | null {
  if (
    value === "captured_from" ||
    value === "corrects" ||
    value === "derived_from" ||
    value === "consolidates"
  ) {
    return value;
  }
  return null;
}

function priorityFactor(priority: number | null): number {
  return priority === null ? 1 : PRIORITY_FACTORS.get(priority) ?? 1;
}

function componentSourceScore(
  ranks: readonly ComponentRank[],
  lane: RetrievalLane
): number {
  const value = ranks.find((rank) => rank.lane === lane)?.sourceScore;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function attainableRrfMaximum(kind: RetrievedItem["kind"]): number {
  if (kind === "working_item") return MAX_WORKING_SEARCH_RRF;
  return MAX_MEMORY_SEARCH_RRF;
}

function evidenceLine(item: RetrievedItem): string {
  const subject =
    item.kind === "memory"
      ? { memoryId: item.memoryId }
      : item.kind === "working_item"
        ? { workingItemId: item.workingItemId }
        : { artifactId: item.artifactId };
  return JSON.stringify({
    retrievalItemId: item.retrievalItemId,
    kind: item.kind,
    ...subject,
    currentness: item.currentness,
    provenance: item.provenance,
    content: item.content,
  });
}

function packEvidence(
  items: readonly RetrievedItem[],
  tokenBudget: number
): { selected: RetrievedItem[]; context: string; tokensUsed: number } {
  const selected: RetrievedItem[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.retrievalItemId)) continue;
    const candidateLines = [...lines, evidenceLine(item)];
    const candidateContext = candidateLines.join("\n");
    if (countTokens(candidateContext) > tokenBudget) continue;
    seen.add(item.retrievalItemId);
    selected.push(item);
    lines.push(candidateLines.at(-1)!);
  }
  if (selected.length === 0) {
    return { selected: [], context: "", tokensUsed: 0 };
  }
  const context = lines.join("\n");
  return { selected, context, tokensUsed: countTokens(context) };
}

function preselectInitWorkingItems(items: readonly WorkingItem[]): WorkingItem[] {
  const selected: WorkingItem[] = [];
  const lines: string[] = [];
  for (const item of items) {
    if (selected.length >= MAX_BOOT_WORKING_ITEMS) break;
    const line = JSON.stringify({
      kind: "working_item",
      workingItemId: item.id,
      currentness: 1,
      provenance: [],
      content: item.content,
    });
    if (countTokens([...lines, line].join("\n")) > INIT_WORKING_TOKEN_BUDGET) {
      continue;
    }
    selected.push(item);
    lines.push(line);
  }
  return selected;
}

function buildInitQuery(
  workingItems: readonly WorkingItem[],
  queryHint: string | undefined
): string | null {
  const pieces = [
    ...workingItems.map((item) => item.content),
    ...(queryHint === undefined ? [] : [queryHint]),
  ];
  const accepted: string[] = [];
  for (const piece of pieces) {
    const next = [...accepted, piece].join("\n");
    if (Buffer.byteLength(next, "utf8") <= MAX_RETRIEVAL_QUERY_BYTES) {
      accepted.push(piece);
    }
  }
  const query = accepted.join("\n");
  return query.trim().length > 0 ? query : null;
}

function candidateMatchesPersistedRow(
  candidate: RetrievedItem | undefined,
  row: {
    memory_id: number | string | null | undefined;
    working_item_id: string | null | undefined;
    content_hash: string;
    final_rank: number | string;
  }
): boolean {
  if (
    !candidate ||
    candidate.finalRank !== Number(row.final_rank) ||
    sha256(candidate.content) !== row.content_hash
  ) {
    return false;
  }
  if (candidate.kind === "memory") {
    return (
      candidate.memoryId === Number(row.memory_id) &&
      (row.working_item_id ?? null) === null
    );
  }
  if (candidate.kind === "working_item") {
    return (
      (row.memory_id ?? null) === null &&
      candidate.workingItemId === row.working_item_id
    );
  }
  return false;
}

async function markRetrievalFailed(
  deps: MemoryServiceDependencies,
  retrievalId: string,
  elapsedMs: number,
  completedAt: string
): Promise<void> {
  try {
    await deps.sql`
      UPDATE public.memory_retrievals
      SET status = 'failed',
          error_code = 'retrieval_failed',
          latency_ms = ${elapsedMs},
          completed_at = GREATEST(
            created_at,
            ${completedAt}::timestamptz
          )
      WHERE id = ${retrievalId}::uuid
        AND status = 'running'
    `;
  } catch {
    // The original retrieval error remains authoritative when telemetry itself
    // is unavailable.
  }
}

async function hydrateAndPersist(
  deps: MemoryServiceDependencies,
  retrievalId: string,
  agentId: number,
  asOf: string,
  fused: readonly FusedCandidate[],
  reserveWorking: boolean
): Promise<RetrievedItem[]> {
  const boundedForHydration = fused.slice(
    0,
    deps.config.retrievalCandidateLimit * SEARCH_LANES.length
  );
  const memoryCandidates = boundedForHydration.filter(
    (candidate): candidate is FusedCandidate & {
      kind: "memory";
      memoryId: number;
    } => candidate.kind === "memory"
  );
  const workingCandidates = boundedForHydration.filter(
    (candidate): candidate is FusedCandidate & {
      kind: "working_item";
      workingItemId: string;
    } => candidate.kind === "working_item"
  );
  const memoryIds = memoryCandidates.map((candidate) => candidate.memoryId);
  const workingIds = workingCandidates.map((candidate) => candidate.workingItemId);

  return deps.sql.begin(async (transaction) => {
    if (memoryIds.length === 0 && workingIds.length === 0) {
      await transaction`
        UPDATE public.memory_retrievals
        SET candidate_count = 0
        WHERE id = ${retrievalId}::uuid
          AND agent_id = ${agentId}
          AND status = 'running'
      `;
      return [];
    }

    const hydratedRows = memoryIds.length
      ? ((await transaction`
          SELECT
            node.id,
            node.content,
            node.source,
            node.source_type,
            node.priority,
            node.resonance_score,
            node.entities,
            node.semantic_tags,
            node.created_at,
            node.last_recalled_at,
            node.valid_from,
            node.valid_until,
            node.superseded_by
          FROM public.memory_nodes AS node
          WHERE node.agent_id = ${agentId}
            AND node.id = ANY(${transaction.array(memoryIds)}::integer[])
            AND node.status = 'active'
            AND (node.valid_from IS NULL OR node.valid_from <= ${asOf}::timestamptz)
            AND (node.valid_until IS NULL OR node.valid_until > ${asOf}::timestamptz)
            AND (
              node.derivation_expires_at IS NULL
              OR node.derivation_expires_at > ${asOf}::timestamptz
            )
            AND (
              node.ingest_event_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM public.memory_provenance AS support
                JOIN public.memory_ingest_events AS support_event
                  ON support_event.id = support.ingest_event_id
                 AND support_event.agent_id = support.agent_id
                WHERE support.agent_id = ${agentId}
                  AND support.memory_id = node.id
                  AND support.relation = 'captured_from'
                  AND support_event.status = 'indexed'
                  AND (
                    support_event.snapshot_valid_until IS NULL
                    OR support_event.snapshot_valid_until > ${asOf}::timestamptz
                  )
              )
            )
          ORDER BY node.id ASC
          FOR SHARE OF node
        `) as unknown as HydratedMemoryRow[])
      : [];

    const hydratedWorkingRows = workingIds.length
      ? ((await transaction`
          SELECT
            item.id::text AS id,
            item.content,
            item.kind,
            item.importance,
            item.display_order,
            item.last_confirmed_at,
            item.expires_at,
            item.source_memory_id,
            item.source_event_id::text AS source_event_id
          FROM public.working_memory_items AS item
          WHERE item.agent_id = ${agentId}
            AND item.id = ANY(${transaction.array(workingIds)}::uuid[])
            AND item.status = 'active'
            AND item.expires_at > ${asOf}::timestamptz
            AND (
              item.source_memory_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM public.memory_nodes AS source_node
                WHERE source_node.id = item.source_memory_id
                  AND source_node.agent_id = item.agent_id
                  AND source_node.status = 'active'
                  AND (
                    source_node.valid_from IS NULL
                    OR source_node.valid_from <= ${asOf}::timestamptz
                  )
                  AND (
                    source_node.valid_until IS NULL
                    OR source_node.valid_until > ${asOf}::timestamptz
                  )
                  AND (
                    source_node.derivation_expires_at IS NULL
                    OR source_node.derivation_expires_at > ${asOf}::timestamptz
                  )
                  AND (
                    item.kind <> 'correction'
                    OR (
                      source_node.ingest_event_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1
                        FROM public.memory_provenance AS source_provenance
                        JOIN public.memory_ingest_events AS source_event
                          ON source_event.id = source_provenance.ingest_event_id
                         AND source_event.agent_id = source_provenance.agent_id
                        WHERE source_provenance.agent_id = item.agent_id
                          AND source_provenance.memory_id = source_node.id
                          AND source_provenance.relation = 'captured_from'
                          AND source_event.status = 'indexed'
                          AND (
                            source_event.snapshot_valid_until IS NULL
                            OR source_event.snapshot_valid_until > ${asOf}::timestamptz
                          )
                      )
                    )
                  )
              )
            )
            AND (
              item.source_event_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM public.memory_ingest_events AS item_event
                WHERE item_event.id = item.source_event_id
                  AND item_event.agent_id = item.agent_id
                  AND item_event.status = 'indexed'
                  AND (
                    item_event.snapshot_valid_until IS NULL
                    OR item_event.snapshot_valid_until > ${asOf}::timestamptz
                  )
              )
            )
          ORDER BY item.id ASC
          FOR SHARE OF item
        `) as unknown as HydratedWorkingRow[])
      : [];

    const hydratedIds = hydratedRows.map((row) => Number(row.id));
    const provenanceRows = hydratedIds.length
      ? ((await transaction`
          SELECT
            requested.memory_id,
            current_support.event_id,
            current_support.source,
            current_support.source_type,
            current_support.relation,
            current_support.accepted_at
          FROM pg_catalog.unnest(
            ${transaction.array(hydratedIds)}::integer[]
          ) AS requested(memory_id)
          JOIN LATERAL (
            SELECT
              event.id::text AS event_id,
              event.source,
              event.source_type,
              provenance.relation,
              event.accepted_at
            FROM public.memory_provenance AS provenance
            JOIN public.memory_ingest_events AS event
              ON event.id = provenance.ingest_event_id
             AND event.agent_id = provenance.agent_id
            WHERE provenance.agent_id = ${agentId}
              AND provenance.memory_id = requested.memory_id
              AND provenance.relation IN (
                'captured_from', 'corrects', 'derived_from', 'consolidates'
              )
              AND event.status = 'indexed'
              AND (
                event.snapshot_valid_until IS NULL
                OR event.snapshot_valid_until > ${asOf}::timestamptz
              )
            ORDER BY event.accepted_at DESC, event.id DESC
            LIMIT ${PROVENANCE_LIMIT + 1}
          ) AS current_support ON true
          ORDER BY requested.memory_id ASC,
                   current_support.accepted_at DESC,
                   current_support.event_id DESC
        `) as unknown as ProvenanceRow[])
      : [];

    const provenanceByMemory = new Map<number, RetrievalProvenance[]>();
    for (const row of provenanceRows) {
      const provenanceRelation = relation(row.relation);
      const acceptedAt = optionalIso(row.accepted_at);
      if (!provenanceRelation || !acceptedAt) continue;
      const memoryId = Number(row.memory_id);
      const entries = provenanceByMemory.get(memoryId) ?? [];
      entries.push({
        eventId: row.event_id,
        source: row.source,
        sourceType: row.source_type,
        relation: provenanceRelation,
        confidence: null,
        acceptedAt,
      });
      provenanceByMemory.set(memoryId, entries);
    }

    const fusedByMemory = new Map(
      memoryCandidates.map((candidate) => [candidate.memoryId, candidate])
    );
    const fusedByWorking = new Map(
      workingCandidates.map((candidate) => [candidate.workingItemId, candidate])
    );
    type ScoredCandidate = {
      candidate: FusedCandidate;
      rankingScore: number;
      score: number;
      identity: string;
      item(finalRank: number): RetrievedItem;
      contentHash: string;
    };
    const scored: ScoredCandidate[] = hydratedRows.flatMap((row) => {
      const memoryId = Number(row.id);
      const candidate = fusedByMemory.get(memoryId);
      const createdAt = optionalIso(row.created_at);
      if (!candidate || !createdAt) return [];
      const priority = numeric(row.priority);
      const factor = priorityFactor(priority);
      const hybridScore = clamp01(
        candidate.fusedScore / attainableRrfMaximum("memory")
      );
      const score = clamp01(
        (candidate.fusedScore * factor) /
          (attainableRrfMaximum("memory") * MAX_PRIORITY_FACTOR)
      );
      return [
        {
          candidate,
          rankingScore: candidate.fusedScore * factor,
          score,
          identity: candidateIdentity(candidate),
          contentHash: sha256(row.content),
          item(finalRank: number): RetrievedItem {
            const allProvenance = provenanceByMemory.get(memoryId) ?? [];
            return {
              retrievalItemId: deps.newId(),
              kind: "memory",
              memoryId,
              content: row.content,
              source: row.source,
              priority,
              resonance: numeric(row.resonance_score),
              currentness: 1,
              score,
              finalRank,
              componentRanks: candidate.componentRanks.map((rank) => ({
                ...rank,
              })),
              reasons: [
                "current",
                ...candidate.componentRanks.map(
                  (rank) => `${rank.lane}_rank_${rank.rank}`
                ),
                ...(factor > 1 ? ["storage_priority_tiebreaker"] : []),
              ],
              provenance: allProvenance.slice(0, PROVENANCE_LIMIT),
              provenanceTruncated: allProvenance.length > PROVENANCE_LIMIT,
              compatibility: {
                sourceType: row.source_type,
                entities: row.entities,
                semanticTags: row.semantic_tags,
                createdAt,
                lastRecalledAt: optionalIso(row.last_recalled_at),
                validFrom: optionalIso(row.valid_from),
                validUntil: optionalIso(row.valid_until),
                supersededBy:
                  row.superseded_by === null
                    ? null
                    : Number(row.superseded_by),
                hybridScore,
                scoreBreakdown: {
                  cosine: componentSourceScore(
                    candidate.componentRanks,
                    "vector"
                  ),
                  textMatch: componentSourceScore(
                    candidate.componentRanks,
                    "lexical"
                  ),
                  recency: 0,
                  resonance: 0,
                  priorityBoost: clamp01((factor - 1) / 0.05),
                  emotionalBoost: 0,
                  ca3Activation: clamp01(
                    componentSourceScore(candidate.componentRanks, "graph")
                  ),
                },
              },
            };
          },
        },
      ];
    });

    for (const row of hydratedWorkingRows) {
      const candidate = fusedByWorking.get(row.id);
      const lastConfirmedAt = optionalIso(row.last_confirmed_at);
      const expiresAt = optionalIso(row.expires_at);
      if (!candidate || !lastConfirmedAt || !expiresAt) continue;
      const score = clamp01(
        candidate.fusedScore / attainableRrfMaximum("working_item")
      );
      scored.push({
        candidate,
        rankingScore: candidate.fusedScore,
        score,
        identity: candidateIdentity(candidate),
        contentHash: sha256(row.content),
        item(finalRank: number): RetrievedItem {
          return {
            retrievalItemId: deps.newId(),
            kind: "working_item",
            workingItemId: row.id,
            content: row.content,
            source: null,
            priority: null,
            currentness: 1,
            score,
            finalRank,
            componentRanks: candidate.componentRanks.map((rank) => ({
              ...rank,
            })),
            reasons: [
              "current",
              ...candidate.componentRanks.map(
                (rank) => `${rank.lane}_rank_${rank.rank}`
              ),
            ],
            provenance: [],
            provenanceTruncated: false,
          };
        },
      });
    }

    scored.sort((left, right) => {
      const finalDifference = right.rankingScore - left.rankingScore;
      if (finalDifference !== 0) return finalDifference;
      const fusedDifference =
        right.candidate.fusedScore - left.candidate.fusedScore;
      if (fusedDifference !== 0) return fusedDifference;
      return left.identity < right.identity
        ? -1
        : left.identity > right.identity
          ? 1
          : 0;
    });

    const boundedScored = reserveWorking
      ? [
          ...scored
            .filter((entry) => entry.candidate.kind === "working_item")
            .sort((left, right) => {
              const leftRank = left.candidate.componentRanks.find(
                (rank) => rank.lane === "working"
              )?.rank ?? Number.MAX_SAFE_INTEGER;
              const rightRank = right.candidate.componentRanks.find(
                (rank) => rank.lane === "working"
              )?.rank ?? Number.MAX_SAFE_INTEGER;
              return leftRank - rightRank ||
                (left.identity < right.identity
                  ? -1
                  : left.identity > right.identity
                    ? 1
                    : 0);
            }),
          ...scored.filter((entry) => entry.candidate.kind !== "working_item"),
        ].slice(0, deps.config.retrievalCandidateLimit)
      : scored.slice(0, deps.config.retrievalCandidateLimit);

    const persisted = boundedScored
      .map((entry, index) => {
        const item = entry.item(index + 1);
        return {
          item,
          contentHash: entry.contentHash,
          candidateLanes: entry.candidate.componentRanks.map(
            (rank) => rank.lane
          ),
        };
      });

    if (persisted.length > 0) {
      const payload = persisted.map(({ item, contentHash, candidateLanes }) => ({
        id: item.retrievalItemId,
        agentId,
        retrievalId,
        memoryId: item.kind === "memory" ? item.memoryId : null,
        workingItemId:
          item.kind === "working_item" ? item.workingItemId : null,
        contentHash,
        candidateLanes,
        componentRanks: item.componentRanks,
        finalScore: item.score,
        finalRank: item.finalRank,
        createdAt: asOf,
      }));
      // Drizzle installs transparent json/jsonb serializers on the shared
      // postgres.js client. Serialize explicitly and bind as text so this raw
      // query remains correct with either the Drizzle-wrapped or plain client.
      const serializedPayload = JSON.stringify(payload);
      await transaction`
        INSERT INTO public.memory_retrieval_items (
          id,
          agent_id,
          retrieval_id,
          memory_id,
          working_item_id,
          content_hash,
          candidate_lanes,
          component_ranks,
          final_score,
          final_rank,
          created_at
        )
        SELECT
          (entry ->> 'id')::uuid,
          (entry ->> 'agentId')::integer,
          (entry ->> 'retrievalId')::uuid,
          (entry ->> 'memoryId')::integer,
          (entry ->> 'workingItemId')::uuid,
          entry ->> 'contentHash',
          ARRAY(
            SELECT pg_catalog.jsonb_array_elements_text(
              entry -> 'candidateLanes'
            )
          ),
          entry -> 'componentRanks',
          (entry ->> 'finalScore')::real,
          (entry ->> 'finalRank')::integer,
          (entry ->> 'createdAt')::timestamptz
        FROM pg_catalog.jsonb_array_elements(
          ${transaction.typed(serializedPayload, 25)}::jsonb
        ) AS entry
      `;
    }

    await transaction`
      UPDATE public.memory_retrievals
      SET candidate_count = ${persisted.length}
      WHERE id = ${retrievalId}::uuid
        AND agent_id = ${agentId}
        AND status = 'running'
    `;
    return persisted.map(({ item }) => item);
  });
}

export function createRetrievalService(
  deps: MemoryServiceDependencies
): RetrievalService {
  const workingSet = createWorkingSetService(deps);
  // PreparedRetrieval is an in-process capability: it contains hydrated content
  // and has no durable reconstruction API. Keep the exact first delivery intent
  // with that capability so a lost-response retry can replay an invalidated
  // subset without weakening changed-selection checks or adding false returned
  // evidence to memory_retrieval_items.
  const successfulDeliveries = new WeakMap<
    PreparedRetrieval,
    DeliveryReplayRecord
  >();
  const preparedSnapshots = new WeakMap<
    PreparedRetrieval,
    PreparedRetrievalSnapshot
  >();
  const preparationStartedAt = new WeakMap<PreparedRetrieval, number>();

  async function prepareInternal(
    input: RetrieveInput,
    includeMemoryLanes: boolean,
    reservedWorkingItemIds?: readonly string[]
  ): Promise<PreparedRetrieval> {
    validateInput(input);
    const startedAt = performance.now();
    const asOf = dependencyInstant(deps);
    const retrievalId = deps.newId();
    const warnings: string[] = [];

    await deps.sql`
      INSERT INTO public.memory_retrievals (
        id,
        agent_id,
        request_id,
        session_id,
        query,
        query_hash,
        channel,
        status,
        algorithm_version,
        build_id,
        token_budget,
        candidate_count,
        returned_count,
        created_at
      ) VALUES (
        ${retrievalId}::uuid,
        ${input.agentId},
        ${input.requestId ?? null},
        ${input.sessionId ?? null},
        ${input.query},
        ${sha256(input.query)},
        ${input.channel},
        'running',
        ${deps.config.retrievalVersion},
        ${deps.config.buildId},
        ${input.tokenBudget ?? null},
        0,
        0,
        ${asOf}
      )
    `;

    try {
      const reservedWorking =
        reservedWorkingItemIds === undefined
          ? null
          : new Set(reservedWorkingItemIds);
      const workingPromise =
        input.channel === "init"
          ? workingLane(
              deps,
              input.agentId,
              asOf,
              deps.config.retrievalCandidateLimit
            ).then((candidates) =>
              reservedWorking === null
                ? candidates
                : candidates.filter(
                    (candidate) =>
                      candidate.kind === "working_item" &&
                      reservedWorking.has(candidate.workingItemId)
                  )
            )
          : Promise.resolve([]);
      const lexicalPromise = includeMemoryLanes
        ? lexicalLane(
            deps,
            input.agentId,
            input.query,
            asOf,
            deps.config.retrievalCandidateLimit
          )
        : Promise.resolve([]);
      const embeddingPromise = includeMemoryLanes
        ? deps.embedQuery(input.query).then(
            (embedding) => embedding,
            () => {
              warnings.push("vector_lane_unavailable");
              return null;
            }
          )
        : Promise.resolve(null);
      const [working, lexical, embedding] = await Promise.all([
        workingPromise,
        lexicalPromise,
        embeddingPromise,
      ]);
      const entityTerms = includeMemoryLanes
        ? deterministicQueryTerms(input.query)
        : [];

      const entityPromise = includeMemoryLanes
        ? entityLane(
            deps,
            input.agentId,
            entityTerms,
            asOf,
            deps.config.retrievalCandidateLimit
          )
        : Promise.resolve([]);
      const vectorPromise = embedding
        ? vectorLane(
            deps,
            input.agentId,
            embedding.values,
            asOf,
            deps.config.retrievalCandidateLimit
          ).catch(() => {
            warnings.push("vector_lane_unavailable");
            return [];
          })
        : Promise.resolve([]);
      const graphEnabled = input.enableCA3 ?? deps.config.ca3Enabled;
      const graphPromise = embedding && graphEnabled
        ? deps
            .patternComplete(
              input.agentId,
              embedding.values,
              deps.config.retrievalCandidateLimit,
              asOf
            )
            .then((candidates) =>
              [...candidates]
                .sort(
                  (left, right) =>
                    right.activationScore - left.activationScore ||
                    left.memoryId - right.memoryId
                )
                .map<LaneCandidate>((candidate, index) => ({
                  kind: "memory",
                  memoryId: candidate.memoryId,
                  lane: "graph",
                  sourceRank: index + 1,
                  sourceScore: candidate.activationScore,
                  content: "",
                }))
            )
            .catch(() => {
              warnings.push("graph_lane_unavailable");
              return [];
            })
        : Promise.resolve([]);

      const [entity, vector, graph] = await Promise.all([
        entityPromise,
        vectorPromise,
        graphPromise,
      ]);
      const lanes = new Map<RetrievalLane, readonly LaneCandidate[]>([
        ["working", working],
        ["lexical", lexical],
        ["vector", vector],
        ["entity", entity],
        ["graph", graph],
      ]);
      const fused = fuseCandidateRanks(lanes, SEARCH_RANK_FUSION_OPTIONS);
      const candidates = await hydrateAndPersist(
        deps,
        retrievalId,
        input.agentId,
        asOf,
        fused,
        input.channel === "init"
      );

      const prepared: PreparedRetrieval = {
        retrievalId,
        algorithmVersion: deps.config.retrievalVersion,
        buildId: deps.config.buildId,
        candidates,
        elapsedMs: elapsedMilliseconds(startedAt),
        warnings: [...new Set(warnings)].sort(),
      };
      preparationStartedAt.set(prepared, startedAt);
      preparedSnapshots.set(prepared, {
        retrievalId: prepared.retrievalId,
        algorithmVersion: prepared.algorithmVersion,
        buildId: prepared.buildId,
        candidates: prepared.candidates.map(cloneRetrievedItem),
        elapsedMs: prepared.elapsedMs,
        warnings: [...prepared.warnings],
      });
      return prepared;
    } catch (error) {
      await markRetrievalFailed(
        deps,
        retrievalId,
        elapsedMilliseconds(startedAt),
        failureInstant(deps)
      );
      throw error;
    }
  }

  async function prepare(input: RetrieveInput): Promise<PreparedRetrieval> {
    return prepareInternal(input, true);
  }

  async function deliver(
    prepared: PreparedRetrieval,
    selected: readonly RetrievedItem[]
  ): Promise<RetrievalResponse> {
    const snapshot = preparedSnapshots.get(prepared);
    if (!snapshot) {
      throw new TypeError("Prepared retrieval was not created by this service");
    }
    assertPreparedRetrievalUnchanged(prepared, snapshot);
    const startedAt =
      preparationStartedAt.get(prepared) ??
      performance.now() - Math.max(snapshot.elapsedMs, 0);
    let attemptedDeliveryAt: string | null = null;
    let pendingReplayRecord: DeliveryReplayRecord | null = null;
    const canonicalCandidates = new Map(
      snapshot.candidates.map((candidate) => [candidate.retrievalItemId, candidate])
    );
    const requestedIds = new Set(
      selected.map((item) => item.retrievalItemId)
    );
    if (requestedIds.size > MAX_RESULT_LIMIT) {
      throw new TypeError("A retrieval may deliver at most 50 results");
    }
    for (const selectedId of requestedIds) {
      if (!canonicalCandidates.has(selectedId)) {
        throw new TypeError("Delivered item was not prepared by this retrieval");
      }
    }
    const selectedIds = snapshot.candidates
      .filter((candidate) => requestedIds.has(candidate.retrievalItemId))
      .sort((left, right) => left.finalRank - right.finalRank)
      .map((candidate) => candidate.retrievalItemId);

    try {
      return await deps.sql.begin(async (transaction) => {
        const headers = (await transaction`
          SELECT
            agent_id,
            algorithm_version,
            build_id,
            candidate_count,
            returned_count,
            latency_ms,
            status,
            created_at
          FROM public.memory_retrievals
          WHERE id = ${snapshot.retrievalId}::uuid
          FOR UPDATE
        `) as unknown as RetrievalHeaderRow[];
        const header = headers[0];
        if (
          !header ||
          header.algorithm_version !== snapshot.algorithmVersion ||
          header.build_id !== snapshot.buildId
        ) {
          throw new TypeError("Prepared retrieval no longer exists");
        }
        if (header.status === "failed") {
          throw new TypeError("Failed retrieval cannot be delivered");
        }

        const agentId = Number(header.agent_id);
        const candidateCount = Number(header.candidate_count);
        const createdAt = optionalIso(header.created_at);
        if (!createdAt) throw new TypeError("Retrieval timestamp is invalid");

        if (header.status === "completed") {
          const returnedRows = (await transaction`
            SELECT
              id::text AS id,
              memory_id,
              working_item_id::text AS working_item_id,
              content_hash,
              final_rank
            FROM public.memory_retrieval_items
            WHERE retrieval_id = ${snapshot.retrievalId}::uuid
              AND agent_id = ${agentId}
              AND returned_at IS NOT NULL
            ORDER BY final_rank ASC
          `) as unknown as ReturnedCandidateRow[];
          const returnedIds = returnedRows.map((row) => row.id);
          const replayRecord = successfulDeliveries.get(prepared);
          if (replayRecord) {
            if (
              !equalIds(replayRecord.selectedIds, selectedIds) ||
              !equalIds(replayRecord.returnedIds, returnedIds)
            ) {
              throw new TypeError("Completed retrieval delivery cannot be changed");
            }
            for (const selectedId of replayRecord.selectedIds) {
              const candidate = canonicalCandidates.get(selectedId);
              if (
                !candidate ||
                retrievedItemFingerprint(candidate) !==
                  replayRecord.selectedFingerprints.get(selectedId)
              ) {
                throw new TypeError(
                  "Prepared retrieval candidates do not match persisted retrieval"
                );
              }
            }
          } else if (!equalIds(returnedIds, selectedIds)) {
            // Without the original in-process capability receipt, accepting a
            // strict subset would make a changed selection indistinguishable
            // from an exact retry whose first delivery invalidated candidates.
            throw new TypeError("Completed retrieval delivery cannot be changed");
          }
          const replayResults = returnedRows.map((row) => {
            const candidate = canonicalCandidates.get(row.id);
            if (!candidate || !candidateMatchesPersistedRow(candidate, row)) {
              throw new TypeError(
                "Prepared retrieval candidates do not match persisted retrieval"
              );
            }
            return cloneRetrievedItem(candidate);
          });
          return {
            retrievalId: snapshot.retrievalId,
            algorithmVersion: snapshot.algorithmVersion,
            buildId: snapshot.buildId,
            results: replayResults,
            candidateCount,
            returnedCount: Number(header.returned_count),
            elapsedMs:
              replayRecord?.elapsedMs ??
              Math.max(Number(header.latency_ms ?? snapshot.elapsedMs), 0),
            warnings: replayRecord
              ? [...replayRecord.warnings]
              : [...snapshot.warnings],
          };
        }

        attemptedDeliveryAt = dependencyInstant(deps);
        const deliveryAt =
          new Date(attemptedDeliveryAt).getTime() >= new Date(createdAt).getTime()
            ? attemptedDeliveryAt
            : createdAt;

        let validRows: DeliveryCandidateRow[] = [];
        if (selectedIds.length > 0) {
          const selectedMemoryIds = selectedIds.filter(
            (id) => canonicalCandidates.get(id)?.kind === "memory"
          );
          const selectedWorkingIds = selectedIds.filter(
            (id) => canonicalCandidates.get(id)?.kind === "working_item"
          );
          const validMemoryRows = selectedMemoryIds.length
            ? ((await transaction`
                SELECT
                  item.id::text AS retrieval_item_id,
                  item.memory_id,
                  NULL::text AS working_item_id,
                  item.content_hash,
                  node.content,
                  item.final_rank
                FROM public.memory_retrieval_items AS item
                JOIN public.memory_nodes AS node
                  ON node.id = item.memory_id
                 AND node.agent_id = item.agent_id
                WHERE item.retrieval_id = ${snapshot.retrievalId}::uuid
                  AND item.agent_id = ${agentId}
                  AND item.id = ANY(${transaction.array(selectedMemoryIds)}::uuid[])
                  AND item.working_item_id IS NULL
                  AND item.returned_at IS NULL
                  AND node.status = 'active'
                  AND (node.valid_from IS NULL OR node.valid_from <= ${deliveryAt}::timestamptz)
                  AND (node.valid_until IS NULL OR node.valid_until > ${deliveryAt}::timestamptz)
                  AND (
                    node.derivation_expires_at IS NULL
                    OR node.derivation_expires_at > ${deliveryAt}::timestamptz
                  )
                  AND (
                    node.ingest_event_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM public.memory_provenance AS support
                      JOIN public.memory_ingest_events AS support_event
                        ON support_event.id = support.ingest_event_id
                       AND support_event.agent_id = support.agent_id
                      WHERE support.agent_id = ${agentId}
                        AND support.memory_id = node.id
                        AND support.relation = 'captured_from'
                        AND support_event.status = 'indexed'
                        AND (
                          support_event.snapshot_valid_until IS NULL
                          OR support_event.snapshot_valid_until > ${deliveryAt}::timestamptz
                        )
                    )
                  )
                -- All deliveries lock memory subjects before working subjects;
                -- each subject class also has one global identifier order.
                ORDER BY node.id ASC, item.id ASC
                FOR UPDATE OF item, node
              `) as unknown as DeliveryCandidateRow[])
            : [];
          const validWorkingRows = selectedWorkingIds.length
            ? ((await transaction`
                SELECT
                  item.id::text AS retrieval_item_id,
                  NULL::integer AS memory_id,
                  working_item.id::text AS working_item_id,
                  item.content_hash,
                  working_item.content,
                  item.final_rank
                FROM public.memory_retrieval_items AS item
                JOIN public.working_memory_items AS working_item
                  ON working_item.id = item.working_item_id
                 AND working_item.agent_id = item.agent_id
                WHERE item.retrieval_id = ${snapshot.retrievalId}::uuid
                  AND item.agent_id = ${agentId}
                  AND item.id = ANY(${transaction.array(selectedWorkingIds)}::uuid[])
                  AND item.memory_id IS NULL
                  AND item.returned_at IS NULL
                  AND working_item.status = 'active'
                  AND working_item.expires_at > ${deliveryAt}::timestamptz
                  AND (
                    working_item.source_memory_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM public.memory_nodes AS source_node
                      WHERE source_node.id = working_item.source_memory_id
                        AND source_node.agent_id = working_item.agent_id
                        AND source_node.status = 'active'
                        AND (
                          source_node.valid_from IS NULL
                          OR source_node.valid_from <= ${deliveryAt}::timestamptz
                        )
                        AND (
                          source_node.valid_until IS NULL
                          OR source_node.valid_until > ${deliveryAt}::timestamptz
                        )
                        AND (
                          source_node.derivation_expires_at IS NULL
                          OR source_node.derivation_expires_at > ${deliveryAt}::timestamptz
                        )
                        AND (
                          working_item.kind <> 'correction'
                          OR (
                            source_node.ingest_event_id IS NOT NULL
                            AND EXISTS (
                              SELECT 1
                              FROM public.memory_provenance AS source_provenance
                              JOIN public.memory_ingest_events AS source_event
                                ON source_event.id = source_provenance.ingest_event_id
                               AND source_event.agent_id = source_provenance.agent_id
                              WHERE source_provenance.agent_id = working_item.agent_id
                                AND source_provenance.memory_id = source_node.id
                                AND source_provenance.relation = 'captured_from'
                                AND source_event.status = 'indexed'
                                AND (
                                  source_event.snapshot_valid_until IS NULL
                                  OR source_event.snapshot_valid_until > ${deliveryAt}::timestamptz
                                )
                            )
                          )
                        )
                    )
                  )
                  AND (
                    working_item.source_event_id IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM public.memory_ingest_events AS item_event
                      WHERE item_event.id = working_item.source_event_id
                        AND item_event.agent_id = working_item.agent_id
                        AND item_event.status = 'indexed'
                        AND (
                          item_event.snapshot_valid_until IS NULL
                          OR item_event.snapshot_valid_until > ${deliveryAt}::timestamptz
                        )
                    )
                  )
                ORDER BY working_item.id ASC, item.id ASC
                FOR UPDATE OF item, working_item
              `) as unknown as DeliveryCandidateRow[])
            : [];
          validRows = [...validMemoryRows, ...validWorkingRows].filter((row) => {
            const canonical = canonicalCandidates.get(row.retrieval_item_id);
            return (
              candidateMatchesPersistedRow(canonical, row) &&
              sha256(row.content) === row.content_hash
            );
          }).sort(
            (left, right) => Number(left.final_rank) - Number(right.final_rank)
          );
        }

        const validIds = validRows.map((row) => row.retrieval_item_id);
        const markedRows = validIds.length
          ? ((await transaction`
              UPDATE public.memory_retrieval_items
              SET returned_at = ${deliveryAt}
              WHERE retrieval_id = ${snapshot.retrievalId}::uuid
                AND agent_id = ${agentId}
                AND id = ANY(${transaction.array(validIds)}::uuid[])
                AND returned_at IS NULL
              RETURNING
                id::text AS id,
                memory_id,
                working_item_id::text AS working_item_id
            `) as unknown as MarkedCandidateRow[])
          : [];
        const deliveredMemoryIds = [
          ...new Set(
            markedRows.flatMap((row) =>
              row.memory_id === null ? [] : [Number(row.memory_id)]
            )
          ),
        ];
        if (deliveredMemoryIds.length > 0) {
          await transaction`
            UPDATE public.memory_nodes
            SET last_recalled_at = CASE
              WHEN last_recalled_at IS NULL
                OR last_recalled_at < ${deliveryAt}::timestamptz
              THEN ${deliveryAt}::timestamptz
              ELSE last_recalled_at
            END
            WHERE agent_id = ${agentId}
              AND id = ANY(
                ${transaction.array(deliveredMemoryIds)}::integer[]
              )
          `;
        }

        const totalElapsedMs = elapsedMilliseconds(startedAt);

        await transaction`
          UPDATE public.memory_retrievals
          SET status = 'completed',
              returned_count = ${markedRows.length},
              latency_ms = ${totalElapsedMs},
              completed_at = ${deliveryAt}
          WHERE id = ${snapshot.retrievalId}::uuid
            AND agent_id = ${agentId}
            AND status = 'running'
        `;

        const markedIds = new Set(markedRows.map((row) => row.id));
        const results = validRows.flatMap((row) => {
          if (!markedIds.has(row.retrieval_item_id)) return [];
          const candidate = canonicalCandidates.get(row.retrieval_item_id);
          return candidate ? [cloneRetrievedItem(candidate)] : [];
        });
        const invalidated = selectedIds.length - results.length;
        const response: RetrievalResponse = {
          retrievalId: snapshot.retrievalId,
          algorithmVersion: snapshot.algorithmVersion,
          buildId: snapshot.buildId,
          results,
          candidateCount,
          returnedCount: results.length,
          elapsedMs: totalElapsedMs,
          warnings: [
            ...snapshot.warnings,
            ...(invalidated > 0
              ? ["candidate_invalidated_before_delivery"]
              : []),
          ],
        };
        pendingReplayRecord = {
          selectedIds: [...selectedIds],
          returnedIds: results.map((candidate) => candidate.retrievalItemId),
          selectedFingerprints: new Map(
            selectedIds.map((selectedId) => {
              const candidate = canonicalCandidates.get(selectedId);
              if (!candidate) {
                throw new TypeError(
                  "Delivered item was not prepared by this retrieval"
                );
              }
              return [selectedId, retrievedItemFingerprint(candidate)] as const;
            })
          ),
          elapsedMs: response.elapsedMs,
          warnings: [...response.warnings],
        };
        successfulDeliveries.set(prepared, pendingReplayRecord);
        return response;
      });
    } catch (error) {
      // Keep a receipt created at the end of the transaction callback. A
      // rejected begin() may mean COMMIT succeeded but its acknowledgement was
      // lost. If the transaction actually rolled back, the still-running (or
      // subsequently failed) header ignores this receipt; a later successful
      // delivery overwrites it. Deleting it here would make an exact retry of
      // an invalidated subset impossible after an ambiguous commit.
      await markRetrievalFailed(
        deps,
        snapshot.retrievalId,
        elapsedMilliseconds(startedAt),
        attemptedDeliveryAt ?? failureInstant(deps)
      );
      throw error;
    }
  }

  async function search(input: RetrieveInput): Promise<RetrievalResponse> {
    const prepared = await prepare({ ...input, channel: "search" });
    return deliver(prepared, prepared.candidates.slice(0, input.limit));
  }

  async function init(
    agentId: number,
    sessionId?: string,
    queryHint?: string
  ) {
    if (queryHint !== undefined && !isValidRetrievalQuery(queryHint)) {
      throw new TypeError(
        "queryHint must be nonblank and at most 8192 UTF-8 bytes"
      );
    }
    validateInput({
      agentId,
      query: queryHint ?? INIT_EMPTY_QUERY,
      channel: "init",
      sessionId,
      limit: MAX_RESULT_LIMIT,
      tokenBudget: INIT_RETRIEVAL_TOKEN_BUDGET,
      enableCA3: false,
    });

    const activeWorkingItems = await workingSet.list(
      agentId,
      MAX_ACTIVE_WORKING_ITEMS
    );
    const bootWorkingItems = preselectInitWorkingItems(activeWorkingItems);
    const derivedQuery = buildInitQuery(bootWorkingItems, queryHint);
    const prepared = await prepareInternal(
      {
        agentId,
        query: derivedQuery ?? INIT_EMPTY_QUERY,
        channel: "init",
        sessionId,
        limit: MAX_RESULT_LIMIT,
        tokenBudget: INIT_RETRIEVAL_TOKEN_BUDGET,
        enableCA3: false,
      },
      derivedQuery !== null,
      bootWorkingItems.map((item) => item.id)
    );

    const workingCandidatesById = new Map(
      prepared.candidates.flatMap((candidate) =>
        candidate.kind === "working_item"
          ? [[candidate.workingItemId, candidate] as const]
          : []
      )
    );
    const orderedWorkingCandidates = bootWorkingItems.flatMap((item) => {
      const candidate = workingCandidatesById.get(item.id);
      return candidate ? [candidate] : [];
    });
    let workingPack = packEvidence(
      orderedWorkingCandidates,
      INIT_WORKING_TOKEN_BUDGET
    );
    const memoryCandidates = prepared.candidates
      .filter(
        (candidate): candidate is RetrievedItem & { kind: "memory" } =>
          candidate.kind === "memory"
      )
      .sort((left, right) => left.finalRank - right.finalRank);
    let memoryPack = packEvidence(
      memoryCandidates,
      INIT_RETRIEVAL_TOKEN_BUDGET
    );

    const combinedContext = () =>
      [workingPack.context, memoryPack.context].filter(Boolean).join("\n");
    while (
      countTokens(combinedContext()) > INIT_TOTAL_TOKEN_BUDGET &&
      memoryPack.selected.length > 0
    ) {
      memoryPack = packEvidence(
        memoryPack.selected.slice(0, -1),
        INIT_RETRIEVAL_TOKEN_BUDGET
      );
    }

    const retrieval = await deliver(prepared, [
      ...workingPack.selected,
      ...memoryPack.selected,
    ]);
    const deliveredIds = new Set(
      retrieval.results.map((item) => item.retrievalItemId)
    );
    workingPack = packEvidence(
      workingPack.selected.filter((item) =>
        deliveredIds.has(item.retrievalItemId)
      ),
      INIT_WORKING_TOKEN_BUDGET
    );
    memoryPack = packEvidence(
      memoryPack.selected.filter((item) =>
        deliveredIds.has(item.retrievalItemId)
      ),
      INIT_RETRIEVAL_TOKEN_BUDGET
    );
    const context = combinedContext();
    const exposedWorkingIds = new Set(
      workingPack.selected.flatMap((item) =>
        item.kind === "working_item" ? [item.workingItemId] : []
      )
    );

    return {
      workingItems: bootWorkingItems.filter((item) =>
        exposedWorkingIds.has(item.id)
      ),
      retrieval,
      context,
      tokensUsed: countTokens(context),
      workingTokensUsed: workingPack.tokensUsed,
      retrievalTokensUsed: memoryPack.tokensUsed,
    };
  }

  return Object.freeze({ prepare, deliver, search, init });
}
