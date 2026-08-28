// Test/pre-v2 rollback fixture only. Never package or run after a v2 token exists.
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { SignJWT, jwtVerify } from "jose";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { decorateMcpResponse, requiredScopesForTool } from "./chatgpt-tools.js";

const app = express();

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );

  if (req.path === "/authorize" || req.path === "/token") {
    noStore(res);
  }

  // Never log OAuth query strings: they contain state, PKCE challenges, and
  // client identifiers that do not belong in long-lived container logs.
  console.error(`[oauth-gateway] ${req.method} ${req.path}`);
  next();
});

const PORT = Number(process.env.PORT || 8080);

const BASE_URL = process.env.BASE_URL || "https://cortex.obsidiannetwork.au";
const RESOURCE_URL = process.env.RESOURCE_URL || `${BASE_URL}/mcp`;
const ISSUER_URL = process.env.ISSUER_URL || BASE_URL;

const MCP_TARGET = process.env.MCP_TARGET || "http://cortex-mcp:8000";
const REST_TARGET = process.env.REST_TARGET || "http://cortex:3100";

const USERNAME = process.env.MCP_OAUTH_USERNAME || "jordan";
const PASSWORD = process.env.MCP_OAUTH_PASSWORD;
const JWT_SECRET = process.env.MCP_OAUTH_JWT_SECRET;
const OAUTH_STATE_FILE =
  process.env.MCP_OAUTH_STATE_FILE || "/var/lib/cortex-oauth/state.json";
const CLIENT_IP_HEADER = String(process.env.MCP_OAUTH_TRUSTED_IP_HEADER || "")
  .trim()
  .toLowerCase();
const TRUSTED_PROXY_CIDRS = String(process.env.MCP_OAUTH_TRUSTED_PROXY_CIDRS || "")
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const ACCESS_TOKEN_TTL_SECONDS = positiveInteger(
  process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  60 * 60
);
const REFRESH_TOKEN_TTL_SECONDS = positiveInteger(
  process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  90 * 24 * 60 * 60
);
const AUTH_CODE_TTL_SECONDS = positiveInteger(
  process.env.MCP_OAUTH_AUTH_CODE_TTL_SECONDS,
  5 * 60
);
const LOGIN_SESSION_TTL_SECONDS = positiveInteger(
  process.env.MCP_OAUTH_LOGIN_SESSION_TTL_SECONDS,
  30 * 24 * 60 * 60
);
const LOGIN_ATTEMPT_LIMIT = positiveInteger(
  process.env.MCP_OAUTH_LOGIN_ATTEMPT_LIMIT,
  10
);
const LOGIN_ATTEMPT_WINDOW_SECONDS = positiveInteger(
  process.env.MCP_OAUTH_LOGIN_ATTEMPT_WINDOW_SECONDS,
  15 * 60
);
const REGISTRATION_ATTEMPT_LIMIT = positiveInteger(
  process.env.MCP_OAUTH_REGISTRATION_ATTEMPT_LIMIT,
  30
);
const REGISTRATION_ATTEMPT_WINDOW_SECONDS = positiveInteger(
  process.env.MCP_OAUTH_REGISTRATION_ATTEMPT_WINDOW_SECONDS,
  60 * 60
);

const OAUTH_STATE_VERSION = 1;
const MAX_DYNAMIC_CLIENTS = 1000;
const MAX_OUTSTANDING_CODES = 1000;
const LOGIN_SESSION_COOKIE = "__Host-cortex_oauth_session";
const DYNAMIC_CLIENT_ID_PATTERN = /^chatgpt-[A-Za-z0-9_-]{24}$/;

const SCOPES = ["cortex:read", "cortex:write", "mcp"];
const SUPPORTED_SCOPES = new Set(SCOPES);

const STATIC_OAUTH_CLIENTS = [
  {
    client_id: process.env.LINEAR_OAUTH_CLIENT_ID || "linear-cortex",
    client_secret: process.env.LINEAR_OAUTH_CLIENT_SECRET || "",
    redirect_uris: (process.env.LINEAR_OAUTH_REDIRECT_URI || "https://linear.app/connect/mcp/callback")
      .split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)
  },
  {
    client_id: process.env.NOTION_OAUTH_CLIENT_ID || "notion-cortex",
    client_secret: process.env.NOTION_OAUTH_CLIENT_SECRET || "",
    redirect_uris: (process.env.NOTION_OAUTH_REDIRECT_URI || "https://app.notion.com/workflows/mcp/oauth/callback")
      .split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)
  }
];

function getStaticClient(clientId) {
  return STATIC_OAUTH_CLIENTS.find((client) => client.client_id === clientId) || null;
}

if (!PASSWORD) {
  console.error("[oauth-gateway] MCP_OAUTH_PASSWORD is required");
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("[oauth-gateway] MCP_OAUTH_JWT_SECRET is required and should be at least 32 characters");
  process.exit(1);
}

