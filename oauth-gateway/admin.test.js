import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_USAGE,
  OAuthAdminUnavailableError,
  OAuthAdminUsageError,
  formatAdminResult,
  parseAdminCommand,
  runAdminCli,
  runAdminCommand,
  validateOperatorDatabaseUrl
} from "./admin.js";

const SID = "11111111-1111-4111-8111-111111111111";
const BINDING_ID = "22222222-2222-4222-8222-222222222222";
const OPERATOR_URL =
  "postgresql://cortex_oauth_operator_user:operator-test-password@127.0.0.1:5432/cortex_test";
const ISSUER = "https://cortex.example.test";

function mutationArguments(prefix) {
  return [
    ...prefix,
    "--actor",
    "security-operator",
    "--reason",
    "requested incident response"
  ];
}

function grantFixture(overrides = {}) {
  return {
    sid: SID,
    issuer: ISSUER,
    subject: "test-user",
    bindingId: BINDING_ID,
    agentExternalId: "agent-a",
    clientId: "chatgpt-client",
    resource: `${ISSUER}/mcp`,
    scopes: ["cortex:read", "mcp"],
    status: "active",
    currentRefreshGeneration: 2,
    inactivityExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
    refreshedAt: new Date("2026-08-29T00:00:00.000Z"),
    revokedAt: null,
    revokedReason: null,
    supersededBy: null,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    ...overrides
  };
}

function rolloutFixture(overrides = {}) {
  return {
    stateVersion: "legacy-oauth-state-v1",
    stateOutcome: "imported",
    stateStartedAt: new Date("2026-08-28T00:00:00.000Z"),
    stateCompletedAt: new Date("2026-08-28T00:00:01.000Z"),
    stateReport: { codesImported: 1, clientsImported: 1 },
    principalCount: 2,
    activeBindingCount: 2,
    activeClientCount: 1,
    activeGrantCount: 1,
    ...overrides
  };
}

function fakeStore(overrides = {}) {
  return {
    async close() {},
    async listRedactedGrants() {
      return { grants: [grantFixture()], truncated: false };
    },
    async revokeGrant() {
      return { matched: true, changed: true, sid: SID };
    },
    async revokePrincipal() {
      return { matched: true, changed: true, grantCount: 2, codeCount: 1 };
    },
    async disablePrincipal() {
      return { matched: true, changed: true, grantCount: 2, codeCount: 1, sessionCount: 1 };
    },
    async disableBinding() {
      return {
        matched: true,
        changed: true,
        bindingId: BINDING_ID,
        grantCount: 1,
        codeCount: 1
      };
    },
    async securityLogout() {
      return {
        matched: true,
        changed: true,
        authenticationEpoch: 4,
        grantCount: 2,
        codeCount: 1,
        sessionCount: 1
      };
    },
    async getRolloutStatus() {
      return rolloutFixture();
    },
    async invalidateIssuer() {
      return {
        matched: true,
        changed: true,
        principalCount: 2,
        grantCount: 3,
        codeCount: 2,
        sessionCount: 2
      };
    },
    ...overrides
  };
}

function captureStream() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read() { return value; }
  };
}

