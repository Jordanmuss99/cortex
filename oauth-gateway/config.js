import { isIP } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://cortex.obsidiannetwork.au";
const DEFAULT_MCP_TARGET = "http://cortex-mcp:8000";
const DEFAULT_REST_TARGET = "http://cortex:3100";
const DEFAULT_STATE_FILE = "/var/lib/cortex-oauth/state.json";

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_AUTH_CODE_TTL_SECONDS = 5 * 60;
const DEFAULT_LOGIN_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_REFRESH_RETRY_GRACE_SECONDS = 30;
const DEFAULT_LOGIN_ATTEMPT_LIMIT = 10;
const DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_REGISTRATION_ATTEMPT_LIMIT = 30;
const DEFAULT_REGISTRATION_ATTEMPT_WINDOW_SECONDS = 60 * 60;
const MAX_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAX_REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_AUTH_CODE_TTL_SECONDS = 60 * 60;
const MAX_LOGIN_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_REFRESH_RETRY_GRACE_SECONDS = 5 * 60;
const MAX_RATE_LIMIT_ATTEMPTS = 10_000;
const MAX_RATE_LIMIT_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_LEGACY_WINDOW_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
const OAUTH_GATEWAY_LOGIN_ROLE = "cortex_oauth_gateway";
const ALLOWED_DATABASE_SSL_MODES = new Set(["verify-full"]);
const MAX_SECRET_UTF8_BYTES = 4096;
const STATIC_CLIENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "LINEAR",
    defaultClientId: "linear-cortex",
    defaultRedirectUri: "https://linear.app/connect/mcp/callback",
    clientName: "Linear"
  }),
  Object.freeze({
    key: "NOTION",
    defaultClientId: "notion-cortex",
    defaultRedirectUri: "https://app.notion.com/workflows/mcp/oauth/callback",
    clientName: "Notion"
  })
]);

function requiredString(env, name, maxLength) {
  const value = typeof env[name] === "string" ? env[name].trim() : "";
  if (!value || value.length > maxLength) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function optionalString(env, name, fallback, maxLength) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }

  const value = String(raw).trim();
  if (value.length > maxLength) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(env, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }

  if (!/^[1-9][0-9]*$/.test(String(raw).trim())) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function absoluteUrl(env, name, fallback, protocols) {
  const raw = optionalString(env, name, fallback, 4096);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }

  if (
    !protocols.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /[?#]/.test(raw) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(`${name} must be an absolute URL`);
  }

  return parsed.toString().replace(/\/$/, "");
}

function assertSecurePublicUrl(value, name) {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(host);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new TypeError(`${name} must use HTTPS outside loopback development`);
  }
}

function databaseUrl(env) {
  const raw = requiredString(env, "MCP_OAUTH_DATABASE_URL", 4096);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("MCP_OAUTH_DATABASE_URL must be a PostgreSQL URL");
  }

  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new TypeError("MCP_OAUTH_DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    raw.includes("#") ||
    (raw.includes("?") && parsed.search !== "?sslmode=verify-full")
  ) {
    throw new TypeError("MCP_OAUTH_DATABASE_URL contains unsupported URL parameters");
  }
  for (const [key, value] of parsed.searchParams) {
    if (
      key !== "sslmode" ||
      parsed.searchParams.getAll(key).length !== 1 ||
      !ALLOWED_DATABASE_SSL_MODES.has(value)
    ) {
      throw new TypeError("MCP_OAUTH_DATABASE_URL contains unsupported URL parameters");
    }
  }
  let username;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new TypeError("MCP_OAUTH_DATABASE_URL must use the gateway login role");
  }
  if (username !== OAUTH_GATEWAY_LOGIN_ROLE) {
    throw new TypeError("MCP_OAUTH_DATABASE_URL must use the gateway login role");
  }
  let database;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new TypeError("MCP_OAUTH_DATABASE_URL must include gateway credentials and database");
  }
  if (!parsed.password || !database || database.includes("/")) {
    throw new TypeError("MCP_OAUTH_DATABASE_URL must include gateway credentials and database");
  }
  return raw;
}