if (CLIENT_IP_HEADER && !/^[a-z0-9-]+$/.test(CLIENT_IP_HEADER)) {
  console.error("[oauth-gateway] MCP_OAUTH_TRUSTED_IP_HEADER must be an HTTP header name");
  process.exit(1);
}

if (CLIENT_IP_HEADER && TRUSTED_PROXY_CIDRS.length === 0) {
  console.error("[oauth-gateway] a trusted IP header requires MCP_OAUTH_TRUSTED_PROXY_CIDRS");
  process.exit(1);
}

const trustedProxyAddresses = new BlockList();
for (const cidr of TRUSTED_PROXY_CIDRS) {
  const separator = cidr.lastIndexOf("/");
  const address = separator === -1 ? "" : cidr.slice(0, separator);
  const prefix = Number.parseInt(separator === -1 ? "" : cidr.slice(separator + 1), 10);
  const version = isIP(address);
  const maximumPrefix = version === 4 ? 32 : 128;

  if (!version || !Number.isSafeInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
    console.error(`[oauth-gateway] invalid trusted proxy CIDR: ${cidr}`);
    process.exit(1);
  }

  trustedProxyAddresses.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
}

const secretKey = new TextEncoder().encode(JWT_SECRET);

const ACCEPTED_AUDIENCES = new Set([
  RESOURCE_URL,
  BASE_URL,
  `${BASE_URL}/`
]);

function validateResource(resource) {
  const value = String(resource || "");
  return ACCEPTED_AUDIENCES.has(value) ? value : null;
}

const clients = new Map();
const codes = new Map();
const loginAttempts = new Map();
const registrationAttempts = new Map();
const MAX_RATE_LIMIT_KEYS = 10_000;

function randomId(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function oauthChallenge(res) {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource", scope="${SCOPES.join(" ")}"`
  );
  return res.status(401).json({
    error: "unauthorized",
    message: "OAuth authorization required"
  });
}

function validChatGPTRedirect(uri) {
  try {
    const u = new URL(uri);
    return (
      u.origin === "https://chatgpt.com" &&
      u.username === "" &&
      u.password === "" &&
      u.search === "" &&
      u.hash === "" &&
      (
        u.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname)
      )
    );
  } catch {
    return false;
  }
}

function validateRedirectForClient(clientId, redirectUri) {
  const client = clients.get(clientId) || getStaticClient(clientId);

  if (client) {
    return client.redirect_uris.includes(redirectUri);
  }

  // Preserve only the client IDs issued by earlier versions of this gateway.
  // Their exact redirect registration was ephemeral, so compatibility is
  // intentionally limited to the two strict ChatGPT callback forms.
  return DYNAMIC_CLIENT_ID_PATTERN.test(clientId) && validChatGPTRedirect(redirectUri);
}


function readBasicAuthClient(req) {
  const auth = req.header("authorization") || "";
  const match = auth.match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;

    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1))
    };
  } catch {
    return null;
  }
}

function resolveTokenClient(req) {
  const basic = readBasicAuthClient(req);

  return {
    client_id: basic?.client_id || req.body.client_id,
    client_secret: basic?.client_secret || req.body.client_secret || ""
  };
}

function validateTokenClient(req, expectedClientId) {
  const { client_id, client_secret } = resolveTokenClient(req);

  if (client_id !== expectedClientId) {
    return false;
  }

  const staticClient = getStaticClient(client_id);

  if (staticClient?.client_secret) {
    return client_secret === staticClient.client_secret;
  }

  return true;
}



async function issueAccessToken({ sub, scope, aud, clientId }) {
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    scope,
    aud: aud || RESOURCE_URL,
    client_id: clientId,
    token_use: "access"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER_URL)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secretKey);
}

async function issueRefreshToken({ sub, scope, aud, clientId }) {
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    scope,
    aud: aud || RESOURCE_URL,
    client_id: clientId,
    token_use: "refresh"
  })
    .setProtectedHeader({ alg: "HS256", typ: "refresh+jwt" })
    .setIssuer(ISSUER_URL)
    .setSubject(sub)
    .setJti(randomId(18))
    .setIssuedAt(now)
    .setExpirationTime(now + REFRESH_TOKEN_TTL_SECONDS)
    .sign(secretKey);
}

function scopeIsSubset(requestedScope, grantedScope) {
  const requested = new Set(String(requestedScope || "").split(/\s+/).filter(Boolean));
  const granted = new Set(String(grantedScope || "").split(/\s+/).filter(Boolean));
  return [...requested].every((scope) => granted.has(scope));
}

