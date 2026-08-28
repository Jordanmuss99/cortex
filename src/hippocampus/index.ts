/**
 * Digital Hippocampus — Entry Point
 *
 * The hippocampal encoding layer sits between embedding and storage:
 *
 *   embed(chunk) → hippocampalEncode(DG + CA1) → store → form synapses
 *
 * DG (Dentate Gyrus): Pattern separation via sparse coding
 * CA1: Novelty detection via predictive coding comparator
 * CA3: Pattern completion at recall time (separate module)
 */

export { dgEncode, sparseOverlap, sparseJaccard, DG_CONFIG } from "./dentate-gyrus.js";
export { computeNovelty } from "./ca1-novelty.js";
export { patternComplete } from "./ca3-pattern-completion.js";
export type {
  SparseCode,
  NoveltyResult,
  HippocampalEncoding,
  CompletionResult,
} from "./types.js";

import { dgEncode } from "./dentate-gyrus.js";
import { computeNovelty } from "./ca1-novelty.js";
import type { HippocampalEncoding } from "./types.js";

export class HippocampalResultError extends Error {
  readonly code = "hippocampal_result_invalid" as const;

  constructor() {
    super("Hippocampal projection returned invalid data");
    this.name = "HippocampalResultError";
  }
}

export function validateHippocampalEncoding(
  candidate: HippocampalEncoding,
  expectedPriority: number
): HippocampalEncoding {
  const sparse = candidate?.sparseCode;
  const novelty = candidate?.noveltyResult;
  if (
    !sparse ||
    sparse.dim !== 4096 ||
    !Array.isArray(sparse.indices) ||
    !Array.isArray(sparse.values) ||
    sparse.indices.length === 0 ||
    sparse.indices.length !== sparse.values.length
  ) {
    throw new HippocampalResultError();
  }
  const seenIndices = new Set<number>();
  let sparseMagnitude = 0;
  for (let index = 0; index < sparse.indices.length; index += 1) {
    const sparseIndex = sparse.indices[index];
    const sparseValue = sparse.values[index];
    if (
      !Object.hasOwn(sparse.indices, index) ||
      !Object.hasOwn(sparse.values, index) ||
      !Number.isSafeInteger(sparseIndex) ||
      sparseIndex < 0 ||
      sparseIndex >= sparse.dim ||
      seenIndices.has(sparseIndex) ||
      typeof sparseValue !== "number" ||
      !Number.isFinite(sparseValue) ||
      sparseValue <= 0
    ) {
      throw new HippocampalResultError();
    }
    seenIndices.add(sparseIndex);
    sparseMagnitude += sparseValue * sparseValue;
  }
  const sparseNorm = Math.sqrt(sparseMagnitude);
  if (!Number.isFinite(sparseNorm) || Math.abs(sparseNorm - 1) > 1e-4) {
    throw new HippocampalResultError();
  }
  if (
    !novelty ||
    !Number.isFinite(novelty.noveltyScore) ||
    novelty.noveltyScore < 0 ||
    novelty.noveltyScore > 1 ||
    !Number.isFinite(novelty.predictedSimilarity) ||
    novelty.predictedSimilarity < -1 ||
    novelty.predictedSimilarity > 1 ||
    !Number.isFinite(novelty.sparseMismatch) ||
    novelty.sparseMismatch < 0 ||
    novelty.sparseMismatch > 1 ||
    !Array.isArray(novelty.possibleUpdateIds) ||
    !Number.isFinite(novelty.resonanceScore) ||
    novelty.adjustedPriority !== expectedPriority
  ) {
    throw new HippocampalResultError();
  }
  const possibleUpdateIds = new Set<number>();
  for (
    let index = 0;
    index < novelty.possibleUpdateIds.length;
    index += 1
  ) {
    const memoryId = novelty.possibleUpdateIds[index];
    if (
      !Object.hasOwn(novelty.possibleUpdateIds, index) ||
      !Number.isSafeInteger(memoryId) ||
      memoryId <= 0 ||
      possibleUpdateIds.has(memoryId)
    ) {
      throw new HippocampalResultError();
    }
    possibleUpdateIds.add(memoryId);
  }
  return candidate;
}

/**
 * Full hippocampal encoding pipeline for a single memory chunk.
 *
 * Called during ingestion after Voyage embedding, before DB storage.
 * Adds ~2-10ms latency (negligible vs ~200-500ms embedding API call).
 *
 * @param agentId - Agent ID for network comparison
 * @param denseEmbedding - 1024-dim Voyage-3 embedding
 * @param basePriority - Starting priority level (0-4)
 * @returns Sparse code + novelty result for storage
 */
export async function hippocampalEncode(
  agentId: number,
  denseEmbedding: number[],
  basePriority: number,
  asOf: Date = new Date()
): Promise<HippocampalEncoding> {
  // Step 1: DG pattern separation (pure math, ~1-5ms)
  const sparseCode = dgEncode(denseEmbedding);

  // Step 2: CA1 novelty detection (1 DB query, ~5-20ms)
  const noveltyResult = await computeNovelty(
    agentId,
    denseEmbedding,
    sparseCode,
    basePriority,
    asOf
  );

  return { sparseCode, noveltyResult };
}
