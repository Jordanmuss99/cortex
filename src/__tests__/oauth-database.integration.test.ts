import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres, { type Sql, type TransactionSql } from "postgres";
import {
  assertRequiredMigrations,
  DEFAULT_MIGRATION_DIRECTORY,
  discoverMigrations,
  preflightCheckedInMigrations,
  readSchemaReadiness,
  REQUIRED_MIGRATIONS,
  runCheckedInMigrations,
} from "../db/migrations.js";
import {
  postgresTlsOptions as corePostgresTlsOptions,
  runLegacyBuildMigrations,
} from "../db/index.js";
import {
  assertOAuthBootstrap,
  bootstrapOAuthAuthority,
  type OAuthBootstrapConfig,
} from "../oauth/bootstrap.js";
import {
  OAUTH_GATEWAY_LOGIN_ROLE,
  OAUTH_OPERATOR_LOGIN_ROLE,
  isPrivateDatabaseHost,
  provisionOAuthLoginRoles,
  validateOAuthRoleConfig,
} from "../oauth/roles.js";
import {
  prepareOAuthDatabase,
  type PrepareOAuthDatabaseDependencies,
} from "../../scripts/prepare-oauth-database.js";

const MIGRATION_ID = "009_oauth_authority";
const CURRENT_MIGRATION_ID = "010_memory_lifecycle";
const EXPECTED_SCOPES = ["cortex:read", "cortex:write", "mcp"] as const;
const LISTEN_CALLED_MARKER = "[slice2-test] network listen called";

type DatabaseClient = ReturnType<typeof postgres>;

let ownerSql: DatabaseClient;
let gatewaySql: DatabaseClient;
let operatorSql: DatabaseClient;
let ownerDatabaseUrl: string;
let gatewayDatabaseUrl: string;
let operatorDatabaseUrl: string;
let freshMigrationDatabaseUrl: string;
let issuer: string;
let primarySubject: string;
let primaryAgentExternalId: string;
let secondSubject: string;
let secondAgentExternalId: string;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the disposable OAuth integration suite`);
  return value;
}

function parseDatabaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("Disposable OAuth test URLs must use PostgreSQL");
  }
  return url;
}

function assertDisposableEnvironment(): void {
  if (requiredEnvironment("MCP_OAUTH_TEST_DISPOSABLE") !== "1") {
    throw new Error("Refusing to run OAuth database integration tests without the disposable guard");
  }

  const owner = parseDatabaseUrl(ownerDatabaseUrl);
  const gateway = parseDatabaseUrl(gatewayDatabaseUrl);
  const operator = parseDatabaseUrl(operatorDatabaseUrl);
  const urls = [owner, gateway, operator];

  for (const url of urls) {
    if (url.search || url.hash) {
      throw new Error("Disposable OAuth test URLs must not contain URL parameters or fragments");
    }
    if (url.hostname !== "127.0.0.1" || decodeURIComponent(url.pathname) !== "/cortex_test") {
      throw new Error("Refusing to run OAuth database integration tests outside the loopback cortex_test database");
    }
    if (url.hostname !== owner.hostname || url.port !== owner.port || url.pathname !== owner.pathname) {
      throw new Error("Disposable OAuth test URLs must target the same database");
    }
  }

  if (decodeURIComponent(gateway.username) !== "cortex_oauth_gateway") {
    throw new Error("Gateway test URL must use cortex_oauth_gateway");
  }
  if (decodeURIComponent(operator.username) !== "cortex_oauth_operator_user") {
    throw new Error("Operator test URL must use cortex_oauth_operator_user");
  }

  const fresh = parseDatabaseUrl(freshMigrationDatabaseUrl);
  if (
    fresh.search ||
    fresh.hash ||
    fresh.hostname !== "127.0.0.1" ||
    decodeURIComponent(fresh.pathname) !== "/cortex_test" ||
    decodeURIComponent(fresh.username) !== "cortex_test" ||
    fresh.port === owner.port
  ) {
    throw new Error("Fresh migration tests require a separate disposable cortex_test cluster");
  }
}

function bootstrapConfig(
  subject: string,
  agentExternalId: string
): OAuthBootstrapConfig {
  return {
    issuer,
    subject,
    agentExternalId,
    allowedScopes: EXPECTED_SCOPES,
  };
}

async function expectPrivilegeDenied(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code: "42501" });
    return;
  }
  throw new Error("Expected PostgreSQL to deny the operation");
}

async function withRolledBackOwnerTransaction(
  operation: (transaction: TransactionSql) => Promise<void>
): Promise<void> {
  const marker = new Error("rollback disposable readiness probe");
  try {
    await ownerSql.begin(async (transaction) => {
      await operation(transaction);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

interface OperatorAuthorityFixture {
  ids: {
    principal: string;
    binding: string;
    client: string;
    authorizationCode: string;
    grant: string;
    refresh: string;
    loginSession: string;
  };
  issuer: string;
  subject: string;
  actorPrefix: string;
}

async function createOperatorAuthorityFixture(input: {
  issuer: string;
  subject: string;
  actorPrefix: string;
  agentExternalId: string;
  includeGrant?: boolean;
}): Promise<OperatorAuthorityFixture> {
  const agentRows = await ownerSql`
    SELECT id FROM public.agents WHERE external_id = ${input.agentExternalId}
  `;
  expect(agentRows).toHaveLength(1);

  const ids = {
    principal: randomUUID(),
    binding: randomUUID(),
    client: randomUUID(),
    authorizationCode: randomUUID(),
    grant: randomUUID(),
    refresh: randomUUID(),
    loginSession: randomUUID(),
  };
  await ownerSql.begin(async (transaction) => {
    await transaction`
      INSERT INTO public.oauth_principals (id, issuer, subject)
      VALUES (${ids.principal}, ${input.issuer}, ${input.subject})
    `;
    await transaction`
      INSERT INTO public.oauth_agent_bindings (
        id, principal_id, agent_id, status, is_default,
        binding_version, allowed_scopes
      ) VALUES (
        ${ids.binding},
        ${ids.principal},
        ${agentRows[0].id},
        'active',
        TRUE,
        1,
        ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[]
      )
    `;
    await transaction`
      INSERT INTO public.oauth_clients (
        id, client_id, client_kind, redirect_uris,
        token_endpoint_auth_method, status
      ) VALUES (
        ${ids.client},
        ${`slice8-client-${randomUUID()}`},
        'dynamic',
        ${transaction.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
        'none',
        'active'
      )
    `;
    await transaction`
      INSERT INTO public.oauth_authorization_codes (
        id, code_digest, oauth_client_id, principal_id, binding_id,
        authentication_epoch, binding_version, redirect_uri, scopes,
        code_challenge, resource, expires_at
      ) VALUES (
        ${ids.authorizationCode},
        ${randomBytes(32)},
        ${ids.client},
        ${ids.principal},
        ${ids.binding},
        0,
        1,
        'https://chatgpt.com/connector_platform_oauth_redirect',
        ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
        ${"A".repeat(43)},
        'https://cortex.example.test/mcp',
        CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      )
    `;
    if (input.includeGrant !== false) {
      await transaction`
        INSERT INTO public.oauth_grants (
          id, principal_id, binding_id, oauth_client_id, resource, scopes,
          authentication_epoch, binding_version, status,
          current_refresh_generation, inactivity_expires_at
        ) VALUES (
          ${ids.grant},
          ${ids.principal},
          ${ids.binding},
          ${ids.client},
          'https://cortex.example.test/mcp',
          ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
          0,
          1,
          'active',
          0,
          CURRENT_TIMESTAMP + INTERVAL '2 hours'
        )
      `;
      await transaction`
        INSERT INTO public.oauth_refresh_tokens (
          id, grant_id, generation, kind, jti_digest, reconstruction_nonce,
          effective_scopes, issued_at, expires_at
        ) VALUES (
          ${ids.refresh},
          ${ids.grant},
          0,
          'v2',
          ${randomBytes(32)},
          ${randomBytes(32)},
          ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '2 hours'
        )
      `;
    }
    await transaction`
      INSERT INTO public.oauth_login_sessions (
        id, session_digest, principal_id, ip_fingerprint,
        authentication_epoch, issued_at, expires_at
      ) VALUES (
        ${ids.loginSession},
        ${randomBytes(32)},
        ${ids.principal},
        ${randomBytes(32)},
        0,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '2 hours'
      )
    `;
  });

  return {
    ids,
    issuer: input.issuer,
    subject: input.subject,
    actorPrefix: input.actorPrefix,
  };
}

async function cleanupOperatorAuthorityFixture(
  fixture: OperatorAuthorityFixture
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => ownerSql`
      DELETE FROM public.oauth_audit_events
      WHERE principal_id = ${fixture.ids.principal}
         OR binding_id = ${fixture.ids.binding}
         OR grant_id = ${fixture.ids.grant}
         OR metadata->>'actor' LIKE ${`${fixture.actorPrefix}%`}
    `,
    async () => ownerSql`
      DELETE FROM public.oauth_refresh_tokens WHERE grant_id = ${fixture.ids.grant}
    `,
    async () => ownerSql`
      DELETE FROM public.oauth_login_sessions WHERE principal_id = ${fixture.ids.principal}
    `,
    async () => ownerSql`
      DELETE FROM public.oauth_authorization_codes WHERE principal_id = ${fixture.ids.principal}
    `,
    async () => ownerSql`
      DELETE FROM public.oauth_grants WHERE principal_id = ${fixture.ids.principal}
    `,
    async () => ownerSql`
      DELETE FROM public.oauth_agent_bindings WHERE principal_id = ${fixture.ids.principal}
    `,
    async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${fixture.ids.client}`,
    async () => ownerSql`DELETE FROM public.oauth_principals WHERE id = ${fixture.ids.principal}`,
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Slice 8 operator fixture cleanup failed");
  }
}

function databaseUrlFor(raw: string, databaseName: string): string {
  const url = parseDatabaseUrl(raw);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function expectRuntimeStartupFailure(
  entrypoint: string,
  databaseUrl: string,
  stderrMarker: RegExp,
  readyMarker: RegExp
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let stderr = "";
    const importArguments = ["--import", "tsx"];
    if (entrypoint === "src/index.ts") {
      const listenProbe = [
        'import { Server } from "node:net";',
        "const originalListen = Server.prototype.listen;",
        "Server.prototype.listen = function (...args) {",
        `  process.stderr.write(${JSON.stringify(`${LISTEN_CALLED_MARKER}\n`)});`,
        "  return Reflect.apply(originalListen, this, args);",
        "};",
      ].join("\n");
      importArguments.unshift("--import", `data:text/javascript,${encodeURIComponent(listenProbe)}`);
    }
    const child = spawn(process.execPath, [...importArguments, entrypoint], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0" },
      // Keep MCP stdin open so its intentional clean-EOF shutdown cannot win
      // the startup-integrity assertion this helper is exercising.
      stdio: [entrypoint === "src/mcp/server.ts" ? "pipe" : "ignore", "ignore", "pipe"],
    });
    const childStderr = child.stderr;
    if (!childStderr) {
      child.kill("SIGKILL");
      reject(new Error(`${entrypoint} did not expose its stderr pipe`));
      return;
    }
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${entrypoint} did not fail startup within 20 seconds`));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const listenerStateIsCorrect = entrypoint === "src/index.ts"
        ? stderr.includes(LISTEN_CALLED_MARKER)
        : !stderr.includes(LISTEN_CALLED_MARKER);
      if (
        code === 1 &&
        signal === null &&
        stderrMarker.test(stderr) &&
        !readyMarker.test(stderr) &&
        listenerStateIsCorrect
      ) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${entrypoint} exited unexpectedly (${signal ?? code}); stderr: ${stderr.slice(0, 1000)}`
        )
      );
    });
  });
}

beforeAll(async () => {
  ownerDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OWNER_DATABASE_URL");
  gatewayDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_DATABASE_URL");
  operatorDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_OPERATOR_DATABASE_URL");
  freshMigrationDatabaseUrl = requiredEnvironment("MCP_OAUTH_TEST_FRESH_DATABASE_URL");
  issuer = requiredEnvironment("MCP_OAUTH_TEST_ISSUER");
  primarySubject = requiredEnvironment("MCP_OAUTH_TEST_SUBJECT");
  primaryAgentExternalId = requiredEnvironment("MCP_OAUTH_TEST_AGENT_ID");
  secondSubject = requiredEnvironment("MCP_OAUTH_TEST_SECOND_SUBJECT");
  secondAgentExternalId = requiredEnvironment("MCP_OAUTH_TEST_SECOND_AGENT_ID");
  assertDisposableEnvironment();

  ownerSql = postgres(ownerDatabaseUrl, { max: 6, onnotice: () => {} });
  const identityRows = await ownerSql`
    SELECT pg_catalog.current_database() AS database_name,
           SESSION_USER::text AS session_user
  `;
  if (
    identityRows.length !== 1 ||
    identityRows[0].database_name !== "cortex_test" ||
    identityRows[0].session_user !== "cortex_test"
  ) {
    throw new Error(
      "Refusing to run OAuth database integration tests unless the connected owner session is cortex_test on cortex_test"
    );
  }
  gatewaySql = postgres(gatewayDatabaseUrl, { max: 3, onnotice: () => {} });
  operatorSql = postgres(operatorDatabaseUrl, { max: 3, onnotice: () => {} });
});

afterAll(async () => {
  await Promise.all([
    ownerSql?.end({ timeout: 5 }),
    gatewaySql?.end({ timeout: 5 }),
    operatorSql?.end({ timeout: 5 }),
  ]);
});