function normalizeRequestedScope(scope) {
  const requested = [...new Set(String(scope || "").split(/\s+/).filter(Boolean))];
  if (requested.length === 0 || requested.some((value) => !SUPPORTED_SCOPES.has(value))) {
    return null;
  }
  return requested.join(" ");
}

function resourceFromAudience(audience) {
  if (Array.isArray(audience)) {
    return audience.length === 1 ? audience[0] : null;
  }

  return typeof audience === "string" ? audience : null;
}

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function boundedString(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function secureStringEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left ?? "")).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right ?? "")).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pruneExpiredCodes(now = Date.now()) {
  let changed = false;

  for (const [code, grant] of codes) {
    if (!Number.isSafeInteger(grant.expires_at) || grant.expires_at <= now) {
      codes.delete(code);
      changed = true;
    }
  }

  return changed;
}

function oauthStateSnapshot() {
  pruneExpiredCodes();

  return {
    version: OAUTH_STATE_VERSION,
    clients: [...clients.values()].map((client) => ({
      client_id: client.client_id,
      redirect_uris: [...client.redirect_uris],
      client_name: client.client_name,
      created_at: client.created_at
    })),
    codes: [...codes.entries()].map(([code, grant]) => ({
      code,
      client_id: grant.client_id,
      redirect_uri: grant.redirect_uri,
      scope: grant.scope,
      code_challenge: grant.code_challenge,
      resource: grant.resource,
      sub: grant.sub,
      expires_at: grant.expires_at
    }))
  };
}

