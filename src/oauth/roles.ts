import postgres, { type Sql, type TransactionSql } from "postgres";
import { isIP } from "node:net";

export const OAUTH_GATEWAY_LOGIN_ROLE = "cortex_oauth_gateway" as const;
export const OAUTH_OPERATOR_LOGIN_ROLE = "cortex_oauth_operator_user" as const;
export const OAUTH_RUNTIME_CAPABILITY_ROLE = "cortex_oauth_runtime" as const;
export const OAUTH_OPERATOR_CAPABILITY_ROLE = "cortex_oauth_operator" as const;

export interface OAuthRoleConfig {
  ownerDatabaseUrl: string;
  gatewayDatabaseUrl: string;
  operatorDatabaseUrl: string;
  gatewayLoginRole: typeof OAUTH_GATEWAY_LOGIN_ROLE;
  operatorLoginRole: typeof OAUTH_OPERATOR_LOGIN_ROLE;
}

interface ParsedDatabaseUrl {
  raw: string;
  username: string;
  password: string;
  host: string;
  port: string;
  database: string;
  sslMode: string | null;
}

const ALLOWED_DATABASE_SSL_MODES = new Set(["verify-full"]);

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} contains invalid URL encoding`);
  }
}

function parseDatabaseUrl(raw: string, label: string): ParsedDatabaseUrl {
  if (!raw) throw new Error(`${label} is required`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${label} must use the postgresql protocol`);
  }
  if (
    raw.includes("#") ||
    (raw.includes("?") && url.search !== "?sslmode=verify-full")
  ) {
    throw new Error(`${label} contains unsupported URL parameters`);
  }
  for (const [key, value] of url.searchParams) {
    if (
      key !== "sslmode" ||
      url.searchParams.getAll(key).length !== 1 ||
      !ALLOWED_DATABASE_SSL_MODES.has(value)
    ) {
      throw new Error(`${label} contains unsupported URL parameters`);
    }
  }

  const username = decodeUrlComponent(url.username, `${label} username`);
  const password = decodeUrlComponent(url.password, `${label} password`);
  const database = decodeUrlComponent(url.pathname.replace(/^\//, ""), `${label} database`);
  if (!username || !database || database.includes("/")) {
    throw new Error(`${label} must include a username and database name`);
  }

  return {
    raw,
    username,
    password,
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database,
    sslMode: url.searchParams.get("sslmode"),
  };
}

export function isPrivateDatabaseHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return isIP(host) === 6 && /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host);
}

function postgresTlsOptions(parsed: ParsedDatabaseUrl): { ssl?: "verify-full" } {
  return !isPrivateDatabaseHost(parsed.host) && parsed.sslMode === null
    ? { ssl: "verify-full" }
    : {};
}

function sameDatabase(left: ParsedDatabaseUrl, right: ParsedDatabaseUrl): boolean {
  return (
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database
  );
}

function parsedRoleConfig(config: OAuthRoleConfig): {
  owner: ParsedDatabaseUrl;
  gateway: ParsedDatabaseUrl;
  operator: ParsedDatabaseUrl;
} {
  if (config.gatewayLoginRole !== OAUTH_GATEWAY_LOGIN_ROLE) {
    throw new Error(`Gateway login role must be ${OAUTH_GATEWAY_LOGIN_ROLE}`);
  }
  if (config.operatorLoginRole !== OAUTH_OPERATOR_LOGIN_ROLE) {
    throw new Error(`Operator login role must be ${OAUTH_OPERATOR_LOGIN_ROLE}`);
  }

  const owner = parseDatabaseUrl(config.ownerDatabaseUrl, "ownerDatabaseUrl");
  const gateway = parseDatabaseUrl(config.gatewayDatabaseUrl, "gatewayDatabaseUrl");
  const operator = parseDatabaseUrl(config.operatorDatabaseUrl, "operatorDatabaseUrl");

  if (!sameDatabase(owner, gateway) || !sameDatabase(owner, operator)) {
    throw new Error("Owner, gateway, and operator URLs must target the same PostgreSQL database");
  }
  if (gateway.username !== OAUTH_GATEWAY_LOGIN_ROLE) {
    throw new Error(`Gateway URL username must be ${OAUTH_GATEWAY_LOGIN_ROLE}`);
  }
  if (operator.username !== OAUTH_OPERATOR_LOGIN_ROLE) {
    throw new Error(`Operator URL username must be ${OAUTH_OPERATOR_LOGIN_ROLE}`);
  }
  if (
    new Set([
      OAUTH_GATEWAY_LOGIN_ROLE,
      OAUTH_OPERATOR_LOGIN_ROLE,
      OAUTH_RUNTIME_CAPABILITY_ROLE,
      OAUTH_OPERATOR_CAPABILITY_ROLE,
    ]).has(owner.username as typeof OAUTH_GATEWAY_LOGIN_ROLE)
  ) {
    throw new Error("Migration owner must be distinct from the runtime login roles");
  }
  if (!owner.password || !gateway.password || !operator.password) {
    throw new Error("OAuth database URLs must include distinct passwords");
  }
  if (
    owner.password === gateway.password ||
    owner.password === operator.password ||
    gateway.password === operator.password
  ) {
    throw new Error("OAuth database URLs must include distinct passwords");
  }

  return { owner, gateway, operator };
}

export function validateOAuthRoleConfig(config: OAuthRoleConfig): void {
  parsedRoleConfig(config);
}

