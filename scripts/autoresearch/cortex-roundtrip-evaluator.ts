#!/usr/bin/env node
/**
 * Autoresearch evaluator for the cortex-roundtrip-omo-omc mission.
 *
 * Drives Cortex through both lanes (MCP stdio + REST) in one invocation,
 * times every call, and emits a single JSON object on stdout matching the
 * schema in .omc/autoresearch/cortex-roundtrip-omo-omc/evaluator.json.
 *
 * Exit code: 0 on pass, 1 on fail.
 *
 * Env overrides:
 *   CORTEX_AR_ITERATION_ID   default: "iteration-0001"
 *   CORTEX_AR_AGENT_ID       default: "autoresearch-roundtrip"
 *   CORTEX_AR_REST_BASE      default: "http://127.0.0.1:3100"
 *   CORTEX_AR_DATABASE_URL   url passed to spawned MCP child; falls back to
 *                            DATABASE_URL, then localhost
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MISSION = "cortex-roundtrip-omo-omc";
const N_MEMORIES = 20;

const AGENT_ID = process.env.CORTEX_AR_AGENT_ID || "autoresearch-roundtrip";
const REST_BASE = process.env.CORTEX_AR_REST_BASE || "http://127.0.0.1:3100";
const ITERATION_ID = process.env.CORTEX_AR_ITERATION_ID || "iteration-0001";
const DATABASE_URL_FOR_CHILD =
  process.env.CORTEX_AR_DATABASE_URL ||
  (() => {
    const cur = process.env.DATABASE_URL || "";
    // .env in this repo uses placeholder hostname `host`; rewrite to localhost
    // so the host-side spawned MCP can actually connect to the local docker DB.
    if (/@host:5432\b/.test(cur)) {
      return "postgresql://cortex:cortex@127.0.0.1:5432/cortex";
    }
    return cur || "postgresql://cortex:cortex@127.0.0.1:5432/cortex";
  })();

const T_SUCCESS = 1.0;
const T_RECALL_P95 = 500;
const T_INGEST_P95 = 2000;

type Timed<T = unknown> = { ok: boolean; ms: number; err?: string; result?: T };
const errors: Array<{ call: string; message: string }> = [];

async function timed<T>(label: string, fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = performance.now();
  try {
    const result = await fn();
    return { ok: true, ms: Math.round(performance.now() - t0), result };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    errors.push({ call: label, message: msg });
    return { ok: false, ms: Math.round(performance.now() - t0), err: msg };
  }
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function resolveTsxBin(): string {
  const candidates = [
    path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
    path.resolve("node_modules", "tsx", "dist", "cli.cjs"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("tsx CLI not found in node_modules/tsx/dist/. Run `npm install` first.");
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function postJson(url: string, body: any): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`);
  }
  return res.json();
}

let _client: Client | null = null;

async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
  if (!_client) throw new Error("MCP client not connected");
  const result: any = await _client.callTool({ name, arguments: args });
  if (result?.isError) {
    const text = Array.isArray(result?.content)
      ? result.content.map((c: any) => c?.text ?? "").join(" ")
      : "";
    throw new Error(`tool ${name} returned isError: ${text.slice(0, 200)}`);
  }
  return result;
}

async function main() {
  const tsxBin = resolveTsxBin();
  const runToken = crypto.randomBytes(4).toString("hex");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxBin, path.resolve("src/mcp/server.ts")],
    env: {
      ...process.env,
      DATABASE_URL: DATABASE_URL_FOR_CHILD,
    } as Record<string, string>,
    cwd: process.cwd(),
    stderr: "inherit",
  });

  _client = new Client(
    { name: "autoresearch-evaluator", version: "1.0" },
    { capabilities: {} }
  );

  try {
    await _client.connect(transport);
  } catch (e: any) {
    errors.push({ call: "mcp.connect", message: e?.message ?? String(e) });
    emitAndExit({});
    return;
  }

  const init = await timed("mcp.init", () =>
    mcpCall("cortex_init", { agent_id: AGENT_ID })
  );

  const status = await timed("mcp.status", () =>
    mcpCall("cortex_status", { agent_id: AGENT_ID })
  );

  const restHealth = await timed("rest.health", () =>
    getJson(`${REST_BASE}/api/v1/health`)
  );
  const restStatus = await timed("rest.status", () =>
    getJson(`${REST_BASE}/api/v1/status?agentId=${encodeURIComponent(AGENT_ID)}`)
  );

  const mcpIngestMs: number[] = [];
  let mcpIngestErrors = 0;
  for (let i = 0; i < N_MEMORIES; i++) {
    const slot = i.toString().padStart(2, "0");
    const token = `tok_${runToken}_${slot}`;
    const content =
      `Autoresearch roundtrip ${ITERATION_ID} seed ${slot}: ` +
      `The secret token for slot ${slot} is ${token}. ` +
      `Run identifier ${runToken}.`;
    const r = await timed(`mcp.ingest.${slot}`, () =>
      mcpCall("cortex_ingest", {
        content,
        agent_id: AGENT_ID,
        source: `autoresearch/${ITERATION_ID}`,
        source_type: "autoresearch",
        priority: 2,
      })
    );
    mcpIngestMs.push(r.ms);
    if (!r.ok) mcpIngestErrors++;
  }

  const restIngestToken = `rest_${runToken}`;
  const restIngest = await timed("rest.ingest", () =>
    postJson(`${REST_BASE}/api/v1/ingest`, {
      agentId: AGENT_ID,
      content:
        `Autoresearch REST seed ${ITERATION_ID}: ` +
        `The REST token is ${restIngestToken}. Run ${runToken}.`,
      source: `autoresearch/${ITERATION_ID}`,
      sourceType: "autoresearch",
      priority: 2,
    })
  );

  const mcpRecallMs: number[] = [];
  let mcpRecallErrors = 0;
  for (let i = 0; i < N_MEMORIES; i++) {
    const slot = i.toString().padStart(2, "0");
    const token = `tok_${runToken}_${slot}`;
    const query =
      `What is the secret token for slot ${slot} in iteration ${ITERATION_ID}? ` +
      `Token reference ${token}, run ${runToken}.`;
    const r = await timed(`mcp.recall.${slot}`, () =>
      mcpCall("cortex_recall", {
        query,
        agent_id: AGENT_ID,
        token_budget: 1500,
      })
    );
    mcpRecallMs.push(r.ms);
    if (!r.ok) mcpRecallErrors++;
  }

  const restSearch = await timed("rest.search", () =>
    postJson(`${REST_BASE}/api/v1/search`, {
      agentId: AGENT_ID,
      query: `REST autoresearch token ${restIngestToken} run ${runToken}`,
      limit: 5,
    })
  );

  const selfCheck = await timed("mcp.self_check", () =>
    mcpCall("cortex_self_check", { agent_id: AGENT_ID, verbose: false })
  );

  try {
    await _client.close();
  } catch {
    /* noop */
  }

  emitAndExit({
    init,
    status,
    selfCheck,
    restHealth,
    restStatus,
    restIngest,
    restSearch,
    mcpIngestMs,
    mcpIngestErrors,
    mcpRecallMs,
    mcpRecallErrors,
  });
}

