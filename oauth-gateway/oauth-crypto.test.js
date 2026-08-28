import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { SignJWT } from "jose";
import {
  createBrowserCredentialVerifier,
  loadGatewaySecrets
} from "./config.js";
import {
  canonicalizeScopes,
  createOAuthCrypto,
  createPkceChallenge,
  createRefreshRequestFingerprint,
  verifyPkceChallenge
} from "./oauth-crypto.js";

const JWT_SECRET = " slice-3-secret-that-is-at-least-thirty-two-bytes ";
const SECOND_SECRET = "another-slice-3-secret-that-is-at-least-32-bytes";
const ISSUER = "https://cortex.example.test";
const RESOURCE = `${ISSUER}/mcp`;
const LEGACY_CLIENT_IP = "203.0.113.10";
const LOGIN_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const CONFIG = Object.freeze({
  baseUrl: ISSUER,
  issuerUrl: ISSUER,
  resourceUrl: RESOURCE,
  bootstrapSubject: "slice-3-user",
  accessTokenTtlSeconds: 60,
  refreshTokenTtlSeconds: 3600,
  loginSessionTtlSeconds: LOGIN_SESSION_TTL_SECONDS,
  acceptLegacyUntil: new Date(Date.now() + 60 * 60 * 1_000)
});

const SECRETS = Object.freeze({
  jwtSecret: JWT_SECRET,
  browserPassword: " password bytes are not trimmed "
});

function grant(overrides = {}) {
  return {
    sid: randomUUID(),
    principalId: randomUUID(),
    subject: "slice-3-user",
    authenticationEpoch: 2,
    bindingId: randomUUID(),
    bindingVersion: 3,
    agentId: 7,
    agentExternalId: "agent-slice-3",
    clientId: "chatgpt-012345678901234567890123",
    resource: RESOURCE,
    scopes: ["mcp", "cortex:read", "cortex:write"],
    inactivityExpiresAt: new Date(Date.now() + 3600_000),
    ...overrides
  };
}

function fixedRefreshDescriptor(crypto, grantValue) {
  const issuedSeconds = Math.floor(Date.now() / 1000);
  const material = crypto.createRefreshMaterial(grantValue.sid, 0);
  return {
    material,
    descriptor: {
      grant: grantValue,
      generation: 0,
      reconstructionNonce: material.nonce,
      issuedAt: new Date(issuedSeconds * 1000),
      expiresAt: new Date((issuedSeconds + CONFIG.refreshTokenTtlSeconds) * 1000)
    }
  };
}

async function signRaw(payload, typ = "JWT", secret = JWT_SECRET) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ })
    .sign(new TextEncoder().encode(secret));
}

async function signLegacyToken(use, overrides = {}, {
  config = CONFIG,
  secret = JWT_SECRET,
  subject = config.bootstrapSubject,
  lifetimeAdjustment = 0
} = {}) {
  const issuedAt = Math.floor(Date.now() / 1_000) - 5;
  const lifetime = use === "access"
    ? config.accessTokenTtlSeconds
    : config.refreshTokenTtlSeconds;
  const payload = {
    scope: "mcp cortex:read",
    aud: config.resourceUrl,
    client_id: "chatgpt-012345678901234567890123",
    token_use: use,
    ...overrides
  };
  const builder = new SignJWT(payload)
    .setProtectedHeader({
      alg: "HS256",
      typ: use === "access" ? "JWT" : "refresh+jwt"
    })
    .setIssuer(config.issuerUrl)
    .setSubject(subject);
  if (use === "refresh" && payload.jti === undefined) {
    builder.setJti(Buffer.alloc(18, 7).toString("base64url"));
  }
  return await builder
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetime + lifetimeAdjustment)
    .sign(new TextEncoder().encode(secret));
}

