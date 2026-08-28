import { TextDecoder } from "node:util";
import { CORTEX_TOOL_NAMES } from "./chatgpt-tools.js";

/**
 * @typedef {{
 *   subject:string,
 *   sid:string,
 *   clientId:string,
 *   agentId:number,
 *   agentExternalId:string,
 *   scopes:ReadonlySet<string>
 * }} HostedAuthContext
 */

const MAX_AGENT_ID_LENGTH = 128;
const MAX_RAW_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_RAW_URL_BYTES = 16 * 1024;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const HOSTED_TOOL_NAMES = new Set(CORTEX_TOOL_NAMES);
const SELECTOR_KEYS = new Set(["agentId", "agent_id"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const HOSTED_MCP_METHODS = Object.freeze([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call"
]);
const HOSTED_MCP_METHOD_SET = new Set(HOSTED_MCP_METHODS);

function hostedRestRoute(method, pathSource, requiredScopes, agentLocation) {
  const matcher = new RegExp(pathSource);
  const policy = Object.freeze({
    method,
    // RegExp instances have mutable internal slots (including `.compile()`).
    // Return a fresh projection so exported catalog consumers can never alter
    // the private matcher used for an authorization decision.
    get path() {
      return new RegExp(pathSource);
    },
    requiredScopes: Object.freeze([...requiredScopes]),
    agentLocation
  });
  return Object.freeze({ matcher, policy });
}

const HOSTED_REST_ROUTE_DEFINITIONS = Object.freeze([
  hostedRestRoute("GET", "^/api/v1/status$", ["cortex:read"], "query"),
  hostedRestRoute("GET", "^/api/v1/graph$", ["cortex:read"], "query"),
  hostedRestRoute("GET", "^/api/v1/cognition$", ["cortex:read"], "query"),
  hostedRestRoute("GET", "^/api/v1/vitals$", ["cortex:read"], "query"),
  hostedRestRoute("GET", "^/api/v1/reconsolidate/labile$", ["cortex:read"], "query"),
  hostedRestRoute("GET", "^/api/v1/procedural$", ["cortex:read"], "query"),
  hostedRestRoute("POST", "^/api/v1/search$", ["cortex:read", "cortex:write"], "body"),
  hostedRestRoute("POST", "^/api/v1/recall$", ["cortex:read", "cortex:write"], "body"),
  hostedRestRoute("POST", "^/api/v1/ingest$", ["cortex:write"], "body"),
  hostedRestRoute("POST", "^/api/v1/reconsolidate$", ["cortex:read", "cortex:write"], "body"),
  hostedRestRoute("POST", "^/api/v1/dream$", ["cortex:read", "cortex:write"], "body"),
  hostedRestRoute("POST", "^/api/v1/procedural$", ["cortex:write"], "body"),
  hostedRestRoute("POST", "^/api/v1/procedural/retrieve$", ["cortex:read"], "body"),
  hostedRestRoute("POST", "^/api/v1/procedural/([1-9]\\d*)/execute$", ["cortex:write"], "body"),
  hostedRestRoute("PATCH", "^/api/v1/procedural/([1-9]\\d*)$", ["cortex:read", "cortex:write"], "body")
]);

export const HOSTED_REST_ROUTES = Object.freeze(
  HOSTED_REST_ROUTE_DEFINITIONS.map((definition) => definition.policy)
);

export class HostedPolicyError extends Error {
  constructor(status, code, safeDescription) {
    super(safeDescription);
    this.name = "HostedPolicyError";
    this.status = status;
    this.code = code;
    this.safeDescription = safeDescription;
  }
}

export function isHostedPolicyError(error) {
  return error instanceof HostedPolicyError;
}

function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWellFormedAgentId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_ID_LENGTH
  );
}

function invalidRequest() {
  return new HostedPolicyError(
    400,
    "invalid_request",
    "Malformed hosted request"
  );
}

function agentMismatch() {
  return new HostedPolicyError(
    403,
    "agent_mismatch",
    "Requested agent is not authorized for this connection"
  );
}

function unavailableTool() {
  return new HostedPolicyError(
    404,
    "not_found",
    "Hosted MCP tool is not available"
  );
}

function unavailableMethod() {
  return new HostedPolicyError(
    404,
    "not_found",
    "Hosted MCP method is not available"
  );
}

function unavailableRestRoute() {
  return new HostedPolicyError(
    404,
    "not_found",
    "Hosted REST route is not available"
  );
}

function policyConfigurationError() {
  return new HostedPolicyError(
    500,
    "policy_configuration_error",
    "Hosted agent binding is unavailable"
  );
}

