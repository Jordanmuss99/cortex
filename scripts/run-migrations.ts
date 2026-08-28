import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  closeDatabaseConnection,
  runLegacyBuildMigrations,
  sqlClient,
} from "../src/db/index.js";
import {
  DEFAULT_MIGRATION_DIRECTORY,
  REQUIRED_MIGRATIONS,
  preflightCheckedInMigrations,
  runCheckedInMigrations,
} from "../src/db/migrations.js";

export async function runMigrations(): Promise<void> {
  await preflightCheckedInMigrations(
    DEFAULT_MIGRATION_DIRECTORY,
    REQUIRED_MIGRATIONS
  );
  await runLegacyBuildMigrations();
  await runCheckedInMigrations(
    sqlClient,
    DEFAULT_MIGRATION_DIRECTORY,
    REQUIRED_MIGRATIONS
  );
}

async function main(): Promise<void> {
  try {
    console.log("[migrations] Running legacy Build 1-8 and checked-in migrations...");
    await runMigrations();
    console.log("[migrations] All migrations applied successfully.");
  } finally {
    await closeDatabaseConnection();
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[migrations] Failed:", error);
    process.exitCode = 1;
  });
}
