import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Disposable-only restore proof. Every Compose call supplies both a unique
// project name and docker-compose.test.yml; this script never loads or targets
// the live stack, and it deliberately never starts a gateway process.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(repositoryRoot, "docker-compose.test.yml");
const migrationsDirectory = resolve(repositoryRoot, "db/migrations");
const frozenOAuthMigrationSha256 =
  "e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80";
const runSuffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
const projectName = `cortex-oauth-recovery-${runSuffix}`;
const snapshotPath = `/tmp/cortex-oauth-recovery-${runSuffix}.dump`;
const testPasswords = Object.freeze([
  "cortex-test-password",
  "gateway-test-password",
  "operator-test-password"
]);

let activeChild = null;
let receivedSignal = null;
const forceKillTimers = new Map();

function redactMessage(value) {
  let message = typeof value === "string" ? value : "unknown failure";
  for (const password of testPasswords) message = message.replaceAll(password, "[redacted]");
  return message;
}

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function terminateProcessTree(child, signal = "SIGTERM") {
  signalProcessTree(child, signal);
  if (child?.pid && !forceKillTimers.has(child.pid)) {
    const timer = setTimeout(() => {
      signalProcessTree(child, "SIGKILL");
      forceKillTimers.delete(child.pid);
    }, 5_000);
    timer.unref?.();
    forceKillTimers.set(child.pid, timer);
  }
}

