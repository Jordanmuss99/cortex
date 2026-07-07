/**
 * Backfill novelty_score for memories with corrupt or missing values.
 *
 * Run after fixing sparseOverlap (min-sum -> dot-product). Recomputes CA1
 * novelty against the current network and updates memory_nodes + hippocampal_codes.
 *
 * Run: npx tsx scripts/backfill-novelty.ts [--agent arlo] [--batch 100] [--dry-run]
 */
import { db, initDatabase } from "../src/db/index.js";
import { sql } from "drizzle-orm";
import { computeNovelty } from "../src/hippocampus/ca1-novelty.js";
import type { SparseCode } from "../src/hippocampus/types.js";
import "dotenv/config";

const args = process.argv.slice(2);
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;
const batchSize = args.includes("--batch") ? parseInt(args[args.indexOf("--batch") + 1]) : 100;
const dryRun = args.includes("--dry-run");

async function main() {
  await initDatabase();

  let agentId: number | null = null;
  if (agentFilter) {
    const agentResult = await db.execute(sql`
      SELECT id FROM agents WHERE external_id = ${agentFilter} LIMIT 1
    `);
    if (agentResult.rows.length === 0) {
      console.error(`Agent "${agentFilter}" not found`);
      process.exit(1);
    }
    agentId = (agentResult.rows[0] as { id: number }).id;
    console.log(`[backfill-novelty] Agent: ${agentFilter} (id: ${agentId})`);
  }

  const countResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt
    FROM memory_nodes mn
    JOIN hippocampal_codes hc ON hc.memory_id = mn.id
    WHERE mn.status = 'active'
      AND mn.embedding IS NOT NULL
      ${agentId !== null ? sql`AND mn.agent_id = ${agentId}` : sql``}
  `);
  const total = Number((countResult.rows[0] as { cnt: string }).cnt);
  console.log(`[backfill-novelty] ${total} memories to recompute`);

  if (dryRun) {
    console.log("[backfill-novelty] Dry run -- exiting");
    process.exit(0);
  }

  let processed = 0;
  let errors = 0;
  let lastId = 0;

  while (processed + errors < total) {
    const batch = await db.execute(sql`
      SELECT mn.id, mn.agent_id, mn.embedding, mn.priority,
             hc.sparse_indices, hc.sparse_values, hc.sparse_dim
      FROM memory_nodes mn
      JOIN hippocampal_codes hc ON hc.memory_id = mn.id
      WHERE mn.status = 'active'
        AND mn.embedding IS NOT NULL
        AND mn.id > ${lastId}
        ${agentId !== null ? sql`AND mn.agent_id = ${agentId}` : sql``}
      ORDER BY mn.id ASC
      LIMIT ${batchSize}
    `);

    const rows = batch.rows as Array<{
      id: number;
      agent_id: number;
      embedding: string;
      priority: number;
      sparse_indices: number[];
      sparse_values: number[];
      sparse_dim: number;
    }>;

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      try {
        const embedding = (row.embedding as string)
          .slice(1, -1)
          .split(",")
          .map(Number);

        if (embedding.length !== 1024) {
          errors++;
          continue;
        }

        const sparseCode: SparseCode = {
          indices: row.sparse_indices,
          values: row.sparse_values,
          dim: row.sparse_dim,
        };

        const result = await computeNovelty(
          row.agent_id,
          embedding,
          sparseCode,
          row.priority
        );

        await db.execute(sql`
          UPDATE memory_nodes SET novelty_score = ${result.noveltyScore} WHERE id = ${row.id}
        `);
        await db.execute(sql`
          UPDATE hippocampal_codes SET novelty_score = ${result.noveltyScore} WHERE memory_id = ${row.id}
        `);

        processed++;
      } catch (err) {
        console.error(`[backfill-novelty] Memory #${row.id} failed:`, err);
        errors++;
      }
    }

    const pct = ((processed / total) * 100).toFixed(1);
    console.log(`[backfill-novelty] Progress: ${processed}/${total} (${pct}%) -- ${errors} errors`);
  }

  // Post-check distribution
  const stats = await db.execute(sql`
    SELECT
      COUNT(*) AS n,
      ROUND(AVG(mn.novelty_score)::numeric, 3) AS mean,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mn.novelty_score))::numeric, 3) AS median,
      COUNT(*) FILTER (WHERE mn.novelty_score < 0) AS neg,
      COUNT(*) FILTER (WHERE mn.novelty_score BETWEEN 0 AND 1) AS ok
    FROM memory_nodes mn
    WHERE mn.status = 'active' AND mn.novelty_score IS NOT NULL
      ${agentId !== null ? sql`AND mn.agent_id = ${agentId}` : sql``}
  `);
  console.log("\n[backfill-novelty] Post-check:", stats.rows[0]);
  console.log(`[backfill-novelty] Complete: ${processed} updated, ${errors} errors`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-novelty] Fatal:", err);
  process.exit(1);
});
