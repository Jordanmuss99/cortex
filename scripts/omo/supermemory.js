/**
 * supermemory.js - global OmO (Senpi) extension: Supermemory capture, tuned recall, lazy search_memory MCP.
 *
 * Design: cortex/.omo/evidence/cortex-audit-20261110/omo-supermemory-design.md (sections 1-6).
 * Installed copy: ~/.omo/agent/extensions/supermemory.js. Tracked source: cortex/scripts/omo/supermemory.js.
 *
 * Phase 1 rulings (design section 7, adopted 2026-11-10): live capture on, recall in SHADOW (scored and logged,
 * never injected), nonGitPolicy "skip", spawnedBy children skipped, 5000 ms recall timeout with a 60 s circuit
 * breaker after 2 consecutive timeouts, injectProfile false, SimsOnline recall shadow, singleInjector true.
 *
 * Every network path is off unless ~/.omo/supermemory.json turns it on (code defaults: enabled false, capture
 * off, recall "off", mcp off). Env overrides: OMO_SUPERMEMORY_ENABLED=0, OMO_SUPERMEMORY_MODE=
 * shadow|live|capture-only|off, OMO_SUPERMEMORY_TELEMETRY=0, OMO_SUPERMEMORY_DEBUG=1, SUPERMEMORY_REPO_TAG.
 *
 * The Claude Code plugin's own library (newest ~/.claude/plugins/cache/supermemory-plugins/supermemory/<v>/hooks/lib)
 * does container derivation, redaction and the API calls, so Claude Code and OmO share one container per repo.
 * The API key is read only through that library's settings.getApiKey (SUPERMEMORY_CC_API_KEY, else
 * ~/.supermemory-claude/credentials.json). It is never copied, logged or written anywhere under ~/.omo, and
 * repo-local configs cannot change the key or the base URL (an empty project config is passed instead).
 *
 * Runtime state: ~/.omo/state/supermemory/{trackers,outbox,deadletter,sessions}/, recall-telemetry.jsonl,
 * capture-telemetry.jsonl, corpus-cache.jsonl, debug.log.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const HOME = os.homedir();
// OMO_SUPERMEMORY_CONFIG points at a staged config for dry-run testing without installing one.
const CONFIG_FILE = process.env.OMO_SUPERMEMORY_CONFIG || path.join(HOME, ".omo", "supermemory.json");
const STATE_DIR = path.join(HOME, ".omo", "state", "supermemory");
const TRACKERS = path.join(STATE_DIR, "trackers");
const OUTBOX = path.join(STATE_DIR, "outbox");
const DEADLETTER = path.join(STATE_DIR, "deadletter");
const SESSIONS = path.join(STATE_DIR, "sessions");
const PLUGIN_ROOT = path.join(HOME, ".claude", "plugins", "cache", "supermemory-plugins", "supermemory");

const HARD_MIN_PROMPT_CHARS = 15; // below this no recall telemetry row is written (matches cortex-memory.js)
const MAX_RECORD_CHARS = 20000;
const IN_PROCESS_RETRY_MS = [2000, 8000];
const MAX_OUTBOX_AGE_MS = 7 * 24 * 3600 * 1000;
const NAMESPACE_RE = /^[a-zA-Z0-9_:-]{1,100}$/;
const RECALL_KEYS = [
  "minPromptChars", "topFloor", "minSpread", "relWindow", "absFloor", "maxResults", "maxResultChars",
  "maxPromptTokens", "timeoutMs", "circuitBreakerFailures", "circuitBreakerCooldownMs", "maxSeenHashes",
];

const DEFAULTS = {
  enabled: false,
  nonGitPolicy: "skip",
  includeWorkerChildren: false,
  mcp: { enabled: false },
  // capture.mode: "live" | "dry-run" | "off" (section-7 Q1). Absent mode falls back to capture.enabled.
  capture: { enabled: false, timeoutMs: 30000, maxBatchChars: 16000, minTurnChars: 100, maxOutboxAttempts: 10 },
  recall: {
    mode: "off", injectProfile: false, maxProfileItems: 5, minPromptChars: 40, topFloor: 0.68, minSpread: 0.03, relWindow: 0.1,
    absFloor: 0.62, maxResults: 6, maxResultChars: 300, maxPromptTokens: 450, timeoutMs: 5000,
    circuitBreakerFailures: 2, circuitBreakerCooldownMs: 60000, maxSeenHashes: 500,
  },
  coexistence: { singleInjector: true, primaryInjector: "supermemory" },
  // section-7 Q7: read by Tools/cortex/scripts/supermemory-snapshot.mjs (the 6-hourly task); false makes it a no-op.
  snapshot: { enabled: true },
  containerOverrides: {},
  repos: {},
};

// ---------- small utilities ----------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}
const pick = (obj, keys) => {
  const out = {};
  if (isObj(obj)) for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};
const sha16 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const hashText = (t) => sha16(String(t).replace(/\s+/g, " ").trim());
const normPath = (p) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const envOff = (v) => v === "0" || /^false$/i.test(v || "");
const envOn = (v) => v === "1" || /^true$/i.test(v || "");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}
function appendLine(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* telemetry must never break a turn */
  }
}
function debug(msg, data) {
  if (!envOn(process.env.OMO_SUPERMEMORY_DEBUG) && process.env.SUPERMEMORY_DEBUG !== "true") return;
  appendLine(path.join(STATE_DIR, "debug.log"), { at: new Date().toISOString(), msg, ...(data ? { data } : {}) });
}
const telemetryOn = () => !envOff(process.env.OMO_SUPERMEMORY_TELEMETRY);
const recallTelemetry = (row) => telemetryOn() && appendLine(path.join(STATE_DIR, "recall-telemetry.jsonl"), row);
const captureTelemetry = (row) =>
  telemetryOn() && appendLine(path.join(STATE_DIR, "capture-telemetry.jsonl"), { v: 1, at: new Date().toISOString(), ...row });

