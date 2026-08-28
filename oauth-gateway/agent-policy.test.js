import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { createGatewayApp, probeGatewayReadiness } from "./app.js";
import { createSecurityLogger } from "./security-log.js";
import { loadGatewayConfig } from "./config.js";
import { postgresTlsOptions } from "./oauth-store.js";
import {
  HOSTED_MCP_METHODS,
  HOSTED_REST_ROUTES,
  HostedPolicyError,
  bindHostedMcpRequest,
  bindHostedRestRequest,
  inspectAgentSelectors,
  isHostedPublicHealthRequest,
  matchHostedRestRoute,
  scanTopLevelJsonMemberNames,
  validateHostedMcpEnvelope
} from "./agent-policy.js";
import {
  CORTEX_TOOL_METADATA,
  CORTEX_TOOL_NAMES,
  hideHostedAgentSelector
} from "./chatgpt-tools.js";
import { loadExpectedLegacyState } from "./server-v2.js";

const AUTH_CONTEXT = Object.freeze({
  subject: "test-user",
  sid: "grant-1",
  clientId: "chatgpt-test",
  agentId: 7,
  agentExternalId: "agent-a",
  scopes: new Set(["cortex:read", "mcp"])
});

const HOSTED_REST_CASES = Object.freeze([
  ["GET", "/api/v1/status", "query", ["cortex:read"]],
  ["GET", "/api/v1/graph", "query", ["cortex:read"]],
  ["GET", "/api/v1/cognition", "query", ["cortex:read"]],
  ["GET", "/api/v1/vitals", "query", ["cortex:read"]],
  ["GET", "/api/v1/reconsolidate/labile", "query", ["cortex:read"]],
  ["GET", "/api/v1/procedural", "query", ["cortex:read"]],
  ["POST", "/api/v1/search", "body", ["cortex:read", "cortex:write"]],
  ["POST", "/api/v1/recall", "body", ["cortex:read", "cortex:write"]],
  ["POST", "/api/v1/ingest", "body", ["cortex:write"]],
  ["POST", "/api/v1/reconsolidate", "body", ["cortex:read", "cortex:write"]],
  ["POST", "/api/v1/dream", "body", ["cortex:read", "cortex:write"]],
  ["POST", "/api/v1/procedural", "body", ["cortex:write"]],
  ["POST", "/api/v1/procedural/retrieve", "body", ["cortex:read"]],
  ["POST", "/api/v1/procedural/17/execute", "body", ["cortex:write"]],
  ["PATCH", "/api/v1/procedural/17", "body", ["cortex:read", "cortex:write"]]
]);

function validGatewayEnvironment() {
  return {
    BASE_URL: "https://cortex.example.test/",
    MCP_OAUTH_DATABASE_URL: "postgresql://cortex_oauth_gateway:secret@db.example.test/cortex",
    MCP_OAUTH_USERNAME: "test-user",
    MCP_OAUTH_AGENT_ID: "agent-a",
    MCP_OAUTH_ACCEPT_LEGACY_UNTIL: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    ).toISOString()
  };
}

test("loadGatewayConfig validates the DB/bootstrap contract and stable defaults", () => {
  const environment = validGatewayEnvironment();
  const config = loadGatewayConfig(environment);

  assert.equal(config.baseUrl, "https://cortex.example.test");
  assert.equal(config.issuerUrl, "https://cortex.example.test");
  assert.equal(config.resourceUrl, "https://cortex.example.test/mcp");
  assert.equal(config.bootstrapSubject, "test-user");
  assert.equal(config.bootstrapAgentExternalId, "agent-a");
  assert.equal(config.accessTokenTtlSeconds, 3600);
  assert.equal(config.refreshRetryGraceSeconds, 30);
  assert.equal(config.loginAttemptLimit, 10);
  assert.equal(config.loginAttemptWindowSeconds, 15 * 60);
  assert.equal(config.registrationAttemptLimit, 30);
  assert.equal(config.registrationAttemptWindowSeconds, 60 * 60);
  assert.deepEqual(config.trustedProxyCidrs, []);
  assert.equal(
    config.acceptLegacyUntil.toISOString(),
    environment.MCP_OAUTH_ACCEPT_LEGACY_UNTIL
  );
  assert.equal(Object.isFrozen(config), true);

  assert.equal(
    loadGatewayConfig({
      ...environment,
      MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS: "47"
    }).refreshRetryGraceSeconds,
    47
  );
});

test("gateway PostgreSQL options verify external TLS without overriding verify-full", () => {
  assert.deepEqual(
    postgresTlsOptions(
      "postgresql://cortex_oauth_gateway:secret@ep-example.us-east-2.aws.neon.tech/cortex"
    ),
    { ssl: "verify-full" }
  );
  assert.deepEqual(
    postgresTlsOptions(
      "postgresql://cortex_oauth_gateway:secret@ep-example.us-east-2.aws.neon.tech/cortex?sslmode=verify-full"
    ),
    {}
  );
  assert.deepEqual(
    postgresTlsOptions(
      "postgresql://cortex_oauth_gateway:secret@127.0.0.1/cortex"
    ),
    {}
  );
  for (const publicHostname of ["fd.example.test", "fca.example.test", "fe80.example.test"]) {
    assert.deepEqual(
      postgresTlsOptions(
        `postgresql://cortex_oauth_gateway:secret@${publicHostname}/cortex`
      ),
      { ssl: "verify-full" }
    );
  }
  assert.deepEqual(
    postgresTlsOptions(
      "postgresql://cortex_oauth_gateway:secret@[fd00::1]/cortex"
    ),
    {}
  );
});

test("loadGatewayConfig rejects missing authority settings without leaking values", () => {
  for (const missing of [
    "MCP_OAUTH_DATABASE_URL",
    "MCP_OAUTH_USERNAME",
    "MCP_OAUTH_AGENT_ID",
    "MCP_OAUTH_ACCEPT_LEGACY_UNTIL"
  ]) {
    const env = validGatewayEnvironment();
    delete env[missing];
    assert.throws(
      () => loadGatewayConfig(env),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, new RegExp(missing));
        assert.doesNotMatch(error.message, /secret@db/);
        return true;
      }
    );
  }
});

test("loadGatewayConfig rejects invalid bounds and unsafe trusted-header configuration", () => {
  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      BASE_URL: "http://cortex.example.test"
    }),
    /HTTPS outside loopback/
  );
  assert.equal(
    loadGatewayConfig({
      ...validGatewayEnvironment(),
      BASE_URL: "http://127.0.0.1:8080",
      ISSUER_URL: "http://127.0.0.1:8080",
      RESOURCE_URL: "http://127.0.0.1:8080/mcp"
    }).baseUrl,
    "http://127.0.0.1:8080"
  );

  for (const [name, value] of [
    ["BASE_URL", "https://cortex.example.test/"],
    ["ISSUER_URL", "https://cortex.example.test/issuer"],
    ["RESOURCE_URL", "https://cortex.example.test/mcp"],
    ["MCP_TARGET", "http://cortex-mcp:8000/mcp"],
    ["REST_TARGET", "http://cortex:3100/api"]
  ]) {
    for (const delimiter of ["?", "#"]) {
      assert.throws(
        () => loadGatewayConfig({
          ...validGatewayEnvironment(),
          [name]: `${value}${delimiter}`
        }),
        /absolute URL/
      );
    }
  }

  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_DATABASE_URL: "postgresql://database_owner:secret@db.example.test/cortex"
    }),
    /gateway login role/
  );

  for (const query of [
    "",
    "user=database_owner",
    "database=other",
    "options=-c%20role%3Ddatabase_owner",
    "sslmode=require&sslmode=require",
    "sslmode=require",
    "sslmode=verify-ca"
  ]) {
    assert.throws(
      () => loadGatewayConfig({
        ...validGatewayEnvironment(),
        MCP_OAUTH_DATABASE_URL:
          `postgresql://cortex_oauth_gateway:secret@db.example.test/cortex?${query}`
      }),
      /unsupported URL parameters/
    );
  }
  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_DATABASE_URL:
        "postgresql://cortex_oauth_gateway:secret@db.example.test/cortex#"
    }),
    /unsupported URL parameters/
  );

  assert.equal(
    loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_DATABASE_URL:
        "postgresql://cortex_oauth_gateway:secret@db.example.test/cortex?sslmode=verify-full"
    }).databaseUrl,
    "postgresql://cortex_oauth_gateway:secret@db.example.test/cortex?sslmode=verify-full"
  );

  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS: "0"
    }),
    /MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS/
  );

  const closedLegacyConfig = loadGatewayConfig({
    ...validGatewayEnvironment(),
    MCP_OAUTH_ACCEPT_LEGACY_UNTIL: "2000-01-01T00:00:00Z"
  });
  assert.equal(
    closedLegacyConfig.acceptLegacyUntil.toISOString(),
    "2000-01-01T00:00:00.000Z",
    "an expired cutoff must remain a valid, permanently closed restart state"
  );
  assert.equal(
    loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_ACCEPT_LEGACY_UNTIL: "2000-01-01T10:00:00+10:00"
    }).acceptLegacyUntil.toISOString(),
    "2000-01-01T00:00:00.000Z"
  );

  for (const invalidDeadline of [
    "2026-02-31T00:00:00Z",
    "2026-08-29 00:00:00Z",
    "2026-08-29T24:00:00Z",
    "2026-08-29T00:00:00.0000Z",
    "2026-08-29T00:00:00+24:00"
  ]) {
    assert.throws(
      () => loadGatewayConfig({
        ...validGatewayEnvironment(),
        MCP_OAUTH_ACCEPT_LEGACY_UNTIL: invalidDeadline
      }),
      /ISO-8601 timestamp with a timezone/
    );
  }

  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_ACCEPT_LEGACY_UNTIL: new Date(
        Date.now() + 91 * 24 * 60 * 60 * 1000
      ).toISOString()
    }),
    /maximum rollout window/
  );

  for (const [name, value] of [
    ["MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", String(24 * 60 * 60 + 1)],
    ["MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS", String(365 * 24 * 60 * 60 + 1)],
    ["MCP_OAUTH_AUTH_CODE_TTL_SECONDS", String(60 * 60 + 1)],
    ["MCP_OAUTH_LOGIN_SESSION_TTL_SECONDS", String(90 * 24 * 60 * 60 + 1)],
    ["MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS", String(5 * 60 + 1)],
    ["MCP_OAUTH_LOGIN_ATTEMPT_LIMIT", "10001"],
    ["MCP_OAUTH_LOGIN_ATTEMPT_WINDOW_SECONDS", String(7 * 24 * 60 * 60 + 1)],
    ["MCP_OAUTH_REGISTRATION_ATTEMPT_LIMIT", "10001"],
    ["MCP_OAUTH_REGISTRATION_ATTEMPT_WINDOW_SECONDS", String(7 * 24 * 60 * 60 + 1)]
  ]) {
    assert.throws(
      () => loadGatewayConfig({
        ...validGatewayEnvironment(),
        [name]: value
      }),
      new RegExp(name)
    );
  }

  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_TRUSTED_IP_HEADER: "cf-connecting-ip"
    }),
    /MCP_OAUTH_TRUSTED_PROXY_CIDRS/
  );

  assert.throws(
    () => loadGatewayConfig({
      ...validGatewayEnvironment(),
      MCP_OAUTH_TRUSTED_PROXY_CIDRS: "192.0.2.0/99"
    }),
    /invalid CIDR/
  );

  const config = loadGatewayConfig({
    ...validGatewayEnvironment(),
    MCP_OAUTH_TRUSTED_IP_HEADER: "CF-Connecting-IP",
    MCP_OAUTH_TRUSTED_PROXY_CIDRS: "192.0.2.0/24, 2001:db8::/32"
  });
  assert.equal(config.trustedIpHeader, "cf-connecting-ip");
  assert.deepEqual(config.trustedProxyCidrs, ["192.0.2.0/24", "2001:db8::/32"]);
});

test("loadExpectedLegacyState accepts only a lowercase digest and bounded exact counts", () => {
  const expected = loadExpectedLegacyState({
    MCP_OAUTH_LEGACY_STATE_SHA256: "ab".repeat(32),
    MCP_OAUTH_LEGACY_STATE_CLIENT_COUNT: "12",
    MCP_OAUTH_LEGACY_STATE_CODE_COUNT: "0"
  });
  assert.equal(Buffer.from(expected.sourceChecksum).toString("hex"), "ab".repeat(32));
  assert.equal(expected.clientCount, 12);
  assert.equal(expected.codeCount, 0);
  assert.equal(Object.isFrozen(expected), true);

  for (const environment of [
    {},
    {
      MCP_OAUTH_LEGACY_STATE_SHA256: "AB".repeat(32),
      MCP_OAUTH_LEGACY_STATE_CLIENT_COUNT: "0",
      MCP_OAUTH_LEGACY_STATE_CODE_COUNT: "0"
    },
    {
      MCP_OAUTH_LEGACY_STATE_SHA256: "ab".repeat(32),
      MCP_OAUTH_LEGACY_STATE_CLIENT_COUNT: "01",
      MCP_OAUTH_LEGACY_STATE_CODE_COUNT: "0"
    },
    {
      MCP_OAUTH_LEGACY_STATE_SHA256: "ab".repeat(32),
      MCP_OAUTH_LEGACY_STATE_CLIENT_COUNT: "1001",
      MCP_OAUTH_LEGACY_STATE_CODE_COUNT: "0"
    }
  ]) {
    assert.throws(
      () => loadExpectedLegacyState(environment),
      (error) => error?.message === "Legacy OAuth state expectation is invalid"
    );
  }
});

