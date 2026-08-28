import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Sql } from "postgres";
import {
  closeDatabaseConnection,
  runLegacyBuildMigrations,
  sqlClient,
} from "../src/db/index.js";
import {
  assertRequiredMigrations,
  DEFAULT_MIGRATION_DIRECTORY,
  REQUIRED_MIGRATIONS,
  preflightCheckedInMigrations,
  runCheckedInMigrations,
} from "../src/db/migrations.js";
import {
  assertOAuthBootstrap,
  bootstrapOAuthAuthority,
  type OAuthBootstrapConfig,
} from "../src/oauth/bootstrap.js";
import {
  OAUTH_GATEWAY_LOGIN_ROLE,
  OAUTH_OPERATOR_LOGIN_ROLE,
  assertOAuthOwnerDatabaseIdentity,
  provisionOAuthLoginRoles,
  validateOAuthRoleConfig,
  type OAuthRoleConfig,
} from "../src/oauth/roles.js";

export interface PrepareOAuthDatabaseOptions {
  migrationDirectory: string;
  roles: OAuthRoleConfig;
  bootstrap: OAuthBootstrapConfig;
}

export interface PrepareOAuthDatabaseDependencies {
  assertOwnerDatabaseIdentity(sql: Sql, roles: OAuthRoleConfig): Promise<void>;
  preflightMigrations(
    migrationDirectory: string,
    required: readonly (typeof REQUIRED_MIGRATIONS)[number][]
  ): Promise<void>;
  runLegacyMigrations(): Promise<void>;
  runMigrations(
    sql: Sql,
    migrationDirectory: string,
    required: readonly (typeof REQUIRED_MIGRATIONS)[number][]
  ): Promise<unknown>;
  provisionRoles(roles: OAuthRoleConfig): Promise<void>;
  bootstrapAuthority(sql: Sql, bootstrap: OAuthBootstrapConfig): Promise<unknown>;
  assertMigrations(
    sql: Sql,
    required: readonly (typeof REQUIRED_MIGRATIONS)[number][],
    migrationDirectory: string
  ): Promise<void>;
  assertBootstrap(sql: Sql, bootstrap: OAuthBootstrapConfig): Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: PrepareOAuthDatabaseDependencies = {
  assertOwnerDatabaseIdentity: assertOAuthOwnerDatabaseIdentity,
  preflightMigrations: preflightCheckedInMigrations,
  runLegacyMigrations: runLegacyBuildMigrations,
  runMigrations: runCheckedInMigrations,
  provisionRoles: provisionOAuthLoginRoles,
  bootstrapAuthority: bootstrapOAuthAuthority,
  assertMigrations: assertRequiredMigrations,
  assertBootstrap: assertOAuthBootstrap,
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionsFromEnvironment(): PrepareOAuthDatabaseOptions {
  const issuer = (process.env.ISSUER_URL || process.env.BASE_URL || "").trim();
  if (!issuer) throw new Error("ISSUER_URL or BASE_URL is required");

  return {
    migrationDirectory: DEFAULT_MIGRATION_DIRECTORY,
    roles: {
      ownerDatabaseUrl: requiredEnvironment("DATABASE_URL"),
      gatewayDatabaseUrl: requiredEnvironment("MCP_OAUTH_DATABASE_URL"),
      operatorDatabaseUrl: requiredEnvironment("MCP_OAUTH_OPERATOR_DATABASE_URL"),
      gatewayLoginRole: OAUTH_GATEWAY_LOGIN_ROLE,
      operatorLoginRole: OAUTH_OPERATOR_LOGIN_ROLE,
    },
    bootstrap: {
      issuer,
      subject: requiredEnvironment("MCP_OAUTH_USERNAME"),
      agentExternalId: requiredEnvironment("MCP_OAUTH_AGENT_ID"),
      allowedScopes: ["cortex:read", "cortex:write", "mcp"],
    },
  };
}

export async function prepareOAuthDatabase(
  options: PrepareOAuthDatabaseOptions,
  dependencies: PrepareOAuthDatabaseDependencies = DEFAULT_DEPENDENCIES
): Promise<void> {
  validateOAuthRoleConfig(options.roles);
  if (options.roles.ownerDatabaseUrl !== process.env.DATABASE_URL) {
    throw new Error("Prepare ownerDatabaseUrl must exactly match DATABASE_URL");
  }

  await dependencies.assertOwnerDatabaseIdentity(sqlClient, options.roles);
  await dependencies.preflightMigrations(
    options.migrationDirectory,
    REQUIRED_MIGRATIONS
  );
  await dependencies.runLegacyMigrations();
  await dependencies.runMigrations(
    sqlClient,
    options.migrationDirectory,
    REQUIRED_MIGRATIONS
  );
  await dependencies.provisionRoles(options.roles);
  await dependencies.bootstrapAuthority(sqlClient, options.bootstrap);
  await dependencies.assertMigrations(
    sqlClient,
    REQUIRED_MIGRATIONS,
    options.migrationDirectory
  );
  await dependencies.assertBootstrap(sqlClient, options.bootstrap);
}

async function main(): Promise<void> {
  try {
    console.log("[oauth-prepare] Preparing Cortex OAuth database authority...");
    await prepareOAuthDatabase(optionsFromEnvironment());
    console.log("[oauth-prepare] OAuth database authority is ready.");
  } finally {
    await closeDatabaseConnection();
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message =
      error instanceof Error && error.name !== "PostgresError"
        ? error.message
        : "database operation failed; PostgreSQL details were suppressed";
    console.error(`[oauth-prepare] Failed: ${message}`);
    process.exitCode = 1;
  });
}