async function assertDatabaseIdentity(
  sql: Sql,
  expected: ParsedDatabaseUrl,
  label: string
): Promise<void> {
  const rows = (await sql`
    SELECT
      CURRENT_USER AS current_user,
      SESSION_USER AS session_user,
      pg_catalog.current_database() AS current_database
  `) as unknown as Array<{
    current_user: string;
    session_user: string;
    current_database: string;
  }>;
  if (
    rows.length !== 1 ||
    rows[0].current_user !== expected.username ||
    rows[0].session_user !== expected.username ||
    rows[0].current_database !== expected.database
  ) {
    throw new Error(`${label} database identity does not match its URL`);
  }
}

export async function assertOAuthOwnerDatabaseIdentity(
  sql: Sql,
  config: OAuthRoleConfig
): Promise<void> {
  await assertDatabaseIdentity(sql, parsedRoleConfig(config).owner, "Migration owner");
}

const PROTECTED_ROLE_NAMES = [
  OAUTH_GATEWAY_LOGIN_ROLE,
  OAUTH_OPERATOR_LOGIN_ROLE,
  OAUTH_RUNTIME_CAPABILITY_ROLE,
  OAUTH_OPERATOR_CAPABILITY_ROLE,
] as const;

const OPERATOR_FUNCTION_SIGNATURES = [
  "public.oauth_operator_revoke_grant(uuid,text,text)",
  "public.oauth_operator_revoke_all_for_principal(text,text,text,text)",
  "public.oauth_operator_disable_principal(text,text,text,text)",
  "public.oauth_operator_disable_binding(uuid,text,text)",
  "public.oauth_operator_security_logout(text,text,text,text)",
  "public.oauth_operator_invalidate_issuer(text,text,text)",
] as const;

const RUNTIME_FUNCTION_SIGNATURES = [
  "public.oauth_redirect_uris_are_canonical(text[])",
  "public.oauth_audit_metadata_is_safe(jsonb)",
  "public.oauth_lock_authorization_codes()",
  "public.oauth_lock_login_sessions()",
  "public.oauth_prune_expired(timestamp with time zone,integer)",
] as const;

const RUNTIME_SECURITY_DEFINER_FUNCTION_SIGNATURES = [
  "public.oauth_lock_authorization_codes()",
  "public.oauth_lock_login_sessions()",
  "public.oauth_prune_expired(timestamp with time zone,integer)",
] as const;

const RUNTIME_UPDATE_COLUMNS = {
  oauth_clients: [
    "redirect_uris",
    "client_name",
    "token_endpoint_auth_method",
    "status",
    "updated_at",
  ],
  oauth_authorization_codes: ["consumed_at"],
  oauth_grants: [
    "status",
    "current_refresh_generation",
    "inactivity_expires_at",
    "refreshed_at",
    "revoked_at",
    "revoked_reason",
    "superseded_by",
    "updated_at",
  ],
  oauth_refresh_tokens: [
    "expires_at",
    "consumed_at",
    "replacement_generation",
    "retry_deadline",
    "request_fingerprint",
  ],
  oauth_login_sessions: ["expires_at", "revoked_at", "revoked_reason"],
} as const;

async function hasTablePrivilege(
  transaction: TransactionSql,
  role: string,
  relation: string,
  privilege: string
): Promise<boolean> {
  const rows = (await transaction`
    SELECT has_table_privilege(${role}, ${`public.${relation}`}, ${privilege}) AS allowed
  `) as unknown as Array<{ allowed: boolean }>;
  return rows[0]?.allowed === true;
}

async function hasColumnPrivilege(
  transaction: TransactionSql,
  role: string,
  relation: string,
  column: string,
  privilege: string
): Promise<boolean> {
  const rows = (await transaction`
    SELECT has_column_privilege(
      ${role},
      ${`public.${relation}`},
      ${column},
      ${privilege}
    ) AS allowed
  `) as unknown as Array<{ allowed: boolean }>;
  return rows[0]?.allowed === true;
}

async function requireTablePrivilege(
  transaction: TransactionSql,
  role: string,
  relation: string,
  privilege: string,
  expected: boolean
): Promise<void> {
  const actual = await hasTablePrivilege(transaction, role, relation, privilege);
  if (actual !== expected) {
    throw new Error(
      `OAuth role privilege assertion failed for ${role} ${privilege} on public.${relation}`
    );
  }
}

async function requireColumnPrivilege(
  transaction: TransactionSql,
  role: string,
  relation: string,
  column: string,
  expected: boolean
): Promise<void> {
  const actual = await hasColumnPrivilege(
    transaction,
    role,
    relation,
    column,
    "SELECT"
  );
  if (actual !== expected) {
    throw new Error(
      `OAuth role column privilege assertion failed for ${role} on public.${relation}.${column}`
    );
  }
}

async function requireAnyColumnPrivilege(
  transaction: TransactionSql,
  role: string,
  relation: string,
  privilege: "SELECT" | "INSERT" | "UPDATE" | "REFERENCES",
  expected: boolean
): Promise<void> {
  const rows = (await transaction`
    SELECT has_any_column_privilege(
      ${role},
      ${`public.${relation}`},
      ${privilege}
    ) AS allowed
  `) as unknown as Array<{ allowed: boolean }>;
  if (rows[0]?.allowed !== expected) {
    throw new Error(
      `OAuth role column privilege assertion failed for ${role} ${privilege} on public.${relation}`
    );
  }
}

