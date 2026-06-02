// One-shot MCP stdio smoke test: spawns the server, sends initialize +
// tools/list, prints the responses, then exits. Used for wiring verification.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const cmd = isWin ? "cmd.exe" : "node_modules/.bin/tsx";
const args = isWin
  ? ["/c", "node_modules\\.bin\\tsx.cmd", "src\\mcp\\server.ts"]
  : ["src/mcp/server.ts"];

const child = spawn(cmd, args, {
  cwd: repo,
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

let buf = "";
const results = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      results.push(obj);
      if (obj.id === 2) {
        const tools = (obj.result?.tools ?? []).map((t) => t.name);
        console.log("[smoke] tools/list ->", tools.length, "tools");
        console.log(tools.join("\n"));
        child.kill();
        process.exit(0);
      }
    } catch {
      console.error("[smoke] non-json line:", line);
    }
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

setTimeout(() => {
  console.error("[smoke] timeout — no tools/list response in 30s");
  console.error("[smoke] captured:", JSON.stringify(results, null, 2));
  child.kill();
  process.exit(1);
}, 30000);
