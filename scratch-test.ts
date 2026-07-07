import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "test",
  version: "1.0.0"
});

server.registerTool("test_tool", {
  description: "A test tool",
  inputSchema: z.object({ test: z.string() }),
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } }
}, async ({ test }) => {
  return {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { ok: true }
  };
});

console.log("Success");
