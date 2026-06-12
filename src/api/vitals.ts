import { Router, Request, Response } from "express";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

const router = Router();

/**
 * GET /api/v1/vitals?agentId=arlo
 *
 * Memory-system observability + early-warning engine for the dashboard.
 * Computes trend series and evaluates warning rules server-side so any client
 * can render "things are starting to go awry" without duplicating logic.
 *
 * Every rule here corresponds to a failure mode this system actually hit:
 * em-dash drift criticals (2026-06-10), duplicate formation via the ungated
 * reflect path (2026-06-11), all-zero dream stats from the rowCount shim bug,
 * ingest-without-reconsolidate loop imbalance, the data-loss incident (stale
 * schedules), and the reconsolidation crash window (valid_until left set).
 *
 * All ages are computed in SQL (EXTRACT EPOCH) to stay timezone-proof.
 */

type Severity = "info" | "warn" | "critical";
interface Warning {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

// ── Tunable thresholds ──
// Defaults match the self-check semantics where one exists. Override any
// subset via the CORTEX_VITALS_THRESHOLDS env var as JSON, e.g.
//   CORTEX_VITALS_THRESHOLDS={"dreamWarnHours":40,"orphansWarn":50}
// (set it in .env; docker-compose passes it through). The effective values
// are echoed in the response payload as `thresholds`.
const THRESHOLD_DEFAULTS = {
  dupThreshold: Number(process.env.CORTEX_DUP_THRESHOLD || 0.88), // legacy env honored as default
  dupScanLimit: 200,
  emdashBoundary: 5,
  emdashCritical: 6,
  dreamWarnHours: 30,
  dreamCriticalHours: 72,
  reflectInfoHours: 48,
  reflectWarnHours: 96,
  threadsWarnHours: 72,
  synapseWarn: 0.25,
  synapseCritical: 0.15,
  hcWarn: 50,
  valenceInfo: 25,
  orphansWarn: 100,
  ratioMinIngests: 10,
  ratioFactor: 6,
  spikeMin: 10,
  spikeFactor: 3,
  streakWarn: 3,
  expiredGraceMinutes: 10,
};
// Hot-reload config file, re-read on every request so edits apply WITHOUT a
// container restart (env vars are frozen at container creation; this file is
// not). Container path is mounted from the host's ~/.cortex/config by
// docker-compose; host-side runs resolve the same file directly.
// Precedence: defaults < CORTEX_VITALS_THRESHOLDS env < config file.
const THRESHOLD_FILE_CANDIDATES = [
  process.env.CORTEX_VITALS_THRESHOLDS_FILE,
  "/app/config/vitals-thresholds.json",
  join(homedir(), ".cortex", "config", "vitals-thresholds.json"),
].filter(Boolean) as string[];

function mergeNumeric(base: typeof THRESHOLD_DEFAULTS, raw: string, label: string): typeof THRESHOLD_DEFAULTS {
  try {
    const o = JSON.parse(raw);
    const merged: any = { ...base };
    for (const k of Object.keys(THRESHOLD_DEFAULTS)) {
      if (typeof o[k] === "number" && Number.isFinite(o[k])) merged[k] = o[k];
    }
    return merged;
  } catch (e) {
    console.error(`[vitals] ${label} is not valid JSON - ignored:`, (e as Error).message);
    return { ...base };
  }
}

function loadThresholds(): typeof THRESHOLD_DEFAULTS {
  let t = { ...THRESHOLD_DEFAULTS };
  const envRaw = process.env.CORTEX_VITALS_THRESHOLDS;
  if (envRaw) t = mergeNumeric(t, envRaw, "CORTEX_VITALS_THRESHOLDS");
  for (const path of THRESHOLD_FILE_CANDIDATES) {
    try {
      const fileRaw = readFileSync(path, "utf-8");
      t = mergeNumeric(t, fileRaw, path);
      break; // first readable file wins
    } catch { /* candidate absent - try next */ }
  }
  return t;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const agentExt = (req.query.agentId as string) || "arlo";
    const agentResult = await db.execute(sql`
      SELECT id FROM agents WHERE external_id = ${agentExt}
    `);
    if (agentResult.rows.length === 0) {
      res.status(404).json({ error: `Agent '${agentExt}' not found` });
      return;
    }
    const agentId = (agentResult.rows[0] as { id: number }).id;
    const T = loadThresholds();

    // ── Daily write/activity series (14 days) ──
    // Independent reads: run concurrently (review finding: serial awaits
    // summed latency for no reason).
    const [writesRes, reconsRes, tracesRes, journalsRes] = await Promise.all([
      db.execute(sql`
        SELECT created_at::date AS day, source_type, COUNT(*) AS cnt
        FROM memory_nodes
        WHERE agent_id = ${agentId} AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY 1, 2 ORDER BY 1
      `),
      db.execute(sql`
        SELECT created_at::date AS day, COUNT(*) AS cnt
        FROM cognitive_artifacts
        WHERE agent_id = ${agentId} AND artifact_type = 'correction'
          AND content::text LIKE '%reconsolidatedAt%'
          AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY 1 ORDER BY 1
      `),
      db.execute(sql`
        SELECT created_at::date AS day, COUNT(*) AS cnt
        FROM cognitive_artifacts
        WHERE agent_id = ${agentId} AND artifact_type = 'reasoning_trace'
          AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY 1 ORDER BY 1
      `),
      db.execute(sql`
        SELECT timestamp::date AS day, COUNT(*) AS cnt
        FROM agent_state_logs
        WHERE agent_id = ${agentId} AND timestamp > NOW() - INTERVAL '14 days'
        GROUP BY 1 ORDER BY 1
      `),
    ]);

    const dayMap = new Map<string, any>();
    const dayKey = (d: unknown) => String(d).slice(0, 10);
    const ensureDay = (d: string) => {
      if (!dayMap.has(d)) {
        dayMap.set(d, { day: d, agentWrites: 0, reflections: 0, otherWrites: 0, total: 0, reconsolidations: 0, traces: 0, journals: 0 });
      }
      return dayMap.get(d);
    };
    for (const r of writesRes.rows as any[]) {
      const e = ensureDay(dayKey(r.day));
      const n = Number(r.cnt);
      if (r.source_type === "api") e.agentWrites += n;
      else if (r.source_type === "reflection") e.reflections += n;
      else e.otherWrites += n;
      e.total += n;
    }
    for (const r of reconsRes.rows as any[]) ensureDay(dayKey(r.day)).reconsolidations = Number(r.cnt);
    for (const r of tracesRes.rows as any[]) ensureDay(dayKey(r.day)).traces = Number(r.cnt);
    for (const r of journalsRes.rows as any[]) ensureDay(dayKey(r.day)).journals = Number(r.cnt);
    const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

    // ── Diagnostics history ──
    const diagRes = await db.execute(sql`
      SELECT to_char(timestamp, 'MM-DD HH24:MI') AS at, overall_health AS health, drift_score AS drift
      FROM self_diagnostics
      WHERE agent_id = ${agentId}
      ORDER BY timestamp DESC LIMIT 14
    `);
    const diagnostics = (diagRes.rows as any[]).reverse();

    // ── Dream cycle history ──
    const dreamRes = await db.execute(sql`
      SELECT to_char(started_at, 'MM-DD HH24:MI') AS at, cycle_type, stats,
             EXTRACT(EPOCH FROM (NOW() - started_at)) / 3600.0 AS hours_ago
      FROM dream_cycle_logs
      WHERE agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT 10
    `);
    const dreams = (dreamRes.rows as any[]).map((d) => ({
      at: d.at,
      cycleType: d.cycle_type,
      hoursAgo: Math.round(Number(d.hours_ago) * 10) / 10,
      resonanceUpdated: d.stats?.phase1_resonanceUpdated ?? 0,
      pruned: (d.stats?.phase2_memoriesDeleted ?? 0) + (d.stats?.phase2_memoriesArchived ?? 0),
      novelSynapses: d.stats?.phase4_novelSynapses ?? 0,
      syntheses: d.stats?.phase5_synthesesCreated ?? 0,
    }));

    // ── Current integrity / coverage / liveness (one round trip) ──
    const curRes = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active') AS active_memories,
        (SELECT COUNT(*) FROM memory_synapses ms WHERE ms.memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})) AS synapses,
        (SELECT ROUND(AVG(resonance_score)::numeric, 2) FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active') AS avg_resonance,
        (SELECT ROUND(AVG(ms.connection_strength)::numeric, 3) FROM memory_synapses ms
           WHERE ms.memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active')) AS avg_synapse_strength,
        (SELECT COUNT(*) FROM memory_nodes mn WHERE mn.agent_id = ${agentId} AND mn.status = 'active'
           AND mn.last_accessed_at < NOW() - INTERVAL '30 days'
           AND NOT EXISTS (SELECT 1 FROM memory_synapses ms WHERE ms.memory_a = mn.id OR ms.memory_b = mn.id)) AS orphans,
        (SELECT COUNT(*) FROM memory_nodes mn WHERE mn.agent_id = ${agentId} AND mn.status = 'active' AND mn.embedding IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM hippocampal_codes hc WHERE hc.memory_id = mn.id)) AS missing_hc,
        (SELECT COUNT(*) FROM memory_nodes mn WHERE mn.agent_id = ${agentId} AND mn.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM emotional_valence ev WHERE ev.memory_id = mn.id)) AS missing_valence,
        (SELECT COUNT(*) FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
           AND last_recalled_at > NOW() - INTERVAL '1 hour') AS labile_now,
        (SELECT COUNT(*) FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
           AND valid_until IS NOT NULL AND valid_until < NOW() - (${T.expiredGraceMinutes} * INTERVAL '1 minute')) AS expired_active,
        (SELECT COALESCE(SUM(length(c) - length(replace(c, chr(8212), ''))), 0) FROM
           (SELECT CASE WHEN artifact_type = 'synthesis'
                        THEN COALESCE(content->>'implication', '') || COALESCE(content->>'connection', '')
                        ELSE content::text END AS c
            FROM cognitive_artifacts WHERE agent_id = ${agentId} ORDER BY created_at DESC LIMIT 20) recent) AS emdash_recent,
        (SELECT COUNT(*) FROM procedural_memories WHERE agent_id = ${agentId} AND status = 'active') AS skills_total,
        (SELECT COALESCE(SUM(execution_count), 0) FROM procedural_memories WHERE agent_id = ${agentId} AND status = 'active') AS skill_executions,
        (SELECT COUNT(*) FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
           AND embedding IS NOT NULL AND created_at > NOW() - INTERVAL '7 days') AS recent_7d_count,
        (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(started_at))) / 3600.0 FROM dream_cycle_logs WHERE agent_id = ${agentId}) AS dream_hours_ago,
        (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600.0 FROM memory_nodes
           WHERE agent_id = ${agentId} AND source_type = 'reflection') AS reflect_hours_ago,
        (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(last_run))) / 3600.0 FROM background_threads WHERE agent_id = ${agentId}) AS threads_hours_ago,
        (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 3600.0 FROM agent_state_logs WHERE agent_id = ${agentId}) AS journal_hours_ago,
        (SELECT COUNT(*) FROM memory_nodes WHERE agent_id = ${agentId} AND source_type = 'api' AND created_at > NOW() - INTERVAL '7 days') AS agent_ingests_7d,
        (SELECT COUNT(*) FROM cognitive_artifacts WHERE agent_id = ${agentId} AND artifact_type = 'correction'
           AND content::text LIKE '%reconsolidatedAt%' AND created_at > NOW() - INTERVAL '7 days') AS recons_7d
    `);
    const cur = curRes.rows[0] as any;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

    // ── Near-duplicate pairs among recent active memories ──
    const dupRes = await db.execute(sql`
      WITH recent AS (
        SELECT id, embedding FROM memory_nodes
        WHERE agent_id = ${agentId} AND created_at > NOW() - INTERVAL '7 days'
          AND embedding IS NOT NULL AND status = 'active'
        ORDER BY created_at DESC
        LIMIT ${T.dupScanLimit}
      )
      SELECT DISTINCT LEAST(r.id, n.id) AS a, GREATEST(r.id, n.id) AS b,
             ROUND((1 - (r.embedding <=> n.embedding))::numeric, 3) AS sim
      FROM recent r,
      LATERAL (
        SELECT id, embedding FROM memory_nodes
        WHERE id <> r.id AND agent_id = ${agentId} AND status = 'active' AND embedding IS NOT NULL
        ORDER BY embedding <=> r.embedding LIMIT 1
      ) n
      WHERE 1 - (r.embedding <=> n.embedding) >= ${T.dupThreshold}
      ORDER BY 3 DESC
    `);
    const dupPairs = (dupRes.rows as any[]).map((p) => ({ a: Number(p.a), b: Number(p.b), sim: Number(p.sim) }));

    // ── Warning engine ──
    const warnings: Warning[] = [];
    const okChecks: string[] = [];
    const push = (id: string, severity: Severity, title: string, detail: string) =>
      warnings.push({ id, severity, title, detail });

    const lastDiag = diagnostics[diagnostics.length - 1];
    const drift = lastDiag ? Number(lastDiag.drift) : 0;
    const health = lastDiag?.health || "unknown";
    const badStreak = diagnostics.slice(-5).filter((d) => d.health !== "healthy").length;

    // "Never ran" is the loudest state for an early-warning engine - it must
    // never read as a passing check (review finding).
    if (!lastDiag) push("health", "warn", "Self-check has never run", "No self_diagnostics rows exist for this agent. Run cortex_self_check to establish a baseline.");
    else if (health === "critical") push("health", "critical", "Self-check is CRITICAL", `Latest diagnostic (${lastDiag.at}) reports critical health.`);
    else if (health === "degraded") push("health", "warn", "Self-check is degraded", `Latest diagnostic (${lastDiag.at}) reports degraded health.`);
    else okChecks.push(`self-check healthy (${lastDiag.at})`);
    if (badStreak >= T.streakWarn) push("health-streak", "warn", "Degraded/critical streak", `${badStreak} of the last 5 self-checks were not healthy.`);

    if (drift >= 0.5) push("drift", "critical", `Drift score ${drift.toFixed(2)}`, "At or past the critical threshold (0.5). Check recent artifacts for em-dashes.");
    else if (drift > 0) push("drift", "warn", `Drift building (${drift.toFixed(2)})`, "Non-zero drift. Each em-dash in the last 20 artifacts adds 0.1; critical at 0.5.");
    else okChecks.push("drift 0.00");

    const emdash = num(cur.emdash_recent) ?? 0;
    if (emdash >= T.emdashCritical) push("emdash", "critical", `${emdash} em-dashes in recent artifacts`, "The NEXT self-check will score drift > 0.5 (critical). Run scripts/scrub-em-dashes.ts and find the writer (stale pre-scrub MCP process?).");
    else if (emdash >= T.emdashBoundary) push("emdash", "warn", `${emdash} em-dashes in recent artifacts`, "At the critical boundary: drift will read 0.5 on the next self-check (em-dashes are the dominant term; sycophancy flags add 0.02 each). Scrub now.");
    else if (emdash > 0) push("emdash", "warn", `${emdash} em-dash(es) in recent artifacts`, "Drift will read >0 on the next self-check. A pre-sanitizer process is likely still writing; scrub and restart it.");
    else okChecks.push("0 em-dashes in last 20 artifacts (synthesis source text excluded, matching self-check)");

    if (dupPairs.length > 0) push("dups", "warn", `${dupPairs.length} near-duplicate pair(s) forming`, `Active memories within 7 days at cosine >= ${T.dupThreshold}: ${dupPairs.slice(0, 5).map((p) => `#${p.a}~#${p.b}@${p.sim}`).join(", ")}${dupPairs.length > 5 ? "..." : ""}. A dedup gate was bypassed (pre-restart Desktop? multi-chunk? force?). Reconsolidate or archive the newer copies.`);
    else okChecks.push("no near-duplicate pairs (7d window)");

    const expiredActive = num(cur.expired_active) ?? 0;
    if (expiredActive > 0) push("expired-active", "warn", `${expiredActive} active memories marked expired`, "status='active' but valid_until is in the past - a reconsolidation likely crashed between its expire and rewrite steps. Inspect and clear valid_until or finish the update.");
    else okChecks.push("no crashed-reconsolidation residue");

    const dreamAge = num(cur.dream_hours_ago);
    if (dreamAge === null || dreamAge > T.dreamCriticalHours) push("dream", "critical", "Dream cycle stale", dreamAge === null ? "No dream cycle has ever run." : `Last dream ${Math.round(dreamAge)}h ago (nightly expected). Check the 'Cortex Dream Cycle' scheduled task.`);
    else if (dreamAge > T.dreamWarnHours) push("dream", "warn", `Last dream ${Math.round(dreamAge)}h ago`, "Nightly cycle appears to have missed a run.");
    else okChecks.push(`dream cycle ${Math.round(dreamAge)}h ago`);

    const lastRealDream = dreams.find((d) => d.cycleType === "full" || d.cycleType === "resonance_only");
    const activeMem = num(cur.active_memories) ?? 0;
    if (lastRealDream && activeMem > 0 && lastRealDream.resonanceUpdated === 0) {
      push("dream-zero", "warn", "Dream cycle reports zero work", `${lastRealDream.cycleType} cycle at ${lastRealDream.at} updated 0 of ${activeMem} memories - either resonance decay is broken or stats reporting regressed (rowCount-vs-count bug class).`);
    } else if (lastRealDream) okChecks.push(`dream updating resonance (${lastRealDream.resonanceUpdated} memories last cycle)`);

    const reflectAge = num(cur.reflect_hours_ago);
    if (reflectAge === null) push("reflect", "warn", "Reflect has never produced a memory", "No reflection-sourced memories exist. Check the 'Cortex Nightly Reflect' scheduled task and reflect.log.");
    else if (reflectAge > T.reflectWarnHours) push("reflect", "warn", `No reflections in ${Math.round(reflectAge / 24)}d`, "Nightly Reflect may be failing - check the scheduled task and reflect.log.");
    else if (reflectAge > T.reflectInfoHours) push("reflect", "info", `Last reflection ${Math.round(reflectAge)}h ago`, "Reflect skips quiet days; only investigate if sessions were active.");
    else okChecks.push(`reflect pipeline ${Math.round(reflectAge)}h ago`);

    const threadsAge = num(cur.threads_hours_ago);
    if (threadsAge === null) push("threads", "warn", "Background threads have never run", "Strategic/operational/relational cognition has no last_run. Check the 'Cortex Background Threads' scheduled task.");
    else if (threadsAge > T.threadsWarnHours) push("threads", "warn", `Background threads ${Math.round(threadsAge / 24)}d stale`, "Strategic/operational/relational cognition is not running.");
    else okChecks.push(`background threads ${Math.round(threadsAge)}h ago`);

    const strength = num(cur.avg_synapse_strength);
    if (strength === null) push("synapses", "info", "No synapses yet", "The graph has no connections to measure - expected only for a brand-new agent.");
    else if (strength < T.synapseCritical) push("synapses", "critical", `Synaptic collapse (avg ${strength})`, `Average connection strength below the ${T.synapseCritical} viability threshold.`);
    else if (strength < T.synapseWarn) push("synapses", "warn", `Synapse strength trending low (avg ${strength})`, `Approaching the ${T.synapseCritical} collapse threshold; dream strengthening may be under-firing.`);
    else okChecks.push(`avg synapse strength ${strength}`);

    const missingHc = num(cur.missing_hc) ?? 0;
    if (missingHc > T.hcWarn) push("coverage-hc", "warn", `${missingHc} memories missing hippocampal codes`, "Invisible to DG/CA3 sparse recall. Run npm run backfill:hippocampal.");
    else if (missingHc > 0) push("coverage-hc", "info", `${missingHc} memories missing hippocampal codes`, "Run npm run backfill:hippocampal to restore full sparse-recall coverage.");
    else okChecks.push("hippocampal coverage 100%");

    const missingVal = num(cur.missing_valence) ?? 0;
    if (missingVal > T.valenceInfo) push("coverage-val", "info", `${missingVal} memories missing valence`, "Run npx tsx scripts/backfill-valence.ts (zero-cost lexicon).");
    else okChecks.push(missingVal === 0 ? "valence coverage 100%" : `valence coverage ok (${missingVal} missing)`);

    const orphans = num(cur.orphans) ?? 0;
    if (orphans > T.orphansWarn) push("orphans", "warn", `${orphans} orphaned memories`, "Active, synapse-less, untouched in 30+ days.");
    else okChecks.push(`orphans ${orphans}`);

    const ingests7 = num(cur.agent_ingests_7d) ?? 0;
    const recons7 = num(cur.recons_7d) ?? 0;
    if (ingests7 >= T.ratioMinIngests && recons7 * T.ratioFactor < ingests7) push("loop-ratio", "info", `Loop imbalance ${ingests7}:${recons7} (7d)`, "Agent ingests far outpace reconsolidations - sessions may be duplicating instead of updating. Check session compliance verdicts.");
    else okChecks.push(`ingest:reconsolidation ${ingests7}:${recons7} (7d)`);

    const skillsTotal = num(cur.skills_total) ?? 0;
    const skillExec = num(cur.skill_executions) ?? 0;
    if (skillsTotal >= 5 && skillExec <= 1) push("skills", "info", `Skill loop write-only (${skillsTotal} skills, ${skillExec} executions)`, "Skills are stored but never retrieved/executed - proficiency cannot grow. Sessions should call cortex_skill_retrieve before tasks and cortex_skill_executed after.");
    else okChecks.push(`skills: ${skillsTotal} stored / ${skillExec} executions`);

    // Write-spike: compare TODAY (gap-filled - days with zero writes count as
    // zero in the median; review finding: the last series entry is merely the
    // last day WITH activity, not necessarily today).
    {
      const todayKey = new Date().toISOString().slice(0, 10);
      const totalsByDay = new Map(daily.map((d) => [d.day, d.total]));
      const priorTotals: number[] = [];
      for (let i = 1; i <= 13; i++) {
        const k = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        priorTotals.push(totalsByDay.get(k) || 0);
      }
      priorTotals.sort((a, b) => a - b);
      const median = priorTotals[Math.floor(priorTotals.length / 2)] || 0;
      const todayTotal = totalsByDay.get(todayKey) || 0;
      if (todayTotal > Math.max(T.spikeMin, median * T.spikeFactor)) {
        push("write-spike", "info", `Ingestion spike today (${todayTotal} writes vs ~${median}/day median)`, "Sudden write bursts can indicate a runaway pipeline (e.g. reflect re-harvesting transcripts).");
      } else okChecks.push(`write volume normal (${todayTotal} today, ~${median}/day median)`);
    }

    const sevRank = { critical: 0, warn: 1, info: 2 } as Record<Severity, number>;
    warnings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

    res.json({
      agent: agentExt,
      generatedAt: new Date().toISOString(),
      thresholds: T,
      series: { daily, diagnostics, dreams },
      current: {
        activeMemories: activeMem,
        synapses: num(cur.synapses),
        avgResonance: num(cur.avg_resonance),
        avgSynapseStrength: strength,
        orphans,
        missingHippocampal: missingHc,
        missingValence: missingVal,
        labileNow: num(cur.labile_now),
        expiredActive,
        emDashRecent: emdash,
        skillsTotal,
        skillExecutions: skillExec,
        dreamHoursAgo: dreamAge,
        reflectHoursAgo: reflectAge,
        threadsHoursAgo: threadsAge,
        journalHoursAgo: num(cur.journal_hours_ago),
        agentIngests7d: ingests7,
        reconsolidations7d: recons7,
        dupPairs,
        // True when the 7-day window exceeded the 200-row scan cap - the dup
        // list is then a floor over the newest writes, not exhaustive.
        dupScanTruncated: (num(cur.recent_7d_count) ?? 0) > 200,
      },
      warnings,
      okChecks,
    });
  } catch (err) {
    console.error("[vitals] Error:", err);
    res.status(500).json({ error: "Vitals query failed" });
  }
});

export { router as vitalsRouter };
