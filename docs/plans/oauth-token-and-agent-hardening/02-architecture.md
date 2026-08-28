# Architecture: OAuth Revocation and Agent Isolation

## Fit

This change keeps the existing Cortex OAuth gateway as both authorization server and public policy-enforcement point, but moves durable OAuth authority from the gateway's single-process JSON snapshot into the existing PostgreSQL cluster.

The current code signs access and refresh JWTs but does not persist a connection/grant identifier. Access tokens are therefore valid until expiry, and every previously issued refresh token remains reusable until its own expiry. The current JSON file contains only dynamic clients and outstanding authorization codes. The new design adds a live grant check to every protected request and a transactional refresh-token family.

The change touches these existing areas:

- `oauth-gateway/server.js`: login sessions, authorization-code exchange, token issuance and verification, refresh rotation, revocation, hosted REST/MCP policy, readiness, and compatibility migration.
- `oauth-gateway/chatgpt-tools.js`: remove `agent_id` from ChatGPT-facing tool schemas while leaving the raw/internal MCP schemas unchanged.
- Cortex database schema and migrations: add OAuth principals, bindings, clients, codes, grants, refresh generations, login sessions, migration state, and audit events.
- `src/api/health.ts`: make every statistic in a bound `/status` response agent-scoped. The public gateway will not expose the all-agent `/agents` route.
- Procedural-memory write paths: validate that every supplied `source_memory_id` belongs to the bound agent. Existing reconsolidation and procedural execute/refine paths already include agent ownership in their record queries.
- Docker deployment: give the gateway a least-privilege PostgreSQL connection; keep raw REST and raw MCP in a private trusted-service network; retain direct loopback access only in an explicit development/admin override.
- Connector verification: extend the existing restart-safe OAuth test and live ChatGPT verifier with revocation, replay, migration, and two-agent isolation cases.

PostgreSQL is chosen instead of extending the JSON file because identity-to-agent bindings already depend on the `agents` table, and code consumption, grant creation, refresh rotation, replay revocation, and audit insertion need one atomic transaction. It also removes the current single-writer/single-replica security assumption. The JSON state file becomes a read-only migration and rollback artifact, not an ongoing authority.

The public gateway is the hosted-traffic trust boundary. Raw Cortex REST/MCP remains an explicit privileged admin/service boundary because `supergateway` does not carry the authenticated HTTP identity into the stdio MCP process. Production network isolation is therefore part of the security design, not an optional deployment note.

## Endpoints

- `POST /revoke` — RFC 7009-style revocation of an access or refresh token's entire grant; uses the same client authentication rules as `/token`, is idempotent, and returns success for unknown tokens after valid client authentication so it is not a token oracle.
- `GET /.well-known/oauth-authorization-server` — add `revocation_endpoint` and `revocation_endpoint_auth_methods_supported`; existing authorization, token, registration, scopes, and PKCE metadata remain.
- `GET /.well-known/openid-configuration` — advertise the same revocation metadata.
- `POST /token` — same public route; authorization-code exchange now creates a bound grant atomically, and refresh exchange performs stateful rotation/replay handling.
- `GET|POST /authorize` — same public routes; resolve the authenticated principal's server-owned default agent binding before creating a code. No request parameter may select an agent.
- `GET /livez` — gateway process liveness only; it contains no security or database details.
- `GET /readyz` — ready only when the required OAuth schema, database connection, bootstrap binding, and upstreams are usable.
- `GET /api/v1/health` — remains public and agent-neutral.
- Protected `/api/v1/*` routes — replace generic pass-through with an explicit hosted-route policy. Known agent-scoped routes get a server-injected binding; `/api/v1/agents` and unknown future routes are not exposed through the public gateway.
- Protected `/mcp` — same public endpoint; `tools/list` hides the agent selector, and `tools/call` injects or validates the bound agent before forwarding.

There is no public administrative API and no new UI. A local/operator command will list and revoke grants or disable a principal/binding directly through the least-privilege operational database path. This avoids inventing another internet-facing administrator authentication surface.

## Data

All new primary keys are application-generated UUIDs. Security timestamps use PostgreSQL `TIMESTAMPTZ` in UTC. Raw access tokens, refresh tokens, authorization codes, passwords, PKCE verifiers, client secrets, and raw IP addresses are never stored or logged.

