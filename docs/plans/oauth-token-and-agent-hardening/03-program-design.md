# Program Design: OAuth Revocation and Agent Isolation

## Scope and invariants

This document turns the approved architecture into an implementation contract. It does not contain implementation bodies.

The non-negotiable invariants are:

1. PostgreSQL is the only live OAuth authority after cutover. The v1 JSON file is immutable migration input, never a fallback writer.
2. Every v2 access or refresh token names one grant (`sid`) and one server-owned agent binding. No public request chooses another agent.
3. Every protected request checks the live grant, principal, binding, and agent. A database outage is `503 temporarily_unavailable`; revoked or invalid credentials are `401 invalid_token`.
4. Refresh rotation is transactional. Only one immediately previous token, with the identical semantic request fingerprint and within the configured grace period, may receive the already-created replacement. Every other reuse revokes the family.
5. A valid same-cookie, same-IP browser login session survives gateway restarts and grant revocation. A missing or changed cookie, changed trusted IP, expiry, principal epoch change, or security logout requires credentials again.
6. Hosted REST and MCP fail closed. Scope checks precede agent checks; agent mismatch is `403 agent_mismatch` without `WWW-Authenticate` and never reaches an upstream.
7. Raw REST and MCP remain privileged internal interfaces. Production Compose does not publish them; an explicit admin override exposes them on loopback only.
8. No token, authorization code, cookie, password, client secret, raw JTI, or raw IP address is stored or logged.

## Files

### Created

- `db/migrations/009_oauth_authority.sql` — the ordered, additive OAuth schema, indexes, constraints, group roles, redacted operator views, and fixed-search-path operator functions.
- `src/db/migrations.ts` — discovers checked-in SQL migrations, hashes them, serializes runners with a PostgreSQL advisory lock, maintains `cortex_schema_migrations`, and asserts the required version at runtime.
- `src/oauth/roles.ts` — validates and provisions the fixed gateway/operator LOGIN roles from secret-managed database URLs, then grants their NOLOGIN capability roles.
- `src/oauth/bootstrap.ts` — idempotently creates the configured issuer/subject principal and binds it to one existing `MCP_OAUTH_AGENT_ID`; it never creates an agent or silently replaces a binding.
- `scripts/prepare-oauth-database.ts` — the one-shot deployment entry point: existing idempotent Cortex build migrations, checked-in migration 009, login-role provisioning, bootstrap, and final assertions.
- `oauth-gateway/config.js` — validates all non-secret gateway configuration plus a separate, non-serializable secret boundary; it rejects missing, ambiguous, expired, or unsafe settings before listening without placing credentials in ordinary configuration or logs.
- `oauth-gateway/oauth-crypto.js` — domain-separated token signing/verification, opaque secret generation, deterministic refresh-token reconstruction, and keyed digests/fingerprints.
- `oauth-gateway/oauth-store.js` — all PostgreSQL OAuth queries and transactions; no HTTP or filesystem behavior.
- `oauth-gateway/legacy-state.js` — strict, bounded v1 JSON parsing/checksumming and immutable one-time client/code import.
- `oauth-gateway/agent-policy.js` — the complete hosted REST/MCP allowlist, raw selector inspection, canonical agent injection, and stable policy errors.
- `oauth-gateway/security-log.js` — structured, redacted security logging and audit metadata allowlisting.
- `oauth-gateway/app.js` — dependency-injected Express application and all OAuth, discovery, login, REST, and MCP handlers.
- `oauth-gateway/server-v2.js` — temporary database-authority executable used only by disposable and staging proofs in Slices 3–12; it has no JSON fallback. Slice 13 promotes this path to the normal container command only after the migration-first Compose stack is rollback-qualified.
- `oauth-gateway/admin.js` — local operator CLI for redacted listing, revocation, principal/binding disablement, security logout, rollout status, and restore invalidation.
- `oauth-gateway/oauth-crypto.test.js` — token, digest, fingerprint, legacy-token, and deterministic reconstruction unit tests.
- `oauth-gateway/oauth-store.integration.test.js` — real-PostgreSQL transaction, concurrency, revocation, migration, privilege, and readiness tests.
- `oauth-gateway/legacy-state.test.js` — strict parser, checksum, import, size-limit, and source-immutability tests.
- `oauth-gateway/agent-policy.test.js` — exhaustive hosted route/tool catalog, duplicate-selector, mismatch, and canonicalization tests.
- `oauth-gateway/admin.test.js` — command validation, redaction, confirmation, and operator-function tests.
- `src/__tests__/oauth-database.integration.test.ts` — migration ledger, bootstrap, role privilege, and service-startup tests against disposable PostgreSQL.
- `src/__tests__/health-agent-isolation.test.ts` — agent-scoped status-statistic regressions.
- `src/__tests__/procedural-agent-isolation.test.ts` — source-memory ownership and existing ID-based ownership regressions.
- `docker-compose.admin.yml` — explicit loopback-only DB, raw REST, raw MCP, and dashboard port bindings for maintenance.
- `docker-compose.test.yml` — disposable pgvector/PostgreSQL service with temporary storage for non-skipped integration tests.
- `scripts/run-oauth-integration-tests.mjs` — creates an isolated Compose project, applies migrations, runs both test suites, and always tears the project down.
- `scripts/verify-deployment-boundary.mjs` — rejects a rendered production Compose configuration that exposes raw services, crosses network boundaries, leaks owner/operator URLs, or starts before migration.
- `docs/runbooks/oauth-security.md` — backup, cutover, live-connector exercise, revoke, legacy-window closure, operator actions, rollback, and restore recovery.

### Changed

