import { jest } from "@jest/globals";
import {
  ScreenCaptureUnavailableError,
  captureAndAnalyze,
  ingestObservation,
  resolveScreenCapturePlatform,
  shouldStoreScreenObservation,
} from "../perception/screen-observer.js";
import type {
  AcceptIngestInput,
  IngestReceipt,
  IngestService,
} from "../memory/types.js";

describe("screen observer platform safety", () => {
  const originalHeadless = process.env.CORTEX_HEADLESS;

  afterEach(() => {
    if (originalHeadless === undefined) {
      delete process.env.CORTEX_HEADLESS;
    } else {
      process.env.CORTEX_HEADLESS = originalHeadless;
    }
  });

  it("routes only supported desktop platforms", () => {
    expect(resolveScreenCapturePlatform("win32", false)).toBe("windows");
    expect(resolveScreenCapturePlatform("darwin", false)).toBe("macos");
  });

  it("stores by default and disables storage only for explicit false", () => {
    expect(shouldStoreScreenObservation(undefined)).toBe(true);
    expect(shouldStoreScreenObservation(null)).toBe(true);
    expect(shouldStoreScreenObservation(true)).toBe(true);
    expect(shouldStoreScreenObservation(false)).toBe(false);
  });

  it("rejects Linux instead of routing it through macOS commands", () => {
    expect(() => resolveScreenCapturePlatform("linux", false)).toThrow(
      expect.objectContaining({
        name: "ScreenCaptureUnavailableError",
        code: "screen_capture_unavailable",
        platform: "linux",
        reason: "unsupported_platform",
      })
    );
  });

  it("rejects headless mode even on an otherwise supported platform", () => {
    expect(() => resolveScreenCapturePlatform("win32", true)).toThrow(
      expect.objectContaining({
        code: "screen_capture_unavailable",
        reason: "headless",
      })
    );
  });

  it("fails before capture work in the hosted headless environment", async () => {
    process.env.CORTEX_HEADLESS = "true";

    await expect(captureAndAnalyze()).rejects.toBeInstanceOf(
      ScreenCaptureUnavailableError
    );
    await expect(captureAndAnalyze()).rejects.toMatchObject({
      code: "screen_capture_unavailable",
      reason: "headless",
    });
  });
});

describe("screen observation durable acceptance", () => {
  const acceptedReceipt: IngestReceipt = {
    eventId: "55555555-5555-4555-8555-555555555555",
    status: "accepted",
    replayed: false,
    nodeIds: [],
    effectivePriorities: [],
    chunksStored: 0,
    chunksCreated: 0,
    synapsesFormed: 0,
    totalAttempts: 0,
    manualRetryCount: 0,
    possibleUpdateOf: [],
    acceptedAt: "2026-08-29T01:02:03.000Z",
    warnings: [],
  };

  test("returns an accepted receipt without claiming a memory node", async () => {
    const accept = jest.fn(async () => acceptedReceipt);
    const ingest = {
      accept,
      get: jest.fn(),
      wait: jest.fn(),
      retryTerminalFailure: jest.fn(),
      deriveLegacyKey: jest.fn(),
    } as unknown as IngestService;
    const observation = {
      activeApp: "Terminal",
      windowTitle: "Cortex",
      description: "A terminal window showing Cortex health.",
      entities: ["Cortex"],
      timestamp: "2026-08-29T01:02:03.000Z",
      screenshotPath: null,
    };

    await expect(
      ingestObservation(7, observation, { ingest, waitMs: 0 })
    ).resolves.toEqual(acceptedReceipt);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 7,
        sourceType: "observation",
        observedAt: observation.timestamp,
        requestedPriority: 3,
        idempotencyKey: expect.stringMatching(/^observation:v1:[0-9a-f]{64}$/),
      })
    );
  });

  test("exact observation retry keeps its key while changed capture identity is distinct", async () => {
    const inputs: Array<{ idempotencyKey?: string }> = [];
    const ingest = {
      accept: jest.fn(async (input: AcceptIngestInput) => {
        inputs.push(input);
        return acceptedReceipt;
      }),
      get: jest.fn(),
      wait: jest.fn(),
      retryTerminalFailure: jest.fn(),
      deriveLegacyKey: jest.fn(),
    } as unknown as IngestService;
    const base = {
      activeApp: "Terminal",
      windowTitle: "Cortex",
      description: "Cortex is active.",
      entities: ["Cortex"],
      timestamp: "2026-08-29T01:02:03.000Z",
      screenshotPath: null,
    };

    await ingestObservation(7, base, { ingest, waitMs: 0 });
    await ingestObservation(7, base, { ingest, waitMs: 0 });
    await ingestObservation(
      7,
      { ...base, timestamp: "2026-08-29T01:02:04.000Z" },
      { ingest, waitMs: 0 }
    );
    await ingestObservation(
      7,
      { ...base, windowTitle: "Cortex Health" },
      { ingest, waitMs: 0 }
    );
    await ingestObservation(
      7,
      { ...base, description: "Cortex is active and indexing." },
      { ingest, waitMs: 0 }
    );

    expect(inputs[0].idempotencyKey).toBe(inputs[1].idempotencyKey);
    expect(inputs[2].idempotencyKey).not.toBe(inputs[0].idempotencyKey);
    expect(inputs[3].idempotencyKey).not.toBe(inputs[0].idempotencyKey);
    expect(inputs[4].idempotencyKey).not.toBe(inputs[0].idempotencyKey);
  });
});
