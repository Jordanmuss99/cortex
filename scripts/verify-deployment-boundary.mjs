import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseCompose = resolve(repositoryRoot, "docker-compose.yml");
const adminCompose = resolve(repositoryRoot, "docker-compose.admin.yml");

const RENDER_ENVIRONMENT = Object.freeze({
  ...process.env,
  CORTEX_DB_OWNER_PASSWORD: "boundary-owner-password",
  CORTEX_DATABASE_OWNER_URL: "postgresql://boundary_owner:owner@db:5432/cortex",
  MCP_OAUTH_DATABASE_URL:
    "postgresql://cortex_oauth_gateway:gateway@db:5432/cortex",
  MCP_OAUTH_OPERATOR_DATABASE_URL:
    "postgresql://cortex_oauth_operator_user:operator@db:5432/cortex",
  CORTEX_MEMORY_DATABASE_URL:
    "postgresql://cortex_memory_user:memory@db:5432/cortex",
  MCP_OAUTH_USERNAME: "boundary-user",
  MCP_OAUTH_AGENT_ID: "boundary-agent",
  MCP_OAUTH_PASSWORD: "boundary-browser-password",
  MCP_OAUTH_JWT_SECRET: "boundary-jwt-secret-that-is-at-least-32-bytes",
  MCP_OAUTH_ACCEPT_LEGACY_UNTIL: "2026-09-05T00:00:00Z",
  CORTEX_BUILD_ID: "slice13-boundary",
  VOYAGE_API_KEY: "boundary-voyage",
  ANTHROPIC_API_KEY: "boundary-anthropic",
  OLLAMA_API_KEY: "boundary-ollama",
});

function fail(message) {
  throw new Error(`Deployment boundary rejected: ${message}`);
}

function service(config, name) {
  const value = config?.services?.[name];
  if (!value) fail(`required service ${name} is missing`);
  return value;
}

function publishedPorts(value) {
  return Array.isArray(value?.ports) ? value.ports : [];
}

function assertLoopbackPort(value, target, label) {
  if (
    value?.host_ip !== "127.0.0.1" ||
    Number(value?.target) !== target ||
    value?.protocol !== "tcp"
  ) fail(`${label} must be published only on IPv4 loopback`);
}

function networkNames(value) {
  if (Array.isArray(value?.networks)) return [...value.networks].sort();
  return Object.keys(value?.networks ?? {}).sort();
}

function assertMigrationDependency(value, name) {
  if (value?.depends_on?.["cortex-migrate"]?.condition !== "service_completed_successfully") {
    fail(`${name} does not wait for the one-shot migration`);
  }
}

function environmentKeys(value) {
  return new Set(Object.keys(value?.environment ?? {}));
}

function assertNoEnvironmentKeys(value, forbidden, label) {
  const keys = environmentKeys(value);
  for (const key of forbidden) {
    if (keys.has(key)) fail(`${label} receives forbidden ${key}`);
  }
}

function mountForTarget(value, target) {
  return (value?.volumes ?? []).find((volume) => volume?.target === target);
}

export function verifyDeploymentBoundary(config, { admin = false } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("rendered Compose JSON is invalid");
  }
  for (const value of Object.values(config.services ?? {})) {
    if (value.container_name !== undefined) fail("fixed container names are forbidden");
  }

  const gateway = service(config, "cortex-oauth-gateway");
  const gatewayPorts = publishedPorts(gateway);
  if (gatewayPorts.length !== 1) fail("gateway must have exactly one published port");
  assertLoopbackPort(gatewayPorts[0], 8080, "gateway");
  if (networkNames(gateway).join(",") !== "edge,private") {
    fail("gateway must join exactly edge and private networks");
  }
  if (!String(gateway.healthcheck?.test?.join(" ") ?? "").includes("/readyz")) {
    fail("gateway healthcheck must use /readyz");
  }
  const stateMount = mountForTarget(gateway, "/var/lib/cortex-oauth");
  if (!stateMount || stateMount.read_only !== true) {
    fail("legacy OAuth state must be mounted read-only");
  }
  assertNoEnvironmentKeys(
    gateway,
    ["DATABASE_URL", "MCP_OAUTH_OPERATOR_DATABASE_URL"],
    "gateway"
  );
  if (!environmentKeys(gateway).has("MCP_OAUTH_DATABASE_URL")) {
    fail("gateway is missing its runtime database URL");
  }

  const migrate = service(config, "cortex-migrate");
  const migrationKeys = environmentKeys(migrate);
  for (const key of [
    "DATABASE_URL",
    "MCP_OAUTH_DATABASE_URL",
    "MCP_OAUTH_OPERATOR_DATABASE_URL"
  ]) {
    if (!migrationKeys.has(key)) fail(`migration service is missing ${key}`);
  }

  const rawPorts = new Map([
    ["db", 5432],
    ["cortex", 3100],
    ["cortex-mcp", 8000],
    ["cortex-dashboard", 80],
  ]);
  for (const [name, target] of rawPorts) {
    const value = service(config, name);
    const ports = publishedPorts(value);
    if (!admin && ports.length !== 0) fail(`${name} publishes a privileged port`);
    if (admin) {
      if (ports.length !== 1) fail(`${name} must have exactly one admin binding`);
      assertLoopbackPort(ports[0], target, name);
    }
  }

  for (const name of [
    "db",
    "cortex-migrate",
    "cortex",
    "cortex-worker",
    "cortex-mcp",
    "cortex-dashboard",
    "cortex-cron",
  ]) {
    if (networkNames(service(config, name)).join(",") !== "private") {
      fail(`${name} must join only the private network`);
    }
  }
  if (config.networks?.private?.internal === true) {
    fail("private network must retain required outbound egress");
  }
  if (config.networks?.edge?.external !== true) fail("edge network must be external");

  for (const name of [
    "cortex",
    "cortex-worker",
    "cortex-mcp",
    "cortex-oauth-gateway",
    "cortex-dashboard",
    "cortex-cron",
  ]) assertMigrationDependency(service(config, name), name);

  if (admin) {
    const adminService = service(config, "cortex-oauth-admin");
    assertMigrationDependency(adminService, "cortex-oauth-admin");
    const adminKeys = environmentKeys(adminService);
    if (!adminKeys.has("MCP_OAUTH_OPERATOR_DATABASE_URL")) {
      fail("admin is missing its operator database URL");
    }
    assertNoEnvironmentKeys(
      adminService,
      [
        "DATABASE_URL",
        "MCP_OAUTH_DATABASE_URL",
        "MCP_OAUTH_JWT_SECRET",
        "MCP_OAUTH_PASSWORD",
      ],
      "admin"
    );
  }
  return true;
}

export function renderCompose({ admin = false } = {}) {
  const args = ["compose", "--file", baseCompose];
  if (admin) args.push("--file", adminCompose, "--profile", "admin");
  args.push("config", "--format", "json");
  const rendered = execFileSync("docker", args, {
    cwd: repositoryRoot,
    env: RENDER_ENVIRONMENT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(rendered);
}

export function verifyCheckedInDeployment() {
  verifyDeploymentBoundary(renderCompose(), { admin: false });
  verifyDeploymentBoundary(renderCompose({ admin: true }), { admin: true });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    verifyCheckedInDeployment();
    console.log("Deployment boundary verified.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment boundary rejected");
    process.exitCode = 1;
  }
}
