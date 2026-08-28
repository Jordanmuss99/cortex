import "dotenv/config";
import {
  closeDatabaseConnection,
  initDatabase,
} from "./db/index.js";
import { createIngestWorker } from "./memory/ingest-worker.js";
import { createMemoryServiceDependencies } from "./memory/index.js";

const shutdown = new AbortController();
let receivedSignal: NodeJS.Signals | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    receivedSignal = signal;
    shutdown.abort();
  });
}

async function main(): Promise<void> {
  await initDatabase();
  const dependencies = createMemoryServiceDependencies();
  const worker = createIngestWorker(dependencies);
  console.error("[cortex-worker] Durable ingest worker started", {
    buildId: dependencies.config.buildId,
    concurrency: dependencies.config.ingestWorkerConcurrency,
  });
  await worker.run(shutdown.signal);
}

main()
  .catch((error) => {
    console.error("[cortex-worker] Fatal worker failure", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnection().catch(() => {});
    if (receivedSignal) {
      console.error("[cortex-worker] Stopped", { signal: receivedSignal });
    }
  });
