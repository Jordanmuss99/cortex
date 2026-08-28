# Cortex OAuth security deployment and recovery

This runbook covers the database-authoritative OAuth gateway prepared in Slice 13. Slice 13 is a **release-candidate exercise only**: it must not recreate, restart, migrate, restore, or otherwise change the live Cortex deployment.

## Release status and immutable inputs

- OAuth migration `009` is frozen. Its exact SHA-256 is `e0c2de152746cb4b9d3a91710dcf71149062dc53b7b55ff1608f4f8d9b629d80`. A binary must reject different bytes before any database mutation.
- Memory migration `010` currently has SHA-256 `c41cdcbd0bdef50d673dbb19bbdea47403d4b8e8981c7d2438f6a1ead8789df5`, but it is intentionally mutable and guarded for disposable loopback databases under the independent Cortex memory plan. It does not become immutable until that plan's Slice 18.
- Consequently, OAuth Slice 14 and every live preparation or rollout remain blocked until migration `010` is independently frozen. Do not weaken its disposable-database guard to make this stack start against production.
- Retained pre-v2 rollback image: `cortex-oauth-gateway:pre-v2-slice13` (local OCI index `sha256:e6e72c2e293a2773892b46ad952c5e1ee51c9b958cba9f290f9425f07c7f6d52`). It is eligible only before the first v2 token has been issued.
- Retained post-v2 compatibility image: `cortex-oauth-gateway:db-compat-slice13` (digest: `<record-after-slice-13-build>`). Record and verify the final immutable digest before any future cutover.

## Deployment boundary

The base [`docker-compose.yml`](../../docker-compose.yml) is migration-first and private by default:

- `cortex-migrate` must complete successfully before Core, worker, MCP, gateway, dashboard, or cron starts.
- Only the OAuth gateway is published, and only at `127.0.0.1:${CORTEX_GATEWAY_PORT:-8091}`. The public edge or tunnel should reach the gateway through the external edge network; PostgreSQL, Core REST, MCP, and the dashboard are not host-published.
- Only the gateway joins both `edge` and `private`. Every database and application service remains on `private`.
- The legacy OAuth JSON volume is mounted read-only. The gateway imports its exact bytes once; it never rewrites or deletes the file.
- The optional [`docker-compose.admin.yml`](../../docker-compose.admin.yml) override publishes PostgreSQL, Core REST, MCP, and the dashboard on IPv4 loopback only. Load it for bounded local administration, never as the normal public topology.
- No service has a fixed container name, so disposable release-candidate projects cannot collide with a live Compose project.

Verify these invariants before any release-candidate exercise:

```bash
npm run oauth:verify-deployment
npm run test:oauth:deployment
docker compose config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.admin.yml --profile admin config >/dev/null
```

The verifier must fail if a raw service becomes publicly reachable, a runtime bypasses migration completion, a privileged credential leaks to a runtime, or the legacy state mount becomes writable.

## Credential separation

Use distinct PostgreSQL URLs and logins. Never copy one credential into another variable.

| Purpose | Variable | Allowed location |
| --- | --- | --- |
| Database owner and migration DDL | `CORTEX_DATABASE_OWNER_URL` | `cortex-migrate` only (mapped to `DATABASE_URL` inside that container) |
| OAuth runtime DML | `MCP_OAUTH_DATABASE_URL` | OAuth gateway and migration preparation |
| OAuth redacted operator functions/views | `MCP_OAUTH_OPERATOR_DATABASE_URL` | migration preparation and the local admin container only |
| Memory runtime DML | `CORTEX_MEMORY_DATABASE_URL` | Core, worker, MCP, and cron only |

The gateway must never receive the owner URL, operator URL, or general `DATABASE_URL`. The admin container must never receive the owner URL, gateway URL, browser password, or JWT signing secret. Provision the memory login separately as a member of `cortex_memory_runtime`; do not use an OAuth or owner login for memory processes.

## Legacy state and explicit fresh install

The normal upgrade path requires the existing mode-`0600` JSON state file and its existing Docker volume. Before a future cutover, stop the old single-writer gateway, byte-copy the file, record its SHA-256 and mode, and back up PostgreSQL. The DB-aware gateway validates and imports the frozen snapshot transactionally while leaving the source unchanged and read-only.

`MCP_OAUTH_FRESH_INSTALL=1` is a destructive-meaning bootstrap assertion, not a missing-file fallback. Use it only when all of the following are proven:

1. This is genuinely a new installation with no legacy client, code, token, or browser-session authority to preserve.
2. The OAuth authority contains no non-static security state.
3. The operator deliberately selected fresh install and recorded that decision.