- `docs/plans/oauth-token-and-agent-hardening/00-status.md` — gate approvals, final slice checklist, and durable handoff notes.
- `.env.example` — documents every new variable name and purpose without values or credentials.
- `src/db/schema.ts` — mirrors the OAuth tables and enums for repository schema visibility; gateway runtime continues using explicit SQL.
- `src/db/index.ts` — separates the existing idempotent Build 1–8 migration routine from runtime schema assertion; services no longer continue against an unknown schema.
- `src/index.ts` — treats failed database/schema initialization as fatal instead of listening in a partially broken state.
- `src/api/health.ts` — makes every `/status?agentId=...` statistic agent-scoped while retaining aggregate status only on privileged raw REST.
- `src/api/procedural.ts` — validates source-memory ID shape/limit and maps ownership failures to one non-oracular client error.
- `src/procedural/index.ts` — normalizes source IDs and rechecks their ownership atomically with procedural-memory insertion.
- `src/mcp/server.ts` — keeps `agent_id` in every raw/internal schema, maps procedural ownership errors, and treats database/schema startup failure as fatal.
- `scripts/run-migrations.ts` — runs existing Build 1–8 migrations followed by the ordered SQL runner; it performs no OAuth bootstrap or legacy import.
- `package.json` — adds preparation, operator, deployment-boundary, and disposable OAuth integration-test commands; no new root dependency.
- `Dockerfile` — copies checked-in migrations and compiled preparation/admin support required by the one-shot migration image.
- `docker-compose.yml` — adds the one-shot migration service and admin profile, separates edge/private networks, removes raw host ports, gives each process only its database role, and uses `/readyz` for gateway health.
- `README.md` — points operators to the new migration-first startup, ChatGPT connector verification, and explicit admin override.
- `CONTRIBUTING.md` — records that runtime services assert schema and that only the one-shot migration command may run DDL.
- `oauth-gateway/server.js` — remains the existing v1 executable during the non-production Slices 3–12 so an intermediate checkout cannot accidentally cut over the live connector. Slice 13 replaces it with the small database-aware entry point after the release-candidate stack is proven; it then loads config and secrets, connects dependencies, imports legacy state once, starts, and shuts down cleanly.
- `oauth-gateway/chatgpt-tools.js` — clones hosted input schemas and removes the top-level `agent_id` property/requirement without mutating raw schemas or outputs.
- `oauth-gateway/chatgpt-tools.test.js` — locks all 29 tool names, schemas, security metadata, and hosted/raw separation.
- `oauth-gateway/server.test.js` — converts the existing spawn tests to DB-backed end-to-end flows and adds OAuth, policy, proxy, restart, and failure semantics.
- `oauth-gateway/package.json` — adds `postgres` and separate unit/integration test commands.
- `oauth-gateway/package-lock.json` — locks the gateway PostgreSQL dependency.
- `oauth-gateway/Dockerfile` — copies the new gateway modules and operator entry point.
- `scripts/verify-chatgpt-connector.mjs` — verifies the bound agent, hosted schemas, restart-safe refresh, revocation, legacy upgrade, and mismatch behavior without reading JSON as authority.

### Explicitly unchanged

- `init-cortex-db.sql` and `schema.sql` remain historical/base-install artifacts. Migration 009 is the authority for this feature; broad conversion of the older Cortex schema is outside this security patch.
- Raw/internal MCP input schemas continue exposing `agent_id` for trusted local/admin callers.
- The existing public OAuth route names, ChatGPT redirect URLs, issuer/resource URLs, JWT signing secret, and imported DCR client IDs remain stable through cutover.

## Types & signatures

### Migration, role, and bootstrap contracts

```ts
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

export function discoverMigrations(directory: string): Promise<MigrationFile[]>;
export function preflightCheckedInMigrations(
  directory: string,
  required: readonly MigrationId[]
): Promise<void>;
export function runCheckedInMigrations(
  sql: import("postgres").Sql,
  directory: string,
  required: readonly MigrationId[]
): Promise<MigrationResult>;
export function readSchemaReadiness(
  sql: import("postgres").Sql,
  required: readonly MigrationId[]
): Promise<SchemaReadiness>;
export function assertRequiredMigrations(
  sql: import("postgres").Sql,
  required: readonly MigrationId[]
): Promise<void>;
```

```ts
export interface OAuthRoleConfig {
  ownerDatabaseUrl: string;
  gatewayDatabaseUrl: string;
  operatorDatabaseUrl: string;
  gatewayLoginRole: "cortex_oauth_gateway";
  operatorLoginRole: "cortex_oauth_operator_user";
}

export interface OAuthBootstrapConfig {
  issuer: string;
  subject: string;
  agentExternalId: string;
  allowedScopes: readonly ("cortex:read" | "cortex:write" | "mcp")[];
}

export interface OAuthBootstrapResult {
  principalId: string;
  bindingId: string;
  agentId: number;
  agentExternalId: string;
  created: boolean;
}

export interface PrepareOAuthDatabaseOptions {
  migrationDirectory: string;
  roles: OAuthRoleConfig;
  bootstrap: OAuthBootstrapConfig;
}

export function provisionOAuthLoginRoles(config: OAuthRoleConfig): Promise<void>;
export function bootstrapOAuthAuthority(
  sql: import("postgres").Sql,
  config: OAuthBootstrapConfig
): Promise<OAuthBootstrapResult>;
export function assertOAuthBootstrap(
  sql: import("postgres").Sql,
  config: OAuthBootstrapConfig
): Promise<OAuthBootstrapResult>;
export function prepareOAuthDatabase(
  options: PrepareOAuthDatabaseOptions
): Promise<void>;
```

`src/db/index.ts` retains `initDatabase(): Promise<void>` for callers, but its runtime meaning becomes “connect and assert the required migration.” It also exports `runLegacyBuildMigrations(): Promise<void>` solely for `scripts/run-migrations.ts` and `scripts/prepare-oauth-database.ts`.

### Database records and constraints

Migration 009 creates these application-generated UUID records:

```ts
type PrincipalStatus = "active" | "disabled";
type BindingStatus = "active" | "revoked";
type ClientStatus = "active" | "disabled";
type GrantStatus = "active" | "revoked" | "expired" | "superseded";
type RefreshKind = "v2" | "legacy";
type OAuthScope = "cortex:read" | "cortex:write" | "mcp";

interface OAuthPrincipalRow {
  id: string;
  issuer: string;
  subject: string;
  status: PrincipalStatus;
  authenticationEpoch: number;
  legacyNotBefore: Date;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OAuthAgentBindingRow {
  id: string;
  principalId: string;
  agentId: number;
  status: BindingStatus;
  isDefault: boolean;
  bindingVersion: number;
  allowedScopes: OAuthScope[];
  revokedAt: Date | null;
  revokedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OAuthClientRow {
  id: string;
  clientId: string;
  clientKind: "dynamic" | "static" | "legacy";
  redirectUris: string[];
  clientName: string | null;
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  status: ClientStatus;
  createdAt: Date;
  updatedAt: Date;
}

interface OAuthAuthorizationCodeRow {
  codeDigest: Uint8Array;
  clientId: string;
  principalId: string;
  bindingId: string;
  authenticationEpoch: number;
  bindingVersion: number;
  redirectUri: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  resource: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface OAuthGrantRow {
  id: string; // JWT sid
  principalId: string;
  bindingId: string;
  clientId: string;
  resource: string;
  scopes: OAuthScope[];
  authenticationEpoch: number;
  bindingVersion: number;
  status: GrantStatus;
  currentRefreshGeneration: number;
  inactivityExpiresAt: Date;
  legacyTupleDigest: Uint8Array | null;
  refreshedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  supersededBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OAuthRefreshTokenRow {
  id: string;
  grantId: string;
  generation: number; // -1 is the consumed legacy token; v2 begins at 0
  kind: RefreshKind;
  jtiDigest: Uint8Array;
  reconstructionNonce: Uint8Array | null;
  effectiveScopes: OAuthScope[];
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  replacementGeneration: number | null;
  retryDeadline: Date | null;
  requestFingerprint: Uint8Array | null;
}

interface OAuthLoginSessionRow {
  sessionDigest: Uint8Array;
  legacyCookieDigest: Uint8Array | null;
  principalId: string;
  ipFingerprint: Uint8Array;
  authenticationEpoch: number;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

interface OAuthAuditEventRow {
  id: string;
  eventType: string;
  outcome: string;
  principalId: string | null;
  bindingId: string | null;
  grantId: string | null;
  clientId: string | null;
  requestId: string;
  actorType: "connector" | "browser" | "operator" | "migration" | "system";
  ipFingerprint: Uint8Array | null;
  userAgentFingerprint: Uint8Array | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: Date;
}

interface OAuthStateMigrationRow {
  version: string;
  sourceChecksum: Uint8Array;
  outcome: "imported" | "fresh_install";
  startedAt: Date;
  completedAt: Date;
  report: Record<string, number>;
}
```