function legacyDeadline(env) {
  const raw = requiredString(env, "MCP_OAUTH_ACCEPT_LEGACY_UNTIL", 128);
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) {
    throw new TypeError(
      "MCP_OAUTH_ACCEPT_LEGACY_UNTIL must be an ISO-8601 timestamp with a timezone"
    );
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction = "", offset] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText
  ].map(Number);
  const millisecond = Number(`${fraction.slice(1)}00`.slice(0, 3));
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  const validComponents =
    month >= 1 && month <= 12 &&
    day >= 1 && day <= 31 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second &&
    calendar.getUTCMilliseconds() === millisecond;
  const value = new Date(raw);
  if (!validComponents || !Number.isFinite(value.getTime())) {
    throw new TypeError(
      "MCP_OAUTH_ACCEPT_LEGACY_UNTIL must be an ISO-8601 timestamp with a timezone"
    );
  }
  const now = Date.now();
  if (
    value.getTime() > now &&
    value.getTime() - now > MAX_LEGACY_WINDOW_MILLISECONDS
  ) {
    throw new TypeError("MCP_OAUTH_ACCEPT_LEGACY_UNTIL exceeds the maximum rollout window");
  }
  return value;
}

function trustedProxyCidrs(env) {
  const value = optionalString(env, "MCP_OAUTH_TRUSTED_PROXY_CIDRS", "", 8192);
  const cidrs = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const cidr of cidrs) {
    const separator = cidr.lastIndexOf("/");
    const address = separator === -1 ? "" : cidr.slice(0, separator);
    const prefixText = separator === -1 ? "" : cidr.slice(separator + 1);
    const version = isIP(address);
    const maximumPrefix = version === 4 ? 32 : 128;
    if (
      !version ||
      !/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText) ||
      Number(prefixText) > maximumPrefix
    ) {
      throw new TypeError("MCP_OAUTH_TRUSTED_PROXY_CIDRS contains an invalid CIDR");
    }
  }

  return Object.freeze(cidrs);
}

function staticRedirectUris(env, definition) {
  const raw = optionalString(
    env,
    `${definition.key}_OAUTH_REDIRECT_URI`,
    definition.defaultRedirectUri,
    10_240
  );
  const values = raw.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  if (values.length < 1 || values.length > 5 || new Set(values).size !== values.length) {
    throw new TypeError(`${definition.key}_OAUTH_REDIRECT_URI is invalid`);
  }
  for (const value of values) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new TypeError(`${definition.key}_OAUTH_REDIRECT_URI is invalid`);
    }
    if (
      value.length > 2048 ||
      /[?#]/.test(value) ||
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      value !== `${parsed.origin}${parsed.pathname}`
    ) {
      throw new TypeError(`${definition.key}_OAUTH_REDIRECT_URI is invalid`);
    }
  }
  return Object.freeze(values);
}

/**
 * Load static-client descriptors while keeping their optional secrets only in
 * a constant-time verifier closure. The database receives metadata, never the
 * configured secret bytes.
 */
export function loadStaticClientConfiguration(env = process.env) {
  const clients = [];
  const secretDigests = new Map();
  for (const definition of STATIC_CLIENT_DEFINITIONS) {
    const clientId = optionalString(
      env,
      `${definition.key}_OAUTH_CLIENT_ID`,
      definition.defaultClientId,
      512
    );
    if (clientId !== clientId.trim()) {
      throw new TypeError(`${definition.key}_OAUTH_CLIENT_ID is invalid`);
    }
    const rawSecret = env[`${definition.key}_OAUTH_CLIENT_SECRET`] ?? "";
    if (
      typeof rawSecret !== "string" ||
      Buffer.byteLength(rawSecret, "utf8") > MAX_SECRET_UTF8_BYTES
    ) {
      throw new TypeError(`${definition.key}_OAUTH_CLIENT_SECRET is invalid`);
    }
    const client = Object.freeze({
      clientId,
      redirectUris: staticRedirectUris(env, definition),
      clientName: definition.clientName,
      tokenEndpointAuthMethod: rawSecret.length === 0 ? "none" : "client_secret_basic"
    });
    clients.push(client);
    if (rawSecret.length > 0) secretDigests.set(clientId, stringDigest(rawSecret));
  }
  if (new Set(clients.map((client) => client.clientId)).size !== clients.length) {
    throw new TypeError("Static OAuth client IDs must be unique");
  }

  const dummyDigest = stringDigest("cortex-oauth-static-client-dummy");
  const verifyClientSecret = Object.freeze((clientId, candidateSecret) => {
    const expected = secretDigests.get(clientId) ?? dummyDigest;
    const candidate = typeof candidateSecret === "string" &&
      Buffer.byteLength(candidateSecret, "utf8") <= MAX_SECRET_UTF8_BYTES
      ? candidateSecret
      : "";
    const matches = timingSafeEqual(stringDigest(candidate), expected);
    return secretDigests.has(clientId) && matches;
  });

  return Object.freeze({
    clients: Object.freeze(clients),
    verifyClientSecret
  });
}