function clearForceKillTimer(child) {
  const timer = child?.pid ? forceKillTimers.get(child.pid) : undefined;
  if (!timer) return;
  clearTimeout(timer);
  forceKillTimers.delete(child.pid);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    if (receivedSignal && !options.allowAfterSignal) {
      reject(new Error(`recovery drill interrupted by ${receivedSignal}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      detached: process.platform !== "win32"
    });
    activeChild = child;
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    const timeoutMilliseconds = options.timeoutMs ?? 180_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMilliseconds);

    child.once("error", (error) => {
      clearTimeout(timeout);
      clearForceKillTimer(child);
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearForceKillTimer(child);
      if (activeChild === child) activeChild = null;
      if (code === 0) {
        resolvePromise(options.capture
          ? Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim() })
          : undefined);
        return;
      }
      const detail = options.capture && stderr.trim()
        ? `: ${redactMessage(stderr.trim())}`
        : "";
      reject(new Error(
        timedOut
          ? `${command} exceeded its ${timeoutMilliseconds}ms timeout`
          : `${command} exited ${signal ? `from ${signal}` : `with code ${code}`}${detail}`
      ));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal = signal;
    if (activeChild) terminateProcessTree(activeChild, signal);
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function checkedMigrationChecksums() {
  const [oauthBytes, memoryBytes] = await Promise.all([
    readFile(resolve(migrationsDirectory, "009_oauth_authority.sql")),
    readFile(resolve(migrationsDirectory, "010_memory_lifecycle.sql"))
  ]);
  const oauthSha256 = sha256(oauthBytes);
  const memorySha256 = sha256(memoryBytes);
  assert.equal(
    oauthSha256,
    frozenOAuthMigrationSha256,
    "migration 009 differs from its frozen Slice 13 checksum"
  );
  return Object.freeze({ oauthSha256, memorySha256 });
}

async function assertOnlyDisposableDatabaseRuns(compose, environment) {
  const result = await run(
    "docker",
    [...compose, "ps", "--services", "--status", "running"],
    { capture: true, env: environment, timeoutMs: 30_000 }
  );
  assert.deepEqual(
    result.stdout.split(/\r?\n/u).filter(Boolean).sort(),
    ["db"],
    "the recovery project must contain only its disposable database"
  );
}

async function assertMigrationLedger(databaseUrl, checksums) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT id, pg_catalog.btrim(sha256) AS sha256
      FROM public.cortex_schema_migrations
      WHERE id IN ('009_oauth_authority', '010_memory_lifecycle')
      ORDER BY id
    `;
    assert.deepEqual([...rows], [
      { id: "009_oauth_authority", sha256: checksums.oauthSha256 },
      { id: "010_memory_lifecycle", sha256: checksums.memorySha256 }
    ]);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function seedLiveAuthority(databaseUrl, issuer) {
  const ids = Object.freeze({
    principal: randomUUID(),
    binding: randomUUID(),
    client: randomUUID(),
    authorizationCode: randomUUID(),
    grant: randomUUID(),
    refresh: randomUUID(),
    loginSession: randomUUID()
  });
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const agents = await sql`
      SELECT id FROM public.agents WHERE external_id = 'recovery-drill-agent'
    `;
    assert.equal(agents.length, 1, "the disposable recovery agent must exist");
    const agentId = agents[0].id;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO public.oauth_principals (id, issuer, subject)
        VALUES (${ids.principal}, ${issuer}, 'recovery-drill-subject')
      `;
      await transaction`
        INSERT INTO public.oauth_agent_bindings (
          id, principal_id, agent_id, status, is_default,
          binding_version, allowed_scopes
        ) VALUES (
          ${ids.binding}, ${ids.principal}, ${agentId}, 'active', TRUE,
          1, ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[]
        )
      `;
      await transaction`
        INSERT INTO public.oauth_clients (
          id, client_id, client_kind, redirect_uris,
          token_endpoint_auth_method, status
        ) VALUES (
          ${ids.client}, ${`recovery-drill-client-${runSuffix}`}, 'dynamic',
          ${transaction.array(["https://chatgpt.com/connector_platform_oauth_redirect"])}::text[],
          'none', 'active'
        )
      `;
      await transaction`
        INSERT INTO public.oauth_authorization_codes (
          id, code_digest, oauth_client_id, principal_id, binding_id,
          authentication_epoch, binding_version, redirect_uri, scopes,
          code_challenge, resource, expires_at
        ) VALUES (
          ${ids.authorizationCode}, ${randomBytes(32)}, ${ids.client},
          ${ids.principal}, ${ids.binding}, 0, 1,
          'https://chatgpt.com/connector_platform_oauth_redirect',
          ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
          ${"A".repeat(43)}, ${`${issuer}/mcp`},
          CURRENT_TIMESTAMP + INTERVAL '2 hours'
        )
      `;
      await transaction`
        INSERT INTO public.oauth_grants (
          id, principal_id, binding_id, oauth_client_id, resource, scopes,
          authentication_epoch, binding_version, status,
          current_refresh_generation, inactivity_expires_at
        ) VALUES (
          ${ids.grant}, ${ids.principal}, ${ids.binding}, ${ids.client},
          ${`${issuer}/mcp`},
          ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
          0, 1, 'active', 0, CURRENT_TIMESTAMP + INTERVAL '2 hours'
        )
      `;
      await transaction`
        INSERT INTO public.oauth_refresh_tokens (
          id, grant_id, generation, kind, jti_digest, reconstruction_nonce,
          effective_scopes, issued_at, expires_at
        ) VALUES (
          ${ids.refresh}, ${ids.grant}, 0, 'v2', ${randomBytes(32)},
          ${randomBytes(32)},
          ${transaction.array(["cortex:read", "mcp"])}::public.oauth_scope[],
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '2 hours'
        )
      `;
      await transaction`
        INSERT INTO public.oauth_login_sessions (
          id, session_digest, principal_id, ip_fingerprint,
          authentication_epoch, issued_at, expires_at
        ) VALUES (
          ${ids.loginSession}, ${randomBytes(32)}, ${ids.principal},
          ${randomBytes(32)}, 0, CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '2 hours'
        )
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  return ids;
}

async function readAuthorityState(databaseUrl, ids, actor) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT
        principal.authentication_epoch,
        code.consumed_at IS NULL AS code_live,
        (
          code.consumed_at IS NULL
          AND code.expires_at > pg_catalog.clock_timestamp()
          AND code.authentication_epoch = principal.authentication_epoch
          AND code.binding_version = binding.binding_version
          AND principal.status = 'active'
          AND binding.status = 'active'
          AND client.status = 'active'
        ) AS code_exchangeable,
        grant_row.status::text AS grant_status,
        grant_row.status = 'active'
          AND grant_row.inactivity_expires_at > pg_catalog.clock_timestamp()
          AS grant_live,
        refresh.expires_at > pg_catalog.clock_timestamp() AS refresh_live,
        session.revoked_at IS NULL
          AND session.expires_at > pg_catalog.clock_timestamp()
          AND session.authentication_epoch = principal.authentication_epoch
          AS session_live,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.oauth_audit_events AS audit
          WHERE audit.event_type = 'operator_issuer_invalidate'
            AND audit.metadata ->> 'actor' = ${actor}
        ) AS recovery_audit_count
      FROM public.oauth_principals AS principal
      JOIN public.oauth_agent_bindings AS binding ON binding.id = ${ids.binding}
      JOIN public.oauth_clients AS client ON client.id = ${ids.client}
      JOIN public.oauth_authorization_codes AS code ON code.id = ${ids.authorizationCode}
      JOIN public.oauth_grants AS grant_row ON grant_row.id = ${ids.grant}
      JOIN public.oauth_refresh_tokens AS refresh ON refresh.id = ${ids.refresh}
      JOIN public.oauth_login_sessions AS session ON session.id = ${ids.loginSession}
      WHERE principal.id = ${ids.principal}
    `;
    assert.equal(rows.length, 1, "the complete recovery authority tuple must exist");
    return Object.freeze({ ...rows[0] });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function assertLiveAuthority(state) {
  assert.deepEqual(state, {
    authentication_epoch: 0,
    code_live: true,
    code_exchangeable: true,
    grant_status: "active",
    grant_live: true,
    refresh_live: true,
    session_live: true,
    recovery_audit_count: 0
  });
}

function assertInvalidatedAuthority(state) {
  assert.deepEqual(state, {
    authentication_epoch: 1,
    code_live: false,
    code_exchangeable: false,
    grant_status: "revoked",
    grant_live: false,
    refresh_live: false,
    session_live: false,
    recovery_audit_count: 1
  });
}

async function invalidateIssuer(operatorDatabaseUrl, issuer, actor, reason) {
  const result = await run(
    process.execPath,
    [
      resolve(repositoryRoot, "oauth-gateway/admin.js"),
      "recovery",
      "invalidate-issuer",
      "--issuer",
      issuer,
      "--actor",
      actor,
      "--reason",
      reason,
      "--confirmation",
      issuer,
      "--json"
    ],
    {
      capture: true,
      env: { ...process.env, MCP_OAUTH_OPERATOR_DATABASE_URL: operatorDatabaseUrl },
      timeoutMs: 30_000
    }
  );
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    kind: "recovery.invalidateIssuer",
    matched: true,
    changed: true,
    principalCount: 1,
    grantCount: 1,
    codeCount: 1,
    sessionCount: 1
  });
}

const composeEnvironment = { ...process.env };
const compose = [
  "compose",
  "--project-name",
  projectName,
  "--file",
  composeFile
];
let composeAttempted = false;

try {
  const checksums = await checkedMigrationChecksums();
  composeAttempted = true;
  await run(
    "docker",
    [...compose, "up", "--detach", "--wait", "db"],
    { env: composeEnvironment, timeoutMs: 60_000 }
  );
  await assertOnlyDisposableDatabaseRuns(compose, composeEnvironment);

  const published = await run(
    "docker",
    [...compose, "port", "db", "5432"],
    { capture: true, env: composeEnvironment, timeoutMs: 30_000 }
  );
  const portMatch = published.stdout.match(/^127\.0\.0\.1:([1-9][0-9]*)$/u);
  assert.ok(portMatch, "the disposable recovery database must publish one loopback port");
  const port = portMatch[1];
  const ownerDatabaseUrl =
    `postgresql://cortex_test:cortex-test-password@127.0.0.1:${port}/cortex_test`;
  const gatewayDatabaseUrl =
    `postgresql://cortex_oauth_gateway:gateway-test-password@127.0.0.1:${port}/cortex_test`;
  const operatorDatabaseUrl =
    `postgresql://cortex_oauth_operator_user:operator-test-password@127.0.0.1:${port}/cortex_test`;
  const bootstrapIssuer = "https://recovery-bootstrap.example.test";
  const issuer = `https://recovery-${runSuffix}.example.test`;
  const prepareEnvironment = {
    ...process.env,
    DATABASE_URL: ownerDatabaseUrl,
    MCP_OAUTH_DATABASE_URL: gatewayDatabaseUrl,
    MCP_OAUTH_OPERATOR_DATABASE_URL: operatorDatabaseUrl,
    MCP_OAUTH_USERNAME: "recovery-bootstrap-subject",
    MCP_OAUTH_AGENT_ID: "recovery-drill-agent",
    ISSUER_URL: bootstrapIssuer,
    BASE_URL: bootstrapIssuer,
    MCP_OAUTH_TEST_DISPOSABLE: "1",
    CORTEX_MEMORY_TEST_DISPOSABLE: "1"
  };

  const ownerSql = postgres(ownerDatabaseUrl, { max: 1 });
  try {
    await ownerSql`
      INSERT INTO public.agents (external_id, name)
      VALUES ('recovery-drill-agent', 'Recovery Drill Agent')
      ON CONFLICT (external_id) DO NOTHING
    `;
  } finally {
    await ownerSql.end({ timeout: 5 });
  }

  await run("npm", ["run", "oauth:prepare"], {
    env: prepareEnvironment,
    timeoutMs: 180_000
  });
  await assertMigrationLedger(ownerDatabaseUrl, checksums);
  const ids = await seedLiveAuthority(ownerDatabaseUrl, issuer);
  const firstActor = `slice13-pre-restore-${runSuffix}`;
  const recoveryActor = `slice13-post-restore-${runSuffix}`;
  assertLiveAuthority(await readAuthorityState(ownerDatabaseUrl, ids, firstActor));

  await run(
    "docker",
    [
      ...compose,
      "exec",
      "--no-TTY",
      "db",
      "pg_dump",
      "--username",
      "cortex_test",
      "--dbname",
      "cortex_test",
      "--format",
      "custom",
      "--file",
      snapshotPath
    ],
    { env: composeEnvironment, timeoutMs: 60_000 }
  );

  await invalidateIssuer(
    operatorDatabaseUrl,
    issuer,
    firstActor,
    "Slice 13 proves a pre-revocation backup can resurrect authority"
  );
  assertInvalidatedAuthority(await readAuthorityState(ownerDatabaseUrl, ids, firstActor));

  await assertOnlyDisposableDatabaseRuns(compose, composeEnvironment);
  await run(
    "docker",
    [
      ...compose,
      "exec",
      "--no-TTY",
      "db",
      "pg_restore",
      "--username",
      "cortex_test",
      "--dbname",
      "cortex_test",
      "--clean",
      "--if-exists",
      "--exit-on-error",
      snapshotPath
    ],
    { env: composeEnvironment, timeoutMs: 120_000 }
  );

  await assertOnlyDisposableDatabaseRuns(compose, composeEnvironment);
  await assertMigrationLedger(ownerDatabaseUrl, checksums);
  assertLiveAuthority(await readAuthorityState(ownerDatabaseUrl, ids, recoveryActor));

  await invalidateIssuer(
    operatorDatabaseUrl,
    issuer,
    recoveryActor,
    "Slice 13 invalidates restored OAuth authority before gateway startup"
  );
  assertInvalidatedAuthority(await readAuthorityState(ownerDatabaseUrl, ids, recoveryActor));
  await assertOnlyDisposableDatabaseRuns(compose, composeEnvironment);

  console.log(JSON.stringify({
    status: "passed",
    proof: "restored OAuth authority invalidated before gateway startup",
    project: projectName,
    runningServices: ["db"],
    gatewayProcessesStarted: 0,
    migrations: {
      "009_oauth_authority": checksums.oauthSha256,
      "010_memory_lifecycle": checksums.memorySha256
    },
    invalidated: {
      principals: 1,
      grants: 1,
      authorizationCodes: 1,
      refreshFamilies: 1,
      loginSessions: 1
    }
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`[oauth-recovery] Failed: ${redactMessage(message)}`);
  process.exitCode = 1;
} finally {
  if (composeAttempted) {
    await run(
      "docker",
      [...compose, "down", "--volumes", "--remove-orphans"],
      {
        env: composeEnvironment,
        allowAfterSignal: true,
        timeoutMs: 60_000
      }
    ).catch((error) => {
      console.error(`[oauth-recovery] Cleanup failed: ${redactMessage(error.message)}`);
      process.exitCode = 1;
    });
  }
}