describe("disposable OAuth security authority", () => {
  test("runs existing Build 1-8 changes before OAuth migration 009", async () => {
    const calls: string[] = [];
    const record = (name: string) => async (): Promise<void> => {
      calls.push(name);
    };
    const dependencies: PrepareOAuthDatabaseDependencies = {
      assertOwnerDatabaseIdentity: record("owner-identity"),
      preflightMigrations: record("migration-preflight"),
      runLegacyMigrations: record("legacy-builds-1-8"),
      runMigrations: record("checked-migration-009"),
      provisionRoles: record("roles"),
      bootstrapAuthority: record("bootstrap"),
      assertMigrations: record("assert-migrations"),
      assertBootstrap: record("assert-bootstrap"),
    };

    await prepareOAuthDatabase(
      {
        migrationDirectory: DEFAULT_MIGRATION_DIRECTORY,
        roles: {
          ownerDatabaseUrl,
          gatewayDatabaseUrl,
          operatorDatabaseUrl,
          gatewayLoginRole: OAUTH_GATEWAY_LOGIN_ROLE,
          operatorLoginRole: OAUTH_OPERATOR_LOGIN_ROLE,
        },
        bootstrap: bootstrapConfig(primarySubject, primaryAgentExternalId),
      },
      dependencies
    );

    expect(calls).toEqual([
      "owner-identity",
      "migration-preflight",
      "legacy-builds-1-8",
      "checked-migration-009",
      "roles",
      "bootstrap",
      "assert-migrations",
      "assert-bootstrap",
    ]);
  });

  test("legacy Build 1-8 creates missing relations only in public", async () => {
    const adminSql = postgres(freshMigrationDatabaseUrl, { max: 1, onnotice: () => {} });
    const databaseName = `cortex_legacy_${process.pid}_${randomBytes(4).toString("hex")}`;
    let minimalSql: DatabaseClient | undefined;
    await adminSql`CREATE DATABASE ${adminSql(databaseName)}`;
    try {
      minimalSql = postgres(databaseUrlFor(freshMigrationDatabaseUrl, databaseName), {
        max: 1,
        onnotice: () => {},
      });
      await minimalSql`CREATE EXTENSION vector WITH SCHEMA public`;
      await minimalSql`
        CREATE TABLE public.agents (
          id serial PRIMARY KEY,
          external_id varchar(64) NOT NULL UNIQUE
        )
      `;
      await minimalSql`
        CREATE TABLE public.memory_nodes (
          id serial PRIMARY KEY,
          agent_id integer NOT NULL REFERENCES public.agents(id),
          embedding public.vector(1024),
          status varchar(32),
          priority integer,
          resonance_score real,
          entities text[]
        )
      `;
      await minimalSql`
        CREATE TABLE public.memory_synapses (
          memory_a integer,
          memory_b integer,
          connection_strength real
        )
      `;

      await runLegacyBuildMigrations(minimalSql);
      const relationRows = await minimalSql`
        SELECT namespace.nspname, relation.relname
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE relation.relname IN (
          'hippocampal_codes',
          'emotional_valence',
          'procedural_memories'
        )
        ORDER BY namespace.nspname, relation.relname
      `;
      expect(relationRows).toEqual([
        { nspname: "public", relname: "emotional_valence" },
        { nspname: "public", relname: "hippocampal_codes" },
        { nspname: "public", relname: "procedural_memories" },
      ]);
    } finally {
      await minimalSql?.end({ timeout: 5 });
      await adminSql`DROP DATABASE ${adminSql(databaseName)} WITH (FORCE)`;
      await adminSql.end({ timeout: 5 });
    }
  });

  test("Core exposes probes while MCP stays unready before fatal migration exit", async () => {
    const adminSql = postgres(freshMigrationDatabaseUrl, { max: 1, onnotice: () => {} });
    const databaseName = `cortex_startup_${process.pid}_${randomBytes(4).toString("hex")}`;
    let startupSql: DatabaseClient | undefined;
    await adminSql`CREATE DATABASE ${adminSql(databaseName)}`;
    try {
      const missingMigrationUrl = databaseUrlFor(freshMigrationDatabaseUrl, databaseName);
      await expectRuntimeStartupFailure(
        "src/index.ts",
        missingMigrationUrl,
        /Fatal database\/schema initialization failure/,
        /application routes enabled/
      );
      await expectRuntimeStartupFailure(
        "src/mcp/server.ts",
        missingMigrationUrl,
        /\[cortex-mcp\] Fatal:/,
        /MCP server running/
      );

      startupSql = postgres(missingMigrationUrl, { max: 1, onnotice: () => {} });
      await startupSql.unsafe(
        await readFile(resolve(process.cwd(), "init-cortex-db.sql"), "utf8")
      );
      await runCheckedInMigrations(
        startupSql,
        DEFAULT_MIGRATION_DIRECTORY,
        REQUIRED_MIGRATIONS
      );
      await startupSql`
        UPDATE public.cortex_schema_migrations
        SET sha256 = ${"0".repeat(64)}
        WHERE id = ${MIGRATION_ID}
      `;
      await expectRuntimeStartupFailure(
        "src/index.ts",
        missingMigrationUrl,
        /Fatal database\/schema initialization failure/,
        /application routes enabled/
      );
      await expectRuntimeStartupFailure(
        "src/mcp/server.ts",
        missingMigrationUrl,
        /\[cortex-mcp\] Fatal:/,
        /MCP server running/
      );
    } finally {
      await startupSql?.end({ timeout: 5 });
      await adminSql`DROP DATABASE ${adminSql(databaseName)} WITH (FORCE)`;
      await adminSql`DROP ROLE IF EXISTS cortex_memory_runtime, cortex_oauth_runtime, cortex_oauth_operator`;
      await adminSql.end({ timeout: 5 });
    }
  }, 90_000);

  test("rejects preexisting protected roles, then serializes migration 009 once", async () => {
    let firstSql: DatabaseClient | undefined;
    let secondSql: DatabaseClient | undefined;
    const attackerRole = `slice2_attacker_${process.pid}`;

    try {
      firstSql = postgres(freshMigrationDatabaseUrl, { max: 1, onnotice: () => {} });
      secondSql = postgres(freshMigrationDatabaseUrl, { max: 1, onnotice: () => {} });
      const identity = await firstSql`
        SELECT SESSION_USER AS session_user, pg_catalog.current_database() AS current_database
      `;
      expect(identity).toEqual([{ session_user: "cortex_test", current_database: "cortex_test" }]);
      await firstSql`CREATE SCHEMA hostile`;
      await firstSql`CREATE DOMAIN hostile.text AS pg_catalog.text`;
      await firstSql`SET search_path = hostile, public, pg_catalog`;
      await secondSql`SET search_path = hostile, public, pg_catalog`;

      await firstSql`CREATE ROLE ${firstSql(attackerRole)} NOLOGIN`;
      await firstSql`CREATE ROLE cortex_oauth_runtime NOLOGIN`;
      await firstSql`GRANT cortex_oauth_runtime TO ${firstSql(attackerRole)}`;
      await expect(
        runCheckedInMigrations(
          firstSql,
          DEFAULT_MIGRATION_DIRECTORY,
          REQUIRED_MIGRATIONS
        )
      ).rejects.toThrow(/protected OAuth roles must not preexist/);
      const rolledBack = await firstSql`
        SELECT
          to_regclass('public.cortex_schema_migrations') IS NULL AS no_ledger,
          to_regclass('public.oauth_clients') IS NULL AS no_oauth_clients
      `;
      expect(rolledBack).toEqual([{ no_ledger: true, no_oauth_clients: true }]);
      await firstSql`REVOKE cortex_oauth_runtime FROM ${firstSql(attackerRole)}`;
      await firstSql`DROP ROLE ${firstSql(attackerRole)}`;
      await firstSql`DROP ROLE cortex_oauth_runtime`;

      const results = await Promise.all([
        runCheckedInMigrations(
          firstSql,
          DEFAULT_MIGRATION_DIRECTORY,
          REQUIRED_MIGRATIONS
        ),
        runCheckedInMigrations(
          secondSql,
          DEFAULT_MIGRATION_DIRECTORY,
          REQUIRED_MIGRATIONS
        ),
      ]);
      expect(results.filter((result) => result.applied.includes(MIGRATION_ID)).length).toBe(1);
      expect(
        results.filter((result) => result.alreadyApplied.includes(MIGRATION_ID)).length
      ).toBe(1);

      const ledgerRows = await firstSql`
        SELECT id, sha256
        FROM public.cortex_schema_migrations
        WHERE id = ${MIGRATION_ID}
      `;
      expect(ledgerRows).toHaveLength(1);
      expect(String(ledgerRows[0].sha256).trim()).toMatch(/^[0-9a-f]{64}$/);
      const resolvedTypes = await firstSql`
        SELECT attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype AS built_in_text
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.oauth_principals'::pg_catalog.regclass
          AND attribute.attname = 'issuer'
      `;
      expect(resolvedTypes).toEqual([{ built_in_text: true }]);
      const supersessionConstraint = await firstSql`
        SELECT constraint_row.condeferrable, constraint_row.condeferred
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.oauth_grants'::pg_catalog.regclass
          AND constraint_row.conname = 'oauth_grants_superseded_by_fkey'
      `;
      expect(supersessionConstraint).toEqual([{
        condeferrable: true,
        condeferred: true,
      }]);
    } finally {
      await Promise.allSettled([
        firstSql?.end({ timeout: 5 }),
        secondSql?.end({ timeout: 5 }),
      ]);
    }
  });

  test("records the exact checksum, reruns idempotently, and rejects migration drift", async () => {
    const migrations = await discoverMigrations(DEFAULT_MIGRATION_DIRECTORY);
    expect(migrations.map((migration) => migration.id)).toEqual(REQUIRED_MIGRATIONS);
    const migration = migrations.find((candidate) => candidate.id === MIGRATION_ID)!;

    const ledgerRows = await ownerSql`
      SELECT id, sha256
      FROM public.cortex_schema_migrations
      WHERE id = ${MIGRATION_ID}
    `;
    expect(ledgerRows).toHaveLength(1);
    expect(String(ledgerRows[0].sha256).trim()).toBe(migration.sha256);

    const rerun = await runCheckedInMigrations(
      ownerSql,
      DEFAULT_MIGRATION_DIRECTORY,
      REQUIRED_MIGRATIONS
    );
    expect(rerun.applied).toEqual([]);
    expect(rerun.alreadyApplied).toEqual(REQUIRED_MIGRATIONS);

    const driftDirectory = await mkdtemp(join(tmpdir(), "cortex-oauth-drift-"));
    try {
      await writeFile(
        join(driftDirectory, `${MIGRATION_ID}.sql`),
        `${migration.sql}\n-- deliberate disposable checksum drift\n`,
        "utf8"
      );
      const memoryMigration = migrations.find(
        (candidate) => candidate.id === CURRENT_MIGRATION_ID
      )!;
      await writeFile(
        join(driftDirectory, `${CURRENT_MIGRATION_ID}.sql`),
        memoryMigration.sql,
        "utf8"
      );
      await expect(
        runCheckedInMigrations(ownerSql, driftDirectory, REQUIRED_MIGRATIONS)
      ).rejects.toMatchObject({ reason: "checksum_mismatch" });
    } finally {
      await rm(driftDirectory, { recursive: true, force: true });
    }
  });

  test("runtime readiness fails closed for missing, changed, unknown, or unapplied migration state", async () => {
    await withRolledBackOwnerTransaction(async (transaction) => {
      await transaction`
        DELETE FROM public.cortex_schema_migrations
        WHERE id = ${MIGRATION_ID}
      `;
      const transactionSql = transaction as unknown as Sql;
      await expect(
        readSchemaReadiness(
          transactionSql,
          REQUIRED_MIGRATIONS,
          DEFAULT_MIGRATION_DIRECTORY
        )
      ).resolves.toMatchObject({ ready: false, reason: "missing" });
      await expect(
        assertRequiredMigrations(
          transactionSql,
          REQUIRED_MIGRATIONS,
          DEFAULT_MIGRATION_DIRECTORY
        )
      ).rejects.toMatchObject({ reason: "missing" });
    });

    await withRolledBackOwnerTransaction(async (transaction) => {
      await transaction`
        UPDATE public.cortex_schema_migrations
        SET sha256 = ${"0".repeat(64)}
        WHERE id = ${MIGRATION_ID}
      `;
      await expect(
        readSchemaReadiness(
          transaction as unknown as Sql,
          REQUIRED_MIGRATIONS,
          DEFAULT_MIGRATION_DIRECTORY
        )
      ).resolves.toMatchObject({ ready: false, reason: "checksum_mismatch" });
    });

    await withRolledBackOwnerTransaction(async (transaction) => {
      await transaction`
        INSERT INTO public.cortex_schema_migrations (id, sha256)
        VALUES ('999_disposable_unknown', ${"1".repeat(64)})
      `;
      await expect(
        readSchemaReadiness(
          transaction as unknown as Sql,
          REQUIRED_MIGRATIONS,
          DEFAULT_MIGRATION_DIRECTORY
        )
      ).resolves.toMatchObject({ ready: false, reason: "missing" });
    });

    const unappliedDirectory = await mkdtemp(join(tmpdir(), "cortex-oauth-unapplied-"));
    try {
      const migrations = await discoverMigrations(DEFAULT_MIGRATION_DIRECTORY);
      await writeFile(
        join(unappliedDirectory, `${MIGRATION_ID}.sql`),
        migrations[0].sql,
        "utf8"
      );
      await writeFile(
        join(unappliedDirectory, "010_disposable_unapplied.sql"),
        "CREATE TABLE public.slice2_unapproved_migration_probe (id integer);\n",
        "utf8"
      );
      const preparationCalls: string[] = [];
      const recordPreparation = (name: string) => async (): Promise<void> => {
        preparationCalls.push(name);
      };
      await expect(
        prepareOAuthDatabase(
          {
            migrationDirectory: unappliedDirectory,
            roles: {
              ownerDatabaseUrl,
              gatewayDatabaseUrl,
              operatorDatabaseUrl,
              gatewayLoginRole: OAUTH_GATEWAY_LOGIN_ROLE,
              operatorLoginRole: OAUTH_OPERATOR_LOGIN_ROLE,
            },
            bootstrap: bootstrapConfig(primarySubject, primaryAgentExternalId),
          },
          {
            assertOwnerDatabaseIdentity: recordPreparation("owner-identity"),
            preflightMigrations: async (directory, required) => {
              preparationCalls.push("migration-preflight");
              await preflightCheckedInMigrations(directory, required);
            },
            runLegacyMigrations: recordPreparation("legacy-builds-1-8"),
            runMigrations: recordPreparation("checked-migrations"),
            provisionRoles: recordPreparation("roles"),
            bootstrapAuthority: recordPreparation("bootstrap"),
            assertMigrations: recordPreparation("assert-migrations"),
            assertBootstrap: recordPreparation("assert-bootstrap"),
          }
        )
      ).rejects.toMatchObject({ reason: "missing" });
      expect(preparationCalls).toEqual([
        "owner-identity",
        "migration-preflight",
      ]);
      await expect(
        runCheckedInMigrations(ownerSql, unappliedDirectory, REQUIRED_MIGRATIONS)
      ).rejects.toMatchObject({ reason: "missing" });
      const mutationProbe = await ownerSql`
        SELECT
          pg_catalog.to_regclass('public.slice2_unapproved_migration_probe') IS NULL AS no_relation,
          NOT EXISTS (
            SELECT 1 FROM public.cortex_schema_migrations
            WHERE id = '010_disposable_unapplied'
          ) AS no_ledger_row
      `;
      expect(mutationProbe).toEqual([{
        no_relation: true,
        no_ledger_row: true,
      }]);
      await expect(
        readSchemaReadiness(ownerSql, REQUIRED_MIGRATIONS, unappliedDirectory)
      ).resolves.toMatchObject({ ready: false, reason: "missing" });
      await expect(
        assertRequiredMigrations(ownerSql, REQUIRED_MIGRATIONS, unappliedDirectory)
      ).rejects.toMatchObject({ reason: "missing" });
    } finally {
      await ownerSql`
        DELETE FROM public.cortex_schema_migrations
        WHERE id = '010_disposable_unapplied'
      `;
      await ownerSql`DROP TABLE IF EXISTS public.slice2_unapproved_migration_probe`;
      await rm(unappliedDirectory, { recursive: true, force: true });
    }

    await expect(
      readSchemaReadiness(ownerSql, REQUIRED_MIGRATIONS, DEFAULT_MIGRATION_DIRECTORY)
    ).resolves.toMatchObject({ ready: true, current: CURRENT_MIGRATION_ID });
  });

  test("bootstraps two explicit subject-agent bindings idempotently", async () => {
    const primary = await assertOAuthBootstrap(
      ownerSql,
      bootstrapConfig(primarySubject, primaryAgentExternalId)
    );
    expect(primary.agentExternalId).toBe(primaryAgentExternalId);
    expect(primary.created).toBe(false);

    const createdSecond = await bootstrapOAuthAuthority(
      ownerSql,
      bootstrapConfig(secondSubject, secondAgentExternalId)
    );
    expect(createdSecond.agentExternalId).toBe(secondAgentExternalId);
    expect(createdSecond.created).toBe(true);

    const repeatedSecond = await bootstrapOAuthAuthority(
      ownerSql,
      bootstrapConfig(secondSubject, secondAgentExternalId)
    );
    expect(repeatedSecond).toMatchObject({
      principalId: createdSecond.principalId,
      bindingId: createdSecond.bindingId,
      agentId: createdSecond.agentId,
      agentExternalId: secondAgentExternalId,
      created: false,
    });

    const rows = await ownerSql`
      SELECT p.subject, a.external_id,
             b.allowed_scopes::text[] AS allowed_scopes
      FROM public.oauth_principals AS p
      JOIN public.oauth_agent_bindings AS b ON b.principal_id = p.id
      JOIN public.agents AS a ON a.id = b.agent_id
      WHERE p.issuer = ${issuer}
        AND p.subject IN (${primarySubject}, ${secondSubject})
        AND p.status = 'active'
        AND b.status = 'active'
        AND b.is_default = TRUE
      ORDER BY p.subject
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.subject, row.external_id])).toEqual(
      [
        [primarySubject, primaryAgentExternalId],
        [secondSubject, secondAgentExternalId],
      ].sort((left, right) => left[0].localeCompare(right[0]))
    );
    for (const row of rows) expect(row.allowed_scopes).toEqual(EXPECTED_SCOPES);
  });

  test("bootstrap rejects missing agents and conflicting defaults without partial replacement", async () => {
    const insecureIssuerSubject = `insecure-issuer-${randomUUID()}`;
    await expect(
      bootstrapOAuthAuthority(ownerSql, {
        ...bootstrapConfig(insecureIssuerSubject, primaryAgentExternalId),
        issuer: "http://cortex.example.test",
      })
    ).rejects.toThrow(/HTTPS outside loopback/);
    const insecureIssuerRows = await ownerSql`
      SELECT id FROM public.oauth_principals
      WHERE subject = ${insecureIssuerSubject}
    `;
    expect(insecureIssuerRows).toHaveLength(0);

    for (const delimiter of ["?", "#"]) {
      const emptyDelimiterSubject = `empty-delimiter-${randomUUID()}`;
      await expect(
        bootstrapOAuthAuthority(ownerSql, {
          ...bootstrapConfig(emptyDelimiterSubject, primaryAgentExternalId),
          issuer: `https://cortex.example.test/${delimiter}`,
        })
      ).rejects.toThrow(/absolute HTTP\(S\) URL/);
      const emptyDelimiterRows = await ownerSql`
        SELECT id FROM public.oauth_principals
        WHERE subject = ${emptyDelimiterSubject}
      `;
      expect(emptyDelimiterRows).toHaveLength(0);
    }

    const missingSubject = `missing-${randomUUID()}`;
    await expect(
      bootstrapOAuthAuthority(
        ownerSql,
        bootstrapConfig(missingSubject, `missing-${randomUUID()}`)
      )
    ).rejects.toThrow(/exactly one existing agent/);
    const missingRows = await ownerSql`
      SELECT id FROM public.oauth_principals
      WHERE issuer = ${issuer} AND subject = ${missingSubject}
    `;
    expect(missingRows).toHaveLength(0);

    const conflictSubject = `conflict-${randomUUID()}`;
    const original = await bootstrapOAuthAuthority(
      ownerSql,
      bootstrapConfig(conflictSubject, primaryAgentExternalId)
    );
    await expect(
      bootstrapOAuthAuthority(
        ownerSql,
        bootstrapConfig(conflictSubject, secondAgentExternalId)
      )
    ).rejects.toThrow(/replace an existing default agent binding/);

    const defaultRows = await ownerSql`
      SELECT b.id, a.external_id
      FROM public.oauth_principals AS p
      JOIN public.oauth_agent_bindings AS b ON b.principal_id = p.id
      JOIN public.agents AS a ON a.id = b.agent_id
      WHERE p.id = ${original.principalId}
        AND b.status = 'active'
        AND b.is_default = TRUE
    `;
    expect(defaultRows).toEqual([
      expect.objectContaining({ id: original.bindingId, external_id: primaryAgentExternalId }),
    ]);

    const secondAgentRows = await ownerSql`
      SELECT id FROM public.agents WHERE external_id = ${secondAgentExternalId}
    `;
    await expect(
      ownerSql`
        INSERT INTO public.oauth_agent_bindings (
          id, principal_id, agent_id, status, is_default, binding_version, allowed_scopes
        ) VALUES (
          ${randomUUID()},
          ${original.principalId},
          ${secondAgentRows[0].id},
          'active',
          TRUE,
          1,
          ${ownerSql.array([...EXPECTED_SCOPES])}::public.oauth_scope[]
        )
      `
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("provisions fixed login roles with only their intended memberships", async () => {
    const roles = await ownerSql`
      SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
             rolcanlogin, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname IN (
        'cortex_oauth_gateway',
        'cortex_oauth_operator_user',
        'cortex_oauth_runtime',
        'cortex_oauth_operator'
      )
      ORDER BY rolname
    `;
    expect(roles).toHaveLength(4);
    for (const role of roles) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: true,
      });
      expect(role.rolcanlogin).toBe(
        role.rolname === "cortex_oauth_gateway" ||
          role.rolname === "cortex_oauth_operator_user"
      );
    }

    const memberships = await ownerSql`
      SELECT member_role.rolname AS member_name, granted_role.rolname AS granted_name
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
      JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname IN ('cortex_oauth_gateway', 'cortex_oauth_operator_user')
      ORDER BY member_name, granted_name
    `;
    expect(memberships).toEqual([
      { member_name: "cortex_oauth_gateway", granted_name: "cortex_oauth_runtime" },
      { member_name: "cortex_oauth_operator_user", granted_name: "cortex_oauth_operator" },
    ]);

    const operatorFunctionNames = [
      "oauth_operator_revoke_grant",
      "oauth_operator_revoke_all_for_principal",
      "oauth_operator_disable_principal",
      "oauth_operator_disable_binding",
      "oauth_operator_security_logout",
      "oauth_operator_invalidate_issuer",
    ];
    const runtimeFunctionNames = [
      "oauth_redirect_uris_are_canonical",
      "oauth_audit_metadata_is_safe",
      "oauth_lock_authorization_codes",
      "oauth_lock_login_sessions",
      "oauth_prune_expired",
    ];
    const oauthFunctionNames = [...operatorFunctionNames, ...runtimeFunctionNames];
    const publicFunctionPrivileges = await ownerSql`
      SELECT procedure.proname,
             procedure.prosecdef,
             procedure.proconfig = ARRAY['search_path=pg_catalog']::text[] AS fixed_search_path,
             EXISTS (
               SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )
               ) AS privilege
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS public_execute
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = ANY(${ownerSql.array(oauthFunctionNames)}::text[])
      ORDER BY procedure.proname
    `;
    expect(publicFunctionPrivileges).toHaveLength(oauthFunctionNames.length);
    expect(publicFunctionPrivileges.every((row) => row.public_execute === false)).toBe(true);
    expect(publicFunctionPrivileges.every((row) => row.fixed_search_path === true)).toBe(true);
    const runtimeSecurityDefinerNames = new Set([
      "oauth_lock_authorization_codes",
      "oauth_lock_login_sessions",
      "oauth_prune_expired",
    ]);
    for (const row of publicFunctionPrivileges) {
      expect(row.prosecdef).toBe(
        operatorFunctionNames.includes(row.proname) ||
          runtimeSecurityDefinerNames.has(row.proname)
      );
    }

    const runtimeFunctionPrivileges = await ownerSql`
      SELECT signature,
        pg_catalog.has_function_privilege(
          'cortex_oauth_gateway',
          signature,
          'EXECUTE'
        ) AS gateway_execute,
        pg_catalog.has_function_privilege(
          'cortex_oauth_operator_user',
          signature,
          'EXECUTE'
        ) AS operator_execute
      FROM pg_catalog.unnest(${ownerSql.array([
        "public.oauth_redirect_uris_are_canonical(text[])",
        "public.oauth_audit_metadata_is_safe(jsonb)",
        "public.oauth_lock_authorization_codes()",
        "public.oauth_lock_login_sessions()",
        "public.oauth_prune_expired(timestamp with time zone,integer)",
      ])}::text[]) AS allowed(signature)
      ORDER BY signature
    `;
    expect(runtimeFunctionPrivileges).toHaveLength(5);
    expect(runtimeFunctionPrivileges.every((row) =>
      row.gateway_execute === true && row.operator_execute === false
    )).toBe(true);
  });

  test("runtime lock helpers replace broad UPDATE authority without weakening serialization", async () => {
    const expectedUpdateColumns = {
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

    for (const [relation, expectedColumns] of Object.entries(expectedUpdateColumns)) {
      const tablePrivileges = await ownerSql`
        SELECT
          has_table_privilege(
            'cortex_oauth_gateway',
            ${`public.${relation}`},
            'UPDATE'
          ) AS table_update,
          has_any_column_privilege(
            'cortex_oauth_gateway',
            ${`public.${relation}`},
            'UPDATE'
          ) AS any_column_update
      `;
      expect(tablePrivileges).toEqual([{ table_update: false, any_column_update: true }]);

      const updateColumns = await ownerSql`
        SELECT attribute.attname AS column_name
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = ${`public.${relation}`}::pg_catalog.regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND has_column_privilege(
            'cortex_oauth_gateway',
            attribute.attrelid,
            attribute.attnum,
            'UPDATE'
          )
        ORDER BY attribute.attnum
      `;
      expect(updateColumns.map((row) => row.column_name)).toEqual(expectedColumns);
    }

    for (const relation of ["oauth_authorization_codes", "oauth_login_sessions"]) {
      await expect(
        gatewaySql.begin(async (transaction) => {
          await transaction.unsafe(
            `LOCK TABLE public.${relation} IN SHARE ROW EXCLUSIVE MODE`
          );
        })
      ).rejects.toMatchObject({ code: "42501" });
    }

    await gatewaySql.begin(async (transaction) => {
      await transaction`SELECT public.oauth_lock_authorization_codes()`;
      await transaction`SELECT public.oauth_lock_login_sessions()`;
      const heldLocks = await transaction`
        SELECT relation::pg_catalog.regclass::text AS relation_name, mode
        FROM pg_catalog.pg_locks
        WHERE pid = pg_catalog.pg_backend_pid()
          AND relation IN (
            'public.oauth_authorization_codes'::pg_catalog.regclass,
            'public.oauth_login_sessions'::pg_catalog.regclass
          )
          AND mode = 'ShareRowExclusiveLock'
          AND granted
        ORDER BY relation_name
      `;
      expect(heldLocks).toEqual([
        {
          relation_name: "oauth_authorization_codes",
          mode: "ShareRowExclusiveLock",
        },
        { relation_name: "oauth_login_sessions", mode: "ShareRowExclusiveLock" },
      ]);
    });
  });

  test("role configuration rejects URL identity overrides and retained direct grants", async () => {
    const validConfig = {
      ownerDatabaseUrl,
      gatewayDatabaseUrl,
      operatorDatabaseUrl,
      gatewayLoginRole: OAUTH_GATEWAY_LOGIN_ROLE,
      operatorLoginRole: OAUTH_OPERATOR_LOGIN_ROLE,
    } as const;

    expect(
      corePostgresTlsOptions("postgresql://user:secret@db.example.test/cortex")
    ).toEqual({ ssl: "verify-full" });
    for (const publicHostname of ["fd.example.test", "fca.example.test", "fe80.example.test"]) {
      expect(
        corePostgresTlsOptions(
          `postgresql://user:secret@${publicHostname}/cortex`
        )
      ).toEqual({ ssl: "verify-full" });
      expect(isPrivateDatabaseHost(publicHostname)).toBe(false);
    }
    expect(
      corePostgresTlsOptions("postgresql://user:secret@[fd00::1]/cortex")
    ).toEqual({});
    expect(isPrivateDatabaseHost("fd00::1")).toBe(true);
    expect(isPrivateDatabaseHost("fe80::1")).toBe(true);
    expect(
      corePostgresTlsOptions(
        "postgresql://user:secret@db.example.test/cortex?sslmode=verify-full"
      )
    ).toEqual({});
    for (const query of [
      "",
      "sslmode=disable",
      "sslmode=require",
      "sslmode=allow",
      "sslmode=prefer",
      "sslmode=verify-ca",
      "options=-c%20role%3Dcortex_test",
    ]) {
      expect(() =>
        corePostgresTlsOptions(
          `postgresql://user:secret@db.example.test/cortex?${query}`
        )
      ).toThrow(/safe TLS parameters/);
    }
    expect(() =>
      corePostgresTlsOptions(
        "postgresql://user:secret@db.example.test/cortex#"
      )
    ).toThrow(/safe TLS parameters/);

    for (const [field, raw] of [
      ["ownerDatabaseUrl", `${ownerDatabaseUrl}?`],
      ["gatewayDatabaseUrl", `${gatewayDatabaseUrl}#`],
      ["ownerDatabaseUrl", `${ownerDatabaseUrl}?user=cortex_oauth_gateway`],
      ["gatewayDatabaseUrl", `${gatewayDatabaseUrl}?user=cortex_test`],
      ["operatorDatabaseUrl", `${operatorDatabaseUrl}?database=other`],
      ["gatewayDatabaseUrl", `${gatewayDatabaseUrl}?options=-c%20role%3Dcortex_test`],
      ["ownerDatabaseUrl", `${ownerDatabaseUrl}?sslmode=require`],
      ["gatewayDatabaseUrl", `${gatewayDatabaseUrl}?sslmode=verify-ca`],
    ] as const) {
      expect(() => validateOAuthRoleConfig({ ...validConfig, [field]: raw })).toThrow(
        /unsupported URL parameters/
      );
    }

    const protectedOwnerUrl = new URL(ownerDatabaseUrl);
    protectedOwnerUrl.username = OAUTH_GATEWAY_LOGIN_ROLE;
    protectedOwnerUrl.password = `protected-owner-${randomUUID()}`;
    expect(() =>
      validateOAuthRoleConfig({
        ...validConfig,
        ownerDatabaseUrl: protectedOwnerUrl.toString(),
      })
    ).toThrow(/Migration owner must be distinct/);

    const duplicatePasswordOwnerUrl = new URL(ownerDatabaseUrl);
    duplicatePasswordOwnerUrl.password = decodeURIComponent(new URL(gatewayDatabaseUrl).password);
    expect(() =>
      validateOAuthRoleConfig({
        ...validConfig,
        ownerDatabaseUrl: duplicatePasswordOwnerUrl.toString(),
      })
    ).toThrow(/distinct passwords/);

    await ownerSql`CREATE SCHEMA slice2_hostile_role_setup`;
    await ownerSql`
      CREATE TABLE slice2_hostile_role_setup.call_log (
        function_name text NOT NULL
      )
    `;
    await ownerSql.unsafe(`
      CREATE FUNCTION slice2_hostile_role_setup.set_config(text, text, boolean)
      RETURNS text
      LANGUAGE plpgsql
      AS $hostile$
      BEGIN
        INSERT INTO slice2_hostile_role_setup.call_log VALUES ('set_config');
        RETURN pg_catalog.set_config($1, $2, $3);
      END
      $hostile$;

      CREATE FUNCTION slice2_hostile_role_setup.current_setting(text)
      RETURNS text
      LANGUAGE plpgsql
      AS $hostile$
      BEGIN
        INSERT INTO slice2_hostile_role_setup.call_log VALUES ('current_setting');
        RETURN pg_catalog.current_setting($1);
      END
      $hostile$;

      CREATE FUNCTION slice2_hostile_role_setup.pg_advisory_xact_lock(integer, integer)
      RETURNS void
      LANGUAGE plpgsql
      AS $hostile$
      BEGIN
        INSERT INTO slice2_hostile_role_setup.call_log VALUES ('pg_advisory_xact_lock');
        PERFORM pg_catalog.pg_advisory_xact_lock($1, $2);
      END
      $hostile$;

      CREATE FUNCTION slice2_hostile_role_setup.to_regclass(text)
      RETURNS regclass
      LANGUAGE plpgsql
      AS $hostile$
      BEGIN
        INSERT INTO slice2_hostile_role_setup.call_log VALUES ('to_regclass');
        RETURN pg_catalog.to_regclass($1);
      END
      $hostile$;

      CREATE FUNCTION slice2_hostile_role_setup.now()
      RETURNS timestamptz
      LANGUAGE plpgsql
      AS $hostile$
      BEGIN
        INSERT INTO slice2_hostile_role_setup.call_log VALUES ('now');
        RETURN pg_catalog.now();
      END
      $hostile$;
    `);
    try {
      await ownerSql`
        ALTER ROLE cortex_test IN DATABASE cortex_test
        SET search_path TO slice2_hostile_role_setup, pg_catalog, public
      `;
      await ownerSql`SET search_path TO slice2_hostile_role_setup, pg_catalog, public`;

      await provisionOAuthLoginRoles(validConfig);
      const hostileSubject = `hostile-search-path-${randomUUID()}`;
      await bootstrapOAuthAuthority(
        ownerSql,
        bootstrapConfig(hostileSubject, primaryAgentExternalId)
      );
      await assertOAuthBootstrap(
        ownerSql,
        bootstrapConfig(hostileSubject, primaryAgentExternalId)
      );
      await runLegacyBuildMigrations(ownerSql);
      await expect(
        readSchemaReadiness(ownerSql, REQUIRED_MIGRATIONS, DEFAULT_MIGRATION_DIRECTORY)
      ).resolves.toMatchObject({ ready: true });

      const shadowCalls = await ownerSql`
        SELECT function_name FROM slice2_hostile_role_setup.call_log
      `;
      expect(shadowCalls).toHaveLength(0);
    } finally {
      await ownerSql`RESET search_path`;
      await ownerSql`
        ALTER ROLE cortex_test IN DATABASE cortex_test RESET search_path
      `;
      await ownerSql`DROP SCHEMA slice2_hostile_role_setup CASCADE`;
    }

    await ownerSql`
      GRANT SELECT (content) ON TABLE public.memory_nodes TO cortex_oauth_gateway
    `;
    try {
      await expect(provisionOAuthLoginRoles(validConfig)).rejects.toThrow(
        /must not retain direct object privileges/
      );
    } finally {
      await ownerSql`
        REVOKE SELECT (content) ON TABLE public.memory_nodes FROM cortex_oauth_gateway
      `;
    }

    const limitedOwnerRole = `slice2_limited_owner_${process.pid}`;
    const limitedOwnerPassword = "slice2-limited-owner-password";
    const gatewayPasswordCanary = `gateway-canary-${randomUUID()}`;
    const operatorPasswordCanary = `operator-canary-${randomUUID()}`;
    await ownerSql`
      CREATE ROLE ${ownerSql(limitedOwnerRole)} LOGIN
      PASSWORD 'slice2-limited-owner-password'
    `;
    let setConfigRevoked = false;
    try {
      const limitedOwnerUrl = new URL(ownerDatabaseUrl);
      limitedOwnerUrl.username = limitedOwnerRole;
      limitedOwnerUrl.password = limitedOwnerPassword;
      const canaryGatewayUrl = new URL(gatewayDatabaseUrl);
      canaryGatewayUrl.password = gatewayPasswordCanary;
      const canaryOperatorUrl = new URL(operatorDatabaseUrl);
      canaryOperatorUrl.password = operatorPasswordCanary;

      let failure: unknown;
      try {
        await ownerSql`
          REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC
        `;
        setConfigRevoked = true;
        await provisionOAuthLoginRoles({
          ...validConfig,
          ownerDatabaseUrl: limitedOwnerUrl.toString(),
          gatewayDatabaseUrl: canaryGatewayUrl.toString(),
          operatorDatabaseUrl: canaryOperatorUrl.toString(),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const exposedFailure = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
      expect(exposedFailure).toContain("OAuth login role credential rotation failed");
      expect(exposedFailure).not.toContain(gatewayPasswordCanary);
      expect(exposedFailure).not.toContain(operatorPasswordCanary);
    } finally {
      if (setConfigRevoked) {
        await ownerSql`
          GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO PUBLIC
        `;
      }
      await ownerSql`DROP ROLE ${ownerSql(limitedOwnerRole)}`;
    }
  });

  test("gateway role completes the allowed OAuth-state transaction matrix", async () => {
    const bindingRows = await ownerSql`
      SELECT p.id AS principal_id, p.authentication_epoch,
             b.id AS binding_id, b.binding_version
      FROM public.oauth_principals AS p
      JOIN public.oauth_agent_bindings AS b ON b.principal_id = p.id
      WHERE p.issuer = ${issuer}
        AND p.subject = ${primarySubject}
        AND p.status = 'active'
        AND b.status = 'active'
        AND b.is_default = TRUE
    `;
    expect(bindingRows).toHaveLength(1);
    const binding = bindingRows[0];
    const ids = {
      client: randomUUID(),
      authorizationCode: randomUUID(),
      grant: randomUUID(),
      replacementGrant: randomUUID(),
      refresh: randomUUID(),
      loginSession: randomUUID(),
      stateMigration: randomUUID(),
      audit: randomUUID(),
    };
    const stateVersion = `slice2-runtime-${randomUUID()}`;

    try {
      await gatewaySql.begin(async (transaction) => {
        await transaction`
          INSERT INTO public.oauth_clients (
            id, client_id, client_kind, redirect_uris, client_name,
            token_endpoint_auth_method, status
          ) VALUES (
            ${ids.client},
            ${`slice2-runtime-${randomUUID()}`},
            'dynamic',
            ${transaction.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
            'Slice 2 runtime transaction',
            'none',
            'active'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_authorization_codes (
            id, code_digest, oauth_client_id, principal_id, binding_id,
            authentication_epoch, binding_version,
            redirect_uri, scopes, code_challenge, resource, expires_at
          ) VALUES (
            ${ids.authorizationCode},
            ${randomBytes(32)},
            ${ids.client},
            ${binding.principal_id},
            ${binding.binding_id},
            ${binding.authentication_epoch},
            ${binding.binding_version},
            'https://chatgpt.com/connector_platform_oauth_redirect',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${"A".repeat(43)},
            'https://cortex.example.test/mcp',
            CURRENT_TIMESTAMP + INTERVAL '5 minutes'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_grants (
            id, principal_id, binding_id, oauth_client_id, resource, scopes,
            authentication_epoch, binding_version, status,
            current_refresh_generation, inactivity_expires_at
          ) VALUES (
            ${ids.grant},
            ${binding.principal_id},
            ${binding.binding_id},
            ${ids.client},
            'https://cortex.example.test/mcp',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${binding.authentication_epoch},
            ${binding.binding_version},
            'active',
            0,
            CURRENT_TIMESTAMP + INTERVAL '1 hour'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_refresh_tokens (
            id, grant_id, generation, kind, jti_digest,
            reconstruction_nonce, effective_scopes, issued_at, expires_at
          ) VALUES (
            ${ids.refresh},
            ${ids.grant},
            0,
            'v2',
            ${randomBytes(32)},
            ${randomBytes(32)},
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '1 hour'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_login_sessions (
            id, session_digest, principal_id, ip_fingerprint,
            authentication_epoch, issued_at, expires_at
          ) VALUES (
            ${ids.loginSession},
            ${randomBytes(32)},
            ${binding.principal_id},
            ${randomBytes(32)},
            ${binding.authentication_epoch},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '1 hour'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_state_migrations (
            id, version, source_checksum, outcome,
            started_at, completed_at, report
          ) VALUES (
            ${ids.stateMigration},
            ${stateVersion},
            ${randomBytes(32)},
            'fresh_install',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            ${transaction.json({ imported: 0 })}
          )
        `;
        await transaction`
          INSERT INTO public.oauth_audit_events (
            id, event_type, outcome, principal_id, binding_id, grant_id,
            oauth_client_id, request_id, actor_type, metadata
          ) VALUES (
            ${ids.audit},
            'slice2_runtime_transaction',
            'created',
            ${binding.principal_id},
            ${binding.binding_id},
            ${ids.grant},
            ${ids.client},
            ${`slice2-${randomUUID()}`},
            'system',
            ${transaction.json({ surface: "runtime-role" })}
          )
        `;

        await transaction`
          UPDATE public.oauth_clients
          SET client_name = 'Slice 2 runtime transaction updated'
          WHERE id = ${ids.client}
        `;
        await transaction`
          UPDATE public.oauth_authorization_codes
          SET consumed_at = CURRENT_TIMESTAMP
          WHERE id = ${ids.authorizationCode}
        `;
        await transaction`
          UPDATE public.oauth_grants
          SET refreshed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${ids.grant}
        `;
        await transaction`
          UPDATE public.oauth_refresh_tokens
          SET consumed_at = CURRENT_TIMESTAMP,
              replacement_generation = 1,
              retry_deadline = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
              request_fingerprint = ${randomBytes(32)}
          WHERE id = ${ids.refresh}
        `;
        await transaction`
          UPDATE public.oauth_login_sessions
          SET expires_at = expires_at
          WHERE id = ${ids.loginSession}
        `;

        // The replacement does not exist when the old row first points to it.
        // This is the intended two-statement supersession order and therefore
        // proves the self-reference is deferred until transaction commit.
        await transaction`
          UPDATE public.oauth_grants
          SET status = 'superseded',
              superseded_by = ${ids.replacementGrant},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${ids.grant}
        `;
        await transaction`
          INSERT INTO public.oauth_grants (
            id, principal_id, binding_id, oauth_client_id, resource, scopes,
            authentication_epoch, binding_version, status,
            current_refresh_generation, inactivity_expires_at
          ) VALUES (
            ${ids.replacementGrant},
            ${binding.principal_id},
            ${binding.binding_id},
            ${ids.client},
            'https://cortex.example.test/mcp',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${binding.authentication_epoch},
            ${binding.binding_version},
            'active',
            0,
            CURRENT_TIMESTAMP + INTERVAL '1 hour'
          )
        `;
      });

      const persistedRows = await ownerSql`
        SELECT
          EXISTS (SELECT 1 FROM public.oauth_clients WHERE id = ${ids.client}) AS client,
          EXISTS (SELECT 1 FROM public.oauth_authorization_codes WHERE id = ${ids.authorizationCode}) AS authorization_code,
          EXISTS (
            SELECT 1 FROM public.oauth_grants
            WHERE id = ${ids.grant}
              AND status = 'superseded'
              AND superseded_by = ${ids.replacementGrant}
          ) AS grant,
          EXISTS (
            SELECT 1 FROM public.oauth_grants
            WHERE id = ${ids.replacementGrant}
              AND status = 'active'
          ) AS replacement_grant,
          EXISTS (SELECT 1 FROM public.oauth_refresh_tokens WHERE id = ${ids.refresh}) AS refresh,
          EXISTS (SELECT 1 FROM public.oauth_login_sessions WHERE id = ${ids.loginSession}) AS login_session,
          EXISTS (SELECT 1 FROM public.oauth_state_migrations WHERE id = ${ids.stateMigration}) AS state_migration,
          EXISTS (SELECT 1 FROM public.oauth_audit_events WHERE id = ${ids.audit}) AS audit
      `;
      expect(persistedRows).toEqual([{
        client: true,
        authorization_code: true,
        grant: true,
        replacement_grant: true,
        refresh: true,
        login_session: true,
        state_migration: true,
        audit: true,
      }]);

      await expectPrivilegeDenied(gatewaySql`
        UPDATE public.oauth_state_migrations
        SET report = ${gatewaySql.json({ imported: 0, verified: true })}
        WHERE id = ${ids.stateMigration}
      `);
      await expectPrivilegeDenied(gatewaySql`
        DELETE FROM public.oauth_state_migrations WHERE id = ${ids.stateMigration}
      `);

      for (const operation of [
        () => gatewaySql`
          UPDATE public.oauth_clients
          SET client_id = ${`forbidden-${randomUUID()}`}
          WHERE id = ${ids.client}
        `,
        () => gatewaySql`
          UPDATE public.oauth_authorization_codes
          SET code_digest = ${randomBytes(32)}
          WHERE id = ${ids.authorizationCode}
        `,
        () => gatewaySql`
          UPDATE public.oauth_grants
          SET legacy_tuple_digest = ${randomBytes(32)}
          WHERE id = ${ids.replacementGrant}
        `,
        () => gatewaySql`
          UPDATE public.oauth_refresh_tokens
          SET jti_digest = ${randomBytes(32)}
          WHERE id = ${ids.refresh}
        `,
        () => gatewaySql`
          UPDATE public.oauth_login_sessions
          SET session_digest = ${randomBytes(32)}
          WHERE id = ${ids.loginSession}
        `,
      ]) {
        await expectPrivilegeDenied(operation());
      }

      for (const operation of [
        () => gatewaySql`DELETE FROM public.oauth_refresh_tokens WHERE id = ${ids.refresh}`,
        () => gatewaySql`DELETE FROM public.oauth_authorization_codes WHERE id = ${ids.authorizationCode}`,
        () => gatewaySql`DELETE FROM public.oauth_grants WHERE id = ${ids.grant}`,
        () => gatewaySql`DELETE FROM public.oauth_grants WHERE id = ${ids.replacementGrant}`,
        () => gatewaySql`DELETE FROM public.oauth_login_sessions WHERE id = ${ids.loginSession}`,
        () => gatewaySql`DELETE FROM public.oauth_clients WHERE id = ${ids.client}`,
      ]) {
        await expectPrivilegeDenied(operation());
      }
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        async () => ownerSql`DELETE FROM public.oauth_audit_events WHERE id = ${ids.audit}`,
        async () => ownerSql`DELETE FROM public.oauth_refresh_tokens WHERE id = ${ids.refresh}`,
        async () => ownerSql`DELETE FROM public.oauth_authorization_codes WHERE id = ${ids.authorizationCode}`,
        async () => ownerSql`DELETE FROM public.oauth_grants WHERE id = ${ids.grant}`,
        async () => ownerSql`DELETE FROM public.oauth_grants WHERE id = ${ids.replacementGrant}`,
        async () => ownerSql`DELETE FROM public.oauth_login_sessions WHERE id = ${ids.loginSession}`,
        async () => ownerSql`DELETE FROM public.oauth_state_migrations WHERE id = ${ids.stateMigration}`,
        async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${ids.client}`,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Runtime role proof cleanup failed");
      }
    }
  });

  test("gateway role can use OAuth state but cannot reach Cortex content, audit history, or DDL", async () => {
    const agentRows = await gatewaySql`
      SELECT id, external_id FROM public.agents ORDER BY id LIMIT 2
    `;
    expect(agentRows).toHaveLength(2);
    await gatewaySql`
      SELECT id, sha256 FROM public.cortex_schema_migrations WHERE id = ${MIGRATION_ID}
    `;
    await gatewaySql`SELECT id FROM public.oauth_principals LIMIT 1`;
    await gatewaySql`SELECT id FROM public.oauth_agent_bindings LIMIT 1`;

    const clientUuid = randomUUID();
    try {
      await gatewaySql`
        INSERT INTO public.oauth_clients (
          id, client_id, client_kind, redirect_uris,
          token_endpoint_auth_method, status
        ) VALUES (
          ${clientUuid},
          ${`slice2-runtime-${randomUUID()}`},
          'dynamic',
          ${gatewaySql.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
          'none',
          'active'
        )
      `;
      const rows = await gatewaySql`
        SELECT id FROM public.oauth_clients WHERE id = ${clientUuid}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await ownerSql`DELETE FROM public.oauth_clients WHERE id = ${clientUuid}`;
    }

    for (const column of ["name", "owner_id", "config", "created_at", "updated_at"]) {
      await expectPrivilegeDenied(
        gatewaySql`SELECT ${gatewaySql(column)} FROM public.agents LIMIT 1`
      );
    }
    await expectPrivilegeDenied(gatewaySql`SELECT content FROM public.memory_nodes LIMIT 1`);
    await expectPrivilegeDenied(gatewaySql`SELECT id FROM public.oauth_audit_events LIMIT 1`);
    await expect(
      gatewaySql`
        INSERT INTO public.oauth_audit_events (
          id, event_type, outcome, request_id, actor_type, metadata
        ) VALUES (
          ${randomUUID()},
          'slice12_metadata_rejection',
          'rejected',
          ${`slice12-${randomUUID()}`},
          'system',
          ${gatewaySql.json({ raw_token: "must-not-enter-audit" })}
        )
      `
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "oauth_audit_events_metadata_check",
    });
    await expect(
      gatewaySql`
        INSERT INTO public.oauth_audit_events (
          id, event_type, outcome, request_id, actor_type, metadata
        ) VALUES (
          ${randomUUID()},
          'slice12_metadata_rejection',
          'rejected',
          ${`slice12-${randomUUID()}`},
          'system',
          ${gatewaySql.json({ surface: { nested: true } })}
        )
      `
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "oauth_audit_events_metadata_check",
    });
    await expectPrivilegeDenied(
      gatewaySql`UPDATE public.oauth_principals SET updated_at = updated_at WHERE FALSE`
    );
    try {
      await expectPrivilegeDenied(
        gatewaySql`CREATE TABLE public.slice2_gateway_forbidden (id integer)`
      );
    } finally {
      await ownerSql`DROP TABLE IF EXISTS public.slice2_gateway_forbidden`;
    }
    await expectPrivilegeDenied(
      gatewaySql`
        SELECT public.oauth_operator_revoke_grant(
          ${randomUUID()}::uuid,
          'slice2-gateway',
          'must be denied'
        )
      `
    );
  });

  test("bounded pruning retains quarterly attribution, live authority, and permanent legacy tombstones", async () => {
    const clockRows = await ownerSql`
      SELECT pg_catalog.clock_timestamp() AS operation_now
    `;
    const operationNow = clockRows[0].operation_now as Date;
    const millisecondsPerDay = 24 * 60 * 60 * 1000;
    const atDaysAgo = (days: number): Date =>
      new Date(operationNow.getTime() - days * millisecondsPerDay);
    const oldCreatedAt = atDaysAgo(200);
    const oldIssuedAt = atDaysAgo(150);
    const oldExpiredAt = atDaysAgo(120);
    const retainedAuditAt = new Date(
      operationNow.getTime() - 93 * millisecondsPerDay + 60 * 60 * 1000
    );
    const expiredAuditAt = new Date(
      operationNow.getTime() - 93 * millisecondsPerDay - 60 * 60 * 1000
    );
    const futureExpiry = new Date(operationNow.getTime() + 60 * 60 * 1000);
    const futureCallerTime = new Date(
      operationNow.getTime() + 365 * millisecondsPerDay
    );

    const bindingRows = await ownerSql`
      SELECT principal.id AS principal_id,
             principal.authentication_epoch,
             binding.id AS binding_id,
             binding.binding_version
      FROM public.oauth_principals AS principal
      JOIN public.oauth_agent_bindings AS binding
        ON binding.principal_id = principal.id
      WHERE principal.issuer = ${issuer}
        AND principal.subject = ${primarySubject}
        AND binding.status = 'active'
        AND binding.is_default = TRUE
    `;
    expect(bindingRows).toHaveLength(1);
    const binding = bindingRows[0];

    const clientId = randomUUID();
    const ids = {
      retainedGrant: randomUUID(),
      expiredAuditGrant: randomUUID(),
      tombstoneGrant: randomUUID(),
      futureRefreshGrant: randomUUID(),
      activeGrant: randomUUID(),
      retainedAudit: randomUUID(),
      expiredAudit: randomUUID(),
      expiredCode: randomUUID(),
      expiredSession: randomUUID(),
      retainedRefresh: randomUUID(),
      expiredAuditRefresh: randomUUID(),
      tombstoneRefresh: randomUUID(),
      futureRefresh: randomUUID(),
      activeRefresh: randomUUID(),
    };
    const batchAuditIds = [randomUUID(), randomUUID(), randomUUID()];
    const hostileSchema = `slice12_hostile_${randomBytes(6).toString("hex")}`;
    let hostileGatewaySql: DatabaseClient | undefined;

    try {
      await ownerSql.begin(async (transaction) => {
        await transaction`
          INSERT INTO public.oauth_clients (
            id, client_id, client_kind, redirect_uris,
            token_endpoint_auth_method, status, created_at, updated_at
          ) VALUES (
            ${clientId},
            ${`slice12-prune-${randomUUID()}`},
            'dynamic',
            ${transaction.array([
              "https://chatgpt.com/connector_platform_oauth_redirect",
            ])}::text[],
            'none',
            'active',
            ${oldCreatedAt},
            ${oldCreatedAt}
          )
        `;

        for (const grant of [
          { id: ids.retainedGrant, status: "expired", legacyDigest: null },
          { id: ids.expiredAuditGrant, status: "expired", legacyDigest: null },
          { id: ids.tombstoneGrant, status: "expired", legacyDigest: randomBytes(32) },
        ]) {
          await transaction`
            INSERT INTO public.oauth_grants (
              id, principal_id, binding_id, oauth_client_id, resource, scopes,
              authentication_epoch, binding_version, status,
              current_refresh_generation, inactivity_expires_at,
              legacy_tuple_digest, created_at, updated_at
            ) VALUES (
              ${grant.id},
              ${binding.principal_id},
              ${binding.binding_id},
              ${clientId},
              ${`https://cortex.example.test/mcp/${grant.id}`},
              ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
              ${binding.authentication_epoch},
              ${binding.binding_version},
              ${grant.status},
              0,
              ${oldExpiredAt},
              ${grant.legacyDigest},
              ${oldCreatedAt},
              ${oldExpiredAt}
            )
          `;
        }

        await transaction`
          INSERT INTO public.oauth_grants (
            id, principal_id, binding_id, oauth_client_id, resource, scopes,
            authentication_epoch, binding_version, status,
            current_refresh_generation, inactivity_expires_at,
            revoked_at, revoked_reason, created_at, updated_at
          ) VALUES (
            ${ids.futureRefreshGrant},
            ${binding.principal_id},
            ${binding.binding_id},
            ${clientId},
            'https://cortex.example.test/mcp/future-refresh',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${binding.authentication_epoch},
            ${binding.binding_version},
            'revoked',
            0,
            ${oldExpiredAt},
            ${oldExpiredAt},
            'slice12_fixture_revocation',
            ${oldCreatedAt},
            ${oldExpiredAt}
          )
        `;

        await transaction`
          INSERT INTO public.oauth_grants (
            id, principal_id, binding_id, oauth_client_id, resource, scopes,
            authentication_epoch, binding_version, status,
            current_refresh_generation, inactivity_expires_at,
            created_at, updated_at
          ) VALUES (
            ${ids.activeGrant},
            ${binding.principal_id},
            ${binding.binding_id},
            ${clientId},
            'https://cortex.example.test/mcp/active',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${binding.authentication_epoch},
            ${binding.binding_version},
            'active',
            0,
            ${futureExpiry},
            ${atDaysAgo(2)},
            ${atDaysAgo(2)}
          )
        `;

        for (const refresh of [
          { id: ids.retainedRefresh, grantId: ids.retainedGrant },
          { id: ids.expiredAuditRefresh, grantId: ids.expiredAuditGrant },
          { id: ids.tombstoneRefresh, grantId: ids.tombstoneGrant },
        ]) {
          await transaction`
            INSERT INTO public.oauth_refresh_tokens (
              id, grant_id, generation, kind, jti_digest,
              reconstruction_nonce, effective_scopes, issued_at, expires_at
            ) VALUES (
              ${refresh.id},
              ${refresh.grantId},
              0,
              'v2',
              ${randomBytes(32)},
              ${randomBytes(32)},
              ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
              ${oldIssuedAt},
              ${oldExpiredAt}
            )
          `;
        }

        for (const refresh of [
          { id: ids.futureRefresh, grantId: ids.futureRefreshGrant },
          { id: ids.activeRefresh, grantId: ids.activeGrant },
        ]) {
          await transaction`
            INSERT INTO public.oauth_refresh_tokens (
              id, grant_id, generation, kind, jti_digest,
              reconstruction_nonce, effective_scopes, issued_at, expires_at
            ) VALUES (
              ${refresh.id},
              ${refresh.grantId},
              0,
              'v2',
              ${randomBytes(32)},
              ${randomBytes(32)},
              ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
              ${new Date(operationNow.getTime() - 60 * 60 * 1000)},
              ${futureExpiry}
            )
          `;
        }

        for (const audit of [
          {
            id: ids.retainedAudit,
            grantId: ids.retainedGrant,
            createdAt: retainedAuditAt,
            requestId: `slice12-retained-${randomUUID()}`,
          },
          {
            id: ids.expiredAudit,
            grantId: ids.expiredAuditGrant,
            createdAt: expiredAuditAt,
            requestId: `slice12-expired-${randomUUID()}`,
          },
        ]) {
          await transaction`
            INSERT INTO public.oauth_audit_events (
              id, event_type, outcome, grant_id, request_id,
              actor_type, metadata, created_at
            ) VALUES (
              ${audit.id},
              'refresh_rotation',
              'rotated',
              ${audit.grantId},
              ${audit.requestId},
              'connector',
              ${transaction.json({
                presented_generation: 0,
                replacement_generation: 1,
              })},
              ${audit.createdAt}
            )
          `;
        }

        await transaction`
          INSERT INTO public.oauth_authorization_codes (
            id, code_digest, oauth_client_id, principal_id, binding_id,
            authentication_epoch, binding_version, redirect_uri, scopes,
            code_challenge, resource, expires_at, created_at
          ) VALUES (
            ${ids.expiredCode},
            ${randomBytes(32)},
            ${clientId},
            ${binding.principal_id},
            ${binding.binding_id},
            ${binding.authentication_epoch},
            ${binding.binding_version},
            'https://chatgpt.com/connector_platform_oauth_redirect',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${"A".repeat(43)},
            'https://cortex.example.test/mcp',
            ${new Date(oldCreatedAt.getTime() + 60 * 1000)},
            ${oldCreatedAt}
          )
        `;

        await transaction`
          INSERT INTO public.oauth_login_sessions (
            id, session_digest, principal_id, ip_fingerprint,
            authentication_epoch, issued_at, expires_at
          ) VALUES (
            ${ids.expiredSession},
            ${randomBytes(32)},
            ${binding.principal_id},
            ${randomBytes(32)},
            ${binding.authentication_epoch},
            ${oldCreatedAt},
            ${new Date(oldCreatedAt.getTime() + 60 * 1000)}
          )
        `;
      });

      await expect(
        ownerSql`DELETE FROM public.oauth_grants WHERE id = ${ids.retainedGrant}`
      ).rejects.toMatchObject({
        code: "23503",
        constraint_name: "oauth_audit_events_grant_id_fkey",
      });

      const firstPass = await gatewaySql`
        SELECT public.oauth_prune_expired(
          ${operationNow}::timestamptz,
          100
        ) AS report
      `;
      expect(firstPass).toEqual([{
        report: {
          audit_event_count: 1,
          authorization_code_count: 1,
          refresh_token_count: 3,
          login_session_count: 1,
          grant_count: 1,
        },
      }]);

      const retainedRows = await ownerSql`
        SELECT
          EXISTS (
            SELECT 1 FROM public.oauth_audit_events
            WHERE id = ${ids.retainedAudit}
              AND grant_id = ${ids.retainedGrant}
          ) AS retained_attribution,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.retainedGrant})
            AS retained_grant,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.expiredAuditGrant})
            AS deleted_expired_audit_grant,
          EXISTS (
            SELECT 1 FROM public.oauth_grants
            WHERE id = ${ids.tombstoneGrant}
              AND legacy_tuple_digest IS NOT NULL
          ) AS retained_tombstone,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.futureRefreshGrant})
            AS retained_future_refresh_grant,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.activeGrant})
            AS retained_active_grant,
          EXISTS (SELECT 1 FROM public.oauth_refresh_tokens WHERE id = ${ids.futureRefresh})
            AS retained_future_refresh,
          EXISTS (SELECT 1 FROM public.oauth_refresh_tokens WHERE id = ${ids.activeRefresh})
            AS retained_active_refresh
      `;
      expect(retainedRows).toEqual([{
        retained_attribution: true,
        retained_grant: true,
        deleted_expired_audit_grant: false,
        retained_tombstone: true,
        retained_future_refresh_grant: true,
        retained_active_grant: true,
        retained_future_refresh: true,
        retained_active_refresh: true,
      }]);

      const clampedPass = await gatewaySql`
        SELECT public.oauth_prune_expired(
          ${futureCallerTime}::timestamptz,
          100
        ) AS report
      `;
      expect(clampedPass[0].report).toEqual({
        audit_event_count: 0,
        authorization_code_count: 0,
        refresh_token_count: 0,
        login_session_count: 0,
        grant_count: 0,
      });

      await ownerSql`
        UPDATE public.oauth_audit_events
        SET created_at = ${expiredAuditAt}
        WHERE id = ${ids.retainedAudit}
      `;
      const attributionExpiryPass = await gatewaySql`
        SELECT public.oauth_prune_expired(
          ${operationNow}::timestamptz,
          100
        ) AS report
      `;
      expect(attributionExpiryPass[0].report).toMatchObject({
        audit_event_count: 1,
        grant_count: 1,
      });

      const permanentRows = await ownerSql`
        SELECT
          NOT EXISTS (
            SELECT 1 FROM public.oauth_grants WHERE id = ${ids.retainedGrant}
          ) AS attribution_grant_pruned,
          EXISTS (
            SELECT 1 FROM public.oauth_grants
            WHERE id = ${ids.tombstoneGrant}
              AND legacy_tuple_digest IS NOT NULL
          ) AS tombstone_still_present,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.futureRefreshGrant})
            AS future_refresh_grant_still_present,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.activeGrant})
            AS active_grant_still_present
      `;
      expect(permanentRows).toEqual([{
        attribution_grant_pruned: true,
        tombstone_still_present: true,
        future_refresh_grant_still_present: true,
        active_grant_still_present: true,
      }]);

      for (const auditId of batchAuditIds) {
        await ownerSql`
          INSERT INTO public.oauth_audit_events (
            id, event_type, outcome, request_id, actor_type, metadata, created_at
          ) VALUES (
            ${auditId},
            'slice12_prune_batch',
            'recorded',
            ${`slice12-batch-${auditId}`},
            'system',
            ${ownerSql.json({ surface: "prune" })},
            ${atDaysAgo(100)}
          )
        `;
      }
      const concurrentPasses = await Promise.all([
        gatewaySql`
          SELECT public.oauth_prune_expired(${operationNow}::timestamptz, 1) AS report
        `,
        gatewaySql`
          SELECT public.oauth_prune_expired(${operationNow}::timestamptz, 1) AS report
        `,
      ]);
      expect(concurrentPasses.map((rows) => rows[0].report.audit_event_count)).toEqual([
        1,
        1,
      ]);
      const batchRemainder = await ownerSql`
        SELECT pg_catalog.count(*)::integer AS count
        FROM public.oauth_audit_events
        WHERE id = ANY(${ownerSql.array(batchAuditIds)}::uuid[])
      `;
      expect(batchRemainder).toEqual([{ count: 1 }]);
      const finalBatchPass = await gatewaySql`
        SELECT public.oauth_prune_expired(${operationNow}::timestamptz, 1) AS report
      `;
      expect(finalBatchPass[0].report.audit_event_count).toBe(1);

      await expectPrivilegeDenied(
        operatorSql`
          SELECT public.oauth_prune_expired(${operationNow}::timestamptz, 1)
        `
      );
      await expect(
        gatewaySql`
          SELECT public.oauth_prune_expired(${operationNow}::timestamptz, 0)
        `
      ).rejects.toMatchObject({ code: "22023" });

      await ownerSql`CREATE SCHEMA ${ownerSql(hostileSchema)}`;
      await ownerSql.unsafe(`
        CREATE FUNCTION ${hostileSchema}.clock_timestamp()
        RETURNS timestamptz
        LANGUAGE sql
        IMMUTABLE
        AS 'SELECT ''2999-01-01T00:00:00Z''::timestamptz';
      `);
      await ownerSql`
        GRANT USAGE ON SCHEMA ${ownerSql(hostileSchema)} TO cortex_oauth_runtime
      `;
      hostileGatewaySql = postgres(gatewayDatabaseUrl, { max: 1, onnotice: () => {} });
      await hostileGatewaySql.unsafe(
        `SET search_path TO ${hostileSchema}, public, pg_catalog`
      );
      const hostilePass = await hostileGatewaySql`
        SELECT public.oauth_prune_expired(
          ${futureCallerTime}::timestamptz,
          100
        ) AS report
      `;
      expect(hostilePass[0].report.grant_count).toBe(0);
      const postHostileRows = await ownerSql`
        SELECT
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.tombstoneGrant})
            AS tombstone_present,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.futureRefreshGrant})
            AS future_refresh_grant_present,
          EXISTS (SELECT 1 FROM public.oauth_grants WHERE id = ${ids.activeGrant})
            AS active_grant_present
      `;
      expect(postHostileRows).toEqual([{
        tombstone_present: true,
        future_refresh_grant_present: true,
        active_grant_present: true,
      }]);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        async () => hostileGatewaySql?.end({ timeout: 5 }),
        async () => ownerSql`DROP SCHEMA IF EXISTS ${ownerSql(hostileSchema)} CASCADE`,
        async () => ownerSql`
          DELETE FROM public.oauth_audit_events
          WHERE id = ANY(${ownerSql.array([
            ids.retainedAudit,
            ids.expiredAudit,
            ...batchAuditIds,
          ])}::uuid[])
        `,
        async () => ownerSql`
          DELETE FROM public.oauth_refresh_tokens
          WHERE grant_id = ANY(${ownerSql.array([
            ids.retainedGrant,
            ids.expiredAuditGrant,
            ids.tombstoneGrant,
            ids.futureRefreshGrant,
            ids.activeGrant,
          ])}::uuid[])
        `,
        async () => ownerSql`DELETE FROM public.oauth_authorization_codes WHERE id = ${ids.expiredCode}`,
        async () => ownerSql`DELETE FROM public.oauth_login_sessions WHERE id = ${ids.expiredSession}`,
        async () => ownerSql`
          DELETE FROM public.oauth_grants
          WHERE id = ANY(${ownerSql.array([
            ids.retainedGrant,
            ids.expiredAuditGrant,
            ids.tombstoneGrant,
            ids.futureRefreshGrant,
            ids.activeGrant,
          ])}::uuid[])
        `,
        async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${clientId}`,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Slice 12 pruning cleanup failed");
      }
    }
  });

  test("operator role is view-and-function only and revocation audit is atomic", async () => {
    const views = await operatorSql`
      SELECT subject, agent_external_id
      FROM public.oauth_operator_bindings
      WHERE issuer = ${issuer}
      ORDER BY subject
    `;
    expect(views.length).toBeGreaterThanOrEqual(2);
    await expectPrivilegeDenied(operatorSql`SELECT id FROM public.oauth_principals LIMIT 1`);
    await expectPrivilegeDenied(operatorSql`SELECT id FROM public.oauth_audit_events LIMIT 1`);
    await expectPrivilegeDenied(
      operatorSql`UPDATE public.oauth_clients SET updated_at = updated_at WHERE FALSE`
    );

    const bindingRows = await ownerSql`
      SELECT p.id AS principal_id, p.authentication_epoch,
             b.id AS binding_id, b.binding_version
      FROM public.oauth_principals AS p
      JOIN public.oauth_agent_bindings AS b ON b.principal_id = p.id
      WHERE p.issuer = ${issuer}
        AND p.subject = ${primarySubject}
        AND p.status = 'active'
        AND b.status = 'active'
        AND b.is_default = TRUE
    `;
    expect(bindingRows).toHaveLength(1);
    const binding = bindingRows[0];
    const clientUuid = randomUUID();
    const grantId = randomUUID();

    try {
      await ownerSql`
        INSERT INTO public.oauth_clients (
          id, client_id, client_kind, redirect_uris,
          token_endpoint_auth_method, status
        ) VALUES (
          ${clientUuid},
          ${`slice2-operator-${randomUUID()}`},
          'dynamic',
          ${ownerSql.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
          'none',
          'active'
        )
      `;
      await ownerSql`
        INSERT INTO public.oauth_grants (
          id, principal_id, binding_id, oauth_client_id, resource, scopes,
          authentication_epoch, binding_version, status,
          current_refresh_generation, inactivity_expires_at
        ) VALUES (
          ${grantId},
          ${binding.principal_id},
          ${binding.binding_id},
          ${clientUuid},
          'https://cortex.example.test/mcp',
          ${ownerSql.array(["cortex:read", "mcp"])}::public.oauth_scope[],
          ${binding.authentication_epoch},
          ${binding.binding_version},
          'active',
          0,
          CURRENT_TIMESTAMP + INTERVAL '1 hour'
        )
      `;

      const oversizedEscapedReason = "\u0001".repeat(700);
      await expect(operatorSql`
        SELECT public.oauth_operator_revoke_grant(
          ${grantId}::uuid,
          'slice2-integration',
          ${oversizedEscapedReason}
        )
      `).rejects.toMatchObject({ code: "22023" });
      const unchangedRows = await ownerSql`
        SELECT status,
               EXISTS (
                 SELECT 1 FROM public.oauth_audit_events
                 WHERE grant_id = ${grantId}
                   AND event_type = 'operator_grant_revoke'
               ) AS audit_exists
        FROM public.oauth_grants
        WHERE id = ${grantId}
      `;
      expect(unchangedRows).toEqual([{ status: "active", audit_exists: false }]);

      const resultRows = await operatorSql`
        SELECT public.oauth_operator_revoke_grant(
          ${grantId}::uuid,
          'slice2-integration',
          'prove atomic operator revocation'
        ) AS result
      `;
      expect(resultRows[0].result).toMatchObject({
        matched: true,
        changed: true,
        grant_id: grantId,
      });

      const stateRows = await ownerSql`
        SELECT g.status, g.revoked_reason,
               e.id AS audit_id, e.outcome, e.metadata
        FROM public.oauth_grants AS g
        JOIN public.oauth_audit_events AS e ON e.grant_id = g.id
        WHERE g.id = ${grantId}
          AND e.event_type = 'operator_grant_revoke'
      `;
      expect(stateRows).toHaveLength(1);
      expect(stateRows[0]).toMatchObject({
        status: "revoked",
        revoked_reason: "prove atomic operator revocation",
        outcome: "revoked",
        metadata: {
          actor: "slice2-integration",
          reason: "prove atomic operator revocation",
        },
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        async () => ownerSql`
          DELETE FROM public.oauth_audit_events
          WHERE grant_id = ${grantId}
            AND event_type = 'operator_grant_revoke'
        `,
        async () => ownerSql`DELETE FROM public.oauth_grants WHERE id = ${grantId}`,
        async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${clientUuid}`,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Operator revocation proof cleanup failed");
      }
    }
  });

  test("principal revoke-all reports a pending-code-only authority change", async () => {
    const agentRows = await ownerSql`
      SELECT id FROM public.agents WHERE external_id = ${primaryAgentExternalId}
    `;
    expect(agentRows).toHaveLength(1);

    const ids = {
      principal: randomUUID(),
      binding: randomUUID(),
      client: randomUUID(),
      authorizationCode: randomUUID(),
    };
    const subject = `slice2-code-only-${randomUUID()}`;
    const actor = `slice2-code-only-actor-${randomUUID()}`;
    const reason = "prove pending authorization code revocation is reported";

    try {
      await ownerSql.begin(async (transaction) => {
        await transaction`
          INSERT INTO public.oauth_principals (id, issuer, subject)
          VALUES (${ids.principal}, ${issuer}, ${subject})
        `;
        await transaction`
          INSERT INTO public.oauth_agent_bindings (
            id, principal_id, agent_id, status, is_default,
            binding_version, allowed_scopes
          ) VALUES (
            ${ids.binding},
            ${ids.principal},
            ${agentRows[0].id},
            'active',
            TRUE,
            1,
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[]
          )
        `;
        await transaction`
          INSERT INTO public.oauth_clients (
            id, client_id, client_kind, redirect_uris,
            token_endpoint_auth_method, status
          ) VALUES (
            ${ids.client},
            ${`slice2-code-only-client-${randomUUID()}`},
            'dynamic',
            ${transaction.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
            'none',
            'active'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_authorization_codes (
            id, code_digest, oauth_client_id, principal_id, binding_id,
            authentication_epoch, binding_version,
            redirect_uri, scopes, code_challenge, resource, expires_at
          ) VALUES (
            ${ids.authorizationCode},
            ${randomBytes(32)},
            ${ids.client},
            ${ids.principal},
            ${ids.binding},
            0,
            1,
            'https://chatgpt.com/connector_platform_oauth_redirect',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${"A".repeat(43)},
            'https://cortex.example.test/mcp',
            CURRENT_TIMESTAMP + INTERVAL '5 minutes'
          )
        `;
      });

      const resultRows = await operatorSql`
        SELECT public.oauth_operator_revoke_all_for_principal(
          ${issuer},
          ${subject},
          ${actor},
          ${reason}
        ) AS result
      `;
      expect(resultRows[0].result).toMatchObject({
        matched: true,
        changed: true,
        grant_count: 0,
        code_count: 1,
      });

      const stateRows = await ownerSql`
        SELECT c.consumed_at IS NOT NULL AS authorization_code_consumed,
               e.outcome AS audit_outcome,
               e.metadata AS audit_metadata
        FROM public.oauth_authorization_codes AS c
        JOIN public.oauth_audit_events AS e
          ON e.principal_id = c.principal_id
         AND e.event_type = 'operator_principal_revoke_all'
        WHERE c.id = ${ids.authorizationCode}
      `;
      expect(stateRows).toEqual([
        {
          authorization_code_consumed: true,
          audit_outcome: "revoked",
          audit_metadata: {
            actor,
            reason,
            grant_count: 0,
            code_count: 1,
          },
        },
      ]);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        async () => ownerSql`
          DELETE FROM public.oauth_audit_events
          WHERE principal_id = ${ids.principal}
            AND event_type = 'operator_principal_revoke_all'
        `,
        async () => ownerSql`
          DELETE FROM public.oauth_authorization_codes WHERE id = ${ids.authorizationCode}
        `,
        async () => ownerSql`DELETE FROM public.oauth_agent_bindings WHERE id = ${ids.binding}`,
        async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${ids.client}`,
        async () => ownerSql`DELETE FROM public.oauth_principals WHERE id = ${ids.principal}`,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Pending-code revoke-all proof cleanup failed");
      }
    }
  });

  test("security logout preserves future-issued CHECK invariants while revoking authority", async () => {
    const agentRows = await ownerSql`
      SELECT id FROM public.agents WHERE external_id = ${primaryAgentExternalId}
    `;
    expect(agentRows).toHaveLength(1);

    const ids = {
      principal: randomUUID(),
      binding: randomUUID(),
      client: randomUUID(),
      authorizationCode: randomUUID(),
      grant: randomUUID(),
      refresh: randomUUID(),
      loginSession: randomUUID(),
    };
    const subject = `slice2-security-logout-${randomUUID()}`;
    const actor = "slice2-security-integration";
    const reason = "prove future-dated security logout invariants";

    try {
      await ownerSql.begin(async (transaction) => {
        await transaction`
          INSERT INTO public.oauth_principals (id, issuer, subject, legacy_not_before)
          VALUES (
            ${ids.principal},
            ${issuer},
            ${subject},
            CURRENT_TIMESTAMP + INTERVAL '30 minutes'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_agent_bindings (
            id, principal_id, agent_id, status, is_default,
            binding_version, allowed_scopes
          ) VALUES (
            ${ids.binding},
            ${ids.principal},
            ${agentRows[0].id},
            'active',
            TRUE,
            1,
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[]
          )
        `;
        await transaction`
          INSERT INTO public.oauth_clients (
            id, client_id, client_kind, redirect_uris,
            token_endpoint_auth_method, status
          ) VALUES (
            ${ids.client},
            ${`slice2-security-logout-${randomUUID()}`},
            'dynamic',
            ${transaction.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
            'none',
            'active'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_authorization_codes (
            id, code_digest, oauth_client_id, principal_id, binding_id,
            authentication_epoch, binding_version,
            redirect_uri, scopes, code_challenge, resource, expires_at
          ) VALUES (
            ${ids.authorizationCode},
            ${randomBytes(32)},
            ${ids.client},
            ${ids.principal},
            ${ids.binding},
            0,
            1,
            'https://chatgpt.com/connector_platform_oauth_redirect',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${"A".repeat(43)},
            'https://cortex.example.test/mcp',
            CURRENT_TIMESTAMP + INTERVAL '5 minutes'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_grants (
            id, principal_id, binding_id, oauth_client_id, resource, scopes,
            authentication_epoch, binding_version, status,
            current_refresh_generation, inactivity_expires_at
          ) VALUES (
            ${ids.grant},
            ${ids.principal},
            ${ids.binding},
            ${ids.client},
            'https://cortex.example.test/mcp',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            0,
            1,
            'active',
            0,
            CURRENT_TIMESTAMP + INTERVAL '2 hours'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_refresh_tokens (
            id, grant_id, generation, kind, jti_digest,
            reconstruction_nonce, effective_scopes, issued_at, expires_at
          ) VALUES (
            ${ids.refresh},
            ${ids.grant},
            0,
            'v2',
            ${randomBytes(32)},
            ${randomBytes(32)},
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            CURRENT_TIMESTAMP + INTERVAL '10 minutes',
            CURRENT_TIMESTAMP + INTERVAL '2 hours'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_login_sessions (
            id, session_digest, principal_id, ip_fingerprint,
            authentication_epoch, issued_at, expires_at
          ) VALUES (
            ${ids.loginSession},
            ${randomBytes(32)},
            ${ids.principal},
            ${randomBytes(32)},
            0,
            CURRENT_TIMESTAMP + INTERVAL '10 minutes',
            CURRENT_TIMESTAMP + INTERVAL '2 hours'
          )
        `;
      });

      const beforeLogoutRows = await ownerSql`
        SELECT EXISTS (
          SELECT 1
          FROM public.oauth_authorization_codes AS authorization_code
          JOIN public.oauth_principals AS principal
            ON principal.id = authorization_code.principal_id
          JOIN public.oauth_agent_bindings AS binding
            ON binding.id = authorization_code.binding_id
           AND binding.principal_id = principal.id
          WHERE authorization_code.id = ${ids.authorizationCode}
            AND authorization_code.consumed_at IS NULL
            AND authorization_code.expires_at > pg_catalog.clock_timestamp()
            AND authorization_code.authentication_epoch = principal.authentication_epoch
            AND authorization_code.binding_version = binding.binding_version
            AND principal.status = 'active'
            AND binding.status = 'active'
        ) AS exchangeable
      `;
      expect(beforeLogoutRows).toEqual([{ exchangeable: true }]);

      const resultRows = await operatorSql`
        SELECT public.oauth_operator_security_logout(
          ${issuer},
          ${subject},
          ${actor},
          ${reason}
        ) AS result
      `;
      expect(resultRows[0].result).toMatchObject({
        matched: true,
        changed: true,
        authentication_epoch: 1,
        grant_count: 1,
        session_count: 1,
      });

      const stateRows = await ownerSql`
        SELECT p.authentication_epoch,
               p.legacy_not_before > e.created_at AS legacy_cutoff_remained_future,
               g.status AS grant_status,
               g.revoked_at IS NOT NULL AS grant_revoked,
               g.revoked_reason AS grant_revoked_reason,
               r.issued_at > e.created_at AS refresh_was_future_dated,
               r.expires_at > r.issued_at AS refresh_expiry_check_holds,
               r.expires_at = r.issued_at + INTERVAL '1 microsecond' AS refresh_expiry_clamped,
               s.issued_at > e.created_at AS session_was_future_dated,
               s.revoked_at IS NOT NULL AS session_revoked,
               s.revoked_at >= s.issued_at AS session_revocation_check_holds,
               c.consumed_at IS NOT NULL AS authorization_code_consumed,
               (
                 c.consumed_at IS NULL
                 AND c.expires_at > pg_catalog.clock_timestamp()
                 AND c.authentication_epoch = p.authentication_epoch
                 AND c.binding_version = b.binding_version
                 AND p.status = 'active'
                 AND b.status = 'active'
               ) AS authorization_code_exchangeable,
               e.outcome AS audit_outcome,
               e.metadata AS audit_metadata
        FROM public.oauth_principals AS p
        JOIN public.oauth_grants AS g ON g.principal_id = p.id
        JOIN public.oauth_refresh_tokens AS r ON r.grant_id = g.id
        JOIN public.oauth_login_sessions AS s ON s.principal_id = p.id
        JOIN public.oauth_authorization_codes AS c ON c.principal_id = p.id
        JOIN public.oauth_agent_bindings AS b
          ON b.id = c.binding_id AND b.principal_id = p.id
        JOIN public.oauth_audit_events AS e ON e.principal_id = p.id
        WHERE p.id = ${ids.principal}
          AND g.id = ${ids.grant}
          AND r.id = ${ids.refresh}
          AND s.id = ${ids.loginSession}
          AND c.id = ${ids.authorizationCode}
          AND e.event_type = 'operator_security_logout'
      `;
      expect(stateRows).toHaveLength(1);
      expect(stateRows[0]).toMatchObject({
        authentication_epoch: 1,
        legacy_cutoff_remained_future: true,
        grant_status: "revoked",
        grant_revoked: true,
        grant_revoked_reason: reason,
        refresh_was_future_dated: true,
        refresh_expiry_check_holds: true,
        refresh_expiry_clamped: true,
        session_was_future_dated: true,
        session_revoked: true,
        session_revocation_check_holds: true,
        authorization_code_consumed: true,
        authorization_code_exchangeable: false,
        audit_outcome: "logged_out",
        audit_metadata: {
          actor,
          reason,
          grant_count: 1,
          code_count: 1,
          session_count: 1,
        },
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        async () => ownerSql`
          DELETE FROM public.oauth_audit_events
          WHERE principal_id = ${ids.principal}
            AND event_type = 'operator_security_logout'
        `,
        async () => ownerSql`DELETE FROM public.oauth_refresh_tokens WHERE id = ${ids.refresh}`,
        async () => ownerSql`DELETE FROM public.oauth_login_sessions WHERE id = ${ids.loginSession}`,
        async () => ownerSql`DELETE FROM public.oauth_authorization_codes WHERE id = ${ids.authorizationCode}`,
        async () => ownerSql`DELETE FROM public.oauth_grants WHERE id = ${ids.grant}`,
        async () => ownerSql`DELETE FROM public.oauth_agent_bindings WHERE id = ${ids.binding}`,
        async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${ids.client}`,
        async () => ownerSql`DELETE FROM public.oauth_principals WHERE id = ${ids.principal}`,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Security logout proof cleanup failed");
      }
    }
  });

  test("issuer invalidation makes outstanding authorization codes unexchangeable", async () => {
    const agentRows = await ownerSql`
      SELECT id FROM public.agents WHERE external_id = ${secondAgentExternalId}
    `;
    expect(agentRows).toHaveLength(1);

    const ids = {
      principal: randomUUID(),
      binding: randomUUID(),
      client: randomUUID(),
      authorizationCode: randomUUID(),
    };
    const invalidatedIssuer = `https://slice2-${randomUUID()}.example.test`;
    const subject = `slice2-issuer-subject-${randomUUID()}`;
    const actor = `slice2-issuer-actor-${randomUUID()}`;
    const reason = "prove issuer invalidation consumes pre-invalidation authorization codes";

    try {
      await ownerSql.begin(async (transaction) => {
        await transaction`
          INSERT INTO public.oauth_principals (id, issuer, subject, legacy_not_before)
          VALUES (
            ${ids.principal},
            ${invalidatedIssuer},
            ${subject},
            CURRENT_TIMESTAMP + INTERVAL '30 minutes'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_agent_bindings (
            id, principal_id, agent_id, status, is_default,
            binding_version, allowed_scopes
          ) VALUES (
            ${ids.binding},
            ${ids.principal},
            ${agentRows[0].id},
            'active',
            TRUE,
            1,
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[]
          )
        `;
        await transaction`
          INSERT INTO public.oauth_clients (
            id, client_id, client_kind, redirect_uris,
            token_endpoint_auth_method, status
          ) VALUES (
            ${ids.client},
            ${`slice2-issuer-client-${randomUUID()}`},
            'dynamic',
            ${transaction.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
            'none',
            'active'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_authorization_codes (
            id, code_digest, oauth_client_id, principal_id, binding_id,
            authentication_epoch, binding_version,
            redirect_uri, scopes, code_challenge, resource, expires_at
          ) VALUES (
            ${ids.authorizationCode},
            ${randomBytes(32)},
            ${ids.client},
            ${ids.principal},
            ${ids.binding},
            0,
            1,
            'https://chatgpt.com/connector_platform_oauth_redirect',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            ${"A".repeat(43)},
            'https://cortex.example.test/mcp',
            CURRENT_TIMESTAMP + INTERVAL '5 minutes'
          )
        `;
      });

      const beforeRows = await ownerSql`
        SELECT c.consumed_at IS NULL
                 AND c.authentication_epoch = p.authentication_epoch
                 AND c.binding_version = b.binding_version
                 AND p.status = 'active'
                 AND b.status = 'active' AS exchangeable
        FROM public.oauth_authorization_codes AS c
        JOIN public.oauth_principals AS p ON p.id = c.principal_id
        JOIN public.oauth_agent_bindings AS b
          ON b.id = c.binding_id AND b.principal_id = p.id
        WHERE c.id = ${ids.authorizationCode}
      `;
      expect(beforeRows).toEqual([{ exchangeable: true }]);

      const resultRows = await operatorSql`
        SELECT public.oauth_operator_invalidate_issuer(
          ${invalidatedIssuer},
          ${actor},
          ${reason}
        ) AS result
      `;
      expect(resultRows[0].result).toMatchObject({
        matched: true,
        changed: true,
        principal_count: 1,
        grant_count: 0,
        session_count: 0,
      });

      const afterRows = await ownerSql`
        SELECT p.authentication_epoch,
               p.legacy_not_before > e.created_at AS legacy_cutoff_remained_future,
               c.consumed_at IS NOT NULL AS authorization_code_consumed,
               (
                 c.consumed_at IS NULL
                 AND c.authentication_epoch = p.authentication_epoch
                 AND c.binding_version = b.binding_version
                 AND p.status = 'active'
                 AND b.status = 'active'
               ) AS exchangeable,
               e.outcome AS audit_outcome,
               e.metadata AS audit_metadata
        FROM public.oauth_authorization_codes AS c
        JOIN public.oauth_principals AS p ON p.id = c.principal_id
        JOIN public.oauth_agent_bindings AS b
          ON b.id = c.binding_id AND b.principal_id = p.id
        JOIN public.oauth_audit_events AS e
          ON e.event_type = 'operator_issuer_invalidate'
         AND e.metadata->>'actor' = ${actor}
        WHERE c.id = ${ids.authorizationCode}
      `;
      expect(afterRows).toEqual([
        {
          authentication_epoch: 1,
          legacy_cutoff_remained_future: true,
          authorization_code_consumed: true,
          exchangeable: false,
          audit_outcome: "invalidated",
          audit_metadata: {
            actor,
            reason,
            principal_count: 1,
            grant_count: 0,
            code_count: 1,
            session_count: 0,
          },
        },
      ]);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        async () => ownerSql`
          DELETE FROM public.oauth_audit_events
          WHERE event_type = 'operator_issuer_invalidate'
            AND metadata->>'actor' = ${actor}
        `,
        async () => ownerSql`
          DELETE FROM public.oauth_authorization_codes WHERE id = ${ids.authorizationCode}
        `,
        async () => ownerSql`DELETE FROM public.oauth_agent_bindings WHERE id = ${ids.binding}`,
        async () => ownerSql`DELETE FROM public.oauth_clients WHERE id = ${ids.client}`,
        async () => ownerSql`DELETE FROM public.oauth_principals WHERE id = ${ids.principal}`,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Issuer invalidation proof cleanup failed");
      }
    }
  });

  test("principal and binding controls revoke all dependent authority and remain idempotent", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const principalFixture = await createOperatorAuthorityFixture({
      issuer,
      subject: `slice8-disable-principal-${suffix}`,
      actorPrefix: `slice8-disable-principal-${suffix}`,
      agentExternalId: primaryAgentExternalId,
    });
    const bindingFixture = await createOperatorAuthorityFixture({
      issuer,
      subject: `slice8-disable-binding-${suffix}`,
      actorPrefix: `slice8-disable-binding-${suffix}`,
      agentExternalId: secondAgentExternalId,
    });

    try {
      const principalReason = "disable the principal and every dependent authority row";
      const principalActor = `${principalFixture.actorPrefix}-first`;
      const principalRepeatActor = `${principalFixture.actorPrefix}-repeat`;
      const principalResult = await operatorSql`
        SELECT public.oauth_operator_disable_principal(
          ${principalFixture.issuer},
          ${principalFixture.subject},
          ${principalActor},
          ${principalReason}
        ) AS result
      `;
      expect(principalResult[0].result).toEqual({
        matched: true,
        changed: true,
        grant_count: 1,
        code_count: 1,
        session_count: 1,
      });
      const principalRepeat = await operatorSql`
        SELECT public.oauth_operator_disable_principal(
          ${principalFixture.issuer},
          ${principalFixture.subject},
          ${principalRepeatActor},
          ${principalReason}
        ) AS result
      `;
      expect(principalRepeat[0].result).toEqual({
        matched: true,
        changed: false,
        grant_count: 0,
        code_count: 0,
        session_count: 0,
      });

      const principalState = await ownerSql`
        SELECT principal.status AS principal_status,
               principal.authentication_epoch,
               principal.disabled_reason,
               authorization_code.consumed_at IS NOT NULL AS code_consumed,
               grant_row.status AS grant_status,
               grant_row.revoked_reason AS grant_reason,
               refresh.expires_at <= GREATEST(
                 grant_row.revoked_at,
                 refresh.issued_at + INTERVAL '1 microsecond'
               ) AS refresh_clipped,
               session.revoked_at IS NOT NULL AS session_revoked,
               session.revoked_reason AS session_reason,
               audit.outcome AS first_outcome,
               audit.metadata AS first_metadata,
               repeat_audit.outcome AS repeat_outcome,
               repeat_audit.metadata AS repeat_metadata
        FROM public.oauth_principals AS principal
        JOIN public.oauth_authorization_codes AS authorization_code
          ON authorization_code.principal_id = principal.id
        JOIN public.oauth_grants AS grant_row ON grant_row.principal_id = principal.id
        JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
        JOIN public.oauth_login_sessions AS session ON session.principal_id = principal.id
        JOIN public.oauth_audit_events AS audit
          ON audit.principal_id = principal.id
         AND audit.event_type = 'operator_principal_disable'
         AND audit.metadata->>'actor' = ${principalActor}
        JOIN public.oauth_audit_events AS repeat_audit
          ON repeat_audit.principal_id = principal.id
         AND repeat_audit.event_type = 'operator_principal_disable'
         AND repeat_audit.metadata->>'actor' = ${principalRepeatActor}
        WHERE principal.id = ${principalFixture.ids.principal}
      `;
      expect(principalState).toEqual([
        {
          principal_status: "disabled",
          authentication_epoch: 1,
          disabled_reason: principalReason,
          code_consumed: true,
          grant_status: "revoked",
          grant_reason: principalReason,
          refresh_clipped: true,
          session_revoked: true,
          session_reason: principalReason,
          first_outcome: "disabled",
          first_metadata: {
            actor: principalActor,
            reason: principalReason,
            grant_count: 1,
            code_count: 1,
            session_count: 1,
          },
          repeat_outcome: "no_change",
          repeat_metadata: {
            actor: principalRepeatActor,
            reason: principalReason,
            grant_count: 0,
            code_count: 0,
            session_count: 0,
          },
        },
      ]);

      const bindingReason = "disable the binding and its code and grant families";
      const bindingActor = `${bindingFixture.actorPrefix}-first`;
      const bindingRepeatActor = `${bindingFixture.actorPrefix}-repeat`;
      const bindingResult = await operatorSql`
        SELECT public.oauth_operator_disable_binding(
          ${bindingFixture.ids.binding}::uuid,
          ${bindingActor},
          ${bindingReason}
        ) AS result
      `;
      expect(bindingResult[0].result).toEqual({
        matched: true,
        changed: true,
        grant_count: 1,
        code_count: 1,
        binding_id: bindingFixture.ids.binding,
      });
      const bindingRepeat = await operatorSql`
        SELECT public.oauth_operator_disable_binding(
          ${bindingFixture.ids.binding}::uuid,
          ${bindingRepeatActor},
          ${bindingReason}
        ) AS result
      `;
      expect(bindingRepeat[0].result).toEqual({
        matched: true,
        changed: false,
        grant_count: 0,
        code_count: 0,
        binding_id: bindingFixture.ids.binding,
      });

      const bindingState = await ownerSql`
        SELECT binding.status AS binding_status,
               binding.is_default,
               binding.binding_version,
               binding.revoked_reason AS binding_reason,
               authorization_code.consumed_at IS NOT NULL AS code_consumed,
               grant_row.status AS grant_status,
               refresh.expires_at <= GREATEST(
                 grant_row.revoked_at,
                 refresh.issued_at + INTERVAL '1 microsecond'
               ) AS refresh_clipped,
               session.revoked_at IS NULL AS session_preserved,
               audit.principal_id AS audit_principal_id,
               audit.binding_id AS audit_binding_id,
               audit.outcome AS first_outcome,
               audit.metadata AS first_metadata,
               repeat_audit.outcome AS repeat_outcome,
               repeat_audit.metadata AS repeat_metadata
        FROM public.oauth_agent_bindings AS binding
        JOIN public.oauth_authorization_codes AS authorization_code
          ON authorization_code.binding_id = binding.id
        JOIN public.oauth_grants AS grant_row ON grant_row.binding_id = binding.id
        JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
        JOIN public.oauth_login_sessions AS session
          ON session.principal_id = binding.principal_id
        JOIN public.oauth_audit_events AS audit
          ON audit.binding_id = binding.id
         AND audit.event_type = 'operator_binding_disable'
         AND audit.metadata->>'actor' = ${bindingActor}
        JOIN public.oauth_audit_events AS repeat_audit
          ON repeat_audit.binding_id = binding.id
         AND repeat_audit.event_type = 'operator_binding_disable'
         AND repeat_audit.metadata->>'actor' = ${bindingRepeatActor}
        WHERE binding.id = ${bindingFixture.ids.binding}
      `;
      expect(bindingState).toEqual([
        {
          binding_status: "revoked",
          is_default: false,
          binding_version: 2,
          binding_reason: bindingReason,
          code_consumed: true,
          grant_status: "revoked",
          refresh_clipped: true,
          session_preserved: true,
          audit_principal_id: null,
          audit_binding_id: bindingFixture.ids.binding,
          first_outcome: "disabled",
          first_metadata: {
            actor: bindingActor,
            reason: bindingReason,
            grant_count: 1,
            code_count: 1,
          },
          repeat_outcome: "no_change",
          repeat_metadata: {
            actor: bindingRepeatActor,
            reason: bindingReason,
            grant_count: 0,
            code_count: 0,
          },
        },
      ]);

      const forbiddenViewColumns = await ownerSql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY(${ownerSql.array([
            "oauth_operator_grants",
            "oauth_operator_principals",
            "oauth_operator_bindings",
            "oauth_operator_rollout_status",
          ])}::text[])
          AND column_name = ANY(${ownerSql.array([
            "code_digest",
            "jti_digest",
            "reconstruction_nonce",
            "request_fingerprint",
            "session_digest",
            "legacy_cookie_digest",
            "ip_fingerprint",
            "user_agent_fingerprint",
          ])}::text[])
      `;
      expect(forbiddenViewColumns).toEqual([]);
      expect(JSON.stringify(principalResult[0].result)).not.toContain(principalReason);
      expect(JSON.stringify(bindingResult[0].result)).not.toContain(bindingReason);
    } finally {
      await cleanupOperatorAuthorityFixture(principalFixture);
      await cleanupOperatorAuthorityFixture(bindingFixture);
    }
  });

  test("every operator mutation rolls back its authority changes when audit insertion fails", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const fixture = await createOperatorAuthorityFixture({
      issuer: `https://slice8-rollback-${suffix}.example.test`,
      subject: `slice8-rollback-subject-${suffix}`,
      actorPrefix: `slice8-rollback-${suffix}`,
      agentExternalId: primaryAgentExternalId,
    });
    let triggerInstalled = false;

    try {
      await ownerSql`
        CREATE FUNCTION public.slice8_fail_operator_audit()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $function$
        BEGIN
          IF NEW.actor_type = 'operator'
             AND NEW.metadata->>'actor' LIKE 'slice8-rollback-%'
          THEN
            RAISE EXCEPTION 'injected Slice 8 operator audit failure';
          END IF;
          RETURN NEW;
        END
        $function$
      `;
      await ownerSql`
        CREATE TRIGGER slice8_fail_operator_audit
        BEFORE INSERT ON public.oauth_audit_events
        FOR EACH ROW EXECUTE FUNCTION public.slice8_fail_operator_audit()
      `;
      triggerInstalled = true;

      const reason = "prove operator mutation and audit share one transaction";
      const operations = [
        (actor: string) => operatorSql`
          SELECT public.oauth_operator_revoke_grant(
            ${fixture.ids.grant}::uuid, ${actor}, ${reason}
          )
        `,
        (actor: string) => operatorSql`
          SELECT public.oauth_operator_revoke_all_for_principal(
            ${fixture.issuer}, ${fixture.subject}, ${actor}, ${reason}
          )
        `,
        (actor: string) => operatorSql`
          SELECT public.oauth_operator_disable_principal(
            ${fixture.issuer}, ${fixture.subject}, ${actor}, ${reason}
          )
        `,
        (actor: string) => operatorSql`
          SELECT public.oauth_operator_disable_binding(
            ${fixture.ids.binding}::uuid, ${actor}, ${reason}
          )
        `,
        (actor: string) => operatorSql`
          SELECT public.oauth_operator_security_logout(
            ${fixture.issuer}, ${fixture.subject}, ${actor}, ${reason}
          )
        `,
        (actor: string) => operatorSql`
          SELECT public.oauth_operator_invalidate_issuer(
            ${fixture.issuer}, ${actor}, ${reason}
          )
        `,
      ];

      for (const [index, operation] of operations.entries()) {
        const actor = `${fixture.actorPrefix}-${index}`;
        await expect(operation(actor)).rejects.toMatchObject({
          code: "P0001",
          message: "injected Slice 8 operator audit failure",
        });
        const unchanged = await ownerSql`
          SELECT principal.status AS principal_status,
                 principal.authentication_epoch,
                 principal.legacy_not_before = 'epoch'::timestamptz AS legacy_cutoff_unchanged,
                 binding.status AS binding_status,
                 binding.is_default,
                 binding.binding_version,
                 authorization_code.consumed_at IS NULL AS code_unconsumed,
                 grant_row.status AS grant_status,
                 grant_row.revoked_at IS NULL AS grant_not_revoked,
                 refresh.expires_at > pg_catalog.clock_timestamp() AS refresh_live,
                 session.revoked_at IS NULL AS session_live,
                 NOT EXISTS (
                   SELECT 1 FROM public.oauth_audit_events AS audit
                   WHERE audit.metadata->>'actor' = ${actor}
                 ) AS no_audit
          FROM public.oauth_principals AS principal
          JOIN public.oauth_agent_bindings AS binding ON binding.principal_id = principal.id
          JOIN public.oauth_authorization_codes AS authorization_code
            ON authorization_code.principal_id = principal.id
          JOIN public.oauth_grants AS grant_row ON grant_row.principal_id = principal.id
          JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
          JOIN public.oauth_login_sessions AS session ON session.principal_id = principal.id
          WHERE principal.id = ${fixture.ids.principal}
        `;
        expect(unchanged).toEqual([
          {
            principal_status: "active",
            authentication_epoch: 0,
            legacy_cutoff_unchanged: true,
            binding_status: "active",
            is_default: true,
            binding_version: 1,
            code_unconsumed: true,
            grant_status: "active",
            grant_not_revoked: true,
            refresh_live: true,
            session_live: true,
            no_audit: true,
          },
        ]);
      }
    } finally {
      if (triggerInstalled) {
        await ownerSql`DROP TRIGGER slice8_fail_operator_audit ON public.oauth_audit_events`;
      }
      await ownerSql`DROP FUNCTION IF EXISTS public.slice8_fail_operator_audit()`;
      await cleanupOperatorAuthorityFixture(fixture);
    }
  });

  test("principal revoke-all follows code-to-grant order and timestamps after a waiting exchange", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const fixture = await createOperatorAuthorityFixture({
      issuer: `https://slice8-race-${suffix}.example.test`,
      subject: `slice8-race-subject-${suffix}`,
      actorPrefix: `slice8-race-${suffix}`,
      agentExternalId: secondAgentExternalId,
      includeGrant: false,
    });
    const actor = `${fixture.actorPrefix}-operator`;
    const reason = "revoke the grant committed by the in-flight exchange";
    let releaseExchange: () => void = () => {};
    let exchangeReleased = false;
    let exchangePromise: Promise<Date> | null = null;
    let operatorPromise: Promise<Record<string, unknown>> | null = null;
    let raceTimeout: ReturnType<typeof setTimeout> | null = null;

    try {
      let markCodeLocked!: () => void;
      const codeLocked = new Promise<void>((resolvePromise) => {
        markCodeLocked = resolvePromise;
      });
      const exchangeRelease = new Promise<void>((resolvePromise) => {
        releaseExchange = resolvePromise;
      });
      exchangePromise = gatewaySql.begin(async (transaction) => {
        const codeRows = await transaction`
          SELECT id
          FROM public.oauth_authorization_codes
          WHERE id = ${fixture.ids.authorizationCode}
          FOR UPDATE
        `;
        expect(codeRows).toHaveLength(1);
        markCodeLocked();
        await exchangeRelease;
        await transaction`
          INSERT INTO public.oauth_grants (
            id, principal_id, binding_id, oauth_client_id, resource, scopes,
            authentication_epoch, binding_version, status,
            current_refresh_generation, inactivity_expires_at
          ) VALUES (
            ${fixture.ids.grant},
            ${fixture.ids.principal},
            ${fixture.ids.binding},
            ${fixture.ids.client},
            'https://cortex.example.test/mcp',
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            0,
            1,
            'active',
            0,
            CURRENT_TIMESTAMP + INTERVAL '2 hours'
          )
        `;
        await transaction`
          INSERT INTO public.oauth_refresh_tokens (
            id, grant_id, generation, kind, jti_digest, reconstruction_nonce,
            effective_scopes, issued_at, expires_at
          ) VALUES (
            ${fixture.ids.refresh},
            ${fixture.ids.grant},
            0,
            'v2',
            ${randomBytes(32)},
            ${randomBytes(32)},
            ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '2 hours'
          )
        `;
        await transaction`
          UPDATE public.oauth_authorization_codes
          SET consumed_at = GREATEST(CURRENT_TIMESTAMP, created_at)
          WHERE id = ${fixture.ids.authorizationCode}
        `;
        const clockRows = await transaction`
          SELECT pg_catalog.clock_timestamp() AS exchange_completed_at
        `;
        return clockRows[0].exchange_completed_at;
      }) as Promise<Date>;
      await codeLocked;

      let publishOperatorPid!: (pid: number) => void;
      const operatorPidReady = new Promise<number>((resolvePromise) => {
        publishOperatorPid = resolvePromise;
      });
      operatorPromise = operatorSql.begin(async (transaction) => {
        const pidRows = await transaction`SELECT pg_catalog.pg_backend_pid() AS pid`;
        publishOperatorPid(pidRows[0].pid);
        const resultRows = await transaction`
          SELECT public.oauth_operator_revoke_all_for_principal(
            ${fixture.issuer}, ${fixture.subject}, ${actor}, ${reason}
          ) AS result
        `;
        return resultRows[0].result;
      }) as Promise<Record<string, unknown>>;
      const operatorPid = await operatorPidReady;

      let operatorWaited = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waitRows = await ownerSql`
          SELECT wait_event_type
          FROM pg_catalog.pg_stat_activity
          WHERE pid = ${operatorPid}
        `;
        if (waitRows[0]?.wait_event_type === "Lock") {
          operatorWaited = true;
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(operatorWaited).toBe(true);

      releaseExchange();
      exchangeReleased = true;
      const timeout = new Promise<never>((_, reject) => {
        raceTimeout = setTimeout(
          () => reject(new Error("Slice 8 code/grant ordering race timed out")),
          10_000
        );
      });
      const [exchangeCompletedAt, operatorResult] = await Promise.race([
        Promise.all([exchangePromise, operatorPromise]),
        timeout,
      ]);
      if (raceTimeout !== null) {
        clearTimeout(raceTimeout);
        raceTimeout = null;
      }
      expect(operatorResult).toEqual({
        matched: true,
        changed: true,
        grant_count: 1,
        code_count: 0,
      });

      const finalState = await ownerSql`
        SELECT grant_row.status AS grant_status,
               grant_row.revoked_reason,
               refresh.expires_at <= GREATEST(
                 grant_row.revoked_at,
                 refresh.issued_at + INTERVAL '1 microsecond'
               ) AS refresh_clipped,
               authorization_code.consumed_at IS NOT NULL AS code_consumed,
               audit.created_at >= ${exchangeCompletedAt}::timestamptz AS post_lock_clock,
               audit.outcome,
               audit.metadata
        FROM public.oauth_grants AS grant_row
        JOIN public.oauth_refresh_tokens AS refresh ON refresh.grant_id = grant_row.id
        JOIN public.oauth_authorization_codes AS authorization_code
          ON authorization_code.principal_id = grant_row.principal_id
        JOIN public.oauth_audit_events AS audit
          ON audit.principal_id = grant_row.principal_id
         AND audit.event_type = 'operator_principal_revoke_all'
         AND audit.metadata->>'actor' = ${actor}
        WHERE grant_row.id = ${fixture.ids.grant}
      `;
      expect(finalState).toEqual([
        {
          grant_status: "revoked",
          revoked_reason: reason,
          refresh_clipped: true,
          code_consumed: true,
          post_lock_clock: true,
          outcome: "revoked",
          metadata: {
            actor,
            reason,
            grant_count: 1,
            code_count: 0,
          },
        },
      ]);
    } finally {
      if (raceTimeout !== null) clearTimeout(raceTimeout);
      if (!exchangeReleased) releaseExchange();
      await Promise.allSettled([
        exchangePromise ?? Promise.resolve(new Date()),
        operatorPromise ?? Promise.resolve({}),
      ]);
      await cleanupOperatorAuthorityFixture(fixture);
    }
  });
});