function parseHostedRestTarget(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    Buffer.byteLength(rawUrl, "utf8") > MAX_RAW_URL_BYTES ||
    /[\u0000-\u001f\u007f]/.test(rawUrl) ||
    rawUrl.includes("#")
  ) {
    return null;
  }

  const queryOffset = rawUrl.indexOf("?");
  const rawPath = queryOffset === -1 ? rawUrl : rawUrl.slice(0, queryOffset);
  const rawQuery = queryOffset === -1 ? "" : rawUrl.slice(queryOffset + 1);
  if (
    !rawPath.startsWith("/") ||
    rawPath.includes("%") ||
    rawPath.includes("\\") ||
    rawPath.includes("//")
  ) {
    return null;
  }

  try {
    decodeURIComponent(rawQuery.replace(/\+/g, "%20"));
  } catch {
    return null;
  }

  const path = rawPath.length > 1 && rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  return Object.freeze({ path, rawQuery });
}

function validRoutePath(matcher, path) {
  const match = matcher.exec(path);
  if (!match) return false;
  if (match[1] === undefined) return true;
  const identifier = Number(match[1]);
  return Number.isSafeInteger(identifier) &&
    identifier > 0 &&
    identifier <= MAX_POSTGRES_INTEGER;
}

export function matchHostedRestRoute(method, rawUrl) {
  if (typeof method !== "string") return null;
  const target = parseHostedRestTarget(rawUrl);
  if (!target) return null;
  return HOSTED_REST_ROUTE_DEFINITIONS.find((definition) =>
    definition.policy.method === method &&
      validRoutePath(definition.matcher, target.path))?.policy ?? null;
}

export function isHostedPublicHealthRequest(method, rawUrl) {
  const target = parseHostedRestTarget(rawUrl);
  return method === "GET" && target?.path === "/api/v1/health";
}

function decodeRawJson(rawJson) {
  if (typeof rawJson === "string") {
    if (Buffer.byteLength(rawJson, "utf8") > MAX_RAW_JSON_BYTES) {
      throw invalidRequest();
    }
    return rawJson;
  }
  if (!(rawJson instanceof Uint8Array) || rawJson.byteLength > MAX_RAW_JSON_BYTES) {
    throw invalidRequest();
  }
  try {
    return UTF8_DECODER.decode(rawJson);
  } catch {
    throw invalidRequest();
  }
}

function scanJsonObjectMembers(rawJson) {
  const source = decodeRawJson(rawJson);
  const members = [];
  let offset = 0;

  const fail = () => {
    throw invalidRequest();
  };
  const skipWhitespace = () => {
    while ([" ", "\t", "\r", "\n"].includes(source[offset])) {
      offset += 1;
    }
  };
  const readString = () => {
    if (source[offset] !== '"') fail();
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset));
        } catch {
          fail();
        }
      }
      if (code < 0x20) fail();
      if (character !== "\\") {
        offset += 1;
        continue;
      }

      offset += 1;
      const escape = source[offset];
      if (["\"", "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
        offset += 1;
        continue;
      }
      if (escape !== "u" || !/^[0-9a-fA-F]{4}$/.test(source.slice(offset + 1, offset + 5))) {
        fail();
      }
      offset += 5;
    }
    fail();
  };

  const parseValue = (path, depth) => {
    if (depth > MAX_JSON_DEPTH) fail();
    skipWhitespace();
    const character = source[offset];

    if (character === "{") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        const name = readString();
        skipWhitespace();
        if (source[offset] !== ":") fail();
        offset += 1;
        members.push(Object.freeze({ path: Object.freeze([...path]), name }));
        parseValue([...path, name], depth + 1);
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail();
        offset += 1;
        skipWhitespace();
      }
      fail();
    }

    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < source.length) {
        parseValue([...path, "*"], depth + 1);
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") fail();
        offset += 1;
      }
      fail();
    }

    if (character === '"') {
      readString();
      return;
    }

    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }

    const number = source.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) fail();
    offset += number[0].length;
  };

  skipWhitespace();
  parseValue([], 0);
  skipWhitespace();
  if (offset !== source.length) fail();
  return Object.freeze({ source, members: Object.freeze(members) });
}

function pathEquals(left, right) {
  return left.length === right.length &&
    left.every((component, index) => component === right[index]);
}

function memberNamesAt(scan, objectPath) {
  return scan.members
    .filter((member) => pathEquals(member.path, objectPath))
    .map((member) => member.name);
}

/**
 * Return decoded member names, including duplicates, for every object found at
 * one exact JSON path. Array traversal is represented internally by `*`.
 */
