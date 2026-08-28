import { describe, expect, it } from "@jest/globals";
import {
  EmbeddingResultError,
  validateEmbeddedBatch,
} from "../ingestion/embeddings.js";
import { validateHippocampalEncoding } from "../hippocampus/index.js";
import { validateValenceResult } from "../valence/index.js";
import type { EmbeddedBatch, EmbeddedVector } from "../memory/types.js";

const UNIT_VECTOR = [1, ...Array.from({ length: 1023 }, () => 0)];
const SPARSE_VECTOR = new Array<number>(1024);
SPARSE_VECTOR[0] = 1;

function vector(overrides: Partial<EmbeddedVector> = {}): EmbeddedVector {
  return {
    values: [...UNIT_VECTOR],
    provider: "test-provider",
    model: "test-model",
    dimensions: 1024,
    normalized: true,
    ...overrides,
  };
}

function batch(
  vectors: EmbeddedVector[] = [vector()],
  overrides: Partial<EmbeddedBatch> = {}
): EmbeddedBatch {
  return {
    vectors,
    provider: "test-provider",
    model: "test-model",
    ...overrides,
  };
}

describe("durable ingest provider-result validation", () => {
  it("accepts an identity-consistent finite normalized 1024-vector batch", () => {
    expect(validateEmbeddedBatch(batch(), 1)).toEqual(batch());
  });

  it.each([
    ["missing vector", batch([]), 1, "embedding_batch_mismatch"],
    ["extra vector", batch([vector(), vector()]), 1, "embedding_batch_mismatch"],
    ["wrong dimension", batch([vector({ values: [1], dimensions: 1 })]), 1, "embedding_dimension_invalid"],
    ["declared dimension mismatch", batch([vector({ dimensions: 768 })]), 1, "embedding_dimension_invalid"],
    ["NaN", batch([vector({ values: [Number.NaN, ...UNIT_VECTOR.slice(1)] })]), 1, "embedding_non_finite"],
    ["infinity", batch([vector({ values: [Number.POSITIVE_INFINITY, ...UNIT_VECTOR.slice(1)] })]), 1, "embedding_non_finite"],
    ["sparse array hole", batch([vector({ values: SPARSE_VECTOR })]), 1, "embedding_non_finite"],
    ["zero norm", batch([vector({ values: Array.from({ length: 1024 }, () => 0) })]), 1, "embedding_zero_norm"],
    ["not normalized", batch([vector({ values: [2, ...UNIT_VECTOR.slice(1)] })]), 1, "embedding_not_normalized"],
    ["provider mismatch", batch([vector({ provider: "other-provider" })]), 1, "embedding_result_invalid"],
    ["model mismatch", batch([vector({ model: "other-model" })]), 1, "embedding_result_invalid"],
    ["blank provider", batch([vector({ provider: "" })], { provider: "" }), 1, "embedding_result_invalid"],
  ])("rejects %s before pgvector", (_name, candidate, expectedCount, code) => {
    expect(() => validateEmbeddedBatch(candidate, expectedCount)).toThrow(
      expect.objectContaining({
        name: "EmbeddingResultError",
        code,
      })
    );
  });
});

describe("deterministic projection validation", () => {
  const sparseIndicesWithHole = new Array<number>(2);
  sparseIndicesWithHole[0] = 3;
  const sparseValuesWithHole = new Array<number>(2);
  sparseValuesWithHole[0] = 1;
  const possibleUpdateIdsWithHole = new Array<number>(1);
  const validEncoding = {
    sparseCode: {
      indices: [3, 17],
      values: [0.6, 0.8],
      dim: 4096,
    },
    noveltyResult: {
      noveltyScore: 0.4,
      resonanceScore: 5,
      adjustedPriority: 2,
      predictedSimilarity: 0.7,
      sparseMismatch: 0.3,
      possibleUpdateIds: [],
    },
  };

  it("accepts bounded hippocampal output without changing storage priority", () => {
    expect(validateHippocampalEncoding(validEncoding, 2)).toEqual(
      validEncoding
    );
  });

  it.each([
    ["duplicate sparse index", { sparseCode: { ...validEncoding.sparseCode, indices: [3, 3] } }],
    ["out-of-range sparse index", { sparseCode: { ...validEncoding.sparseCode, indices: [3, 4096] } }],
    ["mismatched sparse arrays", { sparseCode: { ...validEncoding.sparseCode, values: [1] } }],
    ["sparse index hole", { sparseCode: { ...validEncoding.sparseCode, indices: sparseIndicesWithHole } }],
    ["sparse value hole", { sparseCode: { ...validEncoding.sparseCode, values: sparseValuesWithHole } }],
    ["non-normalized sparse values", { sparseCode: { ...validEncoding.sparseCode, values: [0.2, 0.2] } }],
    ["unbounded novelty", { noveltyResult: { ...validEncoding.noveltyResult, noveltyScore: 1.1 } }],
    ["possible update ID hole", { noveltyResult: { ...validEncoding.noveltyResult, possibleUpdateIds: possibleUpdateIdsWithHole } }],
    ["priority mutation", { noveltyResult: { ...validEncoding.noveltyResult, adjustedPriority: 1 } }],
  ])("rejects %s", (_name, override) => {
    const candidate = {
      ...validEncoding,
      ...override,
      sparseCode: {
        ...validEncoding.sparseCode,
        ...(override as { sparseCode?: object }).sparseCode,
      },
      noveltyResult: {
        ...validEncoding.noveltyResult,
        ...(override as { noveltyResult?: object }).noveltyResult,
      },
    };
    expect(() => validateHippocampalEncoding(candidate, 2)).toThrow();
  });

  const validValence = {
    vector: {
      valence: -0.2,
      arousal: 0.1,
      dominance: 0,
      certainty: 0.4,
      relevance: 0.6,
      urgency: 0.2,
    },
    salience: {
      intensity: 0.3,
      decayResistance: 0.4,
      recallBoost: 0.2,
      dominantDimension: "relevance" as const,
    },
  };

  it("accepts finite bounded valence output", () => {
    expect(validateValenceResult(validValence)).toEqual(validValence);
  });

  it.each([
    ["NaN dimension", { vector: { ...validValence.vector, valence: Number.NaN } }],
    ["unbounded signed dimension", { vector: { ...validValence.vector, certainty: 2 } }],
    ["unbounded unsigned dimension", { vector: { ...validValence.vector, urgency: -0.1 } }],
    ["unbounded salience", { salience: { ...validValence.salience, recallBoost: 1.1 } }],
    ["unknown dominant dimension", { salience: { ...validValence.salience, dominantDimension: "secret" } }],
  ])("rejects %s", (_name, candidate) => {
    expect(() => validateValenceResult(candidate as never)).toThrow();
  });
});