test("parseAdminCommand returns every approved command without its format flag", () => {
  assert.deepEqual(
    parseAdminCommand([
      "--json",
      "grants",
      "list",
      "--status",
      "active",
      "--agent",
      "agent-a",
      "--issuer",
      ISSUER,
      "--subject",
      "test-user",
      "--client-id",
      "chatgpt-client",
      "--limit",
      "25"
    ]),
    {
      kind: "grants.list",
      filter: {
        issuer: ISSUER,
        subject: "test-user",
        clientId: "chatgpt-client",
        agentExternalId: "agent-a",
        status: "active",
        limit: 25
      }
    }
  );
  assert.deepEqual(parseAdminCommand(["grants", "list"]), {
    kind: "grants.list",
    filter: {
      issuer: null,
      subject: null,
      clientId: null,
      agentExternalId: null,
      status: null,
      limit: 100
    }
  });
  assert.deepEqual(
    parseAdminCommand(mutationArguments(["grants", "revoke", "--sid", SID])),
    {
      kind: "grants.revoke",
      sid: SID,
      actor: "security-operator",
      reason: "requested incident response"
    }
  );

  const principalExpectations = new Map([
    ["revoke-all", "principals.revokeAll"],
    ["disable", "principals.disable"],
    ["security-logout", "principals.securityLogout"]
  ]);
  for (const [action, kind] of principalExpectations) {
    assert.deepEqual(
      parseAdminCommand(mutationArguments([
        "principals",
        action,
        "--subject",
        "test-user",
        "--issuer",
        ISSUER
      ])),
      {
        kind,
        issuer: ISSUER,
        subject: "test-user",
        actor: "security-operator",
        reason: "requested incident response"
      }
    );
  }

  assert.deepEqual(
    parseAdminCommand(mutationArguments([
      "bindings",
      "disable",
      "--binding-id",
      BINDING_ID
    ])),
    {
      kind: "bindings.disable",
      bindingId: BINDING_ID,
      actor: "security-operator",
      reason: "requested incident response"
    }
  );
  assert.deepEqual(parseAdminCommand(["rollout", "status", "--json"]), {
    kind: "rollout.status"
  });
  assert.deepEqual(
    parseAdminCommand(mutationArguments([
      "recovery",
      "invalidate-issuer",
      "--confirmation",
      ISSUER,
      "--issuer",
      ISSUER
    ])),
    {
      kind: "recovery.invalidateIssuer",
      issuer: ISSUER,
      actor: "security-operator",
      reason: "requested incident response",
      confirmation: ISSUER
    }
  );
});

test("parseAdminCommand rejects ambiguous, incomplete, and unsafe input", () => {
  const invalidCommands = [
    [],
    ["grants", "list", "extra"],
    ["grants", "list", "--json", "--json"],
    ["grants", "list", "--status", "disabled"],
    ["grants", "list", "--limit", "0"],
    ["grants", "list", "--limit", "501"],
    ["grants", "list", "--issuer", ` ${ISSUER}`],
    ["grants", "revoke", "--sid", SID, "--actor", "operator"],
    mutationArguments(["grants", "revoke", "--sid", SID, "--sid", SID]),
    mutationArguments([
      "grants",
      "revoke",
      "--sid",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    ]),
    mutationArguments(["grants", "revoke", "--sid", SID, "--unknown", "value"]),
    mutationArguments(["grants", "revoke", "--sid", SID, "--actor"]),
    [
      "principals",
      "disable",
      "--issuer",
      ISSUER,
      "--subject",
      "test-user",
      "--actor",
      "bad\nactor",
      "--reason",
      "reason"
    ],
    [
      "recovery",
      "invalidate-issuer",
      "--issuer",
      ISSUER,
      "--confirmation",
      `${ISSUER}/other`,
      "--actor",
      "operator",
      "--reason",
      "reason"
    ],
    ["rollout", "status", "--actor", "operator"]
  ];
  for (const argv of invalidCommands) {
    assert.throws(() => parseAdminCommand(argv), OAuthAdminUsageError, argv.join(" "));
  }

  assert.throws(
    () => parseAdminCommand([
      "grants",
      "revoke",
      "--sid",
      SID,
      "--actor",
      "a".repeat(257),
      "--reason",
      "reason"
    ]),
    OAuthAdminUsageError
  );
  assert.throws(
    () => parseAdminCommand([
      "grants",
      "revoke",
      "--sid",
      SID,
      "--actor",
      "operator",
      "--reason",
      "😀".repeat(1_024)
    ]),
    OAuthAdminUsageError
  );
  assert.throws(
    () => parseAdminCommand([
      "grants",
      "revoke",
      "--sid",
      SID,
      "--actor",
      "operator",
      "--reason",
      "r".repeat(1_025)
    ]),
    OAuthAdminUsageError
  );
});