function persistOAuthState() {
  const stateDirectory = dirname(OAUTH_STATE_FILE);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${OAUTH_STATE_FILE}.${process.pid}.${randomId(8)}.tmp`;
  let descriptor = null;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(oauthStateSnapshot())}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, OAUTH_STATE_FILE);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function validPersistedClient(client) {
  return (
    isRecord(client) &&
    DYNAMIC_CLIENT_ID_PATTERN.test(client.client_id) &&
    Array.isArray(client.redirect_uris) &&
    client.redirect_uris.length > 0 &&
    client.redirect_uris.length <= 5 &&
    client.redirect_uris.every((uri) => boundedString(uri, 2048) && validChatGPTRedirect(uri)) &&
    new Set(client.redirect_uris).size === client.redirect_uris.length &&
    boundedString(client.client_name, 200) !== null &&
    Number.isSafeInteger(client.created_at) &&
    client.created_at > 0
  );
}

function validPersistedCode(grant, now) {
  return (
    isRecord(grant) &&
    /^[A-Za-z0-9_-]{43}$/.test(grant.code) &&
    Boolean(boundedString(grant.client_id, 512)) &&
    Boolean(boundedString(grant.redirect_uri, 2048)) &&
    validateRedirectForClient(grant.client_id, grant.redirect_uri) &&
    normalizeRequestedScope(grant.scope) === grant.scope &&
    /^[A-Za-z0-9_-]{43}$/.test(grant.code_challenge) &&
    validateResource(grant.resource) === grant.resource &&
    grant.sub === USERNAME &&
    Number.isSafeInteger(grant.expires_at) &&
    grant.expires_at > now
  );
}

function loadOAuthState() {
  let parsed;

  try {
    parsed = JSON.parse(readFileSync(OAUTH_STATE_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    persistOAuthState();
    console.error("[oauth-gateway] initialized persistent OAuth state");
    return;
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== OAUTH_STATE_VERSION ||
    !Array.isArray(parsed.clients) ||
    !Array.isArray(parsed.codes) ||
    parsed.clients.length > MAX_DYNAMIC_CLIENTS ||
    parsed.codes.length > MAX_OUTSTANDING_CODES
  ) {
    throw new Error("OAuth state file has an unsupported or invalid structure");
  }

  let discardedClients = 0;
  let discardedCodes = 0;

  for (const client of parsed.clients) {
    if (!validPersistedClient(client)) {
      discardedClients += 1;
      continue;
    }
    clients.set(client.client_id, client);
  }

  const now = Date.now();
  for (const grant of parsed.codes) {
    if (!validPersistedCode(grant, now)) {
      discardedCodes += 1;
      continue;
    }

    const { code, ...storedGrant } = grant;
    codes.set(code, storedGrant);
  }

  // Rewriting on startup prunes expired/invalid records and ensures the state
  // file is always replaced by a mode-0600 atomic write.
  persistOAuthState();
  console.error(
    `[oauth-gateway] loaded OAuth state clients=${clients.size} codes=${codes.size}` +
    ` discarded_clients=${discardedClients} discarded_codes=${discardedCodes}`
  );
}

function normalizeClientIp(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return null;

  // A trusted ingress should supply one canonical address (for example,
  // CF-Connecting-IP). Reject comma-separated forwarding chains so an
  // attacker-controlled leftmost X-Forwarded-For value is never trusted.
  if (value.includes(",")) return null;

  let candidate = value.trim();
  if (candidate.startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }

  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function requestClientIp(req) {
  const socketIp = normalizeClientIp(req.socket.remoteAddress);

  if (CLIENT_IP_HEADER && socketIp) {
    const socketVersion = isIP(socketIp);
    const socketIsTrustedProxy = trustedProxyAddresses.check(
      socketIp,
      socketVersion === 4 ? "ipv4" : "ipv6"
    );

    if (socketIsTrustedProxy) {
      const forwardedIp = normalizeClientIp(req.headers[CLIENT_IP_HEADER]);
      if (forwardedIp) return forwardedIp;
    }
  }

  return socketIp;
}

function sessionHmac(purpose, value) {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`cortex-oauth:${purpose}:v1\0`)
    .update(value)
    .digest("base64url");
}

function rateLimitKey(req, purpose) {
  return sessionHmac("rate-limit", `${purpose}\0${requestClientIp(req) || "unknown"}`);
}

function consumeRateLimit(bucket, key, maximum, windowSeconds) {
  const now = Date.now();

  for (const [candidate, entry] of bucket) {
    if (entry.resetAt <= now) bucket.delete(candidate);
  }

  if (bucket.size >= MAX_RATE_LIMIT_KEYS && !bucket.has(key)) {
    const oldest = bucket.keys().next().value;
    if (oldest) bucket.delete(oldest);
  }

  let entry = bucket.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
    bucket.set(key, entry);
  }

  if (entry.count >= maximum) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function enforceRateLimit(req, res, bucket, purpose, maximum, windowSeconds) {
  const result = consumeRateLimit(
    bucket,
    rateLimitKey(req, purpose),
    maximum,
    windowSeconds
  );
  if (result.allowed) return true;

  res.setHeader("Retry-After", String(result.retryAfter));
  res.status(429).json({
    error: "temporarily_unavailable",
    error_description: "Too many attempts. Try again later."
  });
  return false;
}

function createLoginSession(clientIp) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    sub: USERNAME,
    ip_hash: sessionHmac("client-ip", clientIp),
    issued_at: now,
    expires_at: now + LOGIN_SESSION_TTL_SECONDS
  })).toString("base64url");

  return `${payload}.${sessionHmac("login-session", payload)}`;
}

function readLoginSession(req) {
  const cookie = req.cookies?.[LOGIN_SESSION_COOKIE];
  if (!cookie) return { present: false, valid: false, clientIp: null };
  if (!boundedString(cookie, 2048)) return { present: true, valid: false, clientIp: null };

  const [payloadPart, signature, extra] = cookie.split(".");
  if (!payloadPart || !signature || extra !== undefined) {
    return { present: true, valid: false, clientIp: null };
  }

  if (!secureStringEqual(signature, sessionHmac("login-session", payloadPart))) {
    return { present: true, valid: false, clientIp: null };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    const clientIp = requestClientIp(req);
    const validLifetime =
      Number.isSafeInteger(payload.issued_at) &&
      Number.isSafeInteger(payload.expires_at) &&
      payload.issued_at <= now + 60 &&
      payload.expires_at > now &&
      payload.expires_at - payload.issued_at === LOGIN_SESSION_TTL_SECONDS;
    const validIp =
      clientIp !== null &&
      secureStringEqual(payload.ip_hash, sessionHmac("client-ip", clientIp));

    return {
      present: true,
      valid: payload.version === 1 && payload.sub === USERNAME && validLifetime && validIp,
      clientIp
    };
  } catch {
    return { present: true, valid: false, clientIp: null };
  }
}

function setLoginSessionCookie(res, clientIp) {
  if (!clientIp) return;

  res.cookie(LOGIN_SESSION_COOKIE, createLoginSession(clientIp), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: LOGIN_SESSION_TTL_SECONDS * 1000
  });
}

function clearLoginSessionCookie(res) {
  res.clearCookie(LOGIN_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/"
  });
}

function hasScope(req, scope) {
  return new Set(String(req.user?.scope || "").split(/\s+/).filter(Boolean)).has(scope);
}

function requireRestScope(req, res, next) {
  const requiredScope = ["GET", "HEAD", "OPTIONS"].includes(req.method)
    ? "cortex:read"
    : "cortex:write";

  if (hasScope(req, requiredScope)) return next();

  res.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${requiredScope}"`);
  return res.status(403).json({
    error: "insufficient_scope",
    error_description: `Missing required scope: ${requiredScope}`
  });
}

async function sendTokenPair(res, { sub, scope, resource, clientId }) {
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken({ sub, scope, aud: resource, clientId }),
    issueRefreshToken({ sub, scope, aud: resource, clientId })
  ]);

  return res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    refresh_token_expires_in: REFRESH_TOKEN_TTL_SECONDS,
    scope
  });
}

