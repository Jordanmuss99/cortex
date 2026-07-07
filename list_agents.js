import { db } from "./src/db/index.js";
import { sql } from "drizzle-orm";

async function run() {
  try {
    const res = await db.execute(sql`SELECT id, external_id, name FROM agents`);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
