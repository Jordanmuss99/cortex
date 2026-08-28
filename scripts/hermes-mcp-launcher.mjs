import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cortexDir = resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Load Cortex's own .env so the MCP subprocess gets DATABASE_URL, VOYAGE_API_KEY,
// etc.  Both Hermes and Codex pass env values literally (no ${VAR} expansion),
// so we must resolve them here before spawning the server.
// ─────────────────────────────────────────────────────────────────────────────
function loadDotEnv(envPath) {
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, "utf8");
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const dotenvVars = loadDotEnv(resolve(cortexDir, ".env"));

// Prefer the compiled dist/ (fast startup, no TSX compilation).
// Fall back to tsx src/ if dist/ doesn't exist (dev mode).
const distServer = resolve(cortexDir, "dist", "src", "mcp", "server.js");
const srcServer = resolve(cortexDir, "src", "mcp", "server.ts");

let args;
if (existsSync(distServer)) {
  // Compiled JS -- fast, no extra deps needed at runtime
  args = [distServer];
} else {
  // TypeScript source -- needs tsx
  args = ["--import", "tsx", srcServer];
}

// Build the child environment: start from process env (Hermes/Codex pass PATH etc.),
// overlay the Cortex .env vars, then overlay anything from the parent process.
const childEnv = { ...process.env, ...dotenvVars };

const child = spawn(process.execPath, args, {
  cwd: cortexDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: childEnv,
});

let alive = true;

function cleanup(signal) {
  if (!alive) return;
  alive = false;
  try { child.kill(signal); } catch {}
  process.exit(signal === "SIGTERM" ? 0 : 1);
}

process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("SIGINT", () => cleanup("SIGTERM"));

child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));

process.stdin.on("data", (d) => {
  if (alive) child.stdin.write(d);
});

// Keep process alive across stdin EOF -- Hermes/Codex mcp test closes stdin early.
process.stdin.on("end", () => {});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error("[cortex-mcp-launcher] failed to start Cortex MCP server:", err.message);
  process.exit(1);
});