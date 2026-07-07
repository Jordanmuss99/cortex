import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use((req, _res, next) => {
  console.error(`[oauth-gateway] ${req.method} ${req.originalUrl}`);
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

const SCOPES = ["cortex:read", "cortex:write", "mcp"];

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

function validConfiguredRedirect(uri) {
  return STATIC_OAUTH_CLIENTS.some((client) => client.redirect_uris.includes(uri));
}

const LINEAR_OAUTH_REDIRECT_URI =
  process.env.LINEAR_OAUTH_REDIRECT_URI || "https://linear.app/connect/mcp/callback";
const LINEAR_ALLOWED_REDIRECTS = new Set([
  "https://linear.app/connect/mcp/callback",
  LINEAR_OAUTH_REDIRECT_URI
]);

if (!PASSWORD) {
  console.error("[oauth-gateway] MCP_OAUTH_PASSWORD is required");
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("[oauth-gateway] MCP_OAUTH_JWT_SECRET is required and should be at least 32 characters");
  process.exit(1);
}

const secretKey = new TextEncoder().encode(JWT_SECRET);

const ACCEPTED_AUDIENCES = new Set([
  RESOURCE_URL,
  BASE_URL,
  `${BASE_URL}/`
]);

const clients = new Map();
const codes = new Map();

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
    if (LINEAR_ALLOWED_REDIRECTS.has(uri)) return true;

    const u = new URL(uri);
    return (
      u.protocol === "https:" &&
      u.hostname === "chatgpt.com" &&
      u.pathname.startsWith("/connector/oauth/")
    );
  } catch {
    return false;
  }
}

function validOAuthRedirect(uri) {
  return validChatGPTRedirect(uri) || validConfiguredRedirect(uri);
}


function validateRedirectForClient(clientId, redirectUri) {
  const client = clients.get(clientId) || getStaticClient(clientId);

  if (client) {
    return client.redirect_uris.includes(redirectUri);
  }

  return validOAuthRedirect(redirectUri);
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



async function issueAccessToken({ sub, scope, aud }) {
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    scope,
    aud: aud || RESOURCE_URL
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER_URL)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60)
    .sign(secretKey);
}

async function verifyAccessToken(req, res, next) {
  const auth = req.header("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return oauthChallenge(res);
  }

  try {
    const { payload } = await jwtVerify(match[1], secretKey, {
      issuer: ISSUER_URL
    });

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
    grant_types_supported: ["authorization_code"],
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
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SCOPES
  });
});

