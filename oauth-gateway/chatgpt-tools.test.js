import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv from "ajv";
import ts from "typescript";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CORTEX_TOOL_METADATA,
  CORTEX_TOOL_NAMES,
  decorateMcpResponse,
  projectHostedToolCatalog,
  requiredScopesForTool,
  sanitizeToolForChatGPT
} from "./chatgpt-tools.js";

const EXPECTED_TOOL_NAMES = [
  "cortex_search",
  "cortex_recall",
  "cortex_init",
  "cortex_ingest",
  "cortex_ingest_file",
  "cortex_ingest_corpus",
  "cortex_dream",
  "cortex_status",
  "cortex_vitals",
  "cortex_artifact",
  "cortex_self_check",
  "cortex_journal",
  "cortex_assess_state",
  "cortex_state_history",
  "cortex_bg_thread",
  "cortex_synthesize",
  "cortex_observe",
  "cortex_relationship",
  "cortex_relationships",
  "cortex_relationship_update",
  "cortex_reason",
  "cortex_audit",
  "cortex_monologue",
  "cortex_reconsolidate",
  "cortex_labile",
  "cortex_skill_store",
  "cortex_skill_retrieve",
  "cortex_skill_executed",
  "cortex_skill_refine"
];

const DESTRUCTIVE_TOOLS = new Set([
  "cortex_ingest_file",
  "cortex_ingest_corpus",
  "cortex_dream",
  "cortex_synthesize",
  "cortex_relationship_update",
  "cortex_reconsolidate",
  "cortex_skill_refine"
]);

function rawTool(name) {
  return {
    name,
    description: `${name} authoritative raw description`,
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          default: "arlo",
          description: "Agent ID"
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: `${name} query`
        },
        nested: {
          type: "object",
          properties: { agent_id: { type: "string" } },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      required: ["agent_id", "query"],
      additionalProperties: false
    },
    outputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        ok: { const: true },
        agent_id: { type: "string", minLength: 1 }
      },
      required: ["ok", "agent_id"],
      additionalProperties: false
    },
    annotations: { audience: ["assistant"] },
    _meta: { existing: true, ui: { custom: "preserved" } }
  };
}

function rawCatalog() {
  return EXPECTED_TOOL_NAMES.map(rawTool);
}

function expectedScopes(name) {
  const access = CORTEX_TOOL_METADATA[name].access;
  if (access === "read") return ["cortex:read", "mcp"];
  if (access === "write") return ["cortex:write", "mcp"];
  return ["cortex:read", "cortex:write", "mcp"];
}

function listMessage(tools = rawCatalog()) {
  return { jsonrpc: "2.0", id: 1, result: { tools } };
}

function exportedPositiveInteger(sourceUrl, exportName) {
  const sourceText = readFileSync(sourceUrl, "utf8");
  const sourceFile = ts.createSourceFile(
    sourceUrl.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let value = null;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (!isExported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== exportName) {
        continue;
      }
      assert.ok(declaration.initializer && ts.isNumericLiteral(declaration.initializer));
      value = Number(declaration.initializer.text);
    }
  }

  assert.ok(Number.isSafeInteger(value) && value > 0);
  return value;
}