async function assertNoUnsafeRoleState(transaction: TransactionSql): Promise<void> {
  const ownershipRows = await transaction`
    WITH protected_roles AS (
      SELECT oid, rolname
      FROM pg_catalog.pg_roles
      WHERE rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
    )
    SELECT protected_role.rolname, 'database' AS object_type, database.datname AS object_name
    FROM pg_catalog.pg_database AS database
    JOIN protected_roles AS protected_role ON protected_role.oid = database.datdba
    UNION ALL
    SELECT protected_role.rolname, 'schema', namespace.nspname
    FROM pg_catalog.pg_namespace AS namespace
    JOIN protected_roles AS protected_role ON protected_role.oid = namespace.nspowner
    UNION ALL
    SELECT protected_role.rolname, 'relation', namespace.nspname || '.' || relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN protected_roles AS protected_role ON protected_role.oid = relation.relowner
    UNION ALL
    SELECT protected_role.rolname, 'function', procedure.oid::regprocedure::text
    FROM pg_catalog.pg_proc AS procedure
    JOIN protected_roles AS protected_role ON protected_role.oid = procedure.proowner
    UNION ALL
    SELECT protected_role.rolname, 'type', namespace.nspname || '.' || type.typname
    FROM pg_catalog.pg_type AS type
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
    JOIN protected_roles AS protected_role ON protected_role.oid = type.typowner
    LIMIT 1
  `;
  if (ownershipRows.length > 0) {
    throw new Error("OAuth roles must not own database objects");
  }

  const directLoginPrivilegeRows = await transaction`
    WITH login_roles AS (
      SELECT oid, rolname
      FROM pg_catalog.pg_roles
      WHERE rolname IN (${OAUTH_GATEWAY_LOGIN_ROLE}, ${OAUTH_OPERATOR_LOGIN_ROLE})
    ), direct_privileges AS (
      SELECT login_role.rolname
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      JOIN login_roles AS login_role ON login_role.oid = privilege.grantee
      UNION ALL
      SELECT login_role.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      JOIN login_roles AS login_role ON login_role.oid = privilege.grantee
      UNION ALL
      SELECT login_role.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      JOIN login_roles AS login_role ON login_role.oid = privilege.grantee
      WHERE attribute.attnum > 0
      UNION ALL
      SELECT login_role.rolname
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
      JOIN login_roles AS login_role ON login_role.oid = privilege.grantee
      UNION ALL
      SELECT login_role.rolname
      FROM pg_catalog.pg_type AS type
      CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) AS privilege
      JOIN login_roles AS login_role ON login_role.oid = privilege.grantee
    )
    SELECT rolname FROM direct_privileges LIMIT 1
  `;
  if (directLoginPrivilegeRows.length > 0) {
    throw new Error("OAuth login roles must not retain direct object privileges");
  }

  const outOfBoundaryPrivilegeRows = await transaction`
    WITH protected_roles AS (
      SELECT oid, rolname
      FROM pg_catalog.pg_roles
      WHERE rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
    ), unsafe_privileges AS (
      SELECT protected_role.rolname
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
      JOIN protected_roles AS protected_role ON protected_role.oid = privilege.grantee
      UNION ALL
      SELECT protected_role.rolname
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      JOIN protected_roles AS protected_role ON protected_role.oid = privilege.grantee
      WHERE namespace.nspname <> 'public'
      UNION ALL
      SELECT protected_role.rolname
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      JOIN protected_roles AS protected_role ON protected_role.oid = privilege.grantee
      WHERE namespace.nspname <> 'public'
      UNION ALL
      SELECT protected_role.rolname
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      JOIN protected_roles AS protected_role ON protected_role.oid = privilege.grantee
      WHERE attribute.attnum > 0 AND namespace.nspname <> 'public'
      UNION ALL
      SELECT protected_role.rolname
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
      JOIN protected_roles AS protected_role ON protected_role.oid = privilege.grantee
      WHERE namespace.nspname <> 'public'
      UNION ALL
      SELECT protected_role.rolname
      FROM pg_catalog.pg_type AS type
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) AS privilege
      JOIN protected_roles AS protected_role ON protected_role.oid = privilege.grantee
      WHERE namespace.nspname <> 'public'
    )
    SELECT rolname FROM unsafe_privileges LIMIT 1
  `;
  if (outOfBoundaryPrivilegeRows.length > 0) {
    throw new Error("OAuth roles must not retain out-of-boundary privileges");
  }

  const grantOptionRows = await transaction`
    WITH capability_roles AS (
      SELECT oid, rolname
      FROM pg_catalog.pg_roles
      WHERE rolname IN (${OAUTH_RUNTIME_CAPABILITY_ROLE}, ${OAUTH_OPERATOR_CAPABILITY_ROLE})
    ), grant_options AS (
      SELECT capability_role.rolname
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
      WHERE privilege.is_grantable
      UNION ALL
      SELECT capability_role.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
      WHERE privilege.is_grantable
      UNION ALL
      SELECT capability_role.rolname
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
      WHERE attribute.attnum > 0 AND privilege.is_grantable
      UNION ALL
      SELECT capability_role.rolname
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
      JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
      WHERE privilege.is_grantable
      UNION ALL
      SELECT capability_role.rolname
      FROM pg_catalog.pg_type AS type
      CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) AS privilege
      JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
      WHERE privilege.is_grantable
    )
    SELECT rolname FROM grant_options LIMIT 1
  `;
  if (grantOptionRows.length > 0) {
    throw new Error("OAuth capability roles must not retain grant options");
  }

  const unexpectedCapabilityColumnRows = await transaction`
    WITH capability_roles AS (
      SELECT oid, rolname
      FROM pg_catalog.pg_roles
      WHERE rolname IN (${OAUTH_RUNTIME_CAPABILITY_ROLE}, ${OAUTH_OPERATOR_CAPABILITY_ROLE})
    )
    SELECT capability_role.rolname, namespace.nspname, relation.relname,
           attribute.attname, privilege.privilege_type
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
    WHERE attribute.attnum > 0
      AND NOT (
        capability_role.rolname = ${OAUTH_RUNTIME_CAPABILITY_ROLE}
        AND namespace.nspname = 'public'
        AND NOT privilege.is_grantable
        AND (
          (
            relation.relname = 'agents'
            AND attribute.attname IN ('id', 'external_id')
            AND privilege.privilege_type = 'SELECT'
          )
          OR
          (
            privilege.privilege_type = 'UPDATE'
            AND (
              (
                relation.relname = 'oauth_clients'
                AND attribute.attname = ANY(
                  ${transaction.array([...RUNTIME_UPDATE_COLUMNS.oauth_clients])}::text[]
                )
              )
              OR
              (
                relation.relname = 'oauth_authorization_codes'
                AND attribute.attname = ANY(
                  ${transaction.array([
                    ...RUNTIME_UPDATE_COLUMNS.oauth_authorization_codes,
                  ])}::text[]
                )
              )
              OR
              (
                relation.relname = 'oauth_grants'
                AND attribute.attname = ANY(
                  ${transaction.array([...RUNTIME_UPDATE_COLUMNS.oauth_grants])}::text[]
                )
              )
              OR
              (
                relation.relname = 'oauth_refresh_tokens'
                AND attribute.attname = ANY(
                  ${transaction.array([...RUNTIME_UPDATE_COLUMNS.oauth_refresh_tokens])}::text[]
                )
              )
              OR
              (
                relation.relname = 'oauth_login_sessions'
                AND attribute.attname = ANY(
                  ${transaction.array([...RUNTIME_UPDATE_COLUMNS.oauth_login_sessions])}::text[]
                )
              )
            )
          )
        )
      )
    LIMIT 1
  `;
  if (unexpectedCapabilityColumnRows.length > 0) {
    throw new Error("OAuth capability roles retain an unexpected column privilege");
  }

  const unexpectedCapabilityFunctionRows = await transaction`
    WITH capability_roles AS (
      SELECT oid, rolname
      FROM pg_catalog.pg_roles
      WHERE rolname IN (${OAUTH_RUNTIME_CAPABILITY_ROLE}, ${OAUTH_OPERATOR_CAPABILITY_ROLE})
    ), allowed_operator_functions AS (
      SELECT signature::pg_catalog.regprocedure::oid AS oid
      FROM pg_catalog.unnest(
        ${transaction.array([...OPERATOR_FUNCTION_SIGNATURES])}::text[]
      ) AS allowed(signature)
    ), allowed_runtime_functions AS (
      SELECT signature::pg_catalog.regprocedure::oid AS oid
      FROM pg_catalog.unnest(
        ${transaction.array([...RUNTIME_FUNCTION_SIGNATURES])}::text[]
      ) AS allowed(signature)
    )
    SELECT capability_role.rolname, procedure.oid::pg_catalog.regprocedure::text,
           privilege.privilege_type
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
    JOIN capability_roles AS capability_role ON capability_role.oid = privilege.grantee
    WHERE NOT (
      (
        capability_role.rolname = ${OAUTH_OPERATOR_CAPABILITY_ROLE}
        AND procedure.oid IN (SELECT oid FROM allowed_operator_functions)
        AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable
      )
      OR
      (
        capability_role.rolname = ${OAUTH_RUNTIME_CAPABILITY_ROLE}
        AND procedure.oid IN (SELECT oid FROM allowed_runtime_functions)
        AND privilege.privilege_type = 'EXECUTE'
        AND NOT privilege.is_grantable
      )
    )
    LIMIT 1
  `;
  if (unexpectedCapabilityFunctionRows.length > 0) {
    throw new Error("OAuth capability roles retain an unexpected function privilege");
  }

  const roleSettingRows = await transaction`
    SELECT protected_role.rolname
    FROM pg_catalog.pg_db_role_setting AS setting
    JOIN pg_catalog.pg_roles AS protected_role ON protected_role.oid = setting.setrole
    WHERE protected_role.rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
      AND pg_catalog.cardinality(setting.setconfig) > 0
    LIMIT 1
  `;
  if (roleSettingRows.length > 0) {
    throw new Error("OAuth roles must not retain database-specific settings");
  }
}