test("operator database URL validation fixes the role and strips credentials from failures", () => {
  assert.deepEqual(validateOperatorDatabaseUrl(OPERATOR_URL), { database: "cortex_test" });
  assert.deepEqual(
    validateOperatorDatabaseUrl(
      "postgres://cortex_oauth_operator_user:p%2Fword@db.example.test/cortex?sslmode=verify-full"
    ),
    { database: "cortex" }
  );

  const passwordCanary = "operator-url-canary";
  const invalidUrls = [
    undefined,
    `postgresql://cortex_oauth_gateway:${passwordCanary}@localhost/cortex`,
    `postgresql://cortex_oauth_operator_user:${passwordCanary}@localhost/cortex?sslmode=disable`,
    `postgresql://cortex_oauth_operator_user:${passwordCanary}@localhost/cortex#fragment`,
    "postgresql://cortex_oauth_operator_user@localhost/cortex",
    `postgresql://cortex_oauth_operator_user:${passwordCanary}@localhost/one/two`,
    `https://cortex_oauth_operator_user:${passwordCanary}@localhost/cortex`
  ];
  for (const value of invalidUrls) {
    assert.throws(
      () => validateOperatorDatabaseUrl(value),
      (error) => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message.includes(passwordCanary), false);
        assert.equal(error.message.includes("fixed-role PostgreSQL URL"), true);
        return true;
      }
    );
  }
});

test("runAdminCommand dispatches every command and returns allowlisted stable results", async () => {
  const calls = [];
  const store = fakeStore({
    async listRedactedGrants(input) {
      calls.push(["listRedactedGrants", input]);
      return { grants: [grantFixture()], truncated: false };
    },
    async revokeGrant(input) {
      calls.push(["revokeGrant", input]);
      return { matched: true, changed: true, sid: SID, ignored: "secret" };
    },
    async revokePrincipal(input) {
      calls.push(["revokePrincipal", input]);
      return { matched: true, changed: true, grantCount: 2, codeCount: 1 };
    },
    async disablePrincipal(input) {
      calls.push(["disablePrincipal", input]);
      return { matched: true, changed: true, grantCount: 2, codeCount: 1, sessionCount: 1 };
    },
    async disableBinding(input) {
      calls.push(["disableBinding", input]);
      return {
        matched: true,
        changed: true,
        bindingId: BINDING_ID,
        grantCount: 1,
        codeCount: 1
      };
    },
    async securityLogout(input) {
      calls.push(["securityLogout", input]);
      return {
        matched: true,
        changed: true,
        authenticationEpoch: 4,
        grantCount: 2,
        codeCount: 1,
        sessionCount: 1
      };
    },
    async getRolloutStatus() {
      calls.push(["getRolloutStatus"]);
      return rolloutFixture();
    },
    async invalidateIssuer(input) {
      calls.push(["invalidateIssuer", input]);
      return {
        matched: true,
        changed: true,
        principalCount: 2,
        grantCount: 3,
        codeCount: 2,
        sessionCount: 2
      };
    }
  });

  const commands = [
    parseAdminCommand(["grants", "list"]),
    parseAdminCommand(mutationArguments(["grants", "revoke", "--sid", SID])),
    parseAdminCommand(mutationArguments([
      "principals", "revoke-all", "--issuer", ISSUER, "--subject", "test-user"
    ])),
    parseAdminCommand(mutationArguments([
      "principals", "disable", "--issuer", ISSUER, "--subject", "test-user"
    ])),
    parseAdminCommand(mutationArguments([
      "principals", "security-logout", "--issuer", ISSUER, "--subject", "test-user"
    ])),
    parseAdminCommand(mutationArguments(["bindings", "disable", "--binding-id", BINDING_ID])),
    parseAdminCommand(["rollout", "status"]),
    parseAdminCommand(mutationArguments([
      "recovery", "invalidate-issuer", "--issuer", ISSUER, "--confirmation", ISSUER
    ]))
  ];
  const results = [];
  for (const command of commands) results.push(await runAdminCommand(store, command));

  assert.deepEqual(results[0], {
    kind: "grants.list",
    grants: [{
      ...grantFixture(),
      inactivityExpiresAt: "2026-09-01T00:00:00.000Z",
      refreshedAt: "2026-08-29T00:00:00.000Z",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z"
    }],
    truncated: false
  });
  assert.deepEqual(results.slice(1), [
    { kind: "grants.revoke", matched: true, changed: true, sid: SID },
    {
      kind: "principals.revokeAll",
      matched: true,
      changed: true,
      grantCount: 2,
      codeCount: 1
    },
    {
      kind: "principals.disable",
      matched: true,
      changed: true,
      grantCount: 2,
      codeCount: 1,
      sessionCount: 1
    },
    {
      kind: "principals.securityLogout",
      matched: true,
      changed: true,
      authenticationEpoch: 4,
      grantCount: 2,
      codeCount: 1,
      sessionCount: 1
    },
    {
      kind: "bindings.disable",
      matched: true,
      changed: true,
      bindingId: BINDING_ID,
      grantCount: 1,
      codeCount: 1
    },
    {
      kind: "rollout.status",
      status: {
        stateVersion: "legacy-oauth-state-v1",
        stateOutcome: "imported",
        stateStartedAt: "2026-08-28T00:00:00.000Z",
        stateCompletedAt: "2026-08-28T00:00:01.000Z",
        stateReport: { clientsImported: 1, codesImported: 1 },
        principalCount: 2,
        activeBindingCount: 2,
        activeClientCount: 1,
        activeGrantCount: 1
      }
    },
    {
      kind: "recovery.invalidateIssuer",
      matched: true,
      changed: true,
      principalCount: 2,
      grantCount: 3,
      codeCount: 2,
      sessionCount: 2
    }
  ]);
  assert.deepEqual(calls.map(([name]) => name), [
    "listRedactedGrants",
    "revokeGrant",
    "revokePrincipal",
    "disablePrincipal",
    "securityLogout",
    "disableBinding",
    "getRolloutStatus",
    "invalidateIssuer"
  ]);
  assert.equal(JSON.stringify(results).includes("ignored"), false);
  assert.equal(JSON.stringify(results).includes("security-operator"), false);
  assert.equal(JSON.stringify(results).includes("requested incident response"), false);
  assert.equal(results.every(Object.isFrozen), true);
});

