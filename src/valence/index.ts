/**
 * Emotional Valence Layer — Entry Point
 *
 * Multi-dimensional emotional context for memories.
 * Replaces simple priority 0-4 with a 6-dimensional emotional vector
 * that modulates storage, retrieval, and pruning.
 */

export { analyzeValence, computeSalience } from "./analyzer.js";
export type {
  EmotionalVector,
  EmotionalSalience,
  ValenceResult,
} from "./types.js";
export { NEUTRAL_VECTOR } from "./types.js";

import type { EmotionalVector, ValenceResult } from "./types.js";

export class ValenceResultError extends Error {
  readonly code = "valence_result_invalid" as const;

  constructor() {
    super("Valence projection returned invalid data");
    this.name = "ValenceResultError";
  }
}

function bounded(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function validateValenceResult(candidate: ValenceResult): ValenceResult {
  const vector = candidate?.vector;
  const salience = candidate?.salience;
  const signed: Array<keyof EmotionalVector> = [
    "valence",
    "arousal",
    "dominance",
    "certainty",
  ];
  const unsigned: Array<keyof EmotionalVector> = ["relevance", "urgency"];
  if (
    !vector ||
    signed.some((key) => !bounded(vector[key], -1, 1)) ||
    unsigned.some((key) => !bounded(vector[key], 0, 1)) ||
    !salience ||
    !bounded(salience.intensity, 0, 1) ||
    !bounded(salience.decayResistance, 0, 1) ||
    !bounded(salience.recallBoost, 0, 1) ||
    !new Set<keyof EmotionalVector>([
      "valence",
      "arousal",
      "dominance",
      "certainty",
      "relevance",
      "urgency",
    ]).has(salience.dominantDimension)
  ) {
    throw new ValenceResultError();
  }
  return candidate;
}