async function assertEffectiveOAuthPrivileges(transaction: TransactionSql): Promise<void> {
  const roleRows = await transaction`
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolcanlogin, rolreplication, rolbypassrls, rolconfig
    FROM pg_catalog.pg_roles
    WHERE rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
  `;
  if (
    roleRows.length !== PROTECTED_ROLE_NAMES.length ||
    roleRows.some(
      (role) =>
        role.rolsuper ||
        !role.rolinherit ||
        role.rolcreaterole ||
        role.rolcreatedb ||
        role.rolreplication ||
        role.rolbypassrls ||
        role.rolconfig !== null ||
        role.rolcanlogin !==
          (role.rolname === OAUTH_GATEWAY_LOGIN_ROLE ||
            role.rolname === OAUTH_OPERATOR_LOGIN_ROLE)
    )
  ) {
    throw new Error("OAuth role attribute assertion failed");
  }

  const schemaRows = (await transaction`
    SELECT
      has_schema_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, 'public', 'USAGE') AS gateway_usage,
      has_schema_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, 'public', 'CREATE') AS gateway_create,
      has_schema_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, 'public', 'USAGE') AS operator_usage,
      has_schema_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, 'public', 'CREATE') AS operator_create
  `) as unknown as Array<{
    gateway_usage: boolean;
    gateway_create: boolean;
    operator_usage: boolean;
    operator_create: boolean;
  }>;
  if (
    !schemaRows[0]?.gateway_usage ||
    schemaRows[0].gateway_create ||
    !schemaRows[0].operator_usage ||
    schemaRows[0].operator_create
  ) {
    throw new Error("OAuth schema privilege assertion failed");
  }

  const databaseRows = (await transaction`
    SELECT
      has_database_privilege(
        ${OAUTH_GATEWAY_LOGIN_ROLE},
        pg_catalog.current_database(),
        'CREATE'
      ) AS gateway_create,
      has_database_privilege(
        ${OAUTH_OPERATOR_LOGIN_ROLE},
        pg_catalog.current_database(),
        'CREATE'
      ) AS operator_create
  `) as unknown as Array<{ gateway_create: boolean; operator_create: boolean }>;
  if (databaseRows[0]?.gateway_create || databaseRows[0]?.operator_create) {
    throw new Error("OAuth database privilege assertion failed");
  }

  for (const relation of ["cortex_schema_migrations", "oauth_principals", "oauth_agent_bindings"]) {
    for (const privilege of [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ]) {
      await requireTablePrivilege(
        transaction,
        OAUTH_GATEWAY_LOGIN_ROLE,
        relation,
        privilege,
        privilege === "SELECT"
      );
    }
    for (const privilege of ["INSERT", "UPDATE", "REFERENCES"] as const) {
      await requireAnyColumnPrivilege(
        transaction,
        OAUTH_GATEWAY_LOGIN_ROLE,
        relation,
        privilege,
        false
      );
    }
  }

  for (const relation of [
    "oauth_clients",
    "oauth_authorization_codes",
    "oauth_grants",
    "oauth_refresh_tokens",
    "oauth_login_sessions",
  ]) {
    for (const privilege of [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ]) {
      await requireTablePrivilege(
        transaction,
        OAUTH_GATEWAY_LOGIN_ROLE,
        relation,
        privilege,
        ["SELECT", "INSERT"].includes(privilege)
      );
    }
    await requireAnyColumnPrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      relation,
      "UPDATE",
      true
    );
    await requireAnyColumnPrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      relation,
      "REFERENCES",
      false
    );

    const grantedUpdateColumns = (await transaction`
      SELECT attribute.attname AS column_name
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = ${`public.${relation}`}::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND has_column_privilege(
          ${OAUTH_GATEWAY_LOGIN_ROLE},
          attribute.attrelid,
          attribute.attnum,
          'UPDATE'
        )
      ORDER BY attribute.attnum
    `) as unknown as Array<{ column_name: string }>;
    const expectedUpdateColumns = new Set<string>(
      RUNTIME_UPDATE_COLUMNS[relation as keyof typeof RUNTIME_UPDATE_COLUMNS]
    );
    if (
      grantedUpdateColumns.length !== expectedUpdateColumns.size ||
      grantedUpdateColumns.some((row) => !expectedUpdateColumns.has(row.column_name))
    ) {
      throw new Error(`OAuth gateway UPDATE-column privilege assertion failed for ${relation}`);
    }
  }

  for (const privilege of [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ]) {
    await requireTablePrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "oauth_state_migrations",
      privilege,
      privilege === "SELECT" || privilege === "INSERT"
    );
  }
  for (const privilege of ["UPDATE", "REFERENCES"] as const) {
    await requireAnyColumnPrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "oauth_state_migrations",
      privilege,
      false
    );
  }

  await requireTablePrivilege(
    transaction,
    OAUTH_GATEWAY_LOGIN_ROLE,
    "oauth_audit_events",
    "INSERT",
    true
  );
  for (const privilege of [
    "SELECT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
  ]) {
    await requireTablePrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "oauth_audit_events",
      privilege,
      false
    );
  }
  for (const privilege of ["SELECT", "UPDATE", "REFERENCES"] as const) {
    await requireAnyColumnPrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "oauth_audit_events",
      privilege,
      false
    );
  }

  await requireColumnPrivilege(
    transaction,
    OAUTH_GATEWAY_LOGIN_ROLE,
    "agents",
    "id",
    true
  );
  await requireColumnPrivilege(
    transaction,
    OAUTH_GATEWAY_LOGIN_ROLE,
    "agents",
    "external_id",
    true
  );
  for (const column of ["name", "owner_id", "config", "created_at", "updated_at"]) {
    await requireColumnPrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "agents",
      column,
      false
    );
  }
  await requireTablePrivilege(
    transaction,
    OAUTH_GATEWAY_LOGIN_ROLE,
    "agents",
    "SELECT",
    false
  );
  for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    await requireTablePrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "agents",
      privilege,
      false
    );
  }
  for (const privilege of ["INSERT", "UPDATE", "REFERENCES"] as const) {
    await requireAnyColumnPrivilege(
      transaction,
      OAUTH_GATEWAY_LOGIN_ROLE,
      "agents",
      privilege,
      false
    );
  }

  const unexpectedGatewayRelations = await transaction`
    SELECT relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND relation.relname <> ALL(${transaction.array([
        "cortex_schema_migrations",
        "agents",
        "oauth_principals",
        "oauth_agent_bindings",
        "oauth_clients",
        "oauth_authorization_codes",
        "oauth_grants",
        "oauth_refresh_tokens",
        "oauth_login_sessions",
        "oauth_audit_events",
        "oauth_state_migrations",
      ])}::text[])
      AND (
        has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'SELECT')
        OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'INSERT')
        OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'UPDATE')
        OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'DELETE')
        OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'TRUNCATE')
        OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'REFERENCES')
        OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'TRIGGER')
        OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'SELECT')
        OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'INSERT')
        OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'UPDATE')
        OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'REFERENCES')
      )
    LIMIT 1
  `;
  if (unexpectedGatewayRelations.length > 0) {
    throw new Error("OAuth gateway role has access to an unexpected public relation");
  }

  for (const view of [
    "oauth_operator_grants",
    "oauth_operator_principals",
    "oauth_operator_bindings",
    "oauth_operator_rollout_status",
  ]) {
    for (const privilege of [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ]) {
      await requireTablePrivilege(
        transaction,
        OAUTH_OPERATOR_LOGIN_ROLE,
        view,
        privilege,
        privilege === "SELECT"
      );
    }
    for (const privilege of ["INSERT", "UPDATE", "REFERENCES"] as const) {
      await requireAnyColumnPrivilege(
        transaction,
        OAUTH_OPERATOR_LOGIN_ROLE,
        view,
        privilege,
        false
      );
    }
  }

  const unexpectedOperatorRelations = await transaction`
    SELECT relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND relation.relname <> ALL(${transaction.array([
        "oauth_operator_grants",
        "oauth_operator_principals",
        "oauth_operator_bindings",
        "oauth_operator_rollout_status",
      ])}::text[])
      AND (
        has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'SELECT')
        OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'INSERT')
        OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'UPDATE')
        OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'DELETE')
        OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'TRUNCATE')
        OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'REFERENCES')
        OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'TRIGGER')
        OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'SELECT')
        OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'INSERT')
        OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'UPDATE')
        OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'REFERENCES')
      )
    LIMIT 1
  `;
  if (unexpectedOperatorRelations.length > 0) {
    throw new Error("OAuth operator role has access to an unexpected public relation");
  }

  const crossSchemaRelationRows = await transaction`
    SELECT namespace.nspname, relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'public'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname !~ '^pg_'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        (
          has_schema_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, namespace.oid, 'USAGE')
          AND (
            has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'SELECT')
            OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'INSERT')
            OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'UPDATE')
            OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'DELETE')
            OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'TRUNCATE')
            OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'REFERENCES')
            OR has_table_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'TRIGGER')
            OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'SELECT')
            OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'INSERT')
            OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'UPDATE')
            OR has_any_column_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'REFERENCES')
          )
        )
        OR
        (
          has_schema_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, namespace.oid, 'USAGE')
          AND (
            has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'SELECT')
            OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'INSERT')
            OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'UPDATE')
            OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'DELETE')
            OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'TRUNCATE')
            OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'REFERENCES')
            OR has_table_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'TRIGGER')
            OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'SELECT')
            OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'INSERT')
            OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'UPDATE')
            OR has_any_column_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'REFERENCES')
          )
        )
      )
    LIMIT 1
  `;
  if (crossSchemaRelationRows.length > 0) {
    throw new Error("OAuth roles have access to an unexpected non-system schema");
  }

  const sequenceRows = await transaction`
    SELECT relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind = 'S'
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname !~ '^pg_'
      AND (
        has_sequence_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'USAGE')
        OR has_sequence_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'SELECT')
        OR has_sequence_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, relation.oid, 'UPDATE')
        OR has_sequence_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'USAGE')
        OR has_sequence_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'SELECT')
        OR has_sequence_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, relation.oid, 'UPDATE')
      )
    LIMIT 1
  `;
  if (sequenceRows.length > 0) {
    throw new Error("OAuth roles must not use database sequences");
  }

  for (const signature of OPERATOR_FUNCTION_SIGNATURES) {
    const functionRows = (await transaction`
      SELECT
        has_function_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, ${signature}, 'EXECUTE') AS operator_execute,
        has_function_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, ${signature}, 'EXECUTE') AS gateway_execute
    `) as unknown as Array<{ operator_execute: boolean; gateway_execute: boolean }>;
    if (!functionRows[0]?.operator_execute || functionRows[0].gateway_execute) {
      throw new Error(`OAuth operator function privilege assertion failed for ${signature}`);
    }
  }

  for (const signature of RUNTIME_FUNCTION_SIGNATURES) {
    const functionRows = (await transaction`
      SELECT
        has_function_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, ${signature}, 'EXECUTE') AS gateway_execute,
        has_function_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, ${signature}, 'EXECUTE') AS operator_execute
    `) as unknown as Array<{ gateway_execute: boolean; operator_execute: boolean }>;
    if (!functionRows[0]?.gateway_execute || functionRows[0].operator_execute) {
      throw new Error(`OAuth runtime function privilege assertion failed for ${signature}`);
    }
  }

  const publicFunctionRows = await transaction`
    WITH allowed_oauth_functions AS (
      SELECT signature::pg_catalog.regprocedure::oid AS oid
      FROM pg_catalog.unnest(
        ${transaction.array([
          ...OPERATOR_FUNCTION_SIGNATURES,
          ...RUNTIME_FUNCTION_SIGNATURES,
        ])}::text[]
      ) AS allowed(signature)
    )
    SELECT procedure.proname
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'public'
      AND procedure.oid IN (SELECT oid FROM allowed_oauth_functions)
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
    LIMIT 1
  `;
  if (publicFunctionRows.length > 0) {
    throw new Error("PUBLIC must not execute OAuth functions");
  }

  const unexpectedSecurityDefinerRows = await transaction`
    WITH allowed_operator_functions AS (
      SELECT signature::pg_catalog.regprocedure::oid AS oid
      FROM pg_catalog.unnest(
        ${transaction.array([...OPERATOR_FUNCTION_SIGNATURES])}::text[]
      ) AS allowed(signature)
    ), allowed_runtime_functions AS (
      SELECT signature::pg_catalog.regprocedure::oid AS oid
      FROM pg_catalog.unnest(
        ${transaction.array([...RUNTIME_SECURITY_DEFINER_FUNCTION_SIGNATURES])}::text[]
      ) AS allowed(signature)
    )
    SELECT namespace.nspname, procedure.proname
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE procedure.prosecdef
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname !~ '^pg_'
      AND (
        (
          has_schema_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, namespace.oid, 'USAGE')
          AND has_function_privilege(${OAUTH_GATEWAY_LOGIN_ROLE}, procedure.oid, 'EXECUTE')
          AND procedure.oid NOT IN (SELECT oid FROM allowed_runtime_functions)
        )
        OR
        (
          procedure.oid NOT IN (SELECT oid FROM allowed_operator_functions)
          AND has_schema_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, namespace.oid, 'USAGE')
          AND has_function_privilege(${OAUTH_OPERATOR_LOGIN_ROLE}, procedure.oid, 'EXECUTE')
        )
      )
    LIMIT 1
  `;
  if (unexpectedSecurityDefinerRows.length > 0) {
    throw new Error("OAuth roles can execute an unexpected SECURITY DEFINER function");
  }
}

