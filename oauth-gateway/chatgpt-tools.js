import Ajv from "ajv";

const READ_SCOPES = ["cortex:read", "mcp"];
const WRITE_SCOPES = ["cortex:write", "mcp"];
const READ_WRITE_SCOPES = ["cortex:read", "cortex:write", "mcp"];
const MAX_TOOL_DESCRIPTION_LENGTH = 4096;

// ChatGPT-facing metadata is kept in one complete manifest so a new Cortex
// tool cannot silently inherit an unsafe read/write classification.
const TOOL_METADATA = {
  cortex_search: { title: "Search memories", access: "read_write" },
  cortex_recall: { title: "Recall context", access: "read_write" },
  cortex_init: { title: "Initialize memory context", access: "read" },
  cortex_ingest: { title: "Store a memory", access: "read_write" },
  cortex_ingest_file: {
    title: "Ingest a file",
    access: "write",
    destructive: true,
    description: "Ingest a text file that an administrator has staged in Cortex's configured import directory. The path cannot access the rest of the server filesystem. This can create many persistent records, so use it only when the user explicitly requests ingestion of a known staged file."
  },
  cortex_ingest_corpus: {
    title: "Ingest the memory corpus",
    access: "write",
    destructive: true,
    description: "Bulk-import the administrator-staged Cortex corpus from the configured read-only import directory. This replaces prior chunks for the same source files and can create many persistent records, so use it only when the user explicitly requests a full corpus import."
  },
  cortex_dream: {
    title: "Run memory maintenance",
    access: "read_write",
    destructive: true,
    description: "Run Cortex memory maintenance. A full or pruning cycle can archive or delete memories and prune synapses, so use it only when the user explicitly requests maintenance or pruning."
  },
  cortex_status: { title: "Get memory status", access: "read" },
  cortex_vitals: { title: "Check memory health", access: "read" },
  cortex_artifact: { title: "Store a cognitive artifact", access: "write" },
  cortex_self_check: { title: "Run an agent self-check", access: "read_write" },
  cortex_journal: { title: "Record an agent journal", access: "write" },
  cortex_assess_state: { title: "Assess the principal's state", access: "write" },
  cortex_state_history: { title: "Get state history", access: "read" },
  cortex_bg_thread: { title: "Run background reasoning", access: "read_write" },
  cortex_synthesize: {
    title: "Synthesize memory connections",
    access: "read_write",
    destructive: true,
    description: "Synthesize recent memory connections into insights. Low-confidence or coincidental weak synapses can be permanently pruned, so use it only when the user explicitly requests synthesis or graph cleanup."
  },
  cortex_observe: {
    title: "Capture the current screen",
    access: "read_write",
    description: "Capture the screen of the machine running Cortex on supported desktop installations. Hosted Cortex cannot capture the ChatGPT user's device, and storage is opt-in. Use only when live Cortex-host context is needed for the user's request."
  },
  cortex_relationship: { title: "Get a relationship profile", access: "read" },
  cortex_relationships: { title: "List relationships", access: "read" },
  cortex_relationship_update: {
    title: "Update a relationship",
    access: "read_write",
    destructive: true,
    description: "Update a relationship profile. This can replace existing notes or permanently mark open items as resolved, so use it only when the user explicitly requests the change."
  },
  cortex_reason: { title: "Record decision reasoning", access: "write" },
  cortex_audit: { title: "Run a reasoning audit", access: "read_write" },
  cortex_monologue: { title: "Record an inner monologue", access: "write" },
  cortex_reconsolidate: {
    title: "Update a recalled memory",
    access: "read_write",
    destructive: true,
    description: "Replace the active content of a recently recalled memory with corrected or expanded content. Cortex preserves the original as an audit artifact, but the active memory and its derived data change and are difficult to restore automatically."
  },
  cortex_labile: { title: "List updatable memories", access: "read" },
  cortex_skill_store: { title: "Store a procedural memory", access: "write" },
  cortex_skill_retrieve: { title: "Find procedural memories", access: "read" },
  cortex_skill_executed: { title: "Record a skill outcome", access: "write" },
  cortex_skill_refine: {
    title: "Refine a procedural memory",
    access: "read_write",
    destructive: true,
    description: "Replace parts of an existing procedural memory and regenerate its embedding. The previous active version is not automatically restorable, so use it only when the user explicitly requests a refinement."
  }
};

