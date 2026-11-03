# Cortex ownership and project identity

This is the cross-project ownership manifest for consolidation. It documents
source and authority boundaries; it does not migrate stores, register aliases,
deploy connectors, or authorize a merge. The working integration plan is
[Superhuman Go MCP integration](superhuman-go-mcp-integration-plan.md).

## Source ownership

Paths in this table are relative to the named repository, not installed copies.
An installed extension, a working-tree change, and a deployed service are
different observations.

| Component | Source owner and location | State and authority boundary |
|---|---|---|
| Cortex server memory | Cortex: `src/db/`, `src/ingestion/`, `src/mcp/server.ts` | Database-backed memory. Its agent namespace and authorization are not the local notes filesystem. |
| Remote Cortex access | Cortex: `src/mcp/http-server.ts`, `src/mcp/auth.ts` | Authenticated, curated read-only HTTP surface. A read-only tool declaration does not prove every dependency is memory-only. |
| Prompt context composition | Cortex: `src/mcp/prompt-context.ts`, `src/mcp/agentbridge-client.ts` | The current client can add AgentBridge context when `AGENTBRIDGE_MCP_URL` is configured. Unconfigured composition is memory-only. Keep this opt-in boundary explicit. |
| Local OmO memory | SimsOnline: `tools/omo/extensions/cortex-memory.next.js`, `tools/omo/config/`, `tools/omo/install.py` | Filesystem notes, agent-specific memory and federation. Installation selects the live provider; a source revision does not attest which copy is loaded. |
| Frozen v3 ranker and evaluation | SimsOnline: `tools/omo/extensions/cortex-v3/` | Frozen baseline `7b727bf3`, ranker `cortex-v3-recall/2-lennorm`. Injection telemetry repairs belong outside this directory. |
| Live injection and outcome telemetry | SimsOnline: `tools/omo/extensions/cortex-v3-inject.js`, `tools/omo/extensions/cortex-v3-inject/` | Owns prompt event identity, holdout wiring and outcome attribution. Uses `cortex-live-recall`, distinct from benchmark messages. Ledgers remain outside tracked source. |
| AgentBridge | AgentBridge server; Cortex owns only its client adapter | Session history, live inspection and transport. Session context is not an authoritative Cortex memory store, and activity flags alone do not prove work or deployment. |

The HTTP and composition files above include existing local integration work.
This manifest records their current contracts, not a release or deployment claim.
Before exposing a connector, decide whether Cortex-side session enrichment or
separate client-side composition owns the combined result; do not enable both
implicitly.

## Canonical identity

Use these documentation identifiers when referring to the projects:

| Project identifier | Meaning | Worktree policy |
|---|---|---|
| `cortex-server` | This TypeScript server and its database-backed memory | Branches/worktrees remain source checkouts, not new memory authorities. |
| `simsonline` | SimsOnline development and its explicitly configured local memory | Share a store only through an intentional, documented alias mapping. |
| `deadlock-ai` | The separate Deadlock AI project | Do not infer sharing from a similar directory name or a shared provider. |

These identifiers are not a new runtime resolver or a replacement for a
database `agent_id`. Record the following separately:

- **Project:** the explicit canonical project and intended memory namespace.
- **Agent:** the identity owning notes or a database namespace within that project.
- **Worktree:** checkout root, branch and revision; these describe code context.
- **Session:** the host session identity, separate from project and agent identity.
- **Prompt:** an opaque unique event identifier, carried unchanged into its outcome.
- **Provenance:** repository, relative source path and revision for copied or reused code.

A path alias must say which project and store it resolves to and why sharing is
intended. Neither a matching worktree prefix nor a common session transport is
sufficient authority to combine stores. Existing sharing is not itself evidence
of an isolation violation; changing it requires checking the configured intent.

## Telemetry interpretation

- New prompt IDs are opaque UUIDs; consumers join on the full identifier, not a
  parsed session/turn suffix. Session and turn remain separate fields.
- Outcomes are bounded by the originating zero-based user turn and stop at the
  next user entry, including when the originating turn has no assistant response.
  Timestamps remain descriptive rather than determining attribution.
- `openedAny` and `openedInjected` mean a matching access request was observed.
  They do not establish successful reading, useful application, or task success.
- Exposure, successful access, application and task outcome need separate evidence.
  Zero recorded recall calls does not distinguish unavailable, unused and unrecorded.
- Historical duplicate IDs are not repaired by changing future ID generation.
  Preserve those rows and exclude ambiguous joins from causal comparisons.
- Keep live and benchmark message types separate. Do not retune the frozen ranker
  or claim a new efficacy result from telemetry repair.

## Consolidation order

1. Repair and verify identity and attribution in the injection wrapper.
2. Use this manifest to assign each reused implementation to one source owner.
3. Reconcile server, OAuth, migration and connector work in separately verified
   changes, preserving unrelated working edits.
4. Verify loaded configuration and end-to-end host behavior before a rollout.
5. Collect a fresh, unambiguous evaluation window before judging live efficacy.
