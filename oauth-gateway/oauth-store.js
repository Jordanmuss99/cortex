import postgres from "postgres";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { sanitizeSecurityMetadata } from "./security-log.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATION_ID_PATTERN = /^\d{3}_[a-z0-9][a-z0-9_]*$/;
const SUPPORTED_SCOPES = new Set(["cortex:read", "cortex:write", "mcp"]);
const EXPECTED_BOOTSTRAP_SCOPES = Object.freeze([
  "cortex:read",
  "cortex:write",
  "mcp"
]);
const OAUTH_GATEWAY_LOGIN_ROLE = "cortex_oauth_gateway";
const ALLOWED_DATABASE_SSL_MODES = new Set(["verify-full"]);
const MAX_DYNAMIC_CLIENTS = 1_000;
const MAX_LEGACY_AUTHORIZATION_CODES = 1_000;
const MAX_LOGIN_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_REFRESH_RETRY_GRACE_SECONDS = 5 * 60;
const MAX_PRUNE_BATCH_SIZE = 1_000;
const DEFAULT_MAINTENANCE_TIMEOUT_MILLISECONDS = 5_000;
const REFRESH_REPLAY_REVOKED_REASON = "refresh_replay_detected";
const CLIENT_TOKEN_REVOKED_REASON = "client_token_revocation";
const LEGACY_LOGIN_CLOCK_SKEW_MILLISECONDS = 60 * 1_000;
const LEGACY_TOKEN_CLOCK_SKEW_MILLISECONDS = 60 * 1_000;
const DYNAMIC_CLIENT_REGISTRATION_LOCK = 4_412_021_148_517_443n;
const LEGACY_STATE_IMPORT_LOCK = 4_412_021_148_517_444n;
export const LEGACY_STATE_IMPORT_VERSION = "legacy-oauth-state-v1";
export const FRESH_INSTALL_SHA256 = createHash("sha256")
  .update("cortex-oauth:fresh-install:v1", "utf8")
  .digest("hex");
const LEGACY_DYNAMIC_CLIENT_ID_PATTERN = /^chatgpt-[A-Za-z0-9_-]{24}$/;
const CHATGPT_STABLE_REDIRECT =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_CONNECTOR_REDIRECT_PATTERN =
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

export const OAUTH_DATABASE_OBJECTS = Object.freeze({
  migrationLedger: "cortex_schema_migrations",
  principals: "oauth_principals",
  bindings: "oauth_agent_bindings",
  clients: "oauth_clients",
  authorizationCodes: "oauth_authorization_codes",
  grants: "oauth_grants",
  refreshTokens: "oauth_refresh_tokens",
  loginSessions: "oauth_login_sessions",
  auditEvents: "oauth_audit_events",
  stateMigrations: "oauth_state_migrations",
  agents: "agents"
});

const REQUIRED_RELATIONS = Object.freeze(Object.values(OAUTH_DATABASE_OBJECTS));

function isNonEmptyString(value, maxLength = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function databaseAuthority(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TypeError("databaseUrl must be a PostgreSQL gateway URL");
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    databaseUrl.includes("#") ||
    (databaseUrl.includes("?") && parsed.search !== "?sslmode=verify-full")
  ) {
    throw new TypeError("databaseUrl must be a PostgreSQL gateway URL");
  }
  for (const [key, value] of parsed.searchParams) {
    if (
      key !== "sslmode" ||
      parsed.searchParams.getAll(key).length !== 1 ||
      !ALLOWED_DATABASE_SSL_MODES.has(value)
    ) {
      throw new TypeError("databaseUrl contains unsupported URL parameters");
    }
  }

  let username;
  let database;
  try {
    username = decodeURIComponent(parsed.username);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new TypeError("databaseUrl must be a PostgreSQL gateway URL");
  }
  if (
    username !== OAUTH_GATEWAY_LOGIN_ROLE ||
    !parsed.password ||
    !database ||
    database.includes("/")
  ) {
    throw new TypeError("databaseUrl must use the fixed gateway login and database");
  }
  return Object.freeze({ username, database });
}

export function postgresTlsOptions(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".").map(Number);
  const isPrivateIpv4 =
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet)) &&
    (octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (!host.includes(".") && !host.includes(":")) ||
    isPrivateIpv4 ||
    (isIP(host) === 6 && /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host));
  return !isPrivate && !parsed.searchParams.has("sslmode")
    ? Object.freeze({ ssl: "verify-full" })
    : Object.freeze({});
}

function assertOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("OAuth store options are required");
  }
  if (!isNonEmptyString(options.databaseUrl)) {
    throw new TypeError("databaseUrl is required");
  }
  if (options.sql !== undefined) {
    throw new TypeError("custom SQL connections are not supported by the OAuth store");
  }
  if (
    options.maintenanceTimeoutMilliseconds !== undefined &&
    (!Number.isSafeInteger(options.maintenanceTimeoutMilliseconds) ||
      options.maintenanceTimeoutMilliseconds < 1)
  ) {
    throw new TypeError("maintenanceTimeoutMilliseconds must be a positive integer");
  }
  if (
    !options.requiredMigration ||
    !isNonEmptyString(options.requiredMigration.id, 255) ||
    !MIGRATION_ID_PATTERN.test(options.requiredMigration.id) ||
    !SHA256_PATTERN.test(options.requiredMigration.sha256)
  ) {
    throw new TypeError("requiredMigration must contain an id and lowercase SHA-256");
  }
  const additionalMigrations = options.requiredMigration.additionalMigrations ?? [];
  if (
    !Array.isArray(additionalMigrations) ||
    additionalMigrations.length > 16 ||
    additionalMigrations.some((migration) =>
      !migration ||
      typeof migration !== "object" ||
      !isNonEmptyString(migration.id, 255) ||
      !MIGRATION_ID_PATTERN.test(migration.id) ||
      !SHA256_PATTERN.test(migration.sha256)
    )
  ) {
    throw new TypeError("additional required migrations must contain ids and lowercase SHA-256 values");
  }
  const migrationIds = [
    options.requiredMigration.id,
    ...additionalMigrations.map((migration) => migration.id)
  ];
  if (
    new Set(migrationIds).size !== migrationIds.length ||
    migrationIds.some((id, index) => index > 0 && id.localeCompare(migrationIds[index - 1]) <= 0)
  ) {
    throw new TypeError("required migrations must be unique and strictly ordered");
  }
  if (
    !options.bootstrap ||
    !isNonEmptyString(options.bootstrap.issuer) ||
    !canonicalResourceUrl(options.bootstrap.issuer) ||
    !isNonEmptyString(options.bootstrap.subject, 255) ||
    !isNonEmptyString(options.bootstrap.agentExternalId, 64)
  ) {
    throw new TypeError("bootstrap issuer, subject, and agentExternalId are required");
  }
  if (!isNonEmptyString(options.baseUrl) || !canonicalResourceUrl(options.baseUrl)) {
    throw new TypeError("baseUrl must be a canonical absolute HTTP(S) URL");
  }
  if (options.acceptLegacyUntil !== undefined && (
    !(options.acceptLegacyUntil instanceof Date) ||
    !Number.isFinite(options.acceptLegacyUntil.getTime())
  )) {
    throw new TypeError("acceptLegacyUntil must be a valid Date");
  }
  if (options.expectedLegacyState !== undefined && (
    !hasExactKeys(options.expectedLegacyState, [
      "sourceChecksum",
      "clientCount",
      "codeCount"
    ]) ||
    !isByteArray(options.expectedLegacyState.sourceChecksum) ||
    !Number.isSafeInteger(options.expectedLegacyState.clientCount) ||
    options.expectedLegacyState.clientCount < 0 ||
    options.expectedLegacyState.clientCount > MAX_DYNAMIC_CLIENTS ||
    !Number.isSafeInteger(options.expectedLegacyState.codeCount) ||
    options.expectedLegacyState.codeCount < 0 ||
    options.expectedLegacyState.codeCount > MAX_LEGACY_AUTHORIZATION_CODES
  )) {
    throw new TypeError("expectedLegacyState must contain a digest and bounded counts");
  }
  if (
    options.freshInstall !== undefined &&
    typeof options.freshInstall !== "boolean"
  ) {
    throw new TypeError("freshInstall must be a boolean");
  }
  if (options.freshInstall === true && options.expectedLegacyState !== undefined) {
    throw new TypeError("freshInstall and expectedLegacyState are mutually exclusive");
  }
  const resourceUrl = options.resourceUrl ??
    `${options.baseUrl.replace(/\/+$/, "")}/mcp`;
  if (!canonicalResourceUrl(resourceUrl)) {
    throw new TypeError("resourceUrl must be a canonical absolute HTTP(S) URL");
  }
}

function normalizeScopes(value) {
  const scopes = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/).filter(Boolean)
      : null;
  if (!scopes || scopes.length === 0) return null;

  const unique = new Set();
  for (const scope of scopes) {
    if (typeof scope !== "string" || !SUPPORTED_SCOPES.has(scope) || unique.has(scope)) {
      return null;
    }
    unique.add(scope);
  }
  return [...unique].sort();
}

function sameScopes(left, right) {
  const normalizedLeft = normalizeScopes(left);
  const normalizedRight = normalizeScopes(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((scope, index) => scope === normalizedRight[index])
  );
}

function isByteArray(value, length = 32) {
  return (
    (Buffer.isBuffer(value) || value instanceof Uint8Array) &&
    value.byteLength === length
  );
}