function statusCall(...argumentValues) {
  return toolCall("cortex_status", ...argumentValues);
}

function toolCall(name, ...argumentValues) {
  const params = { name };
  if (argumentValues.length > 0) params.arguments = argumentValues[0];

  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params
  };
}

function bind(message) {
  return bindHostedMcpRequest(message, JSON.stringify(message), AUTH_CONTEXT);
}

test("bindHostedMcpRequest injects the missing bound external agent without mutating input", () => {
  const message = statusCall({ verbose: true });
  const before = structuredClone(message);

  const bound = bind(message);

  assert.deepEqual(message, before);
  assert.notEqual(bound, message);
  assert.notEqual(bound.params, message.params);
  assert.notEqual(bound.params.arguments, message.params.arguments);
  assert.deepEqual(bound.params.arguments, {
    verbose: true,
    agent_id: "agent-a"
  });
});

test("bindHostedMcpRequest creates arguments when they are absent", () => {
  const message = statusCall();

  const bound = bind(message);

  assert.equal(Object.hasOwn(message.params, "arguments"), false);
  assert.deepEqual(bound.params.arguments, { agent_id: "agent-a" });
});

test("bindHostedMcpRequest accepts one equal cached selector", () => {
  const message = statusCall({ agent_id: "agent-a" });
  const before = structuredClone(message);

  const bound = bind(message);

  assert.deepEqual(message, before);
  assert.deepEqual(bound.params.arguments, { agent_id: "agent-a" });
});

test("bindHostedMcpRequest rejects a foreign selector with a stable non-oracular error", () => {
  assert.throws(
    () => bind(statusCall({ agent_id: "agent-b" })),
    (error) => {
      assert.ok(error instanceof HostedPolicyError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "agent_mismatch");
      assert.equal(
        error.safeDescription,
        "Requested agent is not authorized for this connection"
      );
      assert.doesNotMatch(error.message, /agent-a|agent-b/);
      return true;
    }
  );
});

test("bindHostedMcpRequest rejects malformed selectors", () => {
  for (const value of [null, 7, false, {}, [], "", "x".repeat(129)]) {
    assert.throws(
      () => bind(statusCall({ agent_id: value })),
      (error) =>
        error instanceof HostedPolicyError &&
        error.status === 403 &&
        error.code === "agent_mismatch",
      `expected malformed selector ${JSON.stringify(value)} to be rejected`
    );
  }
});

test("bindHostedMcpRequest accepts every catalogued tool and fails closed for unknown tools", () => {
  for (const name of CORTEX_TOOL_NAMES) {
    const missing = toolCall(name, { query: "memory" });
    assert.deepEqual(bind(missing).params.arguments, {
      query: "memory",
      agent_id: "agent-a"
    });

    const equal = toolCall(name, { agent_id: "agent-a" });
    assert.deepEqual(bind(equal).params.arguments, { agent_id: "agent-a" });
  }

  const message = statusCall({});
  message.params.name = "cortex_future_tool";

  assert.throws(
    () => bind(message),
    (error) =>
      error instanceof HostedPolicyError &&
      error.status === 404 &&
      error.code === "not_found"
  );
});

test("raw member scanning decodes escaped names and preserves duplicate occurrences", () => {
  const raw = Buffer.from(
    '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-a","agent\\u005fid":"agent-b","nested":{"agent_id":"content"}}}}'
  );

  assert.deepEqual(
    scanTopLevelJsonMemberNames(raw, ["params", "arguments"]),
    ["agent_id", "agent_id", "nested"]
  );
  assert.deepEqual(
    inspectAgentSelectors({ rawJson: raw }).map(({ source, key }) => ({ source, key })),
    [
      { source: "mcp_arguments", key: "agent_id" },
      { source: "mcp_arguments", key: "agent_id" }
    ]
  );
});

test("bindHostedMcpRequest rejects duplicate escaped alias and wrong-path selectors", () => {
  const rawCases = [
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-a","agent_id":"agent-a"}}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-a","agent\\u005fid":"agent-b"}}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agentId":"agent-a"}}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","agent_id":"agent-a","params":{"name":"cortex_status","arguments":{}}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"agent_id":"agent-a","name":"cortex_status","arguments":{}}}',
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-b"},"arguments":{}}}'
  ];

  for (const raw of rawCases) {
    assert.throws(
      () => bindHostedMcpRequest(JSON.parse(raw), raw, AUTH_CONTEXT),
      (error) =>
        error instanceof HostedPolicyError &&
        error.status === 403 &&
        error.code === "agent_mismatch",
      raw
    );
  }
});

test("bindHostedMcpRequest ignores selector-looking nested content and canonicalizes once", () => {
  const message = statusCall({
    content: {
      agent_id: "agent-b",
      agentId: "agent-c",
      nested: { agent_id: null }
    },
    text: 'literal "agent_id":"agent-z"'
  });

  const bound = bind(message);
  assert.deepEqual(bound.params.arguments, {
    ...message.params.arguments,
    agent_id: "agent-a"
  });
});

test("bindHostedMcpRequest rejects ambiguous non-selector input and parsed/raw mismatch", () => {
  const duplicateArgument =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cortex_status","arguments":{"verbose":true,"verbose":false}}}';
  assert.throws(
    () => bindHostedMcpRequest(JSON.parse(duplicateArgument), duplicateArgument, AUTH_CONTEXT),
    (error) => error instanceof HostedPolicyError && error.code === "invalid_request"
  );

  const raw = JSON.stringify(statusCall({ verbose: false }));
  assert.throws(
    () => bindHostedMcpRequest(statusCall({ verbose: true }), raw, AUTH_CONTEXT),
    (error) => error instanceof HostedPolicyError && error.code === "invalid_request"
  );
});

test("hosted MCP envelope admits exactly five methods and rejects malformed ambiguity", () => {
  assert.deepEqual(HOSTED_MCP_METHODS, [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call"
  ]);
  assert.equal(Object.isFrozen(HOSTED_MCP_METHODS), true);

  for (const method of HOSTED_MCP_METHODS) {
    const message = { jsonrpc: "2.0", id: 1, method, params: {} };
    assert.deepEqual(
      validateHostedMcpEnvelope(message, JSON.stringify(message)),
      message
    );
  }

  const unknown = { jsonrpc: "2.0", id: 1, method: "resources/list", params: {} };
  assert.throws(
    () => validateHostedMcpEnvelope(unknown, JSON.stringify(unknown)),
    (error) => error instanceof HostedPolicyError &&
      error.status === 404 && error.code === "not_found"
  );
  for (const malformed of [
    [],
    { jsonrpc: "1.0", method: "ping" },
    { jsonrpc: "2.0", params: {} },
    { jsonrpc: "2.0", method: "ping", params: [] }
  ]) {
    assert.throws(
      () => validateHostedMcpEnvelope(malformed, JSON.stringify(malformed)),
      (error) => error instanceof HostedPolicyError && error.code === "invalid_request"
    );
  }

  const duplicateMethod =
    '{"jsonrpc":"2.0","method":"resources/list","method":"ping","params":{}}';
  assert.throws(
    () => validateHostedMcpEnvelope(JSON.parse(duplicateMethod), duplicateMethod),
    (error) => error instanceof HostedPolicyError && error.code === "invalid_request"
  );
});

test("raw scanner fails closed for invalid UTF-8 excess depth and excess size", () => {
  const invalidUtf8 = Uint8Array.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d
  ]);
  const deep = `${'{"x":'.repeat(66)}null${"}".repeat(66)}`;
  const oversized = JSON.stringify({ value: "x".repeat(64 * 1024) });

  for (const raw of [invalidUtf8, deep, oversized]) {
    assert.throws(
      () => scanTopLevelJsonMemberNames(raw, []),
      (error) => error instanceof HostedPolicyError && error.code === "invalid_request"
    );
  }
});

test("raw scanner accepts the exact byte and depth boundaries", () => {
  const exactDepth = `${"[".repeat(64)}null${"]".repeat(64)}`;
  assert.deepEqual(scanTopLevelJsonMemberNames(exactDepth, []), []);

  const empty = JSON.stringify(statusCall({ padding: "" }));
  const exactBytes = JSON.stringify(statusCall({
    padding: "x".repeat(64 * 1024 - Buffer.byteLength(empty))
  }));
  assert.equal(Buffer.byteLength(exactBytes), 64 * 1024);
  const bound = bindHostedMcpRequest(
    JSON.parse(exactBytes),
    Buffer.from(exactBytes),
    AUTH_CONTEXT
  );
  assert.equal(bound.params.arguments.agent_id, "agent-a");
  assert.equal(bound.params.arguments.padding.length > 0, true);
});

test("hosted REST catalog is the exact immutable 15-route contract", () => {
  assert.equal(HOSTED_REST_ROUTES.length, 15);
  assert.equal(Object.isFrozen(HOSTED_REST_ROUTES), true);

  for (const [method, path, agentLocation, requiredScopes] of HOSTED_REST_CASES) {
    const policy = matchHostedRestRoute(method, `${path}?preserved=yes`);
    assert.ok(policy, `${method} ${path}`);
    assert.equal(policy.method, method);
    assert.equal(policy.agentLocation, agentLocation);
    assert.deepEqual(policy.requiredScopes, requiredScopes);
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.requiredScopes), true);
    assert.equal(matchHostedRestRoute(method, `${path}/`), policy);
  }

  assert.equal(isHostedPublicHealthRequest("GET", "/api/v1/health"), true);
  assert.equal(isHostedPublicHealthRequest("GET", "/api/v1/health/"), true);
  assert.equal(isHostedPublicHealthRequest("HEAD", "/api/v1/health"), false);
  const exportedStatusMatcher = HOSTED_REST_ROUTES[0].path;
  assert.notEqual(exportedStatusMatcher, HOSTED_REST_ROUTES[0].path);
  exportedStatusMatcher.compile(/^\/api\/v1\/agents$/);
  assert.equal(
    matchHostedRestRoute("GET", "/api/v1/status"),
    HOSTED_REST_ROUTES[0]
  );
  assert.equal(matchHostedRestRoute("GET", "/api/v1/agents"), null);
  for (const [method, rawUrl] of [
    ["GET", "/api/v1/agents"],
    ["GET", "/api/v1/future"],
    ["HEAD", "/api/v1/status"],
    ["POST", "/api/v1/status"],
    ["GET", "/api/v1//status"],
    ["GET", "/api/v1/status//"],
    ["GET", "/api/v1/%73tatus"],
    ["GET", "/api/v1/graph/%2e%2e/status"],
    ["POST", "/api/v1/procedural/0/execute"],
    ["POST", "/api/v1/procedural/01/execute"],
    ["POST", "/api/v1/procedural/2147483648/execute"]
  ]) {
    assert.equal(matchHostedRestRoute(method, rawUrl), null, `${method} ${rawUrl}`);
  }
});

test("bindHostedRestRequest injects one canonical query or body selector", () => {
  const queryBound = bindHostedRestRequest({
    method: "GET",
    rawUrl: "/api/v1/status?verbose=true&verbose=false",
    restTarget: "http://cortex.internal:3100"
  }, AUTH_CONTEXT);
  assert.equal(
    queryBound.url.toString(),
    "http://cortex.internal:3100/api/v1/status?verbose=true&verbose=false&agentId=agent-a"
  );
  assert.equal(queryBound.body, null);

  const equalQuery = bindHostedRestRequest({
    method: "GET",
    rawUrl: "/api/v1/graph?agentId=agent-a&depth=2",
    restTarget: "http://cortex.internal:3100"
  }, AUTH_CONTEXT);
  assert.deepEqual(equalQuery.url.searchParams.getAll("agentId"), ["agent-a"]);
  assert.equal(equalQuery.url.searchParams.get("depth"), "2");

  const body = {
    query: "memory",
    content: { agentId: "nested-content", agent_id: "also-content" }
  };
  const before = structuredClone(body);
  const bodyBound = bindHostedRestRequest({
    method: "POST",
    rawUrl: "/api/v1/search?limit=3",
    rawJson: JSON.stringify(body),
    body,
    restTarget: "http://cortex.internal:3100"
  }, AUTH_CONTEXT);
  assert.deepEqual(body, before);
  assert.deepEqual(bodyBound.body, { ...body, agentId: "agent-a" });
  assert.equal(bodyBound.url.toString(), "http://cortex.internal:3100/api/v1/search?limit=3");

  const equalBody = { agentId: "agent-a", content: "cached" };
  const equalBodyBound = bindHostedRestRequest({
    method: "POST",
    rawUrl: "/api/v1/ingest",
    rawJson: JSON.stringify(equalBody),
    body: equalBody,
    restTarget: "http://cortex.internal:3100"
  }, AUTH_CONTEXT);
  assert.deepEqual(equalBodyBound.body, equalBody);
});

