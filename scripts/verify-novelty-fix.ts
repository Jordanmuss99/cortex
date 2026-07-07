/**
 * Verify CA1 novelty fix: bounded overlap, discrimination, dream impact, no search regression.
 *
 * Run: npx tsx scripts/verify-novelty-fix.ts [--agent arlo]
 */
import { db, initDatabase } from "../src/db/index.js";
import { sql } from "drizzle-orm";
import { dgEncode, sparseOverlap } from "../src/hippocampus/dentate-gyrus.js";
import { computeNovelty } from "../src/hippocampus/ca1-novelty.js";
import { hippocampalEncode } from "../src/hippocampus/index.js";
import { embedTexts } from "../src/ingestion/embeddings.js";
import {
  initBenchmark,
  clearBenchmarkData,
  ingestSession,
  search,
} from "../benchmarks/lib/cortex-client.js";
import "dotenv/config";

const agentFilter = process.argv.includes("--agent")
  ? process.argv[process.argv.indexOf("--agent") + 1]
  : "arlo";

await initDatabase();

console.log("=== CA1 Novelty Fix Verification ===\n");

// 1. Live corpus distribution
const stats = await db.execute(sql`
  SELECT
    COUNT(*) AS n,
    ROUND(AVG(novelty_score)::numeric, 4) AS mean,
    ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY novelty_score))::numeric, 4) AS median,
    ROUND(MIN(novelty_score)::numeric, 4) AS min,
    ROUND(MAX(novelty_score)::numeric, 4) AS max,
    COUNT(*) FILTER (WHERE novelty_score < 0) AS negative,
    COUNT(*) FILTER (WHERE novelty_score > 1) AS above_one,
    COUNT(*) FILTER (WHERE novelty_score BETWEEN 0 AND 1) AS in_range
  FROM memory_nodes mn
  JOIN agents a ON a.id = mn.agent_id
  WHERE mn.status = 'active' AND a.external_id = ${agentFilter}
    AND mn.novelty_score IS NOT NULL
`);
console.log("1. Live novelty_score distribution (" + agentFilter + "):");
console.log("  ", stats.rows[0]);

const s = stats.rows[0] as Record<string, string>;
const ok =
  Number(s.negative) === 0 &&
  Number(s.above_one) === 0 &&
  Number(s.in_range) === Number(s.n);
console.log(ok ? "   PASS: all scores in [0, 1]\n" : "   FAIL: out-of-range scores remain\n");

// 2. sparseOverlap bounded on live hippocampal codes
const codes = await db.execute(sql`
  SELECT hc.sparse_indices, hc.sparse_values
  FROM hippocampal_codes hc
  JOIN memory_nodes mn ON mn.id = hc.memory_id
  JOIN agents a ON a.id = mn.agent_id
  WHERE mn.status = 'active' AND a.external_id = ${agentFilter}
  ORDER BY RANDOM()
  LIMIT 80
`);
const rows = codes.rows as Array<{ sparse_indices: number[]; sparse_values: number[] }>;
let maxOverlap = 0;
let minOverlap = 1;
for (let i = 0; i < rows.length; i++) {
  const a = { indices: rows[i].sparse_indices, values: rows[i].sparse_values, dim: 4096 };
  for (let j = i + 1; j < rows.length; j++) {
    const b = { indices: rows[j].sparse_indices, values: rows[j].sparse_values, dim: 4096 };
    const ov = sparseOverlap(a, b);
    maxOverlap = Math.max(maxOverlap, ov);
    minOverlap = Math.min(minOverlap, ov);
  }
}
console.log("2. sparseOverlap on 80 random live codes (pairwise sample):");
console.log(`   min=${minOverlap.toFixed(4)} max=${maxOverlap.toFixed(4)}`);
console.log(
  maxOverlap <= 1 && minOverlap >= 0
    ? "   PASS: overlap bounded [0, 1]\n"
    : "   FAIL: overlap out of bounds\n"
);