test("runAdminCommand rejects malformed store output with a generic error", async () => {
  const rawCanary = "raw-store-canary";
  await assert.rejects(
    runAdminCommand(fakeStore({
      async revokeGrant() {
        return { matched: true, changed: true, sid: rawCanary };
      }
    }), parseAdminCommand(mutationArguments(["grants", "revoke", "--sid", SID]))),
    (error) => {
      assert.equal(error instanceof OAuthAdminUnavailableError, true);
      assert.equal(error.message, "OAuth administration failed");
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes(rawCanary), false);
      return true;
    }
  );
});

test("formatAdminResult is deterministic and escapes terminal control input", async () => {
  const hostileReason = "operator\u001b[31m\u009breason\u009dtitle\u202espoof";
  const result = await runAdminCommand(
    fakeStore({
      async listRedactedGrants() {
        return {
          grants: [grantFixture({
            status: "revoked",
            revokedAt: new Date("2026-08-29T01:00:00.000Z"),
            revokedReason: hostileReason
          })],
          truncated: false
        };
      }
    }),
    parseAdminCommand(["grants", "list"])
  );
  const compact = formatAdminResult(result, true);
  const human = formatAdminResult(result, false);
  assert.deepEqual(JSON.parse(compact), result);
  assert.deepEqual(JSON.parse(human.slice(human.indexOf("\n") + 1)), result);
  assert.equal(compact, formatAdminResult(result, true));
  assert.equal(human, formatAdminResult(result, false));
  assert.equal(human.startsWith("OAuth administration result\n{\n"), true);
  for (const [raw, escaped] of [
    ["\u001b", "\\u001b"],
    ["\u009b", "\\u009b"],
    ["\u009d", "\\u009d"],
    ["\u202e", "\\u202e"]
  ]) {
    assert.equal(compact.includes(raw), false);
    assert.equal(human.includes(raw), false);
    assert.equal(compact.includes(escaped), true);
    assert.equal(human.includes(escaped), true);
  }
});

