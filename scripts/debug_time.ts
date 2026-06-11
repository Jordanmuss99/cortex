import { db } from "../src/db/index.js";
import { sql } from "drizzle-orm";

async function main() {
  const result = await db.execute(sql`
    SELECT id, last_recalled_at, 
           EXTRACT(EPOCH FROM (NOW() - last_recalled_at)) * 1000 AS ms_since_recall
    FROM memory_nodes
    WHERE id = 1191
  `);
  
  const row = result.rows[0] as any;
  console.log("Memory DB Row:", row);
  console.log("ms_since_recall (from Postgres):", Number(row.ms_since_recall));
  console.log("Is LABILE_WINDOW closed via Postgres math?", Number(row.ms_since_recall) > 3600000);
  
  process.exit(0);
}
main().catch(console.error);
