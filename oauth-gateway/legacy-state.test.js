import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  checksumLegacyState,
  parseLegacyState,
  readLegacyState,
  validateLegacyStateFile
} from "./legacy-state.js";

const CLIENT_ID = `chatgpt-${"A".repeat(24)}`;
const STABLE_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CONNECTOR_REDIRECT = "https://chatgpt.com/connector/oauth/cortex_test-1";
const RESOURCE = "https://cortex.example.test/mcp";
const SECRET_CANARY = "raw-code-secret-canary";
const MAX_STATE_BYTES = 16 * 1024 * 1024;

let fixtureDirectory;

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "cortex-legacy-state-"));
});

after(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

function validState(overrides = {}) {
  return {
    version: 1,
    clients: [
      {
        client_id: CLIENT_ID,
        redirect_uris: [STABLE_REDIRECT, CONNECTOR_REDIRECT],
        client_name: "ChatGPT",
        created_at: 1_700_000_000
      }
    ],
    codes: [
      {
        code: "C".repeat(43),
        client_id: CLIENT_ID,
        redirect_uri: STABLE_REDIRECT,
        scope: "cortex:read cortex:write mcp",
        code_challenge: "P".repeat(43),
        resource: RESOURCE,
        sub: "test-user",
        expires_at: 1_900_000_000_000
      }
    ],
    ...overrides
  };
}

function bytesFor(state) {
  return new TextEncoder().encode(`${JSON.stringify(state)}\n`);
}

function rejectsState(state) {
  assert.throws(
    () => parseLegacyState(bytesFor(state)),
    (error) => error?.name === "LegacyStateError" && error.message === "Legacy OAuth state is invalid"
  );
}

test("parses the exact production-shaped v1 ChatGPT state", () => {
  const expiredCode = {
    ...validState().codes[0],
    code: "D".repeat(43),
    redirect_uri: CONNECTOR_REDIRECT,
    scope: "mcp cortex:write cortex:read",
    resource: "https://cortex.example.test",
    expires_at: 1
  };
  const baseSlashCode = {
    ...validState().codes[0],
    code: "E".repeat(43),
    scope: "mcp",
    resource: "https://cortex.example.test/"
  };
  const state = validState({ codes: [...validState().codes, expiredCode, baseSlashCode] });

  const parsed = parseLegacyState(bytesFor(state));

  assert.deepEqual(parsed, state);
  assert.equal(parsed.codes[1].expires_at, 1, "expired code must remain available to import reporting");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.clients));
  assert.ok(Object.isFrozen(parsed.clients[0]));
  assert.ok(Object.isFrozen(parsed.clients[0].redirect_uris));
  assert.ok(Object.isFrozen(parsed.codes));
  assert.ok(Object.isFrozen(parsed.codes[0]));
});

test("rejects unknown missing duplicate and mistyped JSON members", () => {
  rejectsState({ ...validState(), unknown: true });
  rejectsState({ ...validState(), clients: null });
  rejectsState({ ...validState(), codes: {} });

  const missingVersion = validState();
  delete missingVersion.version;
  rejectsState(missingVersion);

  rejectsState({ ...validState(), version: "1" });

  const extraClientKey = validState();
  extraClientKey.clients[0].client_secret = SECRET_CANARY;
  rejectsState(extraClientKey);

  const mistypedRedirects = validState();
  mistypedRedirects.clients[0].redirect_uris = STABLE_REDIRECT;
  rejectsState(mistypedRedirects);

  for (const clientName of ["", " ChatGPT", "ChatGPT "]) {
    const invalidName = validState();
    invalidName.clients[0].client_name = clientName;
    rejectsState(invalidName);
  }

  const missingCodeKey = validState();
  delete missingCodeKey.codes[0].sub;
  rejectsState(missingCodeKey);

  assert.throws(
    () => parseLegacyState(new TextEncoder().encode('{"version":1,"\\u0076ersion":1,"clients":[],"codes":[]}')),
    { name: "LegacyStateError", message: "Legacy OAuth state is invalid" }
  );
});