/**
 * Load the final-shaped gateway configuration without mutating the provided
 * environment object. Secret values are never included in validation errors.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 */
export function loadGatewayConfig(env = process.env) {
  const baseUrl = absoluteUrl(
    env,
    "BASE_URL",
    DEFAULT_BASE_URL,
    new Set(["http:", "https:"])
  );
  const issuerUrl = absoluteUrl(
    env,
    "ISSUER_URL",
    baseUrl,
    new Set(["http:", "https:"])
  );
  const resourceUrl = absoluteUrl(
    env,
    "RESOURCE_URL",
    `${baseUrl}/mcp`,
    new Set(["http:", "https:"])
  );
  assertSecurePublicUrl(baseUrl, "BASE_URL");
  assertSecurePublicUrl(issuerUrl, "ISSUER_URL");
  assertSecurePublicUrl(resourceUrl, "RESOURCE_URL");
  const trustedIpHeader = optionalString(
    env,
    "MCP_OAUTH_TRUSTED_IP_HEADER",
    "",
    256
  ).toLowerCase();
  const trustedProxyCidrsValue = trustedProxyCidrs(env);

  if (trustedIpHeader && !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(trustedIpHeader)) {
    throw new TypeError("MCP_OAUTH_TRUSTED_IP_HEADER must be an HTTP header name");
  }
  if (trustedIpHeader && trustedProxyCidrsValue.length === 0) {
    throw new TypeError(
      "MCP_OAUTH_TRUSTED_PROXY_CIDRS is required when a trusted IP header is configured"
    );
  }

  const config = {
    port: positiveInteger(env, "PORT", 8080, 65535),
    baseUrl,
    issuerUrl,
    resourceUrl,
    mcpTarget: absoluteUrl(
      env,
      "MCP_TARGET",
      DEFAULT_MCP_TARGET,
      new Set(["http:", "https:"])
    ),
    restTarget: absoluteUrl(
      env,
      "REST_TARGET",
      DEFAULT_REST_TARGET,
      new Set(["http:", "https:"])
    ),
    databaseUrl: databaseUrl(env),
    bootstrapSubject: requiredString(env, "MCP_OAUTH_USERNAME", 255),
    bootstrapAgentExternalId: requiredString(env, "MCP_OAUTH_AGENT_ID", 64),
    accessTokenTtlSeconds: positiveInteger(
      env,
      "MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      MAX_ACCESS_TOKEN_TTL_SECONDS
    ),
    refreshTokenTtlSeconds: positiveInteger(
      env,
      "MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
      MAX_REFRESH_TOKEN_TTL_SECONDS
    ),
    authCodeTtlSeconds: positiveInteger(
      env,
      "MCP_OAUTH_AUTH_CODE_TTL_SECONDS",
      DEFAULT_AUTH_CODE_TTL_SECONDS,
      MAX_AUTH_CODE_TTL_SECONDS
    ),
    loginSessionTtlSeconds: positiveInteger(
      env,
      "MCP_OAUTH_LOGIN_SESSION_TTL_SECONDS",
      DEFAULT_LOGIN_SESSION_TTL_SECONDS,
      MAX_LOGIN_SESSION_TTL_SECONDS
    ),
    refreshRetryGraceSeconds: positiveInteger(
      env,
      "MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS",
      DEFAULT_REFRESH_RETRY_GRACE_SECONDS,
      MAX_REFRESH_RETRY_GRACE_SECONDS
    ),
    loginAttemptLimit: positiveInteger(
      env,
      "MCP_OAUTH_LOGIN_ATTEMPT_LIMIT",
      DEFAULT_LOGIN_ATTEMPT_LIMIT,
      MAX_RATE_LIMIT_ATTEMPTS
    ),
    loginAttemptWindowSeconds: positiveInteger(
      env,
      "MCP_OAUTH_LOGIN_ATTEMPT_WINDOW_SECONDS",
      DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS,
      MAX_RATE_LIMIT_WINDOW_SECONDS
    ),
    registrationAttemptLimit: positiveInteger(
      env,
      "MCP_OAUTH_REGISTRATION_ATTEMPT_LIMIT",
      DEFAULT_REGISTRATION_ATTEMPT_LIMIT,
      MAX_RATE_LIMIT_ATTEMPTS
    ),
    registrationAttemptWindowSeconds: positiveInteger(
      env,
      "MCP_OAUTH_REGISTRATION_ATTEMPT_WINDOW_SECONDS",
      DEFAULT_REGISTRATION_ATTEMPT_WINDOW_SECONDS,
      MAX_RATE_LIMIT_WINDOW_SECONDS
    ),
    acceptLegacyUntil: legacyDeadline(env),
    legacyStateFile: optionalString(
      env,
      "MCP_OAUTH_STATE_FILE",
      DEFAULT_STATE_FILE,
      4096
    ),
    trustedIpHeader,
    trustedProxyCidrs: trustedProxyCidrsValue
  };

  return Object.freeze(config);
}

