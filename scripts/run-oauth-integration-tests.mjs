import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(repositoryRoot, "docker-compose.test.yml");
const migrationsDirectory = resolve(repositoryRoot, "db/migrations");
const projectName = `cortex-oauth-test-${process.pid}`;
let activeChild = null;
const forceKillTimers = new Map();
let receivedSignal = null;

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
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
      reject(new Error(`OAuth integration run interrupted by ${receivedSignal}`));
      return;
    }

    let output = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env || process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      detached: process.platform !== "win32"
    });
    activeChild = child;
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, options.timeoutMs || 180_000);

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
        resolvePromise(options.capture ? output.trim() : undefined);
        return;
      }
      reject(new Error(
        timedOut
          ? `${command} exceeded its ${options.timeoutMs || 180_000}ms timeout`
          : `${command} exited ${signal ? `from ${signal}` : `with code ${code}`}`
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
  composeAttempted = true;
  await run(
    "docker",
    [...compose, "up", "--detach", "--wait", "db", "migration_db"],
    { env: composeEnvironment }
  );

  const publishedPort = await run(
    "docker",
    [...compose, "port", "db", "5432"],
    { env: composeEnvironment, capture: true, timeoutMs: 30_000 }
  );
  const portMatch = publishedPort.match(/^127\.0\.0\.1:([1-9][0-9]*)$/);
  if (!portMatch) {
    throw new Error("Disposable PostgreSQL did not publish one IPv4 loopback port");
  }
  const databasePort = portMatch[1];
  const publishedMigrationPort = await run(
    "docker",
    [...compose, "port", "migration_db", "5432"],
    { env: composeEnvironment, capture: true, timeoutMs: 30_000 }
  );
  const migrationPortMatch = publishedMigrationPort.match(/^127\.0\.0\.1:([1-9][0-9]*)$/);
  if (!migrationPortMatch) {
    throw new Error("Fresh disposable PostgreSQL did not publish one IPv4 loopback port");
  }
  const migrationDatabaseUrl =
    `postgresql://cortex_test:cortex-test-password@127.0.0.1:${migrationPortMatch[1]}/cortex_test`;
  const ownerDatabaseUrl =
    `postgresql://cortex_test:cortex-test-password@127.0.0.1:${databasePort}/cortex_test`;
  const gatewayDatabaseUrl =
    `postgresql://cortex_oauth_gateway:gateway-test-password@127.0.0.1:${databasePort}/cortex_test`;
  const operatorDatabaseUrl =
    `postgresql://cortex_oauth_operator_user:operator-test-password@127.0.0.1:${databasePort}/cortex_test`;
  const testJwtSecret = "slice-3-disposable-jwt-secret-32-bytes-minimum";
  const testEnvironment = {
    ...composeEnvironment,
    DATABASE_URL: ownerDatabaseUrl,
    MCP_OAUTH_DATABASE_URL: gatewayDatabaseUrl,
    MCP_OAUTH_OPERATOR_DATABASE_URL: operatorDatabaseUrl,
    MCP_OAUTH_USERNAME: "test-user-a",
    MCP_OAUTH_PASSWORD: "test-password-a",
    MCP_OAUTH_JWT_SECRET: testJwtSecret,
    MCP_OAUTH_AGENT_ID: "agent-a",
    BASE_URL: "https://cortex.example.test",
    RESOURCE_URL: "https://cortex.example.test/mcp",
    ISSUER_URL: "https://cortex.example.test",
    MCP_OAUTH_ACCEPT_LEGACY_UNTIL: new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString(),
    MCP_OAUTH_MIGRATION_FILE: resolve(
      migrationsDirectory,
      "009_oauth_authority.sql"
    ),
    CORTEX_MIGRATIONS_DIR: migrationsDirectory,
    MCP_OAUTH_TEST_DATABASE_URL: gatewayDatabaseUrl,
    MCP_OAUTH_TEST_OWNER_DATABASE_URL: ownerDatabaseUrl,
    MCP_OAUTH_TEST_FRESH_DATABASE_URL: migrationDatabaseUrl,
    MCP_OAUTH_TEST_OPERATOR_DATABASE_URL: operatorDatabaseUrl,
    MCP_OAUTH_TEST_DISPOSABLE: "1",
    MCP_OAUTH_TEST_ISSUER: "https://cortex.example.test",
    MCP_OAUTH_TEST_SUBJECT: "test-user-a",
    MCP_OAUTH_TEST_AGENT_ID: "agent-a",
    MCP_OAUTH_TEST_PASSWORD: "test-password-a",
    MCP_OAUTH_TEST_JWT_SECRET: testJwtSecret,
    MCP_OAUTH_TEST_SECOND_SUBJECT: "test-user-b",
    MCP_OAUTH_TEST_SECOND_AGENT_ID: "agent-b",
    MCP_OAUTH_TEST_DOCKER_NETWORK: `${projectName}_default`
  };

  await run(
    "docker",
    [
      ...compose,
      "exec",
      "--no-TTY",
      "db",
      "psql",
      "--username",
      "cortex_test",
      "--dbname",
      "cortex_test",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      "INSERT INTO agents (external_id, name) VALUES ('agent-a', 'Agent A'), ('agent-b', 'Agent B') ON CONFLICT (external_id) DO NOTHING"
    ],
    { env: composeEnvironment }
  );

  await run("npm", ["run", "oauth:prepare"], { env: testEnvironment });
  await run("npm", ["run", "oauth:prepare"], { env: testEnvironment });
  await run("npm", ["test"], { env: testEnvironment });
  await run("npm", ["--prefix", "oauth-gateway", "test"], { env: testEnvironment });
  await run("npm", ["run", "test:oauth:database"], { env: testEnvironment });
  await run(
    "npm",
    ["--prefix", "oauth-gateway", "run", "test:integration"],
    { env: testEnvironment }
  );
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
      console.error(`[oauth-integration] cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
