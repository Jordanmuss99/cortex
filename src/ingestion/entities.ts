/**
 * Entity extraction from text.
 *
 * Two modes:
 *   - Fast (default): Known-entity matching + proper noun regex. No API calls.
 *   - LLM: Claude API call for semantic NER with co-reference resolution.
 *     Set CORTEX_LLM_ENTITIES=true to enable (costs ~0.001 per ingest).
 *
 * The fast mode always runs first. LLM mode supplements with entities
 * that regex can't catch ("the CEO" → "Jane Smith").
 */
import { llmComplete } from "../lib/llm.js";

// Add your known entities here for fast matching.
// Format: "Canonical Name": ["alias1", "alias2", ...]
const KNOWN_ENTITIES: Record<string, string[]> = {
  // — People / identity —
  "Jordan (Jordanmuss99)": ["jordanmuss99"],
  // — Projects —
  "rts_fps": ["rts_fps", "rts fps"],
  "Sbox-Claude": ["sbox-claude", "sbox claude", "claudebridge", "sbox-mcp", "claude bridge"],
  "ADHDPlan": ["adhdplan", "adhd planner", "adhd plan"],
  "Pterodactyl MC server": ["pterodactyl", "just-create-smp"],
  // — Stack / tooling —
  "s&box": ["s&box", "sbox", "facepunch"],
  "Cortex": ["cortex"],
  "OpenCode": ["opencode"],
  "OpenClaw": ["openclaw"],
  "oh-my-opencode (OMO)": ["oh-my-opencode", "oh-my-openagent", "sisyphus"],
  "oh-my-claudecode (OMC)": ["oh-my-claudecode"],
  "Meridian proxy": ["meridian"],
  "Voyage embeddings": ["voyage-3", "voyageai"],
  "Linear": ["linear.app", "obsidian-network"],
  "CodeRabbit": ["coderabbit"],
  // — rts_fps architecture (ADR-001) —
  "ADR-001": ["adr-001"],
  "OrderRouter": ["orderrouter"],
  "PossessionRouter": ["possessionrouter"],
  "MatchManager": ["matchmanager"],
  // — SimsOnline (dedicated authoritative server project) —
  "SimsOnline": ["simsonline", "sims online"],
  "DedicatedServer": ["dedicatedserver"],
  "SimsOnlineServerHostMod": ["simsonlineserverhostmod", "serverhostmod"],
  "The Sims 3": ["sims 3", "the sims", "ts3w.exe", "ts3"],
  "Sunset Valley": ["sunset valley"],
  "ObjectGuid": ["objectguid"],
  "Fable 5": ["fable 5", "claude-fable"],
};

// Words that frequently start a Title-Case phrase only because of sentence
// position or label formatting, not because they are part of a proper noun.
// Stripped (repeatedly) from the front of regex-extracted phrases.
const LEADING_STOPWORDS = new Set([
  "the", "a", "an", "in", "on", "at", "of", "for", "to", "with", "from", "by",
  "this", "that", "these", "those", "if", "when", "while", "after", "before",
  "during", "and", "but", "or", "as", "is", "are", "was", "were", "not", "no",
  "my", "our", "your", "his", "her", "its", "their", "it", "we", "you", "they",
  "he", "she", "all", "each", "every", "some", "any", "more", "most", "other",
  "into", "over", "under", "about", "via", "per", "vs", "last", "next",
  "user", "use", "using", "used", "runs", "run", "running", "see", "also",
  "then", "now", "here", "there", "what", "which", "who", "how", "why",
  "where", "do", "does", "did", "done", "will", "would", "should", "could",
  "may", "might", "must", "can", "cannot", "please", "note",
]);

// Exact phrases (lowercased) that pass the Title-Case shape test but are
// process/status/filesystem vocabulary, not entities. Sourced from junk
// observed in production entity arrays plus obvious generics.
const JUNK_PHRASES = new Set([
  "in progress", "work in progress", "program files", "dev work",
  "agent platform", "active node", "process coordination", "rich sim",
  "save gameplay", "player same", "in phase", "next steps", "open questions",
  "known issues", "quick start", "getting started", "pull request",
  "pull requests", "code review", "root cause", "action item", "action items",
  "follow up", "status update", "high priority", "low priority",
  "best practices", "edge case", "edge cases", "key insight",
  "lessons learned", "final state", "current state", "live evidence",
  "error message", "command line", "breaking change", "breaking changes",
  "side effects", "file path",
]);

/**
 * Refine a regex-extracted Title-Case phrase into an acceptable entity, or
 * null if it is junk. Strips leading sentence-position stopwords, enforces
 * the 2-3 word window, and rejects blocklisted process vocabulary.
 */
export function refineProperNounPhrase(phrase: string): string | null {
  const words = phrase.trim().split(/\s+/);
  while (words.length > 0 && LEADING_STOPWORDS.has(words[0].toLowerCase())) {
    words.shift();
  }
  if (words.length < 2 || words.length > 3) return null;
  if (words.every((w) => LEADING_STOPWORDS.has(w.toLowerCase()))) return null;
  const joined = words.join(" ");
  if (JUNK_PHRASES.has(joined.toLowerCase())) return null;
  return joined;
}

