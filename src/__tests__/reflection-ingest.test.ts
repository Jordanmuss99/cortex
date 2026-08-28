import { describe, expect, jest, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deriveGatewayCaptureKey,
  deriveReflectionIngestKey,
} from "../memory/ingest.js";
import type { MemoryHealthService } from "../memory/types.js";
import {
  REFLECTION_PROMPT_VERSION,
  applyCompletedTranscriptCheckpoints,
  applySourceTranscriptCheckpoints,
  applyTranscriptAttempts,
  buildReflectionWindows,
  buildReflectionEndpoints,
  cursorTranscriptEntry,
  emptyReflectionRunSummary,
  normalizeCursorState,
  parseCursorTranscript,
  parseReflectionJsonArray,
  prepareReflectionFacts,
  reflectionTranscriptVersion,
  reflectionRunFailed,
  resolveTranscriptScanBaseline,
  runReflectionOperation,
  selectPendingTranscriptVersions,
  submitReflectionFacts,
  transcriptCheckpointKey,
  updateSuccessfulSourceCheckpoints,
} from "../../scripts/reflect-cursor.js";
import { normalizeMultiState } from "../../scripts/reflect-multi.js";

const origin = {
  source: "cursor:session-1",
  transcriptPath: "/workspace/.cursor/projects/project/agent-transcripts/session-1/session-1.jsonl",
  transcriptEntryId: "cursor-record-42",
};

