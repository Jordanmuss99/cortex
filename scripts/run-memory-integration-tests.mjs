import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(repositoryRoot, "docker-compose.test.yml");
const projectName = `cortex-memory-test-${process.pid}`;
let activeChild = null;
let receivedSignal = null;

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    if (receivedSignal && !options.allowAfterSignal) {
      reject(new Error(`Memory integration run interrupted by ${receivedSignal}`));
      return;
    }
    let output = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env || process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      detached: process.platform !== "win32",
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
      signalProcessTree(child, "SIGTERM");
      setTimeout(() => signalProcessTree(child, "SIGKILL"), 5_000).unref();
    }, options.timeoutMs || 180_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (code === 0) {
        resolvePromise(options.capture ? output.trim() : undefined);
        return;
      }
      reject(
        new Error(
          timedOut
            ? `${command} exceeded its timeout`
            : `${command} exited ${signal ? `from ${signal}` : `with code ${code}`}`
        )
      );
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal = signal;
    if (activeChild) signalProcessTree(activeChild, signal);
  });
}

const compose = [
  "compose",
  "--project-name",
  projectName,
  "--file",
  composeFile,
];
let composeAttempted = false;

try {
  composeAttempted = true;
  await run("docker", [
    ...compose,
    "up",
    "--detach",
    "--wait",
    "db",
    "migration_db",
  ]);
  const published = await run(
    "docker",
    [...compose, "port", "migration_db", "5432"],
    { capture: true, timeoutMs: 30_000 }
  );
  const portMatch = published.match(/^127\.0\.0\.1:([1-9][0-9]*)$/);
  if (!portMatch) {
    throw new Error("Disposable memory PostgreSQL did not publish one IPv4 loopback port");
  }
  const preflightPublished = await run(
    "docker",
    [...compose, "port", "db", "5432"],
    { capture: true, timeoutMs: 30_000 }
  );
  const preflightPortMatch = preflightPublished.match(
    /^127\.0\.0\.1:([1-9][0-9]*)$/
  );
  if (!preflightPortMatch || preflightPortMatch[1] === portMatch[1]) {
    throw new Error(
      "Migration preflight PostgreSQL did not publish a distinct IPv4 loopback port"
    );
  }

  const databaseUrl =
    `postgresql://cortex_test:cortex-test-password@127.0.0.1:${portMatch[1]}/cortex_test`;
  const preflightDatabaseUrl =
    `postgresql://cortex_test:cortex-test-password@127.0.0.1:${preflightPortMatch[1]}/cortex_test`;
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    CORTEX_MEMORY_TEST_DATABASE_URL: databaseUrl,
    CORTEX_MEMORY_TEST_PREFLIGHT_DATABASE_URL: preflightDatabaseUrl,
    CORTEX_MEMORY_TEST_DISPOSABLE: "1",
    CORTEX_BUILD_ID: "slice3-integration",
    CORTEX_HEADLESS: "true",
  };

  await run("npm", ["run", "build"], { env: environment });
  await run("npm", ["run", "migrate"], { env: environment });
  await run("npm", ["run", "test:memory:database"], {
    env: environment,
    timeoutMs: 120_000,
  });
} finally {
  if (composeAttempted) {
    await run(
      "docker",
      [...compose, "down", "--volumes", "--remove-orphans"],
      { allowAfterSignal: true, timeoutMs: 60_000 }
    ).catch((error) => {
      console.error(`[memory-integration] cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
