# Vertical Slices: OAuth Revocation and Agent Isolation

## Build order

- Slice 1 -- tracer bullet: route one synthetic bound `cortex_status` call through the dependency-injected gateway and fake live-grant store, hide its hosted `agent_id`, inject the bound agent upstream, then revoke the fake grant and prove the very next call is blocked.
- Slice 2 -- disposable security authority: apply migration 009 through the locked/checksummed runner, provision and denial-test the gateway/operator roles, bootstrap two explicit agent bindings, and make real PostgreSQL readiness replace the tracer fake.
- Slice 3 -- DB-backed OAuth happy path: complete DCR registration, credential authorization, one-time code exchange, bound v2 token issuance, live grant validation, and a protected REST/MCP call across gateway restart and database-failure cases.
- Slice 4 -- immutable connection-state import: strictly checksum and transactionally import a production-shaped frozen v1 JSON client/code snapshot once, preserve its bytes and mode, and keep readiness false for altered or partial input.
- Slice 5 -- restart-safe browser login: replace the signed cookie with an opaque DB/IP-bound session, upgrade a v1 cookie once, and prove same-cookie/same-IP reuse plus changed-cookie/IP, expiry, and epoch rejection.
- Slice 6 -- reliable refresh rotation: rotate the current generation transactionally, reconstruct the immediately following replacement, and prove concurrent or lost-response retries converge on the same refresh token before and after restart.
- Slice 7 -- refresh replay defense: classify late, older-generation, changed-fingerprint, and unknown-JTI reuse as replay, revoke the whole family atomically, and prove refresh/revoke races never resurrect access.
- Slice 8 -- immediate and operator revocation: add RFC 7009 discovery and `/revoke`, the redacted operator commands/functions, principal/binding controls, security logout, and issuer invalidation, then prove the next REST and MCP calls observe each action.
- Slice 9 -- bounded legacy-token bridge: accept sid-less access only within the migration window, upgrade the first valid legacy refresh into generation `-1` plus v2 generation `0`, and prove retry, historical-JTI replay, cutoff, and `legacy_not_before` behavior.
- Slice 10 -- complete hosted MCP isolation: project all 29 valid ChatGPT schemas without input `agent_id`, enforce the five-method/tool/scope catalog and canonical binding, reject duplicate/foreign/unknown input before upstream, and preserve incremental SSE.
- Slice 11 -- complete hosted REST and Cortex isolation: replace the generic proxy with the exact 15-route policy, block `/agents` and unlisted variants, scope every bound status statistic, and prevent procedural source or record IDs from crossing agents.
- Slice 12 -- operational lifecycle and redaction: finish audit retention, safe pruning, dependency-aware `/livez` and `/readyz`, fatal Core/MCP schema startup, graceful shutdown, and executable checks that no secret or raw identifier reaches logs/audit.
- Slice 13 -- rollback-qualified release candidate: assemble the migration-first private-network Compose stack and admin override, run every disposable full-stack/boundary test, drill pre-v2 and post-v2 rollback plus restored-DB invalidation, tag the DB-aware compatibility image, and freeze migration 009's checksum.
- Slice 14 -- reversible production preparation: verify production configuration and the exact agent binding, take and read-test PostgreSQL/state backups, apply only additive migration/roles/bootstrap while the old gateway remains live, and prove the existing ChatGPT connection is unchanged.
- Slice 15 -- live compatibility cutover: freeze the final JSON snapshot, switch to the DB-aware gateway, upgrade the real ChatGPT connection to v2 without credentials, verify all 29 schemas/bound calls/restart/revoke/reconnect behavior, and record whether ChatGPT Disconnect actually calls `/revoke`.
- Slice 16 -- close compatibility and operationalize proof: after the old access lifetime plus skew and an agreed zero-legacy observation period, disable sid-less tokens, archive JSON read-only, drill restore recovery, and activate one successful scheduled redacted end-to-end security check on an approved operator host.

## Execution rules

- Slices 1-12 are development/staging checkpoints and are not independently deployed to production.
- Slice 13 is the no-live-mutation release-candidate boundary. Migration 009 becomes immutable there; any later database correction is migration 010 or higher.
- Slice 14 is additive and keeps the old gateway as the rollback path. Once Slice 15 issues any v2 token, the old stateless image is permanently disallowed and rollback means the tagged DB-aware compatibility image.
- Slice 15 keeps the legacy window open. Slice 16 is a separate timed decision and cannot start until the real connector is confirmed v2 and the observation requirement is satisfied.
- If ChatGPT Disconnect does not invoke `/revoke`, stop in Slice 15 and reopen Gate 1 before claiming that ChatGPT control is server-authoritative; Cortex-side and operator revocation remain valid.
- Every slice runs its focused proof plus all previously landed security suites, updates `00-status.md`, and ends with the required continue-or-re-steer checkpoint.