test("rejects duplicate client IDs raw codes and conflicting code references", () => {
  const duplicateClient = validState();
  duplicateClient.clients.push({ ...duplicateClient.clients[0] });
  rejectsState(duplicateClient);

  const duplicateCode = validState();
  duplicateCode.codes.push({ ...duplicateCode.codes[0] });
  rejectsState(duplicateCode);

  const unknownClient = validState();
  unknownClient.codes[0].client_id = `chatgpt-${"B".repeat(24)}`;
  rejectsState(unknownClient);

  const wrongRegisteredRedirect = validState();
  wrongRegisteredRedirect.clients[0].redirect_uris = [STABLE_REDIRECT];
  wrongRegisteredRedirect.codes[0].redirect_uri = CONNECTOR_REDIRECT;
  rejectsState(wrongRegisteredRedirect);
});

test("rejects non-ChatGPT redirects and duplicate or raw-delimiter callbacks", () => {
  for (const redirect of [
    "https://evil.example/connector_platform_oauth_redirect",
    `${STABLE_REDIRECT}?`,
    `${STABLE_REDIRECT}#`,
    "https://chatgpt.com/connector/oauth/",
    "https://CHATGPT.com/connector_platform_oauth_redirect"
  ]) {
    const state = validState();
    state.clients[0].redirect_uris = [redirect];
    state.codes = [];
    rejectsState(state);
  }

  const duplicateRedirect = validState();
  duplicateRedirect.clients[0].redirect_uris = [STABLE_REDIRECT, STABLE_REDIRECT];
  rejectsState(duplicateRedirect);
});

test("rejects malformed scopes PKCE resources identifiers timestamps and strings", () => {
  const mutations = [
    (state) => { state.clients[0].client_id = "chatgpt-not-issued"; state.codes = []; },
    (state) => { state.clients[0].client_name = "x".repeat(201); },
    (state) => { state.clients[0].created_at = 1.5; },
    (state) => { state.codes[0].code = "x".repeat(42); },
    (state) => { state.codes[0].scope = "cortex:read  mcp"; },
    (state) => { state.codes[0].scope = "cortex:read cortex:read"; },
    (state) => { state.codes[0].scope = "cortex:read admin"; },
    (state) => { state.codes[0].code_challenge = "x".repeat(44); },
    (state) => { state.codes[0].resource = "http://cortex.example.test/mcp"; },
    (state) => { state.codes[0].resource = "https://cortex.example.test/mcp?"; },
    (state) => { state.codes[0].sub = "x".repeat(256); },
    (state) => { state.codes[0].expires_at = 0; }
  ];

  for (const mutate of mutations) {
    const state = validState();
    mutate(state);
    rejectsState(state);
  }
});

test("enforces array byte UTF-8 and nesting bounds", () => {
  const tooManyClients = validState({ clients: [], codes: [] });
  for (let index = 0; index < 1_001; index += 1) {
    tooManyClients.clients.push({
      client_id: `chatgpt-${index.toString(36).padStart(24, "0")}`,
      redirect_uris: [STABLE_REDIRECT],
      client_name: "ChatGPT",
      created_at: 1
    });
  }
  rejectsState(tooManyClients);

  const tooManyCodes = validState({ codes: [] });
  for (let index = 0; index < 1_001; index += 1) {
    tooManyCodes.codes.push({
      ...validState().codes[0],
      code: index.toString(36).padStart(43, "0")
    });
  }
  rejectsState(tooManyCodes);

  assert.throws(
    () => parseLegacyState(new Uint8Array(MAX_STATE_BYTES + 1)),
    { name: "LegacyStateError", message: "Legacy OAuth state is invalid" }
  );
  assert.throws(
    () => parseLegacyState(Uint8Array.from([0xff, 0xfe, 0xfd])),
    { name: "LegacyStateError", message: "Legacy OAuth state is invalid" }
  );
  assert.throws(
    () => parseLegacyState(Uint8Array.from([0xef, 0xbb, 0xbf, ...bytesFor(validState())])),
    { name: "LegacyStateError", message: "Legacy OAuth state is invalid" }
  );

  let nested = "0";
  for (let index = 0; index < 18; index += 1) nested = `[${nested}]`;
  assert.throws(
    () => parseLegacyState(new TextEncoder().encode(nested)),
    { name: "LegacyStateError", message: "Legacy OAuth state is invalid" }
  );

  const adversarialDepth = 1_000_000;
  const deeplyNested = `${"[".repeat(adversarialDepth)}0${"]".repeat(adversarialDepth)}`;
  assert.throws(
    () => parseLegacyState(new TextEncoder().encode(deeplyNested)),
    { name: "LegacyStateError", message: "Legacy OAuth state is invalid" }
  );
});

