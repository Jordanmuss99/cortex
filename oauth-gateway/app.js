import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import express from "express";
import {
  CORTEX_TOOL_METADATA,
  decorateMcpResponse,
  requiredScopesForTool,
} from "./chatgpt-tools.js";
import {
  bindHostedRestRequest,
  bindHostedMcpRequest,
  HostedPolicyError,
  inspectAgentSelectors,
  isHostedPublicHealthRequest,
  isHostedPolicyError,
  matchHostedRestRoute,
  validateHostedMcpEnvelope
} from "./agent-policy.js";
import { OAuthStoreUnavailableError } from "./oauth-store.js";

const SCOPES = Object.freeze(["cortex:read", "cortex:write", "mcp"]);
const SUPPORTED_SCOPES = new Set(SCOPES);
const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const LOGIN_SESSION_COOKIE = "__Host-cortex_oauth_session";
const OPAQUE_LOGIN_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LOGIN_COOKIE_LENGTH = 2048;
const MAX_RATE_LIMIT_KEYS = 10_000;
const RATE_LIMIT_HASH_KEY = randomBytes(32);
const DEFAULT_LOGIN_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_REFRESH_RETRY_GRACE_SECONDS = 30;
const DEFAULT_LOGIN_ATTEMPT_LIMIT = 10;
const DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_REGISTRATION_ATTEMPT_LIMIT = 30;
const DEFAULT_REGISTRATION_ATTEMPT_WINDOW_SECONDS = 60 * 60;
const RAW_MCP_JSON = Symbol("rawMcpJson");
const RAW_REST_JSON = Symbol("rawRestJson");
const MAX_MCP_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_READINESS_RESPONSE_BYTES = 1024;
const MAX_MCP_READINESS_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_READINESS_TIMEOUT_MILLISECONDS = 3_000;
const DEFAULT_READINESS_CACHE_MILLISECONDS = 5_000;
const MAX_MCP_CLEANUP_TIMEOUT_MILLISECONDS = 500;
const MCP_READINESS_PROTOCOL_VERSION = "2025-06-18";
const MCP_READINESS_REQUEST_ID = "cortex-readiness";
const MCP_READINESS_PING_REQUEST_ID = "cortex-readiness-ping";
const MCP_SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;
const MCP_METADATA_DECODER = new TextDecoder("utf-8", { fatal: true });

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maximum, { allowEmpty = false } = {}) {
  return typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0)
    ? value
    : null;
}

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function normalizeClientIp(value) {
  if (Array.isArray(value)) return null;
  if (typeof value !== "string" || value.includes(",")) return null;

  let candidate = value.trim();
  if (candidate.startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function rateLimitSetting(config, name, fallback) {
  const value = config[name] ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`config.${name} must be a positive integer`);
  }
  return value;
}

function trustedProxyBlockList(config) {
  const cidrs = config.trustedProxyCidrs ?? [];
  if (!Array.isArray(cidrs)) {
    throw new TypeError("config.trustedProxyCidrs must be an array");
  }

  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const separator = typeof cidr === "string" ? cidr.lastIndexOf("/") : -1;
    const address = separator === -1 ? "" : cidr.slice(0, separator);
    const prefix = Number(separator === -1 ? NaN : cidr.slice(separator + 1));
    const version = isIP(address);
    const maximumPrefix = version === 4 ? 32 : 128;
    if (
      !version ||
      !Number.isSafeInteger(prefix) ||
      prefix < 0 ||
      prefix > maximumPrefix
    ) {
      throw new TypeError("config.trustedProxyCidrs contains an invalid CIDR");
    }
    blockList.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
  }
  return blockList;
}

function createTrustedClientIpResolver(config) {
  const trustedIpHeader = config.trustedIpHeader ?? "";
  const trustedProxies = trustedProxyBlockList(config);
  if (trustedIpHeader && (typeof trustedIpHeader !== "string" ||
    !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(trustedIpHeader))) {
    throw new TypeError("config.trustedIpHeader must be an HTTP header name");
  }
  if (trustedIpHeader && (config.trustedProxyCidrs?.length ?? 0) === 0) {
    throw new TypeError("config.trustedProxyCidrs is required with trustedIpHeader");
  }

  return function requestClientIp(req) {
    const socketIp = normalizeClientIp(req.socket.remoteAddress);
    if (!socketIp || !trustedIpHeader) return socketIp;

    const version = isIP(socketIp);
    if (!trustedProxies.check(socketIp, version === 4 ? "ipv4" : "ipv6")) {
      return socketIp;
    }

    // Once a peer is trusted as the configured ingress, its canonical client
    // header is mandatory. Falling back to the proxy address would bind many
    // unrelated browsers to the same security identity.
    return normalizeClientIp(req.headers[trustedIpHeader]);
  };
}

function createPublicRateLimiter(config, requestClientIp) {

  const settings = {
    login: {
      bucket: new Map(),
      maximum: rateLimitSetting(
        config,
        "loginAttemptLimit",
        DEFAULT_LOGIN_ATTEMPT_LIMIT
      ),
      windowSeconds: rateLimitSetting(
        config,
        "loginAttemptWindowSeconds",
        DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS
      )
    },
    registration: {
      bucket: new Map(),
      maximum: rateLimitSetting(
        config,
        "registrationAttemptLimit",
        DEFAULT_REGISTRATION_ATTEMPT_LIMIT
      ),
      windowSeconds: rateLimitSetting(
        config,
        "registrationAttemptWindowSeconds",
        DEFAULT_REGISTRATION_ATTEMPT_WINDOW_SECONDS
      )
    }
  };

  function digestKey(req, purpose) {
    return createHmac("sha256", RATE_LIMIT_HASH_KEY)
      .update("cortex-oauth:rate-limit:v2\0")
      .update(purpose)
      .update("\0")
      .update(requestClientIp(req) ?? "unknown")
      .digest("base64url");
  }

  function consume(setting, key) {
    const current = Date.now();
    for (const [candidate, entry] of setting.bucket) {
      if (entry.resetAt <= current) setting.bucket.delete(candidate);
    }

    if (setting.bucket.size >= MAX_RATE_LIMIT_KEYS && !setting.bucket.has(key)) {
      const oldest = setting.bucket.keys().next().value;
      if (oldest !== undefined) setting.bucket.delete(oldest);
    }

    let entry = setting.bucket.get(key);
    if (!entry || entry.resetAt <= current) {
      entry = {
        count: 0,
        resetAt: current + setting.windowSeconds * 1000
      };
      setting.bucket.set(key, entry);
    }
    if (entry.count >= setting.maximum) {
      return Math.max(1, Math.ceil((entry.resetAt - current) / 1000));
    }
    entry.count += 1;
    return 0;
  }

  return function enforce(req, res, purpose) {
    const setting = settings[purpose];
    const retryAfter = consume(setting, digestKey(req, purpose));
    if (retryAfter === 0) return true;

    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "temporarily_unavailable",
      error_description: "Too many attempts. Try again later."
    });
    return false;
  };
}

function bearerToken(req) {
  const authorization = req.header("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function oauthChallenge(res, baseUrl) {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer error="invalid_token", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
  );
  return res.status(401).json({ error: "invalid_token" });
}

function temporarilyUnavailable(res) {
  return res.status(503).json({ error: "temporarily_unavailable" });
}