Database constraints additionally enforce:

- unique `(issuer, subject)` principal identity;
- unique principal-agent binding and at most one active default binding per principal;
- unique public `client_id`; redirect arrays contain 1–5 unique, non-empty, trimmed, bounded elements; and dynamic clients can use only `token_endpoint_auth_method = 'none'`;
- unique code digest, with non-negative captured authentication epoch and positive captured binding version;
- authorization-code and grant `(binding_id, principal_id)` pairs reference one composite binding identity, so a row cannot bind one principal to another principal's agent binding;
- unique `(grant_id, generation)` and `(grant_id, jti_digest)` refresh rows;
- one active grant for `(principal, binding, client, resource)`, with reauthorization superseding the old row; the self-reference from the old grant to its replacement is `DEFERRABLE INITIALLY DEFERRED` so the gateway can update-old then insert-new atomically without a temporary externally visible state;
- unique non-null legacy tuple digest and legacy-cookie source digest;
- bounded canonical scope arrays, non-negative epochs/versions, refresh generation `>= -1`, and `TIMESTAMPTZ` for every security timestamp.

Migration 009 also creates the following SQL operator surface; `PUBLIC` has no execute permission, functions are fully schema-qualified, and each mutation and its audit record are atomic:

```sql
oauth_operator_revoke_grant(uuid, text, text) RETURNS jsonb
oauth_operator_revoke_all_for_principal(text, text, text, text) RETURNS jsonb
oauth_operator_disable_principal(text, text, text, text) RETURNS jsonb
oauth_operator_disable_binding(uuid, text, text) RETURNS jsonb
oauth_operator_security_logout(text, text, text, text) RETURNS jsonb
oauth_operator_invalidate_issuer(text, text, text) RETURNS jsonb
```

The runtime gateway capability role can read the minimum principal/binding/client/grant/session state, read only `agents(id, external_id)`, mutate runtime OAuth rows, and append audit rows. It cannot read memory content, read audit history, change principals/bindings, manage roles, or run DDL. The operator role can read redacted views and call the functions above; it has no base-table DML. Only the migration owner has DDL and role-management authority.

### Gateway configuration, claims, and cryptography

```js
/** @typedef {"cortex:read"|"cortex:write"|"mcp"} OAuthScope */

/** @typedef {{
 * port:number,
 * baseUrl:string,
 * issuerUrl:string,
 * resourceUrl:string,
 * mcpTarget:string,
 * restTarget:string,
 * databaseUrl:string,
 * bootstrapSubject:string,
 * bootstrapAgentExternalId:string,
 * accessTokenTtlSeconds:number,
 * refreshTokenTtlSeconds:number,
 * authCodeTtlSeconds:number,
 * loginSessionTtlSeconds:number,
 * refreshRetryGraceSeconds:number,
 * loginAttemptLimit:number,
 * loginAttemptWindowSeconds:number,
 * registrationAttemptLimit:number,
 * registrationAttemptWindowSeconds:number,
 * acceptLegacyUntil:Date,
 * legacyStateFile:string,
 * trustedIpHeader:string,
 * trustedProxyCidrs:readonly string[]
 * }} GatewayConfig */

/** @typedef {{
 * jwtSecret:string,
 * browserPassword:string
 * }} GatewaySecrets */

export function loadGatewayConfig(env = process.env); // GatewayConfig
export function loadGatewaySecrets(env = process.env); // GatewaySecrets
export function createBrowserCredentialVerifier(subject, secrets);
// (username:string, password:string) => boolean

/** @typedef {{
 * iss:string, sub:string, aud:string, scope:string, client_id:string,
 * token_use:"access", sid:string, agent_id:string,
 * auth_epoch:number, binding_version:number, jti:string,
 * iat:number, exp:number
 * }} AccessClaims */

/** @typedef {{
 * iss:string, sub:string, aud:string, scope:string, client_id:string,
 * token_use:"refresh", sid:string, agent_id:string,
 * auth_epoch:number, binding_version:number, generation:number, jti:string,
 * iat:number, exp:number
 * }} RefreshClaims */

/** @typedef {{
 * sid:string, principalId:string, subject:string, authenticationEpoch:number,
 * bindingId:string, bindingVersion:number, agentId:number, agentExternalId:string,
 * clientId:string, resource:string, scopes:readonly OAuthScope[],
 * inactivityExpiresAt:Date
 * }} TokenGrantSnapshot */

/** @typedef {{
 * grant:TokenGrantSnapshot, generation:number, reconstructionNonce:Uint8Array,
 * issuedAt:Date, expiresAt:Date
 * }} RefreshTokenDescriptor */

export function createOAuthCrypto(config, secrets); // OAuthCrypto
export function canonicalizeScopes(scope); // OAuthScope[]
export function createRefreshRequestFingerprint(input); // Uint8Array

/** @interface OAuthCrypto */
// issueAccessToken(grant: TokenGrantSnapshot): Promise<string>
// issueRefreshToken(descriptor: RefreshTokenDescriptor): Promise<string>
// verifyAccessToken(token: string): Promise<AccessClaims|LegacyAccessClaims>
// verifyRefreshToken(token: string): Promise<RefreshClaims|LegacyRefreshClaims>
// verifyRevocationReference(token: string): Promise<TokenReference|null>
// createAuthorizationCode(): { raw:string, digest:Uint8Array }
// createLoginCookie(): { raw:string, digest:Uint8Array }
// createRefreshMaterial(sid:string, generation:number): { nonce:Uint8Array, jti:string, jtiDigest:Uint8Array }
// digestAuthorizationCode(raw:string): Uint8Array
// digestLoginCookie(raw:string): Uint8Array
// digestLegacyTuple(input:object): Uint8Array
// fingerprintClientIp(ip:string): Uint8Array
// fingerprintUserAgent(userAgent:string): Uint8Array
// verifyLegacyLoginCookie(cookie:string, ip:string): LegacyLoginClaims|null
```

