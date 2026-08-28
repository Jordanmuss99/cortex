import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { isIP } from "node:net";
import { decodeJwt, SignJWT, jwtVerify } from "jose";

const SCOPE_ORDER = Object.freeze(["cortex:read", "cortex:write", "mcp"]);
const SUPPORTED_SCOPES = new Set(SCOPE_ORDER);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_32_BYTE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_REFRESH_JTI_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_SECRET_UTF8_BYTES = 4096;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_CLAIM_LENGTH = 4096;
const MAX_LEGACY_LOGIN_COOKIE_LENGTH = 2048;
const CLOCK_SKEW_SECONDS = 60;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_REFRESH_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const MAX_LOGIN_SESSION_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const LEGACY_LOGIN_PAYLOAD_KEYS = Object.freeze([
  "version",
  "sub",
  "ip_hash",
  "issued_at",
  "expires_at"
]);
const LEGACY_ACCESS_CLAIM_KEYS = Object.freeze([
  "iss",
  "sub",
  "aud",
  "scope",
  "client_id",
  "token_use",
  "iat",
  "exp"
]);
const LEGACY_REFRESH_CLAIM_KEYS = Object.freeze([
  ...LEGACY_ACCESS_CLAIM_KEYS,
  "jti"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function assertString(value, name, maximum = MAX_CLAIM_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function assertSafeInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function masterKeyFromSecrets(secrets) {
  const secret = secrets?.jwtSecret;
  const length = typeof secret === "string" ? Buffer.byteLength(secret, "utf8") : 0;
  if (typeof secret !== "string" || length < 32 || length > MAX_SECRET_UTF8_BYTES) {
    throw new TypeError("OAuth JWT secret is invalid");
  }
  return Buffer.from(secret, "utf8");
}

function derivePurposeKey(masterKey, purpose) {
  return createHmac("sha256", masterKey)
    .update("cortex-oauth:derived-key:v2\0", "utf8")
    .update(purpose, "utf8")
    .digest();
}

function keyedDigest(key, value) {
  return new Uint8Array(createHmac("sha256", key).update(value).digest());
}

function equalBytes(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bytes(value, name, expectedLength) {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    throw new TypeError(`${name} is invalid`);
  }
  return Buffer.from(value);
}

function epochSeconds(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} is invalid`);
  }
  return Math.floor(value.getTime() / 1000);
}

function canonicalScopeString(scope) {
  return canonicalizeScopes(scope).join(" ");
}

function exactCanonicalScopeString(scope) {
  if (typeof scope !== "string") throw new TypeError("scope is invalid");
  const canonical = canonicalScopeString(scope);
  if (canonical !== scope) throw new TypeError("scope is not canonical");
  return canonical;
}

function canonicalLegacyScopeString(scope) {
  if (
    typeof scope !== "string" ||
    scope.length === 0 ||
    scope.length > MAX_CLAIM_LENGTH
  ) {
    throw new TypeError("legacy token scope is invalid");
  }
  return canonicalScopeString(scope);
}

function exactLegacyRefreshJti(value) {
  if (typeof value !== "string" || !LEGACY_REFRESH_JTI_PATTERN.test(value)) {
    throw new TypeError("legacy refresh JTI is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 18 || decoded.toString("base64url") !== value) {
    throw new TypeError("legacy refresh JTI is invalid");
  }
  return value;
}

function assertCompactJwt(token) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new TypeError("OAuth token is invalid");
  }
  return token;
}

function normalizeClientIp(value) {
  if (typeof value !== "string" || value.includes(",")) return null;

  let candidate = value.trim();
  if (candidate.startsWith("::ffff:") && isIP(candidate.slice(7)) === 4) {
    candidate = candidate.slice(7);
  }
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function validateGrant(grant, acceptedAudiences) {
  if (!isRecord(grant)) throw new TypeError("grant is required");
  const sid = assertString(grant.sid, "grant.sid", 36);
  if (!UUID_PATTERN.test(sid)) throw new TypeError("grant.sid is invalid");

  const principalId = assertString(grant.principalId, "grant.principalId", 36);
  if (!UUID_PATTERN.test(principalId)) throw new TypeError("grant.principalId is invalid");

  const bindingId = assertString(grant.bindingId, "grant.bindingId", 36);
  if (!UUID_PATTERN.test(bindingId)) throw new TypeError("grant.bindingId is invalid");

  const resource = assertString(grant.resource, "grant.resource", 2048);
  if (!acceptedAudiences.has(resource)) throw new TypeError("grant.resource is invalid");

  const scopes = canonicalizeScopes(grant.scopes);
  epochSeconds(grant.inactivityExpiresAt, "grant.inactivityExpiresAt");
  return Object.freeze({
    sid,
    principalId,
    subject: assertString(grant.subject, "grant.subject", 512),
    authenticationEpoch: assertSafeInteger(
      grant.authenticationEpoch,
      "grant.authenticationEpoch",
      0
    ),
    bindingId,
    bindingVersion: assertSafeInteger(grant.bindingVersion, "grant.bindingVersion", 1),
    agentId: assertSafeInteger(grant.agentId, "grant.agentId", 1),
    agentExternalId: assertString(grant.agentExternalId, "grant.agentExternalId", 64),
    clientId: assertString(grant.clientId, "grant.clientId", 512),
    resource,
    scopes,
    inactivityExpiresAt: grant.inactivityExpiresAt
  });
}

function refreshJti(key, sid, generation, nonce) {
  return createHmac("sha256", key)
    .update("cortex-oauth:refresh-jti:v2\0", "utf8")
    .update(sid, "utf8")
    .update("\0", "utf8")
    .update(String(generation), "utf8")
    .update("\0", "utf8")
    .update(nonce)
    .digest("base64url");
}

function fingerprintPayload(input) {
  if (!isRecord(input)) throw new TypeError("refresh fingerprint input is required");
  const clientId = assertString(input.clientId, "clientId", 512);
  const resource = assertString(input.resource, "resource", 2048);
  const scopes = canonicalizeScopes(input.scopes);
  return Buffer.from(
    JSON.stringify({ version: 2, client_id: clientId, resource, scopes }),
    "utf8"
  );
}

/**
 * Convert an OAuth scope string or array to the one database/JWT ordering.
 * Incoming duplicate whitespace or scope names are normalized here; signed
 * claims are separately required to already equal this canonical form.
 */
export function canonicalizeScopes(scope) {
  const values = typeof scope === "string"
    ? scope.split(/\s+/).filter(Boolean)
    : Array.isArray(scope)
      ? scope
      : null;

  if (!values || values.length === 0) throw new TypeError("scope is invalid");
  const unique = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !SUPPORTED_SCOPES.has(value)) {
      throw new TypeError("scope contains an unsupported value");
    }
    unique.add(value);
  }

  return Object.freeze(SCOPE_ORDER.filter((value) => unique.has(value)));
}

export function createPkceChallenge(verifier) {
  if (typeof verifier !== "string" || !PKCE_VERIFIER_PATTERN.test(verifier)) {
    throw new TypeError("PKCE verifier is invalid");
  }
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkceChallenge(verifier, expectedChallenge) {
  if (
    typeof expectedChallenge !== "string" ||
    !OPAQUE_32_BYTE_PATTERN.test(expectedChallenge)
  ) {
    return false;
  }

  let actual;
  try {
    actual = createPkceChallenge(verifier);
  } catch {
    return false;
  }
  return equalBytes(Buffer.from(actual, "ascii"), Buffer.from(expectedChallenge, "ascii"));
}

/**
 * Produce the keyed semantic fingerprint used by refresh rotation. The factory
 * exposes a bound one-argument form so callers do not handle key material.
 */
export function createRefreshRequestFingerprint(input, secrets) {
  const masterKey = masterKeyFromSecrets(secrets);
  const key = derivePurposeKey(masterKey, "refresh-request-fingerprint");
  return keyedDigest(key, fingerprintPayload(input));
}

/**
 * @param {{
 *   baseUrl:string, issuerUrl:string, resourceUrl:string,
 *   bootstrapSubject:string, accessTokenTtlSeconds:number,
 *   refreshTokenTtlSeconds:number, loginSessionTtlSeconds:number,
 *   acceptLegacyUntil:Date
 * }} config
 * @param {{jwtSecret:string}} secrets
 */
export function createOAuthCrypto(config, secrets) {
  if (!isRecord(config)) throw new TypeError("OAuth crypto config is required");
  const issuer = assertString(config.issuerUrl, "config.issuerUrl", 2048);
  const baseUrl = assertString(config.baseUrl, "config.baseUrl", 2048).replace(/\/+$/, "");
  const resourceUrl = assertString(config.resourceUrl, "config.resourceUrl", 2048);
  const accessTokenTtlSeconds = assertSafeInteger(
    config.accessTokenTtlSeconds,
    "config.accessTokenTtlSeconds",
    1
  );
  const refreshTokenTtlSeconds = assertSafeInteger(
    config.refreshTokenTtlSeconds,
    "config.refreshTokenTtlSeconds",
    1
  );
  const bootstrapSubject = assertString(
    config.bootstrapSubject,
    "config.bootstrapSubject",
    255
  );
  const loginSessionTtlSeconds = assertSafeInteger(
    config.loginSessionTtlSeconds,
    "config.loginSessionTtlSeconds",
    1
  );
  if (loginSessionTtlSeconds > MAX_LOGIN_SESSION_LIFETIME_SECONDS) {
    throw new TypeError("config.loginSessionTtlSeconds is invalid");
  }
  if (
    !(config.acceptLegacyUntil instanceof Date) ||
    !Number.isFinite(config.acceptLegacyUntil.getTime())
  ) {
    throw new TypeError("config.acceptLegacyUntil is invalid");
  }
  // Snapshot the mutable Date. Freezing a config object does not freeze the
  // Date's internal time value, and the compatibility deadline must not be
  // extendable after this verifier is constructed.
  const acceptLegacyUntilMilliseconds = config.acceptLegacyUntil.getTime();
  const acceptedAudiences = new Set([resourceUrl, baseUrl, `${baseUrl}/`]);
  const signingKey = masterKeyFromSecrets(secrets);
  const authorizationCodeKey = derivePurposeKey(signingKey, "authorization-code-digest");
  const loginCookieKey = derivePurposeKey(signingKey, "login-cookie-digest");
  const legacyLoginCookieKey = derivePurposeKey(signingKey, "legacy-login-cookie-digest");
  const refreshJtiKey = derivePurposeKey(signingKey, "refresh-jti");
  const refreshJtiDigestKey = derivePurposeKey(signingKey, "refresh-jti-digest");
  const legacyRefreshJtiDigestKey = derivePurposeKey(
    signingKey,
    "legacy-refresh-jti-digest"
  );
  const legacyTupleKey = derivePurposeKey(signingKey, "legacy-tuple-digest");
  const clientIpKey = derivePurposeKey(signingKey, "client-ip-fingerprint");
  const userAgentKey = derivePurposeKey(signingKey, "user-agent-fingerprint");
  const refreshFingerprintKey = derivePurposeKey(signingKey, "refresh-request-fingerprint");

  function digestOpaque(raw, name, key) {
    if (typeof raw !== "string" || !OPAQUE_32_BYTE_PATTERN.test(raw)) {
      throw new TypeError(`${name} is invalid`);
    }
    return keyedDigest(key, Buffer.from(raw, "ascii"));
  }

  function legacySessionHmac(purpose, value) {
    return createHmac("sha256", signingKey)
      .update(`cortex-oauth:${purpose}:v1\0`, "utf8")
      .update(value, "utf8")
      .digest();
  }

  function deriveRefreshMaterial(sid, generation, nonceValue) {
    if (typeof sid !== "string" || !UUID_PATTERN.test(sid)) {
      throw new TypeError("refresh sid is invalid");
    }
    assertSafeInteger(generation, "refresh generation", 0);
    const nonce = bytes(nonceValue, "refresh reconstruction nonce", 32);
    const jti = refreshJti(refreshJtiKey, sid, generation, nonce);
    return Object.freeze({
      nonce: new Uint8Array(nonce),
      jti,
      jtiDigest: keyedDigest(refreshJtiDigestKey, Buffer.from(jti, "ascii"))
    });
  }

  async function verifyV2Token(token, expectedUse, { allowExpired = false } = {}) {
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ) {
      throw new TypeError("OAuth token is invalid");
    }

    const requiredClaims = [
      "iss",
      "sub",
      "aud",
      "scope",
      "client_id",
      "token_use",
      "sid",
      "agent_id",
      "auth_epoch",
      "binding_version",
      "jti",
      "iat",
      "exp"
    ];
    if (expectedUse === "refresh") requiredClaims.push("generation");

    let currentDate;
    if (allowExpired) {
      // jwtVerify intentionally enforces expiry for normal bearer use. RFC
      // 7009 still permits an expired, correctly signed token to identify its
      // grant family, so verify it at its signed issue instant and retain every
      // other structural, issuer, audience, lifetime, and future-iat check.
      const untrusted = decodeJwt(token);
      if (
        !Number.isSafeInteger(untrusted.iat) ||
        untrusted.iat < 0 ||
        untrusted.iat > Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS
      ) {
        throw new TypeError("OAuth token issue time is invalid");
      }
      currentDate = new Date(untrusted.iat * 1000);
    }

    const { payload, protectedHeader } = await jwtVerify(token, signingKey, {
      algorithms: ["HS256"],
      issuer,
      audience: [...acceptedAudiences],
      requiredClaims,
      ...(currentDate ? { currentDate } : {})
    });

    const expectedType = expectedUse === "access" ? "JWT" : "refresh+jwt";
    if (protectedHeader.alg !== "HS256" || protectedHeader.typ !== expectedType) {
      throw new TypeError("OAuth token header is invalid");
    }
    if (payload.token_use !== expectedUse) {
      throw new TypeError("OAuth token use is invalid");
    }
    if (typeof payload.aud !== "string" || !acceptedAudiences.has(payload.aud)) {
      throw new TypeError("OAuth token audience is invalid");
    }

    assertString(payload.iss, "token.iss", 2048);
    assertString(payload.sub, "token.sub", 512);
    assertString(payload.client_id, "token.client_id", 512);
    assertString(payload.agent_id, "token.agent_id", 64);
    exactCanonicalScopeString(payload.scope);
    if (typeof payload.sid !== "string" || !UUID_PATTERN.test(payload.sid)) {
      throw new TypeError("OAuth token sid is invalid");
    }
    if (typeof payload.jti !== "string" || !OPAQUE_32_BYTE_PATTERN.test(payload.jti)) {
      throw new TypeError("OAuth token jti is invalid");
    }
    assertSafeInteger(payload.auth_epoch, "token.auth_epoch", 0);
    assertSafeInteger(payload.binding_version, "token.binding_version", 1);
    assertSafeInteger(payload.iat, "token.iat", 0);
    assertSafeInteger(payload.exp, "token.exp", 1);
    if (payload.exp <= payload.iat) throw new TypeError("OAuth token lifetime is invalid");
    if (payload.iat > Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS) {
      throw new TypeError("OAuth token issue time is invalid");
    }

    const maximumLifetime = expectedUse === "access"
      ? MAX_ACCESS_TOKEN_LIFETIME_SECONDS
      : MAX_REFRESH_TOKEN_LIFETIME_SECONDS;
    if (payload.exp - payload.iat > maximumLifetime) {
      throw new TypeError("OAuth token lifetime is invalid");
    }

    if (expectedUse === "access") {
      if (payload.generation !== undefined) {
        throw new TypeError("access token contains refresh claims");
      }
    } else {
      assertSafeInteger(payload.generation, "token.generation", 0);
    }

    return Object.freeze({ ...payload, legacy: false });
  }

  async function verifyLegacyToken(token, expectedUse) {
    if (
      Date.now() >= acceptLegacyUntilMilliseconds ||
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ) {
      throw new TypeError("Legacy OAuth token is invalid");
    }

    const requiredClaims = expectedUse === "access"
      ? LEGACY_ACCESS_CLAIM_KEYS
      : LEGACY_REFRESH_CLAIM_KEYS;
    const { payload, protectedHeader } = await jwtVerify(token, signingKey, {
      algorithms: ["HS256"],
      issuer,
      audience: [...acceptedAudiences],
      requiredClaims
    });
    if (Date.now() >= acceptLegacyUntilMilliseconds) {
      throw new TypeError("Legacy OAuth token is invalid");
    }
    const expectedType = expectedUse === "access" ? "JWT" : "refresh+jwt";
    if (
      !hasExactKeys(protectedHeader, ["alg", "typ"]) ||
      protectedHeader.alg !== "HS256" ||
      protectedHeader.typ !== expectedType ||
      !hasExactKeys(payload, requiredClaims) ||
      payload.token_use !== expectedUse ||
      payload.sub !== bootstrapSubject ||
      typeof payload.aud !== "string" ||
      !acceptedAudiences.has(payload.aud)
    ) {
      throw new TypeError("Legacy OAuth token shape is invalid");
    }

    assertString(payload.iss, "legacyToken.iss", 2048);
    assertString(payload.sub, "legacyToken.sub", 512);
    assertString(payload.client_id, "legacyToken.client_id", 512);
    const canonicalScope = canonicalLegacyScopeString(payload.scope);
    assertSafeInteger(payload.iat, "legacyToken.iat", 0);
    assertSafeInteger(payload.exp, "legacyToken.exp", 1);
    const current = Math.floor(Date.now() / 1_000);
    const expectedLifetime = expectedUse === "access"
      ? accessTokenTtlSeconds
      : refreshTokenTtlSeconds;
    if (
      payload.exp <= payload.iat ||
      payload.exp - payload.iat !== expectedLifetime ||
      payload.iat > current + CLOCK_SKEW_SECONDS
    ) {
      throw new TypeError("Legacy OAuth token lifetime is invalid");
    }
    if (expectedUse === "refresh") exactLegacyRefreshJti(payload.jti);

    return Object.freeze({
      ...payload,
      scope: canonicalScope,
      legacy: true
    });
  }

  const oauthCrypto = {
    createAuthorizationCode() {
      const raw = randomBytes(32).toString("base64url");
      return Object.freeze({ raw, digest: digestOpaque(raw, "authorization code", authorizationCodeKey) });
    },

    digestAuthorizationCode(raw) {
      return digestOpaque(raw, "authorization code", authorizationCodeKey);
    },

    createLoginCookie() {
      const raw = randomBytes(32).toString("base64url");
      return Object.freeze({ raw, digest: digestOpaque(raw, "login cookie", loginCookieKey) });
    },

    digestLoginCookie(raw) {
      return digestOpaque(raw, "login cookie", loginCookieKey);
    },

    verifyLegacyLoginCookie(cookie, ip) {
      try {
        if (
          typeof cookie !== "string" ||
          cookie.length === 0 ||
          cookie.length > MAX_LEGACY_LOGIN_COOKIE_LENGTH
        ) {
          return null;
        }

        const normalizedIp = normalizeClientIp(ip);
        if (normalizedIp === null || normalizedIp !== ip) return null;

        const parts = cookie.split(".");
        if (parts.length !== 2) return null;
        const [payloadPart, signaturePart] = parts;
        if (
          !/^[A-Za-z0-9_-]+$/.test(payloadPart) ||
          !OPAQUE_32_BYTE_PATTERN.test(signaturePart)
        ) {
          return null;
        }

        const signature = Buffer.from(signaturePart, "base64url");
        if (
          signature.byteLength !== 32 ||
          signature.toString("base64url") !== signaturePart ||
          !equalBytes(signature, legacySessionHmac("login-session", payloadPart))
        ) {
          return null;
        }

        const payloadBytes = Buffer.from(payloadPart, "base64url");
        if (
          payloadBytes.byteLength === 0 ||
          payloadBytes.toString("base64url") !== payloadPart
        ) {
          return null;
        }
        const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
        const payload = JSON.parse(payloadText);
        if (!isRecord(payload)) return null;

        const keys = Object.keys(payload);
        if (
          keys.length !== LEGACY_LOGIN_PAYLOAD_KEYS.length ||
          keys.some((key) => !LEGACY_LOGIN_PAYLOAD_KEYS.includes(key))
        ) {
          return null;
        }

        const canonicalPayload = Buffer.from(JSON.stringify({
          version: payload.version,
          sub: payload.sub,
          ip_hash: payload.ip_hash,
          issued_at: payload.issued_at,
          expires_at: payload.expires_at
        }), "utf8").toString("base64url");
        if (canonicalPayload !== payloadPart) return null;

        const current = Math.floor(Date.now() / 1000);
        if (
          payload.version !== 1 ||
          payload.sub !== bootstrapSubject ||
          typeof payload.ip_hash !== "string" ||
          !OPAQUE_32_BYTE_PATTERN.test(payload.ip_hash) ||
          !Number.isSafeInteger(payload.issued_at) ||
          !Number.isSafeInteger(payload.expires_at) ||
          payload.issued_at > current + CLOCK_SKEW_SECONDS ||
          payload.expires_at <= current ||
          payload.expires_at - payload.issued_at !== loginSessionTtlSeconds
        ) {
          return null;
        }

        const expectedIpHash = legacySessionHmac("client-ip", normalizedIp);
        const suppliedIpHash = Buffer.from(payload.ip_hash, "base64url");
        if (
          suppliedIpHash.byteLength !== 32 ||
          suppliedIpHash.toString("base64url") !== payload.ip_hash ||
          !equalBytes(suppliedIpHash, expectedIpHash)
        ) {
          return null;
        }

        return Object.freeze({
          subject: payload.sub,
          issuedAt: new Date(payload.issued_at * 1000),
          expiresAt: new Date(payload.expires_at * 1000),
          legacyCookieDigest: keyedDigest(
            legacyLoginCookieKey,
            Buffer.from(cookie, "ascii")
          )
        });
      } catch {
        return null;
      }
    },

    digestLegacyTuple(input) {
      if (!hasExactKeys(input, ["clientId", "resource", "subject"])) {
        throw new TypeError("legacy tuple is invalid");
      }
      const clientId = assertString(input.clientId, "legacyTuple.clientId", 512);
      const resource = assertString(input.resource, "legacyTuple.resource", 2048);
      const subject = assertString(input.subject, "legacyTuple.subject", 512);
      return keyedDigest(
        legacyTupleKey,
        Buffer.from(JSON.stringify({
          version: 2,
          issuer,
          subject,
          client_id: clientId,
          resource
        }))
      );
    },

    digestLegacyRefreshJti(jti) {
      const value = exactLegacyRefreshJti(jti);
      return keyedDigest(legacyRefreshJtiDigestKey, Buffer.from(value, "ascii"));
    },

    fingerprintClientIp(ip) {
      const value = assertString(ip, "client IP", 128);
      if (normalizeClientIp(value) !== value) {
        throw new TypeError("client IP is invalid");
      }
      return keyedDigest(clientIpKey, Buffer.from(value, "utf8"));
    },

    fingerprintUserAgent(userAgent) {
      const value = assertString(userAgent, "user agent", 2048);
      return keyedDigest(userAgentKey, Buffer.from(value, "utf8"));
    },

    createRefreshRequestFingerprint(input) {
      return keyedDigest(refreshFingerprintKey, fingerprintPayload(input));
    },

    digestRefreshJti(jti) {
      return digestOpaque(jti, "refresh JTI", refreshJtiDigestKey);
    },

    createRefreshMaterial(sid, generation) {
      return deriveRefreshMaterial(sid, generation, randomBytes(32));
    },

    createPkceChallenge,
    verifyPkceChallenge,

    async issueAccessToken(grantInput) {
      const grant = validateGrant(grantInput, acceptedAudiences);
      const issuedAt = Math.floor(Date.now() / 1000);
      const payload = {
        iss: issuer,
        sub: grant.subject,
        aud: grant.resource,
        scope: grant.scopes.join(" "),
        client_id: grant.clientId,
        token_use: "access",
        sid: grant.sid,
        agent_id: grant.agentExternalId,
        auth_epoch: grant.authenticationEpoch,
        binding_version: grant.bindingVersion,
        jti: randomBytes(32).toString("base64url"),
        iat: issuedAt,
        exp: issuedAt + accessTokenTtlSeconds
      };
      return await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .sign(signingKey);
    },

    async issueRefreshToken(descriptor) {
      if (!isRecord(descriptor)) throw new TypeError("refresh descriptor is required");
      const grant = validateGrant(descriptor.grant, acceptedAudiences);
      const generation = assertSafeInteger(descriptor.generation, "refresh generation", 0);
      const issuedAt = epochSeconds(descriptor.issuedAt, "refresh issuedAt");
      const expiresAt = epochSeconds(descriptor.expiresAt, "refresh expiresAt");
      if (
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > MAX_REFRESH_TOKEN_LIFETIME_SECONDS
      ) {
        throw new TypeError("refresh descriptor lifetime is invalid");
      }
      const material = deriveRefreshMaterial(
        grant.sid,
        generation,
        descriptor.reconstructionNonce
      );
      const payload = {
        iss: issuer,
        sub: grant.subject,
        aud: grant.resource,
        scope: grant.scopes.join(" "),
        client_id: grant.clientId,
        token_use: "refresh",
        sid: grant.sid,
        agent_id: grant.agentExternalId,
        auth_epoch: grant.authenticationEpoch,
        binding_version: grant.bindingVersion,
        generation,
        jti: material.jti,
        iat: issuedAt,
        exp: expiresAt
      };
      return await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", typ: "refresh+jwt" })
        .sign(signingKey);
    },

    async verifyAccessToken(token) {
      let candidate;
      try {
        assertCompactJwt(token);
        candidate = decodeJwt(token);
      } catch {
        throw new TypeError("OAuth token is invalid");
      }
      const v2OnlyClaims = [
        "sid",
        "agent_id",
        "auth_epoch",
        "binding_version",
        "generation"
      ];
      return v2OnlyClaims.some((claim) => Object.hasOwn(candidate, claim))
        ? await verifyV2Token(token, "access")
        : await verifyLegacyToken(token, "access");
    },

    async verifyRefreshToken(token) {
      let candidate;
      try {
        assertCompactJwt(token);
        candidate = decodeJwt(token);
      } catch {
        throw new TypeError("OAuth token is invalid");
      }
      const v2OnlyClaims = [
        "sid",
        "agent_id",
        "auth_epoch",
        "binding_version",
        "generation"
      ];
      return v2OnlyClaims.some((claim) => Object.hasOwn(candidate, claim))
        ? await verifyV2Token(token, "refresh")
        : await verifyLegacyToken(token, "refresh");
    },

    async verifyRevocationReference(token) {
      try {
        if (
          typeof token !== "string" ||
          token.length === 0 ||
          token.length > MAX_TOKEN_LENGTH ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
        ) {
          return null;
        }
        const candidate = decodeJwt(token);
        if (candidate.token_use !== "access" && candidate.token_use !== "refresh") {
          return null;
        }
        const claims = await verifyV2Token(token, candidate.token_use, {
          allowExpired: true
        });
        return Object.freeze({
          sid: claims.sid,
          clientId: claims.client_id,
          tokenUse: claims.token_use
        });
      } catch {
        // Revocation references are deliberately non-oracular. Callers learn
        // only whether a safe family reference can be passed to the store.
        return null;
      }
    }
  };

  return Object.freeze(oauthCrypto);
}
