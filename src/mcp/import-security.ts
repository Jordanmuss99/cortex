import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMPORT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
]);

function configuredMaxBytes(): number {
  const parsed = Number.parseInt(process.env.CORTEX_IMPORT_MAX_BYTES || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_IMPORT_BYTES;
}

export function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const childPath = relative(rootPath, candidatePath);
  return childPath !== "" && !childPath.startsWith(`..${sep}`) && childPath !== ".." && !isAbsolute(childPath);
}

export function resolveImportFile(requestedPath: string): string {
  const configuredRoot = process.env.CORTEX_IMPORT_ROOT;
  if (!configuredRoot) {
    throw new Error("CORTEX_IMPORT_ROOT is not configured");
  }
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("file_path must be a non-empty path");
  }

  const importRoot = realpathSync(configuredRoot);
  const candidate = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(importRoot, requestedPath);
  const resolvedPath = realpathSync(candidate);

  if (!isPathInsideRoot(importRoot, resolvedPath)) {
    throw new Error("file_path must stay inside the configured import directory");
  }

  const fileStat = statSync(resolvedPath);
  if (!fileStat.isFile()) {
    throw new Error("file_path must identify a regular file");
  }
  if (fileStat.size > configuredMaxBytes()) {
    throw new Error(`file exceeds the ${configuredMaxBytes()} byte import limit`);
  }

  const extension = extname(resolvedPath).toLowerCase();
  if (!ALLOWED_IMPORT_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported import file type: ${extension || "no extension"}`);
  }

  return resolvedPath;
}