// ---------- config ----------
let cfgCache = { mtime: -1, cfg: DEFAULTS };
function globalConfig() {
  let mtime = 0;
  try {
    mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (mtime !== cfgCache.mtime) {
    const raw = mtime ? readJson(CONFIG_FILE) : null;
    if (mtime && !raw) debug("config unreadable; using code defaults (all off)", { file: CONFIG_FILE });
    cfgCache = { mtime, cfg: deepMerge(DEFAULTS, raw || {}) };
  }
  const cfg = cfgCache.cfg;
  if (envOff(process.env.OMO_SUPERMEMORY_ENABLED) || process.env.OMO_SUPERMEMORY_MODE === "off") {
    return { ...cfg, enabled: false };
  }
  return cfg;
}
function applyModeEnv(recall) {
  const m = process.env.OMO_SUPERMEMORY_MODE;
  if (m === "shadow" || m === "live") return { ...recall, mode: m };
  if (m === "capture-only") return { ...recall, mode: "off" };
  return recall;
}

// ---------- plugin library ----------
let plugin; // undefined = not tried, null = unavailable
function loadPlugin() {
  if (plugin !== undefined) return plugin;
  plugin = null;
  try {
    const versions = fs
      .readdirSync(PLUGIN_ROOT)
      .filter((v) => fs.existsSync(path.join(PLUGIN_ROOT, v, "hooks", "lib", "api.js")))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!versions.length) return null;
    const version = versions[versions.length - 1];
    const hooks = path.join(PLUGIN_ROOT, version, "hooks");
    const req = createRequire(path.join(hooks, "lib", "noop.js"));
    plugin = {
      version,
      api: req("./api.js"),
      settings: req("./settings.js"),
      ct: req("./container-tag.js"),
      pc: req("./project-config.js"),
      redactSecrets: req("./redact.js").redactSecrets,
      mcpProxy: path.join(hooks, "mcp-proxy.js"),
    };
  } catch (e) {
    debug("plugin library load failed", { error: String(e?.message || e) });
    plugin = null;
  }
  return plugin;
}

// Credentials: an empty project config means a repo-local file can never supply the key or redirect the base URL.
function getCreds() {
  const s = loadPlugin().settings;
  const apiKey = s.getApiKey(HOME, {});
  const baseUrl = s.getBaseUrl(HOME, {});
  const apiVersion = s.getApiVersion(HOME, {});
  return { apiKey, baseUrl, apiVersion };
}

