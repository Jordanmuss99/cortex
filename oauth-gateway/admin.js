import postgres from "postgres";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresTlsOptions } from "./oauth-store.js";

const OPERATOR_DATABASE_ENV = "MCP_OAUTH_OPERATOR_DATABASE_URL";
const OPERATOR_LOGIN_ROLE = "cortex_oauth_operator_user";
const OPERATOR_SEARCH_PATH = "pg_catalog, public";
const MAX_DATABASE_URL_LENGTH = 4_096;
const DEFAULT_GRANT_LIMIT = 100;
const MAX_GRANT_LIMIT = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const TERMINAL_UNSAFE_PATTERN = /[\u007f-\u009f\u2028\u2029\p{Cf}]/gu;
const GRANT_STATUSES = new Set(["active", "expired", "revoked", "superseded"]);
const OAUTH_SCOPE_ORDER = Object.freeze(["cortex:read", "cortex:write", "mcp"]);
const OAUTH_SCOPES = new Set(OAUTH_SCOPE_ORDER);

export const ADMIN_USAGE = Object.freeze([
  "Usage: oauth:admin -- grants list [--issuer <issuer>] [--subject <subject>] [--client-id <client-id>] [--agent <agent-id>] [--status <status>] [--limit <count>] [--json]",
  "       oauth:admin -- grants revoke --sid <uuid> --actor <actor> --reason <reason> [--json]",
  "       oauth:admin -- principals revoke-all|disable|security-logout --issuer <issuer> --subject <subject> --actor <actor> --reason <reason> [--json]",
  "       oauth:admin -- bindings disable --binding-id <uuid> --actor <actor> --reason <reason> [--json]",
  "       oauth:admin -- rollout status [--json]",
  "       oauth:admin -- recovery invalidate-issuer --issuer <issuer> --actor <actor> --reason <reason> --confirmation <exact-issuer> [--json]"
].join("\n"));

export class OAuthAdminUsageError extends Error {
  constructor() {
    super("Invalid OAuth administration command");
    this.name = "OAuthAdminUsageError";
  }
}

export class OAuthAdminUnavailableError extends Error {
  constructor() {
    super("OAuth administration failed");
    this.name = "OAuthAdminUnavailableError";
  }
}

function usageError() {
  return new OAuthAdminUsageError();
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw usageError();
  }
  return value;
}

function canonicalUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw usageError();
  }
  return value;
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_GRANT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(value)) throw usageError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_GRANT_LIMIT) throw usageError();
  return parsed;
}

function splitFormat(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw usageError();
  }
  let json = false;
  const command = [];
  for (const value of argv) {
    if (value === "--json") {
      if (json) throw usageError();
      json = true;
    } else {
      command.push(value);
    }
  }
  return Object.freeze({ argv: Object.freeze(command), json });
}

function parseFlags(values, allowed) {
  if (values.length % 2 !== 0) throw usageError();
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (
      !allowed.has(flag) ||
      parsed.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw usageError();
    }
    parsed.set(flag, value);
  }
  return parsed;
}

function requireExactFlags(parsed, required) {
  if (
    parsed.size !== required.length ||
    required.some((flag) => !parsed.has(flag))
  ) {
    throw usageError();
  }
}

function actorAndReason(parsed) {
  const actor = boundedText(parsed.get("--actor"), 256);
  const reason = boundedText(parsed.get("--reason"), 1_024);
  const maximumAuditMetadata = JSON.stringify({
    actor,
    reason,
    principal_count: 2_147_483_647,
    grant_count: 2_147_483_647,
    code_count: 2_147_483_647,
    session_count: 2_147_483_647
  });
  if (Buffer.byteLength(maximumAuditMetadata, "utf8") > 4_096) {
    throw usageError();
  }
  return Object.freeze({ actor, reason });
}