function legacyHmac(purpose, value, secret = JWT_SECRET) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`cortex-oauth:${purpose}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("base64url");
}

function signLegacyPayload(payload, {
  secret = JWT_SECRET,
  payloadText = JSON.stringify(payload)
} = {}) {
  const payloadPart = Buffer.from(payloadText, "utf8").toString("base64url");
  return `${payloadPart}.${legacyHmac("login-session", payloadPart, secret)}`;
}

function legacyPayload(overrides = {}) {
  const issuedAt = Math.floor(Date.now() / 1000) - 5;
  return {
    version: 1,
    sub: CONFIG.bootstrapSubject,
    ip_hash: legacyHmac("client-ip", LEGACY_CLIENT_IP),
    issued_at: issuedAt,
    expires_at: issuedAt + CONFIG.loginSessionTtlSeconds,
    ...overrides
  };
}

function derivedDigest(purpose, value, secret = JWT_SECRET) {
  const purposeKey = createHmac("sha256", Buffer.from(secret, "utf8"))
    .update("cortex-oauth:derived-key:v2\0", "utf8")
    .update(purpose, "utf8")
    .digest();
  return new Uint8Array(createHmac("sha256", purposeKey).update(value).digest());
}

test("loads untrimmed bounded secrets outside serializable gateway config", () => {
  const loaded = loadGatewaySecrets({
    MCP_OAUTH_JWT_SECRET: JWT_SECRET,
    MCP_OAUTH_PASSWORD: "  exact password\n"
  });

  assert.equal(loaded.jwtSecret, JWT_SECRET);
  assert.equal(loaded.browserPassword, "  exact password\n");
  assert.deepEqual(Object.keys(loaded), []);
  assert.equal(JSON.stringify(loaded), "{}");
  assert.ok(Object.isFrozen(loaded));

  assert.throws(
    () => loadGatewaySecrets({ MCP_OAUTH_JWT_SECRET: "x".repeat(31), MCP_OAUTH_PASSWORD: "x" }),
    /MCP_OAUTH_JWT_SECRET/
  );
  assert.equal(
    loadGatewaySecrets({
      MCP_OAUTH_JWT_SECRET: "é".repeat(16),
      MCP_OAUTH_PASSWORD: "x"
    }).jwtSecret,
    "é".repeat(16),
    "minimum JWT secret length is measured in UTF-8 bytes"
  );
  assert.throws(
    () => loadGatewaySecrets({ MCP_OAUTH_JWT_SECRET: JWT_SECRET, MCP_OAUTH_PASSWORD: "" }),
    /MCP_OAUTH_PASSWORD/
  );
  assert.throws(
    () => loadGatewaySecrets({
      MCP_OAUTH_JWT_SECRET: "x".repeat(4097),
      MCP_OAUTH_PASSWORD: "x"
    }),
    /MCP_OAUTH_JWT_SECRET/
  );
});

test("browser credentials require exact username and untrimmed password", () => {
  const verify = createBrowserCredentialVerifier("slice-3-user", SECRETS);
  assert.equal(verify("slice-3-user", SECRETS.browserPassword), true);
  assert.equal(verify("slice-3-user ", SECRETS.browserPassword), false);
  assert.equal(verify("slice-3-user", SECRETS.browserPassword.trim()), false);
  assert.equal(verify(null, SECRETS.browserPassword), false);
  assert.equal(verify("slice-3-user", null), false);
  assert.equal(verify("x".repeat(513), SECRETS.browserPassword), false);
  assert.equal(verify("slice-3-user", "x".repeat(4097)), false);
});

test("requires bounded bootstrap, session, and legacy-cutoff configuration", () => {
  assert.throws(
    () => createOAuthCrypto({ ...CONFIG, bootstrapSubject: undefined }, SECRETS),
    /bootstrapSubject/
  );
  assert.throws(
    () => createOAuthCrypto({ ...CONFIG, bootstrapSubject: " slice-3-user " }, SECRETS),
    /bootstrapSubject/
  );
  assert.throws(
    () => createOAuthCrypto({ ...CONFIG, loginSessionTtlSeconds: 0 }, SECRETS),
    /loginSessionTtlSeconds/
  );
  assert.throws(
    () => createOAuthCrypto({
      ...CONFIG,
      loginSessionTtlSeconds: 90 * 24 * 60 * 60 + 1
    }, SECRETS),
    /loginSessionTtlSeconds/
  );
  assert.throws(
    () => createOAuthCrypto({ ...CONFIG, acceptLegacyUntil: undefined }, SECRETS),
    /acceptLegacyUntil/
  );
  assert.throws(
    () => createOAuthCrypto({ ...CONFIG, acceptLegacyUntil: new Date(NaN) }, SECRETS),
    /acceptLegacyUntil/
  );
});

test("canonicalizes only the three approved scopes", () => {
  assert.deepEqual(
    canonicalizeScopes("mcp cortex:write cortex:read mcp"),
    ["cortex:read", "cortex:write", "mcp"]
  );
  assert.deepEqual(canonicalizeScopes(["mcp"]), ["mcp"]);
  assert.throws(() => canonicalizeScopes(""), /scope/);
  assert.throws(() => canonicalizeScopes("mcp admin"), /unsupported/);
});

test("enforces RFC 7636 verifier shape and constant-length S256 challenges", () => {
  const verifier = "A".repeat(43);
  const challenge = createPkceChallenge(verifier);
  assert.equal(challenge.length, 43);
  assert.equal(
    challenge,
    createHash("sha256").update(verifier, "ascii").digest("base64url")
  );
  assert.equal(verifyPkceChallenge(verifier, challenge), true);
  assert.equal(verifyPkceChallenge(`${verifier.slice(0, -1)}B`, challenge), false);
  assert.equal(verifyPkceChallenge("A".repeat(42), challenge), false);
  assert.equal(verifyPkceChallenge("A".repeat(129), challenge), false);
  assert.equal(verifyPkceChallenge(`${"A".repeat(42)}!`, challenge), false);
  assert.equal(verifyPkceChallenge(verifier, `${challenge}?`), false);
  assert.throws(() => createPkceChallenge("short"), /PKCE/);
});

test("stores only purpose-keyed authorization-code and opaque-cookie digests", () => {
  const first = createOAuthCrypto(CONFIG, SECRETS);
  const restarted = createOAuthCrypto(CONFIG, SECRETS);
  const differentKey = createOAuthCrypto(CONFIG, { ...SECRETS, jwtSecret: SECOND_SECRET });
  const code = first.createAuthorizationCode();

  assert.match(code.raw, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(code.digest.byteLength, 32);
  assert.deepEqual(restarted.digestAuthorizationCode(code.raw), code.digest);
  assert.notDeepEqual(differentKey.digestAuthorizationCode(code.raw), code.digest);
  assert.notDeepEqual(
    code.digest,
    createHash("sha256").update(code.raw, "ascii").digest(),
    "the database descriptor is not a bare hash"
  );

  const cookie = first.createLoginCookie();
  assert.equal(cookie.raw.length, 43);
  assert.equal(cookie.digest.byteLength, 32);
  assert.deepEqual(restarted.digestLoginCookie(cookie.raw), cookie.digest);
  assert.notDeepEqual(differentKey.digestLoginCookie(cookie.raw), cookie.digest);
  assert.notDeepEqual(
    cookie.digest,
    createHash("sha256").update(cookie.raw, "ascii").digest(),
    "the cookie descriptor is not a bare hash"
  );
  assert.notDeepEqual(first.digestAuthorizationCode(cookie.raw), first.digestLoginCookie(cookie.raw));
  assert.throws(() => first.digestAuthorizationCode("not-an-oauth-code"), /authorization code/);
  assert.throws(() => first.digestLoginCookie("not-a-login-cookie"), /login cookie/);
});

test("verifies an exact v1 login cookie and returns only frozen migration claims", () => {
  const first = createOAuthCrypto(CONFIG, SECRETS);
  const restarted = createOAuthCrypto(CONFIG, SECRETS);
  const payload = legacyPayload();
  const cookie = signLegacyPayload(payload);
  const claims = first.verifyLegacyLoginCookie(cookie, LEGACY_CLIENT_IP);

  assert.ok(claims);
  assert.equal(Object.isFrozen(claims), true);
  assert.deepEqual(Object.keys(claims).sort(), [
    "expiresAt",
    "issuedAt",
    "legacyCookieDigest",
    "subject"
  ]);
  assert.equal(claims.subject, CONFIG.bootstrapSubject);
  assert.equal(claims.issuedAt.getTime(), payload.issued_at * 1000);
  assert.equal(claims.expiresAt.getTime(), payload.expires_at * 1000);
  assert.equal(claims.legacyCookieDigest.byteLength, 32);
  assert.deepEqual(
    claims.legacyCookieDigest,
    derivedDigest("legacy-login-cookie-digest", Buffer.from(cookie, "ascii"))
  );
  assert.notDeepEqual(
    claims.legacyCookieDigest,
    derivedDigest("login-cookie-digest", Buffer.from(cookie, "ascii"))
  );
  assert.notDeepEqual(
    claims.legacyCookieDigest,
    createHash("sha256").update(cookie, "ascii").digest()
  );
  assert.deepEqual(
    restarted.verifyLegacyLoginCookie(cookie, LEGACY_CLIENT_IP)?.legacyCookieDigest,
    claims.legacyCookieDigest
  );
  assert.deepEqual(
    first.verifyLegacyLoginCookie(cookie, LEGACY_CLIENT_IP)?.legacyCookieDigest,
    claims.legacyCookieDigest,
    "cryptographic verification is repeatable; PostgreSQL consumes the source once"
  );
  assert.equal(
    createOAuthCrypto(CONFIG, { ...SECRETS, jwtSecret: JWT_SECRET.trim() })
      .verifyLegacyLoginCookie(cookie, LEGACY_CLIENT_IP),
    null,
    "v1 verification uses the exact untrimmed secret bytes"
  );
});

test("rejects malformed, noncanonical, tampered, and mismatched v1 cookies", () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const payload = legacyPayload();
  const valid = signLegacyPayload(payload);
  const [payloadPart, signaturePart] = valid.split(".");
  const duplicateVersion = JSON.stringify(payload)
    .replace("{\"version\":1", "{\"version\":1,\"version\":1");
  const reordered = JSON.stringify({
    sub: payload.sub,
    version: payload.version,
    ip_hash: payload.ip_hash,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at
  });
  const invalidUtf8Part = Buffer.from([0xff, 0xfe]).toString("base64url");
  const invalidUtf8 = `${invalidUtf8Part}.${legacyHmac("login-session", invalidUtf8Part)}`;
  const signedInvalidJsonPart = Buffer.from("{", "utf8").toString("base64url");
  const signedInvalidJson = `${signedInvalidJsonPart}.${legacyHmac(
    "login-session",
    signedInvalidJsonPart
  )}`;

  const rejected = [
    null,
    undefined,
    "",
    "one-part",
    `${payloadPart}.${signaturePart}.extra`,
    `${payloadPart}.${signaturePart.slice(0, -1)}${signaturePart.endsWith("A") ? "B" : "A"}`,
    `${payloadPart.slice(0, -1)}${payloadPart.endsWith("A") ? "B" : "A"}.${signaturePart}`,
    `${payloadPart}=.${legacyHmac("login-session", `${payloadPart}=`)}`,
    "x".repeat(2049),
    invalidUtf8,
    signedInvalidJson,
    signLegacyPayload({ ...payload, version: 2 }),
    signLegacyPayload({ ...payload, sub: "another-subject" }),
    signLegacyPayload({ ...payload, ip_hash: legacyHmac("client-ip", "203.0.113.11") }),
    signLegacyPayload({ ...payload, extra: true }),
    signLegacyPayload(payload, { payloadText: duplicateVersion }),
    signLegacyPayload(payload, { payloadText: reordered }),
    signLegacyPayload(payload, { payloadText: ` ${JSON.stringify(payload)}` })
  ];

  for (const cookie of rejected) {
    assert.doesNotThrow(() => crypto.verifyLegacyLoginCookie(cookie, LEGACY_CLIENT_IP));
    assert.equal(crypto.verifyLegacyLoginCookie(cookie, LEGACY_CLIENT_IP), null);
  }

  for (const ip of [null, undefined, "", "not-an-ip", ` ${LEGACY_CLIENT_IP}`, "203.0.113.11"]) {
    assert.doesNotThrow(() => crypto.verifyLegacyLoginCookie(valid, ip));
    assert.equal(crypto.verifyLegacyLoginCookie(valid, ip), null);
  }
});

test("enforces exact v1 login-cookie lifetime and future clock skew", () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const current = Math.floor(Date.now() / 1000);
  const atSkewBoundary = legacyPayload({
    issued_at: current + 60,
    expires_at: current + 60 + CONFIG.loginSessionTtlSeconds
  });
  assert.ok(crypto.verifyLegacyLoginCookie(
    signLegacyPayload(atSkewBoundary),
    LEGACY_CLIENT_IP
  ));

  const rejected = [
    legacyPayload({
      issued_at: current - CONFIG.loginSessionTtlSeconds,
      expires_at: current
    }),
    legacyPayload({
      issued_at: current + 120,
      expires_at: current + 120 + CONFIG.loginSessionTtlSeconds
    }),
    legacyPayload({ expires_at: current + CONFIG.loginSessionTtlSeconds + 1 }),
    legacyPayload({ issued_at: current - 0.5 })
  ];
  for (const payloadValue of rejected) {
    assert.equal(
      crypto.verifyLegacyLoginCookie(signLegacyPayload(payloadValue), LEGACY_CLIENT_IP),
      null
    );
  }
});

test("IP and user-agent fingerprints are keyed, normalized, and domain separated", () => {
  const first = createOAuthCrypto(CONFIG, SECRETS);
  const restarted = createOAuthCrypto(CONFIG, SECRETS);
  const differentKey = createOAuthCrypto(CONFIG, { ...SECRETS, jwtSecret: SECOND_SECRET });
  const userAgent = "ChatGPT-Connector/1.0";
  const ipFingerprint = first.fingerprintClientIp(LEGACY_CLIENT_IP);
  const userAgentFingerprint = first.fingerprintUserAgent(userAgent);

  assert.equal(ipFingerprint.byteLength, 32);
  assert.equal(userAgentFingerprint.byteLength, 32);
  assert.deepEqual(restarted.fingerprintClientIp(LEGACY_CLIENT_IP), ipFingerprint);
  assert.deepEqual(restarted.fingerprintUserAgent(userAgent), userAgentFingerprint);
  assert.notDeepEqual(first.fingerprintClientIp("203.0.113.11"), ipFingerprint);
  assert.notDeepEqual(first.fingerprintUserAgent(`${userAgent} changed`), userAgentFingerprint);
  assert.notDeepEqual(differentKey.fingerprintClientIp(LEGACY_CLIENT_IP), ipFingerprint);
  assert.notDeepEqual(
    first.fingerprintClientIp("2001:db8::1"),
    first.fingerprintUserAgent("2001:db8::1")
  );
  assert.notDeepEqual(
    ipFingerprint,
    createHash("sha256").update(LEGACY_CLIENT_IP, "utf8").digest()
  );

  for (const ip of [
    "",
    "not-an-ip",
    ` ${LEGACY_CLIENT_IP}`,
    "2001:DB8::1",
    "::ffff:203.0.113.10"
  ]) {
    assert.throws(() => first.fingerprintClientIp(ip), /client IP/);
  }
  assert.equal(first.fingerprintClientIp("2001:db8::1").byteLength, 32);
  assert.throws(() => first.fingerprintUserAgent(""), /user agent/);
  assert.throws(() => first.fingerprintUserAgent(" padded "), /user agent/);
  assert.throws(() => first.fingerprintUserAgent("x".repeat(2049)), /user agent/);
});

test("derives generation-zero refresh material without retaining a bearer JTI", () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const restarted = createOAuthCrypto(CONFIG, SECRETS);
  const differentKey = createOAuthCrypto(CONFIG, { jwtSecret: SECOND_SECRET });
  const sid = randomUUID();
  const first = crypto.createRefreshMaterial(sid, 0);
  const second = crypto.createRefreshMaterial(sid, 0);

  assert.equal(first.nonce.byteLength, 32);
  assert.match(first.jti, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.jtiDigest.byteLength, 32);
  assert.deepEqual(crypto.digestRefreshJti(first.jti), first.jtiDigest);
  assert.deepEqual(restarted.digestRefreshJti(first.jti), first.jtiDigest);
  assert.notDeepEqual(differentKey.digestRefreshJti(first.jti), first.jtiDigest);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notEqual(first.jti, second.jti);
  assert.throws(() => crypto.createRefreshMaterial(sid, -1), /generation/);
  for (const invalid of ["", "J".repeat(42), "J".repeat(44), "J".repeat(42) + "."]) {
    assert.throws(
      () => crypto.digestRefreshJti(invalid),
      (error) => error instanceof TypeError &&
        error.message === "refresh JTI is invalid" &&
        (invalid.length === 0 || !error.message.includes(invalid))
    );
  }
});

test("strictly verifies exact v1 access and refresh tokens before the cutoff", async () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const access = await crypto.verifyAccessToken(await signLegacyToken("access", {
    scope: "mcp   cortex:read mcp"
  }));
  const refresh = await crypto.verifyRefreshToken(await signLegacyToken("refresh", {
    scope: "mcp cortex:write"
  }));

  assert.equal(access.legacy, true);
  assert.equal(access.scope, "cortex:read mcp");
  assert.equal(Object.hasOwn(access, "sid"), false);
  assert.equal(refresh.legacy, true);
  assert.equal(refresh.scope, "cortex:write mcp");
  assert.match(refresh.jti, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(crypto.digestLegacyRefreshJti(refresh.jti).byteLength, 32);
  assert.notDeepEqual(
    crypto.digestLegacyRefreshJti(refresh.jti),
    crypto.digestRefreshJti("J".repeat(43))
  );
  for (const invalid of ["", "J".repeat(23), "J".repeat(25), "J".repeat(23) + "."]) {
    assert.throws(
      () => crypto.digestLegacyRefreshJti(invalid),
      /legacy refresh JTI is invalid/
    );
  }
});

test("legacy token verification rejects downgrade shapes, wrong lifetimes, and cutoff use", async () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const wrongLifetime = await signLegacyToken("access", {}, {
    lifetimeAdjustment: 5
  });
  const malformedV2 = await signLegacyToken("refresh", {
    sid: randomUUID(),
    agent_id: "agent-slice-3",
    auth_epoch: 2,
    binding_version: 3,
    generation: 0,
    jti: "J".repeat(43)
  });
  const badJti = await signLegacyToken("refresh", { jti: "J".repeat(23) });
  const unknownClaim = await signLegacyToken("access", { unexpected: true });
  const wrongSubject = await signLegacyToken("access", {}, {
    subject: "another-user"
  });

  for (const [token, use] of [
    [wrongLifetime, "access"],
    [malformedV2, "refresh"],
    [badJti, "refresh"],
    [unknownClaim, "access"],
    [wrongSubject, "access"]
  ]) {
    await assert.rejects(
      async () => use === "refresh"
        ? await crypto.verifyRefreshToken(token)
        : await crypto.verifyAccessToken(token),
      TypeError
    );
  }

  const mutableDeadline = new Date(Date.now() - 1_000);
  const closed = createOAuthCrypto(
    { ...CONFIG, acceptLegacyUntil: mutableDeadline },
    SECRETS
  );
  const accessToken = await signLegacyToken("access");
  mutableDeadline.setTime(Date.now() + 60 * 60 * 1_000);
  await assert.rejects(
    () => closed.verifyAccessToken(accessToken),
    TypeError
  );
});

test("legacy family digests bind issuer subject client and resource but never scope", () => {
  const first = createOAuthCrypto(CONFIG, SECRETS);
  const otherIssuer = createOAuthCrypto({
    ...CONFIG,
    issuerUrl: "https://other-issuer.example.test"
  }, SECRETS);
  const tuple = {
    subject: CONFIG.bootstrapSubject,
    clientId: "chatgpt-012345678901234567890123",
    resource: CONFIG.resourceUrl
  };

  assert.deepEqual(first.digestLegacyTuple(tuple), first.digestLegacyTuple({ ...tuple }));
  assert.notDeepEqual(first.digestLegacyTuple(tuple), otherIssuer.digestLegacyTuple(tuple));
  assert.notDeepEqual(
    first.digestLegacyTuple(tuple),
    first.digestLegacyTuple({ ...tuple, resource: CONFIG.baseUrl })
  );
  assert.throws(
    () => first.digestLegacyTuple({ ...tuple, scopes: ["mcp"] }),
    /legacy tuple is invalid/
  );
});

test("reconstructs the exact refresh JWT across crypto recreation", async () => {
  const first = createOAuthCrypto(CONFIG, SECRETS);
  const restarted = createOAuthCrypto(CONFIG, SECRETS);
  const grantValue = grant();
  const { material, descriptor } = fixedRefreshDescriptor(first, grantValue);

  const beforeRestart = await first.issueRefreshToken(descriptor);
  const afterRestart = await restarted.issueRefreshToken({
    ...descriptor,
    reconstructionNonce: new Uint8Array(descriptor.reconstructionNonce)
  });
  assert.equal(afterRestart, beforeRestart);

  const claims = await restarted.verifyRefreshToken(afterRestart);
  assert.equal(claims.sid, grantValue.sid);
  assert.equal(claims.agent_id, grantValue.agentExternalId);
  assert.equal(claims.generation, 0);
  assert.equal(claims.jti, material.jti);
  assert.equal(claims.scope, "cortex:read cortex:write mcp");
});

test("existing tokens and refresh descriptors survive TTL configuration changes", async () => {
  const issuingCrypto = createOAuthCrypto(CONFIG, SECRETS);
  const grantValue = grant();
  const accessToken = await issuingCrypto.issueAccessToken(grantValue);
  const { descriptor } = fixedRefreshDescriptor(issuingCrypto, grantValue);
  const refreshToken = await issuingCrypto.issueRefreshToken(descriptor);
  const restarted = createOAuthCrypto({
    ...CONFIG,
    accessTokenTtlSeconds: CONFIG.accessTokenTtlSeconds * 2,
    refreshTokenTtlSeconds: CONFIG.refreshTokenTtlSeconds * 2
  }, SECRETS);

  assert.equal((await restarted.verifyAccessToken(accessToken)).sid, grantValue.sid);
  assert.equal((await restarted.verifyRefreshToken(refreshToken)).sid, grantValue.sid);
  assert.equal(await restarted.issueRefreshToken(descriptor), refreshToken);
});

test("issues and strictly verifies every bound v2 access claim", async () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const grantValue = grant({ resource: ISSUER, scopes: ["mcp", "cortex:read"] });
  const token = await crypto.issueAccessToken(grantValue);
  const claims = await crypto.verifyAccessToken(token);

  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.sub, grantValue.subject);
  assert.equal(claims.aud, ISSUER);
  assert.equal(claims.scope, "cortex:read mcp");
  assert.equal(claims.client_id, grantValue.clientId);
  assert.equal(claims.token_use, "access");
  assert.equal(claims.sid, grantValue.sid);
  assert.equal(claims.agent_id, grantValue.agentExternalId);
  assert.equal(claims.auth_epoch, grantValue.authenticationEpoch);
  assert.equal(claims.binding_version, grantValue.bindingVersion);
  assert.match(claims.jti, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(claims.exp - claims.iat, CONFIG.accessTokenTtlSeconds);
});

test("rejects access-refresh substitution and malformed signed policy claims", async () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const grantValue = grant();
  const accessToken = await crypto.issueAccessToken(grantValue);
  const { descriptor } = fixedRefreshDescriptor(crypto, grantValue);
  const refreshToken = await crypto.issueRefreshToken(descriptor);

  await assert.rejects(() => crypto.verifyRefreshToken(accessToken));
  await assert.rejects(() => crypto.verifyAccessToken(refreshToken));

  const issuedAt = Math.floor(Date.now() / 1000);
  const baseClaims = {
    iss: ISSUER,
    sub: grantValue.subject,
    aud: RESOURCE,
    scope: "mcp cortex:read",
    client_id: grantValue.clientId,
    token_use: "access",
    sid: grantValue.sid,
    agent_id: grantValue.agentExternalId,
    auth_epoch: grantValue.authenticationEpoch,
    binding_version: grantValue.bindingVersion,
    jti: "J".repeat(43),
    iat: issuedAt,
    exp: issuedAt + CONFIG.accessTokenTtlSeconds
  };
  const malformedScopeToken = await signRaw(baseClaims);
  await assert.rejects(() => crypto.verifyAccessToken(malformedScopeToken), /canonical/);
  const wrongAudienceToken = await signRaw({
    ...baseClaims,
    scope: "cortex:read mcp",
    aud: "https://wrong.example"
  });
  await assert.rejects(
    () => crypto.verifyAccessToken(wrongAudienceToken)
  );
  await assert.rejects(
    () => createOAuthCrypto({ ...CONFIG, issuerUrl: "https://other.example" }, SECRETS)
      .verifyAccessToken(accessToken)
  );
  const arrayAudienceToken = await signRaw({
    ...baseClaims,
    scope: "cortex:read mcp",
    aud: [RESOURCE]
  });
  await assert.rejects(() => crypto.verifyAccessToken(arrayAudienceToken));
});

test("revocation references accept expired v2 families without exposing bearer claims", async () => {
  const crypto = createOAuthCrypto(CONFIG, SECRETS);
  const grantValue = grant();
  const currentAccess = await crypto.issueAccessToken(grantValue);
  const { descriptor } = fixedRefreshDescriptor(crypto, grantValue);
  const currentRefresh = await crypto.issueRefreshToken(descriptor);

  const expectedAccess = {
    sid: grantValue.sid,
    clientId: grantValue.clientId,
    tokenUse: "access"
  };
  const expectedRefresh = { ...expectedAccess, tokenUse: "refresh" };
  const currentAccessReference = await crypto.verifyRevocationReference(currentAccess);
  assert.deepEqual(currentAccessReference, expectedAccess);
  assert.deepEqual(await crypto.verifyRevocationReference(currentRefresh), expectedRefresh);
  assert.ok(Object.isFrozen(currentAccessReference));
  assert.deepEqual(Object.keys(currentAccessReference).sort(), [
    "clientId",
    "sid",
    "tokenUse"
  ]);

  const expiredIssuedAt = Math.floor(Date.now() / 1000) - 7_200;
  const baseClaims = {
    iss: ISSUER,
    sub: grantValue.subject,
    aud: RESOURCE,
    scope: "cortex:read cortex:write mcp",
    client_id: grantValue.clientId,
    token_use: "access",
    sid: grantValue.sid,
    agent_id: grantValue.agentExternalId,
    auth_epoch: grantValue.authenticationEpoch,
    binding_version: grantValue.bindingVersion,
    jti: "R".repeat(43),
    iat: expiredIssuedAt,
    exp: expiredIssuedAt + 60
  };
  const expiredAccess = await signRaw(baseClaims);
  const expiredRefresh = await signRaw({
    ...baseClaims,
    token_use: "refresh",
    generation: 4,
    exp: expiredIssuedAt + 3_600
  }, "refresh+jwt");
  await assert.rejects(() => crypto.verifyAccessToken(expiredAccess));
  await assert.rejects(() => crypto.verifyRefreshToken(expiredRefresh));
  assert.deepEqual(await crypto.verifyRevocationReference(expiredAccess), expectedAccess);
  assert.deepEqual(await crypto.verifyRevocationReference(expiredRefresh), expectedRefresh);

  const wrongIssuer = await signRaw({ ...baseClaims, iss: "https://other.example.test" });
  const wrongAudience = await signRaw({ ...baseClaims, aud: "https://other.example.test/mcp" });
  const wrongType = await signRaw(baseClaims, "refresh+jwt");
  const noncanonicalScope = await signRaw({ ...baseClaims, scope: "mcp cortex:read" });
  const arrayAudience = await signRaw({ ...baseClaims, aud: [RESOURCE] });
  const futureIssued = await signRaw({
    ...baseClaims,
    iat: Math.floor(Date.now() / 1000) + 120,
    exp: Math.floor(Date.now() / 1000) + 180
  });
  const wrongSecret = await signRaw(baseClaims, "JWT", SECOND_SECRET);
  const tamperedParts = expiredAccess.split(".");
  tamperedParts[2] = `${tamperedParts[2][0] === "A" ? "B" : "A"}${tamperedParts[2].slice(1)}`;
  const tampered = tamperedParts.join(".");
  for (const invalid of [
    "",
    "not-a-jwt",
    "x".repeat(16 * 1024 + 1),
    wrongIssuer,
    wrongAudience,
    wrongType,
    noncanonicalScope,
    arrayAudience,
    futureIssued,
    wrongSecret,
    tampered
  ]) {
    assert.equal(await crypto.verifyRevocationReference(invalid), null);
  }
});

test("keyed refresh fingerprints are canonical and restart-stable", () => {
  const first = createOAuthCrypto(CONFIG, SECRETS);
  const restarted = createOAuthCrypto(CONFIG, SECRETS);
  const input = {
    clientId: "chatgpt-012345678901234567890123",
    resource: RESOURCE,
    scopes: ["mcp", "cortex:read"]
  };

  assert.deepEqual(
    first.createRefreshRequestFingerprint(input),
    restarted.createRefreshRequestFingerprint({ ...input, scopes: "cortex:read mcp" })
  );
  assert.deepEqual(
    createRefreshRequestFingerprint(input, SECRETS),
    first.createRefreshRequestFingerprint(input)
  );
  assert.notDeepEqual(
    createRefreshRequestFingerprint(input, { jwtSecret: SECOND_SECRET }),
    first.createRefreshRequestFingerprint(input)
  );
  for (const changed of [
    { ...input, clientId: `${input.clientId}-changed` },
    { ...input, resource: ISSUER },
    { ...input, scopes: ["cortex:read"] }
  ]) {
    assert.notDeepEqual(
      first.createRefreshRequestFingerprint(changed),
      first.createRefreshRequestFingerprint(input)
    );
  }
});
