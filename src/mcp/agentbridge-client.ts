import "dotenv/config";

/**
 * Minimal, opt-in client for the AgentBridge read-only MCP-over-HTTP endpoint.
 *
 * cortex_prompt_context uses this to combine CORTEX memory with LIVE session context by
 * calling the AgentBridge tools `agentbridge_list_sessions` and `agentbridge_inspect_session`
 * over the Streamable-HTTP endpoint that agentbridge/agentbridge/mcp_http.py serves at
 * POST /api/mcp. Because it targets that endpoint (not the raw stdio surface), every call is
 * already subject to AgentBridge's own read-only allowlist + secret redaction.
 *
 * Safety model:
 *  - OFF by default. Enrichment only happens when AGENTBRIDGE_MCP_URL is explicitly set.
 *  - Unconfigured  -> collect() returns undefined (digest stays memory-only, no noise).
 *  - Configured but unreachable / errored -> collect() returns an explicit offline note so
 *    the Rewriter degrades honestly ("...without live session context") instead of silently
 *    dropping it. No exception ever propagates to the caller.
 *  - Only read-only tools are ever invoked; fetch is injected so this is unit-testable.
 */

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

const DEFAULT_TIMEOUT_MS = 2500;
const SESSION_TIMEOUT_MS = Number(process.env.AGENTBRIDGE_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

const OFFLINE_NOTE = "[AgentBridge: host offline; rewriting without live session context]";

// Bounded rendering so a chatty session can't blow the digest budget.
const MAX_SESSIONS_LISTED = 12;
const MAX_TURNS_SHOWN = 3;
const TURN_SNIPPET_CHARS = 240;
const MAX_TOUCHED = 12;

function jsonRpcBody(id: number, tool: string, args: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
}

// Calls one AgentBridge MCP tool; returns parsed payload or null on ANY failure
// (non-2xx, JSON-RPC error, isError, timeout, abort, bad JSON). Never throws.
async function callTool(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // AgentBridge's Streamable-HTTP transport requires the dual Accept header.
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: jsonRpcBody(1, tool, args),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.error) return null;
    const result = data.result;
    if (!result || result.isError) return null;
    const text = result.content?.[0]?.text;
    if (typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null; // timeout / abort / network error — degrade gracefully
  } finally {
    clearTimeout(timer);
  }
}

function renderSessions(list: any[]): string {
  const active = list.filter((s) => s && s.is_active);
  const shown = (active.length ? active : list).slice(0, MAX_SESSIONS_LISTED);
  const names = shown
    .map((s) => `${s?.name || s?.sessionId || "?"} (${s?.platform || "?"})`)
    .join(", ");
  return `Active sessions: ${active.length}/${list.length}${names ? ` — ${names}` : ""}`;
}

function renderInspect(detail: any): string {
  const lines: string[] = [];
  const claim = detail?.stack_claim || {};
  const claimTxt = claim?.holds_claim ? `holds claim (${claim.purpose || "-"})` : "no claim";
  lines.push(`Focus: ${detail?.name || "?"} (${detail?.platform || "?"}) — cwd ${detail?.cwd || "?"} · branch ${detail?.gitBranch || "-"} · ${claimTxt}`);
  const turns = (detail?.recent_turns || []).slice(-MAX_TURNS_SHOWN);
  for (const t of turns) {
    const content = String(t?.content || "").replace(/\s+/g, " ").trim().slice(0, TURN_SNIPPET_CHARS);
    if (content) lines.push(`  ${t?.role || "?"}: ${content}`);
  }
  const touched = (detail?.touched_files || []).slice(0, MAX_TOUCHED);
  if (touched.length) lines.push(`  Touched: ${touched.join(", ")}`);
  return lines.join("\n");
}

export interface CollectOptions {
  target?: string;
  url?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * Returns a compact markdown block of live session context, or:
 *   - undefined  when AgentBridge is not configured (caller omits the section),
 *   - OFFLINE_NOTE when configured but unreachable/erroring.
 */
export async function collectAgentBridgeSession(opts: CollectOptions = {}): Promise<string | undefined> {
  const url = (opts.url ?? process.env.AGENTBRIDGE_MCP_URL ?? "").trim();
  if (!url) return undefined; // opt-in: not configured -> memory-only, silently

  const token = (opts.token ?? process.env.AGENTBRIDGE_MCP_TOKEN ?? "").trim();
  const timeoutMs = opts.timeoutMs ?? SESSION_TIMEOUT_MS;
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) return OFFLINE_NOTE;

  const sections: string[] = [];
  let anySuccess = false;

  // 1) list_sessions (active) — which work is in flight.
  const list = await callTool(fetchImpl, url, token, "agentbridge_list_sessions", { active_only: true }, timeoutMs);
  if (Array.isArray(list)) {
    anySuccess = true;
    if (list.length > 0) sections.push(renderSessions(list));
  }

  // 2) inspect_session — deep-dive a target, or the most recent active session.
  let target = (opts.target || "").trim();
  if (!target && Array.isArray(list)) {
    const firstActive = list.find((s) => s && s.is_active) || list[0];
    target = firstActive ? String(firstActive.name || firstActive.sessionId || "") : "";
  }
  if (target) {
    const detail = await callTool(fetchImpl, url, token, "agentbridge_inspect_session", { target, turns: 5 }, timeoutMs);
    if (detail && typeof detail === "object" && !detail.error) {
      anySuccess = true;
      sections.push(renderInspect(detail));
    }
  }

  if (!anySuccess) return OFFLINE_NOTE;
  return sections.length ? sections.join("\n") : "[AgentBridge: no active sessions]";
}