// Dynamic client registration.
// ChatGPT can register a client and receive a client_id for this connector.
app.post("/register", (req, res) => {
  const redirectUris = Array.isArray(req.body.redirect_uris)
    ? req.body.redirect_uris
    : [];

  if (!redirectUris.length || !redirectUris.every(validOAuthRedirect)) {
    return res.status(400).json({
      error: "invalid_redirect_uri",
      error_description: "Only https://chatgpt.com/connector/oauth/... redirect URIs are allowed"
    });
  }

  const clientId = `chatgpt-${randomId(18)}`;

  clients.set(clientId, {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: req.body.client_name || "ChatGPT",
    created_at: Math.floor(Date.now() / 1000)
  });

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
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

  if (response_type !== "code") {
    return res.status(400).send("Unsupported response_type");
  }

  if (!client_id || !redirect_uri || !code_challenge) {
    return res.status(400).send("Missing client_id, redirect_uri, or code_challenge");
  }

  if (code_challenge_method !== "S256") {
    return res.status(400).send("Only PKCE S256 is supported");
  }

  if (!validateRedirectForClient(String(client_id), String(redirect_uri))) {
    return res.status(400).send("Invalid redirect_uri for client");
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
      <input type="hidden" name="client_id" value="${String(client_id)}" />
      <input type="hidden" name="redirect_uri" value="${String(redirect_uri)}" />
      <input type="hidden" name="scope" value="${String(scope)}" />
      <input type="hidden" name="state" value="${String(state)}" />
      <input type="hidden" name="code_challenge" value="${String(code_challenge)}" />
      <input type="hidden" name="resource" value="${RESOURCE_URL}" />

      <input name="username" placeholder="Username" autocomplete="username" required />
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" required />
      <button type="submit">Authorize</button>
    </form>
  </body>
</html>
  `);
});

app.post("/authorize", (req, res) => {
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

  if (username !== USERNAME || password !== PASSWORD) {
    return res.status(401).send("Invalid login");
  }

  if (!validateRedirectForClient(String(client_id), String(redirect_uri))) {
    return res.status(400).send("Invalid redirect_uri for client");
  }

  const code = randomId(32);

  codes.set(code, {
    client_id,
    redirect_uri,
    scope,
    code_challenge,
    resource: RESOURCE_URL,
    sub: username,
    expires_at: Date.now() + 5 * 60 * 1000
  });

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  res.redirect(redirect.toString());
});

// Token endpoint.
app.post("/token", async (req, res) => {
  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    code_verifier
  } = req.body;

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const stored = codes.get(code);
  if (!stored) {
    return res.status(400).json({ error: "invalid_grant" });
  }

  codes.delete(code);

  if (Date.now() > stored.expires_at) {
    return res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
  }

  if (stored.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }

  if (!validateTokenClient(req, stored.client_id)) {
    return res.status(401).json({ error: "invalid_client", error_description: "client authentication failed" });
  }

  if (pkceChallenge(code_verifier) !== stored.code_challenge) {
    return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
  }

  const accessToken = await issueAccessToken({
    sub: stored.sub,
    scope: stored.scope,
    aud: RESOURCE_URL
  });

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: stored.scope
  });
});


// Public health check.
app.get("/api/v1/health", createProxyMiddleware({
  target: REST_TARGET,
  changeOrigin: true
}));

// Protected REST API.
app.use("/api", verifyAccessToken, createProxyMiddleware({
  target: REST_TARGET,
  changeOrigin: true
}));

// Protected MCP endpoint.
// Handles Express-parsed JSON bodies and decorates tools/list for ChatGPT Apps.
async function getRequestBodyBuffer(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return Buffer.from(req.body);
    if (Object.keys(req.body).length > 0) return Buffer.from(JSON.stringify(req.body));
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);

    // If body-parser already consumed the stream and there is no parsed body,
    // resolve quickly instead of hanging forever.
    setTimeout(() => resolve(Buffer.alloc(0)), 250);
  });
}

function sanitizeToolForChatGPT(tool) {
  const scheme = { type: "oauth2", scopes: SCOPES };

  const clean = {
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description || tool.name,
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
    securitySchemes: [scheme],
    annotations: {
      readOnlyHint: [
        "cortex_search",
        "cortex_recall",
        "cortex_init",
        "cortex_status",
        "cortex_labile",
        "cortex_state_history",
        "cortex_relationship",
        "cortex_relationships"
      ].includes(tool.name),
      destructiveHint: false,
      openWorldHint: false
    },
    _meta: {
      ...(tool._meta || {}),
      securitySchemes: [scheme],
      ui: {
        ...((tool._meta && tool._meta.ui) || {}),
        visibility: ["model", "app"]
      },
      "openai/visibility": "public",
      "openai/toolInvocation/invoking": `Running ${tool.name}`.slice(0, 64),
      "openai/toolInvocation/invoked": `${tool.name} finished`.slice(0, 64)
    }
  };

  return clean;
}

function addOpenAISecuritySchemes(body) {
  return body.replace(/^data: (.+)$/gm, (line, json) => {
    try {
      const msg = JSON.parse(json);

      if (msg?.result?.tools && Array.isArray(msg.result.tools)) {
        // Expose the full Cortex toolset.
        msg.result.tools = msg.result.tools.map(sanitizeToolForChatGPT);
      }

      return `data: ${JSON.stringify(msg)}`;
    } catch {
      return line;
    }
  });
}

app.use("/mcp", verifyAccessToken, async (req, res) => {
  try {
    const body = await getRequestBodyBuffer(req);
    const bodyText = body.toString("utf8");

    let rpcMethod = "unknown";
    try {
      rpcMethod = JSON.parse(bodyText || "{}").method || "unknown";
    } catch {}

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (["host", "content-length", "connection", "accept-encoding"].includes(lower)) continue;
      headers[key] = value;
    }

    headers["content-type"] = req.header("content-type") || "application/json";
    headers["accept"] = req.header("accept") || "application/json, text/event-stream";

    console.error(`[oauth-gateway] MCP upstream ${rpcMethod} body_bytes=${body.length}`);

    const upstream = await fetch(`${MCP_TARGET}/mcp`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });

    const text = await upstream.text();

    console.error(`[oauth-gateway] MCP upstream ${rpcMethod} status=${upstream.status} response_bytes=${text.length}`);

    res.status(upstream.status);

    for (const [key, value] of upstream.headers.entries()) {
      const lower = key.toLowerCase();
      if (!["content-length", "content-encoding", "connection", "transfer-encoding"].includes(lower)) {
        res.setHeader(key, value);
      }
    }

    res.send(addOpenAISecuritySchemes(text));
  } catch (err) {
    console.error("[oauth-gateway] MCP proxy failed:", err);
    res.status(502).json({ error: "bad_gateway", message: "MCP proxy failed" });
  }
});


// Protected root REST passthrough.
app.use("/", verifyAccessToken, createProxyMiddleware({
  target: REST_TARGET,
  changeOrigin: true
}));

app.listen(PORT, () => {
  console.error(`[oauth-gateway] listening on :${PORT}`);
  console.error(`[oauth-gateway] resource: ${RESOURCE_URL}`);
  console.error(`[oauth-gateway] issuer:   ${ISSUER_URL}`);
  console.error(`[oauth-gateway] MCP:      ${MCP_TARGET}/mcp`);
  console.error(`[oauth-gateway] REST:     ${REST_TARGET}`);
});