function parseAdminInvocation(argv) {
  const formatted = splitFormat(argv);
  const [group, action, ...values] = formatted.argv;
  let command;

  if (group === "grants" && action === "list") {
    const flags = parseFlags(
      values,
      new Set(["--issuer", "--subject", "--client-id", "--agent", "--status", "--limit"])
    );
    const status = flags.get("--status") ?? null;
    if (status !== null && !GRANT_STATUSES.has(status)) throw usageError();
    command = Object.freeze({
      kind: "grants.list",
      filter: Object.freeze({
        issuer: flags.has("--issuer") ? boundedText(flags.get("--issuer"), 2_048) : null,
        subject: flags.has("--subject") ? boundedText(flags.get("--subject"), 512) : null,
        clientId: flags.has("--client-id") ? boundedText(flags.get("--client-id"), 512) : null,
        agentExternalId: flags.has("--agent") ? boundedText(flags.get("--agent"), 64) : null,
        status,
        limit: parseLimit(flags.get("--limit"))
      })
    });
  } else if (group === "grants" && action === "revoke") {
    const flags = parseFlags(values, new Set(["--sid", "--actor", "--reason"]));
    requireExactFlags(flags, ["--sid", "--actor", "--reason"]);
    command = Object.freeze({
      kind: "grants.revoke",
      sid: canonicalUuid(flags.get("--sid")),
      ...actorAndReason(flags)
    });
  } else if (
    group === "principals" &&
    new Set(["revoke-all", "disable", "security-logout"]).has(action)
  ) {
    const flags = parseFlags(
      values,
      new Set(["--issuer", "--subject", "--actor", "--reason"])
    );
    requireExactFlags(flags, ["--issuer", "--subject", "--actor", "--reason"]);
    const kinds = {
      "revoke-all": "principals.revokeAll",
      disable: "principals.disable",
      "security-logout": "principals.securityLogout"
    };
    command = Object.freeze({
      kind: kinds[action],
      issuer: boundedText(flags.get("--issuer"), 2_048),
      subject: boundedText(flags.get("--subject"), 512),
      ...actorAndReason(flags)
    });
  } else if (group === "bindings" && action === "disable") {
    const flags = parseFlags(values, new Set(["--binding-id", "--actor", "--reason"]));
    requireExactFlags(flags, ["--binding-id", "--actor", "--reason"]);
    command = Object.freeze({
      kind: "bindings.disable",
      bindingId: canonicalUuid(flags.get("--binding-id")),
      ...actorAndReason(flags)
    });
  } else if (group === "rollout" && action === "status" && values.length === 0) {
    command = Object.freeze({ kind: "rollout.status" });
  } else if (group === "recovery" && action === "invalidate-issuer") {
    const flags = parseFlags(
      values,
      new Set(["--issuer", "--actor", "--reason", "--confirmation"])
    );
    requireExactFlags(flags, ["--issuer", "--actor", "--reason", "--confirmation"]);
    const issuer = boundedText(flags.get("--issuer"), 2_048);
    const confirmation = boundedText(flags.get("--confirmation"), 2_048);
    if (confirmation !== issuer) throw usageError();
    command = Object.freeze({
      kind: "recovery.invalidateIssuer",
      issuer,
      ...actorAndReason(flags),
      confirmation
    });
  } else {
    throw usageError();
  }

  return Object.freeze({ command, json: formatted.json });
}

/**
 * Parse the approved local operator command union. Formatting flags are
 * deliberately not carried into the returned security command.
 */
export function parseAdminCommand(argv) {
  return parseAdminInvocation(argv).command;
}

export function validateOperatorDatabaseUrl(databaseUrl) {
  if (
    typeof databaseUrl !== "string" ||
    databaseUrl.length === 0 ||
    databaseUrl.length > MAX_DATABASE_URL_LENGTH
  ) {
    throw new TypeError(`${OPERATOR_DATABASE_ENV} must be a fixed-role PostgreSQL URL`);
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TypeError(`${OPERATOR_DATABASE_ENV} must be a fixed-role PostgreSQL URL`);
  }
  if (
    !new Set(["postgres:", "postgresql:"]).has(parsed.protocol) ||
    !parsed.hostname ||
    databaseUrl.includes("#") ||
    (databaseUrl.includes("?") && parsed.search !== "?sslmode=verify-full")
  ) {
    throw new TypeError(`${OPERATOR_DATABASE_ENV} must be a fixed-role PostgreSQL URL`);
  }
  for (const [key, value] of parsed.searchParams) {
    if (
      key !== "sslmode" ||
      value !== "verify-full" ||
      parsed.searchParams.getAll(key).length !== 1
    ) {
      throw new TypeError(`${OPERATOR_DATABASE_ENV} must be a fixed-role PostgreSQL URL`);
    }
  }

  let username;
  let password;
  let database;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new TypeError(`${OPERATOR_DATABASE_ENV} must be a fixed-role PostgreSQL URL`);
  }
  if (
    username !== OPERATOR_LOGIN_ROLE ||
    password.length === 0 ||
    database.length === 0 ||
    database.includes("/")
  ) {
    throw new TypeError(`${OPERATOR_DATABASE_ENV} must be a fixed-role PostgreSQL URL`);
  }
  return Object.freeze({ database });
}

function safeInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new OAuthAdminUnavailableError();
  }
  return value;
}

function booleanValue(value) {
  if (typeof value !== "boolean") throw new OAuthAdminUnavailableError();
  return value;
}

function storedText(value, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new OAuthAdminUnavailableError();
  }
  return value;
}

function storedUuid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new OAuthAdminUnavailableError();
  }
  return value;
}

function isoTimestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new OAuthAdminUnavailableError();
  }
  return value.toISOString();
}

function stableScopes(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > OAUTH_SCOPES.size ||
    new Set(value).size !== value.length ||
    value.some((scope) => !OAUTH_SCOPES.has(scope)) ||
    value.some((scope, index) =>
      index > 0 &&
      OAUTH_SCOPE_ORDER.indexOf(value[index - 1]) >= OAUTH_SCOPE_ORDER.indexOf(scope)
    )
  ) {
    throw new OAuthAdminUnavailableError();
  }
  return Object.freeze([...value]);
}

function stableGrant(value) {
  if (!isRecord(value) || !GRANT_STATUSES.has(value.status)) {
    throw new OAuthAdminUnavailableError();
  }
  return Object.freeze({
    sid: storedUuid(value.sid),
    issuer: storedText(value.issuer, 2_048),
    subject: storedText(value.subject, 512),
    bindingId: storedUuid(value.bindingId),
    agentExternalId: storedText(value.agentExternalId, 64),
    clientId: storedText(value.clientId, 512),
    resource: storedText(value.resource, 2_048),
    scopes: stableScopes(value.scopes),
    status: value.status,
    currentRefreshGeneration: safeInteger(value.currentRefreshGeneration),
    inactivityExpiresAt: isoTimestamp(value.inactivityExpiresAt),
    refreshedAt: isoTimestamp(value.refreshedAt, true),
    revokedAt: isoTimestamp(value.revokedAt, true),
    revokedReason: storedText(value.revokedReason, 1_024, true),
    supersededBy: storedUuid(value.supersededBy, true),
    createdAt: isoTimestamp(value.createdAt),
    updatedAt: isoTimestamp(value.updatedAt)
  });
}

function stableNumericReport(value) {
  if (!isRecord(value)) throw new OAuthAdminUnavailableError();
  const keys = Object.keys(value).sort();
  if (keys.length > 32) throw new OAuthAdminUnavailableError();
  const report = {};
  for (const key of keys) {
    if (
      key.length < 1 ||
      key.length > 128 ||
      CONTROL_CHARACTER_PATTERN.test(key) ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(key)
    ) {
      throw new OAuthAdminUnavailableError();
    }
    report[key] = safeInteger(value[key]);
  }
  return Object.freeze(report);
}

function stableRolloutStatus(value) {
  if (!isRecord(value)) throw new OAuthAdminUnavailableError();
  const hasState = value.stateVersion !== null;
  return Object.freeze({
    stateVersion: hasState ? storedText(value.stateVersion, 128) : null,
    stateOutcome: hasState ? storedText(value.stateOutcome, 64) : null,
    stateStartedAt: hasState ? isoTimestamp(value.stateStartedAt) : null,
    stateCompletedAt: hasState ? isoTimestamp(value.stateCompletedAt) : null,
    stateReport: hasState ? stableNumericReport(value.stateReport) : null,
    principalCount: safeInteger(value.principalCount),
    activeBindingCount: safeInteger(value.activeBindingCount),
    activeClientCount: safeInteger(value.activeClientCount),
    activeGrantCount: safeInteger(value.activeGrantCount)
  });
}

