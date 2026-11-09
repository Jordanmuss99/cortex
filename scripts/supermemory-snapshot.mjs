#!/usr/bin/env node
/**
 * Supermemory -> OmO cortex-memory.js snapshot (Shape A, see .omo/evidence/cortex-audit-20261110/report.md §4).
 *
 * For each OmO agent memory dir (~/.omo/memory/agents/<agent>) with a resolvable workspace, fetch that
 * workspace's Supermemory memories with the Claude Code plugin's OWN client library (same API key, base URL,
 * API version and repo container tag the plugin uses) and write them as markdown to
 *   <agentDir>/runtime/supermemory-snapshot/memories.md
 * which cortex-memory.js indexes read-only as `supermemory/...` chunks. The extension never calls the network;
 * only this script does, so prompt latency is unaffected.
 *
 * Degradation: a failed fetch never deletes or rewrites memories.md. status.json records the failure (message
 * only, with the key scrubbed) next to the last success, and attempts.jsonl keeps every attempt. After the
 * first network failure (timeout / unreachable) the remaining agents are skipped and recorded as such.
 *
 * Usage: node scripts/supermemory-snapshot.mjs [--agent <dir name>] [--cwd <workspace>] [--timeout-ms 15000] [--dry-run]
 * Never prints the API key.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ONLY_AGENT = argVal("--agent", "");
const CWD_OVERRIDE = argVal("--cwd", "");
const TIMEOUT_MS = Number(argVal("--timeout-ms", "15000"));
const DRY_RUN = args.includes("--dry-run");

const HOME = os.homedir();
const AGENTS_ROOT = path.join(HOME, ".omo", "memory", "agents");
const PLUGIN_ROOT = path.join(HOME, ".claude", "plugins", "cache", "supermemory-plugins", "supermemory");
// Broad project-memory probes; the plugin's search uses threshold 0.55 / limit 15.
const QUERIES = ["architecture decisions", "user preferences and workflow", "conventions and rules", "known problems and fixes"];

function newestPluginLib() {
  if (!fs.existsSync(PLUGIN_ROOT)) return null;
  const versions = fs
    .readdirSync(PLUGIN_ROOT)
    .filter((v) => fs.existsSync(path.join(PLUGIN_ROOT, v, "hooks", "lib", "api.js")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) return null;
  const v = versions[versions.length - 1];
  return { version: v, lib: path.join(PLUGIN_ROOT, v, "hooks", "lib") };
}

// Same workspace discovery as cortex-memory.js discoverFederatedSources: repo/system/project.md, then
// the standard candidate paths for the agent slug.
function workspaceFor(agentDir) {
  const slug = path.basename(agentDir).replace(/-[0-9a-f]{8}$/i, "").toLowerCase();
  if (!slug || slug.length < 3 || slug === os.userInfo().username.toLowerCase()) return null;
  const projectMd = path.join(agentDir, "repo", "system", "project.md");
  if (fs.existsSync(projectMd)) {
    const m = fs.readFileSync(projectMd, "utf8").match(/\*\*Workspace\*\*:\s*`([^`]+)`/i);
    if (m?.[1] && fs.existsSync(m[1])) return path.resolve(m[1]);
  }
  for (const cw of [
    path.join(HOME, "Documents", "antigravity", slug),
    path.join(HOME, "Workspace", "Games", slug),
    path.join(HOME, "Workspace", "Games", `${slug}-simscope`),
    path.join(HOME, "Workspace", slug),
  ]) {
    if (fs.existsSync(cw)) return path.resolve(cw);
  }
  return null;
}

const textOf = (item) => {
  if (typeof item === "string") return item;
  const t = [item?.memory, item?.chunk, item?.content, item?.text].find((v) => typeof v === "string" && v.trim());
  return t || null;
};
const norm = (s) => s.replace(/\s+/g, " ").trim();
const heading = (s) => {
  const words = norm(s).replace(/[#`[\]]/g, "").split(" ").slice(0, 9).join(" ");
  return words.length > 70 ? words.slice(0, 70) : words;
};

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const isNetworkFailure = (err) =>
  /timeout|timed out|abort|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(
    `${err?.name || ""} ${err?.code || ""} ${err?.message || ""}`
  );

async function main() {
  // Section-7 Q7 knob: the OmO Supermemory config can switch this snapshot off without unregistering the
  // scheduled task. Absent or unreadable config keeps today's behavior (snapshot runs).
  const omoCfg = readJson(process.env.OMO_SUPERMEMORY_CONFIG || path.join(HOME, ".omo", "supermemory.json"));
  if (omoCfg?.snapshot?.enabled === false) {
    console.log(JSON.stringify({ at: new Date().toISOString(), skipped: "snapshot.enabled=false in OmO supermemory config" }));
    return;
  }
  const plugin = newestPluginLib();
  if (!plugin) {
    console.error("supermemory plugin library not found under", PLUGIN_ROOT);
    process.exit(2);
  }
  const require = createRequire(path.join(plugin.lib, "noop.js"));
  const api = require("./api.js");
  const settings = require("./settings.js");
  const containerTag = require("./container-tag.js");

  let apiKey;
  try {
    apiKey = settings.getApiKey(HOME);
  } catch {
    console.error("no Supermemory API key available (plugin credentials not found)");
    process.exit(2);
  }
  const scrub = (s) => String(s || "").split(apiKey).join("<redacted>").slice(0, 300);

  const agents = (fs.existsSync(AGENTS_ROOT) ? fs.readdirSync(AGENTS_ROOT) : []).filter(
    (a) => !ONLY_AGENT || a === ONLY_AGENT
  );
  let apiDown = null;
  const summary = [];
  for (const agent of agents) {
    const agentDir = path.join(AGENTS_ROOT, agent);
    const workspace = CWD_OVERRIDE || workspaceFor(agentDir);
    if (!workspace) {
      summary.push({ agent, status: "skipped-no-workspace" });
      continue;
    }
    const outDir = path.join(agentDir, "runtime", "supermemory-snapshot");
    const statusFile = path.join(outDir, "status.json");
    const prev = readJson(statusFile) || {};
    const started = Date.now();
    let namespace, baseUrl, apiVersion;
    try {
      namespace = containerTag.getNamespace(workspace);
      baseUrl = settings.getBaseUrl(workspace);
      apiVersion = settings.getApiVersion(workspace);
    } catch (err) {
      summary.push({ agent, status: "config-error", error: scrub(err.message) });
      continue;
    }
    const record = {
      v: 1,
      agent,
      workspace,
      container: namespace,
      pluginVersion: plugin.version,
      apiVersion,
      lastAttemptAt: new Date(started).toISOString(),
      lastSuccessAt: prev.lastSuccessAt || null,
      lastSuccessItems: prev.lastSuccessItems ?? null,
    };

    if (apiDown) {
      Object.assign(record, { ok: false, error: `skipped: API unreachable earlier in this run (${apiDown})` });
    } else {
      const items = new Map();
      try {
        const opts = { timeoutMs: TIMEOUT_MS, apiVersion };
        const profile = await api.getProfile(baseUrl, apiKey, namespace, "", opts);
        for (const [kind, list] of [
          ["profile-static", profile?.profile?.static],
          ["profile-dynamic", profile?.profile?.dynamic],
        ]) {
          for (const it of list || []) {
            const t = textOf(it);
            if (t && !items.has(norm(t))) items.set(norm(t), { kind, text: t.trim() });
          }
        }
        for (const q of QUERIES) {
          for (const r of await api.searchMemories(baseUrl, apiKey, namespace, q, opts)) {
            const t = textOf(r);
            if (t && !items.has(norm(t))) items.set(norm(t), { kind: `search:${q}`, text: t.trim(), updatedAt: r?.updatedAt });
          }
        }
        const list = [...items.values()];
        // Title only: provenance lives in status.json so it is not indexed as a memory chunk.
        const md = [
          `# Supermemory snapshot: ${namespace}`,
          "",
          ...list.flatMap((it) => [`## ${heading(it.text)}`, "", it.text, "", `(supermemory ${it.kind}${it.updatedAt ? `, updated ${it.updatedAt}` : ""})`, ""]),
        ].join("\n");
        if (!DRY_RUN && list.length) writeAtomic(path.join(outDir, "memories.md"), md);
        Object.assign(record, {
          ok: true,
          items: list.length,
          wrote: !DRY_RUN && list.length > 0,
          lastSuccessAt: record.lastAttemptAt,
          lastSuccessItems: list.length,
          error: null,
        });
      } catch (err) {
        if (isNetworkFailure(err)) apiDown = scrub(err.message);
        Object.assign(record, { ok: false, error: scrub(err.message), keptPreviousSnapshot: fs.existsSync(path.join(outDir, "memories.md")) });
      }
    }
    record.durationMs = Date.now() - started;
    if (!DRY_RUN) {
      writeAtomic(statusFile, JSON.stringify(record, null, 2) + "\n");
      fs.appendFileSync(path.join(outDir, "attempts.jsonl"), JSON.stringify(record) + "\n", "utf8");
    }
    summary.push({ agent, status: record.ok ? "ok" : "failed", items: record.items ?? null, container: namespace, error: record.error || undefined, ms: record.durationMs });
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), plugin: plugin.version, dryRun: DRY_RUN, summary }, null, 2));
  process.exit(summary.some((s) => s.status === "ok") || !summary.some((s) => s.status === "failed") ? 0 : 1);
}

main().catch((err) => {
  console.error("snapshot failed:", String(err?.message || err).slice(0, 300));
  process.exit(1);
});
