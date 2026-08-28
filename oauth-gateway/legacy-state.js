import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";

const LEGACY_STATE_VERSION = 1;
const MAX_LEGACY_STATE_BYTES = 16 * 1024 * 1024;
const MAX_DYNAMIC_CLIENTS = 1_000;
const MAX_AUTHORIZATION_CODES = 1_000;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 255;
const MAX_RESOURCE_LENGTH = 2_048;
const MAX_JSON_DEPTH = 16;

const DYNAMIC_CLIENT_ID_PATTERN = /^chatgpt-[A-Za-z0-9_-]{24}$/;
const AUTHORIZATION_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONNECTOR_REDIRECT_PATTERN = /^\/connector\/oauth\/[A-Za-z0-9_-]+$/;
const SUPPORTED_SCOPES = new Set(["cortex:read", "cortex:write", "mcp"]);

const TOP_LEVEL_KEYS = ["version", "clients", "codes"];
const CLIENT_KEYS = ["client_id", "redirect_uris", "client_name", "created_at"];
const CODE_KEYS = [
  "code",
  "client_id",
  "redirect_uri",
  "scope",
  "code_challenge",
  "resource",
  "sub",
  "expires_at"
];

class LegacyStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegacyStateError";
  }
}

function invalidState() {
  throw new LegacyStateError("Legacy OAuth state is invalid");
}

function invalidStateFile() {
  throw new LegacyStateError("Legacy OAuth state file is invalid");
}

function unreadableStateFile() {
  throw new LegacyStateError("Legacy OAuth state file could not be read");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedString(value, maximumLength, { nonempty = true } = {}) {
  return (
    typeof value === "string" &&
    (!nonempty || value.length > 0) &&
    value.length <= maximumLength
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validChatGptRedirect(value) {
  if (!boundedString(value, MAX_REDIRECT_URI_LENGTH) || /[?#]/.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === "https://chatgpt.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      `${parsed.origin}${parsed.pathname}` === value &&
      (
        parsed.pathname === "/connector_platform_oauth_redirect" ||
        CONNECTOR_REDIRECT_PATTERN.test(parsed.pathname)
      )
    );
  } catch {
    return false;
  }
}

function validResource(value) {
  if (!boundedString(value, MAX_RESOURCE_LENGTH) || /[?#]/.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return false;
    }

    const canonicalWithoutTrailingSlash = parsed.toString().replace(/\/$/, "");
    return (
      value === canonicalWithoutTrailingSlash ||
      value === `${canonicalWithoutTrailingSlash}/`
    );
  } catch {
    return false;
  }
}

function validCanonicalScope(value) {
  if (!boundedString(value, 512)) return false;
  const scopes = value.split(" ");
  return (
    scopes.length > 0 &&
    scopes.every((scope) => scope.length > 0 && SUPPORTED_SCOPES.has(scope)) &&
    new Set(scopes).size === scopes.length &&
    scopes.join(" ") === value
  );
}

// JSON.parse intentionally implements last-key-wins. The v1 import boundary
// must instead reject duplicate members, including escaped spellings of the
// same member name, before exact-shape validation.
function assertNoDuplicateJsonMembers(source) {
  let offset = 0;

  function skipWhitespace() {
    while (/[\t\n\r ]/.test(source[offset] ?? "")) offset += 1;
  }

  function readString() {
    if (source[offset] !== '"') invalidState();
    const start = offset;
    offset += 1;

    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset));
        } catch {
          invalidState();
        }
      }

      if (character === "\\") {
        offset += 1;
        if (source[offset] === "u") {
          if (!/^[0-9A-Fa-f]{4}$/.test(source.slice(offset + 1, offset + 5))) {
            invalidState();
          }
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(source[offset] ?? "")) invalidState();
      } else if (character.charCodeAt(0) <= 0x1f) {
        invalidState();
      }
      offset += 1;
    }

    invalidState();
  }

  function readPrimitive() {
    const remainder = source.slice(offset);
    const token = remainder.match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)?.[0];
    if (!token) invalidState();
    offset += token.length;
  }

  function readValue(depth) {
    if (depth > MAX_JSON_DEPTH) invalidState();
    skipWhitespace();

    if (source[offset] === "{") {
      readObject(depth + 1);
    } else if (source[offset] === "[") {
      readArray(depth + 1);
    } else if (source[offset] === '"') {
      readString();
    } else {
      readPrimitive();
    }
  }

  function readObject(depth) {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }

    const keys = new Set();
    while (offset < source.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) invalidState();
      keys.add(key);

      skipWhitespace();
      if (source[offset] !== ":") invalidState();
      offset += 1;
      readValue(depth);
      skipWhitespace();

      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      if (source[offset] !== ",") invalidState();
      offset += 1;
    }

    invalidState();
  }

  function readArray(depth) {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }

    while (offset < source.length) {
      readValue(depth);
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      if (source[offset] !== ",") invalidState();
      offset += 1;
    }

    invalidState();
  }

  readValue(0);
  skipWhitespace();
  if (offset !== source.length) invalidState();
}

function validateClient(client) {
  return (
    hasExactKeys(client, CLIENT_KEYS) &&
    DYNAMIC_CLIENT_ID_PATTERN.test(client.client_id) &&
    Array.isArray(client.redirect_uris) &&
    client.redirect_uris.length > 0 &&
    client.redirect_uris.length <= MAX_REDIRECT_URIS &&
    client.redirect_uris.every(validChatGptRedirect) &&
    new Set(client.redirect_uris).size === client.redirect_uris.length &&
    boundedString(client.client_name, MAX_CLIENT_NAME_LENGTH) &&
    client.client_name.trim() === client.client_name &&
    Number.isSafeInteger(client.created_at) &&
    client.created_at > 0
  );
}