`loadGatewaySecrets()` validates the password and JWT secret without trimming, normalizing, logging, serializing, or adding either value to `GatewayConfig`. The raw JWT-secret bytes remain the HS256 key so future v1-cookie and legacy-token verification stays compatible. Every stored digest and new fingerprint instead uses a versioned, purpose-specific HMAC key derived from that secret; equality checks are constant-time. The refresh JTI is deterministically derived from the exact versioned tuple `(sid, generation, reconstruction_nonce)`, and the row stores only its keyed digest plus the random 32-byte nonce. Fixed header, claim order, `iat`, `exp`, and descriptor therefore reconstruct a byte-identical refresh JWT after restart without storing the bearer token or raw JTI.

The fixed accepted audience set is the configured `resourceUrl`, `baseUrl`, and `baseUrl` with one trailing slash, preserving v1 ChatGPT compatibility. `issuerUrl` remains the signed `iss` and principal-identity authority; the database store receives `baseUrl` explicitly so HTTP validation, token verification, and live grant validation cannot disagree when the two public URLs differ.

### OAuth store

```js
/** @typedef {{
 * principalId:string, subject:string, authenticationEpoch:number,
 * bindingId:string, bindingVersion:number,
 * agentId:number, agentExternalId:string,
 * allowedScopes:readonly OAuthScope[]
 * }} BoundPrincipal */

/** @typedef {
 * {kind:"rotated", grant:TokenGrantSnapshot, refresh:RefreshTokenDescriptor} |
 * {kind:"retry", grant:TokenGrantSnapshot, refresh:RefreshTokenDescriptor} |
 * {kind:"replay", sid:string} |
 * {kind:"invalid"|"revoked"|"expired"}
 * } RefreshDecision */

/** @typedef {
 * {kind:"active", context:TokenGrantSnapshot} |
 * {kind:"legacy-active", context:BoundPrincipal} |
 * {kind:"invalid"|"revoked"|"expired"}
 * } AccessDecision */

export class OAuthStoreUnavailableError extends Error {}
export function createPostgresOAuthStore(options); // OAuthStore

/** @interface OAuthStore */
// close(): Promise<void>
// checkReadiness(input: ReadinessInput): Promise<ReadinessReport>
// resolveBootstrapBinding(): Promise<BoundPrincipal>
// synchronizeStaticClients(clients: readonly StaticClientMetadata[]): Promise<void>
// resolveActiveClient(clientId: string): Promise<OAuthClient|null>
// registerDynamicClient(input: RegisterClientInput): Promise<OAuthClient>
// createLoginSession(input: CreateLoginSessionInput): Promise<LoginSession>
// resolveLoginSession(input: ResolveLoginSessionInput): Promise<LoginSessionDecision>
// upgradeLegacyLoginSession(input: UpgradeLegacyLoginSessionInput): Promise<LoginSessionDecision>
// createAuthorization(input: CreateAuthorizationInput): Promise<void>
// exchangeAuthorizationCode(input: ExchangeCodeInput): Promise<TokenGrantSnapshot|null>
// rotateRefreshToken(input: RotateRefreshInput): Promise<RefreshDecision>
// migrateLegacyRefreshToken(input: MigrateLegacyRefreshInput): Promise<RefreshDecision>
// resolveAccessContext(input: ResolveAccessInput): Promise<AccessDecision>
// revokeByTokenReference(input: RevokeTokenInput): Promise<RevokeDecision>
// importLegacyStateOnce(input: LegacyImportInput): Promise<LegacyImportReport>
// recordSecurityEvent(input: SecurityEventInput): Promise<void>
// listRedactedGrants(filter: GrantFilter): Promise<readonly GrantSummary[]>
// revokeGrant(input: RevokeGrantInput): Promise<OperatorMutation>
// revokePrincipal(input: RevokePrincipalInput): Promise<OperatorMutation>
// disablePrincipal(input: DisablePrincipalInput): Promise<OperatorMutation>
// disableBinding(input: DisableBindingInput): Promise<OperatorMutation>
// securityLogout(input: SecurityLogoutInput): Promise<OperatorMutation>
// invalidateIssuer(input: InvalidateIssuerInput): Promise<OperatorMutation>
// pruneExpired(now: Date, batchSize: number): Promise<PruneReport>
```

`rotateRefreshToken` and `migrateLegacyRefreshToken` lock the grant before its token row. For v2, only `current_generation - 1` with the same request fingerprint inside the retry deadline can return `retry`; older, late, mismatched, or unknown signed JTI use commits family revocation. First legacy refresh inserts a consumed generation `-1` plus reconstructable v2 generation `0`; a different old JTI for the same legacy tuple is replay.

`registerDynamicClient` serializes the 1,000-client capacity check, generates both identifiers server-side, validates the approved ChatGPT callback forms from their raw strings, and never revives a regex-shaped unknown client. `createAuthorization` revalidates the live client, exact redirect, configured principal/default binding, allowed scopes, resource, and PKCE challenge in one transaction before storing only the keyed code digest and captured epochs. `exchangeAuthorizationCode` locks that row and the active grant tuple, validates every input before consumption, updates the prior same-tuple grant to point at the future replacement, inserts the new grant and generation-zero descriptor, consumes the code, and appends the audit row atomically. Validation or storage failure leaves the code reusable and no partial grant, refresh row, supersession, or audit event.

### Legacy state

```js
/** @typedef {{
 * version:1,
 * clients:readonly LegacyClient[],
 * codes:readonly LegacyAuthorizationCode[]
 * }} LegacyOAuthStateV1 */

export function readLegacyState(path); // Promise<{bytes:Uint8Array,state:LegacyOAuthStateV1}>
export function parseLegacyState(bytes); // LegacyOAuthStateV1
export function checksumLegacyState(bytes); // Uint8Array
export function validateLegacyStateFile(stat); // void
```

The parser rejects unknown top-level structure, duplicate client IDs/codes, invalid redirects, non-canonical scopes, oversized files/arrays/strings, and expired or malformed records. Import uses an advisory lock and one transaction, upserts only exact-match clients, stores only keyed code digests, skips expired codes, records the checksum/report, and never changes source bytes or mode. A previously recorded checksum is idempotent; a different checksum fails closed. The existing deployment requires the frozen state file for first cutover. A genuinely new installation must use the documented explicit `--fresh-install` preparation mode, which records that outcome rather than silently treating a missing file as empty.

### Hosted agent policy and schema projection