export const CORTEX_TOOL_METADATA = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_METADATA).map(([name, metadata]) => [
    name,
    Object.freeze({ ...metadata })
  ])
));

export const CORTEX_TOOL_NAMES = Object.freeze(Object.keys(CORTEX_TOOL_METADATA));

function humanizeToolName(name) {
  const words = String(name || "tool")
    .replace(/^cortex_/, "")
    .split("_")
    .filter(Boolean);

  const label = words.join(" ") || "tool";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function hostedToolDescription(tool, metadata, title) {
  const authoritative = typeof tool?.description === "string" &&
    tool.description.length > 0
    ? tool.description
    : null;
  const guidance = typeof metadata?.description === "string" &&
    metadata.description.length > 0
    ? metadata.description
    : null;
  if (authoritative && guidance && authoritative !== guidance) {
    return `${authoritative}\n\nHosted safety guidance: ${guidance}`;
  }
  return guidance || authoritative || title;
}

export function requiredScopesForTool(name) {
  const metadata = CORTEX_TOOL_METADATA[name];
  if (!metadata) {
    throw new Error(`Unknown Cortex tool: ${String(name)}`);
  }

  switch (metadata.access) {
    case "read":
      return [...READ_SCOPES];
    case "write":
      return [...WRITE_SCOPES];
    case "read_write":
      return [...READ_WRITE_SCOPES];
    default:
      throw new Error(`Invalid Cortex tool access class: ${String(name)}`);
  }
}

export function hideHostedAgentSelector(inputSchema) {
  if (inputSchema === undefined) return undefined;

  const projected = structuredClone(inputSchema);
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
    return projected;
  }

  if (
    projected.properties &&
    typeof projected.properties === "object" &&
    !Array.isArray(projected.properties)
  ) {
    delete projected.properties.agent_id;
  }

  if (Array.isArray(projected.required)) {
    projected.required = projected.required.filter((name) => name !== "agent_id");
  }

  return projected;
}