test("runAdminCli validates before connecting and emits stable success output", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  let openedWith = null;
  let closed = false;
  const code = await runAdminCli({
    argv: ["rollout", "status", "--json"],
    env: { MCP_OAUTH_OPERATOR_DATABASE_URL: OPERATOR_URL },
    stdout: stdout.stream,
    stderr: stderr.stream,
    openStore: async (options) => {
      openedWith = options;
      return fakeStore({ async close() { closed = true; } });
    }
  });
  assert.equal(code, 0);
  assert.deepEqual(openedWith, { databaseUrl: OPERATOR_URL });
  assert.equal(closed, true);
  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(stdout.read()), {
    kind: "rollout.status",
    status: {
      stateVersion: "legacy-oauth-state-v1",
      stateOutcome: "imported",
      stateStartedAt: "2026-08-28T00:00:00.000Z",
      stateCompletedAt: "2026-08-28T00:00:01.000Z",
      stateReport: { clientsImported: 1, codesImported: 1 },
      principalCount: 2,
      activeBindingCount: 2,
      activeClientCount: 1,
      activeGrantCount: 1
    }
  });
  assert.equal(stdout.read().includes("operator-test-password"), false);
});

test("runAdminCli ignores broader database URLs and never echoes secrets", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  let opened = false;
  const secret = "broad-database-secret";
  const code = await runAdminCli({
    argv: ["rollout", "status"],
    env: {
      DATABASE_URL: `postgresql://owner:${secret}@localhost/cortex`,
      MCP_OAUTH_DATABASE_URL: `postgresql://cortex_oauth_gateway:${secret}@localhost/cortex`
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    openStore: async () => {
      opened = true;
      return fakeStore();
    }
  });
  assert.equal(code, 1);
  assert.equal(opened, false);
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), "OAuth administration failed\n");
  assert.equal(stderr.read().includes(secret), false);
});

test("runAdminCli confirmation errors cannot open the operator connection", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  let opened = false;
  const code = await runAdminCli({
    argv: mutationArguments([
      "recovery",
      "invalidate-issuer",
      "--issuer",
      ISSUER,
      "--confirmation",
      `${ISSUER}/wrong`,
      "--json"
    ]),
    env: { MCP_OAUTH_OPERATOR_DATABASE_URL: OPERATOR_URL },
    stdout: stdout.stream,
    stderr: stderr.stream,
    openStore: async () => {
      opened = true;
      return fakeStore();
    }
  });
  assert.equal(code, 2);
  assert.equal(opened, false);
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), '{"error":"invalid_command"}\n');
});

test("runAdminCli returns distinct no-match status and closes its store", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  let closed = false;
  const code = await runAdminCli({
    argv: [...mutationArguments(["grants", "revoke", "--sid", SID]), "--json"],
    env: { MCP_OAUTH_OPERATOR_DATABASE_URL: OPERATOR_URL },
    stdout: stdout.stream,
    stderr: stderr.stream,
    openStore: async () => fakeStore({
      async revokeGrant() {
        return { matched: false, changed: false, sid: null };
      },
      async close() { closed = true; }
    })
  });
  assert.equal(code, 3);
  assert.equal(closed, true);
  assert.equal(stderr.read(), "");
  assert.deepEqual(JSON.parse(stdout.read()), {
    kind: "grants.revoke",
    matched: false,
    changed: false,
    sid: null
  });
});

test("runAdminCli suppresses store and close error details", async () => {
  for (const mode of ["command", "close"]) {
    const stdout = captureStream();
    const stderr = captureStream();
    const secret = `${mode}-failure-canary`;
    const code = await runAdminCli({
      argv: ["rollout", "status", "--json"],
      env: { MCP_OAUTH_OPERATOR_DATABASE_URL: OPERATOR_URL },
      stdout: stdout.stream,
      stderr: stderr.stream,
      openStore: async () => fakeStore({
        async getRolloutStatus() {
          if (mode === "command") throw new Error(secret);
          return rolloutFixture();
        },
        async close() {
          if (mode === "close") throw new Error(secret);
        }
      })
    });
    assert.equal(code, 1);
    assert.equal(stdout.read(), "");
    assert.equal(stderr.read(), '{"error":"admin_failed"}\n');
    assert.equal(stderr.read().includes(secret), false);
  }
});

test("runAdminCli uses fixed usage text without reflecting invalid argv", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const argvCanary = "argv-secret-canary";
  const code = await runAdminCli({
    argv: ["unknown", argvCanary],
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    openStore: async () => {
      assert.fail("invalid commands must not open a store");
    }
  });
  assert.equal(code, 2);
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), `${ADMIN_USAGE}\n`);
  assert.equal(stderr.read().includes(argvCanary), false);
});
