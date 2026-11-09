/**
 * CORTEX MCP OAuth resource-server layer (RFC 9728 / RFC 8707 / OAuth 2.1).
 *
 * The consumer Gemini app (and other OAuth-first MCP clients) require the MCP server to be
 * an OAuth 2.1 RESOURCE SERVER that (a) returns 401 with a `WWW-Authenticate` pointing at its
 * Protected Resource Metadata, and (b) validates that the presented access token was minted
 * specifically for it (audience binding). We do NOT hand-roll an authorization server: a
 * managed IdP (Auth0 / Stytch / Cloudflare Access / etc.) issues the tokens; Cortex only
 * VERIFIES them here.
 *
 * The legacy static bearer (CORTEX_MCP_TOKEN) is kept as a fallback so the Superhuman Go
 * connector and local/dev flows keep working unchanged.
 *
 * Config (env):
 *   CORTEX_MCP_PUBLIC_URL   canonical MCP resource URI, e.g. https://host/mcp  (audience + PRM resource)
 *   CORTEX_OAUTH_ISSUER     IdP issuer URL (must match the token `iss`); becomes authorization_servers[0]
 *   CORTEX_OAUTH_JWKS_URI   optional; if unset it is discovered from the issuer's
 *                           /.well-known/oauth-authorization-server metadata (RFC 8414)
 * If CORTEX_MCP_PUBLIC_URL or CORTEX_OAUTH_ISSUER is missing, OAuth validation is DISABLED and
 * only the static bearer path is active (fail-closed, exactly as before).
 */
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { timingSafeEqual } from "node:crypto";

export type AuthResult =
  | { ok: true; via: "oauth" | "static"; subject?: string }
  | { ok: false; error: string };

export interface OAuthConfig {
  issuer: string;
  audience: string; // canonical resource URI; asserted against the token `aud`
  jwksUri?: string;
}

export function oauthConfigOrNull(): OAuthConfig | null {
  const audience = (process.env.CORTEX_MCP_PUBLIC_URL || "").trim();
  const issuer = (process.env.CORTEX_OAUTH_ISSUER || "").trim();
  if (!audience || !issuer) return null; // OAuth not configured -> static-only
  const jwksUri = (process.env.CORTEX_OAUTH_JWKS_URI || "").trim() || undefined;
  return { issuer, audience, jwksUri };
}

function bearerToken(req: Request): string {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function staticTokenMatches(token: string): boolean {
  const expected = (process.env.CORTEX_MCP_TOKEN || "").trim();
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── JWKS resolution (discovered + cached when CORTEX_OAUTH_JWKS_URI is not set) ──
let cachedKeySet: JWTVerifyGetKey | null = null;
let cachedKeySetFor = "";

async function resolveJwksUri(issuer: string): Promise<string> {
  const explicit = (process.env.CORTEX_OAUTH_JWKS_URI || "").trim();
  if (explicit) return explicit;
  // RFC 8414 discovery
  const metaUrl = `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const res = await fetch(metaUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`AS metadata ${res.status}`);
  const meta = (await res.json()) as { jwks_uri?: string };
  if (!meta.jwks_uri) throw new Error("AS metadata missing jwks_uri");
  return meta.jwks_uri;
}

async function getKeySet(issuer: string): Promise<JWTVerifyGetKey> {
  const uri = await resolveJwksUri(issuer);
  if (cachedKeySet && cachedKeySetFor === uri) return cachedKeySet;
  cachedKeySet = createRemoteJWKSet(new URL(uri));
  cachedKeySetFor = uri;
  return cachedKeySet;
}

// For tests / advanced wiring: reset the cached remote JWKS (e.g. on key rotation config change).
export function resetKeySetCache(): void {
  cachedKeySet = null;
  cachedKeySetFor = "";
}

/**
 * Verifies an OAuth access token. Throws on any failure (invalid sig, exp, iss, aud, alg).
 * `keyResolver` is injectable so unit tests can pass a local JWK instead of hitting a network.
 */
export async function verifyAccessToken(
  token: string,
  cfg: { issuer: string; audience: string; keyResolver?: JWTVerifyGetKey },
): Promise<{ sub?: string }> {
  const keyResolver = cfg.keyResolver ?? (await getKeySet(cfg.issuer));
  const { payload } = await jwtVerify(token, keyResolver, {
    issuer: cfg.issuer,
    audience: cfg.audience, // RFC 8707 audience binding: reject tokens not minted for us
    clockTolerance: 5,
  });
  return { sub: payload.sub ? String(payload.sub) : undefined };
}

/**
 * Authenticates an incoming MCP request:
 *   1. If OAuth is configured and a bearer token is present, try OAuth JWT verification.
 *   2. Otherwise (or if the token is not a JWT this AS signed), fall back to the static bearer.
 * Never reveals which path failed. Fail-closed when nothing is configured.
 */
export async function authenticate(req: Request, deps: { keyResolver?: JWTVerifyGetKey } = {}): Promise<AuthResult> {
  const token = bearerToken(req);
  const cfg = oauthConfigOrNull();

  if (cfg && token) {
    try {
      const { sub } = await verifyAccessToken(token, { ...cfg, keyResolver: deps.keyResolver });
      return { ok: true, via: "oauth", subject: sub };
    } catch {
      // not a valid OAuth token — try the static bearer below rather than 401 immediately
    }
  }

  if (staticTokenMatches(token)) return { ok: true, via: "static" };

  // No / invalid credentials.
  return { ok: false, error: "missing or invalid access token" };
}

// ── RFC 9728 Protected Resource Metadata + WWW-Authenticate ──────────────────

// Where this resource server publishes its PRM, based on the incoming request host
// (works behind whatever domain Vercel / the tunnel uses). Path is fixed by RFC 9728.
export function resourceMetadataUrl(req: Request): string {
  const origin = (req.headers["x-forwarded-host"]
    ? `https://${req.headers["x-forwarded-host"]}`
    : `${req.protocol}://${req.get("host") || "localhost"}`
  ).replace(/\/+$/, "");
  return `${origin}/.well-known/oauth-protected-resource`;
}

// The `WWW-Authenticate` value a client must see on 401 to bootstrap discovery.
export function wwwAuthenticate(req: Request): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(req)}"`;
}

/**
 * Express middleware: the same authentication POST /mcp uses (OAuth JWT or static bearer,
 * fail-closed), with the same 401 body shape and WWW-Authenticate header.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await authenticate(req);
  if (!auth.ok) {
    res.setHeader("WWW-Authenticate", wwwAuthenticate(req));
    res.status(401).json({ error: auth.error });
    return;
  }
  next();
}

// RFC 9728 PRM body. Returns null when OAuth is not configured (caller serves 404).
export function protectedResourceMetadata(): Record<string, unknown> | null {
  const cfg = oauthConfigOrNull();
  if (!cfg) return null;
  return {
    resource: cfg.audience,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:read"],
    resource_name: "CORTEX memory (read-only MCP)",
  };
}
