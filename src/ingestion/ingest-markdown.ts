import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createMemoryServices } from "../memory/index.js";
import type {
  IngestReceipt,
  IngestService,
  IngestStatus,
} from "../memory/types.js";
import "dotenv/config";

export interface FileIngestOptions {
  agentId: number;
  sourcePath: string;
  sourceType?: string;
  priority?: 0 | 1 | 2 | 3 | 4;
}

export interface FileIngestDependencies {
  ingest?: IngestService;
  waitMs?: number;
  /** Canonical snapshot paths must remain inside this root. */
  allowedRoot?: string;
  /** Maximum bytes read from one source snapshot. */
  maxBytes?: number;
}

export interface StableFileReadDependencies {
  allowedRoot?: string;
  maxBytes?: number;
  /** @internal A synchronization seam used to prove atomic replacement safety. */
  beforePathRevalidation?: () => void;
}

export interface FileSnapshot {
  canonicalPath: string;
  content: string;
  contentHash: string;
  sourceVersion: string;
  idempotencyKey: string;
  observedAt: string;
}

export class SourceSnapshotReadError extends Error {
  constructor(
    readonly code:
      | "empty_source_snapshot"
      | "file_changed_during_read"
      | "source_outside_allowed_root"
      | "source_snapshot_too_large"
  ) {
    super(
      code === "empty_source_snapshot"
        ? "Empty source snapshots are not supported; the last good snapshot remains current"
        : code === "source_outside_allowed_root"
          ? "The source snapshot resolved outside its allowed root"
          : code === "source_snapshot_too_large"
            ? "The source snapshot exceeds the configured byte limit"
        : "The source file changed while Cortex was reading it"
    );
    this.name = "SourceSnapshotReadError";
  }
}