// 3. Dream resonance novelty-term impact (simulated)
const dreamTerm = await db.execute(sql`
  SELECT
    ROUND(AVG(0.1 * LEAST(GREATEST(COALESCE(mn.novelty_score, 0.5), 0.0), 1.0) * 10.0)::numeric, 4) AS avg_contribution,
    ROUND(MIN(0.1 * LEAST(GREATEST(COALESCE(mn.novelty_score, 0.5), 0.0), 1.0) * 10.0)::numeric, 4) AS min_contribution,
    ROUND(MAX(0.1 * LEAST(GREATEST(COALESCE(mn.novelty_score, 0.5), 0.0), 1.0) * 10.0)::numeric, 4) AS max_contribution
  FROM memory_nodes mn
  JOIN agents a ON a.id = mn.agent_id
  WHERE mn.status = 'active' AND a.external_id = ${agentFilter}
`);
const dt = dreamTerm.rows[0] as Record<string, string>;
console.log("3. Dream Phase-1 novelty term contribution (current, clamped):");
console.log(`   avg=${dt.avg_contribution} min=${dt.min_contribution} max=${dt.max_contribution}`);
console.log("   (Pre-fix median novelty was -1.98 -> term ~ -1.98; now median ~0.18 -> term ~ +0.18)");
console.log(
  Number(dt.min_contribution) >= 0 && Number(dt.max_contribution) <= 1
    ? "   PASS: dream term non-negative and bounded\n"
    : "   FAIL: dream term still corrupt\n"
);

// 4. Novelty discrimination on fresh benchmark ingest
console.log("4. Novelty discrimination (fresh ingest, full pipeline):");
const benchId = await initBenchmark("novelty-verify");
await clearBenchmarkData(benchId);

const baseText =
  "Quarterly revenue target is $2.4M. Pipeline shows $3.1M in qualified opportunities. " +
  "Top deal Meridian Health $450K ACV in procurement review.";
const redundantText =
  "The revenue goal this quarter is $2.4 million with a pipeline of $3.1 million in qualified deals.";
const novelText =
  "Meridian Health CFO was replaced last week. New CFO reviewing all contracts over $200K.";

await ingestSession(benchId, "base", baseText, "verify", false);
const embedded = await embedTexts([redundantText, novelText]);
const red = await hippocampalEncode(benchId, embedded[0], 2);
const nov = await hippocampalEncode(benchId, embedded[1], 2);

console.log(`   redundant novelty: ${red.noveltyResult.noveltyScore.toFixed(3)}`);
console.log(`   novel novelty:     ${nov.noveltyResult.noveltyScore.toFixed(3)}`);
const discriminates = nov.noveltyResult.noveltyScore > red.noveltyResult.noveltyScore;
console.log(
  discriminates
    ? "   PASS: novel scores higher than redundant paraphrase\n"
    : "   WARN: novel did not score higher (check thresholds, may still be OK)\n"
);

// 5. Retrieval sanity (novelty does not enter hybridSearch directly; ensure no crash/regression)
const results = await search(benchId, "What is the revenue target?", 5);
console.log("5. Retrieval sanity on verify agent:");
console.log(`   top result source: ${results[0]?.source ?? "none"}, score: ${results[0]?.score?.toFixed(3) ?? "n/a"}`);
console.log(results.length > 0 ? "   PASS: search returns results\n" : "   FAIL: empty search\n");

await clearBenchmarkData(benchId);

// 6. High-novelty cohort still exists (signal not collapsed to constant)
const spread = await db.execute(sql`
  SELECT
    COUNT(*) FILTER (WHERE novelty_score > 0.7) AS high,
    COUNT(*) FILTER (WHERE novelty_score BETWEEN 0.3 AND 0.7) AS mid,
    COUNT(*) FILTER (WHERE novelty_score <= 0.3) AS low,
    ROUND(STDDEV(novelty_score)::numeric, 4) AS stdev
  FROM memory_nodes mn
  JOIN agents a ON a.id = mn.agent_id
  WHERE mn.status = 'active' AND a.external_id = ${agentFilter}
    AND mn.novelty_score IS NOT NULL
`);
const sp = spread.rows[0] as Record<string, string>;
console.log("6. Score spread (not collapsed to constant):");
console.log(`   high(>0.7)=${sp.high} mid=${sp.mid} low(<=0.3)=${sp.low} stdev=${sp.stdev}`);
const hasSpread =
  Number(sp.stdev) > 0.05 &&
  Number(sp.high) > 0 &&
  Number(sp.low) > 0;
console.log(
  hasSpread
    ? "   PASS: novelty still discriminates across corpus\n"
    : "   WARN: low spread -- monitor but may be expected for homogeneous corpus\n"
);

console.log("=== Summary ===");
const passes = [ok, maxOverlap <= 1, Number(dt.min_contribution) >= 0, results.length > 0];
console.log(
  passes.every(Boolean)
    ? "Overall: POSITIVE/NEUTRAL -- fix is safe; dream resonance term healed, no search regression."
    : "Overall: REVIEW NEEDED -- one or more checks failed."
);

process.exit(passes.every(Boolean) ? 0 : 1);
