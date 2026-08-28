import type { IngestReceipt } from "../memory/types.js";
import {
  SourceSnapshotNotIndexedError,
  submitFileSnapshot,
  type FileIngestDependencies,
} from "./ingest-markdown.js";

export async function ingestTelegramFileReceipt(
  agentId: number,
  filePath: string,
  dependencies: FileIngestDependencies = {}
): Promise<IngestReceipt> {
  return submitFileSnapshot(
    {
      agentId,
      sourcePath: filePath,
      sourceType: "telegram",
      priority: 3,
    },
    dependencies
  );
}

export async function ingestTelegramFile(
  agentId: number,
  filePath: string
): Promise<number> {
  const receipt = await ingestTelegramFileReceipt(agentId, filePath);
  if (receipt.status !== "indexed") {
    throw new SourceSnapshotNotIndexedError(receipt);
  }
  return receipt.chunksStored;
}