test("bindHostedRestRequest rejects every foreign alias duplicate and wrong-location selector", () => {
  const cases = [
    {
      method: "GET",
      rawUrl: "/api/v1/status?agentId=agent-b",
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "GET",
      rawUrl: "/api/v1/status?agent_id=agent-a",
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "GET",
      rawUrl: "/api/v1/status?agentId=agent-a&agentId=agent-a",
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "GET",
      rawUrl: "/api/v1/status?agentId%5B%5D=agent-b",
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "GET",
      rawUrl: "/api/v1/status?agent_id%5Bforeign%5D=agent-a",
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "GET",
      rawUrl: "/api/v1/status",
      rawJson: '{"agentId":"agent-a"}',
      body: { agentId: "agent-a" },
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "POST",
      rawUrl: "/api/v1/ingest?agentId=agent-a",
      rawJson: '{"content":"x"}',
      body: { content: "x" },
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "POST",
      rawUrl: "/api/v1/ingest",
      rawJson: '{"agent_id":"agent-a","content":"x"}',
      body: { agent_id: "agent-a", content: "x" },
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "POST",
      rawUrl: "/api/v1/ingest",
      rawJson: '{"agentId":"agent-a","agent\\u0049d":"agent-b","content":"x"}',
      body: { agentId: "agent-b", content: "x" },
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "POST",
      rawUrl: "/api/v1/ingest",
      rawJson: '{"agentId":null,"content":"x"}',
      body: { agentId: null, content: "x" },
      restTarget: "http://cortex.internal:3100"
    }
  ];

  for (const input of cases) {
    assert.throws(
      () => bindHostedRestRequest(input, AUTH_CONTEXT),
      (error) => error instanceof HostedPolicyError &&
        error.status === 403 && error.code === "agent_mismatch",
      JSON.stringify(input)
    );
  }

  for (const input of [
    {
      method: "GET",
      rawUrl: "/api/v1/status",
      rawJson: "{}",
      body: {},
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "POST",
      rawUrl: "/api/v1/ingest",
      rawJson: '{"content":"first","content":"second"}',
      body: { content: "second" },
      restTarget: "http://cortex.internal:3100"
    },
    {
      method: "POST",
      rawUrl: "/api/v1/ingest",
      rawJson: '{"content":"raw"}',
      body: { content: "parsed" },
      restTarget: "http://cortex.internal:3100"
    }
  ]) {
    assert.throws(
      () => bindHostedRestRequest(input, AUTH_CONTEXT),
      (error) => error instanceof HostedPolicyError && error.code === "invalid_request"
    );
  }
});

test("hosted REST gateway enforces the complete route scope binding and transport contract", async (t) => {
  const upstreamRequests = [];
  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = rawBody.length === 0 ? null : JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
      const request = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        rawBody,
        body
      };
      upstreamRequests.push(request);

      const target = new URL(req.url, "http://cortex.internal");
      if (target.searchParams.get("redirect") === "yes") {
        res.writeHead(302, {
          location: "https://foreign.example.test/credential-capture",
          "set-cookie": "upstream-secret=must-not-escape"
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        etag: '"rest-proof"',
        location: "https://foreign.example.test/must-not-escape",
        "set-cookie": "upstream-secret=must-not-escape",
        "x-api-key": "upstream-secret"
      });
      res.end(JSON.stringify({
        method: request.method,
        url: request.url,
        body: request.body
      }));
    });
  });
  const upstreamPort = await listenOnLoopback(upstreamServer);
  t.after(async () => await closeServer(upstreamServer));

  const scopeContexts = Object.freeze({
    full: new Set(["cortex:read", "cortex:write", "mcp"]),
    read: new Set(["cortex:read"]),
    write: new Set(["cortex:write"]),
    mcp: new Set(["mcp"])
  });
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      restTarget: `http://127.0.0.1:${upstreamPort}`,
      mcpTarget: "http://127.0.0.1:1"
    },
    crypto: {
      async verifyAccessToken(token) {
        if (!Object.hasOwn(scopeContexts, token)) throw new Error("invalid token");
        return { sid: token, token_use: "access" };
      },
      async verifyRevocationReference() {
        return null;
      }
    },
    verifyBrowserCredentials() {
      return false;
    },
    store: {
      async checkReadiness() {
        return { ready: true };
      },
      async resolveAccessContext({ claims }) {
        return {
          kind: "active",
          context: {
            ...AUTH_CONTEXT,
            sid: claims.sid,
            scopes: scopeContexts[claims.sid]
          }
        };
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      }
    }
  });
  const gatewayServer = http.createServer(app);
  const gatewayPort = await listenOnLoopback(gatewayServer);
  t.after(async () => await closeServer(gatewayServer));

  const requestGateway = ({
    method = "GET",
    path,
    token,
    headers = {},
    body
  }) => new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (token !== undefined) requestHeaders.authorization = `Bearer ${token}`;
    if (body !== undefined && requestHeaders["content-length"] === undefined) {
      requestHeaders["content-length"] = String(Buffer.byteLength(body));
    }
    const request = http.request({
      hostname: "127.0.0.1",
      port: gatewayPort,
      method,
      path,
      headers: requestHeaders
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text,
          json: text.length === 0 ? null : JSON.parse(text)
        });
      });
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });

  const credentialHeaders = {
    cookie: "connector-session=secret",
    "cf-access-jwt-assertion": "edge-jwt-secret",
    "cf-access-client-secret": "edge-client-secret",
    "x-api-key": "api-secret",
    "x-auth-token": "auth-secret"
  };

  const healthBefore = upstreamRequests.length;
  const health = await requestGateway({
    path: "/api/v1/health/?probe=public",
    headers: {
      authorization: "Bearer connector-secret-must-be-ignored",
      ...credentialHeaders
    }
  });
  assert.equal(health.status, 200);
  assert.equal(upstreamRequests.length, healthBefore + 1);
  const healthUpstream = upstreamRequests.at(-1);
  assert.equal(healthUpstream.url, "/api/v1/health?probe=public");
  assert.equal(healthUpstream.headers.authorization, undefined);
  assert.equal(healthUpstream.headers.cookie, undefined);
  assert.equal(healthUpstream.headers["x-api-key"], undefined);
  assert.equal(health.headers["set-cookie"], undefined);
  assert.equal(health.headers.location, undefined);
  assert.equal(health.headers["x-api-key"], undefined);

  for (const [method, path, agentLocation, requiredScopes] of HOSTED_REST_CASES) {
    const token = requiredScopes.length === 2
      ? "full"
      : requiredScopes[0] === "cortex:read"
        ? "read"
        : "write";
    const marker = `${method}-${path}`;
    const nested = {
      agentId: "nested-content-agent",
      agent_id: "nested-content-alias"
    };
    const bodyObject = { marker, nested };
    const requestPath = `${path}?marker=${encodeURIComponent(marker)}`;
    const before = upstreamRequests.length;
    const response = await requestGateway({
      method,
      path: requestPath,
      token,
      headers: agentLocation === "body"
        ? { "content-type": "application/json", ...credentialHeaders }
        : credentialHeaders,
      body: agentLocation === "body" ? JSON.stringify(bodyObject) : undefined
    });
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.equal(upstreamRequests.length, before + 1, `${method} ${path}`);

    const forwarded = upstreamRequests.at(-1);
    const forwardedUrl = new URL(forwarded.url, "http://cortex.internal");
    assert.equal(forwarded.method, method, `${method} ${path}`);
    assert.equal(forwardedUrl.pathname, path, `${method} ${path}`);
    assert.equal(forwardedUrl.searchParams.get("marker"), marker, `${method} ${path}`);
    if (agentLocation === "query") {
      assert.deepEqual(
        forwardedUrl.searchParams.getAll("agentId"),
        ["agent-a"],
        `${method} ${path}`
      );
      assert.equal(forwarded.body, null, `${method} ${path}`);
    } else {
      assert.equal(forwardedUrl.searchParams.has("agentId"), false, `${method} ${path}`);
      assert.deepEqual(forwarded.body, {
        ...bodyObject,
        agentId: "agent-a"
      }, `${method} ${path}`);
      assert.deepEqual(forwarded.body.nested, nested, `${method} ${path}`);
    }
    for (const name of [
      "authorization",
      "cookie",
      "cf-access-jwt-assertion",
      "cf-access-client-secret",
      "x-api-key",
      "x-auth-token"
    ]) {
      assert.equal(forwarded.headers[name], undefined, `${method} ${path}: ${name}`);
    }

    const deniedToken = requiredScopes.length === 2
      ? "read"
      : requiredScopes[0] === "cortex:read"
        ? "mcp"
        : "read";
    const deniedBody = agentLocation === "body"
      ? JSON.stringify({ marker, agentId: "foreign-agent-canary" })
      : undefined;
    const deniedPath = agentLocation === "query"
      ? `${path}?agentId=foreign-agent-canary`
      : path;
    const beforeDenied = upstreamRequests.length;
    const denied = await requestGateway({
      method,
      path: deniedPath,
      token: deniedToken,
      headers: agentLocation === "body"
        ? { "content-type": "application/json" }
        : {},
      body: deniedBody
    });
    assert.equal(denied.status, 403, `${method} ${path}: scope ordering`);
    assert.equal(denied.json.error, "insufficient_scope", `${method} ${path}`);
    assert.match(denied.headers["www-authenticate"], /insufficient_scope/);
    assert.equal(upstreamRequests.length, beforeDenied, `${method} ${path}`);
  }

  for (const accepted of [
    {
      method: "GET",
      path: "/api/v1/status/?agentId=agent-a&detail=equal",
      token: "read"
    },
    {
      method: "POST",
      path: "/api/v1/ingest/",
      token: "write",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-a", content: "equal" })
    }
  ]) {
    const response = await requestGateway(accepted);
    assert.equal(response.status, 200);
    const forwarded = upstreamRequests.at(-1);
    if (accepted.method === "GET") {
      const target = new URL(forwarded.url, "http://cortex.internal");
      assert.deepEqual(target.searchParams.getAll("agentId"), ["agent-a"]);
      assert.equal(target.pathname, "/api/v1/status");
    } else {
      assert.deepEqual(forwarded.body, { agentId: "agent-a", content: "equal" });
      assert.equal(new URL(forwarded.url, "http://cortex.internal").pathname, "/api/v1/ingest");
    }
  }

  const selectorRejections = [
    { method: "GET", path: "/api/v1/status?agentId=foreign-agent-canary", token: "read" },
    { method: "GET", path: "/api/v1/status?agent_id=agent-a", token: "read" },
    { method: "GET", path: "/api/v1/status?agentId=agent-a&agentId=agent-a", token: "read" },
    { method: "GET", path: "/api/v1/status?agentId%5B%5D=agent-a", token: "read" },
    { method: "GET", path: "/api/v1/status?agentId=", token: "read" },
    {
      method: "GET",
      path: "/api/v1/status",
      token: "read",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-a" })
    },
    {
      method: "POST",
      path: "/api/v1/ingest?agentId=agent-a",
      token: "write",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "wrong query location" })
    },
    {
      method: "POST",
      path: "/api/v1/ingest",
      token: "write",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-a", content: "alias" })
    },
    {
      method: "POST",
      path: "/api/v1/ingest",
      token: "write",
      headers: { "content-type": "application/json" },
      body: '{"agentId":"agent-a","agentId":"agent-a","content":"duplicate"}'
    },
    {
      method: "POST",
      path: "/api/v1/ingest",
      token: "write",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: 7, content: "malformed" })
    }
  ];
  for (const rejected of selectorRejections) {
    const before = upstreamRequests.length;
    const response = await requestGateway(rejected);
    assert.equal(response.status, 403, `${rejected.method} ${rejected.path}`);
    assert.equal(response.json.error, "agent_mismatch");
    assert.equal(response.headers["www-authenticate"], undefined);
    assert.doesNotMatch(response.text, /agent-a|foreign-agent-canary/);
    assert.equal(upstreamRequests.length, before);
  }

  const beforeSelectorFreeBody = upstreamRequests.length;
  const selectorFreeGetBody = await requestGateway({
    method: "GET",
    path: "/api/v1/status",
    token: "read",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(selectorFreeGetBody.status, 400);
  assert.equal(selectorFreeGetBody.json.error, "invalid_request");
  assert.equal(upstreamRequests.length, beforeSelectorFreeBody);

  const blockedRoutes = [
    ["GET", "/api/v1/agents"],
    ["GET", "/api/v1/future"],
    ["HEAD", "/api/v1/status"],
    ["POST", "/api/v1/status"],
    ["GET", "/api/v1/status//"],
    ["GET", "/api/v1/./status"],
    ["GET", "/api/v1/%73tatus"],
    ["GET", "/api/v1/status%2f"],
    ["GET", "/api/v1/graph/%2e%2e/status"],
    ["POST", "/api/v1/procedural/0/execute"],
    ["POST", "/api/v1/procedural/01/execute"],
    ["POST", "/api/v1/procedural/2147483648/execute"]
  ];
  for (const [method, path] of blockedRoutes) {
    const before = upstreamRequests.length;
    const response = await requestGateway({ method, path, token: "full" });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(upstreamRequests.length, before, `${method} ${path}`);
  }

  const beforeMalformedUnknown = upstreamRequests.length;
  const malformedUnknown = await requestGateway({
    method: "POST",
    path: "/api/v1/future",
    token: "full",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  assert.equal(malformedUnknown.status, 404);
  assert.equal(upstreamRequests.length, beforeMalformedUnknown);

  const beforeMalformedKnown = upstreamRequests.length;
  const malformedKnown = await requestGateway({
    method: "POST",
    path: "/api/v1/ingest",
    token: "write",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  assert.equal(malformedKnown.status, 400);
  assert.equal(malformedKnown.json.error, "invalid_request");
  assert.equal(upstreamRequests.length, beforeMalformedKnown);

  const beforeRedirect = upstreamRequests.length;
  const redirect = await requestGateway({
    path: "/api/v1/vitals?redirect=yes",
    token: "read"
  });
  assert.equal(redirect.status, 502);
  assert.deepEqual(redirect.json, { error: "bad_gateway" });
  assert.equal(redirect.headers.location, undefined);
  assert.equal(redirect.headers["set-cookie"], undefined);
  assert.equal(upstreamRequests.length, beforeRedirect + 1);
});

test("protected REST authentication and scope checks precede target availability", async (t) => {
  const scopes = Object.freeze({
    read: new Set(["cortex:read"]),
    mcp: new Set(["mcp"])
  });
  let upstreamCalls = 0;
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      mcpTarget: "http://127.0.0.1:1"
    },
    crypto: {
      async verifyAccessToken(token) {
        if (!Object.hasOwn(scopes, token)) throw new Error("invalid token");
        return { sid: token, token_use: "access" };
      },
      async verifyRevocationReference() {
        return null;
      }
    },
    verifyBrowserCredentials() {
      return false;
    },
    store: {
      async checkReadiness() {
        return { ready: true };
      },
      async resolveAccessContext({ claims }) {
        return {
          kind: "active",
          context: { ...AUTH_CONTEXT, scopes: scopes[claims.sid] }
        };
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      }
    },
    async fetchImpl() {
      upstreamCalls += 1;
      throw new Error("missing target must never fetch");
    }
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  t.after(async () => await closeServer(server));

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error, "invalid_token");

  const underScoped = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { authorization: "Bearer mcp" }
  });
  assert.equal(underScoped.status, 403);
  assert.equal((await underScoped.json()).error, "insufficient_scope");

  const authorized = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { authorization: "Bearer read" }
  });
  assert.equal(authorized.status, 502);
  assert.deepEqual(await authorized.json(), { error: "bad_gateway" });

  const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(health.status, 502);
  assert.deepEqual(await health.json(), { error: "bad_gateway" });
  assert.equal(upstreamCalls, 0);
});

