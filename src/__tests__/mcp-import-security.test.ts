import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImportFile } from "../mcp/import-security.js";

describe("MCP import path security", () => {
  const originalRoot = process.env.CORTEX_IMPORT_ROOT;
  const originalLimit = process.env.CORTEX_IMPORT_MAX_BYTES;

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CORTEX_IMPORT_ROOT;
    else process.env.CORTEX_IMPORT_ROOT = originalRoot;
    if (originalLimit === undefined) delete process.env.CORTEX_IMPORT_MAX_BYTES;
    else process.env.CORTEX_IMPORT_MAX_BYTES = originalLimit;
  });

  test("accepts a supported regular file inside the import root", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-import-"));
    const nested = join(root, "nested");
    mkdirSync(nested);
    const file = join(nested, "memory.md");
    writeFileSync(file, "safe memory");
    process.env.CORTEX_IMPORT_ROOT = root;

    expect(resolveImportFile("nested/memory.md")).toBe(file);
  });

  test("rejects traversal and symlinks that escape the import root", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-import-"));
    const outside = mkdtempSync(join(tmpdir(), "cortex-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    symlinkSync(secret, join(root, "linked.txt"));
    process.env.CORTEX_IMPORT_ROOT = root;

    expect(() => resolveImportFile(secret)).toThrow(/inside the configured import directory/);
    expect(() => resolveImportFile("linked.txt")).toThrow(/inside the configured import directory/);
  });

  test("rejects unsupported types and oversized files", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-import-"));
    writeFileSync(join(root, "script.sh"), "echo unsafe");
    writeFileSync(join(root, "large.txt"), "12345");
    process.env.CORTEX_IMPORT_ROOT = root;

    expect(() => resolveImportFile("script.sh")).toThrow(/unsupported import file type/);
    process.env.CORTEX_IMPORT_MAX_BYTES = "4";
    expect(() => resolveImportFile("large.txt")).toThrow(/import limit/);
  });
});

