/**
 * Retro-filter junk entities out of memory_nodes.entities and drop
 * entity_shared synapses whose endpoints no longer share any entity.
 *
 * The fast extractor's old Title-Case regex minted process/status vocabulary
 * ("In Progress", "Program Files") as entities; each one wove 0.6-strength
 * entity_shared synapses, polluting CA3 recall and the dream cycle. The
 * extractor now refuses these (refineProperNounPhrase); this backfill applies
 * the same rules (isJunkStoredEntity) to the existing corpus.
 *
 * Run: npx tsx scripts/cleanup-junk-entities.ts [--agent arlo] [--apply]
 * Without --apply this is a dry run that only reports what would change.
 */
import { db, initDatabase } from "../src/db/index.js";
import { sql } from "drizzle-orm";
import { isJunkStoredEntity } from "../src/ingestion/entities.js";
import "dotenv/config";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;

async function main() {
  await initDatabase();

  let agentClause = sql``;
  if (agentFilter) {
    const a = await db.execute(sql`SELECT id FROM agents WHERE external_id = ${agentFilter} LIMIT 1`);
    if (a.rows.length === 0) {
      console.error(`Agent "${agentFilter}" not found`);
      process.exit(1);
    }
    agentClause = sql`AND agent_id = ${(a.rows[0] as { id: number }).id}`;
  }

  const nodes = await db.execute(sql`
    SELECT id, entities FROM memory_nodes
    WHERE status = 'active'
      AND entities IS NOT NULL
      AND array_length(entities, 1) > 0
      ${agentClause}
  `);

  const removedCounts = new Map<string, number>();
  let touched = 0;

  for (const row of nodes.rows as Array<{ id: number; entities: string[] }>) {
    const junk = row.entities.filter(isJunkStoredEntity);
    if (junk.length === 0) continue;
    touched++;
    for (const j of junk) removedCounts.set(j, (removedCounts.get(j) || 0) + 1);

    if (apply) {
      const kept = row.entities.filter((e) => !isJunkStoredEntity(e));
      // Same explicit text[] literal pattern as reconsolidation/index.ts
      const literal = `{${kept.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",")}}`;
      await db.execute(
        sql`UPDATE memory_nodes SET entities = ${literal}::text[] WHERE id = ${row.id}`
      );
    }
  }

  const mode = apply ? "" : "[dry-run] ";
  console.log(`${mode}memories with junk entities: ${touched} of ${nodes.rows.length} scanned`);
  const sorted = [...removedCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [entity, count] of sorted) {
    console.log(`  - "${entity}" x${count}`);
  }

  // entity_shared synapses whose endpoints share no entity (computed against
  // the arrays as they exist NOW -- after updates when --apply is set).
  const dangling = await db.execute(sql`
    SELECT COUNT(*) AS cnt
    FROM memory_synapses ms
    JOIN memory_nodes a ON a.id = ms.memory_a
    JOIN memory_nodes b ON b.id = ms.memory_b
    WHERE ms.connection_type = 'entity_shared'
      AND NOT (COALESCE(a.entities, '{}'::text[]) && COALESCE(b.entities, '{}'::text[]))
  `);
  console.log(
    `${mode}entity_shared synapses with no remaining shared entity: ${(dangling.rows[0] as { cnt: string }).cnt}`
  );

  if (apply) {
    const del = await db.execute(sql`
      DELETE FROM memory_synapses ms
      USING memory_nodes a, memory_nodes b
      WHERE ms.connection_type = 'entity_shared'
        AND a.id = ms.memory_a
        AND b.id = ms.memory_b
        AND NOT (COALESCE(a.entities, '{}'::text[]) && COALESCE(b.entities, '{}'::text[]))
    `);
    console.log(`deleted dangling entity_shared synapses: ${(del as { rowCount?: number }).rowCount ?? 0}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[cleanup] fatal:", e);
  process.exit(1);
});