test("hideHostedAgentSelector deep-clones and removes only the top-level selector", () => {
  const schema = {
    type: "object",
    properties: {
      agent_id: { type: "string", default: "arlo" },
      query: { type: "string" },
      nested: {
        type: "object",
        properties: { agent_id: { type: "string" } }
      }
    },
    required: ["agent_id", "query"],
    additionalProperties: false
  };
  const before = structuredClone(schema);

  const projected = hideHostedAgentSelector(schema);

  assert.deepEqual(schema, before);
  assert.notEqual(projected, schema);
  assert.notEqual(projected.properties, schema.properties);
  assert.equal(Object.hasOwn(projected.properties, "agent_id"), false);
  assert.deepEqual(projected.required, ["query"]);
  assert.deepEqual(
    projected.properties.nested.properties.agent_id,
    { type: "string" }
  );

  projected.properties.query.type = "number";
  assert.equal(schema.properties.query.type, "string");
});

test("hideHostedAgentSelector preserves schemas with no selector", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  };

  const projected = hideHostedAgentSelector(schema);

  assert.deepEqual(projected, schema);
  assert.notEqual(projected, schema);
});

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    // Node's global fetch pool can retain an otherwise-idle keep-alive socket
    // after the final response. Tests have already consumed every response at
    // teardown, so force those local-only sockets closed rather than allowing
    // one fixture to keep the complete unit suite pending indefinitely.
    server.closeAllConnections?.();
  });
}

const SLICE5_NOW = new Date("2030-01-02T03:04:05.000Z");
const SLICE5_CLIENT_IP = "203.0.113.40";
const SLICE5_OTHER_IP = "203.0.113.41";
const SLICE5_COOKIE_NAME = "__Host-cortex_oauth_session";
const SLICE5_REDIRECT = "https://chatgpt.com/connector/oauth/slice5-browser";
const SLICE5_CONTEXT = Object.freeze({
  principalId: "00000000-0000-4000-8000-000000000001",
  subject: "test-user",
  authenticationEpoch: 3,
  bindingId: "00000000-0000-4000-8000-000000000002",
  bindingVersion: 4,
  agentId: 7,
  agentExternalId: "agent-a",
  allowedScopes: Object.freeze(["cortex:read", "cortex:write", "mcp"])
});

function slice5Digest(value) {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function slice5AuthorizationValues(state = "slice5-state") {
  return {
    response_type: "code",
    client_id: "chatgpt-slice5-test-client",
    redirect_uri: SLICE5_REDIRECT,
    scope: "cortex:read cortex:write mcp",
    state,
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    resource: "https://cortex.example.test/mcp"
  };
}

async function startSlice5Gateway(t, {
  trustedProxyCidrs = ["127.0.0.1/32"],
  trustedIpHeader = "x-test-client-ip"
} = {}) {
  const calls = {
    createAuthorization: [],
    createLoginSession: [],
    resolveLoginSession: [],
    upgradeLegacyLoginSession: [],
    verifiedLegacyIps: []
  };
  let authorizationMode = "success";
  let resolveMode = "normal";
  let legacyMode = "upgraded";
  let activeSession = null;
  let loginCookieSequence = 0;
  let authorizationCodeSequence = 0;

  function unavailableError() {
    const error = new Error("sensitive persistence detail");
    error.name = "OAuthStoreUnavailableError";
    return error;
  }

  const crypto = {
    async verifyAccessToken() {
      throw new Error("not used by Slice 5 authorization tests");
    },
    async verifyRevocationReference() {
      return null;
    },
    createAuthorizationCode() {
      authorizationCodeSequence += 1;
      const raw = `${"C".repeat(42)}${authorizationCodeSequence % 10}`;
      return Object.freeze({ raw, digest: slice5Digest(`code:${raw}`) });
    },
    createLoginCookie() {
      loginCookieSequence += 1;
      const raw = `${"S".repeat(42)}${loginCookieSequence % 10}`;
      return Object.freeze({ raw, digest: slice5Digest(`cookie:${raw}`) });
    },
    digestLoginCookie(raw) {
      return slice5Digest(`cookie:${raw}`);
    },
    fingerprintClientIp(ip) {
      return slice5Digest(`ip:${ip}`);
    },
    fingerprintUserAgent(userAgent) {
      return slice5Digest(`ua:${userAgent}`);
    },
    verifyLegacyLoginCookie(raw, ip) {
      calls.verifiedLegacyIps.push(ip);
      if (raw !== "legacy.signed.cookie" || ip !== SLICE5_CLIENT_IP) return null;
      return Object.freeze({
        subject: "test-user",
        issuedAt: new Date(SLICE5_NOW.getTime() - 60_000),
        expiresAt: new Date(SLICE5_NOW.getTime() + 30 * 60_000),
        legacyCookieDigest: slice5Digest(`legacy:${raw}`)
      });
    }
  };

  const store = {
    async checkReadiness() {
      return { ready: true };
    },
    async resolveAccessContext() {
      return { kind: "invalid" };
    },
    async revokeByTokenReference() {
      return { kind: "not_found" };
    },
    async resolveActiveClient(clientId) {
      if (clientId !== "chatgpt-slice5-test-client") return null;
      return {
        status: "active",
        tokenEndpointAuthMethod: "none",
        redirectUris: [SLICE5_REDIRECT]
      };
    },
    async createLoginSession(input) {
      calls.createLoginSession.push(input);
      if (resolveMode === "unavailable") throw unavailableError();
      activeSession = Object.freeze({
        context: SLICE5_CONTEXT,
        issuedAt: new Date(SLICE5_NOW),
        expiresAt: new Date(SLICE5_NOW.getTime() + input.ttlSeconds * 1000)
      });
      activeSession = Object.freeze({
        ...activeSession,
        sessionDigest: new Uint8Array(input.sessionDigest),
        ipFingerprint: new Uint8Array(input.ipFingerprint)
      });
      return activeSession;
    },
    async resolveLoginSession(input) {
      calls.resolveLoginSession.push(input);
      if (resolveMode === "unavailable") throw unavailableError();
      const matches = activeSession &&
        Buffer.from(input.sessionDigest).equals(Buffer.from(activeSession.sessionDigest)) &&
        Buffer.from(input.ipFingerprint).equals(Buffer.from(activeSession.ipFingerprint));
      return matches
        ? { kind: "active", session: activeSession }
        : { kind: "invalid" };
    },
    async upgradeLegacyLoginSession(input) {
      calls.upgradeLegacyLoginSession.push(input);
      if (resolveMode === "unavailable") throw unavailableError();
      if (legacyMode === "already_upgraded") return { kind: "already_upgraded" };
      if (legacyMode === "invalid") return { kind: "invalid" };
      activeSession = Object.freeze({
        context: SLICE5_CONTEXT,
        issuedAt: new Date(SLICE5_NOW),
        expiresAt: new Date(input.legacyExpiresAt),
        sessionDigest: new Uint8Array(input.sessionDigest),
        ipFingerprint: new Uint8Array(input.ipFingerprint)
      });
      return { kind: "upgraded", session: activeSession };
    },
    async createAuthorization(input) {
      calls.createAuthorization.push(input);
      if (authorizationMode === "unavailable") throw unavailableError();
      return authorizationMode === "invalid" ? null : undefined;
    }
  };

  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      issuerUrl: "https://cortex.example.test",
      resourceUrl: "https://cortex.example.test/mcp",
      mcpTarget: "http://127.0.0.1:1",
      authCodeTtlSeconds: 300,
      loginSessionTtlSeconds: 3600,
      loginAttemptLimit: 20,
      loginAttemptWindowSeconds: 60,
      registrationAttemptLimit: 20,
      registrationAttemptWindowSeconds: 60,
      trustedIpHeader,
      trustedProxyCidrs
    },
    crypto,
    verifyBrowserCredentials(username, password) {
      return username === "test-user" && password === "test-password";
    },
    store,
    now: () => new Date(SLICE5_NOW)
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  t.after(async () => await closeServer(server));

  return {
    port,
    calls,
    crypto,
    setAuthorizationMode(value) {
      authorizationMode = value;
    },
    setResolveMode(value) {
      resolveMode = value;
    },
    setLegacyMode(value) {
      legacyMode = value;
    }
  };
}

function slice5AuthorizeUrl(port, state) {
  return `http://127.0.0.1:${port}/authorize?${new URLSearchParams(
    slice5AuthorizationValues(state)
  )}`;
}

function slice5Headers(ip = SLICE5_CLIENT_IP, extra = {}) {
  return {
    "user-agent": "slice5-browser",
    "x-test-client-ip": ip,
    ...extra
  };
}