async function verifyAccessToken(req, res, next) {
  const auth = req.header("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return oauthChallenge(res);
  }

  try {
    const { payload, protectedHeader } = await jwtVerify(match[1], secretKey, {
      issuer: ISSUER_URL,
      algorithms: ["HS256"]
    });

    if (payload.token_use !== "access" || protectedHeader.typ !== "JWT") {
      console.error("[oauth-gateway] rejected a non-access token at the resource server");
      return oauthChallenge(res);
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

    if (!audiences.some((aud) => ACCEPTED_AUDIENCES.has(aud))) {
      console.error("[oauth-gateway] token audience mismatch:", payload.aud);
      return oauthChallenge(res);
    }

    req.user = payload;
    return next();
  } catch (err) {
    console.error("[oauth-gateway] token verification failed:", err.message);
    return oauthChallenge(res);
  }
}

function createAuthorizationGrant({
  clientId,
  redirectUri,
  scope,
  codeChallenge,
  resource,
  sub
}) {
  pruneExpiredCodes();
  if (codes.size >= MAX_OUTSTANDING_CODES) {
    return { error: "capacity" };
  }

  const code = randomId(32);
  codes.set(code, {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    resource,
    sub,
    expires_at: Date.now() + AUTH_CODE_TTL_SECONDS * 1000
  });

  try {
    persistOAuthState();
    return { code };
  } catch {
    codes.delete(code);
    console.error("[oauth-gateway] failed to persist an authorization grant");
    return { error: "storage" };
  }
}

function authorizeAndRedirect(res, {
  clientId,
  redirectUri,
  scope,
  oauthState,
  codeChallenge,
  resource,
  sub,
  sessionClientIp = null
}) {
  const grant = createAuthorizationGrant({
    clientId,
    redirectUri,
    scope,
    codeChallenge,
    resource,
    sub
  });

  if (!grant.code) {
    return res.status(503).send("Authorization is temporarily unavailable");
  }

  setLoginSessionCookie(res, sessionClientIp);
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", grant.code);
  if (oauthState) redirect.searchParams.set("state", oauthState);
  return res.redirect(redirect.toString());
}

// MCP protected resource metadata.
// OpenAI/ChatGPT discovers this either directly or through the WWW-Authenticate header.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: RESOURCE_URL,
    authorization_servers: [ISSUER_URL],
    scopes_supported: SCOPES,
    resource_documentation: `${BASE_URL}/docs/mcp`
  });
});

// OAuth authorization server metadata.
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: ISSUER_URL,
    authorization_endpoint: `${ISSUER_URL}/authorize`,
    token_endpoint: `${ISSUER_URL}/token`,
    registration_endpoint: `${ISSUER_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SCOPES
  });
});

// Optional OIDC-style discovery alias, useful for clients that look here first.
app.get("/.well-known/openid-configuration", (_req, res) => {
  res.json({
    issuer: ISSUER_URL,
    authorization_endpoint: `${ISSUER_URL}/authorize`,
    token_endpoint: `${ISSUER_URL}/token`,
    registration_endpoint: `${ISSUER_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SCOPES
  });
});

// Dynamic client registration.
// ChatGPT can register a client and receive a client_id for this connector.
app.post("/register", (req, res) => {
  if (!enforceRateLimit(
    req,
    res,
    registrationAttempts,
    "registration",
    REGISTRATION_ATTEMPT_LIMIT,
    REGISTRATION_ATTEMPT_WINDOW_SECONDS
  )) return;

  const redirectUris = Array.isArray(req.body.redirect_uris)
    ? req.body.redirect_uris
    : [];

  if (
    !redirectUris.length ||
    redirectUris.length > 5 ||
    redirectUris.some((uri) => !boundedString(uri, 2048)) ||
    new Set(redirectUris).size !== redirectUris.length ||
    !redirectUris.every(validChatGPTRedirect)
  ) {
    return res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "Only approved ChatGPT redirect URIs are allowed"
    });
  }

  if (clients.size >= MAX_DYNAMIC_CLIENTS) {
    return res.status(429).json({
      error: "temporarily_unavailable",
      error_description: "Dynamic client registration limit reached"
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const clientId = `chatgpt-${randomId(18)}`;

  clients.set(clientId, {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: boundedString(req.body.client_name, 200) || "ChatGPT",
    created_at: now
  });

  try {
    persistOAuthState();
  } catch {
    clients.delete(clientId);
    console.error("[oauth-gateway] failed to persist a dynamic client registration");
    return res.status(503).json({
      error: "temporarily_unavailable",
      error_description: "Client registration is temporarily unavailable"
    });
  }

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: now,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  });
});

