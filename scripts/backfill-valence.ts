/**
 * Backfill emotional valence for memories that have no emotional_valence row.
 *
 * Run: npx tsx scripts/backfill-valence.ts [--agent arlo] [--batch 500] [--dry-run]
 *
 * analyzeValence is a zero-latency lexicon analyzer (no API calls). New memories
 * get valence at ingest time via the REST path (and the MCP path once enriched);
 * this backfills the existing corpus that was ingested through the bare MCP path.
 */
import { db, schema, initDatabase } from "../src/db/index.js";
import { sql } from "drizzle-orm";
import { analyzeValence } from "../src/valence/index.js";
import "dotenv/config";

const args = process.argv.slice(2);
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;
const batchSize = args.includes("--batch") ? parseInt(args[args.indexOf("--batch") + 1]) : 500;
const dryRun = args.includes("--dry-run");

async function main() {
  await initDatabase();

  let agentClause = sql``;
  if (agentFilter) {
    const a = await db.execute(sql`SELECT id FROM agents WHERE external_id = ${agentFilter} LIMIT 1`);
    if (a.rows.length === 0) {
      console.error(`Agent "${agentFilter}" not found`);
      process.exit(1);
    }
    const agentId = (a.rows[0] as { id: number }).id;
    agentClause = sql` AND mn.agent_id = ${agentId}`;
    console.log(`[valence] Filtering to agent ${agentFilter} (id ${agentId})`);
  }

  const countResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM memory_nodes mn
    WHERE mn.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM emotional_valence ev WHERE ev.memory_id = mn.id)
      ${agentClause}
  `);
  const totalMissing = Number((countResult.rows[0] as { cnt: string }).cnt);
  console.log(`[valence] ${totalMissing} active memories need valence analysis`);

  if (dryRun) {
    console.log("[valence] Dry run — exiting without changes");
    process.exit(0);
  }
  if (totalMissing === 0) {
    console.log("[valence] Nothing to do");
    process.exit(0);
  }

  let processed = 0;
  let errors = 0;

  while (processed + errors < totalMissing) {
    const batch = await db.execute(sql`
      SELECT mn.id, mn.agent_id, mn.content FROM memory_nodes mn
      WHERE mn.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM emotional_valence ev WHERE ev.memory_id = mn.id)
        ${agentClause}
      ORDER BY mn.id ASC
      LIMIT ${batchSize}
    `);
    const rows = batch.rows as Array<{ id: number; agent_id: number; content: string }>;
    if (rows.length === 0) break;

    const before = processed + errors;
    for (const row of rows) {
      try {
        const { vector: ev, salience } = analyzeValence(row.content || "");
        await db.insert(schema.emotionalValence).values({
          memoryId: row.id,
          agentId: row.agent_id,
          valence: ev.valence,
          arousal: ev.arousal,
          dominance: ev.dominance,
          certainty: ev.certainty,
          relevance: ev.relevance,
          urgency: ev.urgency,
          intensity: salience.intensity,
          decayResistance: salience.decayResistance,
          recallBoost: salience.recallBoost,
          dominantDimension: salience.dominantDimension,
        });
        processed++;
      } catch (err) {
        console.error(`[valence] Memory #${row.id} failed:`, err);
        errors++;
      }
    }
    // Guard against an infinite loop if every row in a batch errors (no progress).
    if (processed + errors === before) {
      console.error("[valence] Batch made no progress — aborting to avoid a loop");
      break;
    }
    const pct = (((processed + errors) / totalMissing) * 100).toFixed(1);
    console.log(`[valence] Progress: ${processed} analyzed, ${errors} errors (${pct}%)`);
  }

  console.log(`\n[valence] Complete: ${processed} analyzed, ${errors} errors`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[valence] Fatal:", err);
  process.exit(1);
});
