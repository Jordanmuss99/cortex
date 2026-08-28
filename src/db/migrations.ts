import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";

export type MigrationId = `${number}_${string}`;

export interface MigrationFile {
  id: MigrationId;
  path: string;
  sql: string;
  sha256: string;
}

export interface MigrationResult {
  applied: MigrationId[];
  alreadyApplied: MigrationId[];
  current: MigrationId;
}

export interface SchemaReadiness {
  ready: boolean;
  current: MigrationId | null;
  required: readonly MigrationId[];
  reason?: "unreachable" | "missing" | "checksum_mismatch";
}

export const REQUIRED_MIGRATIONS = [
  "009_oauth_authority",
  "010_memory_lifecycle",
] as const satisfies readonly MigrationId[];
export const FROZEN_MIGRATION_SHA256: Readonly<Partial<Record<MigrationId, string>>> = Object.freeze({
  "009_oauth_authority": "e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80",
});
export const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../db/migrations", import.meta.url)
);

const MIGRATION_FILE_PATTERN = /^(\d{3}_[a-z0-9][a-z0-9_]*)\.sql$/;
const MIGRATION_LOCK_NAMESPACE = 0x43525458; // "CRTX"
const MIGRATION_LOCK_RESOURCE = 0x4f415554; // "OAUT"
const MUTABLE_MIGRATION_IDS = new Set<MigrationId>(["010_memory_lifecycle"]);

interface MigrationLedgerRow {
  id: string;
  sha256: string;
}

export class MigrationIntegrityError extends Error {
  readonly reason: "unreachable" | "missing" | "checksum_mismatch";

  constructor(
    reason: "unreachable" | "missing" | "checksum_mismatch",
    message: string
  ) {
    super(message);
    this.name = "MigrationIntegrityError";
    this.reason = reason;
  }
}

export class MutableMigrationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutableMigrationSafetyError";
  }
}

function containsMutableMigration(files: readonly MigrationFile[]): boolean {
  return files.some((file) => MUTABLE_MIGRATION_IDS.has(file.id));
}

function assertMutableMigrationEnvironment(files: readonly MigrationFile[]): void {
  if (!containsMutableMigration(files)) return;

  const markedDisposable =
    process.env.CORTEX_MEMORY_TEST_DISPOSABLE === "1" ||
    process.env.MCP_OAUTH_TEST_DISPOSABLE === "1";
  let ownerUrl: URL | null = null;
  try {
    ownerUrl = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    ownerUrl = null;
  }
  const safeOwnerUrl =
    ownerUrl !== null &&
    new Set(["postgres:", "postgresql:"]).has(ownerUrl.protocol) &&
    ownerUrl.hostname === "127.0.0.1" &&
    decodeURIComponent(ownerUrl.pathname) === "/cortex_test" &&
    decodeURIComponent(ownerUrl.username) === "cortex_test" &&
    !ownerUrl.search &&
    !ownerUrl.hash;

  if (!markedDisposable || !safeOwnerUrl) {
    throw new MutableMigrationSafetyError(
      "Mutable migration 010 is locked to a guarded disposable loopback cortex_test owner database until its release checksum is frozen"
    );
  }
}

async function assertMutableMigrationDatabaseIdentity(
  sql: Sql,
  files: readonly MigrationFile[]
): Promise<void> {
  if (!containsMutableMigration(files)) return;
  const identity = (await sql`
    SELECT SESSION_USER::text AS session_user
  `) as unknown as Array<{ session_user: string }>;
  if (identity.length !== 1 || identity[0].session_user !== "cortex_test") {
    throw new MutableMigrationSafetyError(
      "Mutable migration 010 requires the disposable cortex_test owner identity"
    );
  }
}

function asMigrationId(value: string): MigrationId {
  return value as MigrationId;
}

function migrationChecksum(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function newestMigration(rows: readonly MigrationLedgerRow[]): MigrationId | null {
  const ids = rows
    .map((row) => row.id)
    .filter((id): id is MigrationId => MIGRATION_FILE_PATTERN.test(`${id}.sql`))
    .sort((left, right) => left.localeCompare(right));
  return ids.at(-1) ?? null;
}

function migrationMap(files: readonly MigrationFile[]): Map<MigrationId, MigrationFile> {
  return new Map(files.map((file) => [file.id, file]));
}

function verifyRequiredMigrationSet(
  files: readonly MigrationFile[],
  required: readonly MigrationId[]
): void {
  const requiredIds = new Set(required);
  if (
    requiredIds.size !== required.length ||
    files.length !== required.length ||
    files.some((file) => !requiredIds.has(file.id))
  ) {
    throw new MigrationIntegrityError(
      "missing",
      `Checked-in migrations must exactly match the required set: ${required.join(", ")}`
    );
  }
}

async function loadRequiredMigrations(
  directory: string,
  required: readonly MigrationId[]
): Promise<MigrationFile[]> {
  const files = await discoverMigrations(directory);
  if (files.length === 0) {
    throw new MigrationIntegrityError("missing", "No checked-in SQL migrations were found");
  }
  verifyRequiredMigrationSet(files, required);
  for (const file of files) {
    const frozenChecksum = FROZEN_MIGRATION_SHA256[file.id];
    if (frozenChecksum !== undefined && file.sha256 !== frozenChecksum) {
      throw new MigrationIntegrityError(
        "checksum_mismatch",
        `Checked-in migration ${file.id} does not match its frozen release checksum`
      );
    }
  }
  return files;
}

export async function preflightCheckedInMigrations(
  directory: string,
  required: readonly MigrationId[]
): Promise<void> {
  const files = await loadRequiredMigrations(directory, required);
  assertMutableMigrationEnvironment(files);
}

function verifyAppliedRows(
  rows: readonly MigrationLedgerRow[],
  files: ReadonlyMap<MigrationId, MigrationFile>
): void {
  for (const row of rows) {
    const id = asMigrationId(row.id);
    const file = files.get(id);
    if (!file) {
      throw new MigrationIntegrityError(
        "missing",
        `Applied migration ${row.id} has no checked-in SQL file`
      );
    }
    if (row.sha256 !== file.sha256) {
      throw new MigrationIntegrityError(
        "checksum_mismatch",
        `Applied migration ${row.id} does not match its checked-in checksum`
      );
    }
  }
}

export async function discoverMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));

  for (const entry of sqlEntries) {
    if (!MIGRATION_FILE_PATTERN.test(entry.name)) {
      throw new MigrationIntegrityError(
        "missing",
        `Invalid migration filename ${entry.name}; expected NNN_lower_snake_case.sql`
      );
    }
  }

  const migrations = await Promise.all(
    sqlEntries.map(async (entry): Promise<MigrationFile> => {
      const match = entry.name.match(MIGRATION_FILE_PATTERN);
      if (!match) {
        throw new MigrationIntegrityError("missing", `Invalid migration filename ${entry.name}`);
      }

      const path = resolve(directory, entry.name);
      const contents = await readFile(path);
      return {
        id: asMigrationId(match[1]),
        path,
        sql: contents.toString("utf8"),
        sha256: migrationChecksum(contents),
      };
    })
  );

  migrations.sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].id === migrations[index].id) {
      throw new MigrationIntegrityError(
        "missing",
        `Duplicate migration id ${migrations[index].id}`
      );
    }
  }

  return migrations;
}

