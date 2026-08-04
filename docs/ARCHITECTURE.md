# Architecture

```text
Signal HTTP/SSE       cron       local API
       │                │           │
       └──────── durable SQLite ─────┘
                 inbox / outbox
                 routes / jobs
                 approvals
                        │
               OMP RPC worker pool
                        │
        ┌───────────────┼─────────────────┐
        │               │                 │
   native OMP       native MCPs       native ACP
  tools/tasks/swarm  and plugins          Zed
```

## Ownership

### OMP owns

- all model calls and provider behavior;
- prompts, turns, steering and follow-ups;
- source mutation, LSP, plan mode and permissions;
- tasks, subagents, async jobs and swarm execution;
- sessions, artifacts, compaction and optional OMP memory;
- MCP/plugin/skill/rule discovery;
- ACP and TUI presentation.

### Persephone owns

- the lifecycle of headless OMP RPC child processes;
- mapping a stable channel/thread identity to an OMP session file;
- durable inbound and outbound message state;
- schedule persistence and missed crash recovery;
- Signal transport and allowlists;
- correlation of RPC extension UI requests with remote replies;
- a small status/control API and systemd unit.

### Existing repositories own

- Librarian: delegated retrieval, synthesis, OKF mutation, and its MCP-isolated worker profile;
- Retrieval: semantic archival, real-time filesystem watching, and Chroma writes;
- Context Mode: bulk corpus/output containment;
- Codebase Memory: code graph, coverage and architecture queries;
- Camofox: agent browser transport.

## Worker model

One OMP RPC process owns one active conversation route. This avoids cross-thread session switching while a turn streams. Idle processes are reaped; their session file remains in the `routes` table and is restored through OMP's documented `switch_session` command on the next message.

Prompts are serialized per worker. `/steer` and `/follow` bypass that queue and use OMP's native live-turn commands. OMP protocol v2 is negotiated at startup, including bounded chunk reassembly for large frames.

## Queue recovery

SQLite uses WAL mode, foreign keys, a busy timeout, and explicit claim transitions:

```text
inbox:  pending → running → done|failed
outbox: pending → sending → sent|failed
```

An interrupted `running`/`sending` row returns to `pending` on daemon startup. Signal message IDs are unique per channel, so reconnecting the SSE stream cannot duplicate accepted events.

## Approvals

RPC `extension_ui_request` dialogs are not auto-approved. Noninteractive notifications can be delivered; confirmation/input requests create a durable approval record, emit a Signal prompt, and wait for a reply from the same route. Unknown, expired, or cross-route IDs are denied. If Signal is disabled, confirmation fails closed.

This mechanism complements rather than replaces OMP approval policy. A user-level `tools.approval.<tool>: deny` still prevents the call before remote interaction.

## Orca influence

Orca's MIT-licensed source was studied for its run/task/dispatch state model, heartbeat reconciliation, decision gates, and crash lifecycle. Persephone uses those architectural lessons in an independent, much smaller implementation. Orca's Electron UI, Monaco editor, provider gateway, and database code are neither vendored nor copied because OMP and Zed already own those surfaces.
