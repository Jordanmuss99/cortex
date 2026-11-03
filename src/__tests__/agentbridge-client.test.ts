import { collectAgentBridgeSession, FetchLike } from "../mcp/agentbridge-client";

// Builds a fetch that answers AgentBridge MCP tools/call by parsing the request body.
function fakeFetch(handlers: Record<string, any>): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const tool: string = body.params.name;
    if (!(tool in handlers)) {
      return { ok: true, status: 200, json: async () => ({ result: { isError: true, content: [{ text: "no" }] } }) };
    }
    const payload = handlers[tool];
    if (payload instanceof Error) throw payload;
    if (payload === "__http500__") return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
    };
  };
}

const SESSIONS = [
  { name: "Field Commander", platform: "claude", sessionId: "abc", is_active: true },
  { name: "Worker 2", platform: "omo", sessionId: "def", is_active: false },
];
const DETAIL = {
  name: "Field Commander",
  platform: "claude",
  cwd: "C:\\ws",
  gitBranch: "main",
  is_active: true,
  stack_claim: { holds_claim: true, purpose: "TS3 probe" },
  recent_turns: [
    { role: "user", content: "fix the compaction bug" },
    { role: "assistant", content: "editing compaction_eval.py" },
  ],
  touched_files: ["scripts/compaction_eval.py", "agentbridge/compaction.py"],
};

describe("collectAgentBridgeSession", () => {
  it("returns undefined when unconfigured (opt-in guard)", async () => {
    const out = await collectAgentBridgeSession({ url: "", fetchImpl: fakeFetch({}) });
    expect(out).toBeUndefined();
  });

  it("merges list_sessions + inspect_session output", async () => {
    const out = await collectAgentBridgeSession({
      url: "http://127.0.0.1:8765/api/mcp",
      token: "t0k",
      fetchImpl: fakeFetch({ agentbridge_list_sessions: SESSIONS, agentbridge_inspect_session: DETAIL }),
    });
    expect(out).toContain("Active sessions: 1/2");
    expect(out).toContain("Field Commander (claude)");
    expect(out).toContain("Focus: Field Commander (claude)");
    expect(out).toContain("holds claim (TS3 probe)");
    expect(out).toContain("fix the compaction bug");
    expect(out).toContain("compaction_eval.py");
  });

  it("degrades to the offline note when the host errors", async () => {
    const out = await collectAgentBridgeSession({
      url: "http://127.0.0.1:8765/api/mcp",
      fetchImpl: fakeFetch({ agentbridge_list_sessions: new Error("ECONNREFUSED"), agentbridge_inspect_session: new Error("ECONNREFUSED") }),
    });
    expect(out).toBe("[AgentBridge: host offline; rewriting without live session context]");
  });

  it("degrades to the offline note on a non-2xx response", async () => {
    const out = await collectAgentBridgeSession({
      url: "http://127.0.0.1:8765/api/mcp",
      fetchImpl: fakeFetch({ agentbridge_list_sessions: "__http500__", agentbridge_inspect_session: "__http500__" }),
    });
    expect(out).toContain("host offline");
  });

  it("honors an explicit session_target", async () => {
    const seenTargets: any[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.params.name === "agentbridge_inspect_session") seenTargets.push(body.params.arguments.target);
      const payload = body.params.name === "agentbridge_list_sessions" ? SESSIONS : DETAIL;
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
    };
    await collectAgentBridgeSession({ url: "http://h/api/mcp", target: "Worker 2", fetchImpl });
    expect(seenTargets).toContain("Worker 2");
  });
});