// Authorization endpoint.
app.get("/authorize", (req, res) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    scope = SCOPES.join(" "),
    state = "",
    code_challenge,
    code_challenge_method,
    resource = RESOURCE_URL
  } = req.query;

  const clientId = boundedString(client_id, 512);
  const redirectUri = boundedString(redirect_uri, 2048);
  const requestedScope = boundedString(scope, 512);
  const oauthState = boundedString(state, 2048);
  const codeChallenge = boundedString(code_challenge, 128);
  const requestedResource = boundedString(resource, 2048);

  if (response_type !== "code") {
    return res.status(400).send("Unsupported response_type");
  }

  if (!clientId || !redirectUri || !codeChallenge || oauthState === null) {
    return res.status(400).send("Missing client_id, redirect_uri, or code_challenge");
  }

  if (code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return res.status(400).send("Only PKCE S256 is supported");
  }

  const normalizedScope = normalizeRequestedScope(requestedScope);
  if (!normalizedScope) {
    return res.status(400).send("Invalid or unsupported scope");
  }

  const authorizedResource = validateResource(requestedResource);
  if (!authorizedResource) {
    return res.status(400).send("Invalid resource");
  }

  if (!validateRedirectForClient(clientId, redirectUri)) {
    return res.status(400).send("Invalid redirect_uri for client");
  }

  const loginSession = readLoginSession(req);
  if (loginSession.present && !loginSession.valid) {
    clearLoginSessionCookie(res);
  }

  if (loginSession.valid) {
    return authorizeAndRedirect(res, {
      clientId,
      redirectUri,
      scope: normalizedScope,
      oauthState,
      codeChallenge,
      resource: authorizedResource,
      sub: USERNAME,
      sessionClientIp: loginSession.clientIp
    });
  }

  res.type("html").send(`
<!doctype html>
<html>
  <head>
    <title>Cortex OAuth Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 420px; margin: 64px auto; padding: 0 16px; }
      input, button { width: 100%; padding: 12px; margin: 8px 0; box-sizing: border-box; }
      button { cursor: pointer; }
      .hint { color: #555; font-size: 14px; }
    </style>
  </head>
  <body>
    <h1>Cortex Login</h1>
    <p class="hint">Authorize ChatGPT to access Cortex.</p>
    <form method="post" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtmlAttribute(clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtmlAttribute(redirectUri)}" />
      <input type="hidden" name="scope" value="${escapeHtmlAttribute(normalizedScope)}" />
      <input type="hidden" name="state" value="${escapeHtmlAttribute(oauthState)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtmlAttribute(codeChallenge)}" />
      <input type="hidden" name="resource" value="${escapeHtmlAttribute(authorizedResource)}" />

      <input name="username" placeholder="Username" autocomplete="username" required />
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" required />
      <button type="submit">Authorize</button>
    </form>
  </body>
</html>
  `);
});

app.post("/authorize", (req, res) => {
  if (!enforceRateLimit(
    req,
    res,
    loginAttempts,
    "login",
    LOGIN_ATTEMPT_LIMIT,
    LOGIN_ATTEMPT_WINDOW_SECONDS
  )) return;

  const {
    username,
    password,
    client_id,
    redirect_uri,
    scope = SCOPES.join(" "),
    state = "",
    code_challenge,
    resource = RESOURCE_URL
  } = req.body;

  const clientId = boundedString(client_id, 512);
  const redirectUri = boundedString(redirect_uri, 2048);
  const requestedScope = boundedString(scope, 512);
  const oauthState = boundedString(state, 2048);
  const codeChallenge = boundedString(code_challenge, 128);
  const requestedResource = boundedString(resource, 2048);

  if (!secureStringEqual(username, USERNAME) || !secureStringEqual(password, PASSWORD)) {
    return res.status(401).send("Invalid login");
  }

  if (!clientId || !redirectUri || oauthState === null || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return res.status(400).send("Invalid authorization request");
  }

  const normalizedScope = normalizeRequestedScope(requestedScope);
  if (!normalizedScope) {
    return res.status(400).send("Invalid or unsupported scope");
  }


  const authorizedResource = validateResource(requestedResource);
  if (!authorizedResource) {
    return res.status(400).send("Invalid resource");
  }

  if (!validateRedirectForClient(clientId, redirectUri)) {
    return res.status(400).send("Invalid redirect_uri for client");
  }

  return authorizeAndRedirect(res, {
    clientId,
    redirectUri,
    scope: normalizedScope,
    oauthState,
    codeChallenge,
    resource: authorizedResource,
    sub: username,
    sessionClientIp: requestClientIp(req)
  });
});