function stableMutation(value, fields) {
  if (!isRecord(value)) throw new OAuthAdminUnavailableError();
  const stable = {
    matched: booleanValue(value.matched),
    changed: booleanValue(value.changed)
  };
  for (const [name, type] of fields) {
    if (type === "count") stable[name] = safeInteger(value[name]);
    else if (type === "nullableCount") {
      stable[name] = value[name] === null ? null : safeInteger(value[name]);
    } else if (type === "uuid") stable[name] = storedUuid(value[name]);
    else if (type === "nullableUuid") stable[name] = storedUuid(value[name], true);
  }
  return Object.freeze(stable);
}

/** Execute one parsed command against the narrow operator-store interface. */
export async function runAdminCommand(store, command) {
  if (!store || typeof store !== "object" || !command || typeof command !== "object") {
    throw new OAuthAdminUnavailableError();
  }
  switch (command.kind) {
    case "grants.list": {
      const value = await store.listRedactedGrants(command.filter);
      if (!isRecord(value) || !Array.isArray(value.grants) || typeof value.truncated !== "boolean") {
        throw new OAuthAdminUnavailableError();
      }
      return Object.freeze({
        kind: command.kind,
        grants: Object.freeze(value.grants.map(stableGrant)),
        truncated: value.truncated
      });
    }
    case "grants.revoke": {
      const value = stableMutation(
        await store.revokeGrant(command),
        [["sid", "nullableUuid"]]
      );
      return Object.freeze({ kind: command.kind, ...value });
    }
    case "principals.revokeAll": {
      const value = stableMutation(
        await store.revokePrincipal(command),
        [["grantCount", "count"], ["codeCount", "count"]]
      );
      return Object.freeze({ kind: command.kind, ...value });
    }
    case "principals.disable": {
      const value = stableMutation(
        await store.disablePrincipal(command),
        [["grantCount", "count"], ["codeCount", "count"], ["sessionCount", "count"]]
      );
      return Object.freeze({ kind: command.kind, ...value });
    }
    case "principals.securityLogout": {
      const value = stableMutation(
        await store.securityLogout(command),
        [["authenticationEpoch", "nullableCount"], ["grantCount", "count"], ["codeCount", "count"], ["sessionCount", "count"]]
      );
      return Object.freeze({ kind: command.kind, ...value });
    }
    case "bindings.disable": {
      const value = stableMutation(
        await store.disableBinding(command),
        [["bindingId", "nullableUuid"], ["grantCount", "count"], ["codeCount", "count"]]
      );
      return Object.freeze({ kind: command.kind, ...value });
    }
    case "rollout.status":
      return Object.freeze({
        kind: command.kind,
        status: stableRolloutStatus(await store.getRolloutStatus())
      });
    case "recovery.invalidateIssuer": {
      if (command.confirmation !== command.issuer) throw usageError();
      const value = stableMutation(
        await store.invalidateIssuer(command),
        [["principalCount", "count"], ["grantCount", "count"], ["codeCount", "count"], ["sessionCount", "count"]]
      );
      return Object.freeze({ kind: command.kind, ...value });
    }
    default:
      throw usageError();
  }
}

function dbResult(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0].result)) {
    throw new OAuthAdminUnavailableError();
  }
  return rows[0].result;
}