export function scanTopLevelJsonMemberNames(rawJson, objectPath = []) {
  if (!Array.isArray(objectPath) ||
    objectPath.some((component) => typeof component !== "string")) {
    throw invalidRequest();
  }
  return Object.freeze(memberNamesAt(scanJsonObjectMembers(rawJson), objectPath));
}

function parsedValueAt(message, objectPath, name) {
  let current = message;
  for (const component of objectPath) {
    if (!isObjectRecord(current)) return undefined;
    current = current[component];
  }
  return isObjectRecord(current) ? current[name] : undefined;
}

function inspectAgentSelectorsFromScan(message, scan) {
  const locations = [
    { path: [], source: "body" },
    { path: ["params"], source: "body" },
    { path: ["params", "arguments"], source: "mcp_arguments" }
  ];
  const occurrences = [];

  for (const location of locations) {
    for (const key of memberNamesAt(scan, location.path)) {
      if (!SELECTOR_KEYS.has(key)) continue;
      occurrences.push(Object.freeze({
        source: location.source,
        key,
        value: parsedValueAt(message, location.path, key)
      }));
    }
  }
  return Object.freeze(occurrences);
}

/**
 * Inspect only selector-capable envelope locations. Selector-looking keys in
 * nested user content are intentionally ignored.
 */
export function inspectAgentSelectors(input) {
  if (!isObjectRecord(input) || !Object.hasOwn(input, "rawJson")) {
    throw invalidRequest();
  }
  const scan = scanJsonObjectMembers(input.rawJson);
  let parsed;
  try {
    parsed = JSON.parse(scan.source);
  } catch {
    throw invalidRequest();
  }
  if (!isObjectRecord(parsed)) throw invalidRequest();
  return inspectAgentSelectorsFromScan(parsed, scan);
}

function hasDuplicateMembers(names) {
  return new Set(names).size !== names.length;
}

function assertUnambiguousEnvelope(scan) {
  for (const path of [[], ["params"], ["params", "arguments"]]) {
    if (hasDuplicateMembers(memberNamesAt(scan, path))) {
      throw invalidRequest();
    }
  }
}

function assertSameParsedMessage(message, parsed) {
  try {
    if (JSON.stringify(message) !== JSON.stringify(parsed)) throw invalidRequest();
  } catch (error) {
    if (isHostedPolicyError(error)) throw error;
    throw invalidRequest();
  }
}

function querySelectorOccurrences(parameters) {
  const occurrences = [];
  for (const [key, value] of parameters) {
    if (!SELECTOR_KEYS.has(key) && !/^(?:agentId|agent_id)\[/.test(key)) continue;
    occurrences.push(Object.freeze({ source: "query", key, value }));
  }
  return occurrences;
}

function parseHostedRestBody(body, rawJson) {
  if (!isObjectRecord(body) || rawJson === undefined) throw invalidRequest();
  const scan = scanJsonObjectMembers(rawJson);
  let parsed;
  try {
    parsed = JSON.parse(scan.source);
  } catch {
    throw invalidRequest();
  }
  if (!isObjectRecord(parsed)) throw invalidRequest();
  assertSameParsedMessage(body, parsed);

  const names = memberNamesAt(scan, []);
  const occurrences = names
    .filter((key) => SELECTOR_KEYS.has(key))
    .map((key) => Object.freeze({ source: "body", key, value: parsed[key] }));
  if (hasDuplicateMembers(names) && occurrences.length <= 1) {
    throw invalidRequest();
  }
  return Object.freeze({ parsed, occurrences: Object.freeze(occurrences) });
}

/**
 * Match and bind one protected hosted REST request to the server-owned agent.
 * Query/body aliases, wrong-location selectors, duplicates, and foreign values
 * are rejected before a canonical URL/body is returned to the gateway.
 */
export function bindHostedRestRequest(input, context) {
  if (!isObjectRecord(input)) throw invalidRequest();
  if (!isWellFormedAgentId(context?.agentExternalId)) {
    throw policyConfigurationError();
  }

  const policy = matchHostedRestRoute(input.method, input.rawUrl);
  const target = parseHostedRestTarget(input.rawUrl);
  if (!policy || !target) throw unavailableRestRoute();

  const query = new URLSearchParams(target.rawQuery);
  const occurrences = querySelectorOccurrences(query);
  let parsedBody = null;
  let unexpectedBody = false;

  if (policy.agentLocation === "body") {
    const parsed = parseHostedRestBody(input.body, input.rawJson);
    parsedBody = parsed.parsed;
    occurrences.push(...parsed.occurrences);
  } else {
    const rawLength = typeof input.rawJson === "string"
      ? Buffer.byteLength(input.rawJson, "utf8")
      : input.rawJson instanceof Uint8Array
        ? input.rawJson.byteLength
        : 0;
    if (input.body !== undefined || rawLength > 0) {
      const parsed = parseHostedRestBody(input.body, input.rawJson);
      occurrences.push(...parsed.occurrences);
      unexpectedBody = true;
    }
  }

  const expectedSource = policy.agentLocation;
  const canonical = occurrences.filter((occurrence) =>
    occurrence.source === expectedSource && occurrence.key === "agentId");
  if (
    occurrences.some((occurrence) =>
      occurrence.source !== expectedSource || occurrence.key !== "agentId") ||
    canonical.length > 1
  ) {
    throw agentMismatch();
  }
  if (canonical.length === 1 &&
    (!isWellFormedAgentId(canonical[0].value) ||
      canonical[0].value !== context.agentExternalId)) {
    throw agentMismatch();
  }
  if (unexpectedBody) throw invalidRequest();

  let upstream;
  try {
    upstream = new URL(
      target.path,
      `${String(input.restTarget).replace(/\/+$/, "")}/`
    );
  } catch {
    throw policyConfigurationError();
  }
  for (const [key, value] of query) {
    if (!SELECTOR_KEYS.has(key)) upstream.searchParams.append(key, value);
  }

  if (policy.agentLocation === "query") {
    upstream.searchParams.set("agentId", context.agentExternalId);
    return { url: upstream, body: null };
  }
  return {
    url: upstream,
    body: {
      ...parsedBody,
      agentId: context.agentExternalId
    }
  };
}

export function validateHostedMcpEnvelope(
  message,
  rawJson,
  { deferAmbiguity = false } = {}
) {
  const scan = scanJsonObjectMembers(rawJson);
  let parsed;
  try {
    parsed = JSON.parse(scan.source);
  } catch {
    throw invalidRequest();
  }
  if (!isObjectRecord(parsed) || !isObjectRecord(message)) throw invalidRequest();
  assertSameParsedMessage(message, parsed);
  if (!deferAmbiguity) assertUnambiguousEnvelope(scan);
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw invalidRequest();
  }
  if (!HOSTED_MCP_METHOD_SET.has(parsed.method)) throw unavailableMethod();
  if (parsed.params !== undefined && !isObjectRecord(parsed.params)) {
    throw invalidRequest();
  }
  return parsed;
}

