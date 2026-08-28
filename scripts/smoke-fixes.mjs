// Temp smoke for the 2026-06-12 utilization fixes: calls cortex_init
// (Open Loops section), cortex_search (Matching skills block), and
// cortex_observe (Windows screenshot path) through real MCP stdio.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("cmd.exe", ["/c", "node_modules\\.bin\\tsx.cmd", "src\\mcp\\server.ts"], {
  cwd: repo,
  stdio: ["pipe", "pipe", "inherit"],
  windowsHide: true,
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const text = (obj) => obj.result?.content?.[0]?.text ?? "(no text)";

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.id === 2) {
      const t = text(obj);
      const loops = t.indexOf("## Open Loops");
      console.log("=== cortex_init Open Loops section ===");
      console.log(loops >= 0 ? t.slice(loops, loops + 900) : "MISSING - no Open Loops section!");
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cortex_search", arguments: { query: "run the SimsOnline two TS3 dev stack live test claim sims game speed", limit: 3 } } });
    } else if (obj.id === 3) {
      const t = text(obj);
      const sk = t.indexOf("## Matching skills");
      console.log("\n=== cortex_search Matching skills block ===");
      console.log(sk >= 0 ? t.slice(sk, sk + 900) : "MISSING - no skills block (may be a legit no-match)\nTail:\n" + t.slice(-400));
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cortex_observe", arguments: { store: false } } });
    } else if (obj.id === 4) {
      console.log("\n=== cortex_observe ===");
      console.log(text(obj));
      child.kill();
      process.exit(0);
    }
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-fixes", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cortex_init", arguments: { agent_id: "arlo" } } });

setTimeout(() => {
  console.error("[smoke-fixes] timeout after 120s");
  child.kill();
  process.exit(1);
}, 120000);
