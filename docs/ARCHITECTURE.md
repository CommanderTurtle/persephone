# Architecture

```text
Signal  Discord  Slack       cron       local API
   │       │       │           │           │
   └───────┴───────┴──── durable SQLite ───┘
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
        │               │
 Localflame MCP     Camofox browser + MCP
```

GitHub work is a separate native OMP lane:

```text
GitHub webhook/manual triage ─ durable RoboOMP queue
                                      │
                         issue worktree + JSONL session
                                      │
                           unprivileged slot OMP RPC
                                      │ audited host tools
                          HMAC-only GitHub proxy ─ GitHub

scheduled audit seed ─ create one enhancement issue ─ native manual triage
Orca host clone ─ fetch PR branch ─ human diff/review/approval
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
- separate Signal, Discord, and Slack transports and allowlists;
- correlation of RPC extension UI requests with remote replies;
- a small status/control API and systemd unit.
- lifecycle/configuration of the pinned native RoboOMP deployment;
- the narrow scheduled-audit issue seed and Orca host-clone handoff.

### Existing repositories own

- Librarian: delegated retrieval, synthesis, OKF mutation, and its MCP-isolated worker profile;
- Retrieval: semantic archival, real-time filesystem watching, and Chroma writes;
- Context Mode: bulk corpus/output containment;
- Codebase Memory: code graph, coverage and architecture queries;
- Camofox: agent browser transport.
- Localflame: Firecrawl search, scrape, bounded resource indexing, and read tools;
- OMP roboomp: GitHub webhook, queue, issue/PR automation, worker-slot isolation, worktrees, sessions, prompts, and audited GitHub tools;
- RoboOMP gh-proxy: the GitHub token and all authenticated GitHub transport;
- Orca: optional host-side graph, worktree, and diff review.

## Web ownership

Localflame owns Firecrawl transport as a standalone stdio MCP and is integrated through its checked-in OMP installer. Persephone does not implement or override `web_search`; it supplies the configured local endpoint to Localflame's installer and leaves OMP's other provider choices intact. Firecrawl owns search orchestration and its SearXNG container remains an internal backend.

Camofox is not a Chrome DevTools Protocol endpoint, so Persephone does not route through OMP's Puppeteer implementation. The same-name `browser` extension preserves OMP's named-tab open/run/close workflow with a bounded compatibility worker and a Camofox-backed page facade. Camofox's MCP remains registered for specialist tools that do not belong in the compatibility surface.

## Model-sequence ownership

The workstation endpoint admits eight parallel sequences. Persephone configures capacity rather than eagerly starting eight agents:

|Owner|Maximum active sequences|
|---|---:|
|Interactive OMP primary|1|
|Interactive Advisor|1|
|OMP task workers|4|
|Persephone gateway worker|1|
|Librarian delegated worker|1|

Advisor is disabled inside subagents and worker profiles. Worker recursion is capped at one level. Mnemopi's periodic local extraction is transient and may queue behind the cap; it does not justify a permanently reserved ninth slot.

Inner async execution is disabled in the Persephone and Librarian worker
profiles. A native task child may replace its waiting parent as the active
generation, but it cannot overlap the parent and silently exceed this budget.

## Worker model

One OMP RPC process owns one active conversation route. This avoids cross-thread session switching while a turn streams. Idle processes are reaped; their session file remains in the `routes` table and is restored through OMP's documented `switch_session` command on the next message.

Prompts are serialized per worker. `/steer` and `/follow` bypass that queue and use OMP's native live-turn commands. OMP protocol v2 is negotiated at startup, including bounded chunk reassembly for large frames.

## Queue recovery

SQLite uses WAL mode, foreign keys, a busy timeout, and explicit claim transitions:

```text
inbox:  pending → running → done|failed
outbox: pending → sending → sent|failed
```

An interrupted `running`/`sending` row returns to `pending` on daemon startup. Upstream event IDs are unique per transport, so an SSE or WebSocket reconnect cannot duplicate accepted events.

## Approvals

RPC `extension_ui_request` dialogs are not auto-approved. Noninteractive notifications can be delivered; confirmation/input requests create a durable approval record, emit a prompt on the originating transport, and wait for a reply from that exact transport and route. Unknown, expired, or cross-route IDs are denied. If the originating route has no live transport, confirmation fails closed.

This mechanism complements rather than replaces OMP approval policy. A user-level `tools.approval.<tool>: deny` still prevents the call before remote interaction.

## Orca influence

Orca's MIT-licensed source was studied for its run/task/dispatch state model, heartbeat reconciliation, decision gates, and crash lifecycle. Persephone uses those architectural lessons in an independent, much smaller implementation. Orca's Electron UI, Monaco editor, provider gateway, and database code are neither vendored nor copied because OMP and Zed already own those surfaces.

For GitHub review, stock Orca is used directly rather than merely studied. The
native RoboOMP branch is fetched into an ordinary host clone registered with
Orca. The agent's private worktree is never registered as an Orca worktree, so
the orchestration and review owners cannot race over the same checkout.
