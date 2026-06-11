/**
 * STANDING-ORDERS forbids em-dashes in agent output, and the proprioception
 * drift check (self-check.ts) scans recent cognitive artifacts for them: any
 * em-dash that lands in cognitive_artifacts raises the drift score
 * (0.1 per instance) and can flip overall health to critical on its own.
 *
 * Scrub at write time so the rule is enforced at the source instead of
 * retroactively. Every artifact insert passes its content through here.
 * Replacement mirrors scripts/scrub-em-dashes.ts: em-dash -> "--".
 */
export function scrubEmDashes<T>(content: T): T {
  const json = JSON.stringify(content);
  if (json === undefined || !json.includes("—")) return content;
  return JSON.parse(json.replace(/—/g, "--")) as T;
}