function resolveClientCredentials(req) {
  if (
    req.body?.client_assertion !== undefined ||
    req.body?.client_assertion_type !== undefined
  ) return null;

  const authorization = req.header("authorization");
  if (authorization) {
    const match = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
    if (!match || req.body?.client_secret !== undefined) return null;
    let decoded;
    try {
      decoded = Buffer.from(match[1], "base64").toString("utf8");
    } catch {
      return null;
    }
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    let clientId;
    let clientSecret;
    try {
      clientId = decodeURIComponent(decoded.slice(0, separator));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {
      return null;
    }
    if (
      !boundedString(clientId, 512) ||
      clientId !== clientId.trim() ||
      (req.body?.client_id !== undefined && req.body.client_id !== clientId)
    ) return null;
    return Object.freeze({ clientId, clientSecret, method: "client_secret_basic" });
  }

  const clientId = boundedString(req.body?.client_id, 512);
  if (!clientId || clientId !== clientId.trim()) return null;
  if (req.body?.client_secret !== undefined) {
    if (typeof req.body.client_secret !== "string" || req.body.client_secret.length > 4096) {
      return null;
    }
    return Object.freeze({
      clientId,
      clientSecret: req.body.client_secret,
      method: "client_secret_post"
    });
  }
  return Object.freeze({ clientId, clientSecret: "", method: "none" });
}

function requireClientAuthentication(res, client, credentials, verifyStaticClientSecret) {
  const validPublic =
    client?.status === "active" &&
    client?.tokenEndpointAuthMethod === "none" &&
    credentials?.method === "none";
  const validStaticSecret =
    client?.status === "active" &&
    client?.clientKind === "static" &&
    client?.tokenEndpointAuthMethod !== "none" &&
    new Set(["client_secret_basic", "client_secret_post"]).has(credentials?.method) &&
    typeof verifyStaticClientSecret === "function" &&
    verifyStaticClientSecret(credentials.clientId, credentials.clientSecret) === true;
  if (validPublic || validStaticSecret) return true;
  if (client?.tokenEndpointAuthMethod === "none" && credentials?.method !== "none") {
    res.status(400).json({ error: "invalid_client" });
    return false;
  }
  if (credentials?.method === "client_secret_basic") {
    res.setHeader("WWW-Authenticate", 'Basic realm="cortex-oauth"');
  }
  res.status(401).json({ error: "invalid_client" });
  return false;
}

function invalidClientResponse(req, res) {
  const authorization = req.header("authorization") ?? "";
  if (/^Basic(?:\s|$)/i.test(authorization)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="cortex-oauth"');
    return res.status(401).json({ error: "invalid_client" });
  }
  return res.status(400).json({ error: "invalid_client" });
}

function isStoreUnavailable(error) {
  return error instanceof OAuthStoreUnavailableError ||
    error?.name === "OAuthStoreUnavailableError";
}

function grantedScopes(context) {
  const scopes = context?.scopes;
  if (scopes instanceof Set) return scopes;
  if (Array.isArray(scopes)) return new Set(scopes);
  return new Set();
}

function requireScopes(res, context, required) {
  const granted = grantedScopes(context);
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length === 0) return true;

  res.setHeader(
    "WWW-Authenticate",
    `Bearer error="insufficient_scope", scope="${required.join(" ")}"`
  );
  res.status(403).json({
    error: "insufficient_scope",
    error_description: `Missing required scope(s): ${missing.join(", ")}`
  });
  return false;
}

function canonicalScopes(value) {
  if (typeof value !== "string") return null;
  const requested = value.split(/\s+/).filter(Boolean);
  if (requested.length === 0) return null;
  const unique = new Set(requested);
  if (
    unique.size !== requested.length ||
    requested.some((scope) => !SUPPORTED_SCOPES.has(scope))
  ) {
    return null;
  }
  return SCOPES.filter((scope) => unique.has(scope));
}

function validChatGptRedirect(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return false;
  }
  if (/[?#]/.test(raw)) return false;

  try {
    const redirect = new URL(raw);
    return raw === `${redirect.origin}${redirect.pathname}` &&
      redirect.origin === "https://chatgpt.com" &&
      redirect.username === "" &&
      redirect.password === "" &&
      (
        redirect.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(redirect.pathname)
      );
  } catch {
    return false;
  }
}

function validateStringArray(value, allowed, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) return null;
  if (
    new Set(value).size !== value.length ||
    value.some((entry) => typeof entry !== "string" || !allowed.has(entry))
  ) {
    return null;
  }
  return [...value];
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function readLoginSessionCookie(req) {
  const header = req.headers.cookie;
  if (header === undefined) return Object.freeze({ kind: "missing" });
  if (typeof header !== "string") return Object.freeze({ kind: "invalid" });

  const values = [];
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    if (name !== LOGIN_SESSION_COOKIE) continue;
    if (separator === -1) return Object.freeze({ kind: "invalid" });
    values.push(part.slice(separator + 1));
  }

  if (values.length === 0) return Object.freeze({ kind: "missing" });
  if (
    values.length !== 1 ||
    values[0].length === 0 ||
    values[0].length > MAX_LOGIN_COOKIE_LENGTH
  ) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind: "present", raw: values[0] });
}

function clearLoginSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${LOGIN_SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ` +
      "Path=/; HttpOnly; Secure; SameSite=Lax"
  );
}

function setLoginSessionCookie(res, raw, expiresAt, current) {
  if (
    typeof raw !== "string" ||
    !OPAQUE_LOGIN_COOKIE_PATTERN.test(raw) ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime()) ||
    !(current instanceof Date) ||
    !Number.isFinite(current.getTime())
  ) {
    return false;
  }
  const maxAge = Math.floor((expiresAt.getTime() - current.getTime()) / 1000);
  if (maxAge <= 0) return false;

  res.setHeader(
    "Set-Cookie",
    `${LOGIN_SESSION_COOKIE}=${raw}; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}; ` +
      "Path=/; HttpOnly; Secure; SameSite=Lax"
  );
  return true;
}

function renderLoginForm(res, authorization, { clearCookie = false } = {}) {
  if (clearCookie) clearLoginSessionCookie(res);
  const hidden = {
    response_type: "code",
    client_id: authorization.clientId,
    redirect_uri: authorization.redirectUri,
    scope: authorization.scopes.join(" "),
    state: authorization.state,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: "S256",
    resource: authorization.resource
  };
  const hiddenInputs = Object.entries(hidden)
    .map(([name, value]) =>
      `<input type="hidden" name="${name}" value="${escapeHtmlAttribute(value)}" />`)
    .join("\n");
  return res.type("html").send(`<!doctype html>