/**
 * Is a stored entity string junk under the current rules? Used by the
 * cleanup backfill (scripts/cleanup-junk-entities.ts) to retro-filter entity
 * arrays. Conservative: only strings shaped like regex-extracted Title-Case
 * phrases are re-evaluated; known canonicals, single words, and unusual
 * casings (rts_fps, s&box, ADR-001) are always kept.
 */
export function isJunkStoredEntity(entity: string): boolean {
  const trimmed = entity.trim();
  if (JUNK_PHRASES.has(trimmed.toLowerCase())) return true;
  if (trimmed in KNOWN_ENTITIES) return false;
  const titleCaseShape =
    /^(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*)(?:\s+[A-Z][a-z]+(?:[A-Z][a-z]+)*){1,2}$/;
  if (!titleCaseShape.test(trimmed)) return false;
  return refineProperNounPhrase(trimmed) !== trimmed;
}

const USE_LLM_ENTITIES = process.env.CORTEX_LLM_ENTITIES === "true";

/**
 * Fast entity extraction: known-entity matching + proper noun regex.
 */
function extractEntitiesFast(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  for (const [canonical, aliases] of Object.entries(KNOWN_ENTITIES)) {
    for (const alias of aliases) {
      if (lower.includes(alias.toLowerCase())) {
        found.add(canonical);
        break;
      }
    }
  }

  // Also extract capitalized multi-word phrases (proper nouns).
  // Words may contain internal capitals (McAllister, GameObject) so names
  // like "Fiona McAllister" are captured whole instead of truncating at the
  // internal capital ("Fiona Mc"). Each match is refined: leading
  // sentence-position stopwords stripped, junk process vocabulary rejected.
  // Separator is spaces/tabs only -- \s+ would merge Title words across
  // line breaks into garbage entities ("Root Cause\n\nThe").
  const properNouns = text.match(
    /(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*)(?:[ \t]+[A-Z][a-z]+(?:[A-Z][a-z]+)*)+/g
  );
  if (properNouns) {
    for (const noun of properNouns) {
      const refined = refineProperNounPhrase(noun);
      if (refined && !found.has(refined)) {
        found.add(refined);
      }
    }
  }

  return Array.from(found);
}

/**
 * LLM-based entity extraction with co-reference resolution.
 * Returns canonical entity names, resolving aliases and references.
 */
async function extractEntitiesLLM(text: string, fastEntities: string[]): Promise<string[]> {
  try {
    const response = await llmComplete(
      [
        {
          role: "user",
          content: `Extract all named entities (people, companies, products, places) from this text. Resolve co-references ("the CEO" → "Jane Smith", "the parent company" → "Acme Corp"). Return ONLY a JSON array of canonical entity names, no explanation.

Known entities for disambiguation: ${Object.keys(KNOWN_ENTITIES).join(", ")}

Text:
${text.slice(0, 2000)}`,
        },
      ],
      { maxTokens: 256, temperature: 0 }
    );

    const match = response.content.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as string[];
      // Merge with fast entities, deduplicate
      const merged = new Set([...fastEntities, ...parsed.filter((e) => typeof e === "string" && e.length > 0)]);
      return Array.from(merged);
    }
  } catch (err) {
    console.error("[entities] LLM extraction failed, using fast-only:", err);
  }

  return fastEntities;
}

/**
 * Extract entities from text. Uses fast mode by default,
 * LLM mode if CORTEX_LLM_ENTITIES=true.
 */
export async function extractEntities(text: string): Promise<string[]> {
  const fast = extractEntitiesFast(text);

  if (USE_LLM_ENTITIES) {
    return extractEntitiesLLM(text, fast);
  }

  return fast;
}

/** Synchronous fast-only extraction (for backward compatibility in hot paths) */
export function extractEntitiesSync(text: string): string[] {
  return extractEntitiesFast(text);
}

/**
 * Extract simple semantic tags from text based on content patterns.
 */
export function extractSemanticTags(text: string): string[] {
  const tags = new Set<string>();
  const lower = text.toLowerCase();

  const patterns: [RegExp, string][] = [
    [/\bdecision\b|\bdecided\b|\bagreed\b/, "decision"],
    [/\btask\b|\btodo\b|\baction item\b/, "task"],
    [/\bmeeting\b|\bcall\b|\bsync\b/, "meeting"],
    [/\bprice\b|\bcost\b|\bpayment\b|\binvoice\b|\bbudget\b/, "financial"],
    [/\bbug\b|\bfix\b|\berror\b|\bissue\b/, "technical"],
    [/\bidea\b|\bconcept\b|\bbrainstorm\b/, "ideation"],
    [/\blearn\b|\blesson\b|\binsight\b/, "learning"],
    [/\bdeadline\b|\burgent\b|\basap\b/, "urgent"],
    [/\bfeedback\b|\breview\b/, "feedback"],
    [/\bpersonal\b|\bfamily\b|\bkids?\b/, "personal"],
    [/\bapi\b|\bcode\b|\bdeploy\b|\bserver\b/, "engineering"],
    [/\bstrategy\b|\bplan\b|\broadmap\b/, "strategy"],
  ];

  for (const [pattern, tag] of patterns) {
    if (pattern.test(lower)) {
      tags.add(tag);
    }
  }

  return Array.from(tags);
}
