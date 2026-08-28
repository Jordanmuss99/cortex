import { pathToFileURL } from "node:url";
import { watch } from "chokidar";
import { eq } from "drizzle-orm";
import { initDatabase, db, schema } from "./db/index.js";
import {
  classifyIngestReceipt,
  submitFileSnapshot,
  type FileIngestDependencies,
} from "./ingestion/ingest-markdown.js";
import { ingestTelegramFileReceipt } from "./ingestion/ingest-telegram.js";
import { ingestLimitlessFileReceipt } from "./ingestion/ingest-limitless.js";
import type { IngestReceipt } from "./memory/types.js";
import "dotenv/config";

const DEBOUNCE_MS = 5 * 60 * 1000;

export function formatWatcherReceipt(
  filePath: string,
  receipt: IngestReceipt
): string {
  const bucket = classifyIngestReceipt(receipt);
  if (bucket === "indexed") {
    return `[watcher] Indexed: ${filePath} (event ${receipt.eventId}, ${receipt.chunksStored} chunks)`;
  }
  if (bucket === "rejected") {
    return receipt.failure?.code === "obsolete_source_snapshot"
      ? `[watcher] Superseded by a newer snapshot: ${filePath} (event ${receipt.eventId})`
      : `[watcher] Rejected: ${filePath} (event ${receipt.eventId}, code ${receipt.failure?.code ?? "rejected"})`;
  }
  if (bucket === "failed") {
    return `[watcher] Failed: ${filePath} (event ${receipt.eventId}, code ${receipt.failure?.code ?? "projection_failed"})`;
  }
  const retry = receipt.status === "failed" ? ", retry scheduled" : "";
  return `[watcher] Durably queued: ${filePath} (event ${receipt.eventId}${retry})`;
}

export async function ingestWatchedFile(
  agentId: number,
  filePath: string,
  dependencies: FileIngestDependencies = {}
): Promise<IngestReceipt> {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.includes("/telegram/")) {
    return ingestTelegramFileReceipt(agentId, filePath, dependencies);
  }
  if (normalized.includes("/limitless/")) {
    return ingestLimitlessFileReceipt(agentId, filePath, dependencies);
  }
  return submitFileSnapshot(
    {
      agentId,
      sourcePath: filePath,
      sourceType: "markdown",
    },
    dependencies
  );
}

/** File watcher for automatic durable source-snapshot submission. */
export async function startWatcher(): Promise<void> {
  await initDatabase();
  const pendingIngests = new Map<string, NodeJS.Timeout>();
  const agentExternalId = process.argv[2] || "arlo";
  const workspace = process.env.CORTEX_WORKSPACE || process.cwd();

  let [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.externalId, agentExternalId));
  if (!agent) {
    [agent] = await db
      .insert(schema.agents)
      .values({
        externalId: agentExternalId,
        name: agentExternalId.charAt(0).toUpperCase() + agentExternalId.slice(1),
        ownerId: "rez",
      })
      .returning();
  }

  const watchPaths = [
    `${workspace}/memory`,
    `${workspace}/MEMORY.md`,
    `${workspace}/STANDING-ORDERS.md`,
    `${workspace}/context/telegram`,
    `${workspace}/context/limitless`,
    `${workspace}/logs`,
  ];
  console.error(`[watcher] Watching for changes (agent: ${agent.name})`);
  console.error(`[watcher] Paths: ${watchPaths.join(", ")}`);
  console.error(`[watcher] Debounce: ${DEBOUNCE_MS / 1000}s`);

  const watcher = watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  });

  const queueIngest = (filePath: string): void => {
    if (!filePath.endsWith(".md")) return;
    const existing = pendingIngests.get(filePath);
    if (existing) clearTimeout(existing);
    pendingIngests.set(
      filePath,
      setTimeout(() => {
        pendingIngests.delete(filePath);
        void ingestWatchedFile(agent.id, filePath, { allowedRoot: workspace })
          .then((receipt) => console.error(formatWatcherReceipt(filePath, receipt)))
          .catch((error: unknown) => {
            console.error("[watcher] Snapshot submission failed", {
              source: filePath,
              code:
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "source_snapshot_submission_failed",
            });
          });
      }, DEBOUNCE_MS)
    );
    console.error(
      `[watcher] Change detected; debounce scheduled: ${filePath} (${DEBOUNCE_MS / 1000}s)`
    );
  };

  watcher
    .on("add", queueIngest)
    .on("change", queueIngest)
    .on("error", () =>
      console.error("[watcher] Watch service failed", { code: "watch_service_failed" })
    );
  process.on("SIGINT", () => {
    console.error("[watcher] Shutting down");
    void watcher.close().finally(() => process.exit(0));
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startWatcher();
}