// Token endpoint.
app.post("/token", async (req, res) => {
  noStore(res);

  const {
    grant_type,
    code,
    redirect_uri,
    code_verifier,
    refresh_token,
    resource,
    scope
  } = req.body;

  if (grant_type === "authorization_code") {
    const stored = codes.get(code);
    if (!stored) {
      if (pruneExpiredCodes()) {
        try {
          persistOAuthState();
        } catch {
          console.error("[oauth-gateway] failed to persist expired authorization-code pruning");
          return res.status(503).json({ error: "temporarily_unavailable" });
        }
      }
      return res.status(400).json({ error: "invalid_grant" });
    }

    codes.delete(code);
    try {
      persistOAuthState();
    } catch {
      codes.set(code, stored);
      console.error("[oauth-gateway] failed to persist authorization-code consumption");
      return res.status(503).json({ error: "temporarily_unavailable" });
    }

    if (Date.now() >= stored.expires_at) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
    }

    if (stored.redirect_uri !== redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }

    if (resource && resource !== stored.resource) {
      return res.status(400).json({ error: "invalid_target", error_description: "resource mismatch" });
    }

    if (!validateTokenClient(req, stored.client_id)) {
      return res.status(401).json({ error: "invalid_client", error_description: "client authentication failed" });
    }

    if (!code_verifier || pkceChallenge(code_verifier) !== stored.code_challenge) {
      return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    return await sendTokenPair(res, {
      sub: stored.sub,
      scope: stored.scope,
      resource: stored.resource,
      clientId: stored.client_id
    });
  }

  if (grant_type === "refresh_token") {
    if (!refresh_token) {
      return res.status(400).json({ error: "invalid_request", error_description: "refresh_token is required" });
    }

    try {
      const { payload, protectedHeader } = await jwtVerify(refresh_token, secretKey, {
        issuer: ISSUER_URL,
        audience: [...ACCEPTED_AUDIENCES],
        algorithms: ["HS256"]
      });

      if (payload.token_use !== "refresh" || protectedHeader.typ !== "refresh+jwt") {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token" });
      }

      const tokenResource = resourceFromAudience(payload.aud);
      const tokenClientId = typeof payload.client_id === "string" ? payload.client_id : "";
      const tokenScope = typeof payload.scope === "string" ? payload.scope : "";
      const tokenSubject = typeof payload.sub === "string" ? payload.sub : "";

      if (!tokenResource || !tokenClientId || !tokenScope || !tokenSubject) {
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid refresh token" });
      }

      if (resource && resource !== tokenResource) {
        return res.status(400).json({ error: "invalid_target", error_description: "resource mismatch" });
      }

      if (!validateTokenClient(req, tokenClientId)) {
        return res.status(401).json({ error: "invalid_client", error_description: "client authentication failed" });
      }

      const refreshedScope = scope || tokenScope;
      if (!scopeIsSubset(refreshedScope, tokenScope)) {
        return res.status(400).json({ error: "invalid_scope", error_description: "Requested scope exceeds the original grant" });
      }

      // Return a fresh refresh token on every successful refresh. ChatGPT stores
      // the replacement, so an actively used connection has a sliding lifetime.
      return await sendTokenPair(res, {
        sub: tokenSubject,
        scope: refreshedScope,
        resource: tokenResource,
        clientId: tokenClientId
      });
    } catch (err) {
      console.error("[oauth-gateway] refresh token verification failed:", err.message);
      return res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired or invalid" });
    }
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});


const SENSITIVE_PROXY_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-amzn-oidc-accesstoken",
  "x-api-key",
  "x-auth-token",
  "x-forwarded-access-token",
  "x-goog-iap-jwt-assertion"
]);

function isSensitiveProxyHeader(header) {
  const lower = String(header).toLowerCase();
  return SENSITIVE_PROXY_HEADERS.has(lower) || lower.startsWith("cf-access-");
}

// The gateway has already authenticated the connector. Never copy those
// credentials, or edge-provider identity tokens, into the raw workers.
function scrubProxyCredentials(proxyReq) {
  for (const header of proxyReq.getHeaderNames()) {
    if (isSensitiveProxyHeader(header)) proxyReq.removeHeader(header);
  }
}

function prepareRestProxyRequest(proxyReq, req, res) {
  scrubProxyCredentials(proxyReq);
  fixRequestBody(proxyReq, req, res);
}

function restoreApiPrefix(path) {
  if (path === "/api" || path.startsWith("/api/")) return path;
  return `/api${path.startsWith("/") ? path : `/${path}`}`;
}

app.get("/api/v1/health", createProxyMiddleware({
  target: REST_TARGET,
  changeOrigin: true,
  on: { proxyReq: scrubProxyCredentials }
}));