### `oauth_principals`

- Stable identity key: `(issuer, subject)`; do not overload the nullable, currently unenforced `agents.owner_id` field.
- Fields: status, authentication epoch, created/updated timestamps, and optional disabled timestamp/reason.
- Current bootstrap: the existing `MCP_OAUTH_USERNAME` becomes the subject under the Cortex issuer. Password verification remains secret-managed and is not copied into this table.
- Main queries: resolve the login identity; require active status and matching epoch during authorization, refresh, login-session reuse, and every protected request; disable or globally revoke one principal.

### `oauth_agent_bindings`

- Fields: principal foreign key, `agents.id` foreign key, active/default status, binding version, allowed scopes, created/revoked timestamps, and reason.
- Unique principal-agent pair, with at most one active default binding per principal for the current no-selection-UI flow.
- Main queries: resolve one unambiguous active default during authorization; join during token validation; revoke old bindings instead of silently changing their agent.
- Bootstrap must resolve the explicit `MCP_OAUTH_AGENT_ID` to an existing agent. Missing, unknown, or ambiguous configuration keeps the gateway unready; the public flow never auto-creates an agent.

### `oauth_clients`

- Durable dynamic-client registrations: client ID, redirect URI set, display name, authentication method, status, and timestamps.
- Existing static Linear/Notion client secrets remain in secret-managed environment configuration and are not copied into the database.
- Main queries: exact redirect validation, client status/authentication, registration insert, and migration import of every existing ChatGPT DCR client.

### `oauth_authorization_codes`

- Fields: keyed code digest, client/principal/binding references, captured principal authentication epoch and binding version, exact redirect URI, canonical scopes, PKCE challenge, resource, and expiry.
- Main query: one transaction locks and consumes a matching unexpired code, revalidates the live principal/binding/client, creates the grant and initial refresh generation, and appends the audit event. A failed commit never consumes the code or returns tokens.

### `oauth_grants`

- One row per authorized connector connection and refresh-token family; its UUID is the JWT `sid`.
- Fields: principal/binding/client references, resource, canonical scopes, status, current refresh generation, sliding inactivity expiry, creation/refresh timestamps, and revocation timestamp/reason.
- Main queries: indexed live-policy join for every access request; row lock during refresh; idempotent revoke; revoke/supersede the prior active grant when the same principal, client, resource, and agent reauthorizes.

### `oauth_refresh_tokens`

- One row per refresh generation: grant, generation, random JTI descriptor, issued/expiry timestamps, consumed timestamp, replacement reference, retry deadline, and semantic request fingerprint.
- The stored descriptor is not a bearer token. A retry response reconstructs the currently signed JWT from its fixed claims and the server signing key.
- Main query: lock the presented generation and grant, rotate exactly once, or classify a previously consumed generation as a bounded duplicate retry versus a replay.

### `oauth_login_sessions`

- Keyed digest of an opaque browser cookie plus principal, HMAC of the trusted client IP, issue/expiry timestamps, authentication epoch, and optional revocation timestamp.
- Preserves the current low-friction rule: the password is requested when the cookie is absent/invalid, the trusted IP changes, the session expires, or an administrator performs a security logout. Revoking a connector grant alone does not clear a legitimate same-browser login session, so reconnecting need not ask for the password again.
- The existing signed v1 cookie can be upgraded once into this stateful session after it passes its current signature, lifetime, subject, and IP checks.

### `oauth_audit_events`

- Append-only security events with event type/outcome, principal/binding/grant/client references, request ID, actor type, HMACed IP/user-agent fingerprints, timestamp, and bounded metadata.
- Records authorization, rotation, accepted duplicate retry, replay-triggered revocation, explicit revocation, legacy migration, disabled binding/principal, and rejected agent mismatch. Tokens, authorization codes, JTIs, credentials, and raw network identifiers are excluded from event metadata and logs.
- Supports the Gate 1 quarterly incident metric and scheduled security checks without becoming a second authorization source.

### `oauth_state_migrations`

- Records migration version, source-state checksum, start/completion timestamps, and outcome.
- Existing JSON dynamic clients and still-valid authorization codes are imported once under a migration lock. The original mode-0600 state file is retained unchanged through the rollback window, then archived read-only.