function actualRawMcpCatalog() {
  const sourceText = readFileSync(
    new URL("../src/mcp/server.ts", import.meta.url),
    "utf8"
  );
  const sourceFile = ts.createSourceFile(
    "server.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const requiredDeclarations = new Set([
    "cortexBaseOutputShape",
    "ingestStatusOutputSchema",
    "ingestFailureOutputSchema",
    "proceduralSourceMemoryIdsInputSchema",
    "relationshipPublicSchema",
    "searchQueryInputSchema"
  ]);
  const declarations = [];
  const registrations = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaredNames = statement.declarationList.declarations
      .map((declaration) => ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : null)
      .filter(Boolean);
    if (declaredNames.some((name) => requiredDeclarations.has(name))) {
      declarations.push(statement.getText(sourceFile));
      for (const name of declaredNames) requiredDeclarations.delete(name);
    }
  }
  assert.deepEqual([...requiredDeclarations], []);
  const maxRetrievalQueryBytes = exportedPositiveInteger(
    new URL("../src/memory/retrieval.ts", import.meta.url),
    "MAX_RETRIEVAL_QUERY_BYTES"
  );

  const visit = (node) => {
    if (ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === "server.registerTool") {
      const [nameNode, configNode] = node.arguments;
      assert.ok(nameNode && ts.isStringLiteral(nameNode));
      assert.ok(configNode);
      registrations.push([nameNode.text, configNode.getText(sourceFile)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const evaluated = new Function(
    "z",
    "MAX_RETRIEVAL_QUERY_BYTES",
    "isValidRetrievalQuery",
    `"use strict";\n${declarations.join("\n")}\nreturn [${registrations
      .map(([name, config]) => `({name:${JSON.stringify(name)},config:${config}})`)
      .join(",")}];`
  )(
    z,
    maxRetrievalQueryBytes,
    (value) => typeof value === "string" &&
      value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= maxRetrievalQueryBytes &&
      !value.includes("\u0000")
  );

  return evaluated.map(({ name, config }) => ({
    name,
    description: config.description,
    inputSchema: zodToJsonSchema(config.inputSchema, {
      strictUnions: true,
      pipeStrategy: "input"
    }),
    outputSchema: zodToJsonSchema(config.outputSchema, {
      strictUnions: true,
      pipeStrategy: "output"
    }),
    ...(config.annotations ? { annotations: config.annotations } : {}),
    ...(config._meta ? { _meta: config._meta } : {})
  }));
}

test("has one immutable metadata and scope classification for every raw MCP tool", () => {
  assert.deepEqual(CORTEX_TOOL_NAMES, EXPECTED_TOOL_NAMES);
  assert.equal(Object.isFrozen(CORTEX_TOOL_METADATA), true);

  const source = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  const registeredNames = [...source.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual(registeredNames, EXPECTED_TOOL_NAMES);

  for (const [name, metadata] of Object.entries(CORTEX_TOOL_METADATA)) {
    assert.match(name, /^cortex_[a-z_]+$/);
    assert.equal(Object.isFrozen(metadata), true);
    assert.ok(metadata.title);
    assert.ok(["read", "write", "read_write"].includes(metadata.access));
    assert.deepEqual(requiredScopesForTool(name), expectedScopes(name));
  }
});

test("projects and compiles all 29 schemas without mutating raw input or output", () => {
  const raw = rawCatalog();
  const before = structuredClone(raw);
  const projected = projectHostedToolCatalog(raw);
  const ajv = new Ajv({ strict: false, allErrors: true });

  assert.equal(projected.length, 29);
  assert.deepEqual(raw, before);
  for (let index = 0; index < projected.length; index += 1) {
    const source = raw[index];
    const hosted = projected[index];
    const metadata = CORTEX_TOOL_METADATA[hosted.name];

    assert.notEqual(hosted, source);
    assert.notEqual(hosted.inputSchema, source.inputSchema);
    assert.notEqual(hosted.outputSchema, source.outputSchema);
    assert.equal(Object.hasOwn(hosted.inputSchema.properties, "agent_id"), false);
    assert.equal(hosted.inputSchema.required.includes("agent_id"), false);
    assert.deepEqual(hosted.inputSchema.properties.query, source.inputSchema.properties.query);
    assert.deepEqual(hosted.inputSchema.properties.nested, source.inputSchema.properties.nested);
    assert.equal(hosted.inputSchema.additionalProperties, false);
    assert.deepEqual(hosted.outputSchema, source.outputSchema);
    assert.match(hosted.description, new RegExp(source.description));
    assert.ok(ajv.compile(hosted.inputSchema));
    assert.ok(ajv.compile(hosted.outputSchema));

    const scheme = [{ type: "oauth2", scopes: expectedScopes(hosted.name) }];
    assert.deepEqual(hosted.securitySchemes, scheme);
    assert.deepEqual(hosted._meta.securitySchemes, scheme);
    assert.deepEqual(hosted._meta.ui, {
      custom: "preserved",
      visibility: ["model", "app"]
    });
    assert.equal(hosted._meta.existing, true);
    assert.equal(hosted._meta["openai/visibility"], "public");
    assert.deepEqual(hosted.annotations.audience, ["assistant"]);
    assert.equal(hosted.annotations.readOnlyHint, metadata.access === "read");
    assert.equal(hosted.annotations.idempotentHint, metadata.access === "read");
    assert.equal(hosted.annotations.destructiveHint, DESTRUCTIVE_TOOLS.has(hosted.name));
    assert.equal(hosted.annotations.openWorldHint, false);
  }
});

test("projects every actual MCP Zod schema with only the input selector removed", () => {
  const raw = actualRawMcpCatalog();
  const before = structuredClone(raw);
  const projected = projectHostedToolCatalog(raw);
  const compiler = new Ajv({ strict: false, validateFormats: false });

  assert.deepEqual(raw.map((tool) => tool.name), EXPECTED_TOOL_NAMES);
  assert.deepEqual(projected.map((tool) => tool.name), EXPECTED_TOOL_NAMES);
  assert.deepEqual(raw, before);

  for (let index = 0; index < raw.length; index += 1) {
    const source = raw[index];
    const hosted = projected[index];
    const expectedInput = structuredClone(source.inputSchema);
    delete expectedInput.properties.agent_id;
    if (Array.isArray(expectedInput.required)) {
      expectedInput.required = expectedInput.required.filter(
        (name) => name !== "agent_id"
      );
    }

    assert.equal(Object.hasOwn(source.inputSchema.properties, "agent_id"), true);
    assert.deepEqual(hosted.inputSchema, expectedInput, source.name);
    assert.deepEqual(hosted.outputSchema, source.outputSchema, source.name);
    assert.equal(Object.hasOwn(hosted.outputSchema.properties, "agent_id"), true);
    assert.ok(hosted.description.includes(source.description), source.name);
    assert.ok(compiler.compile(source.inputSchema));
    assert.ok(compiler.compile(source.outputSchema));
    assert.ok(compiler.compile(hosted.inputSchema));
    assert.ok(compiler.compile(hosted.outputSchema));
  }
  const skillStore = projected.find((tool) => tool.name === "cortex_skill_store");
  assert.deepEqual(
    skillStore.inputSchema.properties.source_memory_ids,
    {
      anyOf: [
        {
          type: "array",
          items: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 2147483647
          },
          maxItems: 100
        },
        { type: "null" }
      ],
      description: "IDs of episodic memories where this was learned (maximum 100 unique positive PostgreSQL integer IDs; duplicates are normalized)"
    }
  );
  const search = raw.find((tool) => tool.name === "cortex_search");
  assert.equal(search.inputSchema.properties.query.maxLength, 8192);
  assert.deepEqual(raw, before);
});

test("uses accurate hosted safety descriptions for sensitive tools", () => {
  const byName = Object.fromEntries(
    projectHostedToolCatalog(rawCatalog()).map((tool) => [tool.name, tool])
  );
  assert.match(byName.cortex_ingest_file.description, /configured import directory/i);
  assert.match(byName.cortex_ingest_file.description, /cannot access the rest/i);
  assert.match(byName.cortex_ingest_corpus.description, /replaces prior chunks/i);
  assert.match(byName.cortex_observe.description, /cannot capture the ChatGPT user's device/i);
  assert.match(byName.cortex_observe.description, /storage is opt-in/i);
  assert.match(byName.cortex_synthesize.description, /prun/i);
  assert.match(byName.cortex_reconsolidate.description, /replace/i);
  assert.match(byName.cortex_skill_refine.description, /not automatically restorable/i);
});

test("decorates one exact catalog in JSON and SSE and passes JSON-RPC errors", () => {
  const message = listMessage();
  const jsonResult = JSON.parse(decorateMcpResponse(
    JSON.stringify(message),
    "application/json; charset=utf-8"
  ));
  assert.deepEqual(jsonResult.result.tools.map((tool) => tool.name), EXPECTED_TOOL_NAMES);
  assert.equal(
    Object.hasOwn(jsonResult.result.tools[0].inputSchema.properties, "agent_id"),
    false
  );

  const eventStream = [
    "event: message",
    `data: ${JSON.stringify(message)}`,
    "",
    ""
  ].join("\n");
  const decoratedStream = decorateMcpResponse(eventStream, "text/event-stream");
  const dataLine = decoratedStream.match(/^data: (.+)$/m)?.[1];
  const streamResult = JSON.parse(dataLine);
  assert.deepEqual(streamResult.result.tools.map((tool) => tool.name), EXPECTED_TOOL_NAMES);

  const carriageReturnStream =
    `event: message\rdata: ${JSON.stringify(message)}\r\r`;
  const carriageReturnResult = decorateMcpResponse(
    carriageReturnStream,
    "text/event-stream"
  );
  assert.equal(
    JSON.parse(carriageReturnResult.match(/^data: (.+)$/m)?.[1]).result.tools.length,
    29
  );

  const error = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "catalog unavailable" }
  };
  assert.deepEqual(
    JSON.parse(decorateMcpResponse(JSON.stringify(error), "application/json")),
    error
  );
});

test("rejects every partial ambiguous unknown or malformed upstream catalog", () => {
  const catalog = rawCatalog();
  const invalidCatalogs = [
    catalog.slice(1),
    [...catalog, rawTool("cortex_future_tool")],
    [...catalog.slice(0, -1), structuredClone(catalog[0])],
    [...catalog.slice(0, -1), rawTool("cortex_future_tool")],
    catalog.map((tool, index) => index === 0
      ? { ...tool, inputSchema: undefined }
      : tool),
    catalog.map((tool, index) => index === 0
      ? { ...tool, inputSchema: { type: "object", properties: {} } }
      : tool),
    catalog.map((tool, index) => index === 0
      ? { ...tool, outputSchema: undefined }
      : tool),
    catalog.map((tool, index) => index === 0
      ? { ...tool, outputSchema: { type: "not-a-json-schema-type" } }
      : tool),
    catalog.map((tool, index) => index === 0
      ? { ...tool, description: 42 }
      : tool)
  ];

  for (const tools of invalidCatalogs) {
    assert.throws(
      () => projectHostedToolCatalog(tools),
      /invalid tools\/list catalog/
    );
    assert.throws(
      () => decorateMcpResponse(JSON.stringify(listMessage(tools))),
      /invalid tools\/list catalog/
    );
  }

  assert.throws(
    () => decorateMcpResponse("event: message\ndata: not-json\n\n", "text/event-stream"),
    /invalid tools\/list catalog/
  );
  assert.equal(sanitizeToolForChatGPT(rawTool("cortex_future_tool")), null);
  assert.equal(sanitizeToolForChatGPT({ name: "cortex_status" }), null);
  assert.equal(sanitizeToolForChatGPT({
    ...rawTool("cortex_status"),
    description: " "
  }), null);
  assert.throws(
    () => requiredScopesForTool("cortex_future_tool"),
    /Unknown Cortex tool/
  );
});

test("accepts a reordered catalog only when its unique set remains exact", () => {
  const reversed = rawCatalog().reverse();
  assert.deepEqual(
    projectHostedToolCatalog(reversed).map((tool) => tool.name),
    [...EXPECTED_TOOL_NAMES].reverse()
  );
});