describe("reflection durable-ingest adapter", () => {
  test("stable fact keys ignore model output order but retain every distinct fact", () => {
    const first = prepareReflectionFacts(
      [
        { content: "The retry budget is five attempts.", tags: ["retry"] },
        { content: "Queued captures are not indexed yet.", tags: ["queue"] },
      ],
      origin,
      "arlo"
    );
    const reordered = prepareReflectionFacts(
      [
        { content: "Queued captures are not indexed yet.", tags: ["changed"] },
        { content: "  The retry budget is five attempts.  ", tags: ["other"] },
      ],
      origin,
      "arlo"
    );

    expect(first).toHaveLength(2);
    expect(new Set(first.map((fact) => fact.idempotencyKey)).size).toBe(2);
    expect(
      Object.fromEntries(first.map((fact) => [fact.content, fact.idempotencyKey]))
    ).toEqual(
      Object.fromEntries(reordered.map((fact) => [fact.content, fact.idempotencyKey]))
    );
    expect(first.every((fact) => fact.payload.semanticTags.join(",") === "reflection"))
      .toBe(true);
  });

  test("reflection key changes for a distinct fact, transcript entry, path, or prompt version", () => {
    const base = deriveReflectionIngestKey(
      origin.transcriptPath,
      origin.transcriptEntryId,
      REFLECTION_PROMPT_VERSION,
      "A durable fact"
    );
    expect(
      deriveReflectionIngestKey(
        origin.transcriptPath,
        origin.transcriptEntryId,
        REFLECTION_PROMPT_VERSION,
        "  A   durable fact  "
      )
    ).toBe(base);
    expect(
      deriveReflectionIngestKey(
        origin.transcriptPath,
        "session-2",
        REFLECTION_PROMPT_VERSION,
        "A durable fact"
      )
    ).not.toBe(base);
    expect(
      deriveReflectionIngestKey(
        `${origin.transcriptPath}.other`,
        origin.transcriptEntryId,
        REFLECTION_PROMPT_VERSION,
        "A durable fact"
      )
    ).not.toBe(base);
    expect(
      deriveReflectionIngestKey(
        origin.transcriptPath,
        origin.transcriptEntryId,
        "reflection-extract-v2",
        "A durable fact"
      )
    ).not.toBe(base);
  });

  test("queued receipts are counted as durable but never indexed", async () => {
    const responses = [
      {
        eventId: "11111111-1111-4111-8111-111111111111",
        status: "accepted",
        replayed: false,
        chunksStored: 0,
      },
      {
        eventId: "22222222-2222-4222-8222-222222222222",
        status: "indexed",
        replayed: false,
        chunksStored: 1,
      },
    ];
    const fetchImpl = jest.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: responses.length === 1 ? 202 : 200,
        headers: { "content-type": "application/json" },
      })
    );
    const logs: string[] = [];

    const summary = await submitReflectionFacts(
      [
        { content: "The first durable fact is queued." },
        { content: "The second durable fact is indexed." },
      ],
      origin,
      {
        agentId: "arlo",
        cortexUrl: "http://cortex.invalid",
        fetchImpl,
        log: (message) => logs.push(message),
      }
    );

    expect(summary).toMatchObject({
      prepared: 2,
      durable: 2,
      queued: 1,
      indexed: 1,
      failed: 0,
      rejected: 0,
      submissionFailures: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [input, request] of fetchImpl.mock.calls) {
      expect(String(input)).toBe("http://cortex.invalid/api/v1/ingest");
      const body = JSON.parse(String(request?.body));
      expect(body).toMatchObject({
        agentId: "arlo",
        sourceType: "reflection",
        waitMs: 20_000,
        sourceVersion: REFLECTION_PROMPT_VERSION,
        semanticTags: ["reflection"],
      });
      expect(body.idempotencyKey).toMatch(/^reflection:v1:[0-9a-f]{64}$/);
    }
    expect(logs.some((line) => /durably queued/i.test(line))).toBe(true);
    expect(logs.filter((line) => /indexed/i.test(line))).toHaveLength(1);
  });

  test("retryable, terminal, and rejected receipts keep distinct truthful counts", async () => {
    const lifecycle = [
      { status: "accepted" },
      { status: "processing" },
      { status: "failed", failure: { code: "provider_retry", retryable: true } },
      { status: "indexed" },
      { status: "failed", failure: { code: "provider_failed", retryable: false } },
      { status: "rejected", failure: { code: "invalid_projection", retryable: false } },
    ];
    let event = 0;
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      const receipt = lifecycle.shift();
      event += 1;
      return new Response(
        JSON.stringify({
          eventId: `00000000-0000-4000-8000-${String(event).padStart(12, "0")}`,
          replayed: false,
          ...receipt,
        }),
        {
          status:
            receipt?.status === "indexed"
              ? 200
              : receipt?.status === "rejected"
                ? 422
                : receipt?.status === "failed" && receipt.failure?.retryable === false
                  ? 503
                  : 202,
          headers: { "content-type": "application/json" },
        }
      );
    });

    const summary = await submitReflectionFacts(
      Array.from({ length: 6 }, (_, index) => ({
        content: `Distinct durable reflection fact number ${index + 1}.`,
      })),
      origin,
      {
        agentId: "arlo",
        cortexUrl: "http://cortex.invalid",
        fetchImpl,
      }
    );

    expect(summary).toMatchObject({
      prepared: 6,
      durable: 6,
      queued: 3,
      indexed: 1,
      failed: 1,
      rejected: 1,
      submissionFailures: 0,
    });
    expect(reflectionRunFailed(summary)).toBe(true);
  });

  test("valid empty extraction is distinct from malformed output", () => {
    expect(parseReflectionJsonArray("[]")).toEqual([]);
    expect(parseReflectionJsonArray("reasoning without an array")).toBeNull();
    expect(parseReflectionJsonArray('[{"entry_id":"x"}')).toBeNull();
    expect(() => prepareReflectionFacts([null], origin, "arlo")).toThrow(
      /must be an object/i
    );
    expect(() =>
      prepareReflectionFacts([{ entry_id: origin.transcriptEntryId }], origin, "arlo")
    ).toThrow(/text content/i);
  });

  test("Cursor parsing retains real record IDs and derives stable record IDs only when absent", () => {
    const explicitLine = JSON.stringify({
      id: "cursor-message-99",
      role: "user",
      message: { content: "A transcript record with a real durable identifier." },
    });
    expect(cursorTranscriptEntry(explicitLine, 8)).toMatchObject({
      id: "cursor-message-99",
    });

    const fallbackLine = JSON.stringify({
      role: "assistant",
      message: { content: "A transcript record without an explicit identifier." },
    });
    const first = cursorTranscriptEntry(fallbackLine, 9);
    expect(first?.id).toMatch(/^line:9:sha256:[0-9a-f]{64}$/);
    expect(cursorTranscriptEntry(fallbackLine, 9)?.id).toBe(first?.id);
    expect(cursorTranscriptEntry(fallbackLine, 10)?.id).not.toBe(first?.id);
  });

  test("record-preserving windows cover every transcript record without a tail slice", () => {
    const entries = [
      {
        id: "record-a",
        text: `[entry_id="record-a"] user: ${"a".repeat(260)}-A-TAIL`,
      },
      {
        id: "record-b",
        text: `[entry_id="record-b"] assistant: ${"b".repeat(260)}-B-TAIL`,
      },
      {
        id: "record-c",
        text: `[entry_id="record-c"] user: ${"c".repeat(260)}-C-TAIL`,
      },
    ];
    const windows = buildReflectionWindows(entries, 512);

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.transcript.length <= 512)).toBe(true);
    expect(windows.map((window) => window.transcript).join("\n\n")).toBe(
      entries.map((entry) => entry.text).join("\n\n")
    );
    expect(new Set(windows.flatMap((window) => window.entryIds))).toEqual(
      new Set(["record-a", "record-b", "record-c"])
    );
  });

  test("one oversized record is fully segmented with its real entry ID on every window", () => {
    const id = "oversized-record";
    const marker = `[entry_id=${JSON.stringify(id)}]`;
    const body = `${"0123456789".repeat(180)}-OVERSIZED-TAIL`;
    const windows = buildReflectionWindows(
      [{ id, text: `${marker} ${body}` }],
      512
    );

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.transcript.length <= 512)).toBe(true);
    expect(windows.every((window) => window.entryIds.join(",") === id)).toBe(true);
    const reconstructed = windows
      .map((window) =>
        window.transcript.replace(
          /^\[entry_id="oversized-record"\] \[segment \d+\/\d+\] /,
          ""
        )
      )
      .join("");
    expect(reconstructed).toBe(body);
  });

  test("malformed JSONL is distinct from valid irrelevant records", () => {
    const raw = [
      JSON.stringify({ type: "metadata", version: 1 }),
      '{"role":"user","message":{"content":"unterminated"}',
      JSON.stringify({
        id: "cursor-real-id",
        role: "user",
        message: { content: "A valid transcript record after malformed input." },
      }),
    ].join("\n");
    const parsed = parseCursorTranscript(raw);

    expect(parsed.malformedRecords).toBe(1);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.id).toBe("cursor-real-id");
  });

  test("limited runs retain unprocessed file and database-session backlog", () => {
    const hermesOne = transcriptCheckpointKey("/state/hermes.db", "session-1");
    const hermesTwo = transcriptCheckpointKey("/state/hermes.db", "session-2");
    expect(hermesOne).not.toBe(hermesTwo);
    const candidates = [
      { checkpointKey: "/logs/cursor-a.jsonl", version: "v1", orderMs: 10 },
      { checkpointKey: hermesOne, version: "v1", orderMs: 20 },
      { checkpointKey: hermesTwo, version: "v1", orderMs: 30 },
    ];

    let checkpoints: Record<string, string> = {};
    const first = selectPendingTranscriptVersions(candidates, checkpoints, 1);
    expect(first.map((candidate) => candidate.checkpointKey)).toEqual([
      "/logs/cursor-a.jsonl",
    ]);
    checkpoints = applyCompletedTranscriptCheckpoints(checkpoints, {
      [first[0]!.checkpointKey]: first[0]!.version,
    });
    const second = selectPendingTranscriptVersions(candidates, checkpoints, 1);
    expect(second.map((candidate) => candidate.checkpointKey)).toEqual([hermesOne]);
    checkpoints = applyCompletedTranscriptCheckpoints(checkpoints, {
      [second[0]!.checkpointKey]: second[0]!.version,
    });

    // The uncompleted third item remains pending; no time watermark can hide it.
    expect(
      selectPendingTranscriptVersions(candidates, checkpoints, 1).map(
        (candidate) => candidate.checkpointKey
      )
    ).toEqual([hermesTwo]);
  });

  test("failed versions rotate behind unattempted backlog and return fairly", () => {
    const candidates = [
      { checkpointKey: "/logs/a.jsonl", version: "v1", orderMs: 10 },
      { checkpointKey: "/logs/b.jsonl", version: "v1", orderMs: 20 },
      { checkpointKey: "/logs/c.jsonl", version: "v1", orderMs: 30 },
    ];
    const attempts = {
      "/logs/a.jsonl": { version: "v1", attemptedAtMs: 100 },
      "/logs/b.jsonl": { version: "v1", attemptedAtMs: 200 },
    };

    expect(
      selectPendingTranscriptVersions(candidates, {}, 1, attempts)[0]
        ?.checkpointKey
    ).toBe("/logs/c.jsonl");
    const allAttempted = {
      ...attempts,
      "/logs/c.jsonl": { version: "v1", attemptedAtMs: 300 },
    };
    expect(
      selectPendingTranscriptVersions(candidates, {}, 1, allAttempted)[0]
        ?.checkpointKey
    ).toBe("/logs/a.jsonl");
    expect(
      selectPendingTranscriptVersions(
        [{ ...candidates[1]!, version: "v2" }],
        {},
        1,
        allAttempted
      )[0]?.checkpointKey
    ).toBe("/logs/b.jsonl");
    expect(
      applyTranscriptAttempts(
        allAttempted,
        { "/logs/a.jsonl": { version: "v1", attemptedAtMs: 400 } },
        { "/logs/a.jsonl": "v1" }
      )
    ).not.toHaveProperty("/logs/a.jsonl");
  });

  test("content versions and completed checkpoints remain isolated by source", () => {
    expect(reflectionTranscriptVersion("same")).toBe(
      reflectionTranscriptVersion("same")
    );
    expect(reflectionTranscriptVersion("changed")).not.toBe(
      reflectionTranscriptVersion("same")
    );
    const updated = applySourceTranscriptCheckpoints(
      {
        cursor: { "/cursor/a": "v1" },
        codex: { "/codex/a": "v1" },
      },
      new Map<string, Record<string, string>>([
        ["cursor", { "/cursor/a": "v2", "/cursor/b": "v1" }],
        ["hermes", { "/hermes.db\u0000session:1": "v1" }],
      ])
    );

    expect(updated).toEqual({
      cursor: { "/cursor/a": "v2", "/cursor/b": "v1" },
      codex: { "/codex/a": "v1" },
      hermes: { "/hermes.db\u0000session:1": "v1" },
    });
    const legacy = normalizeCursorState({ lastRunMs: 123 });
    expect(legacy).toEqual({
      checkpointVersion: 1,
      lastRunMs: 123,
      transcripts: {},
      attempts: {},
    });
    expect(resolveTranscriptScanBaseline(legacy, 1_000_000)).toBe(0);
    const migrated = normalizeCursorState({
      checkpointVersion: 2,
      lastRunMs: 0,
      scanBaselineMs: 0,
      transcripts: { "/cursor/a": "v1" },
      attempts: {},
    });
    expect(resolveTranscriptScanBaseline(migrated, 1_000_000)).toBe(0);
    expect(resolveTranscriptScanBaseline(legacy, 1_000_000, 900_000)).toBe(
      900_000
    );
    expect(() => normalizeCursorState(null)).toThrow(
      "reflection_state_invalid"
    );
    expect(() => normalizeCursorState({})).toThrow(
      "reflection_state_invalid"
    );
    expect(() =>
      normalizeCursorState({ checkpointVersion: 1, transcripts: {} })
    ).toThrow("reflection_state_invalid");
    expect(() =>
      normalizeCursorState({
        checkpointVersion: 2,
        lastRunMs: 0,
        scanBaselineMs: 0,
        attempts: {},
      })
    ).toThrow("reflection_state_invalid");
    expect(() =>
      normalizeCursorState({
        checkpointVersion: 2,
        lastRunMs: 0,
        scanBaselineMs: 0,
        transcripts: {},
        attempts: { broken: { version: "v1", attemptedAtMs: "never" } },
      })
    ).toThrow("reflection_state_invalid");

    expect(() => normalizeMultiState({})).toThrow(
      "reflection_state_invalid"
    );
    expect(() =>
      normalizeMultiState({ checkpointVersion: 1 })
    ).toThrow("reflection_state_invalid");
    expect(() =>
      normalizeMultiState({ checkpointVersion: 2, sources: {} })
    ).toThrow("reflection_state_invalid");
    expect(
      normalizeMultiState({
        checkpointVersion: 2,
        sources: {},
        scanBaselines: {},
        transcripts: {},
      })
    ).toEqual({
      checkpointVersion: 2,
      sources: {},
      scanBaselines: {},
      transcripts: {},
      attempts: {},
    });
  });

  test("only sources with complete durable acceptance advance their checkpoint", () => {
    const complete = emptyReflectionRunSummary();
    complete.prepared = 2;
    complete.durable = 2;
    complete.queued = 2;
    const incomplete = emptyReflectionRunSummary();
    incomplete.prepared = 2;
    incomplete.durable = 1;
    incomplete.submissionFailures = 1;

    expect(reflectionRunFailed(complete)).toBe(false);
    expect(reflectionRunFailed(incomplete)).toBe(true);
    expect(
      updateSuccessfulSourceCheckpoints(
        { cursor: 100, codex: 200 },
        new Map([
          ["cursor", complete],
          ["codex", incomplete],
        ]),
        300
      )
    ).toEqual({ cursor: 300, codex: 200 });
  });

  test("fallback endpoints are disabled without an explicitly configured credential", () => {
    expect(
      buildReflectionEndpoints({
        OLLAMA_URL: "http://127.0.0.1:11434/v1",
        REFLECT_MODEL: "local-model",
        REFLECT_FALLBACK_URL: "https://fallback.invalid/v1",
        REFLECT_FALLBACK_MODEL: "fallback-model",
      })
    ).toHaveLength(1);
    expect(
      buildReflectionEndpoints({
        OLLAMA_URL: "http://127.0.0.1:11434/v1",
        REFLECT_MODEL: "local-model",
        REFLECT_FALLBACK_URL: "https://fallback.invalid/v1",
        REFLECT_FALLBACK_MODEL: "fallback-model",
        REFLECT_FALLBACK_KEY: "configured-in-runtime",
      }).map((endpoint) => endpoint.label)
    ).toEqual(["primary", "fallback"]);

    const source = readFileSync(
      resolve("scripts/reflect-cursor.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/REFLECT_FALLBACK_KEY\s*\|\|\s*["'][^"']+["']/);
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });

  test("operation evidence records zero-output success and bounded failure", async () => {
    const startOperation = jest.fn<MemoryHealthService["startOperation"]>(async () => ({
      id: "33333333-3333-4333-8333-333333333333",
      operation: "reflection" as const,
      agentId: 7,
      buildId: "slice5-test",
    }));
    const finishOperation = jest.fn<MemoryHealthService["finishOperation"]>(
      async () => undefined
    );
    const health = {
      startOperation,
      heartbeat: jest.fn(async () => undefined),
      finishOperation,
      readiness: jest.fn(async () => ({
        ready: true,
        buildId: "slice5-test",
        reasons: [],
      })),
    } as MemoryHealthService;

    await runReflectionOperation(health, 7, async () =>
      emptyReflectionRunSummary()
    );
    expect(finishOperation).toHaveBeenLastCalledWith(
      expect.any(Object),
      "succeeded",
      expect.objectContaining({ counters: expect.objectContaining({ durable: 0 }) })
    );

    const failed = emptyReflectionRunSummary();
    failed.extractionFailures = 1;
    await runReflectionOperation(health, 7, async () => failed);
    expect(finishOperation).toHaveBeenLastCalledWith(
      expect.any(Object),
      "failed",
      expect.objectContaining({ errorCode: "reflection_extraction_failed" })
    );
  });
});