export async function provisionOAuthLoginRoles(config: OAuthRoleConfig): Promise<void> {
  const parsed = parsedRoleConfig(config);
  const ownerSql = postgres(parsed.owner.raw, {
    max: 1,
    ...postgresTlsOptions(parsed.owner),
    onnotice: () => {},
  });

  try {
    await assertDatabaseIdentity(ownerSql, parsed.owner, "Migration owner");

    await ownerSql.begin(async (transaction) => {
      await transaction`SET LOCAL search_path = pg_catalog, public`;
      const capabilityRows = (await transaction`
        SELECT rolname
        FROM pg_catalog.pg_roles
        WHERE rolname IN (
          ${OAUTH_RUNTIME_CAPABILITY_ROLE},
          ${OAUTH_OPERATOR_CAPABILITY_ROLE}
        )
      `) as unknown as Array<{ rolname: string }>;
      const capabilities = new Set(capabilityRows.map((row) => row.rolname));
      if (
        !capabilities.has(OAUTH_RUNTIME_CAPABILITY_ROLE) ||
        !capabilities.has(OAUTH_OPERATOR_CAPABILITY_ROLE)
      ) {
        throw new Error("OAuth capability roles are missing; apply migration 009 first");
      }

      try {
        await transaction`
          SELECT
            pg_catalog.set_config('cortex.oauth_gateway_password', ${parsed.gateway.password}, true),
            pg_catalog.set_config('cortex.oauth_operator_password', ${parsed.operator.password}, true)
        `;
        await transaction.unsafe(`
          DO $cortex_oauth_roles$
        DECLARE
          gateway_password TEXT := pg_catalog.current_setting('cortex.oauth_gateway_password');
          operator_password TEXT := pg_catalog.current_setting('cortex.oauth_operator_password');
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${OAUTH_GATEWAY_LOGIN_ROLE}') THEN
            EXECUTE pg_catalog.format(
              'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD %L VALID UNTIL %L',
              '${OAUTH_GATEWAY_LOGIN_ROLE}', gateway_password, 'infinity'
            );
          ELSE
            EXECUTE pg_catalog.format(
              'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD %L VALID UNTIL %L',
              '${OAUTH_GATEWAY_LOGIN_ROLE}', gateway_password, 'infinity'
            );
          END IF;

          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${OAUTH_OPERATOR_LOGIN_ROLE}') THEN
            EXECUTE pg_catalog.format(
              'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD %L VALID UNTIL %L',
              '${OAUTH_OPERATOR_LOGIN_ROLE}', operator_password, 'infinity'
            );
          ELSE
            EXECUTE pg_catalog.format(
              'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD %L VALID UNTIL %L',
              '${OAUTH_OPERATOR_LOGIN_ROLE}', operator_password, 'infinity'
            );
          END IF;
        END
          $cortex_oauth_roles$;
        `);
      } catch {
        throw new Error("OAuth login role credential rotation failed");
      }

      await transaction.unsafe(`
        ALTER ROLE ${OAUTH_RUNTIME_CAPABILITY_ROLE}
          WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
          INHERIT NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL;
        ALTER ROLE ${OAUTH_OPERATOR_CAPABILITY_ROLE}
          WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
          INHERIT NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL;
        ALTER ROLE ${OAUTH_GATEWAY_LOGIN_ROLE} RESET ALL;
        ALTER ROLE ${OAUTH_OPERATOR_LOGIN_ROLE} RESET ALL;
        ALTER ROLE ${OAUTH_RUNTIME_CAPABILITY_ROLE} RESET ALL;
        ALTER ROLE ${OAUTH_OPERATOR_CAPABILITY_ROLE} RESET ALL;
      `);
      await transaction`
        ALTER ROLE cortex_oauth_gateway
        IN DATABASE ${transaction(parsed.owner.database)} RESET ALL
      `;
      await transaction`
        ALTER ROLE cortex_oauth_operator_user
        IN DATABASE ${transaction(parsed.owner.database)} RESET ALL
      `;
      await transaction`
        ALTER ROLE cortex_oauth_runtime
        IN DATABASE ${transaction(parsed.owner.database)} RESET ALL
      `;
      await transaction`
        ALTER ROLE cortex_oauth_operator
        IN DATABASE ${transaction(parsed.owner.database)} RESET ALL
      `;

      const membershipRows = (await transaction`
        SELECT
          member_role.rolname AS member_name,
          granted_role.rolname AS granted_name,
          membership.admin_option
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
        JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
           OR granted_role.rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
      `) as unknown as Array<{
        member_name: string;
        granted_name: string;
        admin_option: boolean;
      }>;
      const expectedMemberships = new Set([
        `${OAUTH_GATEWAY_LOGIN_ROLE}:${OAUTH_RUNTIME_CAPABILITY_ROLE}`,
        `${OAUTH_OPERATOR_LOGIN_ROLE}:${OAUTH_OPERATOR_CAPABILITY_ROLE}`,
      ]);
      for (const membership of membershipRows) {
        const key = `${membership.member_name}:${membership.granted_name}`;
        if (!expectedMemberships.has(key)) {
          throw new Error("OAuth roles have an unexpected role membership");
        }
        if (membership.admin_option) {
          await transaction.unsafe(
            `REVOKE ${membership.granted_name} FROM ${membership.member_name}`
          );
        }
      }

      await transaction.unsafe(`
        GRANT ${OAUTH_RUNTIME_CAPABILITY_ROLE} TO ${OAUTH_GATEWAY_LOGIN_ROLE};
        GRANT ${OAUTH_OPERATOR_CAPABILITY_ROLE} TO ${OAUTH_OPERATOR_LOGIN_ROLE};
      `);

      const finalMemberships = (await transaction`
        SELECT
          member_role.rolname AS member_name,
          granted_role.rolname AS granted_name,
          membership.admin_option
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
        JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
           OR granted_role.rolname = ANY(${transaction.array([...PROTECTED_ROLE_NAMES])}::text[])
        ORDER BY member_name, granted_name
      `) as unknown as Array<{
        member_name: string;
        granted_name: string;
        admin_option: boolean;
      }>;
      if (
        finalMemberships.length !== 2 ||
        finalMemberships.some(
          (membership) =>
            membership.admin_option ||
            !expectedMemberships.has(
              `${membership.member_name}:${membership.granted_name}`
            )
        )
      ) {
        throw new Error("OAuth role membership assertion failed");
      }

      await assertNoUnsafeRoleState(transaction);
      await assertEffectiveOAuthPrivileges(transaction);
    });

    const gatewaySql = postgres(parsed.gateway.raw, {
      max: 1,
      ...postgresTlsOptions(parsed.gateway),
      onnotice: () => {},
    });
    const operatorSql = postgres(parsed.operator.raw, {
      max: 1,
      ...postgresTlsOptions(parsed.operator),
      onnotice: () => {},
    });
    try {
      const [gatewayIdentityRows, operatorIdentityRows] = await Promise.all([
        gatewaySql`
          SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user,
                 pg_catalog.current_database() AS current_database
        `,
        operatorSql`
          SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user,
                 pg_catalog.current_database() AS current_database
        `,
      ]);
      const gatewayIdentity = gatewayIdentityRows[0];
      const operatorIdentity = operatorIdentityRows[0];
      if (
        gatewayIdentityRows.length !== 1 ||
        gatewayIdentity.current_user !== OAUTH_GATEWAY_LOGIN_ROLE ||
        gatewayIdentity.session_user !== OAUTH_GATEWAY_LOGIN_ROLE ||
        gatewayIdentity.current_database !== parsed.owner.database ||
        operatorIdentityRows.length !== 1 ||
        operatorIdentity.current_user !== OAUTH_OPERATOR_LOGIN_ROLE ||
        operatorIdentity.session_user !== OAUTH_OPERATOR_LOGIN_ROLE ||
        operatorIdentity.current_database !== parsed.owner.database
      ) {
        throw new Error("OAuth runtime database identity assertion failed");
      }
    } finally {
      await Promise.allSettled([
        gatewaySql.end({ timeout: 5 }),
        operatorSql.end({ timeout: 5 }),
      ]);
    }
  } finally {
    await ownerSql.end({ timeout: 5 });
  }
}