OAuth tables are installed by an ordered, checked-in migration before the new gateway becomes ready. The gateway never races application instances to create or alter security tables. Its database role has CRUD only on OAuth tables and read-only access to the minimum `agents` columns required for binding validation.

## Flow

1. **Bootstrap and login**
   - Migration creates the current `(issuer, MCP_OAUTH_USERNAME)` principal and binds it to the existing `MCP_OAUTH_AGENT_ID` agent.
   - `/authorize` first checks the opaque login cookie against the live principal, authentication epoch, expiry, and trusted-IP HMAC.
   - A valid same-IP session proceeds without another password prompt. Otherwise the existing username/password form is shown; success creates a new stateful login session.
   - The gateway resolves exactly one active default agent binding. It fails closed if none or more than one exists.

2. **Authorization-code exchange**
   - Validate client authentication, exact redirect/resource, PKCE, requested scope, principal, and binding.
   - In one database transaction, consume the code, create a bound grant, insert refresh generation zero, and append the audit event.
   - Issue access and refresh JWTs containing `sid`, stable subject, bound external `agent_id`, client/resource/scope, token use, JTI, and relevant epoch/version claims. Refresh JWTs also contain their generation.
   - Persist before returning. A database failure returns a temporary service error and no token pair.

3. **Protected access and immediate revocation**
   - Verify JWT signature, type, issuer, audience, expiry, client, and scope locally.
   - Perform one indexed database join for `sid` to the live grant, principal, binding, and agent. Require every status/epoch/version and all token claims to agree.
   - Do not cache an active result: immediate revocation requires this check on every REST and MCP request.
   - A revoked/disabled/stale token gets `401 invalid_token` with the existing OAuth challenge. A database outage gets `503 temporarily_unavailable`, not a false `401`, to avoid causing needless ChatGPT reauthorization loops.

4. **Hosted agent enforcement**
   - Scope checks happen before agent checks so callers cannot use mismatch responses to learn a binding they lack permission to use.
   - For `tools/list`, remove `agent_id` from all 29 ChatGPT-facing input schemas. Raw/internal MCP keeps its current explicit agent field.
   - For `tools/call`, inject the bound agent when absent; accept an equal explicit value for old cached schemas; reject a different, duplicate, malformed, or unbindable value with stable `403 agent_mismatch` and never forward it. Do not attach an OAuth challenge to this 403, because reconnecting cannot fix authorization and would recreate a login loop.
   - For REST, an allowlist defines whether the canonical `agentId` lives in the query or body. Validate every `agentId`/`agent_id` occurrence and duplicate parameter before injecting the binding. `/agents` and any new route without an explicit policy fail closed.
   - Backend ID-based mutations continue to include `agent_id`; procedural source-memory references gain the missing ownership validation.

5. **Refresh rotation and retry safety**
   - Verify the refresh JWT and client/resource/scope binding, then lock its grant and generation.
   - If it is the current unused generation, mark it consumed, insert the next generation, extend the existing 90-day inactivity lifetime, update the grant, and append the event in one transaction. Commit before signing/returning the pair.
   - A second presentation of the immediately consumed token within a configurable 30-second retry window is detected and audited. If its client, resource, and effective-scope fingerprint is identical, return the already-current replacement refresh token without rotating again.
   - Reuse after the retry window, reuse of an older generation, a mismatched retry fingerprint, or an unknown signed JTI for a known `sid` atomically revokes the entire grant. Existing access tokens for that `sid` then fail on their next request.
   - This short idempotent window is a deliberate reliability tradeoff because OpenAI does not publish ChatGPT's refresh retry/concurrency timing. It is narrower than strict immediate family revocation, is configurable, and will be tuned only from token-free staged counters. The OAuth security BCP otherwise requires public clients to use sender-constrained refresh tokens or rotation with retained family relationships.

6. **Explicit revocation**
   - `/revoke` authenticates/identifies the client, verifies that the presented token belongs to it, and atomically revokes the whole `sid` grant plus live refresh rows. Access checks observe it immediately.
   - The operator command uses the same transaction for revoke-one-connection, revoke-all-for-principal, disable-binding, and security-logout actions. Principal-wide security logout also advances the authentication epoch and revokes login sessions.
   - The revocation endpoint does not depend on the browser login cookie and is not CSRF-authenticated as an administrator action.