```js
/** @typedef {"query"|"body"} AgentLocation */
/** @typedef {{
 * method:"GET"|"POST"|"PATCH",
 * path:RegExp,
 * requiredScopes:readonly OAuthScope[],
 * agentLocation:AgentLocation
 * }} HostedRestRoutePolicy */

/** @typedef {{
 * subject:string, sid:string, clientId:string,
 * agentId:number, agentExternalId:string,
 * scopes:ReadonlySet<OAuthScope>
 * }} HostedAuthContext */

/** @typedef {{
 * source:"query"|"body"|"mcp_arguments",
 * key:"agentId"|"agent_id",
 * value:unknown
 * }} AgentSelectorOccurrence */

export class HostedPolicyError extends Error {
  status;
  code;
  safeDescription;
}

export const HOSTED_REST_ROUTES; // readonly HostedRestRoutePolicy[]
export const HOSTED_MCP_METHODS; // initialize, notifications/initialized, ping, tools/list, tools/call
export function matchHostedRestRoute(method, rawUrl); // HostedRestRoutePolicy|null
export function scanTopLevelJsonMemberNames(rawJson, objectPath); // readonly string[]
export function inspectAgentSelectors(input); // readonly AgentSelectorOccurrence[]
export function bindHostedRestRequest(input, context); // {url:URL, body:object|null}
export function bindHostedMcpRequest(message, rawJson, context); // object
export function isHostedPolicyError(error); // boolean

export function hideHostedAgentSelector(inputSchema); // cloned JsonSchema
export function sanitizeToolForChatGPT(tool); // decorated tool|null
```

The exact hosted REST catalog is:

| Method and path | Canonical location | Required scopes |
|---|---|---|
| `GET /api/v1/status` | query `agentId` | `cortex:read` |
| `GET /api/v1/graph` | query `agentId` | `cortex:read` |
| `GET /api/v1/cognition` | query `agentId` | `cortex:read` |
| `GET /api/v1/vitals` | query `agentId` | `cortex:read` |
| `GET /api/v1/reconsolidate/labile` | query `agentId` | `cortex:read` |
| `GET /api/v1/procedural` | query `agentId` | `cortex:read` |
| `POST /api/v1/search` | body `agentId` | `cortex:read`, `cortex:write` |
| `POST /api/v1/recall` | body `agentId` | `cortex:read`, `cortex:write` |
| `POST /api/v1/ingest` | body `agentId` | `cortex:write` |
| `POST /api/v1/reconsolidate` | body `agentId` | `cortex:read`, `cortex:write` |
| `POST /api/v1/dream` | body `agentId` | `cortex:read`, `cortex:write` |
| `POST /api/v1/procedural` | body `agentId` | `cortex:write` |
| `POST /api/v1/procedural/retrieve` | body `agentId` | `cortex:read` |
| `POST /api/v1/procedural/:positiveInteger/execute` | body `agentId` | `cortex:write` |
| `PATCH /api/v1/procedural/:positiveInteger` | body `agentId` | `cortex:read`, `cortex:write` |

`GET /api/v1/health` is the only public REST exception. `/api/v1/agents`, method mismatches, encoded separator/dot-segment variants, and every unlisted future route return `404` without reaching Cortex. At most one ordinary trailing slash is normalized.

For REST and `tools/call`, zero selector occurrences means inject; exactly one well-formed equal legacy/cached selector means accept, remove aliases/wrong-location copies, and inject the canonical key; a different, malformed, aliased, or duplicate occurrence returns `403 agent_mismatch`. Original JSON bytes are inspected because ordinary `JSON.parse` erases duplicate members, and the accepted object is always reserialized before proxying. Nested content fields are not treated as selectors. Scope failure is evaluated first.

For `tools/list`, `hideHostedAgentSelector` removes top-level `agent_id` from both `properties` and `required` on a clone. It does not alter descriptions, other constraints, `outputSchema`, raw schemas, or structured output. Only the 29 names in `CORTEX_TOOL_METADATA` are returned; an unknown tool or method fails closed.

### Gateway app, readiness, logging, and operator CLI

```js
/** @typedef {{
 * config:GatewayConfig,
 * crypto:OAuthCrypto,
 * verifyBrowserCredentials:(username:string,password:string)=>boolean,
 * store:OAuthStore,
 * fetchImpl:typeof fetch,
 * now:()=>Date,
 * logger:SecurityLogger
 * }} GatewayDependencies */

/** @typedef {{
 * live:boolean,
 * ready:boolean,
 * database:boolean,
 * schema:boolean,
 * bootstrap:boolean,
 * legacyImport:boolean,
 * rest:boolean,
 * mcp:boolean,
 * reason?:string
 * }} ReadinessReport */

export function createGatewayApp(dependencies); // Express
export function bootstrapGateway(config); // Promise<GatewayRuntime>
export function probeReadiness(runtime); // Promise<ReadinessReport>
export function startGateway(config); // Promise<GatewayRuntime>

export function createSecurityLogger(sink); // SecurityLogger
export function sanitizeSecurityMetadata(eventType, metadata); // object

/** @typedef {
 * {kind:"grants.list", filter:GrantFilter} |
 * {kind:"grants.revoke", sid:string, actor:string, reason:string} |
 * {kind:"principals.revokeAll", issuer:string, subject:string, actor:string, reason:string} |
 * {kind:"principals.disable", issuer:string, subject:string, actor:string, reason:string} |
 * {kind:"principals.securityLogout", issuer:string, subject:string, actor:string, reason:string} |
 * {kind:"bindings.disable", bindingId:string, actor:string, reason:string} |
 * {kind:"rollout.status"} |
 * {kind:"recovery.invalidateIssuer", issuer:string, actor:string, reason:string, confirmation:string}
 * } AdminCommand */

export function parseAdminCommand(argv); // AdminCommand
export function runAdminCommand(store, command); // Promise<AdminResult>
```

`GET /livez` reports process liveness only. `GET /readyz` is `200` only after the required migration checksum, exact bootstrap binding, legacy import/fresh-install marker, database, raw REST health, and raw MCP health are usable; its public body is only `{status:"ok"}` or `{status:"not_ready"}`. Discovery and liveness remain available during an outage.

The CLI reads its URL only from `MCP_OAUTH_OPERATOR_DATABASE_URL`. Mutations require non-empty actor and reason values; issuer-wide invalidation additionally requires the exact issuer as confirmation. Human and `--json` outputs are stable and redacted.

### Cortex ownership contracts

```ts
export interface CreateProceduralInput {
  agentId: number;
  name: string;
  description: string;
  proceduralType: ProceduralType;
  triggerContext: string;
  steps: string[];
  domainTags: string[];
  sourceMemoryIds?: readonly number[];
}

export class InvalidSourceMemoryReferencesError extends Error {
  readonly code: "invalid_source_memory_references";
  readonly requestedCount: number;
}

export function normalizeSourceMemoryIds(
  ids: readonly number[] | undefined
): number[];
export function assertSourceMemoriesOwnedByAgent(
  agentId: number,
  ids: readonly number[]
): Promise<void>;
export function storeProcedural(input: CreateProceduralInput): Promise<number>;

export interface CortexStatusResponse {
  status: "ok";
  service: string;
  version: string;
  stats: Record<string, unknown>;
}

export function loadCortexStatus(
  agentExternalId?: string
): Promise<CortexStatusResponse>;
```