function postSlice5Authorization(port, state, headers = slice5Headers()) {
  return fetch(`http://127.0.0.1:${port}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers
    },
    body: new URLSearchParams({
      ...slice5AuthorizationValues(state),
      username: "test-user",
      password: "test-password"
    })
  });
}

test("opaque browser login sets a hardened cookie and reuses only its exact IP-bound context", async (t) => {
  const gateway = await startSlice5Gateway(t);

  const missing = await fetch(slice5AuthorizeUrl(gateway.port, "missing-cookie"), {
    redirect: "manual",
    headers: slice5Headers()
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.headers.get("set-cookie"), null);
  assert.match(await missing.text(), /Cortex Login/);

  const login = await postSlice5Authorization(gateway.port, "credential-login");
  assert.equal(login.status, 302);
  const setCookie = login.headers.get("set-cookie") || "";
  assert.match(setCookie, new RegExp(`^${SLICE5_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
  assert.match(setCookie, /; Max-Age=3600;/i);
  assert.match(setCookie, /; Path=\//i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /; Domain=/i);
  const cookie = setCookie.split(";", 1)[0];
  assert.equal(gateway.calls.createLoginSession.length, 1);
  assert.equal(gateway.calls.createAuthorization.length, 1);
  assert.equal(
    gateway.calls.createLoginSession[0].requestId,
    gateway.calls.createAuthorization[0].requestId
  );
  assert.match(
    gateway.calls.createAuthorization[0].requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.deepEqual(
    gateway.calls.createAuthorization[0].authenticatedContext,
    SLICE5_CONTEXT
  );
  assert.deepEqual(
    gateway.calls.createAuthorization[0].ipFingerprint,
    gateway.crypto.fingerprintClientIp(SLICE5_CLIENT_IP)
  );
  assert.deepEqual(
    gateway.calls.createAuthorization[0].userAgentFingerprint,
    gateway.crypto.fingerprintUserAgent("slice5-browser")
  );

  const reused = await fetch(slice5AuthorizeUrl(gateway.port, "cookie-reuse"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie })
  });
  assert.equal(reused.status, 302);
  assert.equal(reused.headers.get("set-cookie"), null, "opaque reuse must not rotate the cookie");
  assert.equal(new URL(reused.headers.get("location")).searchParams.get("state"), "cookie-reuse");
  assert.equal(gateway.calls.createAuthorization.length, 2);
  assert.deepEqual(
    gateway.calls.createAuthorization[1].authenticatedContext,
    SLICE5_CONTEXT
  );

  const changedIp = await fetch(slice5AuthorizeUrl(gateway.port, "changed-ip"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_OTHER_IP, { cookie })
  });
  assert.equal(changedIp.status, 200);
  assert.match(changedIp.headers.get("set-cookie") || "", new RegExp(`^${SLICE5_COOKIE_NAME}=;`));
  assert.match(await changedIp.text(), /Cortex Login/);
  assert.equal(gateway.calls.createAuthorization.length, 2);

  const changedCookie = `${cookie.slice(0, -1)}X`;
  const mutated = await fetch(slice5AuthorizeUrl(gateway.port, "changed-cookie"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie: changedCookie })
  });
  assert.equal(mutated.status, 200);
  assert.match(mutated.headers.get("set-cookie") || "", new RegExp(`^${SLICE5_COOKIE_NAME}=;`));
  assert.equal(gateway.calls.createAuthorization.length, 2);

  const duplicate = await fetch(slice5AuthorizeUrl(gateway.port, "duplicate-cookie"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie: `${cookie}; ${cookie}` })
  });
  assert.equal(duplicate.status, 200);
  assert.match(duplicate.headers.get("set-cookie") || "", new RegExp(`^${SLICE5_COOKIE_NAME}=;`));
  assert.equal(gateway.calls.createAuthorization.length, 2);

  const resolvesBeforeOversized = gateway.calls.resolveLoginSession.length;
  const oversized = await fetch(slice5AuthorizeUrl(gateway.port, "oversized-cookie"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, {
      cookie: `${SLICE5_COOKIE_NAME}=${"Z".repeat(2049)}`
    })
  });
  assert.equal(oversized.status, 200);
  assert.match(oversized.headers.get("set-cookie") || "", new RegExp(`^${SLICE5_COOKIE_NAME}=;`));
  assert.equal(gateway.calls.resolveLoginSession.length, resolvesBeforeOversized);

  gateway.setAuthorizationMode("invalid");
  const staleContext = await fetch(slice5AuthorizeUrl(gateway.port, "stale-context"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie })
  });
  assert.equal(staleContext.status, 200);
  assert.equal(staleContext.headers.get("location"), null);
  assert.match(
    staleContext.headers.get("set-cookie") || "",
    new RegExp(`^${SLICE5_COOKIE_NAME}=;`)
  );
  assert.match(await staleContext.text(), /Cortex Login/);
});

test("valid v1 cookies upgrade once without extending expiry or letting a loser erase the winner", async (t) => {
  const gateway = await startSlice5Gateway(t);
  const legacyCookie = `${SLICE5_COOKIE_NAME}=legacy.signed.cookie`;

  const upgraded = await fetch(slice5AuthorizeUrl(gateway.port, "legacy-upgrade"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie: legacyCookie })
  });
  assert.equal(upgraded.status, 302);
  const replacement = upgraded.headers.get("set-cookie") || "";
  assert.match(replacement, new RegExp(`^${SLICE5_COOKIE_NAME}=[A-Za-z0-9_-]{43};`));
  assert.match(replacement, /; Max-Age=1800;/i);
  assert.equal(gateway.calls.upgradeLegacyLoginSession.length, 1);
  assert.equal(gateway.calls.createAuthorization.length, 1);
  const upgradeInput = gateway.calls.upgradeLegacyLoginSession[0];
  assert.equal(upgradeInput.legacySubject, "test-user");
  assert.equal(upgradeInput.legacyExpiresAt.toISOString(), "2030-01-02T03:34:05.000Z");
  assert.equal(upgradeInput.requestId, gateway.calls.createAuthorization[0].requestId);
  assert.deepEqual(gateway.calls.verifiedLegacyIps, [SLICE5_CLIENT_IP]);

  gateway.setLegacyMode("already_upgraded");
  const loser = await fetch(slice5AuthorizeUrl(gateway.port, "legacy-loser"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie: legacyCookie })
  });
  assert.equal(loser.status, 200);
  assert.equal(loser.headers.get("set-cookie"), null);
  assert.match(await loser.text(), /Cortex Login/);
  assert.equal(gateway.calls.createAuthorization.length, 1);

  const tampered = await fetch(slice5AuthorizeUrl(gateway.port, "legacy-tampered"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, {
      cookie: `${SLICE5_COOKIE_NAME}=tampered.signed.cookie`
    })
  });
  assert.equal(tampered.status, 200);
  assert.match(tampered.headers.get("set-cookie") || "", new RegExp(`^${SLICE5_COOKIE_NAME}=;`));

  gateway.setResolveMode("unavailable");
  const opaqueCookie = replacement.split(";", 1)[0];
  const outage = await fetch(slice5AuthorizeUrl(gateway.port, "session-outage"), {
    redirect: "manual",
    headers: slice5Headers(SLICE5_CLIENT_IP, { cookie: opaqueCookie })
  });
  assert.equal(outage.status, 503);
  assert.equal(outage.headers.get("set-cookie"), null);
  assert.match(await outage.text(), /temporarily unavailable/i);
});

test("committed browser sessions survive downstream authorization outages without another login", async (t) => {
  const legacyGateway = await startSlice5Gateway(t);
  legacyGateway.setAuthorizationMode("unavailable");
  const legacyOutage = await fetch(
    slice5AuthorizeUrl(legacyGateway.port, "legacy-code-outage"),
    {
      redirect: "manual",
      headers: slice5Headers(SLICE5_CLIENT_IP, {
        cookie: `${SLICE5_COOKIE_NAME}=legacy.signed.cookie`
      })
    }
  );
  assert.equal(legacyOutage.status, 503);
  const legacyReplacement = legacyOutage.headers.get("set-cookie") || "";
  assert.match(
    legacyReplacement,
    new RegExp(`^${SLICE5_COOKIE_NAME}=[A-Za-z0-9_-]{43};`)
  );
  assert.match(legacyReplacement, /; Path=\/; HttpOnly; Secure; SameSite=Lax$/i);
  assert.equal(legacyGateway.calls.upgradeLegacyLoginSession.length, 1);
  assert.equal(legacyGateway.calls.createAuthorization.length, 1);
  legacyGateway.setAuthorizationMode("success");
  const legacyRetry = await fetch(
    slice5AuthorizeUrl(legacyGateway.port, "legacy-code-retry"),
    {
      redirect: "manual",
      headers: slice5Headers(SLICE5_CLIENT_IP, {
        cookie: legacyReplacement.split(";", 1)[0]
      })
    }
  );
  assert.equal(legacyRetry.status, 302);
  assert.equal(legacyRetry.headers.get("set-cookie"), null);

  const credentialGateway = await startSlice5Gateway(t);
  credentialGateway.setAuthorizationMode("unavailable");
  const credentialOutage = await postSlice5Authorization(
    credentialGateway.port,
    "credential-code-outage"
  );
  assert.equal(credentialOutage.status, 503);
  const credentialSession = credentialOutage.headers.get("set-cookie") || "";
  assert.match(
    credentialSession,
    new RegExp(`^${SLICE5_COOKIE_NAME}=[A-Za-z0-9_-]{43};`)
  );
  assert.match(credentialSession, /; Path=\/; HttpOnly; Secure; SameSite=Lax$/i);
  assert.equal(credentialGateway.calls.createLoginSession.length, 1);
  assert.equal(credentialGateway.calls.createAuthorization.length, 1);
  credentialGateway.setAuthorizationMode("success");
  const credentialRetry = await fetch(
    slice5AuthorizeUrl(credentialGateway.port, "credential-code-retry"),
    {
      redirect: "manual",
      headers: slice5Headers(SLICE5_CLIENT_IP, {
        cookie: credentialSession.split(";", 1)[0]
      })
    }
  );
  assert.equal(credentialRetry.status, 302);
  assert.equal(credentialRetry.headers.get("set-cookie"), null);
});

test("trusted proxy authorization fails closed without one canonical client-IP header", async (t) => {
  const trustedGateway = await startSlice5Gateway(t);
  for (const headers of [
    { "user-agent": "slice5-browser" },
    slice5Headers("203.0.113.40, 203.0.113.41")
  ]) {
    const response = await fetch(slice5AuthorizeUrl(trustedGateway.port, "proxy-ip-failure"), {
      redirect: "manual",
      headers
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const missingPostIp = await postSlice5Authorization(
    trustedGateway.port,
    "proxy-post-ip-failure",
    { "user-agent": "slice5-browser" }
  );
  assert.equal(missingPostIp.status, 503);
  assert.equal(missingPostIp.headers.get("set-cookie"), null);
  assert.equal(trustedGateway.calls.createLoginSession.length, 0);
  assert.equal(trustedGateway.calls.resolveLoginSession.length, 0);
  assert.equal(trustedGateway.calls.createAuthorization.length, 0);

  const directGateway = await startSlice5Gateway(t, {
    trustedProxyCidrs: ["192.0.2.0/24"]
  });
  const direct = await postSlice5Authorization(
    directGateway.port,
    "direct-peer",
    slice5Headers("198.51.100.200")
  );
  assert.equal(direct.status, 302);
  assert.deepEqual(
    directGateway.calls.createLoginSession[0].ipFingerprint,
    directGateway.crypto.fingerprintClientIp("127.0.0.1")
  );
});

test("hosted MCP projects the full catalog and blocks a bound call immediately after live revocation", async (t) => {
  const rawStatusTool = {
    name: "cortex_status",
    description: "Get memory status",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", default: "arlo" },
        verbose: { type: "boolean", default: false }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" }, agent_id: { type: "string" } },
      required: ["ok", "agent_id"],
      additionalProperties: false
    }
  };
  const rawTools = CORTEX_TOOL_NAMES.map((name) => name === "cortex_status"
    ? rawStatusTool
    : {
        name,
        description: `${name} description`,
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string", default: "arlo" },
            value: { type: "string" }
          },
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" }, agent_id: { type: "string" } },
          required: ["ok", "agent_id"],
          additionalProperties: false
        }
      });
  const receivedCalls = [];
  const upstreamRequests = [];
  let listMode = "valid";

  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      upstreamRequests.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        message
      });

      if (message.method === "tools/list") {
        if (listMode === "error") {
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "catalog unavailable" }
          }));
          return;
        }
        if (listMode === "malformed") {
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {}
          }));
          return;
        }
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: rawTools }
        }));
        return;
      }

      if (message.method === "tools/call") {
        receivedCalls.push({
          arguments: message.params?.arguments,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie
        });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { received_arguments: message.params?.arguments }
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  const upstreamPort = await listenOnLoopback(upstreamServer);
  t.after(async () => await closeServer(upstreamServer));

  let active = true;
  let storeChecks = 0;
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      mcpTarget: `http://127.0.0.1:${upstreamPort}`
    },
    crypto: {
      async verifyAccessToken(token) {
        if (token !== "tracer-token") throw new Error("invalid token");
        return { sid: "grant-1", token_use: "access" };
      },
      async verifyRevocationReference() {
        return null;
      }
    },
    store: {
      async checkReadiness() {
        return { ready: true, database: true, schema: true, bootstrap: true };
      },
      async resolveAccessContext({ claims }) {
        storeChecks += 1;
        assert.equal(claims.sid, "grant-1");
        return active
          ? { kind: "active", context: AUTH_CONTEXT }
          : { kind: "revoked" };
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      }
    }
  });
  const gatewayServer = http.createServer(app);
  const gatewayPort = await listenOnLoopback(gatewayServer);
  t.after(async () => await closeServer(gatewayServer));

  const callGateway = async (message) => await fetch(
    `http://127.0.0.1:${gatewayPort}/mcp`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer tracer-token",
        cookie: "must-not-reach-upstream=1",
        "content-type": "application/json"
      },
      body: JSON.stringify(message)
    }
  );

  const listResponse = await callGateway({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listBody.result.tools.length, 29);
  const hostedStatusTool = listBody.result.tools.find(
    (tool) => tool.name === "cortex_status"
  );
  assert.equal(
    Object.hasOwn(hostedStatusTool.inputSchema.properties, "agent_id"),
    false
  );
  assert.equal(
    hostedStatusTool.inputSchema.required.includes("agent_id"),
    false
  );
  assert.deepEqual(
    hostedStatusTool.securitySchemes[0].scopes,
    ["cortex:read", "mcp"]
  );
  assert.equal(Object.hasOwn(rawStatusTool.inputSchema.properties, "agent_id"), true);

  listMode = "error";
  const listErrorResponse = await callGateway({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/list",
    params: {}
  });
  assert.equal(listErrorResponse.status, 200);
  assert.deepEqual(await listErrorResponse.json(), {
    jsonrpc: "2.0",
    id: 10,
    error: { code: -32000, message: "catalog unavailable" }
  });

  listMode = "malformed";
  const malformedListResponse = await callGateway({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/list",
    params: {}
  });
  assert.equal(malformedListResponse.status, 502);
  assert.deepEqual(await malformedListResponse.json(), { error: "bad_gateway" });
  listMode = "valid";

  const statusMessage = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "cortex_status", arguments: {} }
  };
  const allowedResponse = await callGateway(statusMessage);
  const allowedBody = await allowedResponse.json();
  assert.equal(allowedResponse.status, 200);
  assert.deepEqual(allowedBody.result.received_arguments, {
    agent_id: "agent-a"
  });
  assert.deepEqual(receivedCalls, [{
    arguments: { agent_id: "agent-a" },
    authorization: undefined,
    cookie: undefined
  }]);
  assert.equal(upstreamRequests.length, 4);
  for (const request of upstreamRequests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/mcp");
    assert.match(request.contentType, /^application\/json\b/);
    assert.equal(request.authorization, undefined);
    assert.equal(request.cookie, undefined);
  }

  active = false;
  const revokedResponse = await callGateway(statusMessage);
  assert.equal(revokedResponse.status, 401);
  assert.deepEqual(await revokedResponse.json(), { error: "invalid_token" });
  assert.equal(
    revokedResponse.headers.get("www-authenticate"),
    'Bearer error="invalid_token", resource_metadata="https://cortex.example.test/.well-known/oauth-protected-resource"'
  );
  assert.equal(receivedCalls.length, 1);
  assert.equal(upstreamRequests.length, 4);
  assert.equal(storeChecks, 5);
});