export class SourceSnapshotNotIndexedError extends Error {
  constructor(readonly receipt: IngestReceipt) {
    super(`Source snapshot ${receipt.eventId} is ${receipt.status}, not indexed`);
    this.name = "SourceSnapshotNotIndexedError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameStableFile(
  left: BigIntStats,
  right: BigIntStats
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function configuredSnapshotMaxBytes(): number {
  const configured = Number.parseInt(
    process.env.CORTEX_IMPORT_MAX_BYTES ?? "",
    10
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 10 * 1024 * 1024;
}

export function readStableFileSnapshot(
  sourcePath: string,
  dependencies: StableFileReadDependencies = {}
): FileSnapshot {
  const canonicalPath = realpathSync(sourcePath);
  if (dependencies.allowedRoot) {
    const allowedRoot = realpathSync(dependencies.allowedRoot);
    if (!isPathInside(allowedRoot, canonicalPath)) {
      throw new SourceSnapshotReadError("source_outside_allowed_root");
    }
  }
  const maxBytes = dependencies.maxBytes ?? configuredSnapshotMaxBytes();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Source snapshot maxBytes must be a positive safe integer");
  }
  const descriptor = openSync(canonicalPath, "r");
  let before: BigIntStats;
  let after: BigIntStats;
  let pathTargetAfter: BigIntStats | undefined;
  let canonicalPathAfter: string | undefined;
  let bytes: Buffer;
  try {
    before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("Source snapshot path is not a file");
    if (before.size > BigInt(maxBytes)) {
      throw new SourceSnapshotReadError("source_snapshot_too_large");
    }
    const readBuffer = Buffer.alloc(Number(before.size) + 1);
    let bytesRead = 0;
    while (bytesRead < readBuffer.length) {
      const count = readSync(
        descriptor,
        readBuffer,
        bytesRead,
        readBuffer.length - bytesRead,
        null
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) {
      throw new SourceSnapshotReadError("source_snapshot_too_large");
    }
    bytes = readBuffer.subarray(0, bytesRead);
    after = fstatSync(descriptor, { bigint: true });
    dependencies.beforePathRevalidation?.();
    try {
      canonicalPathAfter = realpathSync(sourcePath);
      pathTargetAfter = statSync(canonicalPathAfter, { bigint: true });
    } catch {
      // A disappearing or temporarily invalid path is a changed snapshot.
    }
  } finally {
    closeSync(descriptor);
  }
  if (
    !sameStableFile(before, after) ||
    canonicalPathAfter !== canonicalPath ||
    !pathTargetAfter ||
    !sameStableFile(after, pathTargetAfter)
  ) {
    throw new SourceSnapshotReadError("file_changed_during_read");
  }

  const content = bytes.toString("utf8");
  if (!content.trim()) {
    throw new SourceSnapshotReadError("empty_source_snapshot");
  }
  const contentHash = sha256(bytes);
  const sourceVersion = `file-v1:${sha256(
    JSON.stringify({
      canonicalPath,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      size: before.size.toString(),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      birthtimeNs: before.birthtimeNs.toString(),
      contentHash,
    })
  )}`;
  const observedAt = new Date(
    Number(before.mtimeNs / 1_000_000n)
  ).toISOString();
  return {
    canonicalPath,
    content,
    contentHash,
    sourceVersion,
    idempotencyKey: `replace-source:file:v1:${sha256(
      `${canonicalPath}\0${sourceVersion}`
    )}`,
    observedAt,
  };
}

/** Determine policy priority from file identity. Novelty never changes it. */
export function inferFilePriority(filePath: string): 0 | 1 | 2 | 3 | 4 {
  const normalized = filePath.replaceAll("\\", "/");
  const name = basename(filePath).toLowerCase();
  if (["memory.md", "standing-orders.md", "soul.md", "agents.md"].includes(name)) {
    return 0;
  }
  if (name === "user.md" || /^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
    return 1;
  }
  if (name.startsWith("enhancement") || normalized.includes("/logs/")) {
    return 2;
  }
  if (
    normalized.includes("/telegram/") ||
    normalized.includes("/limitless/")
  ) {
    return 3;
  }
  return 2;
}

export function classifyIngestReceipt(
  receipt: IngestReceipt
): "queued" | "indexed" | "failed" | "rejected" {
  if (receipt.status === "indexed") return "indexed";
  if (receipt.status === "rejected") return "rejected";
  if (receipt.status === "failed" && !receipt.failure?.retryable) return "failed";
  return "queued";
}

/** Submit one whole-file source snapshot through durable acceptance. */
export async function submitFileSnapshot(
  options: FileIngestOptions,
  dependencies: FileIngestDependencies = {}
): Promise<IngestReceipt> {
  const snapshot = readStableFileSnapshot(options.sourcePath, {
    allowedRoot: dependencies.allowedRoot,
    maxBytes: dependencies.maxBytes,
  });
  const ingest = dependencies.ingest ?? createMemoryServices().ingest;
  const accepted = await ingest.accept({
    agentId: options.agentId,
    content: snapshot.content,
    idempotencyKey: snapshot.idempotencyKey,
    source: snapshot.canonicalPath,
    sourceVersion: snapshot.sourceVersion,
    sourceType: options.sourceType ?? "markdown",
    observedAt: snapshot.observedAt,
    requestedPriority: options.priority ?? inferFilePriority(snapshot.canonicalPath),
    projectionMode: "replace_source",
  });
  const waitMs = dependencies.waitMs ?? 20_000;
  if (
    waitMs <= 0 ||
    !new Set<IngestStatus>(["accepted", "processing"]).has(accepted.status)
  ) {
    return accepted;
  }
  try {
    const waited = await ingest.wait(options.agentId, accepted.eventId, waitMs);
    return { ...waited, replayed: accepted.replayed };
  } catch {
    console.error("[ingest] Optional source snapshot wait failed", {
      eventId: accepted.eventId,
      code: "source_snapshot_wait_failed",
    });
    return accepted;
  }
}

/** Compatibility wrapper: a number is returned only after indexing is proven. */
export async function ingestFile(options: FileIngestOptions): Promise<number> {
  const receipt = await submitFileSnapshot(options);
  if (receipt.status !== "indexed") {
    throw new SourceSnapshotNotIndexedError(receipt);
  }
  return receipt.chunksStored;
}

function findMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(directory).sort()) {
      const fullPath = join(directory, entry);
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) files.push(...findMarkdownFiles(fullPath));
        else if (entry.endsWith(".md")) files.push(fullPath);
      } catch {
        // Optional/unreadable paths are skipped during discovery.
      }
    }
  } catch {
    // Optional corpus directories may not exist.
  }
  return files;
}

export interface CorpusReceiptSummary {
  eventId: string;
  source: string;
  status: IngestReceipt["status"];
  replayed: boolean;
  failureCode?: string;
}