7. **Legacy connection migration**
   - Import all valid DCR clients first so ChatGPT keeps the same client ID. No new sid-less tokens are issued after cutover.
   - Existing sid-less access tokens get at most one old access-token lifetime plus clock skew. During that bounded period they must still match the bootstrapped active principal/binding and global legacy epoch, but they cannot be selectively connection-revoked; an emergency migration-window action therefore revokes the principal globally.
   - For a bounded deployment window, the first valid legacy ChatGPT refresh token for a principal/client/resource tuple atomically creates a bound v2 grant. A duplicate of that exact token gets the retry rule; another historical legacy JTI for the tuple is treated as replay.
   - The rollout actively exercises the real ChatGPT connection during the window so it upgrades without another password entry. Ambiguous legacy static-client grants require one reauthorization instead of guessing an identity/family.
   - After the window, disable legacy token and JSON fallback. The present gateway binary is not a safe rollback target because it would ignore the new claims and mint stateless tokens again; retain a DB-aware compatibility image for rollback.

8. **Failure and recovery**
   - PostgreSQL is authoritative. Authorization, token, revoke, and protected calls fail closed when it is unavailable; discovery and liveness can remain available, while readiness fails.
   - Back up the database and JSON state before cutover. A restore from a point before security revocations can resurrect grants, so the recovery runbook must rotate the JWT/session signing secret or advance an issuer-wide epoch and revoke all families after such a restore, accepting one safe reconnect.
   - Security audit retention must cover at least one quarterly metric period. Expired refresh generations and grants are retained until no token they describe can be valid, then pruned separately from audit events.

## External

No new third-party service is introduced. The existing PostgreSQL cluster becomes the security-state dependency. The custom Cortex OAuth server remains for this feature to avoid forcing a provider migration and reconnect; its `(issuer, subject)` identity model is deliberately compatible with a later established identity provider. OpenAI's current guidance strongly recommends an established provider, so provider migration remains a separate future architecture decision rather than being hidden inside these two hardening items.

Environment variable names added or changed:

- `MCP_OAUTH_DATABASE_URL` — required least-privilege gateway database connection.
- `MCP_OAUTH_AGENT_ID` — required current-subject bootstrap binding; no silent default.
- `MCP_OAUTH_REFRESH_RETRY_GRACE_SECONDS` — configurable bounded duplicate-retry window; initial value 30 seconds.
- `MCP_OAUTH_ACCEPT_LEGACY_UNTIL` — explicit cutover deadline for sid-less refresh migration.
- `MCP_OAUTH_STATE_FILE` — retained temporarily as migration input/rollback evidence, then removed as an authority.
- Existing `MCP_OAUTH_USERNAME`, `MCP_OAUTH_PASSWORD`, `MCP_OAUTH_JWT_SECRET`, URL, TTL, trusted-IP, and static-client variables remain.

Standards and host behavior used by this design:

- [OpenAI's plugin authentication guide](https://developers.openai.com/plugins/build/auth) requires full token verification and app-specific policy checks on every request, calls out replay considerations, and says to plan for token revocation, refresh, and scope changes. It documents that a DCR client is registered once per connector connection and should remain valid while that connection is in use.
- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700) requires public clients to sender-constrain or rotate refresh tokens and retain the family relationship so reuse can revoke the active family.
- [OAuth Token Revocation (RFC 7009)](https://www.rfc-editor.org/rfc/rfc7009) defines the client-facing revocation endpoint and allows revocation to invalidate the grant and related tokens.

OpenAI's public guide does not state that ChatGPT's **Disconnect** control calls an OAuth revocation endpoint. Cortex will advertise and implement the standard endpoint and will always guarantee immediate Cortex-side/operator revocation. A staged end-to-end check must determine whether ChatGPT calls `/revoke` on disconnect. If it does not, Cortex cannot infer that UI event; before shipping a claim that the ChatGPT button itself is server-authoritative, Gate 1 must be reopened and the announcement narrowed or OpenAI must provide a supported disconnect signal.
