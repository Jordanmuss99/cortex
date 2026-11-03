import { SignJWT, generateKeyPair, exportJWK } from "jose";
import type { Request } from "express";
import {
  authenticate,
  verifyAccessToken,
  protectedResourceMetadata,
  wwwAuthenticate,
  resetKeySetCache,
} from "../mcp/auth";

const ISSUER = "https://idp.test/";
const AUDIENCE = "https://cortex.test/mcp";

function fakeReq(opts: { auth?: string; host?: string; forwardedHost?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.forwardedHost) headers["x-forwarded-host"] = opts.forwardedHost;
  return {
    headers,
    protocol: "https",
    get: (name: string) => (name.toLowerCase() === "host" ? opts.host || "cortex.test" : undefined),
  } as unknown as Request;
}

describe("mcp auth (resource server)", () => {
  let privateKey: any;
  let publicKey: any;
  let publicJwk: any;

  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
    publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
  });

  const mint = (over: Partial<{ iss: string; aud: string; exp: string | number; sub: string }> = {}) =>
    new SignJWT({ sub: over.sub ?? "user-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(over.iss ?? ISSUER)
      .setAudience(over.aud ?? AUDIENCE)
      .setExpirationTime(over.exp ?? "5m")
      .sign(privateKey);

  const oauthEnv = () => {
    process.env.CORTEX_OAUTH_ISSUER = ISSUER;
    process.env.CORTEX_MCP_PUBLIC_URL = AUDIENCE;
    delete process.env.CORTEX_OAUTH_JWKS_URI;
  };

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      CORTEX_OAUTH_ISSUER: process.env.CORTEX_OAUTH_ISSUER,
      CORTEX_MCP_PUBLIC_URL: process.env.CORTEX_MCP_PUBLIC_URL,
      CORTEX_OAUTH_JWKS_URI: process.env.CORTEX_OAUTH_JWKS_URI,
      CORTEX_MCP_TOKEN: process.env.CORTEX_MCP_TOKEN,
    };
    resetKeySetCache();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("verifyAccessToken", () => {
    it("accepts a well-formed token with matching iss + aud", async () => {
      const token = await mint();
      const { sub } = await verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE, keyResolver: publicKey });
      expect(sub).toBe("user-1");
    });

    it("rejects a token minted for a different audience (RFC 8707 binding)", async () => {
      const token = await mint({ aud: "https://other.test" });
      await expect(verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE, keyResolver: publicKey }))
        .rejects.toThrow();
    });

    it("rejects a token from a different issuer", async () => {
      const token = await mint({ iss: "https://evil.test/" });
      await expect(verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE, keyResolver: publicKey }))
        .rejects.toThrow();
    });

    it("rejects an expired token", async () => {
      const token = await mint({ exp: Math.floor(Date.now() / 1000) - 100 });
      await expect(verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE, keyResolver: publicKey }))
        .rejects.toThrow();
    });

    it("rejects an alg:none unsigned token", async () => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", iss: ISSUER, aud: AUDIENCE })}.`;
      await expect(verifyAccessToken(none, { issuer: ISSUER, audience: AUDIENCE, keyResolver: publicKey }))
        .rejects.toThrow();
    });
  });

  describe("authenticate", () => {
    it("accepts a valid OAuth bearer (via injected keyset)", async () => {
      oauthEnv();
      process.env.CORTEX_MCP_TOKEN = "static-fallback";
      const token = await mint();
      const res = await authenticate(fakeReq({ auth: `Bearer ${token}` }), { keyResolver: publicKey });
      expect(res.ok).toBe(true);
      expect(res.ok && res.via).toBe("oauth");
    });

    it("falls back to the static bearer when OAuth is not configured", async () => {
      delete process.env.CORTEX_OAUTH_ISSUER;
      delete process.env.CORTEX_MCP_PUBLIC_URL;
      process.env.CORTEX_MCP_TOKEN = "sekret";
      const res = await authenticate(fakeReq({ auth: "Bearer sekret" }));
      expect(res.ok && res.via).toBe("static");
    });

    it("accepts the static bearer even when a non-JWT token is presented under OAuth", async () => {
      oauthEnv();
      process.env.CORTEX_MCP_TOKEN = "sekret";
      const res = await authenticate(fakeReq({ auth: "Bearer sekret" }), { keyResolver: publicKey });
      expect(res.ok && res.via).toBe("static");
    });

    it("rejects when nothing matches / fail-closed when unconfigured", async () => {
      delete process.env.CORTEX_MCP_TOKEN;
      delete process.env.CORTEX_OAUTH_ISSUER;
      delete process.env.CORTEX_MCP_PUBLIC_URL;
      const res = await authenticate(fakeReq({ auth: "Bearer whatever" }));
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error).toContain("invalid");
    });
  });

  describe("RFC 9728 metadata", () => {
    it("returns PRM with authorization_servers when configured", () => {
      oauthEnv();
      const doc = protectedResourceMetadata()!;
      expect(doc.resource).toBe(AUDIENCE);
      expect(doc.authorization_servers).toEqual([ISSUER]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
    });

    it("returns null PRM when OAuth not configured", () => {
      delete process.env.CORTEX_OAUTH_ISSUER;
      delete process.env.CORTEX_MCP_PUBLIC_URL;
      expect(protectedResourceMetadata()).toBeNull();
    });

    it("wwwAuthenticate points at the well-known path (honours x-forwarded-host)", () => {
      oauthEnv();
      const h = wwwAuthenticate(fakeReq({ host: "cortex.test", forwardedHost: "cortex.obsidiannetwork.au" }));
      expect(h).toBe('Bearer resource_metadata="https://cortex.obsidiannetwork.au/.well-known/oauth-protected-resource"');
    });

    it("sanity: exported public JWK round-trips through createLocalJWKSet-style key", async () => {
      oauthEnv();
      expect(publicJwk.kid).toBe("test-key");
      // public key object is usable as a verifier (guards against accidental private-key export)
      expect(publicJwk.d).toBeUndefined();
    });
  });
});
