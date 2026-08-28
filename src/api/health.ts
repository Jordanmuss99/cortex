import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

const router = Router();

/**
 * GET /api/v1/health
 * Basic health check.
 */
router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "cortex-v2",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/v1/agents
 * List all agents.
 */
router.get("/agents", async (_req: Request, res: Response) => {
  try {
    const agentsResult = await db.execute(sql`
      SELECT id, external_id AS "externalId", name FROM agents ORDER BY id ASC
    `);
    res.json(agentsResult.rows);
  } catch (err) {
    console.error("[agents] Error:", err);
    res.status(500).json({ error: "Failed to list agents" });
  }
});

/**
 * GET /api/v1/status
 * Detailed system status with stats.
 */
export interface CortexStatusResponse {
  status: "ok";
  service: string;
  version: string;
  stats: Record<string, unknown>;
}

export async function loadCortexStatus(
  agentExternalId?: string
): Promise<CortexStatusResponse> {
  const bound = agentExternalId !== undefined;
  const memoryCountResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM memory_nodes WHERE status = 'active'
    ${bound ? sql`AND agent_id = (SELECT id FROM agents WHERE external_id = ${agentExternalId})` : sql``}
  `);

  const synapseCountResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM memory_synapses AS synapse
    ${bound ? sql`
      WHERE synapse.agent_id = (SELECT id FROM agents WHERE external_id = ${agentExternalId})
        AND synapse.memory_a IN (
          SELECT id FROM memory_nodes WHERE agent_id = (
            SELECT id FROM agents WHERE external_id = ${agentExternalId}
          )
        )
        AND synapse.memory_b IN (
          SELECT id FROM memory_nodes WHERE agent_id = (
            SELECT id FROM agents WHERE external_id = ${agentExternalId}
          )
        )
    ` : sql``}
  `);

  const avgResonanceResult = await db.execute(sql`
    SELECT COALESCE(AVG(resonance_score), 0) as avg_resonance
    FROM memory_nodes WHERE status = 'active'
    ${bound ? sql`AND agent_id = (SELECT id FROM agents WHERE external_id = ${agentExternalId})` : sql``}
  `);

  const statusBreakdown = await db.execute(sql`
    SELECT status, COUNT(*) as count
    FROM memory_nodes
    ${bound ? sql`WHERE agent_id = (SELECT id FROM agents WHERE external_id = ${agentExternalId})` : sql``}
    GROUP BY status
  `);

  const sourceBreakdown = await db.execute(sql`
    SELECT source_type, COUNT(*) as count
    FROM memory_nodes WHERE status = 'active'
    ${bound ? sql`AND agent_id = (SELECT id FROM agents WHERE external_id = ${agentExternalId})` : sql``}
    GROUP BY source_type
  `);

  const lastDream = await db.execute(sql`
    SELECT cycle_type, stats, started_at, completed_at
    FROM dream_cycle_logs
    ${bound ? sql`WHERE agent_id = (SELECT id FROM agents WHERE external_id = ${agentExternalId})` : sql``}
    ORDER BY started_at DESC
    LIMIT 1
  `);

  const agentCountResult = await db.execute(sql`
    SELECT COUNT(id) as count FROM agents
    ${bound ? sql`WHERE external_id = ${agentExternalId}` : sql``}
  `);

  const memoryCount = memoryCountResult.rows[0] as { count: string } | undefined;
  const synapseCount = synapseCountResult.rows[0] as { count: string } | undefined;
  const avgResonance = avgResonanceResult.rows[0] as { avg_resonance: string } | undefined;
  const agentCount = agentCountResult.rows[0] as { count: string } | undefined;

  return {
    status: "ok",
    service: "cortex-v2",
    version: "0.1.0",
    stats: {
      agents: agentCount?.count ?? 0,
      totalMemories: memoryCount?.count ?? 0,
      totalSynapses: synapseCount?.count ?? 0,
      avgResonance: Number(avgResonance?.avg_resonance ?? 0).toFixed(2),
      memoryByStatus: statusBreakdown.rows,
      memoryBySource: sourceBreakdown.rows,
      lastDreamCycle: lastDream.rows.length > 0 ? lastDream.rows[0] : null,
    },
  };
}

router.get("/status", async (req: Request, res: Response) => {
  try {
    const selector = req.query.agentId;
    if (selector !== undefined && typeof selector !== "string") {
      res.status(400).json({ error: "agentId must be supplied once" });
      return;
    }
    res.json(await loadCortexStatus(selector));
  } catch (err) {
    console.error("[status] Error:", err);
    res.status(500).json({ error: "Status check failed" });
  }
});

export { router as healthRouter };