function summarizeLatency(arr: number[], errCount: number) {
  return {
    n: arr.length,
    errors: errCount,
    p50_ms: percentile(arr, 50),
    p95_ms: percentile(arr, 95),
    max_ms: arr.length > 0 ? Math.max(...arr) : 0,
  };
}

interface EmitArgs {
  init?: Timed;
  status?: Timed;
  selfCheck?: Timed;
  restHealth?: Timed;
  restStatus?: Timed;
  restIngest?: Timed;
  restSearch?: Timed;
  mcpIngestMs?: number[];
  mcpIngestErrors?: number;
  mcpRecallMs?: number[];
  mcpRecallErrors?: number;
}

function emitAndExit(a: EmitArgs) {
  const mcpIngestMs = a.mcpIngestMs ?? [];
  const mcpRecallMs = a.mcpRecallMs ?? [];

  const recallLatencies = [...mcpRecallMs];
  if (a.restSearch?.ms !== undefined) recallLatencies.push(a.restSearch.ms);
  const ingestLatencies = [...mcpIngestMs];
  if (a.restIngest?.ms !== undefined) ingestLatencies.push(a.restIngest.ms);

  const recall_p95 = percentile(recallLatencies, 95);
  const ingest_p95 = percentile(ingestLatencies, 95);

  const singletons = [
    a.init, a.status, a.selfCheck,
    a.restHealth, a.restStatus, a.restIngest, a.restSearch,
  ].filter(Boolean) as Timed[];
  const totalCalls = singletons.length + mcpIngestMs.length + mcpRecallMs.length;
  const totalErrors = errors.length;
  const success_rate = totalCalls > 0 ? 1 - totalErrors / totalCalls : 0;

  const healthOk =
    !!a.init?.ok && !!a.status?.ok && !!a.selfCheck?.ok &&
    !!a.restHealth?.ok && !!a.restStatus?.ok;

  const pass =
    totalErrors === 0 &&
    recall_p95 < T_RECALL_P95 &&
    ingest_p95 < T_INGEST_P95 &&
    healthOk;

  const latency_headroom = clamp(
    0.5 * (1 - recall_p95 / T_RECALL_P95) +
      0.5 * (1 - ingest_p95 / T_INGEST_P95),
    0,
    1
  );
  const score = Number((success_rate * latency_headroom).toFixed(4));

  const output = {
    mission: MISSION,
    iteration_id: ITERATION_ID,
    timestamp: new Date().toISOString(),
    pass,
    score,
    thresholds: {
      success_rate: T_SUCCESS,
      recall_p95_ms: T_RECALL_P95,
      ingest_p95_ms: T_INGEST_P95,
    },
    results: {
      mcp: {
        init: { ok: !!a.init?.ok, ms: a.init?.ms ?? 0 },
        status: { ok: !!a.status?.ok, ms: a.status?.ms ?? 0 },
        self_check: { ok: !!a.selfCheck?.ok, ms: a.selfCheck?.ms ?? 0 },
        ingest: summarizeLatency(mcpIngestMs, a.mcpIngestErrors ?? 0),
        recall: summarizeLatency(mcpRecallMs, a.mcpRecallErrors ?? 0),
      },
      rest: {
        health: { ok: !!a.restHealth?.ok, ms: a.restHealth?.ms ?? 0 },
        status: { ok: !!a.restStatus?.ok, ms: a.restStatus?.ms ?? 0 },
        ingest: { ok: !!a.restIngest?.ok, ms: a.restIngest?.ms ?? 0 },
        search: { ok: !!a.restSearch?.ok, ms: a.restSearch?.ms ?? 0 },
      },
    },
    measured: {
      recall_p95_ms: recall_p95,
      ingest_p95_ms: ingest_p95,
      total_calls: totalCalls,
      total_errors: totalErrors,
    },
    errors,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

main().catch((e: any) => {
  errors.push({ call: "evaluator.fatal", message: e?.message ?? String(e) });
  emitAndExit({});
});
