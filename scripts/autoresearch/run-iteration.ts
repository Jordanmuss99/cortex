#!/usr/bin/env node
/**
 * Autoresearch iteration runner for cortex-roundtrip-omo-omc.
 *
 * Owns persistence and bookkeeping for one mission iteration:
 *   - .omc/autoresearch/cortex-roundtrip-omo-omc/state.json
 *   - .omc/autoresearch/cortex-roundtrip-omo-omc/runs/<run-id>/evaluations/<iter>.json
 *   - .omc/autoresearch/cortex-roundtrip-omo-omc/runs/<run-id>/decision-log.md
 *
 * Spawns the evaluator script as a child process, captures its stdout JSON,
 * appends a human-readable decision-log entry, and bumps state.
 *
 * Env overrides:
 *   CORTEX_AR_NEW_RUN=1         force a new run-id even if state has one
 *   CORTEX_AR_CEILING=<label>   recorded in state.max_runtime_ceiling
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MISSION_SLUG = "cortex-roundtrip-omo-omc";
const MISSION_DIR = path.resolve(".omc", "autoresearch", MISSION_SLUG);
const RUNS_DIR = path.join(MISSION_DIR, "runs");
const STATE_FILE = path.join(MISSION_DIR, "state.json");
const EVALUATOR = path.resolve("scripts", "autoresearch", "cortex-roundtrip-evaluator.ts");

const CEILING = process.env.CORTEX_AR_CEILING || "iter-0001-only";
const FORCE_NEW_RUN = process.env.CORTEX_AR_NEW_RUN === "1";

type State = {
  mission_slug: string;
  mission_dir_rel: string;
  evaluator: { command: string; script_rel: string };
  current_run_id: string | null;
  iteration_count: number;
  started_at: string;
  updated_at: string;
  max_runtime_ceiling: string;
  last_pass: boolean | null;
  last_score: number | null;
};

function loadState(): State | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return null;
  }
}

function saveState(s: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function relFromCwd(p: string): string {
  return path.relative(process.cwd(), p).split(path.sep).join("/");
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function resolveTsxBin(): string {
  const c = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
  if (fs.existsSync(c)) return c;
  throw new Error("tsx CLI not found at node_modules/tsx/dist/cli.mjs. Run `npm install`.");
}

function main() {
  ensureDir(MISSION_DIR);
  ensureDir(RUNS_DIR);

  const now = new Date().toISOString();
  let state = loadState();

  if (!state) {
    state = {
      mission_slug: MISSION_SLUG,
      mission_dir_rel: relFromCwd(MISSION_DIR),
      evaluator: {
        command: "npx tsx scripts/autoresearch/cortex-roundtrip-evaluator.ts",
        script_rel: "scripts/autoresearch/cortex-roundtrip-evaluator.ts",
      },
      current_run_id: null,
      iteration_count: 0,
      started_at: now,
      updated_at: now,
      max_runtime_ceiling: CEILING,
      last_pass: null,
      last_score: null,
    };
  }

  if (FORCE_NEW_RUN || !state.current_run_id) {
    state.current_run_id = newRunId();
  }
  const runId = state.current_run_id;
  const runDir = path.join(RUNS_DIR, runId);
  const evalDir = path.join(runDir, "evaluations");
  ensureDir(evalDir);

  state.iteration_count += 1;
  const iterId = `iteration-${state.iteration_count.toString().padStart(4, "0")}`;
  const iterPath = path.join(evalDir, `${iterId}.json`);
  const decisionLog = path.join(runDir, "decision-log.md");
  const stderrLog = path.join(runDir, `${iterId}.stderr.log`);

  const tsxBin = resolveTsxBin();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const proc = spawnSync(
    process.execPath,
    [tsxBin, EVALUATOR],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_AR_ITERATION_ID: iterId,
        CORTEX_AR_RUN_ID: runId,
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }
  );

  const elapsedMs = Date.now() - startMs;
  const finishedAt = new Date().toISOString();
  const stdout = proc.stdout || "";
  const stderr = proc.stderr || "";
  const exitCode = proc.status ?? -1;

  fs.writeFileSync(stderrLog, stderr);

  let evalJson: any;
  try {
    evalJson = JSON.parse(stdout.trim());
  } catch (e: any) {
    evalJson = {
      mission: MISSION_SLUG,
      iteration_id: iterId,
      timestamp: finishedAt,
      pass: false,
      score: 0,
      thresholds: { success_rate: 1.0, recall_p95_ms: 500, ingest_p95_ms: 2000 },
      results: {},
      measured: { recall_p95_ms: null, ingest_p95_ms: null, total_calls: 0, total_errors: 0 },
      errors: [
        {
          call: "runner.parse_stdout",
          message: `Failed to parse evaluator stdout: ${e?.message ?? String(e)}`,
        },
      ],
    };
    fs.writeFileSync(path.join(runDir, `${iterId}.stdout.raw`), stdout);
  }
  evalJson._runner = {
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: elapsedMs,
    exit_code: exitCode,
    run_id: runId,
    iteration_id: iterId,
  };

  fs.writeFileSync(iterPath, JSON.stringify(evalJson, null, 2) + "\n");

  const passStr = evalJson.pass ? "PASS" : "FAIL";
  const m = evalJson.measured || {};
  const mcp = evalJson.results?.mcp || {};
  const rest = evalJson.results?.rest || {};
  const headline = `## ${iterId} — ${finishedAt}`;
  const body = [
    "",
    `- Run: \`${runId}\``,
    `- Result: **${passStr}**  | score: \`${evalJson.score}\``,
    `- Elapsed: \`${(elapsedMs / 1000).toFixed(2)}s\`  | evaluator exit: \`${exitCode}\``,
    `- Measured: recall_p95=\`${m.recall_p95_ms ?? "n/a"}ms\`, ingest_p95=\`${m.ingest_p95_ms ?? "n/a"}ms\`, errors=\`${m.total_errors ?? "n/a"}/${m.total_calls ?? "n/a"}\``,
    `- MCP: init=\`${mcp.init?.ms ?? "?"}ms\`/${mcp.init?.ok ? "ok" : "FAIL"}, status=\`${mcp.status?.ms ?? "?"}ms\`/${mcp.status?.ok ? "ok" : "FAIL"}, self_check=\`${mcp.self_check?.ms ?? "?"}ms\`/${mcp.self_check?.ok ? "ok" : "FAIL"}`,
    `- MCP ingest: n=\`${mcp.ingest?.n ?? 0}\`, errors=\`${mcp.ingest?.errors ?? 0}\`, p50=\`${mcp.ingest?.p50_ms ?? "?"}ms\`, p95=\`${mcp.ingest?.p95_ms ?? "?"}ms\`, max=\`${mcp.ingest?.max_ms ?? "?"}ms\``,
    `- MCP recall: n=\`${mcp.recall?.n ?? 0}\`, errors=\`${mcp.recall?.errors ?? 0}\`, p50=\`${mcp.recall?.p50_ms ?? "?"}ms\`, p95=\`${mcp.recall?.p95_ms ?? "?"}ms\`, max=\`${mcp.recall?.max_ms ?? "?"}ms\``,
    `- REST: health=\`${rest.health?.ms ?? "?"}ms\`/${rest.health?.ok ? "ok" : "FAIL"}, status=\`${rest.status?.ms ?? "?"}ms\`/${rest.status?.ok ? "ok" : "FAIL"}, ingest=\`${rest.ingest?.ms ?? "?"}ms\`/${rest.ingest?.ok ? "ok" : "FAIL"}, search=\`${rest.search?.ms ?? "?"}ms\`/${rest.search?.ok ? "ok" : "FAIL"}`,
    `- Evaluation: [\`evaluations/${iterId}.json\`](evaluations/${iterId}.json)`,
    "",
  ];
  const errs = Array.isArray(evalJson.errors) ? evalJson.errors : [];
  if (errs.length > 0) {
    body.push("**Errors:**");
    body.push("");
    for (const e of errs.slice(0, 10)) {
      body.push(`- \`${e.call}\`: ${String(e.message).slice(0, 220)}`);
    }
    if (errs.length > 10) body.push(`- ...and ${errs.length - 10} more`);
    body.push("");
  }

  if (!fs.existsSync(decisionLog)) {
    const header = [
      `# Decision Log — ${MISSION_SLUG}`,
      "",
      `- Run: \`${runId}\``,
      `- Mission: \`${relFromCwd(MISSION_DIR)}\``,
      `- Started: ${state.started_at}`,
      `- Max-runtime ceiling: ${state.max_runtime_ceiling}`,
      `- Evaluator: \`${state.evaluator.script_rel}\``,
      "",
      "---",
      "",
    ].join("\n");
    fs.writeFileSync(decisionLog, header);
  }
  fs.appendFileSync(decisionLog, headline + "\n" + body.join("\n") + "\n");

  state.updated_at = finishedAt;
  state.last_pass = !!evalJson.pass;
  state.last_score = typeof evalJson.score === "number" ? evalJson.score : null;
  saveState(state);

  console.log("");
  console.log(`[autoresearch] ${iterId} ${passStr}  score=${evalJson.score}  elapsed=${(elapsedMs / 1000).toFixed(2)}s  exit=${exitCode}`);
  console.log(`[autoresearch] eval JSON: ${iterPath}`);
  console.log(`[autoresearch] decision log: ${decisionLog}`);
  console.log(`[autoresearch] stderr log:  ${stderrLog}`);
  console.log(`[autoresearch] state:       ${STATE_FILE}`);

  process.exit(evalJson.pass ? 0 : 1);
}

main();