export async function runCheckedInMigrations(
  sql: Sql,
  directory: string,
  required: readonly MigrationId[]
): Promise<MigrationResult> {
  // Loading includes the exact-set preflight and must precede sql.begin(): an
  // unapproved packaged file must not execute or receive a ledger row.
  const files = await loadRequiredMigrations(directory, required);
  assertMutableMigrationEnvironment(files);
  await assertMutableMigrationDatabaseIdentity(sql, files);

  const filesById = migrationMap(files);
  return await sql.begin(async (transaction) => {
    await transaction`SET LOCAL search_path = pg_catalog, public`;
    await transaction`
      SELECT pg_catalog.pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_RESOURCE})
    `;
    await transaction`
      CREATE TABLE IF NOT EXISTS public.cortex_schema_migrations (
        id TEXT PRIMARY KEY,
        sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const rows = (await transaction`
      SELECT id, sha256
      FROM public.cortex_schema_migrations
      ORDER BY id ASC
    `) as unknown as MigrationLedgerRow[];
    verifyAppliedRows(rows, filesById);

    const existing = new Set(rows.map((row) => row.id));
    const applied: MigrationId[] = [];
    const alreadyApplied: MigrationId[] = [];

    for (const file of files) {
      if (existing.has(file.id)) {
        alreadyApplied.push(file.id);
        continue;
      }

      await transaction.unsafe(file.sql);
      await transaction`
        INSERT INTO public.cortex_schema_migrations (id, sha256)
        VALUES (${file.id}, ${file.sha256})
      `;
      applied.push(file.id);
    }

    return {
      applied,
      alreadyApplied,
      current: files.at(-1)!.id,
    };
  });
}

export async function readSchemaReadiness(
  sql: Sql,
  required: readonly MigrationId[],
  directory = DEFAULT_MIGRATION_DIRECTORY
): Promise<SchemaReadiness> {
  let files: MigrationFile[];
  try {
    files = await discoverMigrations(directory);
  } catch {
    return { ready: false, current: null, required, reason: "missing" };
  }

  const filesById = migrationMap(files);
  try {
    verifyRequiredMigrationSet(files, required);
  } catch {
    return { ready: false, current: null, required, reason: "missing" };
  }

  try {
    const relation = (await sql`
      SELECT pg_catalog.to_regclass('public.cortex_schema_migrations') IS NOT NULL AS present
    `) as unknown as Array<{ present: boolean }>;
    if (!relation[0]?.present) {
      return { ready: false, current: null, required, reason: "missing" };
    }

    const rows = (await sql`
      SELECT id, sha256
      FROM public.cortex_schema_migrations
      ORDER BY id ASC
    `) as unknown as MigrationLedgerRow[];
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const current = newestMigration(rows);

    try {
      verifyAppliedRows(rows, filesById);
    } catch (error) {
      if (error instanceof MigrationIntegrityError) {
        return { ready: false, current, required, reason: error.reason };
      }
      throw error;
    }

    for (const id of required) {
      const row = rowsById.get(id);
      if (!row) {
        return { ready: false, current, required, reason: "missing" };
      }
      if (row.sha256 !== filesById.get(id)!.sha256) {
        return { ready: false, current, required, reason: "checksum_mismatch" };
      }
    }

    return { ready: true, current, required };
  } catch {
    return { ready: false, current: null, required, reason: "unreachable" };
  }
}

export async function assertRequiredMigrations(
  sql: Sql,
  required: readonly MigrationId[],
  directory = DEFAULT_MIGRATION_DIRECTORY
): Promise<void> {
  const readiness = await readSchemaReadiness(sql, required, directory);
  if (!readiness.ready) {
    throw new MigrationIntegrityError(
      readiness.reason ?? "missing",
      `Database schema is not ready (${readiness.reason ?? "unknown"}); required migrations: ${required.join(", ")}`
    );
  }
}
