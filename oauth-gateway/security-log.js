const MAX_COUNT = 1_000_000_000;

const INTEGER_FIELDS = new Set([
  "audit_event_count",
  "authorization_code_count",
  "clientsExisting",
  "clientsImported",
  "codesExpired",
  "codesImported",
  "current_generation",
  "generation",
  "grant_count",
  "login_session_count",
  "presented_generation",
  "principal_count",
  "refresh_token_count",
  "replacement_generation",
  "session_count",
  "sourceVersion",
  "source_generation",
]);
const NEGATIVE_ONE_INTEGER_FIELDS = new Set([
  "presented_generation",
  "source_generation",
]);

const FIXED_STRING_FIELDS = Object.freeze({
  dependency: new Set(["database", "schema", "bootstrap", "legacy_import", "rest", "mcp"]),
  event_type: new Set([
    "agent_mismatch",
    "authorization_code_exchange",
    "browser_authorization",
    "browser_login_session",
    "legacy_login_session_upgrade",
    "legacy_refresh_upgrade",
    "legacy_state_import",
    "refresh_replay",
    "refresh_rotation",
    "token_revocation",
  ]),
  reason: new Set([
    "current_generation_reuse",
    "legacy_descriptor_mismatch",
    "legacy_descriptor_missing",
    "legacy_historical_jti",
    "legacy_older_generation",
    "legacy_request_fingerprint_mismatch",
    "legacy_replacement_state_mismatch",
    "legacy_retry_state_mismatch",
    "legacy_retry_window_elapsed",
    "older_generation",
    "replacement_state_mismatch",
    "request_fingerprint_mismatch",
    "retry_state_mismatch",
    "retry_window_elapsed",
    "shutdown",
    "startup",
    "token_descriptor_mismatch",
    "token_generation_missing",
    "unknown_jti",
  ]),
  surface: new Set(["mcp", "rest"]),
  token_use: new Set(["access", "refresh"]),
  version: new Set(["legacy-oauth-state-v1"]),
});

const EVENT_FIELDS = Object.freeze({
  agent_mismatch: new Set(["surface"]),
  audit_write_failed: new Set(["event_type"]),
  authorization_code_exchange: new Set(["generation"]),
  browser_authorization: new Set(),
  browser_login_session: new Set(),
  dependency_not_ready: new Set(["dependency"]),
  gateway_prune: new Set([
    "audit_event_count",
    "authorization_code_count",
    "grant_count",
    "login_session_count",
    "refresh_token_count",
  ]),
  gateway_shutdown: new Set(["reason"]),
  gateway_started: new Set(),
  legacy_login_session_upgrade: new Set(["sourceVersion"]),
  legacy_refresh_upgrade: new Set(["source_generation", "replacement_generation"]),
  legacy_state_import: new Set([
    "version",
    "clientsImported",
    "clientsExisting",
    "codesImported",
    "codesExpired",
  ]),
  refresh_replay: new Set(["reason", "presented_generation", "current_generation"]),
  refresh_rotation: new Set(["presented_generation", "replacement_generation"]),
  token_revocation: new Set(["token_use"]),
});

const OUTCOMES = new Set([
  "completed",
  "created",
  "failed",
  "imported",
  "issued",
  "not_ready",
  "rejected",
  "retry",
  "revoked",
  "rotated",
  "started",
  "stopped",
  "upgraded",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeMetadataValue(key, value) {
  if (INTEGER_FIELDS.has(key)) {
    const minimum = NEGATIVE_ONE_INTEGER_FIELDS.has(key) ? -1 : 0;
    return Number.isSafeInteger(value) && value >= minimum && value <= MAX_COUNT
      ? value
      : undefined;
  }
  const allowed = FIXED_STRING_FIELDS[key];
  return typeof value === "string" && allowed?.has(value) ? value : undefined;
}

/**
 * Reduce security metadata to fixed, event-specific scalar fields. Unknown
 * event names, keys, values, objects, and arrays are intentionally discarded.
 */
export function sanitizeSecurityMetadata(eventType, metadata) {
  const allowedFields = EVENT_FIELDS[eventType];
  if (!allowedFields || !isRecord(metadata)) return Object.freeze({});

  const sanitized = {};
  for (const key of allowedFields) {
    if (!Object.hasOwn(metadata, key)) continue;
    const value = safeMetadataValue(key, metadata[key]);
    if (value !== undefined) sanitized[key] = value;
  }
  return Object.freeze(sanitized);
}

/**
 * Create a cause-free structured security logger. The sink receives only a
 * small immutable object; sink failures never affect authorization behavior.
 */
export function createSecurityLogger(sink) {
  if (typeof sink !== "function") {
    throw new TypeError("security log sink must be a function");
  }

  return Object.freeze({
    event(eventType, outcome, metadata = {}) {
      if (!Object.hasOwn(EVENT_FIELDS, eventType) || !OUTCOMES.has(outcome)) {
        return false;
      }
      const entry = Object.freeze({
        component: "oauth_gateway",
        event: eventType,
        outcome,
        metadata: sanitizeSecurityMetadata(eventType, metadata),
      });
      try {
        sink(entry);
        return true;
      } catch {
        return false;
      }
    },
  });
}

export const SECURITY_AUDIT_EVENT_TYPES = Object.freeze(
  new Set([
    "agent_mismatch",
    "authorization_code_exchange",
    "browser_authorization",
    "browser_login_session",
    "legacy_login_session_upgrade",
    "legacy_refresh_upgrade",
    "legacy_state_import",
    "refresh_replay",
    "refresh_rotation",
    "token_revocation",
  ])
);