test("complete hosted MCP surface enforces catalog scopes raw isolation headers and streaming", async (t) => {
  const rawTools = CORTEX_TOOL_NAMES.map((name) => ({
    name,
    description: `${name} authoritative description`,
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", default: "arlo", description: "Agent ID" },
        payload: { type: "string", minLength: 1 },
        content: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          additionalProperties: true
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        agent_id: { type: "string" }
      },
      required: ["ok", "agent_id"],
      additionalProperties: false
    }
  }));
  const upstreamRequests = [];
  let listMode = "json";
  let releaseToolStream = null;

  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const message = JSON.parse(rawBody);
      upstreamRequests.push({
        message,
        rawBody,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        cfAccess: req.headers["cf-access-jwt-assertion"],
        apiKey: req.headers["x-api-key"],
        sessionId: req.headers["mcp-session-id"],
        protocolVersion: req.headers["mcp-protocol-version"]
      });

      if (message.method === "tools/list") {
        const payload = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: listMode === "missing" ? rawTools.slice(1) : rawTools
          }
        };
        if (listMode === "sse") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "mcp-session-id": "upstream-list-session"
          });
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return;
        }
        if (listMode === "non-success") res.statusCode = 500;
        res.setHeader(
          "content-type",
          listMode === "plain" ? "text/plain" : "application/json"
        );
        res.end(JSON.stringify(payload));
        return;
      }

      if (message.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }

      if (message.method === "tools/call" &&
        message.params?.arguments?.stream_marker === "delayed") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "mcp-session-id": "upstream-call-session"
        });
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"progress","params":{"step":1}}\n\n');
        releaseToolStream = () => {
          if (res.writableEnded) return;
          res.end(`event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { ok: true, agent_id: message.params.arguments.agent_id }
          })}\n\n`);
        };
        return;
      }

      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "upstream-response-session");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          method: message.method,
          received_arguments: message.params?.arguments ?? null
        }
      }));
    });
  });
  const upstreamPort = await listenOnLoopback(upstreamServer);
  t.after(async () => {
    releaseToolStream?.();
    await closeServer(upstreamServer);
  });

  const scopeContexts = {
    full: new Set(["cortex:read", "cortex:write", "mcp"]),
    read: new Set(["cortex:read", "mcp"]),
    write: new Set(["cortex:write", "mcp"]),
    mcp: new Set(["mcp"])
  };
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      mcpTarget: `http://127.0.0.1:${upstreamPort}`
    },
    crypto: {
      async verifyAccessToken(token) {
        if (!Object.hasOwn(scopeContexts, token)) throw new Error("invalid token");
        return { sid: token, token_use: "access" };
      },
      async verifyRevocationReference() {
        return null;
      }
    },
    store: {
      async checkReadiness() {
        return { ready: true, database: true, schema: true, bootstrap: true };
      },
      async resolveAccessContext({ claims }) {
        return {
          kind: "active",
          context: {
            ...AUTH_CONTEXT,
            sid: claims.sid,
            scopes: scopeContexts[claims.sid]
          }
        };
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      }
    }
  });
  const gatewayServer = http.createServer(app);
  const gatewayPort = await listenOnLoopback(gatewayServer);
  t.after(async () => await closeServer(gatewayServer));

  const postRaw = async (body, token = "full", headers = {}) => await fetch(
    `http://127.0.0.1:${gatewayPort}/mcp`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...headers
      },
      body
    }
  );
  const postMessage = async (message, token = "full", headers = {}) =>
    await postRaw(JSON.stringify(message), token, headers);

  for (const method of ["initialize", "ping", "notifications/initialized"]) {
    const message = { jsonrpc: "2.0", method, params: {} };
    if (method !== "notifications/initialized") message.id = method;
    const response = await postMessage(message, "mcp");
    assert.equal(response.status, method === "notifications/initialized" ? 202 : 200);
    if (method !== "notifications/initialized") {
      assert.equal((await response.json()).result.method, method);
    }
  }

  const listJson = await postMessage({
    jsonrpc: "2.0",
    id: "list-json",
    method: "tools/list",
    params: {}
  }, "mcp");
  const listJsonBody = await listJson.json();
  assert.equal(listJson.status, 200);
  assert.equal(listJsonBody.result.tools.length, 29);
  assert.ok(listJsonBody.result.tools.every((tool) =>
    !Object.hasOwn(tool.inputSchema.properties, "agent_id") &&
    !tool.inputSchema.required.includes("agent_id")));

  listMode = "sse";
  const listSse = await postMessage({
    jsonrpc: "2.0",
    id: "list-sse",
    method: "tools/list",
    params: {}
  }, "mcp");
  const listSseText = await listSse.text();
  assert.equal(listSse.status, 200);
  assert.match(listSse.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(listSse.headers.get("mcp-session-id"), "upstream-list-session");
  const listSsePayload = JSON.parse(listSseText.match(/^data: (.+)$/m)[1]);
  assert.equal(listSsePayload.result.tools.length, 29);
  assert.ok(listSsePayload.result.tools.every((tool) =>
    !Object.hasOwn(tool.inputSchema.properties, "agent_id")));

  listMode = "missing";
  const missingList = await postMessage({
    jsonrpc: "2.0",
    id: "list-missing",
    method: "tools/list",
    params: {}
  }, "mcp");
  assert.equal(missingList.status, 502);
  assert.deepEqual(await missingList.json(), { error: "bad_gateway" });

  for (const invalidMode of ["plain", "non-success"]) {
    listMode = invalidMode;
    const invalidList = await postMessage({
      jsonrpc: "2.0",
      id: `list-${invalidMode}`,
      method: "tools/list",
      params: {}
    }, "mcp");
    const invalidBody = await invalidList.json();
    assert.equal(invalidList.status, 502);
    assert.deepEqual(invalidBody, { error: "bad_gateway" });
    assert.doesNotMatch(JSON.stringify(invalidBody), /agent_id|cortex_status/);
  }
  listMode = "json";

  for (const name of CORTEX_TOOL_NAMES) {
    const access = CORTEX_TOOL_METADATA[name].access;
    const token = access === "read_write" ? "full" : access;
    const response = await postMessage({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: { payload: name } }
    }, token);
    assert.equal(response.status, 200, name);
    assert.deepEqual((await response.json()).result.received_arguments, {
      payload: name,
      agent_id: "agent-a"
    });

    const beforeDenied = upstreamRequests.length;
    const denied = await postMessage({
      jsonrpc: "2.0",
      id: `${name}-denied`,
      method: "tools/call",
      params: { name, arguments: { agent_id: "agent-b" } }
    }, "mcp");
    assert.equal(denied.status, 403, `${name} must require its classified scope`);
    assert.equal((await denied.json()).error, "insufficient_scope");
    assert.match(denied.headers.get("www-authenticate"), /insufficient_scope/);
    assert.equal(upstreamRequests.length, beforeDenied);
  }

  const beforeScopeFailure = upstreamRequests.length;
  const scopeFailure = await postRaw(
    '{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"cortex_artifact","arguments":{"agent_id":"agent-b"}}}',
    "read"
  );
  assert.equal(scopeFailure.status, 403);
  assert.equal((await scopeFailure.json()).error, "insufficient_scope");
  assert.match(scopeFailure.headers.get("www-authenticate"), /insufficient_scope/);
  assert.equal(upstreamRequests.length, beforeScopeFailure);

  const equalCached = await postRaw(
    '{"jsonrpc":"2.0","id":"equal-cached","method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-a"}}}',
    "read"
  );
  assert.equal(equalCached.status, 200);
  await equalCached.arrayBuffer();
  const equalCachedUpstream = upstreamRequests.at(-1);
  assert.equal(
    (equalCachedUpstream.rawBody.match(/"agent_id"/g) || []).length,
    1
  );
  assert.deepEqual(equalCachedUpstream.message.params.arguments, {
    agent_id: "agent-a"
  });

  const rejectedSelectors = [
    '{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-b"}}}',
    '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agentId":"agent-a"}}}',
    '{"jsonrpc":"2.0","id":43,"method":"tools/call","agent_id":"agent-a","params":{"name":"cortex_status","arguments":{}}}',
    '{"jsonrpc":"2.0","id":44,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":"agent-a","agent\\u005fid":"agent-b"}}}',
    '{"jsonrpc":"2.0","id":45,"method":"tools/call","params":{"name":"cortex_status","arguments":{"agent_id":null}}}',
    '{"jsonrpc":"2.0","id":"escaped-parent","method":"tools/call","par\\u0061ms":{"name":"cortex_status","argu\\u006dents":{"agent\\u005fid":"agent-b"}}}'
  ];
  for (const raw of rejectedSelectors) {
    const before = upstreamRequests.length;
    const response = await postRaw(raw, "read");
    const body = await response.json();
    assert.equal(response.status, 403, raw);
    assert.equal(body.error, "agent_mismatch");
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.doesNotMatch(JSON.stringify(body), /agent-a|agent-b/);
    assert.equal(upstreamRequests.length, before);
  }

  for (const raw of [
    '{"jsonrpc":"2.0","id":"ping-selector","method":"ping","agent_id":"agent-a","params":{}}',
    '{"jsonrpc":"2.0","id":"list-selector","method":"tools/list","params":{"agentId":"agent-a"}}'
  ]) {
    const before = upstreamRequests.length;
    const response = await postRaw(raw, "mcp");
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "agent_mismatch");
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(upstreamRequests.length, before);
  }

  const nestedResponse = await postMessage({
    jsonrpc: "2.0",
    id: 46,
    method: "tools/call",
    params: {
      name: "cortex_status",
      arguments: { content: { agent_id: "content-value", agentId: "also-content" } }
    }
  }, "read");
  assert.equal(nestedResponse.status, 200);
  assert.deepEqual((await nestedResponse.json()).result.received_arguments, {
    content: { agent_id: "content-value", agentId: "also-content" },
    agent_id: "agent-a"
  });

  for (const rejected of [
    JSON.stringify([{ jsonrpc: "2.0", id: 50, method: "ping" }]),
    JSON.stringify({ jsonrpc: "2.0", id: 51, method: "resources/list", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: { name: "cortex_future_tool", arguments: {} }
    }),
    '{"jsonrpc":"2.0","id":53,"method":"ping","method":"tools/list","params":{}}'
  ]) {
    const before = upstreamRequests.length;
    const response = await postRaw(rejected, "full");
    assert.ok([400, 404].includes(response.status));
    assert.equal(upstreamRequests.length, before);
  }

  const scrubbed = await postMessage({
    jsonrpc: "2.0",
    id: 60,
    method: "ping",
    params: {}
  }, "mcp", {
    cookie: "connector-session=secret",
    "cf-access-jwt-assertion": "edge-secret",
    "x-api-key": "api-secret",
    "mcp-session-id": "client-session",
    "mcp-protocol-version": "2025-06-18"
  });
  assert.equal(scrubbed.status, 200);
  assert.equal(scrubbed.headers.get("mcp-session-id"), "upstream-response-session");
  await scrubbed.arrayBuffer();
  const scrubbedRequest = upstreamRequests.at(-1);
  assert.equal(scrubbedRequest.authorization, undefined);
  assert.equal(scrubbedRequest.cookie, undefined);
  assert.equal(scrubbedRequest.cfAccess, undefined);
  assert.equal(scrubbedRequest.apiKey, undefined);
  assert.equal(scrubbedRequest.sessionId, "client-session");
  assert.equal(scrubbedRequest.protocolVersion, "2025-06-18");

  const streamStartedAt = Date.now();
  const streamed = await postMessage({
    jsonrpc: "2.0",
    id: 61,
    method: "tools/call",
    params: {
      name: "cortex_search",
      arguments: { stream_marker: "delayed" }
    }
  }, "full");
  const streamReader = streamed.body.getReader();
  const firstChunk = await streamReader.read();
  const firstChunkElapsed = Date.now() - streamStartedAt;
  assert.equal(streamed.status, 200);
  assert.equal(firstChunk.done, false);
  assert.match(Buffer.from(firstChunk.value).toString("utf8"), /"step":1/);
  assert.ok(firstChunkElapsed < 700, `first hosted MCP chunk took ${firstChunkElapsed}ms`);
  assert.equal(streamed.headers.get("mcp-session-id"), "upstream-call-session");
  releaseToolStream();
  const secondChunk = await streamReader.read();
  assert.equal(secondChunk.done, false);
  assert.match(Buffer.from(secondChunk.value).toString("utf8"), /"agent_id":"agent-a"/);
  await streamReader.cancel();

  for (const request of upstreamRequests) {
    assert.equal(request.authorization, undefined);
    assert.equal(request.cookie, undefined);
    assert.equal(request.cfAccess, undefined);
    assert.equal(request.apiKey, undefined);
  }
});