app.get("/docs/mcp", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><title>Cortex MCP</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>Cortex MCP</h1><p>Cortex provides private, persistent memory tools for ChatGPT and Codex.</p>
<p>Endpoint: <code>${escapeHtmlAttribute(RESOURCE_URL)}</code></p>
<p>Authentication: OAuth 2.1 authorization code flow with PKCE.</p></body></html>`);
});

// Protected REST API.
app.use("/api", verifyAccessToken, requireRestScope, createProxyMiddleware({
  target: REST_TARGET,
  changeOrigin: true,
  pathRewrite: restoreApiPrefix,
  on: { proxyReq: prepareRestProxyRequest }
}));

// Protected MCP endpoint.
// Handles Express-parsed JSON bodies and decorates tools/list for ChatGPT Apps.
async function getRequestBodyBuffer(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body);
    return Buffer.from(JSON.stringify(req.body));
  }

  if (req.readableEnded) return Buffer.alloc(0);

  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function copyUpstreamHeaders(upstream, res) {
  res.status(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    // Fetch transparently decodes compressed response bodies. Never forward
    // the upstream encoding or byte length when relaying that decoded stream.
    const blocked = [
      "connection",
      "content-encoding",
      "content-length",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade"
    ].includes(lower);
    if (!blocked) res.setHeader(key, value);
  }
}

async function readUpstreamText(upstream, limitBytes = 2 * 1024 * 1024) {
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
      throw new Error(`MCP metadata response exceeded ${limitBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

app.use("/mcp", verifyAccessToken, async (req, res) => {
  try {
    if (req.method === "POST" && !req.is("application/json")) {
      return res.status(415).json({
        error: "unsupported_media_type",
        error_description: "MCP POST requests must use application/json"
      });
    }

    const body = await getRequestBodyBuffer(req);
    const bodyText = body.toString("utf8");

    let rpcMethod = "unknown";
    let rpcMessage = null;
    try {
      rpcMessage = JSON.parse(bodyText || "{}");
      rpcMethod = rpcMessage.method || "unknown";
    } catch {}

    if (Array.isArray(rpcMessage)) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "JSON-RPC batch requests are not supported"
      });
    }

    const requiredScopes = rpcMethod === "tools/call"
      ? requiredScopesForTool(rpcMessage?.params?.name)
      : ["mcp"];
    const grantedScopes = new Set(String(req.user?.scope || "").split(/\s+/).filter(Boolean));
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
    if (missingScopes.length > 0) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${requiredScopes.join(" ")}"`
      );
      return res.status(403).json({
        error: "insufficient_scope",
        error_description: `Missing required scope(s): ${missingScopes.join(", ")}`
      });
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (isSensitiveProxyHeader(lower) || [
        "host",
        "content-length",
        "connection",
        "accept-encoding"
      ].includes(lower)) continue;
      headers[key] = value;
    }

    headers["content-type"] = req.header("content-type") || "application/json";
    headers["accept"] = req.header("accept") || "application/json, text/event-stream";
    headers["accept-encoding"] = "identity";

    console.error(`[oauth-gateway] MCP upstream ${rpcMethod} body_bytes=${body.length}`);

    const abortController = new AbortController();
    const abortUpstream = () => abortController.abort();
    req.once("aborted", abortUpstream);
    res.once("close", () => {
      if (!res.writableEnded) abortUpstream();
    });

    const upstream = await fetch(`${MCP_TARGET}/mcp`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      signal: abortController.signal
    });

    if (rpcMethod === "tools/list") {
      const text = await readUpstreamText(upstream);
      console.error(`[oauth-gateway] MCP upstream ${rpcMethod} status=${upstream.status} response_bytes=${text.length}`);
      copyUpstreamHeaders(upstream, res);
      return res.send(decorateMcpResponse(text));
    }

    console.error(`[oauth-gateway] MCP upstream ${rpcMethod} status=${upstream.status} streaming=true`);
    copyUpstreamHeaders(upstream, res);

    if (!upstream.body || req.method === "HEAD") {
      return res.end();
    }

    res.flushHeaders();
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", (streamError) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "bad_gateway", message: "MCP stream failed" });
      } else {
        res.destroy(streamError);
      }
    });
    stream.pipe(res);
  } catch (err) {
    if (res.headersSent) {
      return res.destroy(err);
    }
    console.error("[oauth-gateway] MCP proxy failed:", err);
    res.status(502).json({ error: "bad_gateway", message: "MCP proxy failed" });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

try {
  loadOAuthState();
} catch {
  // Serving OAuth while silently dropping registrations or outstanding codes
  // would turn a storage fault into intermittent ChatGPT connection failures.
  console.error("[oauth-gateway] persistent OAuth state is unavailable; refusing to start");
  process.exit(1);
}

app.listen(PORT, () => {
  console.error(`[oauth-gateway] listening on :${PORT}`);
  console.error(`[oauth-gateway] resource: ${RESOURCE_URL}`);
  console.error(`[oauth-gateway] issuer:   ${ISSUER_URL}`);
  console.error(`[oauth-gateway] MCP:      ${MCP_TARGET}/mcp`);
  console.error(`[oauth-gateway] REST:     ${REST_TARGET}`);
});
