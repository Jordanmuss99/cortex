import assert from "node:assert/strict";
import test from "node:test";
import {
  createSecurityLogger,
  sanitizeSecurityMetadata,
} from "./security-log.js";

const CANARIES = Object.freeze([
  "bearer.secret.canary",
  "authorization-code-canary",
  "__Host-cookie-canary",
  "password-canary",
  "client-secret-canary",
  "raw-jti-canary",
  "203.0.113.77",
  "foreign-agent-canary",
]);

test("security metadata keeps only fixed event-specific scalar fields", () => {
  assert.deepEqual(
    sanitizeSecurityMetadata("refresh_rotation", {
      presented_generation: 4,
      replacement_generation: 5,
      token: CANARIES[0],
      nested: { password: CANARIES[3] },
      surface: "rest",
    }),
    { presented_generation: 4, replacement_generation: 5 }
  );
  assert.deepEqual(
    sanitizeSecurityMetadata("agent_mismatch", {
      surface: "mcp",
      agent_id: CANARIES[7],
      ip: CANARIES[6],
    }),
    { surface: "mcp" }
  );
  assert.deepEqual(sanitizeSecurityMetadata("unknown", { surface: "rest" }), {});
});

test("security logger never emits credential or raw-identifier canaries", () => {
  const entries = [];
  const logger = createSecurityLogger((entry) => entries.push(entry));
  assert.equal(logger.event("agent_mismatch", "rejected", {
    surface: "rest",
    authorization: CANARIES[0],
    code: CANARIES[1],
    cookie: CANARIES[2],
    password: CANARIES[3],
    client_secret: CANARIES[4],
    jti: CANARIES[5],
    ip: CANARIES[6],
    agent_id: CANARIES[7],
  }), true);
  assert.deepEqual(entries, [{
    component: "oauth_gateway",
    event: "agent_mismatch",
    outcome: "rejected",
    metadata: { surface: "rest" },
  }]);
  const serialized = JSON.stringify(entries);
  for (const canary of CANARIES) assert.equal(serialized.includes(canary), false);
});

test("security logger allows bounded pruning counts and absorbs sink failures", () => {
  const entries = [];
  const logger = createSecurityLogger((entry) => entries.push(entry));
  assert.equal(logger.event("gateway_prune", "completed", {
    audit_event_count: 3,
    authorization_code_count: 4,
    login_session_count: 5,
    refresh_token_count: 6,
    grant_count: 7,
    password: CANARIES[3],
  }), true);
  assert.deepEqual(entries[0].metadata, {
    audit_event_count: 3,
    authorization_code_count: 4,
    grant_count: 7,
    login_session_count: 5,
    refresh_token_count: 6,
  });

  const failing = createSecurityLogger(() => {
    throw new Error(CANARIES[3]);
  });
  assert.equal(failing.event("gateway_started", "started"), false);
  assert.equal(failing.event("unknown", "started", { password: CANARIES[3] }), false);
});