Keep `MCP_OAUTH_FRESH_INSTALL=0` for upgrades and recovery. A missing state file must fail startup rather than silently creating new authority.

## Release-candidate validation and future start

While the migration-`010` guard is active, validate the graph and use only the repository's guarded disposable integration harness. The Compose migration container intentionally cannot turn a production-shaped database into a shortcut around that guard.

```bash
npm run oauth:verify-deployment
npm run test:oauth:deployment
npm run test:oauth:integration
docker compose --project-name cortex-slice13-disposable config >/dev/null
```

Do not run the composed migration against production, and do not weaken `010`'s loopback/disposable check to make `docker compose up` succeed. Do not point a release-candidate test URL or volume at live Cortex.

After the memory plan freezes migration `010` and OAuth Slice 14 is separately authorized:

1. Populate `.env` with the four separated database credentials, immutable `CORTEX_BUILD_ID`, public issuer/resource URLs, fixed OAuth subject/agent binding, signing/browser secrets, future legacy cutoff, and existing legacy-state volume.
2. Select the approved external edge network and explicitly named volumes.
3. Render and verify both Compose configurations using the commands above.
4. Start the project. Compose must run `cortex-migrate` once and must not start any runtime if preparation fails.
5. Require `/readyz` from the gateway. `/livez` alone does not authorize traffic.

The admin override is explicit and is only available after the same release block is cleared:

```bash
docker compose -f docker-compose.yml -f docker-compose.admin.yml --profile admin up -d
```

All added raw bindings remain on `127.0.0.1`. Remove the override from ordinary starts.

## Rollback boundary

There are two different rollback rules; the first v2 issuance is the irreversible boundary.

### Before any v2 token is issued

Preparation or candidate-start failure may return to the retained pre-v2 stateless image only if the original JSON file is byte-for-byte unchanged, its mode is still `0600`, the original signing secret/issuer/URLs/DCR identifiers are unchanged, and the first v2 issuance has been conclusively ruled out. Restore neither the database nor JSON merely to make this path work; investigate any mismatch.

### After any v2 token is issued

The stateless gateway is permanently prohibited. It cannot observe database grants, rotation generations, replay tombstones, revocations, epochs, or bindings and could resurrect invalid authority. Roll back only to the retained **DB-aware** compatibility image by its verified digest:

```text
cortex-oauth-gateway:db-compat-slice13@<record-after-slice-13-build>
```

Keep PostgreSQL and the same read-only legacy snapshot. A rollback candidate that cannot pass database readiness stays offline.

## Restoring a database without resurrecting grants

A database snapshot may predate a revoke or security logout. Never reopen the edge immediately after restoring it.

1. Disable public edge routing and stop `cortex-oauth-gateway`. Verify its loopback listener is closed. Keep both gateway and edge stopped through step 7.
2. Restore PostgreSQL while only the private database service is available. Do not start Core, MCP, or the gateway as a side effect.
3. Verify the restored database contains the expected frozen OAuth migration and operator functions. If release preparation is required, run only the already approved, checksum-exact migration set while the gateway remains stopped. A checksum or schema mismatch is a stop condition.
4. Run issuer invalidation through the isolated operator container. `--confirmation` must exactly repeat the issuer:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.admin.yml --profile admin run --rm --no-deps cortex-oauth-admin \
     recovery invalidate-issuer \
     --issuer https://cortex.example.invalid \
     --actor restore-recovery \
     --reason restored-database-may-predate-revocations \
     --confirmation https://cortex.example.invalid \
     --json
   ```

5. Verify the operator result succeeded, then inspect redacted state while the gateway is still stopped:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.admin.yml --profile admin run --rm --no-deps cortex-oauth-admin rollout status --json
   docker compose -f docker-compose.yml -f docker-compose.admin.yml --profile admin run --rm --no-deps cortex-oauth-admin grants list --issuer https://cortex.example.invalid --status active --json
   ```

   The issuer epoch must have advanced and no pre-restore active family may remain usable. If this cannot be established from the redacted output and audit evidence, keep the edge closed.
6. Start the DB-aware compatibility gateway by its verified digest and check `/readyz` locally. Do not use the stateless image.
7. Re-enable the public edge only after readiness and invalidation evidence are recorded.
8. Expect one safe ChatGPT reconnect. Restored browser sessions and tokens were deliberately invalidated.

If the operator command, verification, or readiness fails, leave public routing and the gateway stopped. Do not bypass invalidation by enabling fresh-install mode or by reverting to the JSON-only server.