export function createPostgresOAuthAdminStore({ databaseUrl } = {}) {
  const authority = validateOperatorDatabaseUrl(databaseUrl);
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 20,
    max_lifetime: 30 * 60,
    connection: { search_path: OPERATOR_SEARCH_PATH },
    ...postgresTlsOptions(databaseUrl),
    onnotice: () => {}
  });
  let identityPromise = null;

  const assertIdentity = async () => {
    if (!identityPromise) {
      identityPromise = (async () => {
        const rows = await sql`
          SELECT CURRENT_USER AS current_user,
                 SESSION_USER AS session_user,
                 pg_catalog.current_database() AS current_database,
                 pg_catalog.current_setting('search_path') AS search_path
        `;
        if (
          rows.length !== 1 ||
          rows[0].current_user !== OPERATOR_LOGIN_ROLE ||
          rows[0].session_user !== OPERATOR_LOGIN_ROLE ||
          rows[0].current_database !== authority.database ||
          rows[0].search_path !== OPERATOR_SEARCH_PATH
        ) {
          throw new Error("operator database identity mismatch");
        }
      })();
    }
    await identityPromise;
  };

  const execute = async (operation) => {
    try {
      await assertIdentity();
      return await operation();
    } catch {
      throw new OAuthAdminUnavailableError();
    }
  };

  return Object.freeze({
    async close() {
      try {
        await sql.end({ timeout: 5 });
      } catch {
        throw new OAuthAdminUnavailableError();
      }
    },

    async listRedactedGrants(filter) {
      return await execute(async () => {
        const rows = await sql`
          SELECT grant_id AS sid,
                 issuer,
                 subject,
                 binding_id,
                 agent_external_id,
                 client_id,
                 resource,
                 scopes::text[] AS scopes,
                 status::text AS status,
                 current_refresh_generation,
                 inactivity_expires_at,
                 refreshed_at,
                 revoked_at,
                 revoked_reason,
                 superseded_by,
                 created_at,
                 updated_at
          FROM public.oauth_operator_grants
          WHERE (${filter.issuer}::text IS NULL OR issuer = ${filter.issuer})
            AND (${filter.subject}::text IS NULL OR subject = ${filter.subject})
            AND (${filter.clientId}::text IS NULL OR client_id = ${filter.clientId})
            AND (${filter.agentExternalId}::text IS NULL OR agent_external_id = ${filter.agentExternalId})
            AND (${filter.status}::text IS NULL OR status::text = ${filter.status})
          ORDER BY created_at DESC, grant_id ASC
          LIMIT ${filter.limit + 1}
        `;
        const grants = rows.slice(0, filter.limit).map((row) => ({
          sid: row.sid,
          issuer: row.issuer,
          subject: row.subject,
          bindingId: row.binding_id,
          agentExternalId: row.agent_external_id,
          clientId: row.client_id,
          resource: row.resource,
          scopes: row.scopes,
          status: row.status,
          currentRefreshGeneration: row.current_refresh_generation,
          inactivityExpiresAt: row.inactivity_expires_at,
          refreshedAt: row.refreshed_at,
          revokedAt: row.revoked_at,
          revokedReason: row.revoked_reason,
          supersededBy: row.superseded_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }));
        return Object.freeze({ grants: Object.freeze(grants), truncated: rows.length > filter.limit });
      });
    },

    async revokeGrant(input) {
      return await execute(async () => {
        const result = dbResult(await sql`
          SELECT public.oauth_operator_revoke_grant(
            ${input.sid}::uuid, ${input.actor}, ${input.reason}
          ) AS result
        `);
        return {
          matched: result.matched,
          changed: result.changed,
          sid: result.grant_id
        };
      });
    },

    async revokePrincipal(input) {
      return await execute(async () => {
        const result = dbResult(await sql`
          SELECT public.oauth_operator_revoke_all_for_principal(
            ${input.issuer}, ${input.subject}, ${input.actor}, ${input.reason}
          ) AS result
        `);
        return {
          matched: result.matched,
          changed: result.changed,
          grantCount: result.grant_count,
          codeCount: result.code_count
        };
      });
    },

    async disablePrincipal(input) {
      return await execute(async () => {
        const result = dbResult(await sql`
          SELECT public.oauth_operator_disable_principal(
            ${input.issuer}, ${input.subject}, ${input.actor}, ${input.reason}
          ) AS result
        `);
        return {
          matched: result.matched,
          changed: result.changed,
          grantCount: result.grant_count,
          codeCount: result.code_count,
          sessionCount: result.session_count
        };
      });
    },

    async disableBinding(input) {
      return await execute(async () => {
        const result = dbResult(await sql`
          SELECT public.oauth_operator_disable_binding(
            ${input.bindingId}::uuid, ${input.actor}, ${input.reason}
          ) AS result
        `);
        return {
          matched: result.matched,
          changed: result.changed,
          bindingId: result.binding_id,
          grantCount: result.grant_count,
          codeCount: result.code_count
        };
      });
    },

    async securityLogout(input) {
      return await execute(async () => {
        const result = dbResult(await sql`
          SELECT public.oauth_operator_security_logout(
            ${input.issuer}, ${input.subject}, ${input.actor}, ${input.reason}
          ) AS result
        `);
        return {
          matched: result.matched,
          changed: result.changed,
          authenticationEpoch: result.authentication_epoch,
          grantCount: result.grant_count,
          codeCount: result.code_count,
          sessionCount: result.session_count
        };
      });
    },

    async getRolloutStatus() {
      return await execute(async () => {
        const rows = await sql`
          SELECT state_version,
                 state_outcome::text AS state_outcome,
                 state_started_at,
                 state_completed_at,
                 state_report,
                 principal_count::integer AS principal_count,
                 active_binding_count::integer AS active_binding_count,
                 active_client_count::integer AS active_client_count,
                 active_grant_count::integer AS active_grant_count
          FROM public.oauth_operator_rollout_status
        `;
        if (rows.length !== 1) throw new OAuthAdminUnavailableError();
        return {
          stateVersion: rows[0].state_version,
          stateOutcome: rows[0].state_outcome,
          stateStartedAt: rows[0].state_started_at,
          stateCompletedAt: rows[0].state_completed_at,
          stateReport: rows[0].state_report,
          principalCount: rows[0].principal_count,
          activeBindingCount: rows[0].active_binding_count,
          activeClientCount: rows[0].active_client_count,
          activeGrantCount: rows[0].active_grant_count
        };
      });
    },

    async invalidateIssuer(input) {
      return await execute(async () => {
        const result = dbResult(await sql`
          SELECT public.oauth_operator_invalidate_issuer(
            ${input.issuer}, ${input.actor}, ${input.reason}
          ) AS result
        `);
        return {
          matched: result.matched,
          changed: result.changed,
          principalCount: result.principal_count,
          grantCount: result.grant_count,
          codeCount: result.code_count,
          sessionCount: result.session_count
        };
      });
    }
  });
}

