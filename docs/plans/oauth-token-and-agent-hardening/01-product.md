# Product: OAuth Revocation and Agent Isolation

## Problem

When I disconnect or revoke Cortex access, that access must truly stop instead of continuing through an older saved connection. If Cortex is used by more than one person or agent, each person must only reach the memory agent they were explicitly given; changing a request must never expose or alter somebody else's memory. These protections must not bring back the repeated sign-in problem that made the ChatGPT plugin frustrating to use.

## Success metric

Zero confirmed incidents per quarter in which a revoked connection continues accessing Cortex or an authorized person reaches a memory agent they were not granted, measured through the production security audit trail and scheduled end-to-end security checks.

## Announcement — the blog post before the feature

Cortex connections are now fully controllable and private to the person and agent they belong to. Disconnecting or revoking access takes effect immediately, even if an older saved connection is presented again. Each authorized person can use only the Cortex memory agent they were granted. Existing legitimate ChatGPT connections continue working without repeated sign-ins. These protections make Cortex ready for safer multi-user operation without sacrificing the reliable connection experience.

## Screens

No UI.