function untrimmedSecret(env, name, minimumBytes) {
  const value = env[name];
  const length = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;

  if (typeof value !== "string" || length < minimumBytes || length > MAX_SECRET_UTF8_BYTES) {
    throw new TypeError(`${name} is required and has an invalid UTF-8 byte length`);
  }

  return value;
}

/**
 * Load secret material separately from ordinary gateway configuration. Values
 * are deliberately neither trimmed nor normalized: changing even one byte
 * would invalidate existing JWTs and browser credentials.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} env
 * @returns {Readonly<{jwtSecret:string,browserPassword:string}>}
 */
export function loadGatewaySecrets(env = process.env) {
  const secrets = Object.create(null);
  Object.defineProperties(secrets, {
    jwtSecret: {
      value: untrimmedSecret(env, "MCP_OAUTH_JWT_SECRET", 32),
      enumerable: false
    },
    browserPassword: {
      value: untrimmedSecret(env, "MCP_OAUTH_PASSWORD", 1),
      enumerable: false
    }
  });
  return Object.freeze(secrets);
}

function stringDigest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Create the credential predicate used by the browser authorization form.
 * Both comparisons always run so neither the username nor password result is
 * exposed through a short-circuit timing difference.
 *
 * @param {string} subject
 * @param {{browserPassword:string}} secrets
 */
export function createBrowserCredentialVerifier(subject, secrets) {
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 512) {
    throw new TypeError("subject is required");
  }
  if (
    !secrets ||
    typeof secrets !== "object" ||
    typeof secrets.browserPassword !== "string" ||
    Buffer.byteLength(secrets.browserPassword, "utf8") < 1 ||
    Buffer.byteLength(secrets.browserPassword, "utf8") > MAX_SECRET_UTF8_BYTES
  ) {
    throw new TypeError("browser credentials are invalid");
  }

  const expectedSubjectDigest = stringDigest(subject);
  const expectedPasswordDigest = stringDigest(secrets.browserPassword);

  return Object.freeze(function verifyBrowserCredentials(username, password) {
    const candidateSubject =
      typeof username === "string" && Buffer.byteLength(username, "utf8") <= 512
        ? username
        : "";
    const candidatePassword =
      typeof password === "string" &&
      Buffer.byteLength(password, "utf8") <= MAX_SECRET_UTF8_BYTES
        ? password
        : "";
    const subjectMatches = timingSafeEqual(
      stringDigest(candidateSubject),
      expectedSubjectDigest
    );
    const passwordMatches = timingSafeEqual(
      stringDigest(candidatePassword),
      expectedPasswordDigest
    );
    return Boolean(subjectMatches & passwordMatches);
  });
}