test("computes SHA-256 over the exact raw bytes", () => {
  const input = new TextEncoder().encode("abc");
  const digest = checksumLegacyState(input);

  assert.ok(digest instanceof Uint8Array);
  assert.equal(
    Buffer.from(digest).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    Buffer.from(digest).toString("hex"),
    createHash("sha256").update(input).digest("hex")
  );
});

test("reads a regular mode-0600 file without changing its bytes or mode", async () => {
  const path = join(fixtureDirectory, "state.json");
  const prettySource = `${JSON.stringify(validState(), null, 2).replaceAll("\n", "\r\n")}\r\n`;
  const originalBytes = new TextEncoder().encode(prettySource);
  await writeFile(path, originalBytes, { mode: 0o600 });
  await chmod(path, 0o600);

  const result = await readLegacyState(path);

  assert.deepEqual(result.state, validState());
  assert.deepEqual(Buffer.from(result.bytes), Buffer.from(originalBytes));
  assert.deepEqual(await readFile(path), Buffer.from(originalBytes));
  const after = await lstat(path);
  assert.equal(after.mode & 0o7777, 0o600);
  assert.equal(after.size, originalBytes.byteLength);
});

test("rejects symlink non-regular insecure-mode and oversized sources", async () => {
  const targetPath = join(fixtureDirectory, "target.json");
  const symlinkPath = join(fixtureDirectory, "state-link.json");
  const directoryPath = join(fixtureDirectory, "state-directory");
  const insecurePath = join(fixtureDirectory, "state-insecure.json");
  const oversizedPath = join(fixtureDirectory, "state-oversized.json");

  await writeFile(targetPath, bytesFor(validState()), { mode: 0o600 });
  await symlink(targetPath, symlinkPath);
  await mkdir(directoryPath, { mode: 0o600 });
  await writeFile(insecurePath, bytesFor(validState()), { mode: 0o640 });
  await chmod(insecurePath, 0o640);
  await writeFile(oversizedPath, Buffer.alloc(MAX_STATE_BYTES + 1), { mode: 0o600 });

  for (const path of [symlinkPath, directoryPath, insecurePath, oversizedPath]) {
    await assert.rejects(
      readLegacyState(path),
      (error) => error?.name === "LegacyStateError" && !error.message.includes(path)
    );
  }

  await assert.rejects(
    async () => validateLegacyStateFile(await lstat(symlinkPath)),
    { name: "LegacyStateError", message: "Legacy OAuth state file is invalid" }
  );
});

test("never includes source data or paths in parser and reader errors", async () => {
  const invalidPath = join(fixtureDirectory, `${SECRET_CANARY}.json`);
  await writeFile(invalidPath, `{"secret":"${SECRET_CANARY}"}`, { mode: 0o600 });

  assert.throws(
    () => parseLegacyState(new TextEncoder().encode(`{"secret":"${SECRET_CANARY}"}`)),
    (error) => !error.message.includes(SECRET_CANARY)
  );
  await assert.rejects(
    readLegacyState(invalidPath),
    (error) => !error.message.includes(SECRET_CANARY) && !error.message.includes(invalidPath)
  );
});
