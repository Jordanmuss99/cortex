import { assessMemoryReadiness } from "../memory/health.js";

describe("memory readiness evidence", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("requires checked migrations, the same build, and a recent worker heartbeat", () => {
    expect(
      assessMemoryReadiness({
        buildId: "build-a",
        now,
        schema: { ready: true },
        worker: {
          buildId: "build-a",
          status: "running",
          heartbeatAt: "2026-08-28T11:59:01.000Z",
        },
      })
    ).toEqual({ ready: true, buildId: "build-a", reasons: [] });
  });

  it.each([
    [
      "missing migration",
      { ready: false, reason: "missing" as const },
      {
        buildId: "build-a",
        status: "running" as const,
        heartbeatAt: "2026-08-28T11:59:30.000Z",
      },
      "schema_missing",
    ],
    [
      "stale heartbeat",
      { ready: true },
      {
        buildId: "build-a",
        status: "running" as const,
        heartbeatAt: "2026-08-28T11:58:29.000Z",
      },
      "ingest_worker_stale",
    ],
    [
      "different build",
      { ready: true },
      {
        buildId: "build-b",
        status: "running" as const,
        heartbeatAt: "2026-08-28T11:59:30.000Z",
      },
      "ingest_worker_build_mismatch",
    ],
  ])("stays not ready for %s", (_name, schema, worker, reason) => {
    expect(
      assessMemoryReadiness({ buildId: "build-a", now, schema, worker })
    ).toEqual({ ready: false, buildId: "build-a", reasons: [reason] });
  });

  it("treats a missing worker as not ready without exposing details publicly", () => {
    expect(
      assessMemoryReadiness({
        buildId: "build-a",
        now,
        schema: { ready: true },
        worker: null,
      })
    ).toEqual({
      ready: false,
      buildId: "build-a",
      reasons: ["ingest_worker_missing"],
    });
  });
});