function configuredStaticClientMap(clients) {
  if (!Array.isArray(clients) || clients.length > 32) invalidState();
  const result = new Map();
  for (const client of clients) {
    if (
      client === null ||
      typeof client !== "object" ||
      Array.isArray(client) ||
      !boundedString(client.clientId, 512) ||
      !Array.isArray(client.redirectUris) ||
      client.redirectUris.length < 1 ||
      client.redirectUris.length > MAX_REDIRECT_URIS ||
      new Set(client.redirectUris).size !== client.redirectUris.length ||
      client.redirectUris.some((uri) => !boundedString(uri, MAX_REDIRECT_URI_LENGTH)) ||
      result.has(client.clientId)
    ) {
      invalidState();
    }
    result.set(client.clientId, new Set(client.redirectUris));
  }
  return result;
}

function validateCode(code, clientsById, staticClientsById) {
  if (
    !hasExactKeys(code, CODE_KEYS) ||
    !AUTHORIZATION_CODE_PATTERN.test(code.code) ||
    !DYNAMIC_CLIENT_ID_PATTERN.test(code.client_id) ||
    !validChatGptRedirect(code.redirect_uri) ||
    !validCanonicalScope(code.scope) ||
    !PKCE_CHALLENGE_PATTERN.test(code.code_challenge) ||
    !validResource(code.resource) ||
    !boundedString(code.sub, MAX_SUBJECT_LENGTH) ||
    !Number.isSafeInteger(code.expires_at) ||
    code.expires_at <= 0
  ) {
    return false;
  }

  const client = clientsById.get(code.client_id);
  return Boolean(
    client?.redirect_uris.includes(code.redirect_uri) ||
    staticClientsById.get(code.client_id)?.has(code.redirect_uri)
  );
}

/**
 * Parse a frozen v1 OAuth state snapshot without discarding expired codes.
 * The importer owns time-based reporting and selection.
 */
export function parseLegacyState(bytes, staticClients = []) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_LEGACY_STATE_BYTES) {
    invalidState();
  }

  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    invalidState();
  }

  let source;
  let parsed;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidState();
  }

  // Bound nesting and reject duplicate members before JSON.parse can allocate
  // an attacker-controlled deeply nested object graph.
  assertNoDuplicateJsonMembers(source);

  try {
    parsed = JSON.parse(source);
  } catch {
    invalidState();
  }

  if (
    !hasExactKeys(parsed, TOP_LEVEL_KEYS) ||
    parsed.version !== LEGACY_STATE_VERSION ||
    !Array.isArray(parsed.clients) ||
    !Array.isArray(parsed.codes) ||
    parsed.clients.length > MAX_DYNAMIC_CLIENTS ||
    parsed.codes.length > MAX_AUTHORIZATION_CODES
  ) {
    invalidState();
  }

  const clientsById = new Map();
  const staticClientsById = configuredStaticClientMap(staticClients);
  for (const client of parsed.clients) {
    if (
      !validateClient(client) ||
      clientsById.has(client.client_id) ||
      staticClientsById.has(client.client_id)
    ) invalidState();
    clientsById.set(client.client_id, client);
  }

  const rawCodes = new Set();
  for (const code of parsed.codes) {
    if (
      !validateCode(code, clientsById, staticClientsById) ||
      rawCodes.has(code.code)
    ) invalidState();
    rawCodes.add(code.code);
  }

  return deepFreeze(parsed);
}

export function checksumLegacyState(bytes) {
  if (!(bytes instanceof Uint8Array)) invalidState();
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function validateLegacyStateFile(stat) {
  const modeIsValid =
    (typeof stat?.mode === "number" &&
      Number.isSafeInteger(stat.mode) &&
      (stat.mode & 0o7777) === 0o600) ||
    (typeof stat?.mode === "bigint" && (stat.mode & 0o7777n) === 0o600n);
  const sizeIsValid =
    (typeof stat?.size === "number" &&
      Number.isSafeInteger(stat.size) &&
      stat.size >= 0 &&
      stat.size <= MAX_LEGACY_STATE_BYTES) ||
    (typeof stat?.size === "bigint" &&
      stat.size >= 0n &&
      stat.size <= BigInt(MAX_LEGACY_STATE_BYTES));

  if (
    stat === null ||
    typeof stat !== "object" ||
    typeof stat.isFile !== "function" ||
    !stat.isFile() ||
    !modeIsValid ||
    !sizeIsValid
  ) {
    invalidStateFile();
  }
}

async function readExactSnapshot(handle, expectedSize) {
  const allocation = Buffer.allocUnsafe(expectedSize + 1);
  let bytesRead = 0;

  while (bytesRead < allocation.length) {
    const result = await handle.read(
      allocation,
      bytesRead,
      allocation.length - bytesRead,
      null
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }

  if (bytesRead !== expectedSize) invalidStateFile();
  return new Uint8Array(allocation.subarray(0, bytesRead));
}

export async function readLegacyState(path, staticClients = []) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
    const before = await handle.stat({ bigint: true });
    validateLegacyStateFile(before);
    const bytes = await readExactSnapshot(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });

    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      invalidStateFile();
    }

    return { bytes, state: parseLegacyState(bytes, staticClients) };
  } catch (error) {
    if (error instanceof LegacyStateError) throw error;
    unreadableStateFile();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The primary result is authoritative; close errors contain no useful
        // information for callers and must never expose a source path.
      }
    }
  }
}
