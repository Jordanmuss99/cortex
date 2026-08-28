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
  if (json === undefined || !json.includes("\u2014")) return content;
  return JSON.parse(json.replace(/\u2014/g, "--")) as T;
}

/**
 * Strip think-tag blocks from reasoning model output.
 *
 * Reasoning models like DeepSeek-R1 emit <think>...</think> blocks,
 * and Qwen3 emits a thinking segment. These should not be stored in
 * cognitive artifacts. This function removes them and returns only
 * the final answer content.
 */
export function stripThinkTags(text: string): string {
  // Remove <think>...</think> blocks (DeepSeek-R1 style)
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Remove standalone <think> tags if not properly closed
  result = result.replace(/<think>[\s\S]*$/i, "");
  // Remove leading/trailing whitespace
  return result.trim();
}