test("livez is process-only while readyz gates every dependency without details", async (t) => {
  let authorityMode = "ready";
  let restMode = "ready";
  let mcpMode = "ready";
  let readinessClock = 0;
  let readinessChecks = 0;
  let mcpCleanupChecks = 0;
  const upstreamChecks = [];
  const securityEvents = [];
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      restTarget: "http://core.internal:3100",
      mcpTarget: "http://mcp.internal:8000"
    },
    crypto: {
      async verifyAccessToken() {
        throw new Error("not used");
      },
      async verifyRevocationReference() {
        return null;
      }
    },
    store: {
      async checkReadiness() {
        readinessChecks += 1;
        if (authorityMode === "error") throw new Error("sensitive database detail");
        if (authorityMode !== "ready") {
          return {
            ready: false,
            database: authorityMode !== "database",
            schema: false,
            bootstrap: false,
            legacyImport: false,
            reason: authorityMode
          };
        }
        return {
          ready: true,
          database: true,
          schema: true,
          bootstrap: true,
          legacyImport: true
        };
      },
      async resolveAccessContext() {
        return { kind: "invalid" };
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      }
    },
    async fetchImpl(target, options) {
      upstreamChecks.push({ target: String(target), options });
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers.cookie, undefined);
      if (String(target).endsWith("/readyz")) {
        assert.equal(options.method, "GET");
        if (restMode === "error") throw new Error("sensitive REST detail");
        if (restMode === "redirect") {
          return new Response("", { status: 302, headers: { location: "https://bad.test" } });
        }
        if (restMode === "oversized") {
          return new Response("x".repeat(1025), { status: 200 });
        }
        return Response.json(
          { status: restMode === "ready" ? "ok" : "not_ready" },
          { status: restMode === "ready" ? 200 : 503 }
        );
      }
      if (String(target).endsWith("/mcp") && options.method === "DELETE") {
        mcpCleanupChecks += 1;
        assert.match(options.headers["mcp-session-id"], /^[A-Za-z0-9._~-]+$/);
        assert.equal(options.headers["mcp-protocol-version"], "2025-06-18");
        assert.equal(options.body, undefined);
        return new Response(null, {
          status: mcpMode === "cleanup-failure" ? 500 : 200
        });
      }
      if (String(target).endsWith("/mcp") && options.method === "POST") {
        const message = JSON.parse(options.body);
        assert.equal(options.headers["content-type"], "application/json");
        assert.equal(options.headers.accept, "application/json, text/event-stream");
        assert.equal(options.headers["accept-encoding"], "identity");
        assert.equal(options.headers["mcp-protocol-version"], "2025-06-18");
        if (message.method === "notifications/initialized") {
          assert.deepEqual(message, {
            jsonrpc: "2.0",
            method: "notifications/initialized"
          });
          assert.equal(options.headers["mcp-session-id"], "readiness-session");
          return new Response(null, {
            status: mcpMode === "initialized-failure" ? 500 : 202
          });
        }
        if (message.method === "ping") {
          assert.deepEqual(message, {
            jsonrpc: "2.0",
            id: "cortex-readiness-ping",
            method: "ping"
          });
          assert.equal(options.headers["mcp-session-id"], "readiness-session");
          if (mcpMode === "ping-failure") {
            return new Response("not ready", { status: 503 });
          }
          return Response.json(
            mcpMode === "ping-rpc-error"
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32603, message: "sensitive ping failure" }
                }
              : { jsonrpc: "2.0", id: message.id, result: {} }
          );
        }
        assert.deepEqual(message, {
          jsonrpc: "2.0",
          id: "cortex-readiness",
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {
              name: "cortex-oauth-gateway-readiness",
              version: "1"
            }
          }
        });
        assert.equal(options.headers["mcp-session-id"], undefined);
        if (mcpMode === "error") throw new Error("sensitive MCP detail");
        if (mcpMode === "redirect") {
          return new Response("", { status: 302, headers: { location: "https://bad.test" } });
        }
        if (mcpMode === "health-only" || mcpMode === "not-ready") {
          return new Response("not ready", { status: 503 });
        }
        if (mcpMode === "oversized") {
          return new Response("x".repeat(16 * 1024 + 1), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "readiness-oversized"
            }
          });
        }
        const result = {
          protocolVersion: mcpMode === "wrong-protocol" ? "2024-11-05" : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cortex-v2", version: "2.4.0" },
          instructions: "x".repeat(2048)
        };
        const responseMessage = mcpMode === "rpc-error"
          ? {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: "sensitive upstream failure" }
            }
          : {
              jsonrpc: "2.0",
              id: mcpMode === "wrong-id" ? "other-request" : message.id,
              result
            };
        const sessionId = mcpMode === "invalid-session"
          ? "invalid session"
          : "readiness-session";
        if (mcpMode === "invalid-json") {
          return new Response("not-json", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": sessionId
            }
          });
        }
        const headers = { "content-type": "application/json" };
        if (mcpMode !== "missing-session") {
          headers["mcp-session-id"] = sessionId;
        }
        if (mcpMode === "sse-ready") {
          headers["content-type"] = "text/event-stream; charset=utf-8";
          return new Response(
            `event: message\ndata: ${JSON.stringify(responseMessage)}\n\n`,
            { status: 200, headers }
          );
        }
        return new Response(JSON.stringify(responseMessage), {
          status: 200,
          headers
        });
      }
      throw new Error("unexpected readiness target");
    },
    logger: {
      event(event, outcome, metadata) {
        securityEvents.push({ event, outcome, metadata });
        return true;
      }
    },
    readinessClock: () => readinessClock
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  t.after(async () => await closeServer(server));

  const live = await fetch(`http://127.0.0.1:${port}/livez`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "ok" });
  assert.equal(live.headers.get("cache-control"), "no-store");
  assert.equal(readinessChecks, 0);

  const readyResponses = await Promise.all([
    fetch(`http://127.0.0.1:${port}/readyz`),
    fetch(`http://127.0.0.1:${port}/readyz`)
  ]);
  for (const ready of readyResponses) {
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ok" });
    assert.equal(ready.headers.get("cache-control"), "no-store");
  }
  const readinessCallLabel = (check) => {
    if (check.options.method !== "POST") {
      return `${check.options.method} ${check.target}`;
    }
    return `${JSON.parse(check.options.body).method} ${check.target}`;
  };
  assert.deepEqual(upstreamChecks.map(readinessCallLabel).sort(), [
    "DELETE http://mcp.internal:8000/mcp",
    "GET http://core.internal:3100/readyz",
    "initialize http://mcp.internal:8000/mcp",
    "notifications/initialized http://mcp.internal:8000/mcp",
    "ping http://mcp.internal:8000/mcp"
  ]);
  assert.equal(mcpCleanupChecks, 1);
  assert.equal(readinessChecks, 1);

  const cachedReady = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(cachedReady.status, 200);
  assert.deepEqual(await cachedReady.json(), { status: "ok" });
  assert.equal(readinessChecks, 1);
  assert.equal(upstreamChecks.length, 5);

  readinessClock += 5_001;
  mcpMode = "sse-ready";
  const sseReady = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(sseReady.status, 200);
  assert.deepEqual(await sseReady.json(), { status: "ok" });

  const cases = [
    ["database", "ready", "ready"],
    ["schema", "ready", "ready"],
    ["bootstrap", "ready", "ready"],
    ["legacy_import", "ready", "ready"],
    ["error", "ready", "ready"],
    ["ready", "not-ready", "ready"],
    ["ready", "redirect", "ready"],
    ["ready", "oversized", "ready"],
    ["ready", "error", "ready"],
    ["ready", "ready", "not-ready"],
    ["ready", "ready", "health-only"],
    ["ready", "ready", "redirect"],
    ["ready", "ready", "oversized"],
    ["ready", "ready", "missing-session"],
    ["ready", "ready", "invalid-session"],
    ["ready", "ready", "wrong-protocol"],
    ["ready", "ready", "wrong-id"],
    ["ready", "ready", "rpc-error"],
    ["ready", "ready", "invalid-json"],
    ["ready", "ready", "initialized-failure"],
    ["ready", "ready", "ping-failure"],
    ["ready", "ready", "ping-rpc-error"],
    ["ready", "ready", "cleanup-failure"],
    ["ready", "ready", "error"],
  ];
  for (const [nextAuthority, nextRest, nextMcp] of cases) {
    readinessClock += 5_001;
    authorityMode = nextAuthority;
    restMode = nextRest;
    mcpMode = nextMcp;
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  }
  const upstreamCountBeforeCachedFailure = upstreamChecks.length;
  const eventCountBeforeCachedFailure = securityEvents.length;
  const cachedFailure = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(cachedFailure.status, 503);
  assert.deepEqual(await cachedFailure.json(), { status: "not_ready" });
  assert.equal(upstreamChecks.length, upstreamCountBeforeCachedFailure);
  assert.equal(securityEvents.length, eventCountBeforeCachedFailure);
  assert.equal(readinessChecks, 2 + cases.length);
  assert.equal(
    upstreamChecks.some((check) => check.target.endsWith("/healthz")),
    false
  );
  const serialized = JSON.stringify(securityEvents);
  assert.equal(serialized.includes("sensitive"), false);
  assert.equal(serialized.includes("must-not-leak"), false);
});

