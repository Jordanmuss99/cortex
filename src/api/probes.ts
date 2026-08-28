import { Router, type Request, type Response } from "express";
import { createMemoryServices } from "../memory/index.js";
import type { MemoryServices } from "../memory/types.js";

export interface ProbeRuntimeState {
  isApplicationReady(): boolean;
}

export interface ProbeOptions {
  readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 2_000;
const READINESS_TIMEOUT = Symbol("readiness_timeout");

const alwaysReady: ProbeRuntimeState = {
  isApplicationReady: () => true,
};

export function createProbeRouter(
  services?: MemoryServices,
  runtimeState: ProbeRuntimeState = alwaysReady,
  options: ProbeOptions = {}
): Router {
  const router = Router();
  const sharedServices = services ?? createMemoryServices();
  const readinessTimeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new TypeError("readinessTimeoutMs must be a positive finite number");
  }

  // A client-side deadline alone would start another database query on the next
  // probe while the first one was still stalled. Keep exactly one underlying
  // check in flight and let each HTTP request apply its own bounded wait.
  let readinessInFlight: ReturnType<MemoryServices["health"]["readiness"]> | null =
    null;

  function currentReadinessCheck() {
    if (!readinessInFlight) {
      const check = Promise.resolve().then(() => sharedServices.health.readiness());
      readinessInFlight = check;
      void check.then(
        () => {
          if (readinessInFlight === check) readinessInFlight = null;
        },
        () => {
          if (readinessInFlight === check) readinessInFlight = null;
        }
      );
    }
    return readinessInFlight;
  }

  function waitForReadiness() {
    const check = currentReadinessCheck();
    return new Promise<Awaited<typeof check> | typeof READINESS_TIMEOUT>(
      (resolve, reject) => {
        const timeout = setTimeout(() => resolve(READINESS_TIMEOUT), readinessTimeoutMs);
        timeout.unref();
        void check.then(
          (readiness) => {
            clearTimeout(timeout);
            resolve(readiness);
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          }
        );
      }
    );
  }

  router.get("/livez", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok" });
  });

  router.get("/readyz", async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!runtimeState.isApplicationReady()) {
        res.status(503).json({ status: "not_ready" });
        return;
      }

      const readiness = await waitForReadiness();
      if (readiness === READINESS_TIMEOUT) {
        console.error("[cortex] Memory readiness check timed out", {
          errorType: "MemoryReadinessTimeout",
        });
        res.status(503).json({ status: "not_ready" });
        return;
      }
      if (!readiness.ready) {
        console.error("[cortex] Memory readiness check failed", {
          reasonCount: readiness.reasons.length,
        });
        res.status(503).json({ status: "not_ready" });
        return;
      }

      res.json({ status: "ok" });
    } catch {
      console.error("[cortex] Memory readiness check errored", {
        errorType: "MemoryReadinessError",
      });
      res.status(503).json({ status: "not_ready" });
    }
  });

  return router;
}