describe("gateway durable-capture adapter", () => {
  test("gateway uses a normalized relevance threshold and rejects invalid configuration", () => {
    const script = String.raw`
import importlib.util, sys, types
httpx = types.ModuleType("httpx")
httpx.AsyncClient = object
sys.modules["httpx"] = httpx
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = types.SimpleNamespace()
sys.modules["aiohttp"] = aiohttp
spec = importlib.util.spec_from_file_location("cortex_gateway", "scripts/cortex-memory-gateway.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.CORTEX_RELEVANCE_THRESHOLD)
`;
    const runImport = (threshold?: string) => {
      const env = { ...process.env };
      if (threshold === undefined) {
        delete env.CORTEX_RELEVANCE_THRESHOLD;
      } else {
        env.CORTEX_RELEVANCE_THRESHOLD = threshold;
      }
      return spawnSync("python3", ["-c", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
      });
    };

    expect(runImport().stdout.trim()).toBe("0.5");
    expect(runImport("0").status).toBe(0);
    expect(runImport("1").status).toBe(0);
    for (const invalid of [
      "-0.01",
      "1.01",
      "nan",
      "inf",
      "-inf",
      "not-a-number",
    ]) {
      expect(runImport(invalid).status).not.toBe(0);
    }
  });

  test("gateway A/B classification shares the normalized production boundary", () => {
    const script = String.raw`
import importlib.util, sys, types
httpx = types.ModuleType("httpx")
httpx.Client = object
sys.modules["httpx"] = httpx
spec = importlib.util.spec_from_file_location("gateway_ab", "scripts/gateway-ab-test.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.CORTEX_RELEVANCE_THRESHOLD)
print(module.would_inject_recall(0.5, "useful memory", "ten letters here"))
print(module.would_inject_recall(0.499999, "useful memory", "ten letters here"))
print(module.would_inject_recall(0.5, "   ", "ten letters here"))
`;
    const runImport = (threshold?: string) => {
      const env = { ...process.env };
      if (threshold === undefined) {
        delete env.CORTEX_RELEVANCE_THRESHOLD;
      } else {
        env.CORTEX_RELEVANCE_THRESHOLD = threshold;
      }
      return spawnSync("python3", ["-c", script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
      });
    };

    expect(runImport().stdout.trim().split("\n")).toEqual([
      "0.5",
      "True",
      "False",
      "False",
    ]);
    expect(runImport("0").status).toBe(0);
    expect(runImport("1").status).toBe(0);
    for (const invalid of ["-0.01", "1.01", "nan", "inf", "-inf"]) {
      expect(runImport(invalid).status).not.toBe(0);
    }
  });

  test("Python gateway awaits acceptance and uses the cross-language stable key", () => {
    const script = String.raw`
import asyncio, importlib.util, json, sys, types
httpx = types.ModuleType("httpx")
httpx.AsyncClient = object
sys.modules["httpx"] = httpx
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = types.SimpleNamespace()
sys.modules["aiohttp"] = aiohttp
spec = importlib.util.spec_from_file_location("cortex_gateway", "scripts/cortex-memory-gateway.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
async def fake_ingest(content, source, source_type, priority=2, *, idempotency_key, session_id, request_id):
    calls.append({"content": content, "key": idempotency_key, "session": session_id, "request": request_id})
    return {"eventId": "44444444-4444-4444-8444-444444444444", "status": "accepted", "replayed": len(calls) > 1}
module.cortex_ingest = fake_ingest
async def run():
    user = "u" * 120
    await module.capture_exchange(user, "a" * 120, "session-1", "turn-1")
    await module.capture_exchange(user, "a" * 120, "session-1", "turn-1")
    await module.capture_exchange(user, "b" * 120, "session-1", "turn-1")
    await module.capture_exchange("u", "a", "session-short", "turn-short")
    blocking_started = asyncio.Event()
    blocking_release = asyncio.Event()
    async def blocking_ingest(content, source, source_type, priority=2, *, idempotency_key, session_id, request_id):
        blocking_started.set()
        await blocking_release.wait()
        return {"eventId": "55555555-5555-4555-8555-555555555555", "status": "accepted", "replayed": False}
    module.cortex_ingest = blocking_ingest
    capture_task = asyncio.create_task(module.capture_exchange(user, "c" * 120, "session-1", "turn-2"))
    await blocking_started.wait()
    await_pending = not capture_task.done()
    blocking_release.set()
    await capture_task
    first_payload = {"model": "first", "stream": False, "messages": [{"role": "system", "content": "stable"}, {"role": "user", "content": user}]}
    retry_payload = {"model": "second", "stream": True, "messages": first_payload["messages"]}
    continued_payload = {"messages": first_payload["messages"] + [{"role": "assistant", "content": "answer"}, {"role": "user", "content": "next turn"}]}
    print(json.dumps({
        "calls": calls,
        "direct": module.derive_capture_idempotency_key("session-1", "turn-1", "User: " + user + "\n\nAssistant: " + "a" * 120),
        "bom_key": module.derive_capture_idempotency_key("\ufeffsession-1\ufeff", "\ufeffturn-1\ufeff", "User: " + user + "\n\nAssistant: " + "a" * 120),
        "nel_key": module.derive_capture_idempotency_key("\u0085session-1\u0085", "\u0085turn-1\u0085", "User: " + user + "\n\nAssistant: " + "a" * 120),
        "first_lineage": module.derive_capture_lineage("chat", first_payload, {}),
        "retry_lineage": module.derive_capture_lineage("chat", retry_payload, {}),
        "continued_lineage": module.derive_capture_lineage("chat", continued_payload, {}),
        "await_pending": await_pending,
        "short_content": calls[3]["content"],
    }))
asyncio.run(run())
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.calls).toHaveLength(4);
    expect(output.await_pending).toBe(true);
    expect(output.calls[0].key).toBe(output.calls[1].key);
    expect(output.calls[2].key).not.toBe(output.calls[0].key);
    expect(output.short_content).toBe("User: u\n\nAssistant: a");
    expect(output.retry_lineage).toEqual(output.first_lineage);
    expect(output.continued_lineage[0]).toBe(output.first_lineage[0]);
    expect(output.continued_lineage[1]).not.toBe(output.first_lineage[1]);
    expect(output.direct).toBe(
      deriveGatewayCaptureKey(
        "session-1",
        "turn-1",
        `User: ${"u".repeat(120)}\n\nAssistant: ${"a".repeat(120)}`
      )
    );
    expect(output.bom_key).toBe(output.direct);
    expect(output.bom_key).toBe(
      deriveGatewayCaptureKey(
        "\uFEFFsession-1\uFEFF",
        "\uFEFFturn-1\uFEFF",
        `User: ${"u".repeat(120)}\n\nAssistant: ${"a".repeat(120)}`
      )
    );
    expect(output.nel_key).not.toBe(output.direct);
    expect(output.nel_key).toBe(
      deriveGatewayCaptureKey(
        "\u0085session-1\u0085",
        "\u0085turn-1\u0085",
        `User: ${"u".repeat(120)}\n\nAssistant: ${"a".repeat(120)}`
      )
    );
  });

  test("streaming buffers split UTF-8 events and gates terminal markers on capture", () => {
    const script = String.raw`
import asyncio, importlib.util, json, sys, types
httpx = types.ModuleType("httpx")
httpx.AsyncClient = object
sys.modules["httpx"] = httpx
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = types.SimpleNamespace()
sys.modules["aiohttp"] = aiohttp
spec = importlib.util.spec_from_file_location("cortex_gateway", "scripts/cortex-memory-gateway.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def chat_event(text, ending):
    payload = {"choices": [{"delta": {"content": text}}]}
    return b"data: " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + ending

nonterminal = chat_event("Hello ", b"\r\n\r\n") + chat_event("🌍 café", b"\n\n")
terminal = b"data: [DONE]\r\n\r\n"
wire = nonterminal + terminal

async def split_bytes(value):
    for byte in value:
        yield bytes([byte])

async def held_open(value):
    yield value
    await asyncio.Event().wait()

async def run():
    receipt = {"eventId": "66666666-6666-4666-8666-666666666666", "status": "accepted", "replayed": False}

    chat_writes = []
    chat_captured = []
    chat_started = asyncio.Event()
    chat_release = asyncio.Event()
    async def blocking_chat_capture(user, assistant, session_id, turn_id):
        chat_captured.append(assistant)
        chat_started.set()
        await chat_release.wait()
        return receipt
    async def chat_write(chunk):
        chat_writes.append(chunk)
    module.capture_exchange = blocking_chat_capture
    chat_task = asyncio.create_task(module._forward_chat_sse(
        split_bytes(wire), chat_write, "short user", "session", "turn"
    ))
    await chat_started.wait()
    chat_before = b"".join(chat_writes)
    chat_pending = not chat_task.done()
    chat_release.set()
    await chat_task
    chat_after = b"".join(chat_writes)

    open_chat_writes = []
    open_chat_started = asyncio.Event()
    open_chat_release = asyncio.Event()
    async def open_chat_capture(user, assistant, session_id, turn_id):
        open_chat_started.set()
        await open_chat_release.wait()
        return receipt
    async def open_chat_write(chunk):
        open_chat_writes.append(chunk)
    module.capture_exchange = open_chat_capture
    open_chat_task = asyncio.create_task(module._forward_chat_sse(
        held_open(wire), open_chat_write, "short user", "session", "turn"
    ))
    await asyncio.wait_for(open_chat_started.wait(), 1)
    open_chat_before = b"".join(open_chat_writes)
    open_chat_release.set()
    await asyncio.wait_for(open_chat_task, 1)
    open_chat_after = b"".join(open_chat_writes)

    missing_captures = []
    async def missing_capture(user, assistant, session_id, turn_id):
        missing_captures.append(assistant)
        return None
    chat_missing_writes = []
    async def chat_missing_write(chunk):
        chat_missing_writes.append(chunk)
    module.capture_exchange = missing_capture
    await module._forward_chat_sse(
        split_bytes(wire), chat_missing_write, "short user", "session", "turn"
    )

    responses_writes = []
    responses_captured = []
    responses_started = asyncio.Event()
    responses_release = asyncio.Event()
    async def blocking_responses_capture(user, assistant, session_id, turn_id):
        responses_captured.append(assistant)
        responses_started.set()
        await responses_release.wait()
        return receipt
    async def responses_write(chunk):
        responses_writes.append(chunk)
    module.capture_exchange = blocking_responses_capture
    responses_task = asyncio.create_task(module._forward_responses_sse(
        split_bytes(wire), responses_write, "short user", "session", "turn"
    ))
    await responses_started.wait()
    responses_before = b"".join(responses_writes).decode("utf-8")
    responses_pending = not responses_task.done()
    responses_release.set()
    await responses_task
    responses_after = b"".join(responses_writes).decode("utf-8")

    open_responses_writes = []
    open_responses_started = asyncio.Event()
    open_responses_release = asyncio.Event()
    async def open_responses_capture(user, assistant, session_id, turn_id):
        open_responses_started.set()
        await open_responses_release.wait()
        return receipt
    async def open_responses_write(chunk):
        open_responses_writes.append(chunk)
    module.capture_exchange = open_responses_capture
    open_responses_task = asyncio.create_task(module._forward_responses_sse(
        held_open(wire), open_responses_write, "short user", "session", "turn"
    ))
    await asyncio.wait_for(open_responses_started.wait(), 1)
    open_responses_before = b"".join(open_responses_writes).decode("utf-8")
    open_responses_release.set()
    await asyncio.wait_for(open_responses_task, 1)
    open_responses_after = b"".join(open_responses_writes).decode("utf-8")

    responses_missing_writes = []
    async def responses_missing_write(chunk):
        responses_missing_writes.append(chunk)
    module.capture_exchange = missing_capture
    await module._forward_responses_sse(
        split_bytes(wire), responses_missing_write, "short user", "session", "turn"
    )

    no_capture_wire = b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: [DONE]\n\n"
    chat_no_capture_writes = []
    async def chat_no_capture_write(chunk):
        chat_no_capture_writes.append(chunk)
    await module._forward_chat_sse(
        split_bytes(no_capture_wire), chat_no_capture_write, None, "session", "turn"
    )
    responses_no_capture_writes = []
    async def responses_no_capture_write(chunk):
        responses_no_capture_writes.append(chunk)
    await module._forward_responses_sse(
        split_bytes(no_capture_wire), responses_no_capture_write, None, "session", "turn"
    )

    interrupted_captures = []
    async def interrupted_capture(user, assistant, session_id, turn_id):
        interrupted_captures.append(assistant)
        return receipt
    module.capture_exchange = interrupted_capture
    chat_interrupted_writes = []
    async def chat_interrupted_write(chunk):
        chat_interrupted_writes.append(chunk)
    await module._forward_chat_sse(
        split_bytes(nonterminal), chat_interrupted_write, "short user", "session", "turn"
    )
    responses_interrupted_writes = []
    async def responses_interrupted_write(chunk):
        responses_interrupted_writes.append(chunk)
    await module._forward_responses_sse(
        split_bytes(nonterminal), responses_interrupted_write, "short user", "session", "turn"
    )

    print(json.dumps({
        "wire": wire.decode("utf-8"),
        "nonterminal": nonterminal.decode("utf-8"),
        "chat_before": chat_before.decode("utf-8"),
        "chat_after": chat_after.decode("utf-8"),
        "chat_pending": chat_pending,
        "chat_captured": chat_captured,
        "chat_missing": b"".join(chat_missing_writes).decode("utf-8"),
        "open_chat_before": open_chat_before.decode("utf-8"),
        "open_chat_after": open_chat_after.decode("utf-8"),
        "responses_before": responses_before,
        "responses_after": responses_after,
        "responses_pending": responses_pending,
        "responses_captured": responses_captured,
        "responses_missing": b"".join(responses_missing_writes).decode("utf-8"),
        "open_responses_before": open_responses_before,
        "open_responses_after": open_responses_after,
        "chat_no_capture": b"".join(chat_no_capture_writes).decode("utf-8"),
        "responses_no_capture": b"".join(responses_no_capture_writes).decode("utf-8"),
        "chat_interrupted": b"".join(chat_interrupted_writes).decode("utf-8"),
        "responses_interrupted": b"".join(responses_interrupted_writes).decode("utf-8"),
        "interrupted_captures": interrupted_captures,
        "missing_captures": missing_captures,
    }, ensure_ascii=False))

asyncio.run(run())
`;
    const result = spawnSync("python3", ["-c", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim());

    expect(output.chat_pending).toBe(true);
    expect(output.chat_before).toBe(output.nonterminal);
    expect(output.chat_after).toBe(output.wire);
    expect(output.chat_captured).toEqual(["Hello 🌍 café"]);
    expect(output.chat_missing).toBe(output.nonterminal);
    expect(output.open_chat_before).toBe(output.nonterminal);
    expect(output.open_chat_after).toBe(output.wire);

    expect(output.responses_pending).toBe(true);
    expect(output.responses_before).toContain('"type": "response.output_text.delta"');
    expect(output.responses_before).not.toContain('"type": "response.output_text.done"');
    expect(output.responses_before).not.toContain('"type": "response.done"');
    expect(output.responses_after).toContain('"type": "response.output_text.done"');
    expect(output.responses_after).toContain('"type": "response.done"');
    expect(output.responses_captured).toEqual(["Hello 🌍 café"]);
    expect(output.responses_missing).toContain('"type": "response.output_text.delta"');
    expect(output.responses_missing).not.toContain('"type": "response.output_text.done"');
    expect(output.responses_missing).not.toContain('"type": "response.done"');
    expect(output.open_responses_before).not.toContain('"type": "response.done"');
    expect(output.open_responses_after).toContain('"type": "response.done"');
    expect(output.chat_no_capture).toContain("data: [DONE]");
    expect(output.responses_no_capture).toContain('"type": "response.output_text.done"');
    expect(output.responses_no_capture).toContain('"type": "response.done"');
    expect(output.chat_interrupted).toBe(output.nonterminal);
    expect(output.responses_interrupted).toContain('"type": "response.output_text.delta"');
    expect(output.responses_interrupted).not.toContain('"type": "response.output_text.done"');
    expect(output.responses_interrupted).not.toContain('"type": "response.done"');
    expect(output.interrupted_captures).toEqual([]);
    expect(output.missing_captures).toEqual(["Hello 🌍 café", "Hello 🌍 café"]);
  });
});