test("gateway readiness bounds stalled upstream probes", async () => {
  const started = Date.now();
  const report = await probeGatewayReadiness({
    config: {
      restTarget: "http://core.internal:3100",
      mcpTarget: "http://mcp.internal:8000",
    },
    store: {
      async checkReadiness() {
        return {
          ready: true,
          database: true,
          schema: true,
          bootstrap: true,
          legacyImport: true,
        };
      },
    },
    timeoutMs: 20,
    async fetchImpl(_target, options) {
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });
  assert.equal(report.ready, false);
  assert.equal(report.reason, "rest");
  assert.ok(Date.now() - started < 500);
});

test("gateway readiness cleans timed-out MCP sessions with its own bounded deadline", async () => {
  for (const stalledStep of ["ping", "cleanup"]) {
    let cleanupCalls = 0;
    const started = Date.now();
    const report = await probeGatewayReadiness({
      config: {
        restTarget: "http://core.internal:3100",
        mcpTarget: "http://mcp.internal:8000",
      },
      store: {
        async checkReadiness() {
          return {
            ready: true,
            database: true,
            schema: true,
            bootstrap: true,
            legacyImport: true,
          };
        },
      },
      timeoutMs: 20,
      async fetchImpl(target, options) {
        if (String(target).endsWith("/readyz")) {
          return Response.json({ status: "ok" });
        }
        if (options.method === "DELETE") {
          cleanupCalls += 1;
          assert.equal(options.signal.aborted, false);
          assert.equal(options.headers["mcp-session-id"], "timeout-session");
          if (stalledStep === "cleanup") {
            return await new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true }
              );
            });
          }
          return new Response(null, { status: 200 });
        }
        const message = JSON.parse(options.body);
        if (message.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "cortex-v2", version: "2.4.0" },
            },
          }, {
            headers: { "mcp-session-id": "timeout-session" },
          });
        }
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        assert.equal(message.method, "ping");
        if (stalledStep === "ping") {
          return await new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
          });
        }
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
      },
    });
    assert.equal(report.ready, false);
    assert.equal(report.reason, "mcp");
    assert.equal(cleanupCalls, 1);
    assert.ok(Date.now() - started < 500);
  }
});

test("foreign agent rejections emit only redacted local and audit metadata", async (t) => {
  const foreignAgent = "foreign-agent-canary-never-persist";
  const bearer = "bearer-canary-never-log";
  const rawIp = "203.0.113.89";
  const cookie = "cookie-canary-never-log";
  const password = "password-canary-never-log";
  const auditInputs = [];
  const logEntries = [];
  let upstreamCalls = 0;
  const context = Object.freeze({
    ...AUTH_CONTEXT,
    sid: "00000000-0000-4000-8000-000000000012",
    principalId: "00000000-0000-4000-8000-000000000013",
    bindingId: "00000000-0000-4000-8000-000000000014",
    scopes: Object.freeze(["cortex:read", "cortex:write", "mcp"]),
  });
  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      issuerUrl: "https://cortex.example.test",
      resourceUrl: "https://cortex.example.test/mcp",
      restTarget: "http://core.internal:3100",
      mcpTarget: "http://mcp.internal:8000",
      trustedIpHeader: "",
      trustedProxyCidrs: [],
    },
    crypto: {
      async verifyAccessToken(token) {
        assert.equal(token, bearer);
        return { token_use: "access" };
      },
      async verifyRevocationReference() {
        return null;
      },
    },
    store: {
      async checkReadiness() {
        return { ready: false, reason: "database" };
      },
      async resolveAccessContext() {
        return { kind: "active", context };
      },
      async revokeByTokenReference() {
        return { kind: "not_found" };
      },
      async recordSecurityEvent(input) {
        auditInputs.push(input);
      },
    },
    logger: createSecurityLogger((entry) => logEntries.push(entry)),
    async fetchImpl() {
      upstreamCalls += 1;
      throw new Error("must not reach upstream");
    },
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  t.after(async () => await closeServer(server));

  const headers = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    cookie: `session=${cookie}`,
    "x-forwarded-for": rawIp,
    "x-test-password": password,
  };
  const rest = await fetch(`http://127.0.0.1:${port}/api/v1/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent_id: foreignAgent, query: "safe" }),
  });
  assert.equal(rest.status, 403);
  assert.equal((await rest.json()).error, "agent_mismatch");

  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cortex_search", arguments: { agent_id: foreignAgent, query: "safe" } },
    }),
  });
  assert.equal(mcp.status, 403);
  assert.equal((await mcp.json()).error, "agent_mismatch");
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(auditInputs.map((input) => input.metadata), [
    { surface: "rest" },
    { surface: "mcp" },
  ]);
  assert.deepEqual(logEntries.map((entry) => entry.metadata), [
    { surface: "rest" },
    { surface: "mcp" },
  ]);
  const serialized = JSON.stringify({ auditInputs, logEntries });
  for (const canary of [foreignAgent, bearer, rawIp, cookie, password]) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("RFC 7009 discovery and revocation are non-oracular and immediately gate REST and MCP", async (t) => {
  const clientId = "chatgpt-slice8-public-client";
  const familySid = "00000000-0000-4000-8000-000000000008";
  const calls = { verified: [], revoked: [], upstream: 0 };
  let active = true;
  let resolveClientMode = "normal";
  let revokeMode = "normal";

  const unavailable = () => Object.assign(new Error("sensitive database canary"), {
    name: "OAuthStoreUnavailableError"
  });
  const referenceFor = (token) => {
    if (token === "malformed-token") return null;
    if (token === "signed-other-client") {
      return Object.freeze({
        sid: familySid,
        clientId: "chatgpt-other-client",
        tokenUse: "refresh"
      });
    }
    if (token === "signed-unknown-family") {
      return Object.freeze({
        sid: "00000000-0000-4000-8000-000000000009",
        clientId,
        tokenUse: "access"
      });
    }
    if (new Set(["signed-expired-access", "signed-refresh", "signed-access"])
      .has(token)) {
      return Object.freeze({
        sid: familySid,
        clientId,
        tokenUse: token === "signed-refresh" ? "refresh" : "access"
      });
    }
    return null;
  };

  const app = createGatewayApp({
    config: {
      baseUrl: "https://cortex.example.test",
      issuerUrl: "https://issuer.cortex.example.test",
      resourceUrl: "https://cortex.example.test/mcp",
      restTarget: "http://127.0.0.1:1",
      mcpTarget: "http://127.0.0.1:1"
    },
    crypto: {
      async verifyAccessToken(token) {
        if (token !== "protected-token") throw new Error("invalid token");
        return { sid: familySid, token_use: "access" };
      },
      async verifyRevocationReference(token) {
        calls.verified.push(token);
        return referenceFor(token);
      }
    },
    store: {
      async checkReadiness() {
        return { ready: true };
      },
      async resolveActiveClient(candidate) {
        if (resolveClientMode === "unavailable") throw unavailable();
        if (candidate === "chatgpt-confidential-client") {
          return { status: "active", tokenEndpointAuthMethod: "client_secret_basic" };
        }
        return candidate === clientId
          ? { status: "active", tokenEndpointAuthMethod: "none" }
          : null;
      },
      async revokeByTokenReference(input) {
        calls.revoked.push(input);
        if (revokeMode === "unavailable") throw unavailable();
        if (input.reference.clientId !== clientId ||
          input.reference.sid.endsWith("0009")) {
          return { kind: "not_found" };
        }
        active = false;
        return { kind: "revoked" };
      },
      async resolveAccessContext() {
        return active
          ? { kind: "active", context: AUTH_CONTEXT }
          : { kind: "revoked" };
      }
    },
    async fetchImpl() {
      calls.upstream += 1;
      throw new Error("revoked requests must not reach an upstream");
    }
  });
  const server = http.createServer(app);
  const port = await listenOnLoopback(server);
  t.after(async () => await closeServer(server));

  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration"
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(
      metadata.revocation_endpoint,
      "https://issuer.cortex.example.test/revoke"
    );
    assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, [
      "none",
      "client_secret_basic",
      "client_secret_post"
    ]);
  }

  const postRevoke = async (values, headers = {}) => await fetch(
    `http://127.0.0.1:${port}/revoke`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers
      },
      body: new URLSearchParams(values)
    }
  );
  const emptySignature = async (response) => ({
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
    pragma: response.headers.get("pragma"),
    contentType: response.headers.get("content-type"),
    challenge: response.headers.get("www-authenticate")
  });

  const missingToken = await postRevoke({ client_id: clientId });
  assert.equal(missingToken.status, 400);
  assert.deepEqual(await missingToken.json(), { error: "invalid_request" });
  assert.equal(missingToken.headers.get("cache-control"), "no-store");

  const wrongMediaType = await fetch(`http://127.0.0.1:${port}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, token: "signed-access" })
  });
  assert.equal(wrongMediaType.status, 400);
  assert.deepEqual(await wrongMediaType.json(), { error: "invalid_request" });

  const malformedJson = await fetch(`http://127.0.0.1:${port}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.headers.get("cache-control"), "no-store");
  assert.equal(malformedJson.headers.get("pragma"), "no-cache");

  const oversizedForm = await fetch(`http://127.0.0.1:${port}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      token: "x".repeat(70 * 1024)
    }).toString()
  });
  assert.equal(oversizedForm.status, 400);
  assert.deepEqual(await oversizedForm.json(), { error: "invalid_request" });
  assert.equal(oversizedForm.headers.get("cache-control"), "no-store");
  assert.equal(oversizedForm.headers.get("pragma"), "no-cache");
  assert.equal(oversizedForm.headers.get("www-authenticate"), null);

  const basic = await postRevoke(
    { client_id: clientId, token: "signed-access" },
    { authorization: `Basic ${Buffer.from("client:secret").toString("base64")}` }
  );
  assert.equal(basic.status, 401);
  assert.deepEqual(await basic.json(), { error: "invalid_client" });
  assert.equal(basic.headers.get("www-authenticate"), 'Basic realm="cortex-oauth"');

  const bearer = await postRevoke(
    { client_id: clientId, token: "signed-access" },
    { authorization: "Bearer client-credential" }
  );
  assert.equal(bearer.status, 400);
  assert.deepEqual(await bearer.json(), { error: "invalid_client" });
  assert.equal(bearer.headers.get("www-authenticate"), null);

  const secret = await postRevoke({
    client_id: clientId,
    client_secret: "must-not-work",
    token: "signed-access"
  });
  assert.equal(secret.status, 400);
  assert.deepEqual(await secret.json(), { error: "invalid_client" });

  for (const rejectedClient of ["unknown-client", "chatgpt-confidential-client"]) {
    const response = await postRevoke({
      client_id: rejectedClient,
      token: "signed-access"
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_client" });
    assert.equal(response.headers.get("www-authenticate"), null);
  }

  const oracleResponses = [];
  for (const [token, tokenTypeHint] of [
    ["malformed-token", "not-a-real-hint"],
    ["signed-unknown-family", "access_token"],
    ["signed-expired-access", "refresh_token"],
    ["signed-other-client", "refresh_token"],
    ["signed-refresh", "access_token"]
  ]) {
    oracleResponses.push(await emptySignature(await postRevoke({
      client_id: clientId,
      token,
      token_type_hint: tokenTypeHint
    }, { cookie: "browser-session=must-be-irrelevant" })));
  }
  for (const signature of oracleResponses) {
    assert.deepEqual(signature, {
      status: 200,
      body: "",
      cacheControl: "no-store",
      pragma: "no-cache",
      contentType: null,
      challenge: null
    });
  }

  const revoked = await postRevoke({ client_id: clientId, token: "signed-access" });
  assert.deepEqual(await emptySignature(revoked), oracleResponses[0]);
  const finalInput = calls.revoked.at(-1);
  assert.deepEqual({
    reference: finalInput.reference,
    clientId: finalInput.clientId,
    ipFingerprint: finalInput.ipFingerprint,
    userAgentFingerprint: finalInput.userAgentFingerprint
  }, {
    reference: { sid: familySid, clientId, tokenUse: "access" },
    clientId,
    ipFingerprint: null,
    userAgentFingerprint: null
  });
  assert.match(finalInput.requestId, /^[0-9a-f-]{36}$/);

  const rest = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
    headers: { authorization: "Bearer protected-token" }
  });
  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer protected-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} })
  });
  for (const response of [rest, mcp]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_token" });
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer error="invalid_token", resource_metadata="https://cortex.example.test/.well-known/oauth-protected-resource"'
    );
  }
  assert.equal(calls.upstream, 0);

  resolveClientMode = "unavailable";
  const resolveOutage = await postRevoke({ client_id: clientId, token: "signed-access" });
  assert.equal(resolveOutage.status, 503);
  assert.deepEqual(await resolveOutage.json(), { error: "temporarily_unavailable" });
  assert.equal(resolveOutage.headers.get("www-authenticate"), null);
  assert.equal(resolveOutage.headers.get("cache-control"), "no-store");

  resolveClientMode = "normal";
  revokeMode = "unavailable";
  const revokeOutage = await postRevoke({ client_id: clientId, token: "signed-access" });
  assert.equal(revokeOutage.status, 503);
  assert.deepEqual(await revokeOutage.json(), { error: "temporarily_unavailable" });
  assert.equal(revokeOutage.headers.get("www-authenticate"), null);
  assert.equal(revokeOutage.headers.get("cache-control"), "no-store");
});