export function formatAdminResult(result, json = false) {
  let serialized;
  try {
    serialized = JSON.stringify(result, null, json ? 0 : 2).replace(
      TERMINAL_UNSAFE_PATTERN,
      (character) => {
        const codePoint = character.codePointAt(0);
        if (codePoint <= 0xffff) {
          return `\\u${codePoint.toString(16).padStart(4, "0")}`;
        }
        const offset = codePoint - 0x10000;
        const high = 0xd800 + (offset >> 10);
        const low = 0xdc00 + (offset & 0x3ff);
        return `\\u${high.toString(16)}\\u${low.toString(16)}`;
      }
    );
  } catch {
    throw new OAuthAdminUnavailableError();
  }
  if (typeof serialized !== "string") throw new OAuthAdminUnavailableError();
  return `${json ? "" : "OAuth administration result\n"}${serialized}\n`;
}

function resultMatched(result) {
  return !new Set(["grants.list", "rollout.status"]).has(result.kind)
    ? result.matched
    : true;
}

/**
 * Run the local-only CLI with injectable boundaries for deterministic tests.
 * Returns an exit status and never calls process.exit().
 */
export async function runAdminCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  openStore = createPostgresOAuthAdminStore
} = {}) {
  let invocation;
  try {
    invocation = parseAdminInvocation(argv);
  } catch {
    const json = Array.isArray(argv) && argv.filter((value) => value === "--json").length === 1;
    stderr.write(json ? '{"error":"invalid_command"}\n' : `${ADMIN_USAGE}\n`);
    return 2;
  }

  let store = null;
  let result = null;
  let failed = false;
  try {
    const databaseUrl = env?.[OPERATOR_DATABASE_ENV];
    validateOperatorDatabaseUrl(databaseUrl);
    store = await openStore({ databaseUrl });
    result = await runAdminCommand(store, invocation.command);
  } catch {
    failed = true;
  }

  if (store && typeof store.close === "function") {
    try {
      await store.close();
    } catch {
      failed = true;
    }
  }

  if (failed || result === null) {
    stderr.write(
      invocation.json
        ? '{"error":"admin_failed"}\n'
        : "OAuth administration failed\n"
    );
    return 1;
  }

  stdout.write(formatAdminResult(result, invocation.json));
  return resultMatched(result) ? 0 : 3;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runAdminCli();
}