export function sanitizeToolForChatGPT(tool) {
  const metadata = CORTEX_TOOL_METADATA[tool?.name];
  if (
    !metadata ||
    !tool ||
    typeof tool !== "object" ||
    Array.isArray(tool) ||
    typeof tool.description !== "string" ||
    tool.description.trim().length === 0 ||
    tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH ||
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema)
  ) {
    return null;
  }

  const title = metadata?.title || tool?.title || humanizeToolName(tool?.name);
  const scopes = requiredScopesForTool(tool?.name);
  const scheme = { type: "oauth2", scopes };
  const readOnly = metadata?.access === "read";
  const projected = structuredClone(tool);
  const description = hostedToolDescription(projected, metadata, title);
  if (description.length > MAX_TOOL_DESCRIPTION_LENGTH) return null;
  const annotations = projected.annotations &&
    typeof projected.annotations === "object" &&
    !Array.isArray(projected.annotations)
    ? projected.annotations
    : {};
  const existingMeta = projected._meta &&
    typeof projected._meta === "object" &&
    !Array.isArray(projected._meta)
    ? projected._meta
    : {};
  const existingUi = existingMeta.ui &&
    typeof existingMeta.ui === "object" &&
    !Array.isArray(existingMeta.ui)
    ? existingMeta.ui
    : {};

  return {
    ...projected,
    name: projected.name,
    title,
    description,
    inputSchema: hideHostedAgentSelector(projected.inputSchema),
    securitySchemes: [scheme],
    annotations: {
      ...annotations,
      readOnlyHint: readOnly,
      destructiveHint: metadata?.destructive === true,
      idempotentHint: readOnly,
      openWorldHint: false
    },
    _meta: {
      ...existingMeta,
      securitySchemes: [scheme],
      ui: {
        ...existingUi,
        visibility: ["model", "app"]
      },
      "openai/visibility": "public",
      "openai/toolInvocation/invoking": `Running ${title}`.slice(0, 64),
      "openai/toolInvocation/invoked": `${title} finished`.slice(0, 64)
    }
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidCatalog() {
  return new Error("Hosted MCP upstream returned an invalid tools/list catalog");
}

function assertCatalogSchemasCompile(tools) {
  const compiler = new Ajv({ strict: false, validateFormats: false });
  try {
    for (const tool of tools) {
      compiler.compile(tool.inputSchema);
      compiler.compile(tool.outputSchema);
    }
  } catch {
    throw invalidCatalog();
  }
}

export function projectHostedToolCatalog(tools) {
  if (!Array.isArray(tools) || tools.length !== CORTEX_TOOL_NAMES.length) {
    throw invalidCatalog();
  }

  const seen = new Set();
  const projected = [];
  for (const tool of tools) {
    if (
      !isRecord(tool) ||
      typeof tool.name !== "string" ||
      !Object.hasOwn(CORTEX_TOOL_METADATA, tool.name) ||
      seen.has(tool.name) ||
      !isRecord(tool.inputSchema) ||
      tool.inputSchema.type !== "object" ||
      !isRecord(tool.inputSchema.properties) ||
      !Object.hasOwn(tool.inputSchema.properties, "agent_id") ||
      !isRecord(tool.outputSchema)
    ) {
      throw invalidCatalog();
    }

    const sanitized = sanitizeToolForChatGPT(tool);
    if (!sanitized) throw invalidCatalog();
    seen.add(tool.name);
    projected.push(sanitized);
  }

  if (CORTEX_TOOL_NAMES.some((name) => !seen.has(name))) {
    throw invalidCatalog();
  }
  assertCatalogSchemasCompile(tools);
  assertCatalogSchemasCompile(projected);
  return projected;
}

function projectToolsListMessage(message) {
  if (!isRecord(message) || message.jsonrpc !== "2.0") throw invalidCatalog();
  if (Object.hasOwn(message, "error")) {
    if (Object.hasOwn(message, "result") || !isRecord(message.error)) {
      throw invalidCatalog();
    }
    return { message: structuredClone(message), kind: "error" };
  }
  if (!isRecord(message.result) || !Array.isArray(message.result.tools)) {
    throw invalidCatalog();
  }

  return {
    message: {
      ...structuredClone(message),
      result: {
        ...structuredClone(message.result),
        tools: projectHostedToolCatalog(message.result.tools)
      }
    },
    kind: "catalog"
  };
}

function decorateEventStream(body) {
  const events = body.split(/(?:\r\n|\n|\r){2}/);
  const decorated = [];
  let foundTerminalResponse = false;

  for (const event of events) {
    if (event.length === 0) continue;
    const lines = event.split(/\r\n|\n|\r/);
    const dataIndexes = [];
    const dataParts = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^data:(?: ?)(.*)$/);
      if (!match) continue;
      dataIndexes.push(index);
      dataParts.push(match[1]);
    }

    if (dataIndexes.length === 0) {
      decorated.push(lines.join("\n"));
      continue;
    }

    const payload = dataParts.join("\n");
    if (payload === "[DONE]") {
      decorated.push(lines.join("\n"));
      continue;
    }

    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      throw invalidCatalog();
    }

    if (isRecord(message) && Object.hasOwn(message, "result")) {
      const result = projectToolsListMessage(message);
      foundTerminalResponse = true;
      lines[dataIndexes[0]] = `data: ${JSON.stringify(result.message)}`;
      for (let index = dataIndexes.length - 1; index > 0; index -= 1) {
        lines.splice(dataIndexes[index], 1);
      }
    } else if (isRecord(message) && Object.hasOwn(message, "error")) {
      projectToolsListMessage(message);
      foundTerminalResponse = true;
    }
    decorated.push(lines.join("\n"));
  }

  if (!foundTerminalResponse) throw invalidCatalog();
  return `${decorated.join("\n\n")}\n\n`;
}

export function decorateMcpResponse(body, contentType = "") {
  if (typeof body !== "string") throw invalidCatalog();
  if (/\btext\/event-stream\b/i.test(contentType) ||
    (contentType === "" && /^\s*(?:event:|data:|:)/m.test(body))) {
    return decorateEventStream(body);
  }

  let message;
  try {
    message = JSON.parse(body);
  } catch {
    throw invalidCatalog();
  }
  return JSON.stringify(projectToolsListMessage(message).message);
}
