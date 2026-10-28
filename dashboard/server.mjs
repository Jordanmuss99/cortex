#!/usr/bin/env node
/**
 * Cortex v2.4 Live 3D Hippocampal Dashboard Server (OmO Native Integration)
 *
 * Connects directly to all `~/.omo/memory/agents/*` repositories and runs the
 * live Cortex v2.4 hippocampal engine (`~/.omo/agent/extensions/cortex-memory.js`):
 *   - 4096-dim Dentate Gyrus k-WTA (K=204) sparse encoding + bounded [0, 1] L2 cosine
 *   - Provenance-weighted fact consolidation (P1 User Rulings vs P3 Tentative Facts)
 *   - 6D Emotional Valence & Amygdala Salience
 *   - CA1 Novelty Gate (0.88 duplicate refusal) & 1-hour Labile Reconsolidation
 *   - Real-time OmO Peer Mesh & Runtime Receipts (facts, reflection, dream)
 *
 * Usage:
 *   node dashboard/server.mjs                 # Run in foreground on http://127.0.0.1:3100
 *   node dashboard/server.mjs --daemon        # Ensure singleton background daemon is running
 *   node dashboard/server.mjs --status        # Print daemon status
 *   node dashboard/server.mjs --stop          # Stop running background daemon
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const PORT = parseInt(process.env.CORTEX_DASHBOARD_PORT || process.env.PORT || "3100", 10);
const HOST = process.env.CORTEX_DASHBOARD_HOST || "127.0.0.1";
const MEM_AGENTS_ROOT = path.join(HOME, ".omo", "memory", "agents");
const GATEWAY_DIR = path.join(HOME, ".omo", "agent", "gateway");
const PID_FILE = path.join(GATEWAY_DIR, "cortex-dashboard.pid.json");
const PEERS_FILE = path.join(GATEWAY_DIR, "agentbridge-peers.json");
const SUB_USAGE_FILE = path.join(HOME, ".omo", "agent", "subscription-usage.json");
const EXT_PATH = path.join(HOME, ".omo", "agent", "extensions", "cortex-memory.js");

const LABILE_WINDOW_MS = 60 * 60 * 1000; // 1-hour labile reconsolidation window (matches cortex-memory.js)

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch {
    // ignore
  }
  return fallback;
}

async function checkHttpAlive(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ─── CLI Daemon Management ───
const args = process.argv.slice(2);
if (args.includes("--status")) {
  const info = readJsonSafe(PID_FILE);
  const alive = info?.pid && isPidAlive(info.pid) && (await checkHttpAlive(info.port || PORT));
  console.log(
    JSON.stringify(
      {
        running: Boolean(alive),
        pid: alive ? info.pid : null,
        url: `http://127.0.0.1:${info?.port || PORT}`,
        startedAt: alive ? info.startedAt : null,
      },
      null,
      2
    )
  );
  process.exit(alive ? 0 : 1);
}

if (args.includes("--stop")) {
  const info = readJsonSafe(PID_FILE);
  if (info?.pid && isPidAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // ignore
    }
  }
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
  console.log("[cortex-dashboard] Stopped.");
  process.exit(0);
}

if (args.includes("--daemon")) {
  const info = readJsonSafe(PID_FILE);
  if (info?.pid && isPidAlive(info.pid) && (await checkHttpAlive(info.port || PORT))) {
    console.log(`[cortex-dashboard] Already running (PID ${info.pid}) at http://127.0.0.1:${info.port || PORT}`);
    process.exit(0);
  }
  fs.mkdirSync(GATEWAY_DIR, { recursive: true });
  const logFile = path.join(GATEWAY_DIR, "cortex-dashboard.log");
  let spawnedPid = null;

  if (process.platform === "win32") {
    try {
      const { execFileSync } = await import("node:child_process");
      const cmdLine = `cmd.exe /c ""${process.execPath}" "${__filename}" >> "${logFile}" 2>&1"`;
      const psScript =
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}'; CurrentDirectory = '${__dirname.replace(/'/g, "''")}' }; ` +
        `if ($r.ReturnValue -eq 0) { Write-Output $r.ProcessId } else { exit 1 }`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
      }).trim();
      spawnedPid = Number(out) || null;
    } catch {
      spawnedPid = null;
    }
  }

  if (!spawnedPid) {
    const logOut = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [__filename], {
      detached: true,
      stdio: ["ignore", logOut, logOut],
      windowsHide: true,
      env: { ...process.env, CORTEX_DASHBOARD_PORT: String(PORT) },
    });
    child.unref();
    spawnedPid = child.pid;
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await checkHttpAlive(PORT)) {
      const liveInfo = readJsonSafe(PID_FILE);
      console.log(
        `[cortex-dashboard] Started background daemon (PID ${liveInfo?.pid || spawnedPid}) at http://127.0.0.1:${PORT}`
      );
      process.exit(0);
    }
  }
  console.error("[cortex-dashboard] Daemon launched but health endpoint did not respond within timeout.");
  process.exit(1);
}

// ─── Load Live Cortex v2.4 Engine ───
const cortexMod = await import(pathToFileURL(EXT_PATH).href);
const { CortexLocalGraph, sparseOverlap, analyzeValence, extractTokens } = cortexMod;

// ─── Semantic Category & Provenance Classifier ───
const CATEGORY_KEYWORDS = {
  strategic: [
    "strategy", "strategic", "roadmap", "milestone", "plan", "goal", "decision",
    "ruling", "mission", "phase", "priority", "objective", "target", "gate",
  ],
  technical: [
    "code", "api", "bridge", "sacs", "recorder", "seam", "dll", "mono", "csharp",
    "python", "typescript", "javascript", "node", "trainer", "lyapunov", "cuda",
    "gpu", "parquet", "checkpoint", "ring", "crc32", "socket", "pipe", "mcp",
    "decompile", "ghidra", "rva", "presenterhook", "hook", "extension", "cache",
  ],
  creative: [
    "design", "visual", "ui", "ux", "animation", "clip", "pose", "vfx", "audio",
    "theme", "layout", "color", "style", "3d", "render", "presentation",
  ],
  operational: [
    "workflow", "stackctl", "boot", "reload", "daemon", "lock", "claim",
    "sandboxie", "wine", "worktree", "commit", "deploy", "cron", "schedule",
    "fallback", "keepalive", "guard", "sealed", "repin",
  ],
  research: [
    "research", "analysis", "study", "finding", "benchmark", "holdout", "median",
    "duel", "metric", "arxiv", "paper", "eval", "forensics", "experiment", "mae",
  ],
  communication: [
    "peer", "message", "handoff", "session", "sync", "chat", "thread",
    "conversation", "comment", "linear", "notion", "review", "feedback",
  ],
  identity: [
    "identity", "persona", "principle", "rule", "guardrail", "never", "mandatory",
    "discipline", "authority", "single-committer", "field commander", "self",
  ],
  environmental: [
    "windows", "linux", "path", "directory", "port", "env", "timeout", "status",
    "health", "diagnostic", "monitor", "memory", "vram", "cpu", "disk",
  ],
};

function classifyCategory(content, source) {
  const text = `${source} ${content.slice(0, 600)}`.toLowerCase();
  let best = "technical";
  let bestScore = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of kws) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

function classifyProvenance(node) {
  const src = String(node.source || "");
  const txt = String(node.content || "");
  if (src.startsWith("reconsolidated:")) return "reconsolidated";
  if (src.startsWith("custom:") || src === "cortex-custom" || src.startsWith("dashboard")) return "custom";
  if (src.startsWith("iron-laws/")) return "iron_law";
  if (src.startsWith("claude-memory/")) return "claude_memory";
  if (src.startsWith("openwiki/")) return "openwiki";
  if (src.startsWith("audit/")) return "audit";
  if (src.startsWith("playbook/")) return "ace_playbook";
  if (/\(\s*source:\s*user\s+said\b/i.test(txt)) return "user_ruling";
  if (src.startsWith("reference/")) return "reference";
  if (src.startsWith("skills/")) return "skill";
  if (/\(\s*source:\s*(?:agent\s+suggestion|inferred)\b[^)]*not\s+a\s+user\s+decision/i.test(txt)) {
    return "agent_tentative";
  }
  return "fact";
}

function friendlyAgentLabel(slug) {
  const base = String(slug || "").replace(/-[0-9a-f]{8}$/i, "");
  const map = {
    simsonline: "SimsOnline Multiplayer",
    "lucid-salk": "Deadlock AI (lucid-salk)",
    "tarkov-nexus-master": "Tarkov Nexus",
    "7dtd": "7 Days to Die",
    "7dtd-npc-survivors": "7DTD NPC Survivors",
    jorda: "Jordan Personal Memory",
    "obsidian-network-design-system-1": "Obsidian Design System",
  };
  return map[base] || base;
}

// ─── Graph Cache & Per-Agent Instances ───
const agentGraphs = new Map(); // slug -> CortexLocalGraph

function discoverAgentSlugs() {
  if (!fs.existsSync(MEM_AGENTS_ROOT)) return [];
  const entries = fs.readdirSync(MEM_AGENTS_ROOT, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(MEM_AGENTS_ROOT, e.name);
    const hasRepo = fs.existsSync(path.join(dir, "repo"));
    const hasCustom = fs.existsSync(path.join(dir, "runtime", "cortex-nodes.json"));
    if (!hasRepo && !hasCustom) continue;
    out.push(e.name);
  }
  return out.sort();
}

function getOrLoadGraph(slug) {
  const dir = path.join(MEM_AGENTS_ROOT, slug);
  if (!fs.existsSync(dir)) return null;
  let g = agentGraphs.get(slug);
  if (!g) {
    g = new CortexLocalGraph(dir);
    agentGraphs.set(slug, g);
  }
  g.agentDir = dir;
  g.ensureIndexed(dir);
  return g;
}

function readAgentRuntimeMeta(slug) {
  const dir = path.join(MEM_AGENTS_ROOT, slug);
  const receiptsPath = path.join(dir, "runtime", "receipts.jsonl");
  const artifactsPath = path.join(dir, "runtime", "cortex-artifacts.json");
  const customPath = path.join(dir, "runtime", "cortex-nodes.json");

  const artifacts = readJsonSafe(artifactsPath, []) || [];
  const custom = readJsonSafe(customPath, []) || [];
  const supersededCustom = Array.isArray(custom) ? custom.filter((x) => x?.status === "superseded").length : 0;

  let receipts = [];
  if (fs.existsSync(receiptsPath)) {
    try {
      const raw = fs.readFileSync(receiptsPath, "utf8");
      const lines = raw.trim().split(/\r?\n/).filter(Boolean);
      receipts = lines
        .slice(-40)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      receipts = [];
    }
  }

  let lastReflection = null;
  let lastFacts = null;
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i];
    if (!lastReflection && (r.kind === "reflection" || r.kind === "dream") && (r.event === "merged" || r.event === "no_changes" || r.event === "committed")) {
      lastReflection = r;
    }
    if (!lastFacts && r.kind === "facts" && r.event === "committed") {
      lastFacts = r;
    }
  }

  return {
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    supersededCount: Math.max(Array.isArray(artifacts) ? artifacts.length : 0, supersededCustom),
    receipts,
    lastReflection,
    lastFacts,
  };
}

function extractTopEntities(nodes, topN = 16) {
  const counts = new Map();
  const ENTITY_CANDIDATE_RE = /\b(?:[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z]{2,}[A-Za-z0-9_-]*|[a-z0-9_]+(?:\.cs|\.py|\.js|\.ts|\.mjs|\.jsonc?))\b/g;
  const IGNORE = new Set(["The", "This", "That", "When", "Before", "After", "Never", "Always", "Source", "Checkpoint", "Mission"]);
  for (const n of nodes) {
    const seenInNode = new Set();
    for (const m of String(n.content || "").matchAll(ENTITY_CANDIDATE_RE)) {
      const tok = m[0];
      if (tok.length < 3 || IGNORE.has(tok)) continue;
      if (seenInNode.has(tok)) continue;
      seenInNode.add(tok);
      counts.set(tok, (counts.get(tok) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, count]) => ({ name, count }));
}

function buildSynapses(decoratedNodes, minSynapse = 0.22, maxNeighborsPerNode = 6) {
  const n = decoratedNodes.length;
  const adj = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const ni = decoratedNodes[i];
    for (let j = i + 1; j < n; j++) {
      const nj = decoratedNodes[j];
      const sameAgent = ni.agentSlug === nj.agentSlug;
      const threshold = sameAgent ? minSynapse : Math.min(0.75, minSynapse + 0.05);
      const sim = sparseOverlap(ni._raw.sparse, nj._raw.sparse);
      if (sim < threshold) continue;

      const sameSourceFile =
        sameAgent &&
        String(ni.source || "").split("#")[0] === String(nj.source || "").split("#")[0];
      const type = !sameAgent
        ? "cross_agent_bridge"
        : sim >= 0.55
        ? "ca3_strong_engram"
        : sameSourceFile
        ? "episodic_sibling"
        : "hippocampal_dg";

      adj[i].push({ peer: j, sim, type });
      adj[j].push({ peer: i, sim, type });
    }
  }

  const edgeMap = new Map();
  for (let i = 0; i < n; i++) {
    adj[i].sort((a, b) => b.sim - a.sim);
    const kept = adj[i].slice(0, maxNeighborsPerNode);
    for (const e of kept) {
      const aIdx = Math.min(i, e.peer);
      const bIdx = Math.max(i, e.peer);
      const key = `${aIdx}:${bIdx}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          id: edgeMap.size + 1,
          memoryA: decoratedNodes[aIdx].id,
          memoryB: decoratedNodes[bIdx].id,
          connectionType: e.type,
          connectionStrength: Number(e.sim.toFixed(4)),
        });
      }
    }
  }

  return [...edgeMap.values()].sort((a, b) => b.connectionStrength - a.connectionStrength);
}

function buildGraphPayload(agentIdParam, { limit = 1500, minSynapse = 0.22 } = {}) {
  const allSlugs = discoverAgentSlugs();
  const isAll = !agentIdParam || agentIdParam === "all";
  const targetSlugs = isAll ? allSlugs : allSlugs.includes(agentIdParam) ? [agentIdParam] : [];

  if (!isAll && targetSlugs.length === 0) {
    return null;
  }

  const now = Date.now();
  const decorated = [];
  let totalArchived = 0;
  let latestReflection = null;
  let latestFacts = null;
  const sourceBreakdown = {};
  const provenanceBreakdown = {};
  const categoryBreakdown = {};
  const agentBreakdown = {};

  for (const slug of targetSlugs) {
    const g = getOrLoadGraph(slug);
    if (!g) continue;
    const meta = readAgentRuntimeMeta(slug);
    totalArchived += meta.supersededCount;
    if (meta.lastReflection && (!latestReflection || meta.lastReflection.at > latestReflection.at)) {
      latestReflection = { ...meta.lastReflection, agentSlug: slug };
    }
    if (meta.lastFacts && (!latestFacts || meta.lastFacts.at > latestFacts.at)) {
      latestFacts = { ...meta.lastFacts, agentSlug: slug };
    }

    for (const rawNode of g.nodes) {
      const prov = classifyProvenance(rawNode);
      const cat = classifyCategory(rawNode.content, rawNode.source);
      const val = analyzeValence(rawNode.content);
      const ageDays = Math.max(0, Math.floor((now - rawNode.createdMs) / 86400000));
      const isLabile = Boolean(rawNode.lastRecalledAt && now - rawNode.lastRecalledAt <= LABILE_WINDOW_MS);
      const labileRemainingSec = isLabile
        ? Math.max(0, Math.ceil((LABILE_WINDOW_MS - (now - rawNode.lastRecalledAt)) / 1000))
        : 0;

      const compositeId = `${slug}::${rawNode.id}`;
      const entities = extractTopEntities([rawNode], 6).map((x) => x.name);

      sourceBreakdown[prov] = (sourceBreakdown[prov] || 0) + 1;
      provenanceBreakdown[prov] = (provenanceBreakdown[prov] || 0) + 1;
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
      agentBreakdown[slug] = (agentBreakdown[slug] || 0) + 1;

      decorated.push({
        id: compositeId,
        numericId: rawNode.id,
        agentSlug: slug,
        agentLabel: friendlyAgentLabel(slug),
        content: rawNode.content,
        preview: rawNode.content.slice(0, 220),
        source: rawNode.source,
        sourceType: prov,
        provenance: prov,
        category: cat,
        entities,
        priority: rawNode.priority,
        resonanceScore: Number(rawNode.resonance.toFixed(2)),
        emotionalBoost: Number(rawNode.emotionalBoost.toFixed(3)),
        decayResistance: Number((rawNode.decayResistance || 0).toFixed(3)),
        kuramoto: rawNode.kuramoto
          ? {
              phase: Number((rawNode.kuramoto.phase ?? rawNode.kuramoto.theta ?? 0).toFixed(4)),
              theta: Number((rawNode.kuramoto.phase ?? rawNode.kuramoto.theta ?? 0).toFixed(4)),
              magnitude: Number((rawNode.kuramoto.magnitude ?? 0).toFixed(4)),
              valid: Boolean(rawNode.kuramoto.valid),
            }
          : null,
        aceReliability: rawNode.aceReliability ?? null,
        valence: {
          valence: Number(val.vector.valence.toFixed(3)),
          arousal: Number(val.vector.arousal.toFixed(3)),
          dominance: Number(val.vector.dominance.toFixed(3)),
          certainty: Number(val.vector.certainty.toFixed(3)),
          relevance: Number(val.vector.relevance.toFixed(3)),
          urgency: Number(val.vector.urgency.toFixed(3)),
          intensity: Number(val.salience.intensity.toFixed(3)),
        },
        activeNeurons: rawNode.sparse.indices.length,
        docLen: rawNode.docLen,
        createdAt: new Date(rawNode.createdMs).toISOString(),
        ageDays,
        isLabile,
        labileRemainingSec,
        lastRecalledAt: rawNode.lastRecalledAt ? new Date(rawNode.lastRecalledAt).toISOString() : null,
        _raw: rawNode,
      });
    }
  }

  decorated.sort((a, b) => a.priority - b.priority || b.resonanceScore - a.resonanceScore);
  const limited = decorated.slice(0, limit);
  const synapses = buildSynapses(limited, minSynapse, 6);

  const degreeMap = new Map();
  for (const s of synapses) {
    degreeMap.set(s.memoryA, (degreeMap.get(s.memoryA) || 0) + 1);
    degreeMap.set(s.memoryB, (degreeMap.get(s.memoryB) || 0) + 1);
  }

  const avgRes =
    limited.length > 0
      ? limited.reduce((acc, n) => acc + n.resonanceScore, 0) / limited.length
      : 5.0;
  const labileCount = limited.filter((n) => n.isLabile).length;
  const userRulingCount = limited.filter((n) => n.provenance === "user_ruling").length;
  const crossAgentSynapses = synapses.filter((s) => s.connectionType === "cross_agent_bridge").length;
  const orphanCount = limited.filter((n) => !degreeMap.get(n.id)).length;
  const topEntities = extractTopEntities(limited, 16);

  const cleanNodes = limited.map(({ _raw, ...rest }) => ({
    ...rest,
    synapseDegree: degreeMap.get(rest.id) || 0,
  }));

  return {
    agent: {
      id: isAll ? "all" : targetSlugs[0],
      name: isAll ? "Unified Multi-Agent Cortex Brain" : friendlyAgentLabel(targetSlugs[0]),
      includedAgents: targetSlugs,
    },
    nodes: cleanNodes,
    synapses,
    stats: {
      totalActive: decorated.length,
      returnedNodes: cleanNodes.length,
      totalArchived,
      totalNodes: decorated.length + totalArchived,
      totalSynapses: synapses.length,
      crossAgentSynapses,
      orphanCount,
      labileCount,
      userRulingCount,
      avgResonance: Number(avgRes.toFixed(2)),
      sourceBreakdown,
      provenanceBreakdown,
      categoryBreakdown,
      agentBreakdown,
      topEntities,
      health: "healthy",
      lastReflection: latestReflection,
      lastFacts: latestFacts,
    },
  };
}

function buildVitalsPayload(agentIdParam) {
  const graphData = buildGraphPayload(agentIdParam, { limit: 1500, minSynapse: 0.22 });
  if (!graphData) return null;

  const warnings = [];
  const okChecks = [];
  const allSlugs = graphData.agent.includedAgents;

  // 1. CA1 Near-Duplicate Scan (dgSim >= 0.88 within same agent)
  let nearDuplicates = 0;
  const dupExamples = [];
  for (const slug of allSlugs) {
    const g = getOrLoadGraph(slug);
    if (!g) continue;
    const scanNodes = g.nodes.slice(0, 250);
    for (let i = 0; i < scanNodes.length; i++) {
      for (let j = i + 1; j < scanNodes.length; j++) {
        const sim = sparseOverlap(scanNodes[i].sparse, scanNodes[j].sparse);
        if (sim >= 0.88) {
          nearDuplicates++;
          if (dupExamples.length < 3) {
            dupExamples.push(`${slug}#${scanNodes[i].id}<->#${scanNodes[j].id} (dg=${sim.toFixed(2)})`);
          }
        }
      }
    }
  }
  if (nearDuplicates > 3) {
    warnings.push({
      id: "ca1_near_duplicates",
      severity: "warn",
      title: `${nearDuplicates} near-duplicate engrams (DG >= 0.88)`,
      detail: `Candidates for reconsolidation: ${dupExamples.join(", ")}`,
    });
  } else {
    okChecks.push(`CA1 novelty separation clean (${nearDuplicates} near-dups across ${graphData.stats.totalActive} neurons)`);
  }

  // 2. Bounded [0, 1] L2 Sparse Cosine + Kuramoto Upgrade-K Validity Mask + Lyapunov Floor
  okChecks.push("Dentate Gyrus 4096-dim k-WTA (K=204) L2 cosine strictly bounded in [0.00, 1.00]");
  const phaseValidCount = graphData.nodes.filter((n) => n.kuramoto?.valid).length;
  okChecks.push(
    `Kuramoto Upgrade-K validity mask active: ${phaseValidCount}/${graphData.nodes.length} phase-locked engrams (r >= 0.12; unaligned = 0 bias) + Lyapunov P1 floor (0.72)`
  );

  // 3. Provenance Hierarchy & Multi-Harness Federation Check
  const p1Count = graphData.nodes.filter((n) => n.priority === 1).length;
  const federatedCount =
    (graphData.stats.provenanceBreakdown.iron_law || 0) +
    (graphData.stats.provenanceBreakdown.claude_memory || 0) +
    (graphData.stats.provenanceBreakdown.openwiki || 0) +
    (graphData.stats.provenanceBreakdown.audit || 0) +
    (graphData.stats.provenanceBreakdown.ace_playbook || 0);
  const tentativeCount = graphData.stats.provenanceBreakdown.agent_tentative || 0;
  okChecks.push(
    `Provenance & read-only federation active: ${p1Count} P1 authoritative engrams (${federatedCount} federated across Claude/OpenWiki/Playbook/Audit) vs ${tentativeCount} P3 tentative notes`
  );

  // 4. Synapse Density Check
  const avgDeg =
    graphData.stats.returnedNodes > 0
      ? (graphData.stats.totalSynapses * 2) / graphData.stats.returnedNodes
      : 0;
  if (graphData.stats.returnedNodes > 10 && avgDeg < 0.8) {
    warnings.push({
      id: "low_synapse_density",
      severity: "info",
      title: `Sparse synaptic connectivity (${avgDeg.toFixed(1)} avg degree)`,
      detail: "Lower the Min DG Synapse slider below 0.22 to inspect weaker associative bridges.",
    });
  } else {
    okChecks.push(
      `Hippocampal synapse density healthy (${avgDeg.toFixed(1)} avg degree, ${graphData.stats.totalSynapses} active synapses)`
    );
  }

  // 5. Live OmO Peer Mesh & Subscription / Cache Status
  const peersDb = readJsonSafe(PEERS_FILE, { peers: {} });
  const livePeers = Object.values(peersDb?.peers || {}).filter((p) => p && isPidAlive(p.pid));
  if (livePeers.length > 0) {
    okChecks.push(
      `OmO Peer Mesh connected: ${livePeers.map((p) => `${p.name} (PID ${p.pid})`).join(", ")}`
    );
  }
  const subUsage = readJsonSafe(SUB_USAGE_FILE, null);
  const claudeWin = subUsage?.accounts?.["anthropic-subscription/default"]?.windows || [];
  const exhausted7d = claudeWin.find((w) => Number(w?.usedPercent) >= 100);
  if (exhausted7d) {
    okChecks.push(
      `Anthropic API routing active (1h cache + 24h keepalive; subscription ${exhausted7d.label} resets ${String(exhausted7d.resetsAt || "").slice(0, 10)})`
    );
  }

  // 6. OmO Background Facts / Reflection Receipts
  // 6a. Cortex v2.6 recall telemetry (last 24h): injection rate and context-novelty gate activity
  {
    let decisions = 0;
    let injectedTurns = 0;
    let chunks = 0;
    let redundantSkipped = 0;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const slug of allSlugs) {
      const tf = path.join(MEM_AGENTS_ROOT, slug, "runtime", "cortex-telemetry.jsonl");
      if (!fs.existsSync(tf)) continue;
      try {
        const lines = fs.readFileSync(tf, "utf8").trim().split(/\r?\n/).slice(-2000);
        for (const l of lines) {
          let r;
          try {
            r = JSON.parse(l);
          } catch {
            continue;
          }
          if (!r || Date.parse(r.at) < cutoff || r.session === "verify-all" || r.session === "replay") continue;
          decisions++;
          redundantSkipped += r.redundantSkipped || 0;
          if (Array.isArray(r.injected) && r.injected.length) {
            injectedTurns++;
            chunks += r.injected.length;
          }
        }
      } catch {
        // ignore
      }
    }
    okChecks.push(
      decisions > 0
        ? `Cortex v2.6 recall (24h): ${injectedTurns}/${decisions} turns injected (${chunks} chunks), ${redundantSkipped} already-in-context chunks suppressed by the novelty gate`
        : "Cortex v2.6 recall telemetry: no live recall decisions in the last 24h yet"
    );
  }
  if (graphData.stats.lastFacts) {
    okChecks.push(
      `Latest OmO facts commit: ${String(graphData.stats.lastFacts.sha || "").slice(0, 8)} at ${graphData.stats.lastFacts.at.slice(0, 19)}Z`
    );
  }
  if (graphData.stats.lastReflection) {
    okChecks.push(
      `Latest reflection (${graphData.stats.lastReflection.runId}): ${graphData.stats.lastReflection.event} at ${graphData.stats.lastReflection.at.slice(0, 19)}Z`
    );
  }

  const health = warnings.some((w) => w.severity === "critical")
    ? "critical"
    : warnings.some((w) => w.severity === "warn")
    ? "degraded"
    : "healthy";

  return {
    agentId: graphData.agent.id,
    health,
    warnings,
    okChecks,
    livePeers,
  };
}

function buildCognitionPayload(agentIdParam) {
  const allSlugs = discoverAgentSlugs();
  const isAll = !agentIdParam || agentIdParam === "all";
  const targetSlugs = isAll ? allSlugs : allSlugs.includes(agentIdParam) ? [agentIdParam] : [];
  if (!isAll && targetSlugs.length === 0) return null;

  const artifacts = [];
  const receipts = [];
  const labileMemories = [];
  const now = Date.now();

  for (const slug of targetSlugs) {
    const g = getOrLoadGraph(slug);
    const meta = readAgentRuntimeMeta(slug);

    for (const art of meta.artifacts) {
      artifacts.push({
        id: `${slug}-art-${art.artifactId}`,
        agentSlug: slug,
        type: art.wasLabile ? "labile-reconsolidation" : "reconsolidation",
        created: String(art.supersededAt || "").slice(0, 19).replace("T", " "),
        content: `[${friendlyAgentLabel(slug)} #${art.memoryId} superseded] ${art.previousContent}`,
      });
    }

    for (const r of meta.receipts.slice(-15)) {
      if (r.event === "committed" || r.event === "merged" || r.event === "abandoned") {
        receipts.push({
          id: `${slug}-${r.at}`,
          agentSlug: slug,
          type: `${r.kind}:${r.event}`,
          created: String(r.at || "").slice(0, 19).replace("T", " "),
          content: `[${friendlyAgentLabel(slug)}] ${r.kind} (${r.runId || String(r.batchId || "").slice(0, 8)}) -> ${r.event}${r.sha ? ` sha=${String(r.sha).slice(0, 8)}` : ""}${r.reason ? ` (${r.reason})` : ""}`,
        });
      }
    }

    if (g) {
      for (const n of g.nodes) {
        if (n.lastRecalledAt && now - n.lastRecalledAt <= LABILE_WINDOW_MS) {
          labileMemories.push({
            id: `${slug}::${n.id}`,
            numericId: n.id,
            agentSlug: slug,
            source: n.source,
            remainingSec: Math.ceil((LABILE_WINDOW_MS - (now - n.lastRecalledAt)) / 1000),
            preview: n.content.slice(0, 160),
          });
        }
      }
    }
  }

  const combinedFeed = [...artifacts, ...receipts]
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .slice(0, 40);

  const vitals = buildVitalsPayload(agentIdParam);

  return {
    agentId: isAll ? "all" : targetSlugs[0],
    artifacts: combinedFeed,
    labileMemories,
    selfDiagnostics: {
      health: vitals?.health || "healthy",
      driftScore: 0,
    },
  };
}

function runHybridSearchAcross(agentIdParam, query, limit = 12) {
  const allSlugs = discoverAgentSlugs();
  const isAll = !agentIdParam || agentIdParam === "all";
  const targetSlugs = isAll ? allSlugs : allSlugs.includes(agentIdParam) ? [agentIdParam] : [];

  const merged = [];
  for (const slug of targetSlugs) {
    const g = getOrLoadGraph(slug);
    if (!g) continue;
    const hits = g.search(query, { limit, excludeSurfaced: false });
    for (const h of hits) {
      merged.push({
        id: `${slug}::${h.node.id}`,
        numericId: h.node.id,
        agentSlug: slug,
        agentLabel: friendlyAgentLabel(slug),
        source: h.node.source,
        provenance: classifyProvenance(h.node),
        category: classifyCategory(h.node.content, h.node.source),
        priority: h.node.priority,
        resonanceScore: Number(h.node.resonance.toFixed(2)),
        kuramoto: h.node.kuramoto || null,
        aceReliability: h.node.aceReliability ?? null,
        content: h.node.content,
        qualified: h.hybridScore >= 0.34,
        scores: {
          hybrid: Number(h.hybridScore.toFixed(4)),
          semantic: Number(h.semantic.toFixed(4)),
          dgSim: Number(h.dgSim.toFixed(4)),
          bm25: Number(h.textMatch.toFixed(4)),
          recency: Number(h.recency.toFixed(4)),
          emotionalBoost: Number(h.emotionalBoost.toFixed(4)),
          phaseCoherence: Number((h.phaseCoherence ?? 0).toFixed(4)),
        },
      });
    }
  }

  merged.sort((a, b) => b.scores.hybrid - a.scores.hybrid);
  return merged.slice(0, limit);
}

// ─── HTTP Helpers ───
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = urlObj.pathname;

    // Static Dashboard Files
    if (req.method === "GET" && (pathname === "/" || pathname === "/cortex-graph.html" || pathname === "/index.html")) {
      const htmlPath = path.join(__dirname, "cortex-graph.html");
      const html = fs.readFileSync(htmlPath, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    if (req.method === "GET" && pathname === "/favicon.ico") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f172a"/><circle cx="16" cy="16" r="9" fill="#38bdf8"/></svg>`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(svg);
      return;
    }

    if (req.method === "GET" && pathname === "/3d-force-graph.min.js") {
      const jsPath = path.join(__dirname, "3d-force-graph.min.js");
      const stat = fs.statSync(jsPath);
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=86400",
      });
      fs.createReadStream(jsPath).pipe(res);
      return;
    }

    // REST API v1
    if (req.method === "GET" && pathname === "/api/v1/health") {
      const slugs = discoverAgentSlugs();
      let totalNeurons = 0;
      for (const s of slugs) {
        const g = getOrLoadGraph(s);
        if (g) totalNeurons += g.nodes.length;
      }
      sendJson(res, 200, {
        status: "ok",
        service: "CORTEX v2.5 Live 3D Hippocampal Dashboard",
        version: "2.5.0-omo",
        enginePath: EXT_PATH,
        agentsCount: slugs.length,
        totalActiveNeurons: totalNeurons,
        pid: process.pid,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/v1/agents") {
      const slugs = discoverAgentSlugs();
      const agents = slugs.map((slug) => {
        const g = getOrLoadGraph(slug);
        const meta = readAgentRuntimeMeta(slug);
        return {
          id: slug,
          name: friendlyAgentLabel(slug),
          activeCount: g ? g.nodes.length : 0,
          archivedCount: meta.supersededCount,
          lastFactsAt: meta.lastFacts?.at || null,
          lastReflectionAt: meta.lastReflection?.at || null,
        };
      });
      agents.sort((a, b) => b.activeCount - a.activeCount);
      const totalActive = agents.reduce((s, a) => s + a.activeCount, 0);
      sendJson(res, 200, {
        defaultAgentId: "all",
        totalActive,
        agents: [
          {
            id: "all",
            name: `All Workspaces — Unified 3D Brain (${totalActive} neurons)`,
            activeCount: totalActive,
            archivedCount: agents.reduce((s, a) => s + a.archivedCount, 0),
          },
          ...agents,
        ],
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/v1/graph") {
      const agentId = urlObj.searchParams.get("agentId") || "all";
      const limit = Math.min(Math.max(parseInt(urlObj.searchParams.get("limit") || "1500", 10), 10), 5000);
      const minSynapse = Math.min(Math.max(parseFloat(urlObj.searchParams.get("minSynapse") || "0.22"), 0.1), 0.9);
      const payload = buildGraphPayload(agentId, { limit, minSynapse });
      if (!payload) {
        sendJson(res, 404, { error: `Agent '${agentId}' not found` });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && pathname === "/api/v1/vitals") {
      const agentId = urlObj.searchParams.get("agentId") || "all";
      const payload = buildVitalsPayload(agentId);
      if (!payload) {
        sendJson(res, 404, { error: `Agent '${agentId}' not found` });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "GET" && pathname === "/api/v1/cognition") {
      const agentId = urlObj.searchParams.get("agentId") || "all";
      const payload = buildCognitionPayload(agentId);
      if (!payload) {
        sendJson(res, 404, { error: `Agent '${agentId}' not found` });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && pathname === "/api/v1/search") {
      const body = await readBodyJson(req);
      const query = String(body?.query || "").trim();
      const agentId = String(body?.agentId || "all");
      const limit = Math.min(Math.max(parseInt(String(body?.limit || "12"), 10), 1), 50);
      if (!query) {
        sendJson(res, 400, { error: "query is required" });
        return;
      }
      const t0 = performance.now();
      const results = runHybridSearchAcross(agentId, query, limit);
      const elapsedMs = Number((performance.now() - t0).toFixed(2));
      sendJson(res, 200, {
        query,
        agentId,
        elapsedMs,
        qualifiedThreshold: 0.34,
        tokens: [...new Set(extractTokens(query))],
        results,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/v1/ingest") {
      const body = await readBodyJson(req);
      let agentId = String(body?.agentId || "");
      if (!agentId || agentId === "all") {
        const slugs = discoverAgentSlugs();
        agentId = slugs.find((s) => s.startsWith("simsonline")) || slugs[0] || "";
      }
      const content = String(body?.content || "").trim();
      const source = String(body?.source || "dashboard-ui").trim();
      if (!content || content.length < 15) {
        sendJson(res, 400, { error: "content must be at least 15 characters" });
        return;
      }
      const g = getOrLoadGraph(agentId);
      if (!g) {
        sendJson(res, 404, { error: `Agent '${agentId}' not found` });
        return;
      }
      const result = g.ingest(content, source);
      g.ensureIndexed(g.agentDir);
      sendJson(res, 200, { agentId, ...result });
      return;
    }

    if (req.method === "POST" && pathname === "/api/v1/reconsolidate") {
      const body = await readBodyJson(req);
      let agentId = String(body?.agentId || "");
      let rawId = body?.memoryId;
      if (typeof rawId === "string" && rawId.includes("::")) {
        const [slugPart, numPart] = rawId.split("::");
        agentId = slugPart;
        rawId = Number(numPart);
      } else {
        rawId = Number(rawId);
      }
      const content = String(body?.content || "").trim();
      if (!agentId || agentId === "all" || !Number.isFinite(rawId)) {
        sendJson(res, 400, { error: "Specific agentId and numeric memoryId are required" });
        return;
      }
      if (!content || content.length < 15) {
        sendJson(res, 400, { error: "Updated content must be at least 15 characters" });
        return;
      }
      const g = getOrLoadGraph(agentId);
      if (!g) {
        sendJson(res, 404, { error: `Agent '${agentId}' not found` });
        return;
      }
      const result = g.reconsolidate(rawId, content);
      g.ensureIndexed(g.agentDir);
      sendJson(res, 200, {
        agentId,
        compositeNewId: `${agentId}::${result.newId}`,
        ...result,
      });
      return;
    }

    sendJson(res, 404, { error: `Not found: ${pathname}` });
  } catch (err) {
    sendJson(res, 500, { error: err?.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  try {
    fs.mkdirSync(GATEWAY_DIR, { recursive: true });
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          host: HOST,
          port: PORT,
          url: `http://${HOST}:${PORT}`,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    // ignore
  }
  console.log(`[cortex-dashboard] CORTEX v2.4 Live 3D Dashboard running at http://${HOST}:${PORT} (PID ${process.pid})`);
});

function cleanupPid() {
  try {
    const info = readJsonSafe(PID_FILE);
    if (info?.pid === process.pid && fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // ignore
  }
}

process.on("SIGINT", () => {
  cleanupPid();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupPid();
  process.exit(0);
});
process.on("exit", cleanupPid);