function sameBytes(left, right) {
  if (!isByteArray(left) || !isByteArray(right)) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function optionalFingerprint(value) {
  return value === undefined || value === null || isByteArray(value);
}

function validRequestId(value) {
  return (
    isNonEmptyString(value, 128) &&
    value === value.trim()
  );
}

function validPruneReport(value) {
  return Boolean(
    hasExactKeys(value, [
      "audit_event_count",
      "authorization_code_count",
      "grant_count",
      "login_session_count",
      "refresh_token_count",
    ]) &&
    Object.values(value).every(
      (count) => Number.isSafeInteger(count) && count >= 0 && count <= MAX_PRUNE_BATCH_SIZE
    )
  );
}

function normalizeSecurityEventInput(input) {
  const isOptionalUuid = (value) =>
    value === null || (typeof value === "string" && UUID_PATTERN.test(value));
  if (
    !hasExactKeys(input, [
      "eventType",
      "outcome",
      "principalId",
      "bindingId",
      "grantId",
      "requestId",
      "actorType",
      "metadata",
    ]) ||
    input.eventType !== "agent_mismatch" ||
    input.outcome !== "rejected" ||
    input.actorType !== "connector" ||
    typeof input.requestId !== "string" ||
    !UUID_PATTERN.test(input.requestId) ||
    !isOptionalUuid(input.principalId) ||
    !isOptionalUuid(input.bindingId) ||
    !isOptionalUuid(input.grantId)
  ) {
    return null;
  }
  const metadata = sanitizeSecurityMetadata(input.eventType, input.metadata);
  if (metadata.surface !== "rest" && metadata.surface !== "mcp") return null;
  if (input.grantId === null && (input.principalId === null || input.bindingId === null)) {
    return null;
  }
  return Object.freeze({
    eventType: input.eventType,
    outcome: input.outcome,
    principalId: input.grantId === null ? input.principalId : null,
    bindingId: input.grantId === null ? input.bindingId : null,
    grantId: input.grantId,
    requestId: input.requestId,
    actorType: input.actorType,
    metadata,
  });
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function normalizeClientName(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "ChatGPT";
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 200 ? normalized : null;
}

function validChatGptRedirect(uri) {
  if (
    !isNonEmptyString(uri, 2048) ||
    uri !== uri.trim() ||
    /[?#]/.test(uri)
  ) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "chatgpt.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    uri !== `${parsed.origin}${parsed.pathname}`
  ) {
    return false;
  }

  return (
    uri === CHATGPT_STABLE_REDIRECT ||
    CHATGPT_CONNECTOR_REDIRECT_PATTERN.test(uri)
  );
}

function isImportedLegacyDynamicClient(row) {
  return Boolean(
    row &&
    row.client_kind === "dynamic" &&
    row.client_status === "active" &&
    row.token_endpoint_auth_method === "none" &&
    LEGACY_DYNAMIC_CLIENT_ID_PATTERN.test(row.client_id) &&
    normalizeDynamicRedirects(row.redirect_uris) &&
    isValidDate(row.client_created_at) &&
    isValidDate(row.legacy_import_completed_at) &&
    row.client_created_at <= row.legacy_import_completed_at
  );
}

function normalizeDynamicRedirects(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 5 ||
    value.some((uri) => !validChatGptRedirect(uri)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value];
}

function normalizeStaticClient(input) {
  if (
    !hasExactKeys(input, [
      "clientId",
      "redirectUris",
      "clientName",
      "tokenEndpointAuthMethod"
    ]) ||
    !isNonEmptyString(input.clientId, 512) ||
    input.clientId !== input.clientId.trim() ||
    !isNonEmptyString(input.clientName, 200) ||
    input.clientName !== input.clientName.trim() ||
    !new Set(["none", "client_secret_basic", "client_secret_post"])
      .has(input.tokenEndpointAuthMethod) ||
    !Array.isArray(input.redirectUris) ||
    input.redirectUris.length < 1 ||
    input.redirectUris.length > 5 ||
    new Set(input.redirectUris).size !== input.redirectUris.length
  ) {
    return null;
  }
  const redirectUris = [];
  for (const value of input.redirectUris) {
    if (!validCanonicalHttpsRedirect(value)) return null;
    redirectUris.push(value);
  }
  return Object.freeze({
    clientId: input.clientId,
    redirectUris: Object.freeze(redirectUris),
    clientName: input.clientName,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod
  });
}

function validCanonicalHttpsRedirect(value) {
  if (!isNonEmptyString(value, 2048) || value !== value.trim() || /[?#]/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      value === `${parsed.origin}${parsed.pathname}`
    );
  } catch {
    return false;
  }
}

function validLegacyClientName(value) {
  return (
    isNonEmptyString(value, 200) &&
    value === value.trim()
  );
}

function legacyImportInput(input, allowedResources, expectedSubject) {
  if (
    !hasExactKeys(input, [
      "sourceVersion",
      "sourceChecksum",
      "clients",
      "codes",
      "requestId"
    ]) ||
    input.sourceVersion !== 1 ||
    !isByteArray(input.sourceChecksum) ||
    !Array.isArray(input.clients) ||
    input.clients.length > MAX_DYNAMIC_CLIENTS ||
    !Array.isArray(input.codes) ||
    input.codes.length > MAX_LEGACY_AUTHORIZATION_CODES ||
    !validRequestId(input.requestId)
  ) {
    return null;
  }

  const clientsById = new Map();
  const clients = [];
  for (const client of input.clients) {
    if (
      !hasExactKeys(client, [
        "clientId",
        "redirectUris",
        "clientName",
        "createdAt"
      ]) ||
      !isNonEmptyString(client.clientId, 512) ||
      !LEGACY_DYNAMIC_CLIENT_ID_PATTERN.test(client.clientId) ||
      clientsById.has(client.clientId) ||
      !normalizeDynamicRedirects(client.redirectUris) ||
      !validLegacyClientName(client.clientName) ||
      !isValidDate(client.createdAt) ||
      client.createdAt.getTime() <= 0 ||
      client.createdAt.getTime() % 1_000 !== 0
    ) {
      return null;
    }
    const normalizedClient = Object.freeze({
      clientId: client.clientId,
      redirectUris: Object.freeze([...client.redirectUris]),
      clientName: client.clientName,
      createdAt: new Date(client.createdAt.getTime())
    });
    clientsById.set(client.clientId, normalizedClient);
    clients.push(normalizedClient);
  }

  const codeDigests = new Set();
  const codes = [];
  for (const code of input.codes) {
    const normalizedScopes = normalizeScopes(code?.scopes);
    const digestKey = isByteArray(code?.codeDigest)
      ? Buffer.from(code.codeDigest).toString("hex")
      : null;
    if (
      !hasExactKeys(code, [
        "codeDigest",
        "clientId",
        "redirectUri",
        "scopes",
        "codeChallenge",
        "resource",
        "subject",
        "expiresAt"
      ]) ||
      !digestKey ||
      codeDigests.has(digestKey) ||
      !isNonEmptyString(code.clientId, 512) ||
      code.clientId !== code.clientId.trim() ||
      !validCanonicalHttpsRedirect(code.redirectUri) ||
      (
        LEGACY_DYNAMIC_CLIENT_ID_PATTERN.test(code.clientId) &&
        (
          !clientsById.has(code.clientId) ||
          !validChatGptRedirect(code.redirectUri) ||
          !clientsById.get(code.clientId).redirectUris.includes(code.redirectUri)
        )
      ) ||
      !normalizedScopes ||
      !Array.isArray(code.scopes) ||
      normalizedScopes.length !== code.scopes.length ||
      !normalizedScopes.every((scope, index) => scope === code.scopes[index]) ||
      !isNonEmptyString(code.codeChallenge, 43) ||
      !/^[A-Za-z0-9_-]{43}$/.test(code.codeChallenge) ||
      !allowedResources.has(code.resource) ||
      code.subject !== expectedSubject ||
      !isValidDate(code.expiresAt)
    ) {
      return null;
    }
    codeDigests.add(digestKey);
    codes.push(Object.freeze({
      codeDigest: Buffer.from(code.codeDigest),
      clientId: code.clientId,
      redirectUri: code.redirectUri,
      scopes: Object.freeze(normalizedScopes),
      codeChallenge: code.codeChallenge,
      resource: code.resource,
      subject: code.subject,
      expiresAt: new Date(code.expiresAt.getTime())
    }));
  }

  return Object.freeze({
    sourceVersion: 1,
    sourceChecksum: Buffer.from(input.sourceChecksum),
    clients: Object.freeze(clients),
    codes: Object.freeze(codes),
    requestId: input.requestId
  });
}

function validLegacyImportReport(value) {
  return Boolean(
    hasExactKeys(value, [
      "clientsImported",
      "clientsExisting",
      "codesImported",
      "codesExpired"
    ]) &&
    Object.values(value).every(
      (count) => Number.isSafeInteger(count) && count >= 0
    )
  );
}

function legacyImportResult(kind, report) {
  const stableReport = Object.freeze({
    clientsImported: report.clientsImported,
    clientsExisting: report.clientsExisting,
    codesImported: report.codesImported,
    codesExpired: report.codesExpired
  });
  return Object.freeze({
    kind,
    version: LEGACY_STATE_IMPORT_VERSION,
    report: stableReport
  });
}

function sameTimestamp(left, right) {
  return (
    left instanceof Date &&
    right instanceof Date &&
    left.getTime() === right.getTime()
  );
}

function sameStringArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function canonicalResourceUrl(value) {
  if (
    !isNonEmptyString(value, 2048) ||
    value !== value.trim() ||
    /[?#]/.test(value)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString().replace(/\/$/, "") !== value.replace(/\/$/, "")
  ) {
    return null;
  }
  return value.replace(/\/$/, "");
}

function mapClient(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    clientId: row.client_id,
    clientKind: row.client_kind,
    redirectUris: Object.freeze([...row.redirect_uris]),
    clientName: row.client_name,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapBoundPrincipal(row) {
  const scopes = normalizeScopes(row?.allowed_scopes);
  if (!row || !scopes) return null;
  return Object.freeze({
    principalId: row.principal_id,
    subject: row.subject,
    authenticationEpoch: row.authentication_epoch,
    bindingId: row.binding_id,
    bindingVersion: row.binding_version,
    agentId: row.agent_id,
    agentExternalId: row.agent_external_id,
    allowedScopes: Object.freeze(scopes)
  });
}

function normalizeBoundPrincipal(value, expectedSubject, expectedAgentExternalId) {
  const allowedScopes = normalizeScopes(value?.allowedScopes);
  if (
    !hasExactKeys(value, [
      "principalId",
      "subject",
      "authenticationEpoch",
      "bindingId",
      "bindingVersion",
      "agentId",
      "agentExternalId",
      "allowedScopes"
    ]) ||
    !isNonEmptyString(value.principalId, 64) ||
    !UUID_PATTERN.test(value.principalId) ||
    value.subject !== expectedSubject ||
    !Number.isSafeInteger(value.authenticationEpoch) ||
    value.authenticationEpoch < 0 ||
    !isNonEmptyString(value.bindingId, 64) ||
    !UUID_PATTERN.test(value.bindingId) ||
    !Number.isSafeInteger(value.bindingVersion) ||
    value.bindingVersion < 1 ||
    !Number.isSafeInteger(value.agentId) ||
    value.agentId < 1 ||
    value.agentExternalId !== expectedAgentExternalId ||
    !Array.isArray(value.allowedScopes) ||
    !allowedScopes ||
    !sameStringArray(value.allowedScopes, allowedScopes)
  ) {
    return null;
  }
  return Object.freeze({
    principalId: value.principalId,
    subject: value.subject,
    authenticationEpoch: value.authenticationEpoch,
    bindingId: value.bindingId,
    bindingVersion: value.bindingVersion,
    agentId: value.agentId,
    agentExternalId: value.agentExternalId,
    allowedScopes: Object.freeze(allowedScopes)
  });
}

function mapLoginSession(row) {
  const context = mapBoundPrincipal(row);
  if (
    !context ||
    !isValidDate(row?.issued_at) ||
    !isValidDate(row?.expires_at) ||
    row.expires_at <= row.issued_at
  ) {
    return null;
  }
  return Object.freeze({
    context,
    issuedAt: new Date(row.issued_at.getTime()),
    expiresAt: new Date(row.expires_at.getTime())
  });
}

function createLoginSessionInput(input) {
  if (
    !hasExactKeys(input, [
      "sessionDigest",
      "ipFingerprint",
      "ttlSeconds",
      "requestId",
      "userAgentFingerprint"
    ]) ||
    !isByteArray(input.sessionDigest) ||
    !isByteArray(input.ipFingerprint) ||
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > MAX_LOGIN_SESSION_TTL_SECONDS ||
    !validRequestId(input.requestId) ||
    (input.userAgentFingerprint !== null &&
      !isByteArray(input.userAgentFingerprint))
  ) {
    return null;
  }
  return Object.freeze({
    sessionDigest: Buffer.from(input.sessionDigest),
    ipFingerprint: Buffer.from(input.ipFingerprint),
    ttlSeconds: input.ttlSeconds,
    requestId: input.requestId,
    userAgentFingerprint: input.userAgentFingerprint === null
      ? null
      : Buffer.from(input.userAgentFingerprint)
  });
}

function resolveLoginSessionInput(input) {
  if (
    !hasExactKeys(input, ["sessionDigest", "ipFingerprint"]) ||
    !isByteArray(input.sessionDigest) ||
    !isByteArray(input.ipFingerprint)
  ) {
    return null;
  }
  return Object.freeze({
    sessionDigest: Buffer.from(input.sessionDigest),
    ipFingerprint: Buffer.from(input.ipFingerprint)
  });
}

function upgradeLegacyLoginSessionInput(input) {
  if (
    !hasExactKeys(input, [
      "legacyCookieDigest",
      "legacySubject",
      "legacyIssuedAt",
      "legacyExpiresAt",
      "sessionDigest",
      "ipFingerprint",
      "requestId",
      "userAgentFingerprint"
    ]) ||
    !isByteArray(input.legacyCookieDigest) ||
    !isNonEmptyString(input.legacySubject, 512) ||
    input.legacySubject !== input.legacySubject.trim() ||
    !isValidDate(input.legacyIssuedAt) ||
    input.legacyIssuedAt.getTime() <= 0 ||
    input.legacyIssuedAt.getTime() % 1_000 !== 0 ||
    !isValidDate(input.legacyExpiresAt) ||
    input.legacyExpiresAt.getTime() % 1_000 !== 0 ||
    input.legacyExpiresAt <= input.legacyIssuedAt ||
    input.legacyExpiresAt.getTime() - input.legacyIssuedAt.getTime() >
      MAX_LOGIN_SESSION_TTL_SECONDS * 1_000 ||
    !isByteArray(input.sessionDigest) ||
    !isByteArray(input.ipFingerprint) ||
    !validRequestId(input.requestId) ||
    (input.userAgentFingerprint !== null &&
      !isByteArray(input.userAgentFingerprint))
  ) {
    return null;
  }
  return Object.freeze({
    legacyCookieDigest: Buffer.from(input.legacyCookieDigest),
    legacySubject: input.legacySubject,
    legacyIssuedAt: new Date(input.legacyIssuedAt.getTime()),
    legacyExpiresAt: new Date(input.legacyExpiresAt.getTime()),
    sessionDigest: Buffer.from(input.sessionDigest),
    ipFingerprint: Buffer.from(input.ipFingerprint),
    requestId: input.requestId,
    userAgentFingerprint: input.userAgentFingerprint === null
      ? null
      : Buffer.from(input.userAgentFingerprint)
  });
}

const INVALID_LOGIN_SESSION_DECISION = Object.freeze({ kind: "invalid" });
const ALREADY_UPGRADED_LOGIN_SESSION_DECISION = Object.freeze({
  kind: "already_upgraded"
});

function activeLoginSessionDecision(session) {
  return Object.freeze({ kind: "active", session });
}

function upgradedLoginSessionDecision(session) {
  return Object.freeze({ kind: "upgraded", session });
}

function mapGrantSnapshot(row) {
  const scopes = normalizeScopes(row?.scopes);
  if (!row || !scopes || !isValidDate(row.inactivity_expires_at)) return null;
  return Object.freeze({
    sid: row.sid,
    principalId: row.principal_id,
    subject: row.subject,
    authenticationEpoch: row.authentication_epoch,
    bindingId: row.binding_id,
    bindingVersion: row.binding_version,
    agentId: row.agent_id,
    agentExternalId: row.agent_external_id,
    clientId: row.client_id,
    resource: row.resource,
    scopes: Object.freeze(scopes),
    inactivityExpiresAt: new Date(row.inactivity_expires_at.getTime())
  });
}

function authorizationInput(
  input,
  allowedResources,
  expectedSubject,
  expectedAgentExternalId
) {
  const scopes = normalizeScopes(input?.scopes);
  const authenticatedContext = normalizeBoundPrincipal(
    input?.authenticatedContext,
    expectedSubject,
    expectedAgentExternalId
  );
  if (
    !hasExactKeys(input, [
      "authenticatedContext",
      "codeDigest",
      "clientId",
      "redirectUri",
      "scopes",
      "codeChallenge",
      "resource",
      "expiresAt",
      "requestId",
      "ipFingerprint",
      "userAgentFingerprint"
    ]) ||
    !isByteArray(input.codeDigest) ||
    !authenticatedContext ||
    !isNonEmptyString(input.clientId, 512) ||
    !isNonEmptyString(input.redirectUri, 2048) ||
    input.redirectUri !== input.redirectUri.trim() ||
    !scopes ||
    !isNonEmptyString(input.codeChallenge, 43) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
    !allowedResources.has(input.resource) ||
    !isValidDate(input.expiresAt) ||
    !validRequestId(input.requestId) ||
    !optionalFingerprint(input.ipFingerprint) ||
    !optionalFingerprint(input.userAgentFingerprint)
  ) {
    return null;
  }
  return { ...input, authenticatedContext, scopes };
}

function exchangeInput(input) {
  const scopes = input?.scopes === undefined || input?.scopes === null
    ? null
    : normalizeScopes(input.scopes);
  const resource = input?.resource === undefined || input?.resource === null
    ? null
    : input.resource;
  const refresh = input?.refresh;
  const tokenEndpointAuthMethod = input?.tokenEndpointAuthMethod ?? "none";
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isByteArray(input.codeDigest) ||
    !isNonEmptyString(input.clientId, 512) ||
    !new Set(["none", "client_secret_basic", "client_secret_post"])
      .has(tokenEndpointAuthMethod) ||
    !isNonEmptyString(input.redirectUri, 2048) ||
    input.redirectUri !== input.redirectUri.trim() ||
    (input.scopes !== undefined && input.scopes !== null && !scopes) ||
    (resource !== null && (
      !isNonEmptyString(resource, 2048) || resource !== resource.trim()
    )) ||
    !isNonEmptyString(input.codeChallenge, 43) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
    !isNonEmptyString(input.grantId, 64) ||
    !UUID_PATTERN.test(input.grantId) ||
    !isValidDate(input.inactivityExpiresAt) ||
    !refresh ||
    typeof refresh !== "object" ||
    Array.isArray(refresh) ||
    refresh.generation !== 0 ||
    !isByteArray(refresh.jtiDigest) ||
    !isByteArray(refresh.reconstructionNonce) ||
    !isValidDate(refresh.issuedAt) ||
    !isValidDate(refresh.expiresAt) ||
    refresh.expiresAt <= refresh.issuedAt ||
    !validRequestId(input.requestId) ||
    !optionalFingerprint(input.ipFingerprint) ||
    !optionalFingerprint(input.userAgentFingerprint)
  ) {
    return null;
  }
  return { ...input, resource, scopes, refresh, tokenEndpointAuthMethod };
}

function rotateRefreshInput(input, expectedIssuer, allowedResources) {
  if (!hasExactKeys(input, [
    "token",
    "presentedJtiDigest",
    "clientId",
    "resource",
    "effectiveScopes",
    "requestFingerprint",
    "replacement",
    "refreshTokenTtlSeconds",
    "retryGraceSeconds",
    "requestId",
    "ipFingerprint",
    "userAgentFingerprint"
  ])) {
    return null;
  }

  const token = input.token;
  const replacement = input.replacement;
  const tokenScopes = normalizeScopes(token?.scopes);
  const effectiveScopes = normalizeScopes(input.effectiveScopes);
  if (
    !hasExactKeys(token, [
      "issuer",
      "subject",
      "resource",
      "scopes",
      "clientId",
      "sid",
      "agentExternalId",
      "authenticationEpoch",
      "bindingVersion",
      "generation",
      "issuedAt",
      "expiresAt"
    ]) ||
    !hasExactKeys(replacement, [
      "generation",
      "jtiDigest",
      "reconstructionNonce"
    ]) ||
    token.issuer !== expectedIssuer ||
    !isNonEmptyString(token.subject, 512) ||
    token.subject !== token.subject.trim() ||
    !allowedResources.has(token.resource) ||
    !tokenScopes ||
    !Array.isArray(token.scopes) ||
    token.scopes.length !== tokenScopes.length ||
    !token.scopes.every((scope, index) => scope === tokenScopes[index]) ||
    !isNonEmptyString(token.clientId, 512) ||
    token.clientId !== token.clientId.trim() ||
    !isNonEmptyString(token.sid, 64) ||
    !UUID_PATTERN.test(token.sid) ||
    !isNonEmptyString(token.agentExternalId, 64) ||
    token.agentExternalId !== token.agentExternalId.trim() ||
    !Number.isSafeInteger(token.authenticationEpoch) ||
    token.authenticationEpoch < 0 ||
    !Number.isSafeInteger(token.bindingVersion) ||
    token.bindingVersion < 1 ||
    !Number.isSafeInteger(token.generation) ||
    token.generation < 0 ||
    token.generation >= Number.MAX_SAFE_INTEGER ||
    !isValidDate(token.issuedAt) ||
    token.issuedAt.getTime() < 0 ||
    token.issuedAt.getTime() % 1_000 !== 0 ||
    !isValidDate(token.expiresAt) ||
    token.expiresAt.getTime() % 1_000 !== 0 ||
    token.expiresAt <= token.issuedAt ||
    token.expiresAt.getTime() - token.issuedAt.getTime() >
      MAX_REFRESH_TOKEN_TTL_SECONDS * 1_000 ||
    !isByteArray(input.presentedJtiDigest) ||
    !isNonEmptyString(input.clientId, 512) ||
    input.clientId !== input.clientId.trim() ||
    !allowedResources.has(input.resource) ||
    !effectiveScopes ||
    !Array.isArray(input.effectiveScopes) ||
    input.effectiveScopes.length !== effectiveScopes.length ||
    !input.effectiveScopes.every(
      (scope, index) => scope === effectiveScopes[index]
    ) ||
    !effectiveScopes.every((scope) => tokenScopes.includes(scope)) ||
    !isByteArray(input.requestFingerprint) ||
    replacement.generation !== token.generation + 1 ||
    !isByteArray(replacement.jtiDigest) ||
    !isByteArray(replacement.reconstructionNonce) ||
    !Number.isSafeInteger(input.refreshTokenTtlSeconds) ||
    input.refreshTokenTtlSeconds < 1 ||
    input.refreshTokenTtlSeconds > MAX_REFRESH_TOKEN_TTL_SECONDS ||
    !Number.isSafeInteger(input.retryGraceSeconds) ||
    input.retryGraceSeconds < 1 ||
    input.retryGraceSeconds > MAX_REFRESH_RETRY_GRACE_SECONDS ||
    !validRequestId(input.requestId) ||
    !optionalFingerprint(input.ipFingerprint) ||
    !optionalFingerprint(input.userAgentFingerprint)
  ) {
    return null;
  }

  return Object.freeze({
    token: Object.freeze({
      ...token,
      scopes: Object.freeze(tokenScopes),
      issuedAt: new Date(token.issuedAt.getTime()),
      expiresAt: new Date(token.expiresAt.getTime())
    }),
    presentedJtiDigest: Buffer.from(input.presentedJtiDigest),
    clientId: input.clientId,
    resource: input.resource,
    effectiveScopes: Object.freeze(effectiveScopes),
    requestFingerprint: Buffer.from(input.requestFingerprint),
    replacement: Object.freeze({
      generation: replacement.generation,
      jtiDigest: Buffer.from(replacement.jtiDigest),
      reconstructionNonce: Buffer.from(replacement.reconstructionNonce)
    }),
    refreshTokenTtlSeconds: input.refreshTokenTtlSeconds,
    retryGraceSeconds: input.retryGraceSeconds,
    requestId: input.requestId,
    ipFingerprint: input.ipFingerprint == null
      ? null
      : Buffer.from(input.ipFingerprint),
    userAgentFingerprint: input.userAgentFingerprint == null
      ? null
      : Buffer.from(input.userAgentFingerprint)
  });
}

function migrateLegacyRefreshInput(input, expectedIssuer, allowedResources) {
  if (!hasExactKeys(input, [
    "token",
    "presentedJtiDigest",
    "legacyTupleDigest",
    "clientId",
    "resource",
    "effectiveScopes",
    "requestFingerprint",
    "grantId",
    "replacement",
    "refreshTokenTtlSeconds",
    "retryGraceSeconds",
    "requestId",
    "ipFingerprint",
    "userAgentFingerprint"
  ])) {
    return null;
  }

  const token = input.token;
  const replacement = input.replacement;
  const tokenScopes = normalizeScopes(token?.scopes);
  const effectiveScopes = normalizeScopes(input.effectiveScopes);
  if (
    !hasExactKeys(token, [
      "issuer",
      "subject",
      "resource",
      "scopes",
      "clientId",
      "issuedAt",
      "expiresAt"
    ]) ||
    !hasExactKeys(replacement, [
      "generation",
      "jtiDigest",
      "reconstructionNonce"
    ]) ||
    token.issuer !== expectedIssuer ||
    !isNonEmptyString(token.subject, 512) ||
    token.subject !== token.subject.trim() ||
    !allowedResources.has(token.resource) ||
    !tokenScopes ||
    !Array.isArray(token.scopes) ||
    token.scopes.length !== tokenScopes.length ||
    !token.scopes.every((scope, index) => scope === tokenScopes[index]) ||
    !isNonEmptyString(token.clientId, 512) ||
    token.clientId !== token.clientId.trim() ||
    !isValidDate(token.issuedAt) ||
    token.issuedAt.getTime() < 0 ||
    token.issuedAt.getTime() % 1_000 !== 0 ||
    !isValidDate(token.expiresAt) ||
    token.expiresAt.getTime() % 1_000 !== 0 ||
    token.expiresAt <= token.issuedAt ||
    token.expiresAt.getTime() - token.issuedAt.getTime() >
      MAX_REFRESH_TOKEN_TTL_SECONDS * 1_000 ||
    !isByteArray(input.presentedJtiDigest) ||
    !isByteArray(input.legacyTupleDigest) ||
    !isNonEmptyString(input.clientId, 512) ||
    input.clientId !== input.clientId.trim() ||
    !allowedResources.has(input.resource) ||
    !effectiveScopes ||
    !Array.isArray(input.effectiveScopes) ||
    input.effectiveScopes.length !== effectiveScopes.length ||
    !input.effectiveScopes.every(
      (scope, index) => scope === effectiveScopes[index]
    ) ||
    !effectiveScopes.every((scope) => tokenScopes.includes(scope)) ||
    !isByteArray(input.requestFingerprint) ||
    !isNonEmptyString(input.grantId, 64) ||
    !UUID_PATTERN.test(input.grantId) ||
    replacement.generation !== 0 ||
    !isByteArray(replacement.jtiDigest) ||
    !isByteArray(replacement.reconstructionNonce) ||
    !Number.isSafeInteger(input.refreshTokenTtlSeconds) ||
    input.refreshTokenTtlSeconds < 1 ||
    input.refreshTokenTtlSeconds > MAX_REFRESH_TOKEN_TTL_SECONDS ||
    !Number.isSafeInteger(input.retryGraceSeconds) ||
    input.retryGraceSeconds < 1 ||
    input.retryGraceSeconds > MAX_REFRESH_RETRY_GRACE_SECONDS ||
    !validRequestId(input.requestId) ||
    !optionalFingerprint(input.ipFingerprint) ||
    !optionalFingerprint(input.userAgentFingerprint)
  ) {
    return null;
  }

  const legacyTupleDigest = Buffer.from(input.legacyTupleDigest);
  return Object.freeze({
    token: Object.freeze({
      ...token,
      scopes: Object.freeze(tokenScopes),
      issuedAt: new Date(token.issuedAt.getTime()),
      expiresAt: new Date(token.expiresAt.getTime())
    }),
    presentedJtiDigest: Buffer.from(input.presentedJtiDigest),
    legacyTupleDigest,
    clientId: input.clientId,
    resource: input.resource,
    effectiveScopes: Object.freeze(effectiveScopes),
    requestFingerprint: Buffer.from(input.requestFingerprint),
    grantId: input.grantId,
    replacement: Object.freeze({
      generation: 0,
      jtiDigest: Buffer.from(replacement.jtiDigest),
      reconstructionNonce: Buffer.from(replacement.reconstructionNonce)
    }),
    refreshTokenTtlSeconds: input.refreshTokenTtlSeconds,
    retryGraceSeconds: input.retryGraceSeconds,
    requestId: input.requestId,
    ipFingerprint: input.ipFingerprint == null
      ? null
      : Buffer.from(input.ipFingerprint),
    userAgentFingerprint: input.userAgentFingerprint == null
      ? null
      : Buffer.from(input.userAgentFingerprint)
  });
}

function revokeTokenInput(input) {
  const reference = input?.reference;
  if (
    !hasExactKeys(input, [
      "reference",
      "clientId",
      "requestId",
      "ipFingerprint",
      "userAgentFingerprint"
    ]) ||
    !hasExactKeys(reference, ["sid", "clientId", "tokenUse"]) ||
    !isNonEmptyString(reference.sid, 64) ||
    !UUID_PATTERN.test(reference.sid) ||
    !isNonEmptyString(reference.clientId, 512) ||
    reference.clientId !== reference.clientId.trim() ||
    !new Set(["access", "refresh"]).has(reference.tokenUse) ||
    !isNonEmptyString(input.clientId, 512) ||
    input.clientId !== input.clientId.trim() ||
    !validRequestId(input.requestId) ||
    !optionalFingerprint(input.ipFingerprint) ||
    !optionalFingerprint(input.userAgentFingerprint)
  ) {
    return null;
  }

  return Object.freeze({
    reference: Object.freeze({
      sid: reference.sid,
      clientId: reference.clientId,
      tokenUse: reference.tokenUse
    }),
    clientId: input.clientId,
    requestId: input.requestId,
    ipFingerprint: input.ipFingerprint == null
      ? null
      : Buffer.from(input.ipFingerprint),
    userAgentFingerprint: input.userAgentFingerprint == null
      ? null
      : Buffer.from(input.userAgentFingerprint)
  });
}

function epochSeconds(date) {
  return Math.floor(date.getTime() / 1_000);
}

function refreshGrantClaimsAgree(token, row) {
  const allowedScopes = normalizeScopes(row.allowed_scopes);
  const grantScopes = normalizeScopes(row.grant_scopes);
  if (!allowedScopes || !grantScopes) return false;
  if (!grantScopes.every((scope) => allowedScopes.includes(scope))) return false;
  if (!token.scopes.every((scope) => grantScopes.includes(scope))) return false;

  return token.sid === row.sid &&
    token.issuer === row.issuer &&
    token.subject === row.subject &&
    token.resource === row.resource &&
    token.clientId === row.client_id &&
    token.agentExternalId === row.agent_external_id &&
    token.authenticationEpoch === row.grant_authentication_epoch &&
    token.authenticationEpoch === row.principal_authentication_epoch &&
    token.bindingVersion === row.grant_binding_version &&
    token.bindingVersion === row.current_binding_version;
}

function presentedRefreshRowAgrees(input, row) {
  return row.kind === "v2" &&
    row.generation === input.token.generation &&
    sameBytes(row.jti_digest, input.presentedJtiDigest) &&
    sameScopes(row.effective_scopes, input.token.scopes) &&
    epochSeconds(row.issued_at) === epochSeconds(input.token.issuedAt) &&
    epochSeconds(row.expires_at) === epochSeconds(input.token.expiresAt);
}

function legacyRefreshGrantClaimsAgree(input, row) {
  const allowedScopes = normalizeScopes(row.allowed_scopes);
  const grantScopes = normalizeScopes(row.grant_scopes);
  if (!allowedScopes || !grantScopes) return false;
  if (!grantScopes.every((scope) => allowedScopes.includes(scope))) return false;
  if (!input.token.scopes.every((scope) => grantScopes.includes(scope))) return false;

  return input.token.issuer === row.issuer &&
    input.token.subject === row.subject &&
    input.token.resource === row.resource &&
    input.token.clientId === row.client_id &&
    row.grant_authentication_epoch === row.principal_authentication_epoch &&
    row.grant_binding_version === row.current_binding_version;
}

function legacyPresentedRefreshRowAgrees(input, row) {
  return row.kind === "legacy" &&
    row.generation === -1 &&
    sameBytes(row.jti_digest, input.presentedJtiDigest) &&
    sameScopes(row.effective_scopes, input.token.scopes) &&
    epochSeconds(row.issued_at) === epochSeconds(input.token.issuedAt) &&
    epochSeconds(row.expires_at) === epochSeconds(input.token.expiresAt);
}

function mapRefreshGrant(row, scopes, inactivityExpiresAt) {
  return mapGrantSnapshot({
    sid: row.sid,
    principal_id: row.principal_id,
    subject: row.subject,
    authentication_epoch: row.principal_authentication_epoch,
    binding_id: row.binding_id,
    binding_version: row.current_binding_version,
    agent_id: row.agent_id,
    agent_external_id: row.agent_external_id,
    client_id: row.client_id,
    resource: row.resource,
    scopes,
    inactivity_expires_at: inactivityExpiresAt
  });
}

function mapRefreshDescriptor(grant, row) {
  if (
    !grant ||
    row?.kind !== "v2" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 0 ||
    !isByteArray(row.reconstruction_nonce) ||
    !isValidDate(row.issued_at) ||
    !isValidDate(row.expires_at) ||
    row.expires_at <= row.issued_at
  ) {
    return null;
  }
  return Object.freeze({
    grant,
    generation: row.generation,
    reconstructionNonce: new Uint8Array(row.reconstruction_nonce),
    issuedAt: new Date(row.issued_at.getTime()),
    expiresAt: new Date(row.expires_at.getTime())
  });
}

async function revokeRefreshFamilyForReplay(
  transaction,
  { input, currentGeneration, operationNow, replayReason }
) {
  const revokedRows = await transaction`
    UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}
    SET status = 'revoked',
        revoked_at = ${operationNow},
        revoked_reason = ${REFRESH_REPLAY_REVOKED_REASON},
        updated_at = ${operationNow}
    WHERE id = ${input.token.sid}
      AND status = 'active'
      AND current_refresh_generation = ${currentGeneration}
    RETURNING id
  `;
  if (revokedRows.length !== 1) {
    throw new Error("OAuth refresh replay lost its family lock");
  }

  // Keep every descriptor for forensic family history, but make all still-live
  // generations unusable in the same transaction as the grant revocation.
  // The GREATEST guard preserves the table's expires_at > issued_at invariant
  // if a descriptor timestamp is marginally ahead of the database wall clock.
  await transaction`
    UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)}
    SET expires_at = GREATEST(
      issued_at + INTERVAL '1 microsecond',
      LEAST(expires_at, ${operationNow})
    )
    WHERE grant_id = ${input.token.sid}
      AND expires_at > ${operationNow}
  `;

  // Replay auditing remains grant-only. Parent FKs would reverse the
  // client/principal-to-grant order used by authorization and operator paths.
  await transaction`
    INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
      id,
      event_type,
      outcome,
      grant_id,
      request_id,
      actor_type,
      ip_fingerprint,
      user_agent_fingerprint,
      metadata,
      created_at
    ) VALUES (
      ${randomUUID()},
      'refresh_replay',
      'revoked',
      ${input.token.sid},
      ${input.requestId},
      'connector',
      ${input.ipFingerprint},
      ${input.userAgentFingerprint},
      ${transaction.json(sanitizeSecurityMetadata("refresh_replay", {
        reason: replayReason,
        presented_generation: input.token.generation,
        current_generation: currentGeneration
      }))},
      ${operationNow}
    )
  `;

  return Object.freeze({ kind: "replay", sid: input.token.sid });
}

async function revokeLegacyRefreshFamilyForReplay(
  transaction,
  { input, sid, currentGeneration, operationNow, replayReason }
) {
  const revokedRows = await transaction`
    UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}
    SET status = 'revoked',
        revoked_at = ${operationNow},
        revoked_reason = ${REFRESH_REPLAY_REVOKED_REASON},
        updated_at = ${operationNow}
    WHERE id = ${sid}
      AND status = 'active'
      AND current_refresh_generation = ${currentGeneration}
    RETURNING id
  `;
  if (revokedRows.length !== 1) {
    throw new Error("OAuth legacy refresh replay lost its family lock");
  }

  await transaction`
    UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)}
    SET expires_at = GREATEST(
      issued_at + INTERVAL '1 microsecond',
      LEAST(expires_at, ${operationNow})
    )
    WHERE grant_id = ${sid}
      AND expires_at > ${operationNow}
  `;
  await transaction`
    INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
      id,
      event_type,
      outcome,
      grant_id,
      request_id,
      actor_type,
      ip_fingerprint,
      user_agent_fingerprint,
      metadata,
      created_at
    ) VALUES (
      ${randomUUID()},
      'refresh_replay',
      'revoked',
      ${sid},
      ${input.requestId},
      'connector',
      ${input.ipFingerprint},
      ${input.userAgentFingerprint},
      ${transaction.json(sanitizeSecurityMetadata("refresh_replay", {
        reason: replayReason,
        presented_generation: -1,
        current_generation: currentGeneration
      }))},
      ${operationNow}
    )
  `;
  return Object.freeze({ kind: "replay", sid });
}

function validAccessClaims(claims, expectedIssuer, allowedResources) {
  return Boolean(
    claims &&
    typeof claims === "object" &&
    !Array.isArray(claims) &&
    claims.legacy !== true &&
    claims.token_use === "access" &&
    isNonEmptyString(claims.sid, 64) &&
    UUID_PATTERN.test(claims.sid) &&
    isNonEmptyString(claims.iss) &&
    claims.iss === expectedIssuer &&
    isNonEmptyString(claims.sub, 255) &&
    isNonEmptyString(claims.aud) &&
    allowedResources.has(claims.aud) &&
    isNonEmptyString(claims.client_id, 512) &&
    isNonEmptyString(claims.agent_id, 64) &&
    isNonEmptyString(claims.jti, 512) &&
    /^[A-Za-z0-9_-]+$/.test(claims.jti) &&
    normalizeScopes(claims.scope) &&
    Number.isSafeInteger(claims.auth_epoch) &&
    claims.auth_epoch >= 0 &&
    Number.isSafeInteger(claims.binding_version) &&
    claims.binding_version >= 1 &&
    Number.isSafeInteger(claims.iat) &&
    claims.iat >= 0 &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > claims.iat
  );
}

function validLegacyAccessClaims(claims, expectedIssuer, allowedResources) {
  const scopes = normalizeScopes(claims?.scope);
  return Boolean(
    hasExactKeys(claims, [
      "iss",
      "sub",
      "aud",
      "scope",
      "client_id",
      "token_use",
      "iat",
      "exp",
      "legacy"
    ]) &&
    claims.legacy === true &&
    claims.token_use === "access" &&
    claims.iss === expectedIssuer &&
    isNonEmptyString(claims.sub, 255) &&
    claims.sub === claims.sub.trim() &&
    isNonEmptyString(claims.aud) &&
    allowedResources.has(claims.aud) &&
    isNonEmptyString(claims.client_id, 512) &&
    claims.client_id === claims.client_id.trim() &&
    scopes &&
    claims.scope === scopes.join(" ") &&
    Number.isSafeInteger(claims.iat) &&
    claims.iat >= 0 &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > claims.iat
  );
}

function readinessFailure(fields, reason) {
  return Object.freeze({
    ready: false,
    database: fields.database === true,
    schema: fields.schema === true,
    bootstrap: fields.bootstrap === true,
    legacyImport: fields.legacyImport === true,
    reason
  });
}

function inactiveDecision(row) {
  if (row.grant_status === "expired" || row.is_expired === true) {
    return { kind: "expired" };
  }
  if (
    row.grant_status !== "active" ||
    row.principal_status !== "active" ||
    row.binding_status !== "active" ||
    row.client_status !== "active"
  ) {
    return { kind: "revoked" };
  }
  return null;
}

function claimsAgreeWithRow(claims, row) {
  const grantScopesAllowed = normalizeScopes(row.allowed_scopes);
  const grantScopes = normalizeScopes(row.scopes);
  const claimScopes = normalizeScopes(claims.scope);
  if (!grantScopesAllowed || !grantScopes || !claimScopes) return false;
  if (!grantScopes.every((scope) => grantScopesAllowed.includes(scope))) return false;
  if (!claimScopes.every((scope) => grantScopes.includes(scope))) return false;
  if (claims.scope !== claimScopes.join(" ")) return false;

  return (
    claims.sid === row.sid &&
    claims.iss === row.issuer &&
    claims.sub === row.subject &&
    claims.aud === row.resource &&
    claims.client_id === row.client_id &&
    claims.agent_id === row.agent_external_id &&
    claims.auth_epoch === row.grant_authentication_epoch &&
    claims.auth_epoch === row.principal_authentication_epoch &&
    claims.binding_version === row.grant_binding_version &&
    claims.binding_version === row.current_binding_version
  );
}

export class OAuthStoreUnavailableError extends Error {
  constructor(message = "OAuth persistence is unavailable", options) {
    super(message, options);
    this.name = "OAuthStoreUnavailableError";
  }
}

export class OAuthLegacyStateImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OAuthLegacyStateImportError";
    this.code = code;
  }
}

/**
 * @param {{
 *   databaseUrl:string,
 *   requiredMigration:{
 *     id:string,
 *     sha256:string,
 *     additionalMigrations?:Array<{id:string,sha256:string}>
 *   },
 *   bootstrap:{issuer:string,subject:string,agentExternalId:string},
 *   baseUrl:string,
 *   resourceUrl?:string,
 *   acceptLegacyUntil?:Date,
 *   expectedLegacyState?:{
 *     sourceChecksum:Uint8Array,
 *     clientCount:number,
 *     codeCount:number
 *   },
 *   freshInstall?:boolean,
 *   maintenanceTimeoutMilliseconds?:number
 * }} options
 */
export function createPostgresOAuthStore(options) {
  assertOptions(options);
  const authority = databaseAuthority(options.databaseUrl);
  const maintenanceTimeoutMilliseconds =
    options.maintenanceTimeoutMilliseconds ??
    DEFAULT_MAINTENANCE_TIMEOUT_MILLISECONDS;
  const acceptLegacyUntil = new Date(
    options.acceptLegacyUntil?.getTime() ?? 0
  );
  const resourceUrl = canonicalResourceUrl(
    options.resourceUrl ?? `${options.baseUrl.replace(/\/+$/, "")}/mcp`
  );
  const compatibilityResourceBase = canonicalResourceUrl(options.baseUrl);
  const allowedResources = new Set([
    resourceUrl,
    compatibilityResourceBase,
    `${compatibilityResourceBase}/`
  ]);
  const expectedLegacyState = options.expectedLegacyState === undefined
    ? null
    : Object.freeze({
        sourceChecksum: Buffer.from(options.expectedLegacyState.sourceChecksum),
        clientCount: options.expectedLegacyState.clientCount,
        codeCount: options.expectedLegacyState.codeCount
      });
  const freshInstall = options.freshInstall === true;
  const freshInstallChecksum = Buffer.from(FRESH_INSTALL_SHA256, "hex");
  const requiredMigrations = Object.freeze([
    Object.freeze({
      id: options.requiredMigration.id,
      sha256: options.requiredMigration.sha256
    }),
    ...(options.requiredMigration.additionalMigrations ?? []).map((migration) =>
      Object.freeze({ id: migration.id, sha256: migration.sha256 })
    )
  ]);

  const sql = postgres(options.databaseUrl, {
    max: 4,
    connect_timeout: 5,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connection: { search_path: "pg_catalog, public" },
    ...postgresTlsOptions(options.databaseUrl),
    onnotice: () => {}
  });
  const readinessSql = postgres(options.databaseUrl, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 10,
    max_lifetime: 60 * 30,
    connection: {
      search_path: "pg_catalog, public",
      statement_timeout: "3000",
    },
    ...postgresTlsOptions(options.databaseUrl),
    onnotice: () => {},
  });
  const maintenanceSql = postgres(options.databaseUrl, {
    max: 1,
    connect_timeout: Math.max(
      1,
      Math.min(5, Math.ceil(maintenanceTimeoutMilliseconds / 1_000))
    ),
    idle_timeout: 10,
    max_lifetime: 60 * 30,
    connection: {
      search_path: "pg_catalog, public",
      statement_timeout: String(maintenanceTimeoutMilliseconds),
    },
    ...postgresTlsOptions(options.databaseUrl),
    onnotice: () => {},
  });

  return Object.freeze({
    async close() {
      await Promise.all([
        sql.end({ timeout: 5 }),
        readinessSql.end({ timeout: 5 }),
        maintenanceSql.end({ timeout: 5 }),
      ]);
    },

    async checkReadiness() {
      const fields = {
        database: false,
        schema: false,
        bootstrap: false,
        legacyImport: false
      };

      try {
        const identityRows = await readinessSql`
          SELECT
            CURRENT_USER AS current_user,
            SESSION_USER AS session_user,
            pg_catalog.current_database() AS current_database,
            pg_catalog.current_setting('search_path') AS search_path
        `;
        fields.database =
          identityRows.length === 1 &&
          identityRows[0].current_user === authority.username &&
          identityRows[0].session_user === authority.username &&
          identityRows[0].current_database === authority.database &&
          identityRows[0].search_path === "pg_catalog, public";
        if (!fields.database) return readinessFailure(fields, "database");
      } catch {
        return readinessFailure(fields, "database");
      }

      try {
        const relations = await readinessSql`
          SELECT c.relname AS name
          FROM pg_catalog.pg_class AS c
          INNER JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r', 'p')
            AND c.relname = ANY(${readinessSql.array(REQUIRED_RELATIONS)}::text[])
        `;
        const present = new Set(relations.map((row) => row.name));
        if (!REQUIRED_RELATIONS.every((name) => present.has(name))) {
          return readinessFailure(fields, "schema");
        }

        const migrationRows = await readinessSql`
          SELECT id, sha256
          FROM ${readinessSql("public")}.${readinessSql(OAUTH_DATABASE_OBJECTS.migrationLedger)}
          ORDER BY id ASC
        `;
        fields.schema =
          migrationRows.length === requiredMigrations.length &&
          migrationRows.every((row, index) =>
            row.id === requiredMigrations[index].id &&
            row.sha256 === requiredMigrations[index].sha256
          );
        if (!fields.schema) return readinessFailure(fields, "schema");
      } catch {
        return readinessFailure(fields, "schema");
      }

      try {
        const rows = await readinessSql`
          SELECT
            p.id AS principal_id,
            b.id AS binding_id,
            b.agent_id,
            b.allowed_scopes::text[] AS allowed_scopes,
            a.external_id AS agent_external_id
          FROM ${readinessSql("public")}.${readinessSql(OAUTH_DATABASE_OBJECTS.principals)} AS p
          INNER JOIN ${readinessSql("public")}.${readinessSql(OAUTH_DATABASE_OBJECTS.bindings)} AS b
            ON b.principal_id = p.id
          INNER JOIN ${readinessSql("public")}.${readinessSql(OAUTH_DATABASE_OBJECTS.agents)} AS a
            ON a.id = b.agent_id
          WHERE p.issuer = ${options.bootstrap.issuer}
            AND p.subject = ${options.bootstrap.subject}
            AND p.status = 'active'
            AND b.status = 'active'
            AND b.is_default = TRUE
            AND a.external_id = ${options.bootstrap.agentExternalId}
          LIMIT 2
        `;
        fields.bootstrap =
          rows.length === 1 &&
          sameScopes(rows[0].allowed_scopes, EXPECTED_BOOTSTRAP_SCOPES);
        if (!fields.bootstrap) return readinessFailure(fields, "bootstrap");
      } catch {
        return readinessFailure(fields, "bootstrap");
      }

      try {
        const rows = await readinessSql`
          SELECT
            version,
            source_checksum,
            outcome,
            started_at,
            completed_at,
            report
          FROM ${readinessSql("public")}.${readinessSql(OAUTH_DATABASE_OBJECTS.stateMigrations)}
          WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
          LIMIT 2
        `;
        const importedReady =
          expectedLegacyState !== null &&
          rows.length === 1 &&
          isByteArray(rows[0].source_checksum) &&
          Buffer.from(rows[0].source_checksum).equals(
            expectedLegacyState.sourceChecksum
          ) &&
          rows[0].outcome === "imported" &&
          isValidDate(rows[0].started_at) &&
          isValidDate(rows[0].completed_at) &&
          rows[0].completed_at >= rows[0].started_at &&
          validLegacyImportReport(rows[0].report) &&
          rows[0].report.clientsImported + rows[0].report.clientsExisting ===
            expectedLegacyState.clientCount &&
          rows[0].report.codesImported + rows[0].report.codesExpired ===
            expectedLegacyState.codeCount;
        const freshReady =
          freshInstall &&
          rows.length === 1 &&
          isByteArray(rows[0].source_checksum) &&
          Buffer.from(rows[0].source_checksum).equals(freshInstallChecksum) &&
          rows[0].outcome === "fresh_install" &&
          isValidDate(rows[0].started_at) &&
          isValidDate(rows[0].completed_at) &&
          rows[0].completed_at >= rows[0].started_at &&
          validLegacyImportReport(rows[0].report) &&
          rows[0].report.clientsImported === 0 &&
          rows[0].report.clientsExisting === 0 &&
          rows[0].report.codesImported === 0 &&
          rows[0].report.codesExpired === 0;
        fields.legacyImport = importedReady || freshReady;
        if (!fields.legacyImport) {
          return readinessFailure(fields, "legacy_import");
        }
      } catch {
        return readinessFailure(fields, "legacy_import");
      }

      return Object.freeze({
        ready: true,
        database: true,
        schema: true,
        bootstrap: true,
        legacyImport: true
      });
    },

    async pruneExpired(now, batchSize) {
      if (
        !isValidDate(now) ||
        !Number.isSafeInteger(batchSize) ||
        batchSize < 1 ||
        batchSize > MAX_PRUNE_BATCH_SIZE
      ) {
        throw new TypeError("pruneExpired requires a valid Date and batch size from 1 to 1000");
      }

      try {
        const rows = await maintenanceSql`
          SELECT public.oauth_prune_expired(
            ${new Date(now.getTime())},
            ${batchSize}
          ) AS report
        `;
        if (rows.length !== 1 || !validPruneReport(rows[0].report)) {
          throw new Error("OAuth prune report is invalid");
        }
        return Object.freeze({ ...rows[0].report });
      } catch {
        throw new OAuthStoreUnavailableError();
      }
    },

    async recordSecurityEvent(rawInput) {
      const input = normalizeSecurityEventInput(rawInput);
      if (!input) throw new TypeError("security event input is invalid");

      try {
        await sql`
          INSERT INTO ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.auditEvents)} (
            id,
            event_type,
            outcome,
            principal_id,
            binding_id,
            grant_id,
            request_id,
            actor_type,
            metadata
          ) VALUES (
            ${randomUUID()},
            ${input.eventType},
            ${input.outcome},
            ${input.principalId},
            ${input.bindingId},
            ${input.grantId},
            ${input.requestId},
            ${input.actorType},
            ${sql.json(input.metadata)}
          )
        `;
      } catch {
        throw new OAuthStoreUnavailableError();
      }
    },

    async resolveBootstrapBinding() {
      let rows;
      try {
        rows = await sql`
          SELECT
            p.id AS principal_id,
            p.subject,
            p.authentication_epoch,
            b.id AS binding_id,
            b.binding_version,
            b.allowed_scopes::text[] AS allowed_scopes,
            b.agent_id,
            a.external_id AS agent_external_id
          FROM ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.principals)} AS p
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.bindings)} AS b
            ON b.principal_id = p.id
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.agents)} AS a
            ON a.id = b.agent_id
          WHERE p.issuer = ${options.bootstrap.issuer}
            AND p.subject = ${options.bootstrap.subject}
            AND p.status = 'active'
            AND b.status = 'active'
            AND b.is_default = TRUE
            AND a.external_id = ${options.bootstrap.agentExternalId}
          LIMIT 2
        `;
      } catch {
        throw new OAuthStoreUnavailableError();
      }

      if (rows.length !== 1) return null;
      const binding = mapBoundPrincipal(rows[0]);
      return binding && sameScopes(binding.allowedScopes, EXPECTED_BOOTSTRAP_SCOPES)
        ? binding
        : null;
    },

    /**
     * Creates a fixed-lifetime, opaque browser session. Only purpose-keyed
     * digests and fingerprints cross this persistence boundary.
     *
     * @param {{
     *   sessionDigest:Uint8Array,
     *   ipFingerprint:Uint8Array,
     *   ttlSeconds:number,
     *   requestId:string,
     *   userAgentFingerprint:Uint8Array|null
     * }} rawInput
     */
    async createLoginSession(rawInput) {
      const input = createLoginSessionInput(rawInput);
      if (!input) return null;

      try {
        return await sql.begin(async (transaction) => {
          // Principal security controls take their login-session table intent
          // lock before changing the authority row. Taking the conflicting
          // barrier first makes this session either visible to that sweep or
          // forces a fresh post-control authority read.
          await transaction`SELECT public.oauth_lock_login_sessions()`;
          const rows = await transaction`
            SELECT
              principal.id AS principal_id,
              principal.subject,
              principal.authentication_epoch,
              binding.id AS binding_id,
              binding.binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              CURRENT_TIMESTAMP AS issued_at,
              CURRENT_TIMESTAMP + (${input.ttlSeconds} * INTERVAL '1 second') AS expires_at
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            WHERE principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND principal.status = 'active'
              AND binding.status = 'active'
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
            LIMIT 2
          `;
          if (rows.length !== 1) return null;
          const session = mapLoginSession(rows[0]);
          if (
            !session ||
            !sameScopes(session.context.allowedScopes, EXPECTED_BOOTSTRAP_SCOPES)
          ) {
            return null;
          }

          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.loginSessions)} (
              id,
              session_digest,
              legacy_cookie_digest,
              principal_id,
              ip_fingerprint,
              authentication_epoch,
              issued_at,
              expires_at
            ) VALUES (
              ${randomUUID()},
              ${input.sessionDigest},
              NULL,
              ${session.context.principalId},
              ${input.ipFingerprint},
              ${session.context.authenticationEpoch},
              ${session.issuedAt},
              ${session.expiresAt}
            )
          `;
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              principal_id,
              binding_id,
              request_id,
              actor_type,
              ip_fingerprint,
              user_agent_fingerprint,
              metadata,
              created_at
            ) VALUES (
              ${randomUUID()},
              'browser_login_session',
              'created',
              ${session.context.principalId},
              ${session.context.bindingId},
              ${input.requestId},
              'browser',
              ${input.ipFingerprint},
              ${input.userAgentFingerprint},
              ${transaction.json(sanitizeSecurityMetadata("browser_login_session", {}))},
              ${session.issuedAt}
            )
          `;
          return session;
        });
      } catch {
        throw new OAuthStoreUnavailableError();
      }
    },

    /**
     * Resolves one opaque browser session against live principal/default-
     * binding state. All inactive cases deliberately collapse to `invalid`.
     *
     * @param {{sessionDigest:Uint8Array,ipFingerprint:Uint8Array}} rawInput
     */
    async resolveLoginSession(rawInput) {
      const input = resolveLoginSessionInput(rawInput);
      if (!input) return INVALID_LOGIN_SESSION_DECISION;

      let rows;
      try {
        rows = await sql`
          SELECT
            principal.id AS principal_id,
            principal.subject,
            principal.authentication_epoch,
            binding.id AS binding_id,
            binding.binding_version,
            binding.allowed_scopes::text[] AS allowed_scopes,
            binding.agent_id,
            agent.external_id AS agent_external_id,
            login_session.issued_at,
            login_session.expires_at
          FROM ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.loginSessions)} AS login_session
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            ON principal.id = login_session.principal_id
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
            ON binding.principal_id = principal.id
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.agents)} AS agent
            ON agent.id = binding.agent_id
          WHERE login_session.session_digest = ${input.sessionDigest}
            AND login_session.ip_fingerprint = ${input.ipFingerprint}
            AND login_session.revoked_at IS NULL
            AND login_session.issued_at <= CURRENT_TIMESTAMP
            AND login_session.expires_at > CURRENT_TIMESTAMP
            AND login_session.authentication_epoch = principal.authentication_epoch
            AND principal.issuer = ${options.bootstrap.issuer}
            AND principal.subject = ${options.bootstrap.subject}
            AND principal.status = 'active'
            AND binding.status = 'active'
            AND binding.is_default = TRUE
            AND agent.external_id = ${options.bootstrap.agentExternalId}
          LIMIT 2
        `;
      } catch {
        throw new OAuthStoreUnavailableError();
      }
      if (rows.length !== 1) return INVALID_LOGIN_SESSION_DECISION;
      const session = mapLoginSession(rows[0]);
      return session && sameScopes(
        session.context.allowedScopes,
        EXPECTED_BOOTSTRAP_SCOPES
      )
        ? activeLoginSessionDecision(session)
        : INVALID_LOGIN_SESSION_DECISION;
    },

    /**
     * Consumes one verified v1 cookie source into an opaque session. The
     * legacy source's unique digest serializes concurrent upgrades, and the
     * replacement never outlives the verified source cookie.
     *
     * @param {{
     *   legacyCookieDigest:Uint8Array,
     *   legacySubject:string,
     *   legacyIssuedAt:Date,
     *   legacyExpiresAt:Date,
     *   sessionDigest:Uint8Array,
     *   ipFingerprint:Uint8Array,
     *   requestId:string,
     *   userAgentFingerprint:Uint8Array|null
     * }} rawInput
     */
    async upgradeLegacyLoginSession(rawInput) {
      const input = upgradeLegacyLoginSessionInput(rawInput);
      if (!input) return INVALID_LOGIN_SESSION_DECISION;

      try {
        return await sql.begin(async (transaction) => {
          // Pair with principal/issuer security sweeps before reading a legacy
          // epoch or inserting its replacement opaque session.
          await transaction`SELECT public.oauth_lock_login_sessions()`;
          const rows = await transaction`
            SELECT
              principal.id AS principal_id,
              principal.subject,
              principal.authentication_epoch,
              principal.legacy_not_before,
              binding.id AS binding_id,
              binding.binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              CURRENT_TIMESTAMP AS issued_at,
              ${input.legacyExpiresAt}::timestamptz AS expires_at
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            WHERE principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND principal.status = 'active'
              AND binding.status = 'active'
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
            LIMIT 2
          `;
          if (rows.length !== 1) return INVALID_LOGIN_SESSION_DECISION;
          const row = rows[0];
          const session = mapLoginSession(row);
          if (
            !session ||
            input.legacySubject !== row.subject ||
            input.legacyIssuedAt.getTime() >
              session.issuedAt.getTime() + LEGACY_LOGIN_CLOCK_SKEW_MILLISECONDS ||
            input.legacyExpiresAt <= session.issuedAt ||
            !isValidDate(row.legacy_not_before) ||
            input.legacyIssuedAt < row.legacy_not_before ||
            !sameScopes(session.context.allowedScopes, EXPECTED_BOOTSTRAP_SCOPES)
          ) {
            return INVALID_LOGIN_SESSION_DECISION;
          }

          const inserted = await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.loginSessions)} (
              id,
              session_digest,
              legacy_cookie_digest,
              principal_id,
              ip_fingerprint,
              authentication_epoch,
              issued_at,
              expires_at
            ) VALUES (
              ${randomUUID()},
              ${input.sessionDigest},
              ${input.legacyCookieDigest},
              ${session.context.principalId},
              ${input.ipFingerprint},
              ${session.context.authenticationEpoch},
              ${session.issuedAt},
              ${session.expiresAt}
            )
            ON CONFLICT (legacy_cookie_digest)
              WHERE legacy_cookie_digest IS NOT NULL
              DO NOTHING
            RETURNING id
          `;
          if (inserted.length === 0) {
            const existing = await transaction`
              SELECT id
              FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.loginSessions)}
              WHERE legacy_cookie_digest = ${input.legacyCookieDigest}
              LIMIT 2
            `;
            if (existing.length !== 1) {
              throw new Error("Legacy login-session source conflict is inconsistent");
            }
            return ALREADY_UPGRADED_LOGIN_SESSION_DECISION;
          }
          if (inserted.length !== 1) {
            throw new Error("Legacy login-session insert is ambiguous");
          }

          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              principal_id,
              binding_id,
              request_id,
              actor_type,
              ip_fingerprint,
              user_agent_fingerprint,
              metadata,
              created_at
            ) VALUES (
              ${randomUUID()},
              'legacy_login_session_upgrade',
              'upgraded',
              ${session.context.principalId},
              ${session.context.bindingId},
              ${input.requestId},
              'browser',
              ${input.ipFingerprint},
              ${input.userAgentFingerprint},
              ${transaction.json(sanitizeSecurityMetadata(
                "legacy_login_session_upgrade",
                { sourceVersion: 1 }
              ))},
              ${session.issuedAt}
            )
          `;
          return upgradedLoginSessionDecision(session);
        });
      } catch {
        throw new OAuthStoreUnavailableError();
      }
    },

    async resolveActiveClient(clientId) {
      if (!isNonEmptyString(clientId, 512) || clientId !== clientId.trim()) {
        return null;
      }

      let rows;
      try {
        rows = await sql`
          SELECT
            id,
            client_id,
            client_kind,
            redirect_uris,
            client_name,
            token_endpoint_auth_method,
            status,
            created_at,
            updated_at
          FROM ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.clients)}
          WHERE client_id = ${clientId}
            AND status = 'active'
          LIMIT 2
        `;
      } catch (cause) {
        throw new OAuthStoreUnavailableError(undefined, { cause });
      }
      return rows.length === 1 ? mapClient(rows[0]) : null;
    },

    async synchronizeStaticClients(rawClients) {
      if (!Array.isArray(rawClients) || rawClients.length > 32) {
        throw new TypeError("Static OAuth client metadata is invalid");
      }
      const clients = rawClients.map(normalizeStaticClient);
      if (
        clients.some((client) => client === null) ||
        new Set(clients.map((client) => client.clientId)).size !== clients.length
      ) {
        throw new TypeError("Static OAuth client metadata is invalid");
      }

      try {
        return await sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(
              ${DYNAMIC_CLIENT_REGISTRATION_LOCK.toString()}::bigint
            )
          `;
          let inserted = 0;
          let existing = 0;
          for (const client of clients) {
            const rows = await transaction`
              SELECT
                client_id,
                client_kind,
                redirect_uris,
                client_name,
                token_endpoint_auth_method,
                status
              FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)}
              WHERE client_id = ${client.clientId}
              LIMIT 2
              FOR UPDATE
            `;
            if (rows.length > 1) {
              throw new Error("Static OAuth client identity is ambiguous");
            }
            if (rows.length === 1) {
              const row = rows[0];
              if (
                row.client_kind !== "static" ||
                row.status !== "active" ||
                row.client_name !== client.clientName ||
                row.token_endpoint_auth_method !== client.tokenEndpointAuthMethod ||
                !sameStringArray(row.redirect_uris, client.redirectUris)
              ) {
                throw new Error("Static OAuth client conflicts with database authority");
              }
              existing += 1;
              continue;
            }
            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} (
                id,
                client_id,
                client_kind,
                redirect_uris,
                client_name,
                token_endpoint_auth_method,
                status
              ) VALUES (
                ${randomUUID()},
                ${client.clientId},
                'static',
                ${transaction.array(client.redirectUris)}::text[],
                ${client.clientName},
                ${client.tokenEndpointAuthMethod},
                'active'
              )
            `;
            inserted += 1;
          }
          return Object.freeze({ inserted, existing });
        });
      } catch (cause) {
        throw new OAuthStoreUnavailableError(undefined, { cause });
      }
    },

    async registerDynamicClient(input = {}) {
      const redirectUris = normalizeDynamicRedirects(input.redirectUris);
      const clientName = normalizeClientName(input.clientName);
      if (!redirectUris || !clientName) return null;

      const internalId = randomUUID();
      const publicClientId = `chatgpt-${randomBytes(18).toString("base64url")}`;
      try {
        return await sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(
              ${DYNAMIC_CLIENT_REGISTRATION_LOCK.toString()}::bigint
            )
          `;
          const counts = await transaction`
            SELECT pg_catalog.count(*)::integer AS count
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)}
            WHERE client_kind = 'dynamic'
          `;
          if (counts.length !== 1 || counts[0].count >= MAX_DYNAMIC_CLIENTS) {
            return null;
          }

          const rows = await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} (
              id,
              client_id,
              client_kind,
              redirect_uris,
              client_name,
              token_endpoint_auth_method,
              status
            ) VALUES (
              ${internalId},
              ${publicClientId},
              'dynamic',
              ${transaction.array(redirectUris)}::text[],
              ${clientName},
              'none',
              'active'
            )
            RETURNING
              id,
              client_id,
              client_kind,
              redirect_uris,
              client_name,
              token_endpoint_auth_method,
              status,
              created_at,
              updated_at
          `;
          return rows.length === 1 ? mapClient(rows[0]) : null;
        });
      } catch {
        throw new OAuthStoreUnavailableError();
      }
    },

    async recordFreshInstall(input) {
      if (
        !freshInstall ||
        !hasExactKeys(input, ["confirmation", "requestId"]) ||
        input.confirmation !== "fresh_install" ||
        !validRequestId(input.requestId)
      ) {
        throw new OAuthLegacyStateImportError(
          "invalid_input",
          "Fresh installation requires explicit confirmation"
        );
      }
      const report = Object.freeze({
        clientsImported: 0,
        clientsExisting: 0,
        codesImported: 0,
        codesExpired: 0
      });
      try {
        return await sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(
              ${DYNAMIC_CLIENT_REGISTRATION_LOCK.toString()}::bigint
            )
          `;
          await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(
              ${LEGACY_STATE_IMPORT_LOCK.toString()}::bigint
            )
          `;
          const markers = await transaction`
            SELECT source_checksum, outcome, report
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.stateMigrations)}
            WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
            LIMIT 2
          `;
          if (markers.length === 1) {
            const marker = markers[0];
            if (
              marker.outcome === "fresh_install" &&
              isByteArray(marker.source_checksum) &&
              Buffer.from(marker.source_checksum).equals(freshInstallChecksum) &&
              validLegacyImportReport(marker.report) &&
              Object.values(marker.report).every((value) => value === 0)
            ) {
              return Object.freeze({
                kind: "already_fresh_install",
                version: LEGACY_STATE_IMPORT_VERSION,
                report
              });
            }
            throw new OAuthLegacyStateImportError(
              "marker_conflict",
              "Fresh-install marker conflicts with existing OAuth authority"
            );
          }
          if (markers.length > 1) {
            throw new OAuthLegacyStateImportError(
              "marker_conflict",
              "Fresh-install marker is ambiguous"
            );
          }

          const counts = await transaction`
            SELECT
              (SELECT pg_catalog.count(*)::integer FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} WHERE client_kind <> 'static') AS non_static_clients,
              (SELECT pg_catalog.count(*)::integer FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.authorizationCodes)}) AS authorization_codes,
              (SELECT pg_catalog.count(*)::integer FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}) AS grants,
              (SELECT pg_catalog.count(*)::integer FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)}) AS refresh_tokens,
              (SELECT pg_catalog.count(*)::integer FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.loginSessions)}) AS login_sessions
          `;
          if (
            counts.length !== 1 ||
            Object.values(counts[0]).some((value) => value !== 0)
          ) {
            throw new OAuthLegacyStateImportError(
              "authority_not_empty",
              "Fresh installation requires empty OAuth runtime authority"
            );
          }

          const authorityRows = await transaction`
            SELECT
              principal.id AS principal_id,
              binding.id AS binding_id,
              pg_catalog.clock_timestamp() AS started_at
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            WHERE principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND principal.status = 'active'
              AND binding.status = 'active'
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
            LIMIT 2
          `;
          if (authorityRows.length !== 1 || !isValidDate(authorityRows[0].started_at)) {
            throw new OAuthLegacyStateImportError(
              "bootstrap_conflict",
              "Fresh installation cannot resolve the configured principal binding"
            );
          }
          const authority = authorityRows[0];
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id, event_type, outcome, principal_id, binding_id,
              request_id, actor_type, metadata, created_at
            ) VALUES (
              ${randomUUID()}, 'legacy_state_import', 'fresh_install',
              ${authority.principal_id}, ${authority.binding_id},
              ${input.requestId}, 'migration',
              ${transaction.json(sanitizeSecurityMetadata("legacy_state_import", {
                version: LEGACY_STATE_IMPORT_VERSION,
                ...report
              }))},
              ${authority.started_at}
            )
          `;
          const completed = await transaction`
            SELECT pg_catalog.clock_timestamp() AS completed_at
          `;
          if (completed.length !== 1 || !isValidDate(completed[0].completed_at)) {
            throw new Error("Fresh-install completion clock is unavailable");
          }
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.stateMigrations)} (
              id, version, source_checksum, outcome,
              started_at, completed_at, report
            ) VALUES (
              ${randomUUID()}, ${LEGACY_STATE_IMPORT_VERSION},
              ${freshInstallChecksum}, 'fresh_install',
              ${authority.started_at}, ${completed[0].completed_at},
              ${transaction.json(report)}
            )
          `;
          return Object.freeze({
            kind: "fresh_install",
            version: LEGACY_STATE_IMPORT_VERSION,
            report
          });
        });
      } catch (cause) {
        if (cause instanceof OAuthLegacyStateImportError) throw cause;
        throw new OAuthStoreUnavailableError(undefined, { cause });
      }
    },

    /**
     * Imports descriptors produced by the immutable legacy-state parser. Raw
     * file bytes and raw authorization codes are deliberately outside this
     * persistence boundary.
     *
     * @param {{
     *   sourceVersion:1,
     *   sourceChecksum:Uint8Array,
     *   clients:readonly {
     *     clientId:string,
     *     redirectUris:readonly string[],
     *     clientName:string,
     *     createdAt:Date
     *   }[],
     *   codes:readonly {
     *     codeDigest:Uint8Array,
     *     clientId:string,
     *     redirectUri:string,
     *     scopes:readonly string[],
     *     codeChallenge:string,
     *     resource:string,
     *     subject:string,
     *     expiresAt:Date
     *   }[],
     *   requestId:string
     * }} rawInput
     * @returns {Promise<{
     *   kind:"imported"|"already_imported",
     *   version:string,
     *   report:{
     *     clientsImported:number,
     *     clientsExisting:number,
     *     codesImported:number,
     *     codesExpired:number
     *   }
     * }>}
     */
    async importLegacyStateOnce(rawInput) {
      const input = legacyImportInput(
        rawInput,
        allowedResources,
        options.bootstrap.subject
      );
      if (!input) {
        throw new OAuthLegacyStateImportError(
          "invalid_input",
          "Legacy OAuth state descriptors are invalid"
        );
      }
      if (
        expectedLegacyState !== null &&
        !input.sourceChecksum.equals(expectedLegacyState.sourceChecksum)
      ) {
        throw new OAuthLegacyStateImportError(
          "checksum_mismatch",
          "Legacy OAuth state checksum differs from the expected snapshot"
        );
      }
      if (
        expectedLegacyState !== null &&
        (input.clients.length !== expectedLegacyState.clientCount ||
          input.codes.length !== expectedLegacyState.codeCount)
      ) {
        throw new OAuthLegacyStateImportError(
          "source_mismatch",
          "Legacy OAuth state descriptor counts differ from the expected snapshot"
        );
      }

      try {
        return await sql.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(
              ${DYNAMIC_CLIENT_REGISTRATION_LOCK.toString()}::bigint
            )
          `;
          await transaction`
            SELECT pg_catalog.pg_advisory_xact_lock(
              ${LEGACY_STATE_IMPORT_LOCK.toString()}::bigint
            )
          `;

          const markerRows = await transaction`
            SELECT
              source_checksum,
              outcome,
              report
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.stateMigrations)}
            WHERE version = ${LEGACY_STATE_IMPORT_VERSION}
            LIMIT 2
          `;
          if (markerRows.length > 1) {
            throw new OAuthLegacyStateImportError(
              "marker_conflict",
              "Legacy OAuth state migration marker is ambiguous"
            );
          }
          if (markerRows.length === 1) {
            const marker = markerRows[0];
            if (
              !isByteArray(marker.source_checksum) ||
              !Buffer.from(marker.source_checksum).equals(input.sourceChecksum)
            ) {
              throw new OAuthLegacyStateImportError(
                "checksum_mismatch",
                "Legacy OAuth state checksum differs from the completed import"
              );
            }
            if (marker.outcome !== "imported" || !validLegacyImportReport(marker.report)) {
              throw new OAuthLegacyStateImportError(
                "marker_conflict",
                "Legacy OAuth state migration marker is malformed"
              );
            }
            if (
              expectedLegacyState !== null &&
              (marker.report.clientsImported + marker.report.clientsExisting !==
                expectedLegacyState.clientCount ||
                marker.report.codesImported + marker.report.codesExpired !==
                expectedLegacyState.codeCount)
            ) {
              throw new OAuthLegacyStateImportError(
                "marker_conflict",
                "Legacy OAuth state migration report differs from the expected snapshot"
              );
            }
            return legacyImportResult("already_imported", marker.report);
          }

          const authorityRows = await transaction`
            SELECT
              principal.id AS principal_id,
              principal.authentication_epoch,
              binding.id AS binding_id,
              binding.binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              CURRENT_TIMESTAMP AS transaction_now
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            WHERE principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND principal.status = 'active'
              AND binding.status = 'active'
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
            LIMIT 2
          `;
          const authority = authorityRows[0];
          const authorityScopes = normalizeScopes(authority?.allowed_scopes);
          if (authorityRows.length !== 1 || !authorityScopes) {
            throw new OAuthLegacyStateImportError(
              "bootstrap_conflict",
              "Legacy OAuth state cannot resolve the configured principal binding"
            );
          }

          const dynamicClientCounts = await transaction`
            SELECT pg_catalog.count(*)::integer AS count
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)}
            WHERE client_kind = 'dynamic'
          `;
          if (
            dynamicClientCounts.length !== 1 ||
            !Number.isSafeInteger(dynamicClientCounts[0].count) ||
            dynamicClientCounts[0].count > MAX_DYNAMIC_CLIENTS
          ) {
            throw new OAuthLegacyStateImportError(
              "client_capacity",
              "Legacy OAuth client capacity is invalid"
            );
          }
          let dynamicClientCount = dynamicClientCounts[0].count;

          const clientRowsByPublicId = new Map();
          let clientsImported = 0;
          let clientsExisting = 0;
          for (const client of input.clients) {
            const existingRows = await transaction`
              SELECT
                id,
                client_id,
                client_kind,
                redirect_uris,
                client_name,
                token_endpoint_auth_method,
                status,
                created_at,
                updated_at
              FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)}
              WHERE client_id = ${client.clientId}
              LIMIT 2
              FOR UPDATE
            `;
            if (existingRows.length > 1) {
              throw new OAuthLegacyStateImportError(
                "client_conflict",
                "Legacy OAuth client identity is ambiguous"
              );
            }

            let row;
            if (existingRows.length === 1) {
              row = existingRows[0];
              if (
                row.client_kind !== "dynamic" ||
                row.token_endpoint_auth_method !== "none" ||
                row.status !== "active" ||
                row.client_name !== client.clientName ||
                !sameStringArray(row.redirect_uris, client.redirectUris) ||
                !sameTimestamp(row.created_at, client.createdAt)
              ) {
                throw new OAuthLegacyStateImportError(
                  "client_conflict",
                  "Legacy OAuth client conflicts with existing authority"
                );
              }
              clientsExisting += 1;
            } else {
              if (dynamicClientCount >= MAX_DYNAMIC_CLIENTS) {
                throw new OAuthLegacyStateImportError(
                  "client_capacity",
                  "Legacy OAuth client capacity is exhausted"
                );
              }
              const inserted = await transaction`
                INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} (
                  id,
                  client_id,
                  client_kind,
                  redirect_uris,
                  client_name,
                  token_endpoint_auth_method,
                  status,
                  created_at,
                  updated_at
                ) VALUES (
                  ${randomUUID()},
                  ${client.clientId},
                  'dynamic',
                  ${transaction.array(client.redirectUris)}::text[],
                  ${client.clientName},
                  'none',
                  'active',
                  ${client.createdAt},
                  ${client.createdAt}
                )
                RETURNING
                  id,
                  client_id,
                  client_kind,
                  redirect_uris,
                  client_name,
                  token_endpoint_auth_method,
                  status,
                  created_at,
                  updated_at
              `;
              if (inserted.length !== 1) {
                throw new Error("Legacy OAuth client insert returned no authority row");
              }
              row = inserted[0];
              dynamicClientCount += 1;
              clientsImported += 1;
            }
            clientRowsByPublicId.set(client.clientId, row);
          }

          let codesImported = 0;
          let codesExpired = 0;
          const importClockRows = await transaction`
            SELECT pg_catalog.clock_timestamp() AS import_now
          `;
          if (importClockRows.length !== 1 || !isValidDate(importClockRows[0].import_now)) {
            throw new Error("Legacy OAuth import clock is unavailable");
          }
          const importNow = importClockRows[0].import_now;
          for (const code of input.codes) {
            if (code.expiresAt <= importNow) {
              codesExpired += 1;
              continue;
            }
            if (!code.scopes.every((scope) => authorityScopes.includes(scope))) {
              throw new OAuthLegacyStateImportError(
                "bootstrap_conflict",
                "Legacy OAuth code exceeds the configured binding scopes"
              );
            }

            let client = clientRowsByPublicId.get(code.clientId);
            if (!client) {
              const staticRows = await transaction`
                SELECT
                  id,
                  client_id,
                  client_kind,
                  redirect_uris,
                  client_name,
                  token_endpoint_auth_method,
                  status,
                  created_at,
                  updated_at
                FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)}
                WHERE client_id = ${code.clientId}
                LIMIT 2
                FOR UPDATE
              `;
              if (staticRows.length !== 1 || staticRows[0].client_kind !== "static") {
                throw new OAuthLegacyStateImportError(
                  "client_conflict",
                  "Legacy OAuth code references an unsynchronized client"
                );
              }
              client = staticRows[0];
              clientRowsByPublicId.set(code.clientId, client);
            }
            if (
              client.status !== "active" ||
              !client.redirect_uris.includes(code.redirectUri) ||
              (client.client_kind === "dynamic" &&
                client.token_endpoint_auth_method !== "none")
            ) {
              throw new OAuthLegacyStateImportError(
                "client_conflict",
                "Legacy OAuth code client is inactive or mismatched"
              );
            }

            const conflicts = await transaction`
              SELECT id
              FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.authorizationCodes)}
              WHERE code_digest = ${code.codeDigest}
              LIMIT 2
              FOR UPDATE
            `;
            if (conflicts.length !== 0) {
              throw new OAuthLegacyStateImportError(
                "code_conflict",
                "Legacy OAuth code digest already exists"
              );
            }

            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.authorizationCodes)} (
                id,
                code_digest,
                oauth_client_id,
                principal_id,
                binding_id,
                authentication_epoch,
                binding_version,
                redirect_uri,
                scopes,
                code_challenge,
                resource,
                expires_at,
                created_at
              ) VALUES (
                ${randomUUID()},
                ${code.codeDigest},
                ${client.id},
                ${authority.principal_id},
                ${authority.binding_id},
                ${authority.authentication_epoch},
                ${authority.binding_version},
                ${code.redirectUri},
                ${transaction.array(code.scopes)}::public.oauth_scope[],
                ${code.codeChallenge},
                ${code.resource},
                ${code.expiresAt},
                ${importNow}
              )
            `;
            codesImported += 1;
          }

          const report = {
            clientsImported,
            clientsExisting,
            codesImported,
            codesExpired
          };
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              principal_id,
              binding_id,
              request_id,
              actor_type,
              metadata,
              created_at
            ) VALUES (
              ${randomUUID()},
              'legacy_state_import',
              'imported',
              ${authority.principal_id},
              ${authority.binding_id},
              ${input.requestId},
              'migration',
              ${transaction.json(sanitizeSecurityMetadata("legacy_state_import", {
                version: LEGACY_STATE_IMPORT_VERSION,
                ...report
              }))},
              ${importNow}
            )
          `;
          const completionRows = await transaction`
            SELECT pg_catalog.clock_timestamp() AS completed_at
          `;
          if (completionRows.length !== 1 || !isValidDate(completionRows[0].completed_at)) {
            throw new Error("Legacy OAuth import completion time is unavailable");
          }
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.stateMigrations)} (
              id,
              version,
              source_checksum,
              outcome,
              started_at,
              completed_at,
              report
            ) VALUES (
              ${randomUUID()},
              ${LEGACY_STATE_IMPORT_VERSION},
              ${input.sourceChecksum},
              'imported',
              ${authority.transaction_now},
              ${completionRows[0].completed_at},
              ${transaction.json(report)}
            )
          `;
          return legacyImportResult("imported", report);
        });
      } catch (cause) {
        if (cause instanceof OAuthLegacyStateImportError) throw cause;
        throw new OAuthStoreUnavailableError(undefined, { cause });
      }
    },

    async createAuthorization(rawInput) {
      const input = authorizationInput(
        rawInput,
        allowedResources,
        options.bootstrap.subject,
        options.bootstrap.agentExternalId
      );
      if (!input) return null;

      try {
        return await sql.begin(async (transaction) => {
          // Security logout and issuer/principal invalidation consume all
          // outstanding codes. This self-exclusive table lock orders a new
          // code either wholly before that sweep (so the sweep consumes it)
          // or wholly after it (so the captured context is stale). Runtime
          // has DML privilege on this table but no principal UPDATE privilege,
          // so a principal row lock is not available at this boundary.
          await transaction`SELECT public.oauth_lock_authorization_codes()`;
          const rows = await transaction`
            SELECT
              client.id AS oauth_client_id,
              client.client_kind,
              client.redirect_uris,
              client.token_endpoint_auth_method,
              principal.id AS principal_id,
              principal.subject,
              principal.authentication_epoch,
              binding.id AS binding_id,
              binding.binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              CURRENT_TIMESTAMP AS transaction_now
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} AS client
            CROSS JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            WHERE client.client_id = ${input.clientId}
              AND client.status = 'active'
              AND principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND principal.id = ${input.authenticatedContext.principalId}
              AND principal.authentication_epoch = ${input.authenticatedContext.authenticationEpoch}
              AND principal.status = 'active'
              AND binding.id = ${input.authenticatedContext.bindingId}
              AND binding.binding_version = ${input.authenticatedContext.bindingVersion}
              AND binding.agent_id = ${input.authenticatedContext.agentId}
              AND binding.status = 'active'
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
              AND agent.external_id = ${input.authenticatedContext.agentExternalId}
            LIMIT 2
          `;
          if (rows.length !== 1) return null;
          const row = rows[0];
          const allowedScopes = normalizeScopes(row.allowed_scopes);
          if (
            !allowedScopes ||
            row.subject !== input.authenticatedContext.subject ||
            !sameScopes(
              allowedScopes,
              input.authenticatedContext.allowedScopes
            ) ||
            !input.scopes.every((scope) => allowedScopes.includes(scope)) ||
            !row.redirect_uris.includes(input.redirectUri) ||
            input.expiresAt <= row.transaction_now
          ) {
            return null;
          }

          const authorizationCodeId = randomUUID();
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.authorizationCodes)} (
              id,
              code_digest,
              oauth_client_id,
              principal_id,
              binding_id,
              authentication_epoch,
              binding_version,
              redirect_uri,
              scopes,
              code_challenge,
              resource,
              expires_at
            ) VALUES (
              ${authorizationCodeId},
              ${input.codeDigest},
              ${row.oauth_client_id},
              ${row.principal_id},
              ${row.binding_id},
              ${row.authentication_epoch},
              ${row.binding_version},
              ${input.redirectUri},
              ${transaction.array(input.scopes)}::public.oauth_scope[],
              ${input.codeChallenge},
              ${input.resource},
              ${input.expiresAt}
            )
          `;
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              principal_id,
              binding_id,
              oauth_client_id,
              request_id,
              actor_type,
              ip_fingerprint,
              user_agent_fingerprint,
              metadata
            ) VALUES (
              ${randomUUID()},
              'browser_authorization',
              'code_created',
              ${row.principal_id},
              ${row.binding_id},
              ${row.oauth_client_id},
              ${input.requestId},
              'browser',
              ${input.ipFingerprint ?? null},
              ${input.userAgentFingerprint ?? null},
              ${transaction.json(sanitizeSecurityMetadata("browser_authorization", {}))}
            )
          `;
          return undefined;
        });
      } catch {
        throw new OAuthStoreUnavailableError();
      }
    },

    async exchangeAuthorizationCode(rawInput) {
      const input = exchangeInput(rawInput);
      if (!input) return null;

      try {
        return await sql.begin(async (transaction) => {
          // Security controls acquire a conflicting code-table intent lock
          // before authority/grant rows. This orders an exchange wholly before
          // their sweep or makes it re-read the post-control authority state.
          await transaction`SELECT public.oauth_lock_authorization_codes()`;
          const rows = await transaction`
            SELECT
              authorization_code.id AS authorization_code_id,
              authorization_code.redirect_uri,
              authorization_code.scopes::text[] AS scopes,
              authorization_code.code_challenge,
              authorization_code.resource,
              authorization_code.authentication_epoch AS captured_authentication_epoch,
              authorization_code.binding_version AS captured_binding_version,
              authorization_code.expires_at,
              authorization_code.consumed_at,
              authorization_code.created_at AS authorization_created_at,
              client.id AS oauth_client_id,
              client.client_id,
              client.client_kind,
              client.redirect_uris,
              client.token_endpoint_auth_method,
              client.status AS client_status,
              principal.id AS principal_id,
              principal.subject,
              principal.status AS principal_status,
              principal.authentication_epoch,
              binding.id AS binding_id,
              binding.status AS binding_status,
              binding.is_default,
              binding.binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              CURRENT_TIMESTAMP AS transaction_now
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.authorizationCodes)} AS authorization_code
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} AS client
              ON client.id = authorization_code.oauth_client_id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
              ON principal.id = authorization_code.principal_id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.id = authorization_code.binding_id
              AND binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            WHERE authorization_code.code_digest = ${input.codeDigest}
              AND client.client_id = ${input.clientId}
              AND principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND agent.external_id = ${options.bootstrap.agentExternalId}
            LIMIT 2
            FOR UPDATE OF authorization_code, client
          `;
          if (rows.length !== 1) return null;
          const row = rows[0];
          const codeScopes = normalizeScopes(row.scopes);
          const allowedScopes = normalizeScopes(row.allowed_scopes);
          if (
            row.consumed_at !== null ||
            row.expires_at <= row.transaction_now ||
            row.client_status !== "active" ||
            row.principal_status !== "active" ||
            row.binding_status !== "active" ||
            row.is_default !== true ||
            row.captured_authentication_epoch !== row.authentication_epoch ||
            row.captured_binding_version !== row.binding_version ||
            !codeScopes ||
            !allowedScopes ||
            !codeScopes.every((scope) => allowedScopes.includes(scope)) ||
            row.redirect_uri !== input.redirectUri ||
            !row.redirect_uris.includes(row.redirect_uri) ||
            row.code_challenge !== input.codeChallenge ||
            !allowedResources.has(row.resource) ||
            (input.resource !== null && input.resource !== row.resource) ||
            (input.scopes !== null && !sameScopes(input.scopes, codeScopes)) ||
            row.token_endpoint_auth_method !== input.tokenEndpointAuthMethod ||
            input.inactivityExpiresAt <= row.transaction_now ||
            input.refresh.expiresAt <= row.transaction_now
          ) {
            return null;
          }

          const snapshot = mapGrantSnapshot({
            sid: input.grantId,
            principal_id: row.principal_id,
            subject: row.subject,
            authentication_epoch: row.authentication_epoch,
            binding_id: row.binding_id,
            binding_version: row.binding_version,
            agent_id: row.agent_id,
            agent_external_id: row.agent_external_id,
            client_id: row.client_id,
            resource: row.resource,
            scopes: codeScopes,
            inactivity_expires_at: input.inactivityExpiresAt
          });
          if (!snapshot) return null;

          const previousGrants = await transaction`
            SELECT id
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}
            WHERE principal_id = ${row.principal_id}
              AND binding_id = ${row.binding_id}
              AND oauth_client_id = ${row.oauth_client_id}
              AND resource = ${row.resource}
              AND status = 'active'
            LIMIT 2
            FOR UPDATE
          `;
          if (previousGrants.length > 1) {
            throw new Error("OAuth active-grant tuple is ambiguous");
          }
          if (previousGrants.length === 1) {
            await transaction`
              UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}
              SET status = 'superseded',
                  superseded_by = ${input.grantId},
                  updated_at = ${row.transaction_now}
              WHERE id = ${previousGrants[0].id}
                AND status = 'active'
            `;
          }

          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)} (
              id,
              principal_id,
              binding_id,
              oauth_client_id,
              resource,
              scopes,
              authentication_epoch,
              binding_version,
              status,
              current_refresh_generation,
              inactivity_expires_at,
              created_at,
              updated_at
            ) VALUES (
              ${input.grantId},
              ${row.principal_id},
              ${row.binding_id},
              ${row.oauth_client_id},
              ${row.resource},
              ${transaction.array(codeScopes)}::public.oauth_scope[],
              ${row.authentication_epoch},
              ${row.binding_version},
              'active',
              0,
              ${input.inactivityExpiresAt},
              ${row.transaction_now},
              ${row.transaction_now}
            )
          `;
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} (
              id,
              grant_id,
              generation,
              kind,
              jti_digest,
              reconstruction_nonce,
              effective_scopes,
              issued_at,
              expires_at
            ) VALUES (
              ${randomUUID()},
              ${input.grantId},
              0,
              'v2',
              ${input.refresh.jtiDigest},
              ${input.refresh.reconstructionNonce},
              ${transaction.array(codeScopes)}::public.oauth_scope[],
              ${input.refresh.issuedAt},
              ${input.refresh.expiresAt}
            )
          `;
          const consumed = await transaction`
            UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.authorizationCodes)}
            SET consumed_at = GREATEST(${row.transaction_now}, created_at)
            WHERE id = ${row.authorization_code_id}
              AND consumed_at IS NULL
            RETURNING id
          `;
          if (consumed.length !== 1) {
            throw new Error("OAuth authorization code consumption lost its lock");
          }
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              principal_id,
              binding_id,
              grant_id,
              oauth_client_id,
              request_id,
              actor_type,
              ip_fingerprint,
              user_agent_fingerprint,
              metadata,
              created_at
            ) VALUES (
              ${randomUUID()},
              'authorization_code_exchange',
              'issued',
              ${row.principal_id},
              ${row.binding_id},
              ${input.grantId},
              ${row.oauth_client_id},
              ${input.requestId},
              'connector',
              ${input.ipFingerprint ?? null},
              ${input.userAgentFingerprint ?? null},
              ${transaction.json(sanitizeSecurityMetadata(
                "authorization_code_exchange",
                { generation: 0 }
              ))},
              ${row.transaction_now}
            )
          `;
          return snapshot;
        });
      } catch (cause) {
        throw new OAuthStoreUnavailableError(undefined, { cause });
      }
    },

    async rotateRefreshToken(rawInput) {
      const input = rotateRefreshInput(
        rawInput,
        options.bootstrap.issuer,
        allowedResources
      );
      if (!input) return { kind: "invalid" };

      try {
        return await sql.begin(async (transaction) => {
          // All refresh and revocation paths take the family grant lock first.
          // This prevents a concurrent rotation from resurrecting a family
          // after a later explicit-revocation slice acquires the same lock.
          const grantRows = await transaction`
            SELECT
              grant_row.id AS sid,
              grant_row.status AS grant_status,
              grant_row.current_refresh_generation,
              grant_row.resource,
              grant_row.scopes::text[] AS grant_scopes,
              grant_row.authentication_epoch AS grant_authentication_epoch,
              grant_row.binding_version AS grant_binding_version,
              grant_row.inactivity_expires_at,
              principal.id AS principal_id,
              principal.issuer,
              principal.subject,
              principal.status AS principal_status,
              principal.authentication_epoch AS principal_authentication_epoch,
              binding.id AS binding_id,
              binding.status AS binding_status,
              binding.is_default,
              binding.binding_version AS current_binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              client.id AS oauth_client_id,
              client.client_id,
              client.status AS client_status
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)} AS grant_row
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
              ON principal.id = grant_row.principal_id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.id = grant_row.binding_id
              AND binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} AS client
              ON client.id = grant_row.oauth_client_id
            WHERE grant_row.id = ${input.token.sid}
            LIMIT 2
            FOR UPDATE OF grant_row
          `;
          if (grantRows.length !== 1) return { kind: "invalid" };
          // PostgreSQL CURRENT_TIMESTAMP is pinned to transaction start. A
          // contender may have waited on the family lock, so capture the wall
          // clock only after that lock is held and reuse this one DB value for
          // expiry, retry qualification, mutation, and audit timestamps.
          const clockRows = await transaction`
            SELECT pg_catalog.clock_timestamp() AS operation_now
          `;
          if (clockRows.length !== 1 || !isValidDate(clockRows[0].operation_now)) {
            throw new Error("OAuth refresh database clock is unavailable");
          }
          const operationNow = clockRows[0].operation_now;
          const grantRow = {
            ...grantRows[0],
            is_expired: grantRows[0].inactivity_expires_at <= operationNow
          };
          const inactive = inactiveDecision(grantRow);
          if (inactive) return inactive;
          if (
            grantRow.is_default !== true ||
            !refreshGrantClaimsAgree(input.token, grantRow)
          ) {
            return { kind: "revoked" };
          }
          const revokeReplay = async (replayReason) =>
            await revokeRefreshFamilyForReplay(transaction, {
              input,
              currentGeneration: grantRow.current_refresh_generation,
              operationNow,
              replayReason
            });

          // The presented descriptor is locked only after its grant. The
          // database timestamp returned here drives every mutation below.
          const presentedRows = await transaction`
            SELECT
              refresh.id,
              refresh.generation,
              refresh.kind,
              refresh.jti_digest,
              refresh.reconstruction_nonce,
              refresh.effective_scopes::text[] AS effective_scopes,
              refresh.issued_at,
              refresh.expires_at,
              refresh.consumed_at,
              refresh.replacement_generation,
              refresh.retry_deadline,
              refresh.request_fingerprint,
              ${operationNow}::timestamptz AS transaction_now,
              GREATEST(${operationNow}::timestamptz, refresh.issued_at) AS rotation_time,
              GREATEST(${operationNow}::timestamptz, refresh.issued_at)
                + ${input.refreshTokenTtlSeconds} * INTERVAL '1 second'
                AS replacement_expires_at,
              LEAST(
                GREATEST(${operationNow}::timestamptz, refresh.issued_at)
                  + ${input.retryGraceSeconds} * INTERVAL '1 second',
                GREATEST(${operationNow}::timestamptz, refresh.issued_at)
                  + ${input.refreshTokenTtlSeconds} * INTERVAL '1 second'
              ) AS next_retry_deadline
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} AS refresh
            WHERE refresh.grant_id = ${input.token.sid}
              AND refresh.generation = ${input.token.generation}
            LIMIT 2
            FOR UPDATE OF refresh
          `;
          if (presentedRows.length !== 1) {
            return await revokeReplay("token_generation_missing");
          }
          const presented = presentedRows[0];
          if (!sameBytes(presented.jti_digest, input.presentedJtiDigest)) {
            return await revokeReplay("unknown_jti");
          }
          if (!presentedRefreshRowAgrees(input, presented)) {
            return await revokeReplay("token_descriptor_mismatch");
          }
          if (
            presented.expires_at <= presented.transaction_now ||
            input.token.expiresAt <= presented.transaction_now
          ) {
            return { kind: "expired" };
          }

          if (input.token.generation === grantRow.current_refresh_generation) {
            if (
              presented.consumed_at !== null ||
              presented.replacement_generation !== null ||
              presented.retry_deadline !== null ||
              presented.request_fingerprint !== null
            ) {
              return await revokeReplay("current_generation_reuse");
            }
            if (
              input.clientId !== input.token.clientId ||
              input.resource !== input.token.resource
            ) {
              return { kind: "invalid" };
            }

            const consumed = await transaction`
              UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)}
              SET consumed_at = ${presented.rotation_time},
                  replacement_generation = ${input.replacement.generation},
                  retry_deadline = ${presented.next_retry_deadline},
                  request_fingerprint = ${input.requestFingerprint}
              WHERE id = ${presented.id}
                AND consumed_at IS NULL
              RETURNING id
            `;
            if (consumed.length !== 1) {
              throw new Error("OAuth refresh consumption lost its lock");
            }

            const replacementRows = await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} (
                id,
                grant_id,
                generation,
                kind,
                jti_digest,
                reconstruction_nonce,
                effective_scopes,
                issued_at,
                expires_at
              ) VALUES (
                ${randomUUID()},
                ${input.token.sid},
                ${input.replacement.generation},
                'v2',
                ${input.replacement.jtiDigest},
                ${input.replacement.reconstructionNonce},
                ${transaction.array(input.effectiveScopes)}::public.oauth_scope[],
                ${presented.rotation_time},
                ${presented.replacement_expires_at}
              )
              RETURNING
                generation,
                kind,
                reconstruction_nonce,
                effective_scopes::text[] AS effective_scopes,
                issued_at,
                expires_at,
                consumed_at
            `;
            if (replacementRows.length !== 1) {
              throw new Error("OAuth refresh replacement was not persisted");
            }

            const advanced = await transaction`
              UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}
              SET current_refresh_generation = ${input.replacement.generation},
                  inactivity_expires_at = ${presented.replacement_expires_at},
                  refreshed_at = ${presented.rotation_time},
                  updated_at = ${presented.rotation_time}
              WHERE id = ${input.token.sid}
                AND status = 'active'
                AND current_refresh_generation = ${input.token.generation}
              RETURNING id
            `;
            if (advanced.length !== 1) {
              throw new Error("OAuth refresh grant advancement lost its lock");
            }

            // Keep refresh audit references grant-only. Locking principal,
            // binding, or client FKs here would reverse the parent-to-grant
            // order used by authorization and operator transactions.
            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
                id,
                event_type,
                outcome,
                grant_id,
                request_id,
                actor_type,
                ip_fingerprint,
                user_agent_fingerprint,
                metadata,
                created_at
              ) VALUES (
                ${randomUUID()},
                'refresh_rotation',
                'rotated',
                ${input.token.sid},
                ${input.requestId},
                'connector',
                ${input.ipFingerprint},
                ${input.userAgentFingerprint},
                ${transaction.json(sanitizeSecurityMetadata("refresh_rotation", {
                  presented_generation: input.token.generation,
                  replacement_generation: input.replacement.generation
                }))},
                ${presented.rotation_time}
              )
            `;

            const grant = mapRefreshGrant(
              grantRow,
              input.effectiveScopes,
              presented.replacement_expires_at
            );
            const refresh = mapRefreshDescriptor(grant, replacementRows[0]);
            if (!grant || !refresh) {
              throw new Error("OAuth refresh result could not be reconstructed");
            }
            return Object.freeze({ kind: "rotated", grant, refresh });
          }

          if (input.token.generation !== grantRow.current_refresh_generation - 1) {
            return await revokeReplay("older_generation");
          }
          if (
            presented.consumed_at === null ||
            presented.replacement_generation !== grantRow.current_refresh_generation ||
            presented.retry_deadline === null
          ) {
            return await revokeReplay("retry_state_mismatch");
          }
          if (presented.retry_deadline < presented.transaction_now) {
            return await revokeReplay("retry_window_elapsed");
          }
          if (!sameBytes(presented.request_fingerprint, input.requestFingerprint)) {
            return await revokeReplay("request_fingerprint_mismatch");
          }

          const replacementRows = await transaction`
            SELECT
              refresh.generation,
              refresh.kind,
              refresh.reconstruction_nonce,
              refresh.effective_scopes::text[] AS effective_scopes,
              refresh.issued_at,
              refresh.expires_at,
              refresh.consumed_at
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} AS refresh
            WHERE refresh.grant_id = ${input.token.sid}
              AND refresh.generation = ${grantRow.current_refresh_generation}
            LIMIT 2
            FOR UPDATE OF refresh
          `;
          if (
            replacementRows.length !== 1 ||
            replacementRows[0].consumed_at !== null ||
            !sameScopes(
              replacementRows[0].effective_scopes,
              input.effectiveScopes
            )
          ) {
            return await revokeReplay("replacement_state_mismatch");
          }

          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              grant_id,
              request_id,
              actor_type,
              ip_fingerprint,
              user_agent_fingerprint,
              metadata,
              created_at
            ) VALUES (
              ${randomUUID()},
              'refresh_rotation',
              'retry',
              ${input.token.sid},
              ${input.requestId},
              'connector',
              ${input.ipFingerprint},
              ${input.userAgentFingerprint},
              ${transaction.json(sanitizeSecurityMetadata("refresh_rotation", {
                presented_generation: input.token.generation,
                replacement_generation: grantRow.current_refresh_generation
              }))},
              ${presented.transaction_now}
            )
          `;

          const grant = mapRefreshGrant(
            grantRow,
            replacementRows[0].effective_scopes,
            grantRow.inactivity_expires_at
          );
          const refresh = mapRefreshDescriptor(grant, replacementRows[0]);
          if (!grant || !refresh) {
            throw new Error("OAuth refresh retry could not be reconstructed");
          }
          return Object.freeze({ kind: "retry", grant, refresh });
        });
      } catch {
        // SQL parameters include keyed security material. Never retain the
        // driver cause on the public error object.
        throw new OAuthStoreUnavailableError();
      }
    },

    async migrateLegacyRefreshToken(rawInput) {
      const input = migrateLegacyRefreshInput(
        rawInput,
        options.bootstrap.issuer,
        allowedResources
      );
      if (!input) return Object.freeze({ kind: "invalid" });

      try {
        return await sql.begin(async (transaction) => {
          // Every principal/binding security control takes this conflicting
          // barrier before changing authority or grants. A legacy migration is
          // therefore wholly before the sweep (and gets revoked by it) or
          // wholly after it (and observes the advanced legacy_not_before).
          // The lock is also self-exclusive, which serializes the otherwise
          // nonexistent first grant for one legacy tuple.
          await transaction`SELECT public.oauth_lock_authorization_codes()`;

          const authorityRows = await transaction`
            SELECT
              principal.id AS principal_id,
              principal.issuer,
              principal.subject,
              principal.status AS principal_status,
              principal.authentication_epoch AS principal_authentication_epoch,
              principal.legacy_not_before,
              binding.id AS binding_id,
              binding.status AS binding_status,
              binding.is_default,
              binding.binding_version AS current_binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              client.id AS oauth_client_id,
              client.client_id,
              client.client_kind,
              client.redirect_uris,
              client.token_endpoint_auth_method,
              client.status AS client_status,
              client.created_at AS client_created_at,
              migration.source_checksum AS legacy_import_source_checksum,
              migration.outcome AS legacy_import_outcome,
              migration.report AS legacy_import_report,
              migration.completed_at AS legacy_import_completed_at
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            CROSS JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} AS client
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.stateMigrations)} AS migration
              ON migration.version = ${LEGACY_STATE_IMPORT_VERSION}
            WHERE principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
              AND client.client_id = ${input.token.clientId}
            LIMIT 2
            FOR UPDATE OF client
          `;
          if (authorityRows.length !== 1) {
            return Object.freeze({ kind: "invalid" });
          }
          const authorityRow = authorityRows[0];

          // Lock the permanent legacy digest tombstone and every prior tuple
          // grant in stable UUID order. A stale legacy token can never
          // supersede or reactivate a separately authorized v2 connection.
          const grantRows = await transaction`
            SELECT
              grant_row.id AS sid,
              grant_row.principal_id,
              grant_row.binding_id,
              grant_row.oauth_client_id,
              grant_row.resource,
              grant_row.scopes::text[] AS grant_scopes,
              grant_row.authentication_epoch AS grant_authentication_epoch,
              grant_row.binding_version AS grant_binding_version,
              grant_row.status AS grant_status,
              grant_row.current_refresh_generation,
              grant_row.inactivity_expires_at,
              grant_row.legacy_tuple_digest
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)} AS grant_row
            WHERE grant_row.legacy_tuple_digest = ${input.legacyTupleDigest}
               OR (
                 grant_row.principal_id = ${authorityRow.principal_id}
                 AND grant_row.oauth_client_id = ${authorityRow.oauth_client_id}
                 AND grant_row.resource = ${input.token.resource}
               )
            ORDER BY grant_row.id
            FOR UPDATE OF grant_row
          `;
          const clockRows = await transaction`
            SELECT pg_catalog.clock_timestamp() AS operation_now
          `;
          if (clockRows.length !== 1 || !isValidDate(clockRows[0].operation_now)) {
            throw new Error("OAuth legacy refresh database clock is unavailable");
          }
          const operationNow = clockRows[0].operation_now;
          const allowedScopes = normalizeScopes(authorityRow.allowed_scopes);
          const legacyImportReport = authorityRow.legacy_import_report;
          const authorityValid =
            expectedLegacyState !== null &&
            authorityRow.legacy_import_outcome === "imported" &&
            isByteArray(authorityRow.legacy_import_source_checksum) &&
            Buffer.from(authorityRow.legacy_import_source_checksum).equals(
              expectedLegacyState?.sourceChecksum
            ) &&
            validLegacyImportReport(legacyImportReport) &&
            legacyImportReport.clientsImported + legacyImportReport.clientsExisting ===
              expectedLegacyState?.clientCount &&
            legacyImportReport.codesImported + legacyImportReport.codesExpired ===
              expectedLegacyState?.codeCount &&
            isImportedLegacyDynamicClient(authorityRow) &&
            authorityRow.principal_status === "active" &&
            authorityRow.binding_status === "active" &&
            authorityRow.is_default === true &&
            authorityRow.issuer === input.token.issuer &&
            authorityRow.subject === input.token.subject &&
            authorityRow.agent_external_id === options.bootstrap.agentExternalId &&
            allowedScopes &&
            input.token.scopes.every((scope) => allowedScopes.includes(scope)) &&
            isValidDate(authorityRow.legacy_not_before) &&
            input.token.issuedAt >= authorityRow.legacy_not_before &&
            input.token.issuedAt <= authorityRow.legacy_import_completed_at &&
            input.token.issuedAt.getTime() <=
              operationNow.getTime() + LEGACY_TOKEN_CLOCK_SKEW_MILLISECONDS &&
            input.token.expiresAt > operationNow &&
            operationNow < acceptLegacyUntil;
          if (!authorityValid) {
            return Object.freeze({ kind: "invalid" });
          }

          const legacyGrant = grantRows.find((row) =>
            sameBytes(row.legacy_tuple_digest, input.legacyTupleDigest)
          );
          const activeOtherGrant = grantRows.find((row) =>
            row.grant_status === "active" && row !== legacyGrant
          );
          if (!legacyGrant && grantRows.length > 0) {
            return Object.freeze({ kind: "invalid" });
          }

          if (!legacyGrant) {
            if (
              input.clientId !== input.token.clientId ||
              input.resource !== input.token.resource
            ) {
              return Object.freeze({ kind: "invalid" });
            }
            const rotationTime = new Date(Math.max(
              operationNow.getTime(),
              input.token.issuedAt.getTime()
            ));
            const replacementExpiresAt = new Date(
              rotationTime.getTime() + input.refreshTokenTtlSeconds * 1_000
            );
            const retryDeadline = new Date(Math.min(
              rotationTime.getTime() + input.retryGraceSeconds * 1_000,
              replacementExpiresAt.getTime(),
              input.token.expiresAt.getTime()
            ));

            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)} (
                id,
                principal_id,
                binding_id,
                oauth_client_id,
                resource,
                scopes,
                authentication_epoch,
                binding_version,
                status,
                current_refresh_generation,
                inactivity_expires_at,
                legacy_tuple_digest,
                refreshed_at,
                created_at,
                updated_at
              ) VALUES (
                ${input.grantId},
                ${authorityRow.principal_id},
                ${authorityRow.binding_id},
                ${authorityRow.oauth_client_id},
                ${input.token.resource},
                ${transaction.array(input.token.scopes)}::public.oauth_scope[],
                ${authorityRow.principal_authentication_epoch},
                ${authorityRow.current_binding_version},
                'active',
                0,
                ${replacementExpiresAt},
                ${input.legacyTupleDigest},
                ${rotationTime},
                ${rotationTime},
                ${rotationTime}
              )
            `;
            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} (
                id,
                grant_id,
                generation,
                kind,
                jti_digest,
                reconstruction_nonce,
                effective_scopes,
                issued_at,
                expires_at,
                consumed_at,
                replacement_generation,
                retry_deadline,
                request_fingerprint
              ) VALUES (
                ${randomUUID()},
                ${input.grantId},
                -1,
                'legacy',
                ${input.presentedJtiDigest},
                NULL,
                ${transaction.array(input.token.scopes)}::public.oauth_scope[],
                ${input.token.issuedAt},
                ${input.token.expiresAt},
                ${rotationTime},
                0,
                ${retryDeadline},
                ${input.requestFingerprint}
              )
            `;
            const replacementRows = await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} (
                id,
                grant_id,
                generation,
                kind,
                jti_digest,
                reconstruction_nonce,
                effective_scopes,
                issued_at,
                expires_at
              ) VALUES (
                ${randomUUID()},
                ${input.grantId},
                0,
                'v2',
                ${input.replacement.jtiDigest},
                ${input.replacement.reconstructionNonce},
                ${transaction.array(input.effectiveScopes)}::public.oauth_scope[],
                ${rotationTime},
                ${replacementExpiresAt}
              )
              RETURNING
                generation,
                kind,
                reconstruction_nonce,
                effective_scopes::text[] AS effective_scopes,
                issued_at,
                expires_at,
                consumed_at
            `;
            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
                id,
                event_type,
                outcome,
                grant_id,
                request_id,
                actor_type,
                ip_fingerprint,
                user_agent_fingerprint,
                metadata,
                created_at
              ) VALUES (
                ${randomUUID()},
                'legacy_refresh_upgrade',
                'upgraded',
                ${input.grantId},
                ${input.requestId},
                'connector',
                ${input.ipFingerprint},
                ${input.userAgentFingerprint},
                ${transaction.json(sanitizeSecurityMetadata("legacy_refresh_upgrade", {
                  source_generation: -1,
                  replacement_generation: 0
                }))},
                ${rotationTime}
              )
            `;

            const grant = mapGrantSnapshot({
              sid: input.grantId,
              principal_id: authorityRow.principal_id,
              subject: authorityRow.subject,
              authentication_epoch: authorityRow.principal_authentication_epoch,
              binding_id: authorityRow.binding_id,
              binding_version: authorityRow.current_binding_version,
              agent_id: authorityRow.agent_id,
              agent_external_id: authorityRow.agent_external_id,
              client_id: authorityRow.client_id,
              resource: input.token.resource,
              scopes: input.effectiveScopes,
              inactivity_expires_at: replacementExpiresAt
            });
            const refresh = mapRefreshDescriptor(grant, replacementRows[0]);
            if (!grant || !refresh) {
              throw new Error("OAuth legacy refresh result could not be reconstructed");
            }
            return Object.freeze({ kind: "rotated", grant, refresh });
          }

          if (
            legacyGrant.grant_status === "expired" ||
            legacyGrant.inactivity_expires_at <= operationNow
          ) {
            return Object.freeze({ kind: "expired" });
          }
          if (legacyGrant.grant_status !== "active") {
            return Object.freeze({ kind: "revoked" });
          }
          if (
            activeOtherGrant ||
            legacyGrant.principal_id !== authorityRow.principal_id ||
            legacyGrant.binding_id !== authorityRow.binding_id ||
            legacyGrant.oauth_client_id !== authorityRow.oauth_client_id ||
            legacyGrant.resource !== input.token.resource ||
            legacyGrant.grant_authentication_epoch !==
              authorityRow.principal_authentication_epoch ||
            legacyGrant.grant_binding_version !==
              authorityRow.current_binding_version
          ) {
            return Object.freeze({ kind: "revoked" });
          }

          const replay = async (reason) => await revokeLegacyRefreshFamilyForReplay(
            transaction,
            {
              input,
              sid: legacyGrant.sid,
              currentGeneration: legacyGrant.current_refresh_generation,
              operationNow,
              replayReason: reason
            }
          );
          const presentedRows = await transaction`
            SELECT
              refresh.id,
              refresh.generation,
              refresh.kind,
              refresh.jti_digest,
              refresh.effective_scopes::text[] AS effective_scopes,
              refresh.issued_at,
              refresh.expires_at,
              refresh.consumed_at,
              refresh.replacement_generation,
              refresh.retry_deadline,
              refresh.request_fingerprint
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} AS refresh
            WHERE refresh.grant_id = ${legacyGrant.sid}
              AND refresh.generation = -1
            LIMIT 2
            FOR UPDATE OF refresh
          `;
          if (presentedRows.length !== 1) return await replay("legacy_descriptor_missing");
          const presented = presentedRows[0];
          if (!sameBytes(presented.jti_digest, input.presentedJtiDigest)) {
            return await replay("legacy_historical_jti");
          }
          if (
            !legacyPresentedRefreshRowAgrees(input, presented) ||
            !legacyRefreshGrantClaimsAgree(input, {
              ...authorityRow,
              ...legacyGrant
            })
          ) {
            return await replay("legacy_descriptor_mismatch");
          }
          if (legacyGrant.current_refresh_generation !== 0) {
            return await replay("legacy_older_generation");
          }
          if (
            presented.consumed_at === null ||
            presented.replacement_generation !== 0 ||
            presented.retry_deadline === null ||
            presented.request_fingerprint === null
          ) {
            return await replay("legacy_retry_state_mismatch");
          }
          if (presented.retry_deadline < operationNow) {
            return await replay("legacy_retry_window_elapsed");
          }
          if (!sameBytes(presented.request_fingerprint, input.requestFingerprint)) {
            return await replay("legacy_request_fingerprint_mismatch");
          }

          const replacementRows = await transaction`
            SELECT
              refresh.generation,
              refresh.kind,
              refresh.reconstruction_nonce,
              refresh.effective_scopes::text[] AS effective_scopes,
              refresh.issued_at,
              refresh.expires_at,
              refresh.consumed_at
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)} AS refresh
            WHERE refresh.grant_id = ${legacyGrant.sid}
              AND refresh.generation = 0
            LIMIT 2
            FOR UPDATE OF refresh
          `;
          if (
            replacementRows.length !== 1 ||
            replacementRows[0].kind !== "v2" ||
            replacementRows[0].consumed_at !== null ||
            !sameScopes(replacementRows[0].effective_scopes, input.effectiveScopes)
          ) {
            return await replay("legacy_replacement_state_mismatch");
          }
          await transaction`
            INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
              id,
              event_type,
              outcome,
              grant_id,
              request_id,
              actor_type,
              ip_fingerprint,
              user_agent_fingerprint,
              metadata,
              created_at
            ) VALUES (
              ${randomUUID()},
              'legacy_refresh_upgrade',
              'retry',
              ${legacyGrant.sid},
              ${input.requestId},
              'connector',
              ${input.ipFingerprint},
              ${input.userAgentFingerprint},
              ${transaction.json(sanitizeSecurityMetadata("legacy_refresh_upgrade", {
                source_generation: -1,
                replacement_generation: 0
              }))},
              ${operationNow}
            )
          `;

          const grant = mapGrantSnapshot({
            sid: legacyGrant.sid,
            principal_id: authorityRow.principal_id,
            subject: authorityRow.subject,
            authentication_epoch: authorityRow.principal_authentication_epoch,
            binding_id: authorityRow.binding_id,
            binding_version: authorityRow.current_binding_version,
            agent_id: authorityRow.agent_id,
            agent_external_id: authorityRow.agent_external_id,
            client_id: authorityRow.client_id,
            resource: legacyGrant.resource,
            scopes: replacementRows[0].effective_scopes,
            inactivity_expires_at: legacyGrant.inactivity_expires_at
          });
          const refresh = mapRefreshDescriptor(grant, replacementRows[0]);
          if (!grant || !refresh) {
            throw new Error("OAuth legacy refresh retry could not be reconstructed");
          }
          return Object.freeze({ kind: "retry", grant, refresh });
        });
      } catch {
        // Never retain legacy JTI/tuple digests or SQL parameters on the
        // public error object.
        throw new OAuthStoreUnavailableError();
      }
    },

    async revokeByTokenReference(rawInput) {
      const input = revokeTokenInput(rawInput);
      if (!input) return Object.freeze({ kind: "not_found" });

      try {
        return await sql.begin(async (transaction) => {
          // Refresh rotation and every family revocation path serialize on the
          // grant before touching descriptors. Joining the client is read-only
          // here so no parent lock is acquired after the grant lock.
          const grantRows = await transaction`
            SELECT
              grant_row.id,
              grant_row.status,
              client.client_id,
              client.status AS client_status,
              client.token_endpoint_auth_method
            FROM ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)} AS grant_row
            INNER JOIN ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.clients)} AS client
              ON client.id = grant_row.oauth_client_id
            WHERE grant_row.id = ${input.reference.sid}
            LIMIT 2
            FOR UPDATE OF grant_row
          `;
          if (grantRows.length !== 1) {
            return Object.freeze({ kind: "not_found" });
          }

          const grantRow = grantRows[0];
          if (
            input.clientId !== input.reference.clientId ||
            grantRow.client_id !== input.reference.clientId ||
            grantRow.client_status !== "active"
          ) {
            return Object.freeze({ kind: "not_found" });
          }

          // CURRENT_TIMESTAMP is pinned before lock waits. Capture one wall
          // clock value only after owning the family lock, then use it for all
          // mutations and the audit event.
          const clockRows = await transaction`
            SELECT pg_catalog.clock_timestamp() AS operation_now
          `;
          if (clockRows.length !== 1 || !isValidDate(clockRows[0].operation_now)) {
            throw new Error("OAuth revocation database clock is unavailable");
          }
          const operationNow = clockRows[0].operation_now;

          const revokedRows = await transaction`
            UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.grants)}
            SET status = 'revoked',
                revoked_at = ${operationNow},
                revoked_reason = ${CLIENT_TOKEN_REVOKED_REASON},
                updated_at = ${operationNow}
            WHERE id = ${input.reference.sid}
              AND status = 'active'
            RETURNING id
          `;
          const clippedRows = await transaction`
            UPDATE ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.refreshTokens)}
            SET expires_at = GREATEST(
              issued_at + INTERVAL '1 microsecond',
              LEAST(expires_at, ${operationNow})
            )
            WHERE grant_id = ${input.reference.sid}
              AND expires_at > GREATEST(
                issued_at + INTERVAL '1 microsecond',
                ${operationNow}
              )
            RETURNING id
          `;
          const changed = revokedRows.length === 1 || clippedRows.length > 0;

          if (changed) {
            // Audit only a real transition/repair and only the already-locked
            // grant. This keeps repeat revocation idempotent and prevents an
            // old public-client token from growing audit storage without
            // bound. Parent FKs would also reverse authorization lock order.
            await transaction`
              INSERT INTO ${transaction("public")}.${transaction(OAUTH_DATABASE_OBJECTS.auditEvents)} (
                id,
                event_type,
                outcome,
                grant_id,
                request_id,
                actor_type,
                ip_fingerprint,
                user_agent_fingerprint,
                metadata,
                created_at
              ) VALUES (
                ${randomUUID()},
                'token_revocation',
                'revoked',
                ${input.reference.sid},
                ${input.requestId},
                'connector',
                ${input.ipFingerprint},
                ${input.userAgentFingerprint},
                ${transaction.json(sanitizeSecurityMetadata(
                  "token_revocation",
                  { token_use: input.reference.tokenUse }
                ))},
                ${operationNow}
              )
            `;
          }

          return Object.freeze({ kind: changed ? "revoked" : "no_change" });
        });
      } catch {
        // Never retain SQL text, the signed reference, or connection details
        // on the public persistence error.
        throw new OAuthStoreUnavailableError();
      }
    },

    async resolveAccessContext({ claims } = {}) {
      if (claims?.legacy === true) {
        if (!validLegacyAccessClaims(
          claims,
          options.bootstrap.issuer,
          allowedResources
        )) {
          return Object.freeze({ kind: "invalid" });
        }

        let legacyRows;
        try {
          legacyRows = await sql`
            SELECT
              principal.id AS principal_id,
              principal.issuer,
              principal.subject,
              principal.status AS principal_status,
              principal.authentication_epoch,
              principal.legacy_not_before,
              binding.id AS binding_id,
              binding.status AS binding_status,
              binding.is_default,
              binding.binding_version,
              binding.allowed_scopes::text[] AS allowed_scopes,
              binding.agent_id,
              agent.external_id AS agent_external_id,
              client.client_id,
              client.client_kind,
              client.redirect_uris,
              client.token_endpoint_auth_method,
              client.status AS client_status,
              client.created_at AS client_created_at,
              migration.source_checksum AS legacy_import_source_checksum,
              migration.outcome AS legacy_import_outcome,
              migration.report AS legacy_import_report,
              migration.completed_at AS legacy_import_completed_at,
              pg_catalog.clock_timestamp() AS operation_now
            FROM ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.principals)} AS principal
            INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.bindings)} AS binding
              ON binding.principal_id = principal.id
            INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.agents)} AS agent
              ON agent.id = binding.agent_id
            CROSS JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.clients)} AS client
            INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.stateMigrations)} AS migration
              ON migration.version = ${LEGACY_STATE_IMPORT_VERSION}
            WHERE principal.issuer = ${options.bootstrap.issuer}
              AND principal.subject = ${options.bootstrap.subject}
              AND binding.is_default = TRUE
              AND agent.external_id = ${options.bootstrap.agentExternalId}
              AND client.client_id = ${claims.client_id}
            LIMIT 2
          `;
        } catch (cause) {
          throw new OAuthStoreUnavailableError(undefined, { cause });
        }
        if (legacyRows.length !== 1) {
          return Object.freeze({ kind: "invalid" });
        }

        const row = legacyRows[0];
        const scopes = normalizeScopes(claims.scope);
        const allowedScopes = normalizeScopes(row.allowed_scopes);
        const report = row.legacy_import_report;
        const issuedAt = new Date(claims.iat * 1_000);
        const expiresAt = new Date(claims.exp * 1_000);
        if (
          expectedLegacyState === null ||
          row.legacy_import_outcome !== "imported" ||
          !isByteArray(row.legacy_import_source_checksum) ||
          !Buffer.from(row.legacy_import_source_checksum).equals(
            expectedLegacyState.sourceChecksum
          ) ||
          !validLegacyImportReport(report) ||
          report.clientsImported + report.clientsExisting !==
            expectedLegacyState.clientCount ||
          report.codesImported + report.codesExpired !==
            expectedLegacyState.codeCount ||
          !isImportedLegacyDynamicClient(row) ||
          row.principal_status !== "active" ||
          row.binding_status !== "active" ||
          row.is_default !== true ||
          row.issuer !== claims.iss ||
          row.subject !== claims.sub ||
          row.agent_external_id !== options.bootstrap.agentExternalId ||
          !scopes ||
          !allowedScopes ||
          !scopes.every((scope) => allowedScopes.includes(scope)) ||
          !isValidDate(row.operation_now) ||
          !isValidDate(row.legacy_not_before) ||
          issuedAt < row.legacy_not_before ||
          issuedAt > row.legacy_import_completed_at ||
          issuedAt.getTime() >
            row.operation_now.getTime() + LEGACY_TOKEN_CLOCK_SKEW_MILLISECONDS ||
          expiresAt <= row.operation_now ||
          row.operation_now >= acceptLegacyUntil
        ) {
          return Object.freeze({ kind: "invalid" });
        }

        return Object.freeze({
          kind: "legacy-active",
          context: Object.freeze({
            principalId: row.principal_id,
            subject: row.subject,
            authenticationEpoch: row.authentication_epoch,
            bindingId: row.binding_id,
            bindingVersion: row.binding_version,
            agentId: row.agent_id,
            agentExternalId: row.agent_external_id,
            clientId: row.client_id,
            resource: claims.aud,
            scopes: Object.freeze(scopes),
            inactivityExpiresAt: expiresAt
          })
        });
      }

      if (!validAccessClaims(claims, options.bootstrap.issuer, allowedResources)) {
        return { kind: "invalid" };
      }

      let rows;
      try {
        rows = await sql`
          SELECT
            g.id AS sid,
            g.status AS grant_status,
            g.resource,
            g.scopes::text[] AS scopes,
            g.authentication_epoch AS grant_authentication_epoch,
            g.binding_version AS grant_binding_version,
            g.inactivity_expires_at,
            g.inactivity_expires_at <= CURRENT_TIMESTAMP AS is_expired,
            p.id AS principal_id,
            p.issuer,
            p.subject,
            p.status AS principal_status,
            p.authentication_epoch AS principal_authentication_epoch,
            b.id AS binding_id,
            b.status AS binding_status,
            b.binding_version AS current_binding_version,
            b.allowed_scopes::text[] AS allowed_scopes,
            b.agent_id,
            a.external_id AS agent_external_id,
            c.client_id,
            c.status AS client_status
          FROM ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.grants)} AS g
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.principals)} AS p
            ON p.id = g.principal_id
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.bindings)} AS b
            ON b.id = g.binding_id
            AND b.principal_id = p.id
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.agents)} AS a
            ON a.id = b.agent_id
          INNER JOIN ${sql("public")}.${sql(OAUTH_DATABASE_OBJECTS.clients)} AS c
            ON c.id = g.oauth_client_id
          WHERE g.id = ${claims.sid}
          LIMIT 2
        `;
      } catch (cause) {
        throw new OAuthStoreUnavailableError(undefined, { cause });
      }

      if (rows.length !== 1) return { kind: "invalid" };
      const row = rows[0];
      const inactive = inactiveDecision(row);
      if (inactive) return inactive;
      if (!claimsAgreeWithRow(claims, row)) return { kind: "invalid" };

      const effectiveScopes = normalizeScopes(claims.scope);
      if (!effectiveScopes) return { kind: "invalid" };

      return {
        kind: "active",
        context: Object.freeze({
          sid: row.sid,
          principalId: row.principal_id,
          subject: row.subject,
          authenticationEpoch: row.principal_authentication_epoch,
          bindingId: row.binding_id,
          bindingVersion: row.current_binding_version,
          agentId: row.agent_id,
          agentExternalId: row.agent_external_id,
          clientId: row.client_id,
          resource: row.resource,
          scopes: Object.freeze(effectiveScopes),
          inactivityExpiresAt: new Date(row.inactivity_expires_at.getTime())
        })
      };
    }
  });
}