Source IDs are capped at 100 unique positive safe integers. Foreign and nonexistent IDs produce the same generic error and no ID list. Ownership is checked before the embedding call and again in the same transaction/conditional insert that stores the array. Existing reconsolidate, procedural execute, and procedural refine queries retain their `id AND agent_id` predicates.

## Call stack

### 1. Deployment preparation and startup

1. `cortex-migrate` waits for PostgreSQL health.
2. `prepare-oauth-database.ts` validates that the owner, gateway, and operator URLs target the expected database and fixed login names.
3. `preflightCheckedInMigrations()` discovers and checksum-loads the directory and rejects any missing or unapproved migration ID before any legacy or checked-in database mutation begins.
4. `runLegacyBuildMigrations()` applies the existing idempotent Build 1-8 changes under the owner connection.
5. `runCheckedInMigrations()` repeats the exact-set preflight at its own boundary, then takes the fixed advisory lock, creates/reads `cortex_schema_migrations`, verifies every applied checksum, and applies migration 009 plus its ledger row in one transaction.
6. `provisionOAuthLoginRoles()` creates/rotates the two LOGIN members without logging URL components and grants the fixed capability roles.
7. `bootstrapOAuthAuthority()` resolves exactly one existing agent, creates or verifies the principal/default binding, and rejects a conflict.
8. Final schema, privilege, and bootstrap assertions pass; the one-shot service exits zero.
9. Cortex and MCP start only after successful completion and call `initDatabase()` to assert the ledger before listening.
10. During Slices 3–12, `server-v2.js` is the explicit disposable/staging command. It loads the separated configuration and secrets, asserts database/schema/bootstrap readiness, and starts the database-authority app without reading or writing the JSON state. The packaged default remains the untouched v1 command, so development cannot cut over the live connector accidentally.
11. At Slice 13, after the rollback-qualified migration-first stack is proven, the database-aware path becomes `server.js` and the normal container command. It then synchronizes static client metadata, freezes/validates/checksums the v1 state, imports it under an advisory lock, and starts listening. The file remains byte-identical and read-only.

### 2. Browser authorization without repeated credentials

1. `GET /authorize` validates client, exact redirect, resource, scopes, PKCE, and trusted client IP.
2. The opaque cookie is digested, then `resolveLoginSession()` checks live principal status/epoch, expiry, IP fingerprint, and the exact default binding.
3. A valid same-cookie/same-IP session creates a new authorization code without a password prompt.
4. A valid v1 signed cookie instead calls `upgradeLegacyLoginSession()` using a unique legacy-cookie digest, sets the new opaque cookie, and continues once.
5. Missing/changed cookie, changed IP, expiry, epoch change, or revoked session shows the credential form.
6. `POST /authorize` applies the existing rate limit, compares credentials in constant time, re-resolves the principal/binding, creates a stateful session and code, sets `Secure; HttpOnly; SameSite=Lax; Path=/`, and redirects.

### 3. Authorization-code exchange

1. `/token` authenticates/identifies the client and validates form shape, redirect, resource, scope, and PKCE material.
2. `OAuthCrypto` digests the raw code and creates generation-zero refresh material.
3. `exchangeAuthorizationCode()` locks and consumes the unexpired code, requires its captured authentication epoch and binding version to still match the live principal/binding, revalidates the client and statuses, supersedes the old active tuple, creates the bound grant and refresh row, and appends the audit event in one transaction.
4. After commit, `OAuthCrypto` signs access and refresh tokens containing `sid` and bound `agent_id`; the handler returns the pair.
5. Storage failure returns `503 temporarily_unavailable`; validation failure returns the appropriate OAuth error and no partial state.

### 4. Refresh rotation, duplicate retry, and replay

1. `/token` verifies the refresh signature/type/issuer/audience, identifies the client, validates resource and requested scope subset, and creates the semantic fingerprint.
2. `rotateRefreshToken()` locks grant first, then the presented generation.
3. An unused current generation is consumed; the next descriptor is inserted; inactivity expiry/current generation is advanced; and the audit event commits atomically.
4. A second presentation of exactly `current_generation - 1` inside the grace period with identical client/resource/effective scopes returns the stored current descriptor without another rotation.
5. Late, older, mismatched, or unknown-JTI reuse commits whole-family revocation and returns `invalid_grant`.
6. Tokens are signed only after the decision commits. A lost response can therefore be reconstructed on retry without storing bearer material.
7. First valid legacy refresh follows the same stack through `migrateLegacyRefreshToken()`, creating consumed generation `-1` and v2 generation `0`; a different historical legacy JTI for the tuple is replay.

### 5. Protected request and immediate revocation

1. The gateway verifies the access JWT locally, including signature, type, issuer, audience, expiry, client, scope shape, `sid`, epochs, and agent claim.
2. `resolveAccessContext()` performs the indexed live join across grant, principal, binding, and agent; every status and captured claim must still agree.
3. Inactive state returns `401 invalid_token` with the OAuth challenge. `OAuthStoreUnavailableError` returns `503 temporarily_unavailable` without a challenge.
4. Required route/tool scopes are checked.
5. Hosted agent policy injects or verifies the bound external agent and rejects mismatch without forwarding.
6. Connector credentials are scrubbed, the canonical request is reserialized, and only then is it proxied.

### 6. Hosted MCP and REST

1. MCP body capture preserves original bytes for duplicate-member inspection.
2. `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` are the only hosted methods; batching and unknown methods fail closed.
3. `tools/list` reads the upstream catalog, filters against all 29 known tools, clones each schema, removes the hosted agent selector, decorates security metadata, and returns valid JSON/SSE.
4. `tools/call` resolves required scopes from the known manifest, injects/validates `params.arguments.agent_id`, and streams the upstream result unchanged after the request rewrite.
5. REST public health short-circuits before authentication. Every protected call must exactly match the catalog, pass its scopes, and receive canonical query/body injection. `/agents` and future routes never proxy.

### 7. Explicit and operator revocation

1. `POST /revoke` authenticates/identifies the client and signature-checks the supplied access or refresh token without requiring it still be unexpired.
2. `revokeByTokenReference()` verifies ownership and atomically revokes the entire `sid` family plus live refresh rows.
3. Malformed, unknown, expired, or other-client token references return the same empty `200` after valid client authentication.
4. Operator commands connect with the operator URL, read only redacted views, or call one SECURITY DEFINER function.
5. Grant revoke leaves the browser session intact. Security logout increments the principal epoch, advances `legacy_not_before`, and revokes every grant and login session.

### 8. Procedural source ownership and scoped status