export interface CorpusIngestResult {
  discovered: number;
  submitted: number;
  queued: number;
  indexed: number;
  failed: number;
  rejected: number;
  readFailed: number;
  submissionFailed: number;
  replayed: number;
  chunksIndexed: number;
  receipts: CorpusReceiptSummary[];
  omittedReceipts: number;
  chunksStored: number;
  memoriesCreated: number;
  synapsesCreated: number;
  filesProcessed: number;
  filesFailed: number;
}

export interface CorpusIngestDependencies extends FileIngestDependencies {
  concurrency?: number;
  maxReceiptSummaries?: number;
}

interface CorpusFile {
  path: string;
  sourceType: string;
}

export async function ingestCorpus(
  agentId: number,
  dependencies: CorpusIngestDependencies = {}
): Promise<CorpusIngestResult> {
  const configuredWorkspace = process.env.CORTEX_WORKSPACE;
  if (process.env.CORTEX_HEADLESS === "true" && !configuredWorkspace) {
    throw new Error(
      "CORTEX_WORKSPACE must be explicitly configured for hosted corpus ingestion"
    );
  }

  const workspace = realpathSync(configuredWorkspace || process.cwd());
  if (process.env.CORTEX_HEADLESS === "true") {
    const configuredImportRoot = process.env.CORTEX_IMPORT_ROOT;
    if (!configuredImportRoot) {
      throw new Error("CORTEX_IMPORT_ROOT must be configured for hosted corpus ingestion");
    }
    const importRoot = realpathSync(configuredImportRoot);
    if (!isPathInside(importRoot, workspace)) {
      throw new Error("CORTEX_WORKSPACE must stay inside CORTEX_IMPORT_ROOT");
    }
  }

  const sourceDirectories = [
    { path: join(workspace, "memory"), sourceType: "markdown" },
    { path: join(workspace, "logs"), sourceType: "markdown" },
    { path: join(workspace, "context/telegram"), sourceType: "telegram" },
    { path: join(workspace, "context/limitless/lifelogs"), sourceType: "limitless" },
    { path: join(workspace, "context/limitless/lifelogs-new"), sourceType: "limitless" },
    { path: join(workspace, "context/limitless/pulls"), sourceType: "limitless" },
  ];
  const coreFiles = [
    "MEMORY.md",
    "STANDING-ORDERS.md",
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
  ];
  const corpusFiles: CorpusFile[] = [];
  for (const name of coreFiles) {
    const path = join(workspace, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() && stat.isFile()) {
        corpusFiles.push({ path, sourceType: "markdown" });
      }
    } catch {
      // Missing core files are optional.
    }
  }
  for (const directory of sourceDirectories) {
    for (const path of findMarkdownFiles(directory.path)) {
      if (!coreFiles.some((name) => path.endsWith(`${sep}${name}`))) {
        corpusFiles.push({ path, sourceType: directory.sourceType });
      }
    }
  }
  const deduplicated = [
    ...new Map(corpusFiles.map((file) => [file.path, file])).values(),
  ];
  if (deduplicated.length === 0) {
    throw new Error(`No Cortex corpus files were found in ${workspace}`);
  }

  const ingest = dependencies.ingest ?? createMemoryServices().ingest;
  const concurrency = Math.min(
    Math.max(1, Math.trunc(dependencies.concurrency ?? 4)),
    16
  );
  type SubmittedSnapshot = {
    source: string;
    receipt: IngestReceipt;
  };
  type SettledSnapshot = CorpusReceiptSummary & {
    bucket: ReturnType<typeof classifyIngestReceipt>;
    chunks: number;
    chunksCreated: number;
    synapses: number;
  };
  const submittedSnapshots: SubmittedSnapshot[] = [];
  let readFailed = 0;
  let submissionFailed = 0;
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, deduplicated.length) },
      async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          const file = deduplicated[index];
          if (!file) return;
          try {
            const receipt = await submitFileSnapshot(
              {
                agentId,
                sourcePath: file.path,
                sourceType: file.sourceType,
              },
              { ingest, waitMs: 0, allowedRoot: workspace }
            );
            submittedSnapshots.push({ source: file.path, receipt });
          } catch (error) {
            if (error instanceof SourceSnapshotReadError) readFailed += 1;
            else submissionFailed += 1;
            console.error("[ingest] Source snapshot submission failed", {
              source: file.path,
              code:
                error instanceof SourceSnapshotReadError
                  ? error.code
                  : "source_snapshot_submission_failed",
            });
          }
        }
      }
    )
  );

  // All files are durably accepted before optional polling begins. The shared
  // deadline bounds the whole polling phase rather than multiplying per file.
  const waitMs = Math.max(0, Math.trunc(dependencies.waitMs ?? 0));
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    let waitCursor = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, submittedSnapshots.length) },
        async () => {
          while (true) {
            const index = waitCursor;
            waitCursor += 1;
            const submitted = submittedSnapshots[index];
            if (!submitted) return;
            if (
              submitted.receipt.status !== "accepted" &&
              submitted.receipt.status !== "processing"
            ) {
              continue;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            try {
              const replayed = submitted.receipt.replayed;
              const waited = await ingest.wait(
                agentId,
                submitted.receipt.eventId,
                remaining
              );
              submitted.receipt = { ...waited, replayed };
            } catch {
              // Acceptance is already durable; retain its receipt on wait failure.
            }
          }
        }
      )
    );
  }

  const receipts: SettledSnapshot[] = submittedSnapshots.map(
    ({ source, receipt }) => ({
      eventId: receipt.eventId,
      source,
      status: receipt.status,
      replayed: receipt.replayed,
      failureCode: receipt.failure?.code,
      bucket: classifyIngestReceipt(receipt),
      chunks: receipt.status === "indexed" ? receipt.chunksStored : 0,
      chunksCreated: receipt.status === "indexed" ? receipt.chunksCreated : 0,
      synapses: receipt.status === "indexed" ? receipt.synapsesFormed : 0,
    })
  );

  const count = (bucket: ReturnType<typeof classifyIngestReceipt>) =>
    receipts.filter((receipt) => receipt.bucket === bucket).length;
  const chunksIndexed = receipts.reduce(
    (total, receipt) => total + receipt.chunks,
    0
  );
  const memoriesCreated = receipts.reduce(
    (total, receipt) =>
      total +
      (receipt.bucket === "indexed" && !receipt.replayed
        ? receipt.chunksCreated
        : 0),
    0
  );
  const synapsesCreated = receipts.reduce(
    (total, receipt) =>
      total + (receipt.bucket === "indexed" && !receipt.replayed ? receipt.synapses : 0),
    0
  );
  const maxReceiptSummaries = Math.min(
    Math.max(0, Math.trunc(dependencies.maxReceiptSummaries ?? 100)),
    1_000
  );
  const receiptPriority: Record<
    ReturnType<typeof classifyIngestReceipt>,
    number
  > = { failed: 0, rejected: 1, queued: 2, indexed: 3 };
  const summaries = [...receipts]
    .sort(
      (left, right) =>
        receiptPriority[left.bucket] - receiptPriority[right.bucket] ||
        left.source.localeCompare(right.source)
    )
    .slice(0, maxReceiptSummaries)
    .map(
      ({
        bucket: _bucket,
        chunks: _chunks,
        chunksCreated: _chunksCreated,
        synapses: _synapses,
        ...summary
      }) => summary
    );
  const result: CorpusIngestResult = {
    discovered: deduplicated.length,
    submitted: receipts.length,
    queued: count("queued"),
    indexed: count("indexed"),
    failed: count("failed"),
    rejected: count("rejected"),
    readFailed,
    submissionFailed,
    replayed: receipts.filter((receipt) => receipt.replayed).length,
    chunksIndexed,
    receipts: summaries,
    omittedReceipts: receipts.length - summaries.length,
    chunksStored: chunksIndexed,
    memoriesCreated,
    synapsesCreated,
    filesProcessed: receipts.length,
    filesFailed:
      count("failed") +
      count("rejected") +
      readFailed +
      submissionFailed,
  };
  console.error("[ingest] Corpus snapshot submissions settled", {
    discovered: result.discovered,
    submitted: result.submitted,
    queued: result.queued,
    indexed: result.indexed,
    failed: result.failed,
    rejected: result.rejected,
    readFailed: result.readFailed,
    submissionFailed: result.submissionFailed,
  });
  return result;
}

if (
  process.argv[1]?.endsWith("ingest-markdown.ts") ||
  process.argv[1]?.endsWith("ingest-markdown.js")
) {
  const agentExternalId = process.argv[2] || "arlo";
  void (async () => {
    const { initDatabase } = await import("../db/index.js");
    await initDatabase();
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
      console.error(`[ingest] Created agent: ${agent.name} (id: ${agent.id})`);
    }
    await ingestCorpus(agent.id);
  })();
}
