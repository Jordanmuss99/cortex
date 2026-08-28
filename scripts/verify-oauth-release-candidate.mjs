import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateTag = process.env.MCP_OAUTH_RELEASE_CANDIDATE_TAG?.trim() ||
  "cortex-oauth-gateway:db-compat-slice13";
const preV2Tag = process.env.MCP_OAUTH_PRE_V2_IMAGE?.trim() ||
  "cortex-oauth-gateway:pre-v2-slice13";
const expectedPreV2ImageId =
  "sha256:e6e72c2e293a2773892b46ad952c5e1ee51c9b958cba9f290f9425f07c7f6d52";
const frozenMigration009Sha256 =
  "e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80";
const currentMigration010Sha256 =
  "c41cdcbd0bdef50d673dbb19bbdea47403d4b8e8981c7d2438f6a1ead8789df5";
let activeChild = null;
let receivedSignal = null;

function terminate(child, signal = "SIGTERM") {
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
    if (receivedSignal) {
      reject(new Error(`release-candidate verification interrupted by ${receivedSignal}`));
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
    const timeoutMs = options.timeoutMs ?? 180_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child);
      setTimeout(() => terminate(child, "SIGKILL"), 5_000).unref?.();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (activeChild === child) activeChild = null;
      if (code === 0) {
        resolvePromise(options.capture
          ? Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim() })
          : undefined);
        return;
      }
      reject(new Error(
        timedOut
          ? `${command} exceeded its ${timeoutMs}ms timeout`
          : `${command} exited ${signal ? `from ${signal}` : `with code ${code}`}`
      ));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receivedSignal = signal;
    if (activeChild) terminate(activeChild, signal);
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function localImageId(reference) {
  const result = await run(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", reference],
    { capture: true, timeoutMs: 30_000 }
  );
  assert.match(result.stdout, /^sha256:[0-9a-f]{64}$/);
  return result.stdout;
}

const [migration009, migration010] = await Promise.all([
  readFile(resolve(repositoryRoot, "db/migrations/009_oauth_authority.sql")),
  readFile(resolve(repositoryRoot, "db/migrations/010_memory_lifecycle.sql"))
]);
assert.equal(sha256(migration009), frozenMigration009Sha256);
assert.equal(sha256(migration010), currentMigration010Sha256);

await run("node", ["scripts/verify-deployment-boundary.mjs"]);
await run("npm", ["run", "test:oauth:deployment"]);

const preV2ImageId = await localImageId(preV2Tag);
assert.equal(
  preV2ImageId,
  expectedPreV2ImageId,
  "the retained pre-v2 rollback tag no longer identifies the reviewed image"
);

await run(
  "docker",
  [
    "build",
    "--provenance=false",
    "--tag",
    candidateTag,
    "--file",
    "oauth-gateway/Dockerfile",
    "."
  ],
  { timeoutMs: 300_000 }
);
const candidateImageId = await localImageId(candidateTag);

const artifactProbeSource = `
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const hash = (path) => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
  const forbidden = fs.readdirSync("/app").filter((name) =>
    name === "server-v1.js" || name.endsWith(".test.js") || name.includes(".bak.")
  );
  process.stdout.write(JSON.stringify({
    server: hash("/app/server.js"),
    migration009: hash("/db/migrations/009_oauth_authority.sql"),
    migration010: hash("/db/migrations/010_memory_lifecycle.sql"),
    forbidden
  }));
`;
const artifactProbe = await run(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "node",
    candidateImageId,
    "-e",
    artifactProbeSource
  ],
  { capture: true, timeoutMs: 30_000 }
);
const artifact = JSON.parse(artifactProbe.stdout);
assert.equal(artifact.migration009, frozenMigration009Sha256);
assert.equal(artifact.migration010, currentMigration010Sha256);
assert.deepEqual(artifact.forbidden, []);
assert.equal(
  artifact.server,
  sha256(await readFile(resolve(repositoryRoot, "oauth-gateway/server.js")))
);

const imageConfig = await run(
  "docker",
  ["image", "inspect", "--format", "{{json .Config.Cmd}}", candidateImageId],
  { capture: true, timeoutMs: 30_000 }
);
assert.deepEqual(JSON.parse(imageConfig.stdout), ["node", "server.js"]);

await run(
  "npm",
  ["run", "test:oauth:integration"],
  {
    env: {
      ...process.env,
      MCP_OAUTH_TEST_RELEASE_IMAGES: "1",
      MCP_OAUTH_TEST_CANDIDATE_IMAGE: candidateImageId,
      MCP_OAUTH_TEST_PRE_V2_IMAGE: preV2ImageId
    },
    timeoutMs: 600_000
  }
);

await run("node", ["scripts/verify-oauth-restore-recovery.mjs"], {
  timeoutMs: 300_000
});

console.log(JSON.stringify({
  status: "passed",
  candidateTag,
  candidateImageId,
  candidateServerSha256: artifact.server,
  retainedPreV2Tag: preV2Tag,
  retainedPreV2ImageId: preV2ImageId,
  migration009Sha256: frozenMigration009Sha256,
  migration010Sha256: currentMigration010Sha256,
  migration010Status: "mutable-disposable-cross-plan-blocker"
}, null, 2));