/**
 * Bind a hosted tool call to the server-owned agent. Original JSON bytes are
 * inspected before the parsed object is trusted, then the accepted request is
 * cloned for canonical reserialization by the caller.
 *
 * @param {unknown} message
 * @param {string|Uint8Array} rawJson
 * @param {HostedAuthContext} context
 * @returns {object}
 */
export function bindHostedMcpRequest(message, rawJson, context) {
  const scan = scanJsonObjectMembers(rawJson);
  let parsed;
  try {
    parsed = JSON.parse(scan.source);
  } catch {
    throw invalidRequest();
  }
  if (!isObjectRecord(parsed) || !isObjectRecord(message)) throw invalidRequest();
  assertSameParsedMessage(message, parsed);

  const occurrences = inspectAgentSelectorsFromScan(parsed, scan);
  const canonical = occurrences.filter((occurrence) =>
    occurrence.source === "mcp_arguments" && occurrence.key === "agent_id");
  if (
    occurrences.some((occurrence) =>
      occurrence.source !== "mcp_arguments" || occurrence.key !== "agent_id") ||
    canonical.length > 1
  ) {
    throw agentMismatch();
  }
  if (canonical.length === 1 &&
    (!isWellFormedAgentId(canonical[0].value) ||
      canonical[0].value !== context?.agentExternalId)) {
    throw agentMismatch();
  }

  assertUnambiguousEnvelope(scan);
  if (
    parsed.jsonrpc !== "2.0" ||
    parsed.method !== "tools/call" ||
    !isObjectRecord(parsed.params)
  ) {
    throw invalidRequest();
  }
  if (typeof parsed.params.name !== "string" ||
    !HOSTED_TOOL_NAMES.has(parsed.params.name)) {
    throw unavailableTool();
  }
  if (!isWellFormedAgentId(context?.agentExternalId)) {
    throw new HostedPolicyError(
      500,
      "policy_configuration_error",
      "Hosted agent binding is unavailable"
    );
  }

  const suppliedArguments = parsed.params.arguments;
  if (suppliedArguments !== undefined && !isObjectRecord(suppliedArguments)) {
    throw invalidRequest();
  }
  return {
    ...parsed,
    params: {
      ...parsed.params,
      arguments: {
        ...(suppliedArguments ?? {}),
        agent_id: context.agentExternalId
      }
    }
  };
}
