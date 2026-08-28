/**
 * Cortex metacognition runner — invoked by Windows scheduled tasks.
 *
 *   npx tsx scripts/run-metacognition.ts <audit|threads|all> [--agent arlo]
 *
 *   audit   → runWeeklyAudit: analyzes the week's reasoning traces (confidence
 *             calibration, patterns, bias) → cognitive_artifacts.
 *   threads → runAllThreads: strategic / operational / relational background
 *             cognition → background_threads (operational no-ops without
 *             OpenClaw cron; relational no-ops until relationship_graph seeded).
 *
 * Runs host-side against the shared DB (DATABASE_URL) and the LLM proxy
 * (ANTHROPIC_BASE_URL). These tools are MCP-only (no REST endpoint), so this
 * CLI is how a scheduler triggers them.
 */
import { db, schema, initDatabase } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import { runWeeklyAudit } from "../src/metacognition/audit.js";
import { runAllThreads } from "../src/cognition/background-threads.js";
import "dotenv/config";

const mode = (process.argv[2] || "all").toLowerCase();
const rest = process.argv.slice(3);
const agentExt = rest.includes("--agent") ? rest[rest.indexOf("--agent") + 1] : "arlo";

async function main() {
  if (!["audit", "threads", "all"].includes(mode)) {
    console.error(`Unknown mode "${mode}". Use: audit | threads | all`);
    process.exit(2);
  }

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

  if (mode === "audit" || mode === "all") {
    try {
      const r = await runWeeklyAudit(agent.id);
      console.log(
        `${ts}  [audit]  traces=${r.tracesAnalyzed}  avgConfidence=${Number(r.avgConfidence ?? 0).toFixed(2)}  patterns=${r.patterns.length}  recommendations=${r.recommendations.length}`
      );
    } catch (e) {
      console.error(`${ts}  [audit]  ERROR ${(e as Error)?.message || e}`);
    }
  }

  if (mode === "threads" || mode === "all") {
    try {
      const r = await runAllThreads(agent.id);
      console.log(`${ts}  [threads] OK ${JSON.stringify(Object.keys(r))}`);
    } catch (e) {
      console.error(`${ts}  [threads] ERROR ${(e as Error)?.message || e}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[metacognition] fatal:", e);
  process.exit(1);
});