1. REST/MCP resolves the bound external agent to its numeric ID.
2. `normalizeSourceMemoryIds()` validates and deduplicates input.
3. `assertSourceMemoriesOwnedByAgent()` requires all rows to belong to that agent before embedding.
4. `storeProcedural()` embeds, then conditionally inserts only if the same ownership count still matches inside the write transaction.
5. Bound `/status` scopes memories, synapses (both endpoints), resonance, status/source breakdowns, last dream, and agent count to that agent. Only an unbound privileged raw call returns aggregate values.

### 9. Rollout and recovery

1. Stop the old single-writer gateway; back up PostgreSQL and byte-copy/checksum the mode-0600 state file.
2. Run preparation and start the DB-aware compatibility gateway with a future legacy cutoff while preserving issuer, URLs, signing secret, and DCR IDs.
3. Exercise the real ChatGPT connector so its first legacy refresh becomes v2 without a password prompt; verify all 29 schemas and bound calls.
4. Prove server-side revoke, then reauthorize using the still-valid browser session. Separately observe whether ChatGPT Disconnect calls `/revoke`.
5. Wait at least the old access-token lifetime plus skew, confirm no legacy traffic, and close the compatibility window.
6. Before any v2 token is issued, preparation failure can return to the untouched JSON gateway. After v2 issuance, rollback only to the retained DB-aware compatibility image; never run the current stateless binary.
7. After a database restore that may predate revocations, rotate the signing/session secret or run issuer invalidation before reopening readiness, accepting one safe reconnect.

## Test plan

No test below may be skipped when its suite is selected, weakened to match old behavior, or pointed at the live Cortex database. Integration tests use a disposable project/database and fail clearly if that environment cannot be created.

### Migration, bootstrap, and privileges

- `applies migration 009 exactly once and records its checksum` — rerun is a no-op with the same ledger row.
- `serializes concurrent migration runners with the advisory lock` — two runners produce one application.
- `rejects a changed checksum for an applied migration` — readiness and runtime startup fail closed.
- `rejects a checked-in migration omitted from the required set or ledger` — readiness cannot silently lag the binary's migration directory.
- `rejects an unapproved checked-in migration before database mutation` — preparation stops before legacy Build 1-8, and neither the unexpected SQL side effect nor a ledger row exists after preflight rejection.
- `runs existing Build 1-8 changes before OAuth migration 009` — the one-shot order is fixed.
- `bootstraps the configured subject to an existing agent without creating one` — principal/default binding are exact and idempotent.
- `fails bootstrap for a missing agent` — no rows are partially created.
- `fails rather than replacing a different active default binding` — no silent account-to-agent move.
- `permits only one active default binding per principal` — the database constraint rejects a race.
- `gateway role can complete runtime OAuth transactions` — required operations work with no owner privilege, including update-old then insert-new grant supersession under the deferred self-reference.
- `gateway role cannot read memory content audit history or perform DDL` — least privilege is enforced by PostgreSQL.
- `gateway role can read only id and external_id from agents` — names, owner IDs, and config are denied.
- `operator role reads only redacted views and cannot mutate base tables` — direct DML fails.
- `operator functions mutate and audit atomically` — status and audit cannot diverge.
- `principal revoke-all reports a pending-code-only change` — consuming the last outstanding authority is not audited as a no-op.
- `PUBLIC cannot execute operator functions` — unaffiliated roles are denied.
- `runtime services fail startup when migration 009 is missing or changed` — no partially ready deployment.

### Legacy state and login sessions

- `imports every valid DCR client and live authorization code once` — IDs and redirects survive gateway recreation.
- `stores only authorization-code digests` — raw canaries are absent from every table and log.
- `same legacy state checksum is idempotent` — restart changes no imported rows.
- `different checksum after completed import fails closed` — an altered file is not merged silently.
- `invalid oversized or conflicting legacy state rolls back the whole import` — there is no partial client set.
- `expired legacy codes are counted but not imported` — report is accurate.
- `legacy state bytes and mode remain unchanged` — the gateway never writes the source.
- `opaque same-cookie same-IP session survives gateway recreation` — no password is requested.
- `opaque session rejects an IP mismatch` — credentials are required.
- `opaque session rejects a changed or missing cookie` — credentials are required.
- `valid v1 signed cookie upgrades exactly once` — the resulting opaque session is durable.
- `principal epoch invalidates all existing login sessions` — security logout is immediate.
- `security logout and issuer invalidation make every outstanding authorization code unexchangeable` — a pre-logout code cannot mint a post-logout grant.
- `grant revocation preserves a legitimate browser session` — reconnect can be password-free.

### Token issue, refresh, and revoke

- `strict DCR registration survives store and gateway recreation` — the exact client and callback array are durable, capacity is serialized, and no JSON authority is read or written.
- `DCR rejects duplicate malformed and raw-delimiter callback URIs` — empty `?` or `#` delimiters cannot be hidden by URL parsing, and rejected registrations leave no row.
- `credential authorization stores only a keyed code digest` — raw code and credentials are absent from PostgreSQL and logs while the current principal epoch and binding version are captured.
- `invalid client redirect resource or PKCE exchange does not consume the code` — a later exact request can still succeed.
- `exchange persistence failure rolls back code grant refresh supersession and audit together` — an injected audit failure leaves the prior authority unchanged.
- `v2 access and refresh claims include sid agent epochs type audience client and jti` — all policy inputs are signed.
- `rejects access-refresh substitution malformed scope and wrong issuer or audience` — token types cannot cross endpoints.
- `authorization code exchange commits one grant and consumes the code once` — concurrent exchange has one winner.
- `reauthorization supersedes only the prior active tuple` — unrelated clients/agents remain active.
- `two concurrent current-generation refreshes converge on one replacement` — one rotation and one bounded retry.
- `immediate identical retry returns the bit-identical replacement refresh token` — no bearer storage is needed.
- `retry remains reconstructable after gateway restart` — the response-loss path is durable.
- `mismatched retry fingerprint revokes the family` — changed client/resource/scope is replay.
- `retry after grace revokes the family` — the configured window is enforced.
- `older generation reuse revokes the family` — family history is retained.
- `unknown signed JTI for a known sid revokes the family` — token-row substitution fails closed.
- `refresh racing explicit revoke leaves the family revoked` — lock order prevents resurrection.
- `replay revocation rejects an already-issued access token on its next call` — revocation is live.
- `first legacy refresh creates generation minus one and v2 generation zero` — active ChatGPT migrates without credentials.
- `same legacy token retry is idempotent but another historical JTI revokes` — tuple migration cannot hide replay.
- `legacy access and refresh stop at the configured cutoff` — compatibility is bounded.
- `legacy token issued before legacy_not_before is rejected` — emergency invalidation works.
- `revocation discovery metadata is exact` — both discovery documents advertise `/revoke` and client auth methods.
- `unknown-token revocation is idempotent and non-oracular` — valid clients always receive the same empty `200`.
- `database outage is 503 without an OAuth challenge` — ChatGPT is not pushed into a false reconnect loop.
- `revoked access is 401 with the normal OAuth challenge` — actual reauthorization remains discoverable.

