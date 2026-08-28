#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";
import Ajv from "ajv";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

const base = process.env.CORTEX_CONNECTOR_BASE_URL || "https://cortex.obsidiannetwork.au";
const resource = `${base}/mcp`;
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const username = process.env.MCP_OAUTH_USERNAME;
const password = process.env.MCP_OAUTH_PASSWORD;
const restartGateway = process.argv.includes("--restart-gateway");
const useLegacyClient = process.argv.includes("--legacy-client");

if (!username || !password) {
  throw new Error("MCP_OAUTH_USERNAME and MCP_OAUTH_PASSWORD must be configured in .env");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function verifierPair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: crypto.createHash("sha256").update(verifier).digest("base64url")
  };
}

async function readJson(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${parsed.error || "unknown error"}`);
  }
  return parsed;
}

async function register() {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Cortex deployment audit",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none"
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const registration = await readJson(response, "dynamic client registration");
  check(/^chatgpt-[A-Za-z0-9_-]{24}$/.test(registration.client_id), "unexpected client ID shape");
  return registration;
}

function authorizationUrl(clientId, pair, state) {
  return `${base}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "cortex:read cortex:write mcp",
    state,
    code_challenge: pair.challenge,
    code_challenge_method: "S256",
    resource
  })}`;
}

async function login(clientId, pair, state) {
  const response = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username,
      password,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "cortex:read cortex:write mcp",
      state,
      code_challenge: pair.challenge,
      resource
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000)
  });
  check(response.status === 302, `authorization login returned ${response.status}`);

  const location = new URL(response.headers.get("location"));
  check(location.origin === "https://chatgpt.com", "authorization redirected to an unexpected origin");
  check(location.searchParams.get("state") === state, "OAuth state was not preserved");

  const cookie = (response.headers.get("set-cookie") || "").split(";", 1)[0];
  check(cookie.startsWith("__Host-cortex_oauth_session="), "signed login cookie was not set");
  return { code: location.searchParams.get("code"), cookie };
}

async function exchange(clientId, code, verifier) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource
    }),
    signal: AbortSignal.timeout(30_000)
  });
  return await readJson(response, "authorization-code exchange");
}

async function refresh(clientId, refreshToken) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource
    }),
    signal: AbortSignal.timeout(30_000)
  });
  return await readJson(response, "refresh-token exchange");
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8091/api/v1/health", {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("gateway did not become healthy after restart");
}

function parseRpcBody(text, contentType, id) {
  let messages;
  if (contentType.includes("text/event-stream")) {
    messages = text
      .split(/\r?\n\r?\n/)
      .flatMap((event) => {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") return [];
        try {
          return [JSON.parse(data)];
        } catch {
          return [];
        }
      });
  } else {
    messages = text ? [JSON.parse(text)] : [];
  }
  return messages.find((message) => message.id === id) || messages.at(-1) || null;
}

async function mcpRequest(token, sessionId, message) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2025-06-18";
  }

  const response = await fetch(resource, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${message.method} failed with ${response.status}`);

  const payload = response.status === 202
    ? null
    : parseRpcBody(text, response.headers.get("content-type") || "", message.id);
  if (payload?.error) {
    throw new Error(`MCP ${message.method} error ${payload.error.code}: ${payload.error.message}`);
  }
  return {
    payload,
    sessionId: response.headers.get("mcp-session-id") || sessionId
  };
}

function toolErrorCode(result) {
  if (result?.structuredContent?.errors?.[0]?.code) {
    return result.structuredContent.errors[0].code;
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text)?.errors?.[0]?.code || null;
  } catch {
    return null;
  }
}

const registration = useLegacyClient
  ? { client_id: `chatgpt-${crypto.randomBytes(18).toString("base64url")}` }
  : await register();
const firstPair = verifierPair();
const firstAuthorization = await login(
  registration.client_id,
  firstPair,
  "deployment-audit-before-restart"
);
check(firstAuthorization.code, "authorization code missing");

if (restartGateway) {
  execFileSync("docker", ["compose", "restart", "cortex-oauth-gateway"], {
    cwd: process.cwd(),
    stdio: "ignore"
  });
  await waitForGateway();
}

const firstTokens = await exchange(
  registration.client_id,
  firstAuthorization.code,
  firstPair.verifier
);
check(firstTokens.access_token && firstTokens.refresh_token, "token pair incomplete");

const secondPair = verifierPair();
const cookieResponse = await fetch(
  authorizationUrl(registration.client_id, secondPair, "deployment-audit-cookie-reuse"),
  {
    headers: { cookie: firstAuthorization.cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000)
  }
);
check(cookieResponse.status === 302, `same-IP cookie was not reused (${cookieResponse.status})`);
const cookieRedirect = new URL(cookieResponse.headers.get("location"));
check(
  cookieRedirect.searchParams.get("state") === "deployment-audit-cookie-reuse",
  "cookie authorization state mismatch"
);
const secondTokens = await exchange(
  registration.client_id,
  cookieRedirect.searchParams.get("code"),
  secondPair.verifier
);
check(secondTokens.access_token, "cookie authorization did not produce a token");

const refreshed = await refresh(registration.client_id, firstTokens.refresh_token);
check(refreshed.access_token && refreshed.refresh_token, "refresh did not rotate a complete token pair");
check(refreshed.refresh_token !== firstTokens.refresh_token, "refresh token was not rotated");

let rpc = await mcpRequest(refreshed.access_token, null, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cortex-deployment-audit", version: "1.0.0" }
  }
});
check(rpc.payload?.result?.protocolVersion, "MCP initialize result missing");
let sessionId = rpc.sessionId;
check(sessionId, "MCP session ID missing");
const negotiatedProtocol = rpc.payload.result.protocolVersion;

