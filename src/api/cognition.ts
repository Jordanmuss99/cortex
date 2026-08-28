import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

const router = Router();

const r3 = (x: any): number | null =>
  x == null ? null : Math.round(Number(x) * 1000) / 1000;
const r2 = (x: any): number | null =>
  x == null ? null : Math.round(Number(x) * 100) / 100;

/**
 * GET /api/v1/cognition?agentId=arlo
 *
 * Live cognition layer for the dashboard: emotional valence per memory,
 * cognitive artifacts, the relationship graph, the latest principal state,
 * principal-state history (for sparklines), the latest self-diagnostics
 * (so the UI can explain the health badge), and background threads.
 *
 * Mirrors what scripts/refresh-cognition.ps1 bakes into cognition-data.js,
 * but served live. The dashboard tries this endpoint first and falls back
 * to the static snapshot when it is not deployed.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    if (!agentId) {
      res.status(400).json({ error: "agentId query parameter is required" });
      return;
    }

    const agentResult = await db.execute(sql`
      SELECT id, external_id, name FROM agents WHERE external_id = ${agentId}
    `);
    if (agentResult.rows.length === 0) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }
    const agent = agentResult.rows[0] as { id: number; external_id: string; name: string };
    const aid = agent.id;

    // ── Emotional valence (one row per memory) ──────────────
    const valenceResult = await db.execute(sql`
      SELECT memory_id, valence, arousal, dominance, intensity,
             recall_boost, decay_resistance, dominant_dimension
      FROM emotional_valence WHERE agent_id = ${aid}
    `);
    const valence: Record<string, any> = {};
    for (const row of valenceResult.rows as any[]) {
      valence[row.memory_id] = {
        v: r3(row.valence),
        a: r3(row.arousal),
        d: r3(row.dominance),
        intensity: r3(row.intensity),
        recallBoost: r3(row.recall_boost),
        decayResist: r3(row.decay_resistance),
        dominant: row.dominant_dimension,
      };
    }

    // ── Cognitive artifacts (content is JSONB → text-trimmed) ─
    const artifactsResult = await db.execute(sql`
      SELECT id, artifact_type, left(content::text, 4000) AS content,
             resonance_score, to_char(created_at, 'YYYY-MM-DD') AS created
      FROM cognitive_artifacts WHERE agent_id = ${aid}
      ORDER BY created_at DESC LIMIT 80
    `);
    const artifacts = (artifactsResult.rows as any[]).map((a) => ({
      id: a.id,
      type: a.artifact_type,
      content: a.content,
      resonance: r2(a.resonance_score),
      created: a.created,
    }));

    // ── Relationship graph ──────────────────────────────────
    const relResult = await db.execute(sql`
      SELECT person_name, relationship_type,
             to_char(last_contact, 'YYYY-MM-DD') AS last_contact,
             importance_score, open_items, notes
      FROM relationship_graph WHERE agent_id = ${aid}
      ORDER BY importance_score DESC NULLS LAST
    `);
    const relationships = (relResult.rows as any[]).map((r) => ({
      name: r.person_name,
      type: r.relationship_type,
      last_contact: r.last_contact,
      importance: r.importance_score,
      open_items: r.open_items,
      notes: r.notes,
    }));

    // ── Principal state: latest + history (asc) for sparklines ─
    const psResult = await db.execute(sql`
      SELECT energy, stress, focus_state, emotional_valence, adhd_state,
             confidence_score, to_char(timestamp, 'YYYY-MM-DD HH24:MI') AS at
      FROM principal_state WHERE agent_id = ${aid}
      ORDER BY timestamp DESC LIMIT 1
    `);
    const psRow = psResult.rows[0] as any | undefined;
    const principalState = psRow
      ? {
          energy: r3(psRow.energy),
          stress: r3(psRow.stress),
          focus: psRow.focus_state,
          valence: r3(psRow.emotional_valence),
          adhd: psRow.adhd_state,
          confidence: r2(psRow.confidence_score),
          at: psRow.at,
        }
      : null;

    const histResult = await db.execute(sql`
      SELECT energy, stress, confidence_score, emotional_valence,
             to_char(timestamp, 'YYYY-MM-DD HH24:MI') AS at
      FROM principal_state WHERE agent_id = ${aid}
      ORDER BY timestamp DESC LIMIT 60
    `);
    const stateHistory = (histResult.rows as any[])
      .map((h) => ({
        at: h.at,
        energy: r3(h.energy),
        stress: r3(h.stress),
        confidence: r2(h.confidence_score),
        valence: r3(h.emotional_valence),
      }))
      .reverse();

    // ── Self-diagnostics (latest) — explains the health badge ─
    const diagResult = await db.execute(sql`
      SELECT overall_health, drift_score, alerts,
             to_char(timestamp, 'YYYY-MM-DD HH24:MI') AS at
      FROM self_diagnostics WHERE agent_id = ${aid}
      ORDER BY timestamp DESC LIMIT 1
    `);
    const diagRow = diagResult.rows[0] as any | undefined;
    const selfDiagnostics = diagRow
      ? {
          health: diagRow.overall_health,
          drift: r2(diagRow.drift_score),
          alerts: diagRow.alerts || [],
          at: diagRow.at,
        }
      : null;

    // ── Background threads (autonomous cognition) ───────────
    const btResult = await db.execute(sql`
      SELECT thread_type, status, next_action,
             to_char(last_run, 'YYYY-MM-DD HH24:MI') AS last_run
      FROM background_threads WHERE agent_id = ${aid}
      ORDER BY updated_at DESC LIMIT 10
    `);
    const backgroundThreads = (btResult.rows as any[]).map((t) => ({
      type: t.thread_type,
      status: t.status,
      nextAction: t.next_action,
      lastRun: t.last_run,
    }));

    res.json({
      generatedAt: new Date().toISOString().slice(0, 19),
      agent: agent.external_id,
      live: true,
      valence,
      artifacts,
      relationships,
      principalState,
      stateHistory,
      selfDiagnostics,
      backgroundThreads,
      counts: {
        valence: Object.keys(valence).length,
        artifacts: artifacts.length,
        relationships: relationships.length,
      },
    });
  } catch (err) {
    console.error("[cognition] Error:", err);
    res.status(500).json({ error: "Cognition query failed" });
  }
});

export { router as cognitionRouter };