### Hosted schemas, MCP, and REST

- `all 29 upstream tools exactly match the hosted manifest` — no tool is silently added, lost, or unclassified.
- `all 29 hosted schemas omit top-level agent_id from properties and required` — the model cannot select an agent.
- `hosted projection does not mutate raw schemas or output schemas` — trusted callers and structured outputs remain compatible.
- `all projected schemas compile and retain descriptions constraints and security metadata` — schemas are ChatGPT-usable.
- `tools list decorates JSON and SSE without buffering tool-call streams` — existing transport behavior remains.
- `MCP injects a missing bound agent` — upstream receives exactly one canonical selector.
- `MCP accepts one equal cached agent` — old cached schemas keep working.
- `MCP rejects foreign malformed duplicate and alias selectors before upstream` — upstream request count remains zero.
- `scope failure precedes MCP agent mismatch` — binding information is not an authorization oracle.
- `MCP rejects unknown tools methods and JSON-RPC batches` — hosted surface fails closed.
- `every allowlisted REST route receives its agent in the canonical location` — the entire route catalog is covered table-wise.
- `REST accepts one equal legacy selector and rejects foreign malformed duplicate or aliased selectors` — compatibility cannot bypass binding.
- `REST blocks agents unknown paths method mismatches and encoded path variants` — no generic proxy remains.
- `agent_mismatch is 403 without WWW-Authenticate` — reconnect cannot be triggered by an unfixable mismatch.
- `proxy scrubbing still removes every connector and edge credential` — rewrite does not regress header safety.
- `MCP SSE remains incremental after request rewriting` — no regression to long-running calls.
- `logs and audit rows reject token code cookie password JTI raw-IP and foreign-agent canaries` — redaction is executable.

### Cortex ownership and status

- `bound status scopes every memory synapse dream and agent statistic` — no global count leaks through hosted `/status`.
- `unbound raw status retains aggregate admin behavior` — privileged compatibility remains deliberate.
- `procedural store accepts source memories owned by the same agent` — valid provenance works.
- `procedural store rejects mixed foreign and nonexistent source memories before embedding or insert` — no cross-agent reference persists.
- `foreign and nonexistent source IDs have indistinguishable errors` — no ownership oracle.
- `source IDs normalize duplicate values and reject more than 100 or unsafe integers` — input is bounded.
- `conditional insert rechecks source ownership` — a race cannot persist an invalid reference.
- `reconsolidate execute and refine treat cross-agent record IDs as not found` — existing IDOR protections remain locked.
- `REST and MCP map ownership failure to stable non-sensitive errors` — no foreign IDs leak in details.

### Deployment, rollback, and live connector

- `staging v2 executable has no JSON fallback and refuses to listen when readiness fails` — missing database, schema, or bootstrap cannot silently start the old authority.
- `packaged default remains v1 through Slice 12` — building an intermediate development image alone cannot mutate or cut over the live connector; Slice 13 is the explicit promotion boundary.
- `livez remains 200 while readyz reports a dependency failure` — liveness and readiness are distinct.
- `readyz fails for database schema bootstrap import REST or MCP failure` — all required dependencies gate traffic.
- `readyz succeeds only after exact binding and migration checks` — ambiguous state is never ready.
- `gateway pins pg_catalog before a hostile database default` — readiness and a live grant lookup still succeed when the database default exposes a shadow UUID equality operator, and the connection reports the exact pinned search path.
- `authority URLs reject empty query and fragment delimiters` — canonical issuer, gateway public/upstream URLs, and database URLs cannot retain syntactically empty `?` or `#` delimiters that WHATWG otherwise hides from parsed query/fragment fields.
- `production compose publishes only the loopback gateway port` — DB, REST, MCP, and dashboard are not host-exposed.
- `only the gateway joins the edge network while required services share the private network` — raw workers are not edge-addressable.
- `admin override publishes raw ports on 127.0.0.1 only` — maintenance access is explicit and local.
- `gateway receives runtime URL but not owner or operator URL` — secret scope is checked from rendered Compose.
- `admin receives operator URL but not owner or runtime secret` — operator isolation is checked.
- `all runtime services wait for successful one-shot migration` — no DDL race exists.
- `pre-v2 preparation failure can restart the frozen JSON gateway` — rollback evidence is intact.
- `post-v2 compatibility image accepts sid tokens and never mints sidless tokens` — safe rollback does not weaken policy.
- `real ChatGPT connection upgrades on refresh without a password prompt` — the live compatibility goal is proven.
- `real ChatGPT lists 29 bound schemas and safely calls representative read and write tools` — hosted contract works end to end.
- `server-side revoke blocks the next live REST and MCP request` — immediate control is proven.
- `reauthorization after grant revoke reuses the same-IP browser login session` — security does not recreate the usability bug.
- `manual checkpoint records whether ChatGPT Disconnect calls revoke` — the unsupported external behavior is observed, not assumed.

## Least confident decisions

1. **Duplicate JSON-member detection.** A small path-aware scanner is proposed because normal JSON parsing erases duplicates and a regex would be unsafe. Accepted bodies are always reserialized, so a scanner bug cannot forward a hidden foreign selector, but the explicit duplicate rejection still deserves fuzzing and focused review.
2. **Thirty-second refresh retry grace.** This was approved at Gate 2 and is configurable, but ChatGPT's retry/concurrency timing is not public. Staged token-free counters must validate it; changing the duration later must not change the rule that only the immediately previous identical request qualifies.
3. **Incremental migration instead of a full Cortex schema conversion.** This plan runs the existing idempotent Build 1–8 routine under the sole migration service, then applies checked-in migration 009. Converting all historical base DDL into a new baseline would enlarge a security-critical patch without improving these two invariants.
4. **Database LOGIN provisioning.** The short-lived preparation container must temporarily receive owner, gateway, and operator URLs so it can create/rotate the fixed login roles. They are excluded from logs and runtime containers; Docker secrets or an external secret manager would be a separate deployment upgrade.
5. **Network egress.** The private project bridge is not marked `internal: true` because Cortex, cron, and embedding/LLM calls require outbound access. Isolation comes from removing host ports and attaching only the gateway to the external edge network. If the deployment later provides an egress proxy, the bridge can be tightened further.
6. **Equal explicit REST selectors.** One equal selector is accepted for compatibility, matching the approved cached-MCP behavior, then canonicalized. Rejecting all explicit REST selectors would be simpler but could break existing non-ChatGPT clients using the public gateway without providing additional isolation.
7. **ChatGPT Disconnect behavior.** OpenAI's public documentation does not promise a revocation callback. The live checkpoint can prove what this deployment observes, but the product claim must still be narrowed if ChatGPT does not call `/revoke`.