const EXTRA_REDACTIONS = [
  [/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED:google_key]"],
  [/cfat_[A-Za-z0-9_-]{20,}/g, "[REDACTED:cf_token]"],
  [/sk-ant-oat[0-9A-Za-z_-]{20,}/g, "[REDACTED:anthropic_oauth]"],
  [/(\$env:[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*\s*=\s*)(["'])[^"'\r\n]{8,}\2/gi, "$1$2[REDACTED:credential]$2"],
];
function scrub(text, apiKey) {
  let s = String(text ?? "");
  if (apiKey) s = s.split(apiKey).join("<redacted>");
  const p = loadPlugin();
  if (p) s = p.redactSecrets(s);
  for (const [re, rep] of EXTRA_REDACTIONS) s = s.replace(re, rep);
  return s;
}

// ---------- scope (container) resolution, design section 1 + 4.2 ----------
const scopeCache = new Map();
function resolveScope(cwd, trusted) {
  const cfg = globalConfig();
  if (!cfg.enabled) return { skip: "disabled" };
  const p = loadPlugin();
  if (!p) return { skip: "plugin_missing" };
  const key = `${cfgCache.mtime}|${trusted ? 1 : 0}|${process.env.SUPERMEMORY_REPO_TAG || ""}|${process.env.OMO_SUPERMEMORY_MODE || ""}|${cwd}`;
  if (scopeCache.has(key)) return scopeCache.get(key);

  let gitRoot = null;
  try {
    gitRoot = p.ct.getGitRoot(cwd) || null;
  } catch {
    gitRoot = null;
  }
  const base = gitRoot || path.resolve(cwd);
  let namespace = null;
  let source = null;

  if (process.env.SUPERMEMORY_REPO_TAG) {
    namespace = process.env.SUPERMEMORY_REPO_TAG;
    source = "env";
  }
  let local = {};
  if (trusted) {
    const lj = readJson(path.join(base, ".omo", "supermemory.json"));
    if (isObj(lj)) {
      local = lj;
      if (!namespace && typeof lj.namespace === "string" && lj.namespace) {
        namespace = lj.namespace;
        source = "repo-omo";
      }
    }
  }
  let claudeCfg = null;
  try {
    claudeCfg = p.pc.loadProjectConfig(cwd);
  } catch {
    claudeCfg = null;
  }
  if (!namespace && claudeCfg && (claudeCfg.namespace || claudeCfg.repoContainerTag)) {
    namespace = claudeCfg.namespace || claudeCfg.repoContainerTag;
    source = "repo-claude";
  }
  if (!namespace) {
    const n = normPath(cwd);
    for (const [prefix, v] of Object.entries(cfg.containerOverrides || {})) {
      const np = normPath(prefix);
      if (n === np || n.startsWith(np + "/")) {
        namespace = typeof v === "string" ? v : v?.namespace;
        source = "override";
        break;
      }
    }
  }
  let result;
  if (!namespace && !gitRoot) {
    if (cfg.nonGitPolicy === "scratch") {
      namespace = `omo_scratch__${sha16(HOME)}`;
      source = "scratch";
    } else if (cfg.nonGitPolicy === "path") {
      namespace = p.ct.getGeneratedContainerTag(cwd);
      source = "path";
    } else {
      result = { skip: "no_git_repo", base };
    }
  }
  if (!result) {
    if (!namespace) {
      namespace = p.ct.getGeneratedContainerTag(cwd);
      source = "git";
    }
    if (!NAMESPACE_RE.test(namespace)) {
      result = { skip: "invalid_namespace", base };
    } else {
      const repoOv = cfg.repos?.[namespace] || {};
      const tuned = pick(claudeCfg?.tunedRecall, RECALL_KEYS);
      let recall = { ...cfg.recall, ...(repoOv.recall || {}), ...tuned, ...(isObj(local.recall) ? local.recall : {}) };
      recall = applyModeEnv(recall);
      if (source === "scratch") recall = { ...recall, mode: "off" };
      const capture = { ...cfg.capture, ...(repoOv.capture || {}), ...(isObj(local.capture) ? local.capture : {}) };
      let projectName = null;
      let projectId = null;
      try {
        projectName = p.ct.getProjectName(cwd);
        projectId = p.ct.getProjectIdentity(cwd);
      } catch {
        /* metadata only */
      }
      result = { namespace, source, gitRoot, base, recall, capture, projectName, projectId };
    }
  }
  scopeCache.set(key, result);
  return result;
}

// ---------- session helpers ----------
function sessionInfo(ctx) {
  const sm = ctx?.sessionManager;
  const call = (fn) => {
    try {
      return sm?.[fn]?.() ?? null;
    } catch {
      return null;
    }
  };
  return { id: call("getSessionId"), file: call("getSessionFile"), leaf: call("getLeafId"), header: call("getHeader") };
}
function isChildSession(pi, ctx) {
  if (globalConfig().includeWorkerChildren) return false;
  const h = sessionInfo(ctx).header;
  if (h?.spawnedBy) return true;
  return pi.sessionKind === "worker" && pi.sessionContext?.role === "child";
}
function isTrusted(ctx) {
  try {
    return Boolean(ctx?.isProjectTrusted?.());
  } catch {
    return false;
  }
}

const SYNTHETIC_RE =
  /<(system-reminder|omo-senpi-task|environment_context|task-notification|supermemory-recall|supermemory-context|cortex-recall)\b[^>]*>[\s\S]*?<\/\1>|<recalled-memory\b[^>]*>[\s\S]*?<\/recalled-memory>/gi;
const stripSynthetic = (t) => String(t || "").replace(SYNTHETIC_RE, " ").replace(/[ \t]+\n/g, "\n").trim();

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------- recall, design section 3 ----------
const breaker = { timeouts: 0, openUntil: 0 };
const isTimeout = (e) => /timeout|timed out|abort/i.test(`${e?.name || ""} ${e?.code || ""} ${e?.message || ""}`);
const resultText = (r) => [r?.memory, r?.chunk, r?.content, r?.text].find((v) => typeof v === "string" && v.trim()) || null;

function looksPasted(prompt) {
  if (/^\s*(tool result|\[tool result|<tool_result|```|\{|\[|traceback|error:)/i.test(prompt)) return true;
  const letters = (prompt.match(/[A-Za-z]/g) || []).length;
  const alnum = (prompt.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum === 0) return true;
  if (letters / alnum < 0.7) return true;
  const words = prompt.slice(0, 200).split(/\s+/).filter(Boolean);
  const long = words.filter((w) => w.length > 24).length;
  return words.length > 0 && long / words.length > 0.3;
}

const distinctive = (text) => {
  const out = new Set();
  for (const w of String(text).toLowerCase().match(/[a-z0-9_]{5,}/g) || []) if (!/^\d+$/.test(w)) out.add(w);
  return out;
};
function branchTokenSet(ctx) {
  let branch = [];
  try {
    branch = ctx?.sessionManager?.getBranch?.() || [];
  } catch {
    branch = [];
  }
  const set = new Set();
  let budget = 60000;
  for (let i = branch.length - 1, n = 0; i >= 0 && n < 12 && budget > 0; i--) {
    const m = branch[i]?.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    n++;
    const t = textOf(m.content).slice(0, Math.min(12000, budget));
    budget -= t.length;
    for (const w of distinctive(t)) set.add(w);
  }
  return set;
}
function redundancy(text, set) {
  const toks = distinctive(text);
  if (!toks.size || !set.size) return 0;
  let hit = 0;
  for (const t of toks) if (set.has(t)) hit++;
  return hit / toks.size;
}

const seenFile = (sessionId) => path.join(SESSIONS, sha16(sessionId), "recalled.json");
function readSeen(sessionId) {
  if (!sessionId) return [];
  const list = readJson(seenFile(sessionId));
  return Array.isArray(list) ? list.filter((h) => typeof h === "string") : [];
}

let corpusSeen = null;
function appendCorpus(container, scored, apiKey) {
  if (!telemetryOn()) return;
  const file = path.join(STATE_DIR, "corpus-cache.jsonl");
  if (!corpusSeen) {
    corpusSeen = new Set();
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          corpusSeen.add(`${r.container}|${r.hash16}`);
        } catch {
          /* skip a torn line */
        }
      }
    } catch {
      /* first run */
    }
  }
  const at = new Date().toISOString();
  for (const x of scored) {
    const k = `${container}|${x.hash}`;
    if (corpusSeen.has(k)) continue;
    corpusSeen.add(k);
    appendLine(file, { hash16: x.hash, container, firstSeenAt: at, text: scrub(x.text.slice(0, 300), apiKey) });
  }
}

function formatBlock(items, namespace, k) {
  const head =
    "<supermemory-recall>\n" +
    "◪ From supermemory, matched to this prompt (unverified leads; confirm against STATUS / DECISIONS / code before acting):";
  const foot =
    'Credit a line you use with the ◪ prefix (if naming the source, say "from supermemory" - never "from memory"). ' +
    `Deeper history: search_memory (container ${namespace}).\n</supermemory-recall>`;
  const lines = [];
  let block = "";
  for (const x of items) {
    const title = typeof x.r?.title === "string" && x.r.title.trim() ? x.r.title.trim() : null;
    const body = x.text.replace(/\s+/g, " ").slice(0, k.maxResultChars);
    const line = `- ◪ [${x.sim.toFixed(2)}] ${title && !body.startsWith(title) ? `${title} - ` : ""}${body}`;
    const next = [head, ...lines, line, foot].join("\n");
    if (lines.length && Math.ceil(next.length / 4) > k.maxPromptTokens) break;
    lines.push(line);
    block = next;
  }
  return { block, count: lines.length };
}

async function recallHandler(pi, event, ctx) {
  if (!event || event.preview === true || typeof event.prompt !== "string") return undefined;
  if (event.trigger && event.trigger !== "prompt") return undefined;
  const rawPrompt = event.prompt.trim();
  const clean = stripSynthetic(rawPrompt);
  if (clean.length < HARD_MIN_PROMPT_CHARS) return undefined;
  const cwd = ctx?.cwd || pi.cwd;
  const scope = resolveScope(cwd, isTrusted(ctx));
  if (scope.skip === "disabled" || scope.skip === "plugin_missing") return undefined;
  if (!scope.skip && scope.recall.mode === "off") return undefined;

  const s = sessionInfo(ctx);
  const k = scope.recall || DEFAULTS.recall;
  const row = {
    v: 1, at: new Date().toISOString(), mode: scope.recall?.mode ?? null, session: s.id, sessionFile: s.file,
    leafEntryId: s.leaf, container: scope.namespace ?? null, promptChars: clean.length, skipReason: null,
    latencyMs: null, rawHits: 0, topSim: null, lastSim: null, spread: null, seenSkipped: 0, redundantSkipped: 0,
    tokens: 0, injected: false, wouldInject: [],
  };
  // Live injection is allowed only in live mode and, with singleInjector, when no other recall block is present.
  const liveGuard = () => {
    if (k.mode !== "live") return { live: false };
    if (globalConfig().coexistence?.singleInjector !== false) {
      if (process.env.CORTEX_SHADOW === "0") return { live: false, reason: "cortex_live_guard" };
      if (/<recalled-memory\b|<cortex-recall\b/i.test(rawPrompt)) return { live: false, reason: "external_injector_present" };
    }
    return { live: true };
  };
  let profileBlock = null; // section-7 Q5: set on a session's first eligible prompt when recall.injectProfile is true
  const finish = (reason) => {
    if (reason) row.skipReason = reason;
    const pm = profileBlock && liveGuard().live ? profileMessage(profileBlock, scope.namespace) : undefined;
    if (pm) row.profileInjected = true;
    recallTelemetry(row);
    return pm;
  };
  if (scope.skip) return finish(scope.skip);
  if (isChildSession(pi, ctx)) return finish("child_session");
  if (clean.length < k.minPromptChars) return finish("short");
  if (["/", "!", "#", "<"].includes(clean[0])) return finish("command");
  if (looksPasted(clean)) return finish("pasted");
  if (Date.now() < breaker.openUntil) return finish("circuit_open");

  let creds;
  try {
    creds = getCreds();
  } catch {
    return finish("no_api_key");
  }
  if (k.injectProfile && s.id && !profileFetched.has(s.id)) {
    profileFetched.add(s.id);
    try {
      const p = await loadPlugin().api.getProfile(creds.baseUrl, creds.apiKey, scope.namespace, clean.slice(0, 500), {
        timeoutMs: k.timeoutMs,
        apiVersion: creds.apiVersion,
      });
      const n = k.maxProfileItems;
      const lines = [...(p?.profile?.static || []).slice(0, n), ...(p?.profile?.dynamic || []).slice(0, n)]
        .map((x) => (typeof x === "string" ? x : resultText(x)))
        .filter(Boolean)
        .map((x) => `- ◪ ${scrub(String(x).replace(/\s+/g, " ").slice(0, k.maxResultChars), creds.apiKey)}`);
      row.profileItems = lines.length;
      if (lines.length) {
        profileBlock = `<supermemory-profile>\n◪ Supermemory profile for this repo (unverified leads; confirm before acting):\n${lines.join("\n")}\n</supermemory-profile>`;
      }
    } catch (e) {
      row.profileError = scrub(e?.message || e, creds.apiKey).slice(0, 200);
    }
  }
  const t0 = Date.now();
  let results;
  try {
    results = await loadPlugin().api.searchMemories(creds.baseUrl, creds.apiKey, scope.namespace, clean.slice(0, 500), {
      timeoutMs: k.timeoutMs,
      apiVersion: creds.apiVersion,
    });
    breaker.timeouts = 0;
  } catch (e) {
    row.latencyMs = Date.now() - t0;
    row.error = scrub(e?.message || e, creds.apiKey).slice(0, 200);
    if (isTimeout(e)) {
      breaker.timeouts++;
      if (breaker.timeouts >= k.circuitBreakerFailures) {
        breaker.openUntil = Date.now() + k.circuitBreakerCooldownMs;
        breaker.timeouts = 0;
      }
      return finish("timeout");
    }
    return finish("error");
  }
  row.latencyMs = Date.now() - t0;

  const scored = (Array.isArray(results) ? results : [])
    .map((r) => ({ r, text: resultText(r), sim: r?.similarity }))
    .filter((x) => x.text && Number.isFinite(x.sim))
    .map((x) => ({ ...x, hash: hashText(x.text) }))
    .sort((a, b) => b.sim - a.sim);
  row.rawHits = scored.length;
  appendCorpus(scope.namespace, scored, creds.apiKey);
  if (!scored.length) return finish("no_hits");
  const top = scored[0].sim;
  const last = scored[scored.length - 1].sim;
  row.topSim = +top.toFixed(4);
  row.lastSim = +last.toFixed(4);
  row.spread = +(top - last).toFixed(4);
  if (top < k.topFloor) return finish("low_top");
  if (top - last < k.minSpread) return finish("flat");

  const floor = Math.max(k.absFloor, top - k.relWindow);
  const batch = new Set();
  const kept = scored
    .filter((x) => x.sim >= floor)
    .filter((x) => (batch.has(x.hash) ? false : (batch.add(x.hash), true)))
    .slice(0, k.maxResults);
  const seen = new Set(readSeen(s.id));
  const unseen = kept.filter((x) => !seen.has(x.hash));
  row.seenSkipped = kept.length - unseen.length;
  const ctxSet = branchTokenSet(ctx);
  const fresh = [];
  for (const x of unseen) {
    x.redundancy = +redundancy(x.text, ctxSet).toFixed(3);
    if (x.redundancy >= 0.7) row.redundantSkipped++;
    else fresh.push(x);
  }
  if (!fresh.length) return finish("all_seen");

  const { block, count } = formatBlock(fresh, scope.namespace, k);
  const used = fresh.slice(0, count);
  row.tokens = Math.ceil(block.length / 4);
  row.wouldInject = used.map((x) => ({
    hash16: x.hash, similarity: +x.sim.toFixed(4), redundancy: x.redundancy, text: scrub(x.text.slice(0, 300), creds.apiKey),
  }));

  const guard = liveGuard();
  if (guard.reason) row.skipReason = guard.reason;
  if (!guard.live) return finish(null);

  try {
    writeJsonAtomic(seenFile(s.id), [...seen, ...used.map((x) => x.hash)].slice(-k.maxSeenHashes));
  } catch (e) {
    debug("seen-hash write failed", { error: String(e?.message || e) });
  }
  row.injected = true;
  if (profileBlock) row.profileInjected = true;
  recallTelemetry(row);
  try {
    if (ctx?.hasUI) ctx.ui.setStatus("supermemory", `◪ recalled ${count}`);
  } catch {
    /* status is cosmetic */
  }
  return {
    message: {
      customType: "supermemory-recall",
      display: false,
      placement: "before-prompt",
      content: profileBlock ? `${profileBlock}\n${block}` : block,
      details: { container: scope.namespace, count, topSim: row.topSim, tokens: row.tokens },
    },
  };
}

// ---------- capture, design section 2 ----------
// Module-level reducer: folds user text and assistant text (never tool calls/results, thinking, bash, custom).
const CAPTURE_REDUCER = {
  initial: () => ({ recs: [] }),
  add: (state, entry) => {
    if (!entry || entry.type !== "message" || !entry.message) return state;
    const m = entry.message;
    if (m.role === "user") {
      if (entry.inputSource === "extension") return state;
      const text = stripSynthetic(textOf(m.content));
      if (text) state.recs.push({ id: entry.id, role: "user", text: text.slice(0, MAX_RECORD_CHARS), ts: entry.timestamp });
    } else if (m.role === "assistant") {
      const text = stripSynthetic(textOf(m.content));
      if (text) state.recs.push({ id: entry.id, role: "assistant", text: text.slice(0, MAX_RECORD_CHARS), ts: entry.timestamp });
    }
    return state;
  },
};
function foldRecords(ctx) {
  const sm = ctx?.sessionManager;
  if (typeof sm?.reduceHistory === "function") return sm.reduceHistory(CAPTURE_REDUCER).recs;
  let st = CAPTURE_REDUCER.initial();
  for (const e of sm?.getEntries?.() || []) st = CAPTURE_REDUCER.add(st, e);
  return st.recs;
}

const trackerFile = (sessionId) => path.join(TRACKERS, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const outboxDepth = () => {
  try {
    return fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

const profileFetched = new Set();
function profileMessage(content, container) {
  return { message: { customType: "supermemory-profile", display: false, placement: "before-prompt", content, details: { container } } };
}

function captureMode(c) {
  if (c?.mode === "live" || c?.mode === "dry-run" || c?.mode === "off") return c.mode;
  return c?.enabled ? "live" : "off";
}

// dry-run never writes the outbox or advances the tracker; this in-memory cursor only stops repeat would_save rows.
const dryCursor = new Map();

function captureScope(pi, ctx) {
  const scope = resolveScope(ctx?.cwd || pi.cwd, isTrusted(ctx));
  if (scope.skip) return scope;
  if (captureMode(scope.capture) === "off") return { skip: "capture_disabled" };
  if (isChildSession(pi, ctx)) return { skip: "child_session" };
  return scope;
}

const skipLogged = new Set();
function logSkipOnce(s, reason) {
  if (reason === "disabled" || reason === "plugin_missing" || reason === "capture_disabled") return;
  const key = `${s.id}|${reason}`;
  if (skipLogged.has(key)) return;
  skipLogged.add(key);
  captureTelemetry({ session: s.id, sessionFile: s.file, container: null, event: "skipped", reason });
}

function ensureTracker(pi, ctx, scope) {
  const s = sessionInfo(ctx);
  if (!s.id) return null;
  const file = trackerFile(s.id);
  const existing = readJson(file);
  if (existing) return existing;
  const recs = foldRecords(ctx);
  // A session opened with history and no tracker predates this extension (resume, /reload, or a hot-load into a
  // running session): anchor at its end, never bulk-upload it. Count every captured record, not only user turns:
  // daemon sessions driven by peer deliveries have few or no non-extension user turns but long histories.
  const anchor = recs.length > 2;
  const lastId = recs.length ? recs[recs.length - 1].id : null;
  const now = new Date().toISOString();
  const t = {
    v: 1, sessionId: s.id, sessionFile: s.file, container: scope.namespace,
    spooledEntryId: anchor ? lastId : null, confirmedEntryId: anchor ? lastId : null,
    anchoredAtInstall: anchor, seq: 0, captureCount: 0, firstSeenAt: now, updatedAt: now,
  };
  writeJsonAtomic(file, t);
  if (anchor) captureTelemetry({ session: s.id, sessionFile: s.file, container: scope.namespace, event: "anchored", reason: "pre_install_history", spooledEntryId: lastId });
  return t;
}

function collectTurns(recs, afterId) {
  let start = 0;
  if (afterId) {
    const i = recs.findIndex((r) => r.id === afterId);
    if (i < 0) return { anchorLost: true, turns: [] };
    start = i + 1;
  }
  const turns = [];
  let cur = null;
  for (let i = start; i < recs.length; i++) {
    const r = recs[i];
    if (r.role === "user") {
      if (cur) turns.push(cur);
      cur = { user: r.text, assistant: "", lastId: r.id, ts: r.ts };
    } else {
      if (!cur) cur = { user: "", assistant: "", lastId: r.id, ts: r.ts };
      cur.assistant = r.text; // keep only the final assistant prose of the turn
      cur.lastId = r.id;
    }
  }
  if (cur) turns.push(cur);
  return { anchorLost: false, turns };
}

function formatTurn(t, apiKey) {
  const parts = [`<|turn_start|>${t.ts || new Date().toISOString()}`];
  if (t.user) parts.push(`<|start|>user<|message|>${scrub(t.user, apiKey)}<|end|>`);
  if (t.assistant) parts.push(`<|start|>assistant<|message|>${scrub(t.assistant, apiKey)}<|end|>`);
  parts.push("<|turn_end|>");
  return parts.join("\n\n");
}

// Synchronous, network-free: safe inside session_shutdown's 2 s quit budget.
function spool(pi, ctx, why) {
  const s = sessionInfo(ctx);
  try {
    if (!s.id) return 0;
    const scope = captureScope(pi, ctx);
    if (scope.skip) {
      logSkipOnce(s, scope.skip);
      return 0;
    }
    const tracker = ensureTracker(pi, ctx, scope);
    if (!tracker) return 0;
    const dryRun = captureMode(scope.capture) === "dry-run";
    const recs = foldRecords(ctx);
    const { anchorLost, turns } = collectTurns(recs, dryRun ? (dryCursor.get(s.id) ?? tracker.spooledEntryId) : tracker.spooledEntryId);
    if (anchorLost) {
      tracker.spooledEntryId = recs.length ? recs[recs.length - 1].id : null;
      tracker.updatedAt = new Date().toISOString();
      writeJsonAtomic(trackerFile(s.id), tracker);
      captureTelemetry({ session: s.id, sessionFile: s.file, container: scope.namespace, event: "skipped", reason: "anchor_lost", spooledEntryId: tracker.spooledEntryId });
      return 0;
    }
    if (!turns.length) return 0;
    let apiKey = null;
    try {
      apiKey = getCreds().apiKey; // only to scrub the literal key from text; never stored
    } catch {
      apiKey = null;
    }
    const k = scope.capture;
    const formatted = turns.map((t) => ({ t, text: formatTurn(t, apiKey).slice(0, k.maxBatchChars) }));
    const total = formatted.reduce((n, f) => n + f.text.length, 0);
    if (total < k.minTurnChars) return 0; // too little yet; the next settle carries it along

    const batches = [];
    let cur = [];
    let len = 0;
    for (const f of formatted) {
      if (cur.length && len + f.text.length + 2 > k.maxBatchChars) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(f);
      len += f.text.length + 2;
    }
    if (cur.length) batches.push(cur);

    let firstId = tracker.spooledEntryId;
    for (const b of batches) {
      const lastEntryId = b[b.length - 1].t.lastId;
      const content = b.map((f) => f.text).join("\n\n");
      const seq = ++tracker.seq;
      const job = {
        v: 1,
        batchId: sha16(`${s.id}:${firstId}:${lastEntryId}`),
        sessionId: s.id, sessionFile: s.file, container: scope.namespace,
        firstEntryId: firstId, lastEntryId, turnsCount: b.length, content,
        metadata: {
          sm_source: "omo", type: "session_turn", project: scope.projectName, sm_project_id: scope.projectId,
          sm_scope: "personal", sm_capture_mode: "automatic", timestamp: new Date().toISOString(),
        },
        timeoutMs: k.timeoutMs, maxAttempts: k.maxOutboxAttempts, attempts: 0, nextRetryAt: 0,
        createdAt: new Date().toISOString(), spooledBy: why,
      };
      if (dryRun) {
        captureTelemetry({
          session: s.id, sessionFile: s.file, container: scope.namespace, event: "would_save", reason: why, dryRun: true,
          batchId: job.batchId, turnsCount: b.length, chars: content.length, spooledEntryId: lastEntryId,
        });
        firstId = lastEntryId;
        continue;
      }
      writeJsonAtomic(path.join(OUTBOX, `${s.id}__${String(seq).padStart(6, "0")}.json`), job);
      captureTelemetry({
        session: s.id, sessionFile: s.file, container: scope.namespace, event: "spooled", reason: why,
        batchId: job.batchId, turnsCount: b.length, chars: content.length, outboxDepth: outboxDepth(),
        spooledEntryId: lastEntryId, confirmedEntryId: tracker.confirmedEntryId,
      });
      firstId = lastEntryId;
    }
    if (dryRun) {
      dryCursor.set(s.id, firstId);
      return batches.length;
    }
    tracker.spooledEntryId = firstId;
    tracker.sessionFile = s.file;
    tracker.updatedAt = new Date().toISOString();
    writeJsonAtomic(trackerFile(s.id), tracker);
    return batches.length;
  } catch (e) {
    captureTelemetry({ session: s.id, sessionFile: s.file, event: "error", reason: `spool_failed: ${String(e?.message || e).slice(0, 200)}` });
    return 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let draining = null;
function drain() {
  if (!draining) {
    draining = drainOnce()
      .catch((e) => captureTelemetry({ event: "error", reason: `drain_failed: ${String(e?.message || e).slice(0, 200)}` }))
      .finally(() => {
        draining = null;
      });
  }
  return draining;
}

async function drainOnce() {
  let files;
  try {
    files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }
  if (!files.length) return;
  const p = loadPlugin();
  if (!p) return;
  let creds;
  try {
    creds = getCreds();
  } catch {
    captureTelemetry({ event: "skipped", reason: "no_api_key", outboxDepth: files.length });
    return;
  }
  const blockedSessions = new Set(); // keep per-session order: a failed batch holds back its successors
  for (const f of files) {
    const file = path.join(OUTBOX, f);
    const job = readJson(file);
    if (!job) continue;
    if (blockedSessions.has(job.sessionId)) continue;
    if (job.nextRetryAt && job.nextRetryAt > Date.now()) {
      blockedSessions.add(job.sessionId);
      continue;
    }
    let done = false;
    for (let attempt = 0; !done; attempt++) {
      const t0 = Date.now();
      try {
        const result = await p.api.addMemory(creds.baseUrl, creds.apiKey, job.content, job.container, job.metadata, {
          id: job.sessionId,
          supportingContext: p.api.AGENT_SUPPORTING_CONTEXT,
          timeoutMs: job.timeoutMs || 30000,
          apiVersion: creds.apiVersion,
        });
        fs.rmSync(file, { force: true });
        const tf = trackerFile(job.sessionId);
        const t = readJson(tf);
        if (t) {
          t.confirmedEntryId = job.lastEntryId;
          t.captureCount = (t.captureCount || 0) + 1;
          t.updatedAt = new Date().toISOString();
          writeJsonAtomic(tf, t);
        }
        captureTelemetry({
          session: job.sessionId, sessionFile: job.sessionFile, container: job.container, event: "saved",
          batchId: job.batchId, turnsCount: job.turnsCount, chars: job.content.length, latencyMs: Date.now() - t0,
          docId: result?.id ?? null, docStatus: result?.status ?? null, outboxDepth: outboxDepth(),
          confirmedEntryId: job.lastEntryId,
        });
        done = true;
      } catch (e) {
        job.attempts = (job.attempts || 0) + 1;
        const httpStatus = e?.status ?? e?.statusCode ?? null;
        const reason = scrub(e?.message || e, creds.apiKey).slice(0, 200);
        const age = Date.now() - Date.parse(job.createdAt || 0);
        const fatal = httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429;
        if (fatal || job.attempts >= (job.maxAttempts || 10) || age > MAX_OUTBOX_AGE_MS) {
          fs.mkdirSync(DEADLETTER, { recursive: true });
          fs.renameSync(file, path.join(DEADLETTER, f));
          captureTelemetry({ session: job.sessionId, container: job.container, event: "deadletter", batchId: job.batchId, reason, httpStatus, latencyMs: Date.now() - t0, outboxDepth: outboxDepth() });
          done = true;
        } else if (attempt < IN_PROCESS_RETRY_MS.length) {
          captureTelemetry({ session: job.sessionId, container: job.container, event: "retry", batchId: job.batchId, reason, httpStatus, latencyMs: Date.now() - t0 });
          await sleep(IN_PROCESS_RETRY_MS[attempt] * (0.75 + Math.random() * 0.5));
        } else {
          job.nextRetryAt = Date.now() + Math.min(6 * 3600e3, 5 * 60e3 * 2 ** Math.max(0, job.attempts - 3));
          writeJsonAtomic(file, job);
          captureTelemetry({ session: job.sessionId, container: job.container, event: "retry", batchId: job.batchId, reason: `deferred: ${reason}`, httpStatus, outboxDepth: outboxDepth() });
          blockedSessions.add(job.sessionId);
          done = true;
        }
      }
    }
  }
}

// ---------- extension entry ----------
export default function supermemoryExtension(pi) {
  const cfg = globalConfig();
  if (!cfg.enabled) return; // fully off: no hooks, no MCP, no network

  if (cfg.mcp?.enabled) {
    const p = loadPlugin();
    if (p) {
      try {
        const scope = resolveScope(pi.cwd || process.cwd(), false);
        const env = {};
        if (scope.namespace) env.SUPERMEMORY_REPO_TAG = scope.namespace;
        pi.registerMcpServer("supermemory", {
          type: "stdio",
          command: "node",
          args: [p.mcpProxy],
          cwd: pi.cwd || process.cwd(),
          env,
          lifecycle: "lazy",
          exposure: "search",
          requestTimeoutMs: 35000,
        });
      } catch (e) {
        debug("registerMcpServer failed", { error: String(e?.message || e) });
      }
    }
  }

  pi.on("session_start", (event, ctx) => {
    if (event?.sizesOnly === true) return;
    const scope = captureScope(pi, ctx);
    if (!scope.skip) ensureTracker(pi, ctx, scope);
    const go = () => {
      drain();
    };
    if (typeof ctx?.afterSessionStart === "function") ctx.afterSessionStart(go);
    else go();
  });

  pi.on("session_compact", (event, ctx) => {
    if (!event?.accepted) return;
    const id = sessionInfo(ctx).id;
    if (id) fs.rmSync(seenFile(id), { force: true });
  });

  pi.on("before_agent_start", (event, ctx) => recallHandler(pi, event, ctx), { previewSafe: true, runLast: true });

  pi.on("agent_settled", async (_event, ctx) => {
    spool(pi, ctx, "agent_settled");
    await drain();
  });

  pi.on("session_shutdown", (event, ctx) => {
    spool(pi, ctx, `shutdown:${event?.reason || "unknown"}`);
  });

  pi.registerCommand("supermemory-status", {
    description: "Show Supermemory capture/recall state for this session (no secrets)",
    handler: async (_args, ctx) => {
      const s = sessionInfo(ctx);
      const scope = resolveScope(ctx?.cwd || pi.cwd, isTrusted(ctx));
      let key = "missing";
      try {
        key = getCreds().apiKey ? "present" : "missing";
      } catch {
        key = "missing";
      }
      const t = s.id ? readJson(trackerFile(s.id)) : null;
      const lines = [
        `plugin: ${loadPlugin()?.version ?? "not found"}  api key: ${key}`,
        `container: ${scope.namespace ?? "-"} (${scope.source ?? scope.skip})`,
        `recall: ${scope.recall?.mode ?? "-"}  capture: ${scope.capture ? captureMode(scope.capture) : "off"}  breaker: ${Date.now() < breaker.openUntil ? "open" : "closed"}`,
        `tracker: spooled=${t?.spooledEntryId ?? "-"} confirmed=${t?.confirmedEntryId ?? "-"} saves=${t?.captureCount ?? 0}  outbox: ${outboxDepth()}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
