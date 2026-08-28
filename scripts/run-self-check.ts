#!/usr/bin/env tsx
/**
 * Cortex self-check runner -- invoked by the cron sidecar.
 *
 *   npx tsx scripts/run-self-check.ts [--agent arlo] [--verbose]
 *
 * Runs the full proprioceptive self-check (skills, cron, channels, drift,
 * cognitive integrity) and stores the result in self_diagnostics. In
 * headless mode (CORTEX_HEADLESS=true) the OpenClaw file checks are skipped.
 */
import { db, schema, initDatabase } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import { runSelfCheck, formatDiagnostic } from "../src/proprioception/self-check.js";
import "dotenv/config";

const rest = process.argv.slice(2);
const agentExt = rest.includes("--agent") ? rest[rest.indexOf("--agent") + 1] : "arlo";
const verbose = rest.includes("--verbose");

async function main() {
  await initDatabase();

  const [agent] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.externalId, agentExt));
  if (!agent) {
    console.error(`Agent "${agentExt}" not found`);
    process.exit(1);
  }

  const ts = new Date().toISOString();
  try {
    const result = await runSelfCheck(agent.id, verbose);
    console.log(`${ts}  [self-check]  health=${result.overallHealth}  alerts=${result.alerts.length}  drift=${result.driftScore.toFixed(2)}`);
    console.log(formatDiagnostic(result, verbose));
  } catch (e) {
    console.error(`${ts}  [self-check]  ERROR ${(e as Error)?.message || e}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[self-check] fatal:", e);
  process.exit(1);
});
