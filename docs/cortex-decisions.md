# Cortex integration decisions

Accepted November 3, 2026 through the native OhMyOpenAgent questionnaire.
Source: the user's answers, not a delegated architect ruling.

## Selected boundaries

| Question | User answer | Scope |
|---|---|---|
| Next track | Verify repaired telemetry | Verify source, loading provenance and observed telemetry before claiming a live repair or new efficacy result. |
| Composition | Memory-only Cortex | Cortex memory tools return memory context only. AgentBridge session context remains a separate service; any combined result belongs to the consuming client. |
| Memory scope | Share project, preserve agents | Explicit worktree aliases may share canonical project identity. Retain agent-owned notes/namespaces and provenance; do not flatten them into one anonymous store. |
| Server baseline | Keep main, selective ports | Reconcile compatible completed work onto current main. Do not absorb the side branch's unfinished lifecycle/migration rollout or advance its release gates. |
| Connector build targets | Use documented hostnames | Cortex `https://cortex.obsidiannetwork.au/mcp`; AgentBridge `https://ab.obsidiannetwork.au/api/mcp`. These select build definitions, not publication or deployment. |
| AgentBridge SDK search entry | Use context tool | The SDK rejects an empty search list. Register `agentbridge_prompt_context`; keep its service, credentials and returned session context separate from Cortex memory. |

The user added:

> And reconcile server intergration then finish connecctor integration

The later SDK questionnaire answer was:

> Bridge SDK: Use context tool (Recommended)

### Follow-up audit and activation planning choices

The user subsequently answered the native questionnaire:

> Next work: SDK findings first (Recommended)
>
> Hosting: Preserve existing placement (Recommended)
>
> Scope: All my workspaces

| Choice | Scope |
|---|---|
| SDK findings first | Investigate compatible dependency fixes before preparing activation; propose changes with their evidence and remaining risks. |
| Preserve existing placement | Inventory and reuse existing hosting/routing where possible rather than assuming a move to a new hosting model. |
| All my workspaces | Design the first personal Go/AgentBridge connection for session context across the user's workspaces, not a Cortex-only export. Preserve project/agent provenance. |

These are planning selections. No service placement, token policy, workspace
access setting, public sharing, deployment or publication changed as a result.

### Exact SDK override instruction

The user selected **Apply scoped fixes** and supplied this implementation scope:

> Apply the SDK-scoped Zod 4.5.1 and qs 6.14.3 overrides now, update the lockfile, run the clean install + SDK compatibility checks, and rerun the security audit. Do not force-override the deep transitive browserify-sign/pak or elliptic chains if they risk breaking upstream packages—document those remaining findings clearly in the audit report.

These exact versions supersede the earlier research proposal of Zod 4.6.7 and
qs 6.16.2. The scope is the standalone consumer SDK dependency tree, not the
Cortex server or live hosting/access settings. Current advisory records still
place the requested versions below the published fixes; compatibility success
must not be described as a clean security audit.

### Subsequent patched-pin trial

After the requested 4.5.1/6.14.3 pins passed compatibility checks but increased
the full audit from 10 to 13 affected package records, the user answered:

> Next step: Trial patched pins (Recommended)

That questionnaire option specifies SDK-scoped Zod **4.6.7** and qs **6.16.2**,
verification against current patch records, clean installation, SDK compatibility
and a new full audit. This later selection supersedes the earlier exact pins for
the current trial. Deep browserify/glob/cryptographic packages and the separate
Cortex server remain outside the pin changes; hosting, access and publication
authorization are unchanged.

## Work order

1. Verify repaired telemetry.
2. Reconcile server integration under the selected memory-only boundary.
3. Finish connector integration against the verified server contracts.

These decisions authorize the ordered implementation and verification work.
They do not by themselves establish that a source revision is loaded, a connector
is configured, a migration has run, or a remote deployment has succeeded.
Application commits, Git history merges/rewrites, publication, live migrations
and deployments retain their separate authorization and capability requirements.

## Verification record

| Track | Current checkpoint |
|---|---|
| Telemetry | Bounded fresh-native-host verification passed: the tracked entry/core loaded, two injected turns produced correctly joined UUID outcomes and exact noncumulative calls/tokens. See the local evidence note below. |
| Server | Main is reconciled to the memory-only boundary. All 80 tests across seven suites and TypeScript checking pass. Staged side-branch release/migration work remains separate. |
| Connectors | Both consumer Packs pass strict checking, real SDK validation/build and two generated-contract tests. AgentBridge's 17 existing HTTP tests pass. SDK dependency audit findings and live activation/publication prerequisites remain explicit. |

Update these checkpoints with executed evidence as the work completes. Keep
source/configuration observations separate from live-runtime observations.

### Telemetry evidence boundary

The SimsOnline project profile points directly to the repaired tracked entry;
there is no copied global injector installation to update. A fresh isolated
native host reported that entry as a CLI-loaded temporary surface, transmitted
two actual recall injections to an owned loopback stub, and logged per-turn
outcomes of one call/17 input tokens and one call/29 input tokens.

Retained local evidence is under
`.omo/evidence/cortex-integration-20261103/telemetry/native-verification.md`.
The native host and injector were real; memory notes/provider and model replies
were synthetic. This does not attest an already-running host's cached modules,
normal-profile indexing, live relevance or new efficacy. No real model inference
was used, but mandatory MCP surfaces appeared as connecting, so this is not a
packet-level proof of zero background network activity. Owned native processes
and the loopback backend were stopped and the temporary probe tree was removed.

## Selective server reconciliation

| Item | Disposition |
|---|---|
| Main's four-tool HTTP surface and authentication | Retained. Real loopback Streamable HTTP tests cover authentication, discovery and a memory-only tool call. |
| Cortex-side AgentBridge enrichment | Retired, including its client, session selectors, optional digest section and obsolete feature tests. Negative protocol tests prove no session-service request occurs even with legacy environment configuration. |
| Restricted agent lookup | Unknown agents fail without provisioning namespaces. The agent identifier remains separate from the canonical project label. |
| Restricted search counters | HTTP-subset search does not update access counters; full legacy stdio behavior is preserved. |
| HTTP adapter import | Importing the shared tool module no longer starts stdio or invokes database initialization. |
| Portable Jest invocation | Ported the side branch's direct JavaScript entrypoint pattern, without its unrelated test-exclusion rules. |
| Prompt context budget | Includes framing and long Unicode query text; invalid token counts are rejected before memory access. |
| Staged OAuth authority and memory lifecycle | Not merged or activated. Migrations 009/010, cutover, rollback and later lifecycle slices retain their own gates. |

The new boundary tests first failed against the prior behavior. Token-validation
tests were also checked with the actual guard temporarily removed, then the guard
was restored and the complete suite passed. No test was skipped to obtain a pass.