<html><head><title>Cortex OAuth Login</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><h1>Cortex Login</h1><form method="post" action="/authorize">
${hiddenInputs}
<input name="username" autocomplete="username" required />
<input name="password" type="password" autocomplete="current-password" required />
<button type="submit">Authorize</button></form></body></html>`);
}

function requestFingerprints(req, clientIp, crypto) {
  if (
    typeof crypto.fingerprintClientIp !== "function" ||
    typeof crypto.fingerprintUserAgent !== "function"
  ) {
    return null;
  }

  let ipFingerprint;
  try {
    ipFingerprint = crypto.fingerprintClientIp(clientIp);
  } catch {
    return null;
  }

  const userAgent = req.headers["user-agent"];
  let userAgentFingerprint = null;
  if (
    typeof userAgent === "string" &&
    userAgent.length > 0 &&
    userAgent.length <= 2048 &&
    userAgent === userAgent.trim()
  ) {
    try {
      userAgentFingerprint = crypto.fingerprintUserAgent(userAgent);
    } catch {
      return null;
    }
  }
  return Object.freeze({ ipFingerprint, userAgentFingerprint });
}

function upstreamMcpUrl(mcpTarget) {
  return `${mcpTarget.replace(/\/+$/, "")}/mcp`;
}

function safeForwardedHeader(req, name) {
  const value = req.header(name);
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\r\n]/.test(value)
    ? value
    : null;
}

function hostedMcpRequestHeaders(req) {
  const headers = {
    "content-type": "application/json",
    accept: safeForwardedHeader(req, "accept") ||
      "application/json, text/event-stream",
    "accept-encoding": "identity"
  };
  for (const name of ["mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const value = safeForwardedHeader(req, name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

async function callHostedMcpUpstream(
  fetchImpl,
  mcpTarget,
  message,
  req,
  signal
) {
  return await fetchImpl(upstreamMcpUrl(mcpTarget), {
    method: "POST",
    headers: hostedMcpRequestHeaders(req),
    body: JSON.stringify(message),
    signal
  });
}

async function readBoundedMcpResponse(
  upstream,
  limitBytes = MAX_MCP_METADATA_RESPONSE_BYTES
) {
  if (!upstream.body) return "";
  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel("response too large");
      throw new Error("Hosted MCP metadata response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return MCP_METADATA_DECODER.decode(Buffer.concat(chunks));
  } catch {
    throw new Error("Hosted MCP metadata response is not valid UTF-8");
  }
}

function copyHostedMcpResponseHeaders(upstream, res) {
  for (const name of [
    "content-type",
    "cache-control",
    "mcp-session-id",
    "mcp-protocol-version",
    "retry-after"
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }
}

function hostedToolsListMediaType(contentType) {
  if (typeof contentType !== "string" || contentType.length > 512) return null;
  const essence = contentType.split(";", 1)[0].trim().toLowerCase();
  if (essence === "text/event-stream") return "event-stream";
  if (essence === "application/json" ||
    (essence.startsWith("application/") && essence.endsWith("+json"))) {
    return "json";
  }
  return null;
}

async function relayHostedToolsList(upstream, res) {
  if (!upstream.ok) {
    await upstream.body?.cancel("non-success tools/list response").catch(() => {});
    return res.status(502).json({ error: "bad_gateway" });
  }

  const body = await readBoundedMcpResponse(upstream);
  const contentType = upstream.headers.get("content-type");
  const mediaType = hostedToolsListMediaType(contentType);
  if (mediaType === null) {
    throw new Error("Hosted MCP tools/list response has an unsupported media type");
  }
  const projected = decorateMcpResponse(body, contentType);
  copyHostedMcpResponseHeaders(upstream, res);
  res.setHeader(
    "content-type",
    mediaType === "event-stream"
      ? "text/event-stream; charset=utf-8"
      : "application/json; charset=utf-8"
  );
  res.status(upstream.status);
  return projected.length === 0 ? res.end() : res.send(projected);
}

function relayHostedMcpStream(upstream, res) {
  copyHostedMcpResponseHeaders(upstream, res);
  res.status(upstream.status);
  if (!upstream.body) return res.end();

  res.flushHeaders();
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "bad_gateway" });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

function hostedPolicyResponse(res, error) {
  return res.status(error.status).json({
    error: error.code,
    error_description: error.safeDescription
  });
}

async function recordHostedPolicyRejection(
  dependencies,
  context,
  surface,
  error
) {
  if (error?.code !== "agent_mismatch") return;
  dependencies.logger.event("agent_mismatch", "rejected", { surface });
  if (typeof dependencies.store.recordSecurityEvent !== "function") return;

  try {
    await dependencies.store.recordSecurityEvent({
      eventType: "agent_mismatch",
      outcome: "rejected",
      principalId: context?.principalId ?? null,
      bindingId: context?.bindingId ?? null,
      grantId: context?.sid ?? null,
      requestId: randomUUID(),
      actorType: "connector",
      metadata: { surface },
    });
  } catch {
    dependencies.logger.event("audit_write_failed", "failed", {
      event_type: "agent_mismatch",
    });
  }
}

async function readBoundedReadinessBody(
  response,
  limitBytes = MAX_READINESS_RESPONSE_BYTES
) {
  const length = response.headers?.get?.("content-length");
  if (length !== null && length !== undefined) {
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limitBytes) {
      await response.body?.cancel?.("readiness response too large").catch(() => {});
      return null;
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel("readiness response too large").catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    return MCP_METADATA_DECODER.decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    );
  } catch {
    return null;
  }
}

async function probeHttpDependency(fetchImpl, target, path, bodyRequired, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(
      `${target.replace(/\/+$/, "")}${path}`,
      {
        method: "GET",
        headers: { accept: "application/json", "accept-encoding": "identity" },
        redirect: "manual",
        signal: controller.signal,
      }
    );
    if (response.status !== 200) {
      await response.body?.cancel?.("dependency is not ready").catch(() => {});
      return false;
    }
    const body = await readBoundedReadinessBody(response);
    if (body === null) return false;
    if (!bodyRequired) return true;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
    return isRecord(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMcpReadinessMessages(body, mediaType) {
  if (mediaType === "json") {
    try {
      return [JSON.parse(body)];
    } catch {
      return null;
    }
  }

  const messages = [];
  const events = body.replace(/\r\n?/g, "\n").split("\n\n");
  for (const event of events) {
    const data = [];
    for (const line of event.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line === "data") {
        data.push("");
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data.join("\n")));
    } catch {
      return null;
    }
  }
  return messages;
}

function isSuccessfulMcpReadinessResponse(message) {
  if (!isRecord(message) ||
    message.jsonrpc !== "2.0" ||
    message.id !== MCP_READINESS_REQUEST_ID ||
    Object.hasOwn(message, "error") ||
    !isRecord(message.result)) {
    return false;
  }
  const { result } = message;
  return result.protocolVersion === MCP_READINESS_PROTOCOL_VERSION &&
    isRecord(result.capabilities) &&
    isRecord(result.serverInfo) &&
    boundedString(result.serverInfo.name, 128) !== null &&
    boundedString(result.serverInfo.version, 128) !== null;
}

function isSuccessfulMcpPingResponse(message) {
  return isRecord(message) &&
    message.jsonrpc === "2.0" &&
    message.id === MCP_READINESS_PING_REQUEST_ID &&
    !Object.hasOwn(message, "error") &&
    isRecord(message.result) &&
    Object.keys(message.result).length === 0;
}

function mcpReadinessHeaders(sessionId = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "accept-encoding": "identity",
    "mcp-protocol-version": MCP_READINESS_PROTOCOL_VERSION,
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function validateMcpReadinessResponse(
  response,
  requestId,
  limitBytes,
  validator
) {
  if (response.status !== 200) {
    await response.body?.cancel?.("MCP dependency is not ready").catch(() => {});
    return false;
  }
  const mediaType = hostedToolsListMediaType(
    response.headers?.get?.("content-type")
  );
  if (mediaType === null) {
    await response.body?.cancel?.("MCP readiness media type is invalid").catch(() => {});
    return false;
  }
  const body = await readBoundedReadinessBody(response, limitBytes);
  if (body === null) return false;
  const messages = parseMcpReadinessMessages(body, mediaType);
  if (messages === null) return false;
  const matching = messages.filter((message) =>
    isRecord(message) && message.id === requestId
  );
  return matching.length === 1 && validator(matching[0]);
}

async function probeMcpDependency(fetchImpl, target, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  const url = upstreamMcpUrl(target);
  let sessionId = null;
  let handshakeReady = false;
  let cleanupReady = false;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: mcpReadinessHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: MCP_READINESS_REQUEST_ID,
        method: "initialize",
        params: {
          protocolVersion: MCP_READINESS_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "cortex-oauth-gateway-readiness",
            version: "1",
          },
        },
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    const candidateSessionId = response.headers?.get?.("mcp-session-id");
    if (typeof candidateSessionId === "string" &&
      MCP_SESSION_ID_PATTERN.test(candidateSessionId)) {
      sessionId = candidateSessionId;
    }
    if (sessionId === null) {
      await response.body?.cancel?.("MCP dependency is not ready").catch(() => {});
      return false;
    }
    if (!await validateMcpReadinessResponse(
      response,
      MCP_READINESS_REQUEST_ID,
      MAX_MCP_READINESS_RESPONSE_BYTES,
      isSuccessfulMcpReadinessResponse
    )) {
      return false;
    }

    const initialized = await fetchImpl(url, {
      method: "POST",
      headers: mcpReadinessHeaders(sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    const initializedAccepted = initialized.status === 202;
    await initialized.body?.cancel?.("MCP initialized notification completed")
      .catch(() => {});
    if (!initializedAccepted) return false;

    const ping = await fetchImpl(url, {
      method: "POST",
      headers: mcpReadinessHeaders(sessionId),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: MCP_READINESS_PING_REQUEST_ID,
        method: "ping",
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!await validateMcpReadinessResponse(
      ping,
      MCP_READINESS_PING_REQUEST_ID,
      MAX_READINESS_RESPONSE_BYTES,
      isSuccessfulMcpPingResponse
    )) {
      return false;
    }
    handshakeReady = true;
  } catch {
    handshakeReady = false;
  } finally {
    clearTimeout(timeout);
    if (sessionId !== null) {
      const cleanupController = new AbortController();
      const cleanupTimeout = setTimeout(
        () => cleanupController.abort(),
        Math.max(
          1,
          Math.min(MAX_MCP_CLEANUP_TIMEOUT_MILLISECONDS, timeoutMs)
        )
      );
      cleanupTimeout.unref?.();
      try {
        const response = await fetchImpl(url, {
          method: "DELETE",
          headers: mcpReadinessHeaders(sessionId),
          redirect: "manual",
          signal: cleanupController.signal,
        });
        cleanupReady = response.status === 200;
        await response.body?.cancel?.("MCP readiness session closed").catch(() => {});
      } catch {
        cleanupReady = false;
      } finally {
        clearTimeout(cleanupTimeout);
      }
    }
  }
  return handshakeReady && cleanupReady;
}

/**
 * Compose the authority and private-upstream checks without exposing detail on
 * the public readiness route.
 */
export async function probeGatewayReadiness({
  config,
  store,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MILLISECONDS,
}) {
  const failed = (fields, reason) => Object.freeze({
    live: true,
    ready: false,
    database: fields.database === true,
    schema: fields.schema === true,
    bootstrap: fields.bootstrap === true,
    legacyImport: fields.legacyImport === true,
    rest: fields.rest === true,
    mcp: fields.mcp === true,
    reason,
  });
  let authority;
  try {
    authority = await store.checkReadiness();
  } catch {
    return failed({}, "database");
  }
  if (authority?.ready !== true) {
    return failed(authority ?? {}, authority?.reason ?? "database");
  }

  const [rest, mcp] = await Promise.all([
    probeHttpDependency(fetchImpl, config.restTarget, "/readyz", true, timeoutMs),
    probeMcpDependency(fetchImpl, config.mcpTarget, timeoutMs),
  ]);
  const fields = { ...authority, rest, mcp };
  if (!rest) return failed(fields, "rest");
  if (!mcp) return failed(fields, "mcp");
  return Object.freeze({
    live: true,
    ready: true,
    database: true,
    schema: true,
    bootstrap: true,
    legacyImport: true,
    rest: true,
    mcp: true,
  });
}

function createGatewayReadinessCoordinator({
  config,
  store,
  fetchImpl,
  clock,
  logger,
}) {
  let cachedReport = null;
  let cachedUntil = 0;
  let inFlight = null;
  const clockNow = () => {
    try {
      const value = clock();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      // Fall through to the process monotonic clock.
    }
    return performance.now();
  };

  return () => {
    const current = clockNow();
    if (cachedReport !== null && current < cachedUntil) {
      return Promise.resolve(cachedReport);
    }
    if (inFlight !== null) return inFlight;

    const check = probeGatewayReadiness({ config, store, fetchImpl });
    let coordinated;
    coordinated = check.then((report) => {
      if (report.ready !== true) {
        logger.event("dependency_not_ready", "not_ready", {
          dependency: report.reason,
        });
      }
      cachedReport = report;
      cachedUntil = clockNow() + DEFAULT_READINESS_CACHE_MILLISECONDS;
      return report;
    }).finally(() => {
      if (inFlight === coordinated) inFlight = null;
    });
    inFlight = coordinated;
    return coordinated;
  };
}

function normalizeAuthorizationInput(source, config) {
  const clientId = boundedString(source.client_id, 512);
  const redirectUri = boundedString(source.redirect_uri, 2048);
  const state = boundedString(source.state ?? "", 2048, { allowEmpty: true });
  const codeChallenge = boundedString(source.code_challenge, 128);
  const resource = boundedString(source.resource ?? config.resourceUrl, 2048);
  const scopes = canonicalScopes(source.scope ?? SCOPES.join(" "));
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, "");
  const acceptedResources = new Set([
    config.resourceUrl,
    normalizedBaseUrl,
    `${normalizedBaseUrl}/`
  ]);

  if (
    source.response_type !== "code" ||
    !clientId ||
    !redirectUri ||
    state === null ||
    !codeChallenge ||
    !PKCE_CHALLENGE_PATTERN.test(codeChallenge) ||
    source.code_challenge_method !== "S256" ||
    !acceptedResources.has(resource) ||
    !scopes
  ) {
    return null;
  }

  return { clientId, redirectUri, state, codeChallenge, resource, scopes };
}

async function resolveAuthorizationRequest(source, config, store) {
  const input = normalizeAuthorizationInput(source, config);
  if (!input) return null;

  const client = await store.resolveActiveClient(input.clientId);
  if (
    !client ||
    client.status !== "active" ||
    !client.redirectUris.includes(input.redirectUri)
  ) {
    return null;
  }

  return input;
}

async function resolveProtectedContext(req, res, dependencies) {
  const token = bearerToken(req);
  if (!token) {
    oauthChallenge(res, dependencies.config.baseUrl);
    return null;
  }

  let claims;
  try {
    claims = await dependencies.crypto.verifyAccessToken(token);
  } catch {
    oauthChallenge(res, dependencies.config.baseUrl);
    return null;
  }

  let decision;
  try {
    decision = await dependencies.store.resolveAccessContext({ claims });
  } catch (error) {
    if (!isStoreUnavailable(error)) throw error;
    temporarilyUnavailable(res);
    return null;
  }

  if (!new Set(["active", "legacy-active"]).has(decision?.kind)) {
    oauthChallenge(res, dependencies.config.baseUrl);
    return null;
  }
  return decision.context;
}

function hostedRestRequestHeaders(req, hasBody) {
  const headers = {
    accept: safeForwardedHeader(req, "accept") || "application/json",
    "accept-encoding": "identity"
  };
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

function requestHasBodyFraming(req) {
  const contentLength = req.headers["content-length"];
  return req.headers["transfer-encoding"] !== undefined ||
    (typeof contentLength === "string" && contentLength !== "0");
}

function copyHostedRestResponseHeaders(upstream, res) {
  for (const name of ["content-type", "cache-control", "etag", "last-modified", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }
}

function relayHostedRestStream(upstream, res) {
  copyHostedRestResponseHeaders(upstream, res);
  res.status(upstream.status);
  if (!upstream.body) return res.end();

  res.flushHeaders();
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "bad_gateway" });
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

function hostedPublicHealthTarget(rawUrl, restTarget) {
  const source = new URL(rawUrl, "http://gateway.invalid");
  const upstream = new URL(
    "/api/v1/health",
    `${restTarget.replace(/\/+$/, "")}/`
  );
  for (const [key, value] of source.searchParams) {
    upstream.searchParams.append(key, value);
  }
  return upstream;
}

/**
 * Dependency-injected database-authority gateway.
 */
export function createGatewayApp({
  config,
  crypto,
  verifyBrowserCredentials,
  verifyStaticClientSecret = () => false,
  store,
  fetchImpl = fetch,
  now = () => new Date(),
  readinessClock = () => performance.now(),
  logger = Object.freeze({ event: () => false })
}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("config is required");
  }
  if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
    throw new TypeError("config.baseUrl is required");
  }
  if (typeof config.mcpTarget !== "string" || config.mcpTarget.length === 0) {
    throw new TypeError("config.mcpTarget is required");
  }
  if (!crypto || typeof crypto.verifyAccessToken !== "function") {
    throw new TypeError("crypto.verifyAccessToken is required");
  }
  if (typeof crypto.verifyRevocationReference !== "function") {
    throw new TypeError("crypto.verifyRevocationReference is required");
  }
  if (!store || typeof store.resolveAccessContext !== "function") {
    throw new TypeError("store.resolveAccessContext is required");
  }
  if (typeof store.checkReadiness !== "function") {
    throw new TypeError("store.checkReadiness is required");
  }
  if (typeof store.revokeByTokenReference !== "function") {
    throw new TypeError("store.revokeByTokenReference is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof verifyStaticClientSecret !== "function") {
    throw new TypeError("verifyStaticClientSecret must be a function");
  }
  if (typeof readinessClock !== "function") {
    throw new TypeError("readinessClock must be a function");
  }
  if (!logger || typeof logger.event !== "function") {
    throw new TypeError("logger.event must be a function");
  }

  const dependencies = { config, crypto, store, logger };
  const issuerUrl = config.issuerUrl || config.baseUrl;
  const resourceUrl = config.resourceUrl || `${config.baseUrl}/mcp`;
  const requestClientIp = createTrustedClientIpResolver(config);
  const enforcePublicRateLimit = createPublicRateLimiter(config, requestClientIp);
  const checkGatewayReadiness = createGatewayReadinessCoordinator({
    config,
    store,
    fetchImpl,
    clock: readinessClock,
    logger,
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (["/authorize", "/token", "/register", "/revoke"].includes(req.path)) {
      noStore(res);
    }
    next();
  });
  app.use((req, res, next) => {
    if (!req.originalUrl.startsWith("/api/v1")) return next();
    if (
      isHostedPublicHealthRequest(req.method, req.originalUrl) ||
      matchHostedRestRoute(req.method, req.originalUrl)
    ) {
      return next();
    }
    return res.status(404).json({ error: "not_found" });
  });
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(express.json({
    limit: "64kb",
    verify(req, _res, body) {
      if (["/mcp", "/mcp/"].includes(req.path)) {
        req[RAW_MCP_JSON] = Buffer.from(body);
      }
      if (req.originalUrl === "/api/v1" || req.originalUrl.startsWith("/api/v1/")) {
        req[RAW_REST_JSON] = Buffer.from(body);
      }
    }
  }));

  app.get("/livez", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", asyncRoute(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const report = await checkGatewayReadiness();
    if (report.ready === true) {
      return res.status(200).json({ status: "ok" });
    }
    return res.status(503).json({ status: "not_ready" });
  }));

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: resourceUrl,
      authorization_servers: [issuerUrl],
      scopes_supported: SCOPES
    });
  });

  const authorizationMetadata = {
    issuer: issuerUrl,
    authorization_endpoint: `${issuerUrl}/authorize`,
    token_endpoint: `${issuerUrl}/token`,
    revocation_endpoint: `${issuerUrl}/revoke`,
    registration_endpoint: `${issuerUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post"
    ],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post"
    ],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SCOPES
  };
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationMetadata);
  });
  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.json(authorizationMetadata);
  });

  app.post("/register", asyncRoute(async (req, res) => {
    if (!enforcePublicRateLimit(req, res, "registration")) return;

    if (!req.is("application/json") || !isRecord(req.body)) {
      return res.status(400).json({ error: "invalid_client_metadata" });
    }

    const redirectUris = req.body.redirect_uris;
    const clientName = req.body.client_name === undefined
      ? "ChatGPT"
      : boundedString(req.body.client_name, 200);
    const grantTypes = validateStringArray(
      req.body.grant_types,
      new Set(["authorization_code", "refresh_token"]),
      ["authorization_code", "refresh_token"]
    );
    const responseTypes = validateStringArray(
      req.body.response_types,
      new Set(["code"]),
      ["code"]
    );
    const authenticationMethod = req.body.token_endpoint_auth_method ?? "none";
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > 5 ||
      new Set(redirectUris).size !== redirectUris.length ||
      redirectUris.some((redirect) => !validChatGptRedirect(redirect)) ||
      !clientName ||
      !grantTypes ||
      !grantTypes.includes("authorization_code") ||
      !responseTypes ||
      authenticationMethod !== "none"
    ) {
      return res.status(400).json({ error: "invalid_client_metadata" });
    }

    let client;
    try {
      client = await store.registerDynamicClient({ redirectUris, clientName });
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return temporarilyUnavailable(res);
    }
    if (!client) {
      return res.status(429).json({ error: "temporarily_unavailable" });
    }

    const issuedAt = Math.floor(new Date(client.createdAt).getTime() / 1000);
    return res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Number.isFinite(issuedAt)
        ? issuedAt
        : Math.floor(now().getTime() / 1000),
      redirect_uris: [...client.redirectUris],
      client_name: client.clientName,
      token_endpoint_auth_method: "none",
      grant_types: grantTypes,
      response_types: responseTypes
    });
  }));

  async function createAuthorizationForContext({
    authorization,
    authenticatedContext,
    fingerprints,
    requestId
  }) {
    if (
      typeof crypto.createAuthorizationCode !== "function" ||
      typeof store.createAuthorization !== "function"
    ) {
      return Object.freeze({ kind: "unavailable" });
    }

    const code = crypto.createAuthorizationCode();
    const current = now();
    let created;
    try {
      created = await store.createAuthorization({
        codeDigest: code.digest,
        clientId: authorization.clientId,
        redirectUri: authorization.redirectUri,
        scopes: authorization.scopes,
        codeChallenge: authorization.codeChallenge,
        resource: authorization.resource,
        expiresAt: new Date(
          current.getTime() + (config.authCodeTtlSeconds || 300) * 1000
        ),
        authenticatedContext,
        requestId,
        ipFingerprint: fingerprints.ipFingerprint,
        userAgentFingerprint: fingerprints.userAgentFingerprint
      });
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return Object.freeze({ kind: "unavailable" });
    }
    if (created !== undefined) return Object.freeze({ kind: "invalid" });

    const redirect = new URL(authorization.redirectUri);
    redirect.searchParams.set("code", code.raw);
    if (authorization.state) redirect.searchParams.set("state", authorization.state);
    return Object.freeze({ kind: "created", location: redirect.toString() });
  }

  function unavailableAuthorization(res) {
    return res.status(503).send("Authorization is temporarily unavailable");
  }

  app.get("/authorize", asyncRoute(async (req, res) => {
    let authorization;
    try {
      authorization = await resolveAuthorizationRequest(req.query, {
        ...config,
        resourceUrl
      }, store);
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return unavailableAuthorization(res);
    }
    if (!authorization) return res.status(400).send("Invalid authorization request");

    const clientIp = requestClientIp(req);
    if (!clientIp) return unavailableAuthorization(res);

    const cookie = readLoginSessionCookie(req);
    if (cookie.kind === "missing") return renderLoginForm(res, authorization);
    if (cookie.kind === "invalid") {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }

    const fingerprints = requestFingerprints(req, clientIp, crypto);
    if (!fingerprints) return unavailableAuthorization(res);
    const requestId = randomUUID();
    let session;
    let replacementCookie = null;
    let alreadyUpgraded = false;

    try {
      if (OPAQUE_LOGIN_COOKIE_PATTERN.test(cookie.raw)) {
        if (
          typeof crypto.digestLoginCookie !== "function" ||
          typeof store.resolveLoginSession !== "function"
        ) {
          return unavailableAuthorization(res);
        }
        const decision = await store.resolveLoginSession({
          sessionDigest: crypto.digestLoginCookie(cookie.raw),
          ipFingerprint: fingerprints.ipFingerprint
        });
        if (decision?.kind === "active") session = decision.session;
      } else {
        if (
          typeof crypto.verifyLegacyLoginCookie !== "function" ||
          typeof crypto.createLoginCookie !== "function" ||
          typeof store.upgradeLegacyLoginSession !== "function"
        ) {
          return unavailableAuthorization(res);
        }
        const legacy = await crypto.verifyLegacyLoginCookie(cookie.raw, clientIp);
        if (legacy) {
          const opaque = crypto.createLoginCookie();
          const decision = await store.upgradeLegacyLoginSession({
            legacyCookieDigest: legacy.legacyCookieDigest,
            legacySubject: legacy.subject,
            legacyIssuedAt: legacy.issuedAt,
            legacyExpiresAt: legacy.expiresAt,
            sessionDigest: opaque.digest,
            ipFingerprint: fingerprints.ipFingerprint,
            requestId,
            userAgentFingerprint: fingerprints.userAgentFingerprint
          });
          if (decision?.kind === "upgraded") {
            session = decision.session;
            replacementCookie = opaque.raw;
          } else if (decision?.kind === "already_upgraded") {
            alreadyUpgraded = true;
          }
        }
      }
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return unavailableAuthorization(res);
    }

    if (alreadyUpgraded) return renderLoginForm(res, authorization);
    if (!session?.context) {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }

    const result = await createAuthorizationForContext({
      authorization,
      authenticatedContext: session.context,
      fingerprints,
      requestId
    });
    if (result.kind === "unavailable") {
      if (
        replacementCookie !== null &&
        !setLoginSessionCookie(res, replacementCookie, session.expiresAt, now())
      ) {
        clearLoginSessionCookie(res);
      }
      return unavailableAuthorization(res);
    }
    if (result.kind !== "created") {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }
    if (
      replacementCookie !== null &&
      !setLoginSessionCookie(res, replacementCookie, session.expiresAt, now())
    ) {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }
    return res.redirect(result.location);
  }));

  app.post("/authorize", asyncRoute(async (req, res) => {
    const clientIp = requestClientIp(req);
    if (!clientIp) return unavailableAuthorization(res);
    if (!enforcePublicRateLimit(req, res, "login")) return;

    if (typeof verifyBrowserCredentials !== "function") {
      return unavailableAuthorization(res);
    }

    let authorization;
    try {
      authorization = await resolveAuthorizationRequest(req.body, {
        ...config,
        resourceUrl
      }, store);
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return unavailableAuthorization(res);
    }
    if (!authorization) return res.status(400).send("Invalid authorization request");

    const username = boundedString(req.body.username, 512, { allowEmpty: true });
    const password = boundedString(req.body.password, 4096, { allowEmpty: true });
    if (
      username === null ||
      password === null ||
      !verifyBrowserCredentials(username, password)
    ) {
      return res.status(401).send("Invalid login");
    }

    if (
      typeof crypto.createLoginCookie !== "function" ||
      typeof store.createLoginSession !== "function"
    ) {
      return unavailableAuthorization(res);
    }
    const fingerprints = requestFingerprints(req, clientIp, crypto);
    if (!fingerprints) return unavailableAuthorization(res);
    const requestId = randomUUID();
    const opaque = crypto.createLoginCookie();
    let session;
    try {
      session = await store.createLoginSession({
        sessionDigest: opaque.digest,
        ipFingerprint: fingerprints.ipFingerprint,
        ttlSeconds: config.loginSessionTtlSeconds || DEFAULT_LOGIN_SESSION_TTL_SECONDS,
        requestId,
        userAgentFingerprint: fingerprints.userAgentFingerprint
      });
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return unavailableAuthorization(res);
    }
    if (!session?.context) {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }

    const result = await createAuthorizationForContext({
      authorization,
      authenticatedContext: session.context,
      fingerprints,
      requestId
    });
    if (result.kind === "unavailable") {
      if (!setLoginSessionCookie(res, opaque.raw, session.expiresAt, now())) {
        clearLoginSessionCookie(res);
      }
      return unavailableAuthorization(res);
    }
    if (result.kind !== "created") {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }
    if (!setLoginSessionCookie(res, opaque.raw, session.expiresAt, now())) {
      return renderLoginForm(res, authorization, { clearCookie: true });
    }
    return res.redirect(result.location);
  }));

  app.post("/token", asyncRoute(async (req, res) => {
    noStore(res);
    const credentials = resolveClientCredentials(req);
    if (!credentials) {
      return invalidClientResponse(req, res);
    }
    if (req.body?.grant_type === "refresh_token") {
      const rawRefreshToken = boundedString(req.body.refresh_token, 16 * 1024);
      const clientId = credentials.clientId;
      const suppliedResource = req.body.resource === undefined
        ? null
        : boundedString(req.body.resource, 2048);
      const suppliedScopes = req.body.scope === undefined
        ? null
        : canonicalScopes(req.body.scope);
      if (
        !rawRefreshToken ||
        !clientId ||
        (suppliedResource === null && req.body.resource !== undefined)
      ) {
        return res.status(400).json({ error: "invalid_request" });
      }
      if (suppliedScopes === null && req.body.scope !== undefined) {
        return res.status(400).json({ error: "invalid_scope" });
      }

      let client;
      try {
        client = await store.resolveActiveClient(clientId);
      } catch (error) {
        if (!isStoreUnavailable(error)) throw error;
        return temporarilyUnavailable(res);
      }
      if (
        !requireClientAuthentication(
          res,
          client,
          credentials,
          verifyStaticClientSecret
        )
      ) {
        return;
      }

      let claims;
      try {
        claims = await crypto.verifyRefreshToken(rawRefreshToken);
      } catch {
        return res.status(400).json({ error: "invalid_grant" });
      }
      const tokenScopes = canonicalScopes(claims.scope);
      if (!tokenScopes) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      const effectiveScopes = suppliedScopes ?? tokenScopes;
      if (!effectiveScopes.every((scope) => tokenScopes.includes(scope))) {
        return res.status(400).json({ error: "invalid_scope" });
      }

      const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, "");
      const acceptedResources = new Set([
        config.resourceUrl || `${normalizedBaseUrl}/mcp`,
        normalizedBaseUrl,
        `${normalizedBaseUrl}/`
      ]);
      const effectiveResource = suppliedResource ?? claims.aud;
      if (!acceptedResources.has(effectiveResource)) {
        return res.status(400).json({ error: "invalid_request" });
      }

      if (
        typeof crypto.createRefreshRequestFingerprint !== "function" ||
        typeof crypto.createRefreshMaterial !== "function"
      ) {
        return temporarilyUnavailable(res);
      }

      let presentedJtiDigest;
      let requestFingerprint;
      let replacement;
      let candidateGrantId;
      let legacyTupleDigest;
      try {
        requestFingerprint = crypto.createRefreshRequestFingerprint({
          clientId,
          resource: effectiveResource,
          scopes: effectiveScopes
        });
        if (claims.legacy === true) {
          if (
            typeof crypto.digestLegacyRefreshJti !== "function" ||
            typeof crypto.digestLegacyTuple !== "function" ||
            typeof store.migrateLegacyRefreshToken !== "function"
          ) {
            return temporarilyUnavailable(res);
          }
          presentedJtiDigest = crypto.digestLegacyRefreshJti(claims.jti);
          legacyTupleDigest = crypto.digestLegacyTuple({
            subject: claims.sub,
            clientId: claims.client_id,
            resource: claims.aud
          });
          candidateGrantId = randomUUID();
          replacement = crypto.createRefreshMaterial(candidateGrantId, 0);
        } else {
          if (
            typeof crypto.digestRefreshJti !== "function" ||
            typeof store.rotateRefreshToken !== "function"
          ) {
            return temporarilyUnavailable(res);
          }
          presentedJtiDigest = crypto.digestRefreshJti(claims.jti);
          replacement = crypto.createRefreshMaterial(
            claims.sid,
            claims.generation + 1
          );
        }
      } catch {
        return res.status(400).json({ error: "invalid_grant" });
      }

      let decision;
      try {
        const common = {
          presentedJtiDigest,
          clientId,
          resource: effectiveResource,
          effectiveScopes,
          requestFingerprint,
          refreshTokenTtlSeconds: config.refreshTokenTtlSeconds ||
            DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
          retryGraceSeconds: config.refreshRetryGraceSeconds ||
            DEFAULT_REFRESH_RETRY_GRACE_SECONDS,
          requestId: randomUUID(),
          ipFingerprint: null,
          userAgentFingerprint: null
        };
        if (claims.legacy === true) {
          decision = await store.migrateLegacyRefreshToken({
            ...common,
            token: {
              issuer: claims.iss,
              subject: claims.sub,
              resource: claims.aud,
              scopes: tokenScopes,
              clientId: claims.client_id,
              issuedAt: new Date(claims.iat * 1_000),
              expiresAt: new Date(claims.exp * 1_000)
            },
            legacyTupleDigest,
            grantId: candidateGrantId,
            replacement: {
              generation: 0,
              jtiDigest: replacement.jtiDigest,
              reconstructionNonce: replacement.nonce
            }
          });
        } else {
          decision = await store.rotateRefreshToken({
            ...common,
            token: {
              issuer: claims.iss,
              subject: claims.sub,
              resource: claims.aud,
              scopes: tokenScopes,
              clientId: claims.client_id,
              sid: claims.sid,
              agentExternalId: claims.agent_id,
              authenticationEpoch: claims.auth_epoch,
              bindingVersion: claims.binding_version,
              generation: claims.generation,
              issuedAt: new Date(claims.iat * 1_000),
              expiresAt: new Date(claims.exp * 1_000)
            },
            replacement: {
              generation: claims.generation + 1,
              jtiDigest: replacement.jtiDigest,
              reconstructionNonce: replacement.nonce
            }
          });
        }
      } catch (error) {
        if (!isStoreUnavailable(error)) throw error;
        return temporarilyUnavailable(res);
      }
      if (!new Set(["rotated", "retry"]).has(decision?.kind)) {
        return res.status(400).json({ error: "invalid_grant" });
      }

      const [accessToken, refreshToken] = await Promise.all([
        crypto.issueAccessToken(decision.grant),
        crypto.issueRefreshToken(decision.refresh)
      ]);
      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSeconds || 3600,
        refresh_token: refreshToken,
        refresh_token_expires_in: Math.max(
          0,
          Math.floor((decision.refresh.expiresAt.getTime() - now().getTime()) / 1_000)
        ),
        scope: decision.grant.scopes.join(" ")
      });
    }

    if (req.body?.grant_type !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }

    const rawCode = boundedString(req.body.code, 128);
    const clientId = credentials.clientId;
    const redirectUri = boundedString(req.body.redirect_uri, 2048);
    const verifier = boundedString(req.body.code_verifier, 128);
    const suppliedResource = req.body.resource === undefined
      ? null
      : boundedString(req.body.resource, 2048);
    const suppliedScopes = req.body.scope === undefined
      ? null
      : canonicalScopes(req.body.scope);
    if (
      !rawCode ||
      !AUTHORIZATION_CODE_PATTERN.test(rawCode) ||
      !clientId ||
      !redirectUri ||
      !verifier ||
      !PKCE_VERIFIER_PATTERN.test(verifier) ||
      (suppliedResource === null && req.body.resource !== undefined) ||
      (suppliedScopes === null && req.body.scope !== undefined)
    ) {
      return res.status(400).json({ error: "invalid_request" });
    }

    let authenticatedClient;
    try {
      authenticatedClient = await store.resolveActiveClient(clientId);
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return temporarilyUnavailable(res);
    }
    if (
      !requireClientAuthentication(
        res,
        authenticatedClient,
        credentials,
        verifyStaticClientSecret
      )
    ) return;

    const current = now();
    const grantId = randomUUID();
    const refreshMaterial = crypto.createRefreshMaterial(grantId, 0);
    const refreshExpiresAt = new Date(
      current.getTime() + (config.refreshTokenTtlSeconds ||
        DEFAULT_REFRESH_TOKEN_TTL_SECONDS) * 1000
    );
    let grant;
    try {
      grant = await store.exchangeAuthorizationCode({
        codeDigest: crypto.digestAuthorizationCode(rawCode),
        clientId,
        tokenEndpointAuthMethod: authenticatedClient.tokenEndpointAuthMethod,
        redirectUri,
        scopes: suppliedScopes,
        codeChallenge: crypto.createPkceChallenge(verifier),
        resource: suppliedResource,
        grantId,
        inactivityExpiresAt: refreshExpiresAt,
        refresh: {
          generation: 0,
          jtiDigest: refreshMaterial.jtiDigest,
          reconstructionNonce: refreshMaterial.nonce,
          issuedAt: current,
          expiresAt: refreshExpiresAt
        },
        requestId: randomUUID()
      });
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return temporarilyUnavailable(res);
    }
    if (!grant) return res.status(400).json({ error: "invalid_grant" });

    const descriptor = {
      grant,
      generation: 0,
      reconstructionNonce: refreshMaterial.nonce,
      issuedAt: current,
      expiresAt: refreshExpiresAt
    };
    const [accessToken, refreshToken] = await Promise.all([
      crypto.issueAccessToken(grant),
      crypto.issueRefreshToken(descriptor)
    ]);
    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.accessTokenTtlSeconds || 3600,
      refresh_token: refreshToken,
      refresh_token_expires_in: config.refreshTokenTtlSeconds ||
        DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
      scope: grant.scopes.join(" ")
    });
  }));

  app.post("/revoke", asyncRoute(async (req, res) => {
    noStore(res);
    if (!req.is("application/x-www-form-urlencoded") || !isRecord(req.body)) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const credentials = resolveClientCredentials(req);
    if (!credentials) return invalidClientResponse(req, res);
    const clientId = credentials.clientId;

    let client;
    try {
      client = await store.resolveActiveClient(clientId);
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return temporarilyUnavailable(res);
    }
    if (
      !requireClientAuthentication(
        res,
        client,
        credentials,
        verifyStaticClientSecret
      )
    ) {
      return;
    }

    if (!Object.hasOwn(req.body, "token") || req.body.token === "") {
      return res.status(400).json({ error: "invalid_request" });
    }
    const rawToken = typeof req.body.token === "string" &&
      req.body.token.length <= 16 * 1024
      ? req.body.token
      : null;

    let reference = null;
    if (rawToken !== null) {
      reference = await crypto.verifyRevocationReference(rawToken);
    }
    if (reference === null) {
      return res.status(200).end();
    }

    try {
      await store.revokeByTokenReference({
        reference,
        clientId,
        requestId: randomUUID(),
        ipFingerprint: null,
        userAgentFingerprint: null
      });
    } catch (error) {
      if (!isStoreUnavailable(error)) throw error;
      return temporarilyUnavailable(res);
    }
    return res.status(200).end();
  }));

  app.use("/api/v1", asyncRoute(async (req, res) => {
    const publicHealth = isHostedPublicHealthRequest(req.method, req.originalUrl);
    const policy = matchHostedRestRoute(req.method, req.originalUrl);
    if (!publicHealth && !policy) {
      return res.status(404).json({ error: "not_found" });
    }

    let target;
    let canonicalBody = null;
    if (publicHealth) {
      if (typeof config.restTarget !== "string" || config.restTarget.length === 0) {
        return res.status(502).json({ error: "bad_gateway" });
      }
      try {
        target = hostedPublicHealthTarget(req.originalUrl, config.restTarget);
      } catch {
        return res.status(502).json({ error: "bad_gateway" });
      }
    } else {
      const context = await resolveProtectedContext(req, res, dependencies);
      if (!context) return;
      if (!requireScopes(res, context, policy.requiredScopes)) return;
      if (typeof config.restTarget !== "string" || config.restTarget.length === 0) {
        return res.status(502).json({ error: "bad_gateway" });
      }

      const hasBody = requestHasBodyFraming(req);
      if (policy.agentLocation === "query" && hasBody && !req.is("application/json")) {
        return res.status(400).json({ error: "invalid_request" });
      }
      if (policy.agentLocation === "body" && !req.is("application/json")) {
        return res.status(415).json({ error: "unsupported_media_type" });
      }

      try {
        const bound = bindHostedRestRequest({
          method: req.method,
          rawUrl: req.originalUrl,
          rawJson: req[RAW_REST_JSON],
          body: policy.agentLocation === "body" || hasBody ? req.body : undefined,
          restTarget: config.restTarget
        }, context);
        target = bound.url;
        canonicalBody = bound.body;
      } catch (error) {
        if (isHostedPolicyError(error)) {
          await recordHostedPolicyRejection(dependencies, context, "rest", error);
          return hostedPolicyResponse(res, error);
        }
        return res.status(400).json({ error: "invalid_request" });
      }
    }

    try {
      const abortController = new AbortController();
      req.once("aborted", () => abortController.abort());
      res.once("close", () => {
        if (!res.writableEnded) abortController.abort();
      });
      const options = {
        method: req.method,
        headers: hostedRestRequestHeaders(req, canonicalBody !== null),
        redirect: "manual",
        signal: abortController.signal
      };
      if (canonicalBody !== null) options.body = JSON.stringify(canonicalBody);
      const upstream = await fetchImpl(target, options);
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel("hosted REST redirects are not allowed").catch(() => {});
        return res.status(502).json({ error: "bad_gateway" });
      }
      return relayHostedRestStream(upstream, res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy(error);
      return res.status(502).json({ error: "bad_gateway" });
    }
  }));

  app.post("/mcp", asyncRoute(async (req, res) => {
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "unsupported_media_type" });
    }

    const context = await resolveProtectedContext(req, res, dependencies);
    if (!context) return;
    const rawJson = req[RAW_MCP_JSON];
    let message;
    try {
      message = validateHostedMcpEnvelope(req.body, rawJson, {
        deferAmbiguity: true
      });
    } catch (error) {
      if (isHostedPolicyError(error)) {
        await recordHostedPolicyRejection(dependencies, context, "mcp", error);
        return hostedPolicyResponse(res, error);
      }
      return res.status(400).json({ error: "invalid_request" });
    }

    let required;
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (typeof name !== "string" ||
        !Object.hasOwn(CORTEX_TOOL_METADATA, name)) {
        return res.status(404).json({ error: "not_found" });
      }
      required = requiredScopesForTool(name);
    } else {
      required = ["mcp"];
    }
    if (!requireScopes(res, context, required)) return;

    let canonicalMessage = message;
    try {
      if (message.method === "tools/call") {
        canonicalMessage = bindHostedMcpRequest(message, rawJson, context);
      } else {
        const selectors = inspectAgentSelectors({ rawJson });
        if (selectors.length > 0) {
          throw new HostedPolicyError(
            403,
            "agent_mismatch",
            "Requested agent is not authorized for this connection"
          );
        }
        canonicalMessage = validateHostedMcpEnvelope(message, rawJson);
      }
    } catch (error) {
      if (isHostedPolicyError(error)) {
        await recordHostedPolicyRejection(dependencies, context, "mcp", error);
        return hostedPolicyResponse(res, error);
      }
      return res.status(400).json({ error: "invalid_request" });
    }

    try {
      const abortController = new AbortController();
      req.once("aborted", () => abortController.abort());
      res.once("close", () => {
        if (!res.writableEnded) abortController.abort();
      });
      const upstream = await callHostedMcpUpstream(
        fetchImpl,
        config.mcpTarget,
        canonicalMessage,
        req,
        abortController.signal
      );
      if (message.method === "tools/list") {
        return await relayHostedToolsList(upstream, res);
      }
      return relayHostedMcpStream(upstream, res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy(error);
      return res.status(502).json({ error: "bad_gateway" });
    }
  }));

  app.use((error, _req, res, next) => {
    if (
      (error instanceof SyntaxError && "body" in error) ||
      error?.type === "entity.too.large"
    ) {
      return res.status(400).json({ error: "invalid_request" });
    }
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: "server_error" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