rpc = await mcpRequest(refreshed.access_token, sessionId, {
  jsonrpc: "2.0",
  method: "notifications/initialized",
  params: {}
});
sessionId = rpc.sessionId;

rpc = await mcpRequest(refreshed.access_token, sessionId, {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {}
});
const tools = rpc.payload?.result?.tools;
check(Array.isArray(tools), "tools/list did not return a tool array");
check(tools.length === 29, `expected 29 tools, received ${tools.length}`);
check(new Set(tools.map((tool) => tool.name)).size === 29, "duplicate tool names detected");

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
let compiledSchemas = 0;
let metadataComplete = 0;
const toolByName = new Map();
for (const tool of tools) {
  check(tool.inputSchema && tool.outputSchema, `${tool.name} is missing a schema`);
  ajv.compile(tool.inputSchema);
  ajv.compile(tool.outputSchema);
  compiledSchemas += 2;

  const annotations = tool.annotations || {};
  const meta = tool._meta || {};
  check(
    ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
      .every((key) => typeof annotations[key] === "boolean"),
    `${tool.name} has incomplete safety annotations`
  );
  check(
    Array.isArray(tool.securitySchemes) && tool.securitySchemes.length > 0,
    `${tool.name} has no security scheme`
  );
  check(meta["openai/visibility"] === "public", `${tool.name} is not public to ChatGPT`);
  check(
    typeof meta["openai/toolInvocation/invoking"] === "string",
    `${tool.name} has no invoking label`
  );
  check(
    typeof meta["openai/toolInvocation/invoked"] === "string",
    `${tool.name} has no invoked label`
  );
  metadataComplete += 1;
  toolByName.set(tool.name, tool);
}

const safeCalls = [
  ["cortex_status", { agent_id: "arlo" }],
  ["cortex_vitals", { agent_id: "arlo" }],
  ["cortex_state_history", { agent_id: "arlo", hours: 24 }],
  ["cortex_relationships", { agent_id: "arlo", overdue_only: false }],
  ["cortex_labile", { agent_id: "arlo" }]
];
const safeResults = {};
let requestId = 10;
for (const [name, args] of safeCalls) {
  rpc = await mcpRequest(refreshed.access_token, sessionId, {
    jsonrpc: "2.0",
    id: requestId++,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const result = rpc.payload?.result;
  check(result && result.isError !== true, `${name} returned an error`);
  check(result.structuredContent, `${name} returned no structured content`);
  const validate = ajv.compile(toolByName.get(name).outputSchema);
  check(validate(result.structuredContent), `${name} output did not match its advertised schema`);
  safeResults[name] = "ok";
}

rpc = await mcpRequest(refreshed.access_token, sessionId, {
  jsonrpc: "2.0",
  id: requestId++,
  method: "tools/call",
  params: {
    name: "cortex_ingest_file",
    arguments: {
      agent_id: "arlo",
      file_path: "/proc/self/environ",
      source_type: "text"
    }
  }
});
const blockedImport = rpc.payload?.result;
check(blockedImport?.isError === true, "server filesystem import escape was not blocked");
check(toolErrorCode(blockedImport) === "invalid_import_path", "unexpected import rejection code");

rpc = await mcpRequest(refreshed.access_token, sessionId, {
  jsonrpc: "2.0",
  id: requestId++,
  method: "tools/call",
  params: { name: "cortex_observe", arguments: { agent_id: "arlo", store: false } }
});
const blockedObserve = rpc.payload?.result;
check(blockedObserve?.isError === true, "headless screen capture was not rejected");
check(
  toolErrorCode(blockedObserve) === "screen_capture_unavailable",
  "unexpected screen-capture rejection code"
);

const restResponse = await fetch(`${base}/api/v1/status?agentId=arlo`, {
  headers: { authorization: `Bearer ${refreshed.access_token}` },
  signal: AbortSignal.timeout(30_000)
});
check(restResponse.ok, `authorized REST status failed (${restResponse.status})`);
await restResponse.arrayBuffer();

const stateSummary = execFileSync("docker", [
  "exec",
  "cortex-oauth-gateway",
  "node",
  "-e",
  "const fs=require('fs');const p='/var/lib/cortex-oauth/state.json';const s=fs.statSync(p);const d=JSON.parse(fs.readFileSync(p));process.stdout.write(JSON.stringify({mode:(s.mode&0o777).toString(8),clients:d.clients.length,codes:d.codes.length}))"
], { encoding: "utf8" });
const persistedState = JSON.parse(stateSummary);
check(persistedState.mode === "600", `OAuth state file mode is ${persistedState.mode}`);
if (!useLegacyClient) {
  check(persistedState.clients >= 1, "dynamic client was not persisted");
}

console.log(JSON.stringify({
  oauth: {
    dynamic_registration: useLegacyClient ? "legacy_compatibility" : "ok",
    authorization_code_survived_restart: restartGateway,
    same_ip_cookie_reused: true,
    refresh_token_rotated: true,
    oauth_state_mode: persistedState.mode,
    persisted_clients: persistedState.clients,
    outstanding_codes: persistedState.codes
  },
  mcp: {
    protocol: negotiatedProtocol,
    visible_tools: tools.length,
    unique_tools: new Set(tools.map((tool) => tool.name)).size,
    schemas_compiled: compiledSchemas,
    chatgpt_metadata_complete: metadataComplete
  },
  safe_tool_calls: safeResults,
  safety_checks: {
    server_file_escape_blocked: true,
    headless_capture_failed_without_storage: true,
    authenticated_rest_status: "ok"
  }
}, null, 2));
