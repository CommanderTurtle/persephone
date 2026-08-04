# OMP migration: planned versus delivered

This document closes the loop on the workstation analysis recorded in `Omp Thoughts.md`. The original analysis concluded that OMP could replace Hermes only when paired with a small sovereign control plane. Persephone is that control plane.

The result is deliberately not a Hermes fork and not a second agent harness. OMP continues to own the model loop, editing, LSP, planning, steering, tasks, skills, MCP, ACP, profiles, artifacts, compaction, and sessions. Persephone owns only the persistent operational concerns that do not belong in the interactive harness.

## Original control-plane requirements

|Original requirement|Delivered implementation|Boundary|
|---|---|---|
|Daemon supervisor|A systemd user service runs the Bun daemon and its OMP RPC worker pool.|Persephone does not supervise unrelated workstation services.|
|Durable event queue|SQLite WAL inbox and outbox state, deduplication, bounded retries, crash recovery, and route persistence.|Messages are text-first in this release; binary attachment ingestion remains transport-specific future work.|
|Channel-to-session routing|Every Signal contact/group, Discord DM/channel/thread channel, and Slack DM/channel/thread maps to a persistent OMP session.|A route is intentionally isolated from every other route.|
|Durable scheduler|Five-field local-time cron definitions persist in SQLite, avoid duplicate execution for a minute, retain the latest result/error, and can deliver through any enabled transport.|It does not replay every minute missed while the host was powered off or maintain an unbounded run ledger.|
|Remote approvals|OMP RPC UI requests produce expiring approval records bound to the exact originating transport and route.|OMP's native per-tool policy remains authoritative and can still deny a tool before remote approval.|
|Operational profiles|Routes can select native OMP profiles and independently pin provider, model, thinking level, and working directory.|Persephone does not duplicate Hermes' full identity/credential/profile-process abstraction. OMP remains the profile owner.|

## Channel architecture

Hermes' separation between platform adapters was preserved. Signal, Discord, and Slack do not share platform code or credentials. They implement one small transport contract and feed the same durable control plane:

```text
signal-cli HTTP/SSE ─┐
Discord Gateway/REST ├─ transport event ─ SQLite route/queue ─ OMP RPC worker
Slack Socket/Web API ┘                                      └─ durable reply
```

- Signal uses the local `signal-cli` JSON-RPC/SSE service.
- Discord uses Gateway v10 plus REST and supports DMs, channels, and thread channels.
- Slack uses Socket Mode plus the Web API and preserves Slack thread identity.
- Each adapter is disabled by default, separately allowlisted, and separately health-checked.
- Commands, steering, follow-ups, model selection, and approvals behave consistently because those semantics live above the transport boundary.

GitHub is intentionally not treated as a fourth chat transport. OMP already ships `roboomp`, whose webhook verification, durable issue state, isolated worktrees, OMP RPC sessions, and credential-separated `gh-proxy` are better suited to GitHub automation. Persephone only includes optional local health discovery for that native service.

## Web tooling

The workstation's two web systems remain separate by design:

- **Firecrawl owns search.** Persephone registers OMP's `web_search` schema against the self-hosted Firecrawl `/v2/search` endpoint. Firecrawl may use the local SearXNG container internally; SearXNG is not exposed as a competing OMP provider. A local outage always fails closed.
- **Camofox owns browsing and automation.** Its native MCP tools are registered with OMP, and Persephone's same-name `browser` adapter maps OMP's open/run/close workflow to Camofox's local HTTP control plane. OMP's Chromium/Puppeteer backend never starts.

This is not a Firecrawl-to-browser substitution. Search and interactive browser state have distinct owners.

## Existing workstation integrations

|System|Delivered OMP role|
|---|---|
|Context Mode|Linked through its native OMP plugin manifest for lifecycle hooks, with its bundled stdio MCP launched by Bun for the `ctx_*` tool surface.|
|Retrieval|Watcher-backed stdio MCP for archived skills and semantic/session material.|
|Librarian|Public stdio MCP plus an isolated OMP RPC profile for delegated retrieval and synthesis.|
|Codebase Memory|Compiled stdio MCP for project structure, graph, and wiki knowledge.|
|Camofox|Authoritative browser MCP.|
|Firecrawl|Authoritative local search provider.|
|Local model|Inherited from OMP's selected profile unless a route deliberately overrides it.|
|Zed|OMP's native `omp acp` path; Persephone adds only a convenience launcher.|

Mnemopi owns narrowly OMP-specific cross-session memory in the interactive profile. It is project-scoped, locally embedded, bounded to a small injection budget, and runs without an auxiliary LLM. Retrieval remains the archived skill/external-corpus owner; Librarian remains delegated synthesis; Context Mode remains bulk working context; Codebase Memory remains the code graph. Mnemopi is disabled in headless Persephone and Librarian profiles so those workers do not create duplicate recall or consume another model sequence.

## Native OMP features left native

The original analysis identified many things that looked like possible migration work but were already first-class OMP behavior. Persephone therefore leaves these untouched:

- Hashline and LSP-backed editing;
- plan-mode enforcement and mid-turn steering;
- tasks, subagents, Agent Hub, swarm/DAG orchestration, and async jobs;
- artifacts, output minimization, compaction, skills, and rules;
- provider/model configuration and coding-session persistence;
- MCP, ACP, RPC, extensions, and tool approval policy.

The absence of wrappers here is intentional. Updates to these capabilities arrive through OMP's normal update path.

## Privacy and runtime policy

- Bun is the only JavaScript runtime required by Persephone.
- No Node executable, pnpm workspace, cloud relay, or analytics service is introduced.
- `OTEL_SDK_DISABLED=true` is forced for the daemon and OMP RPC children.
- The control API binds to loopback by default; non-loopback binding requires a bearer token.
- Third-party platform traffic occurs only when its explicit Discord or Slack adapter is enabled.
- Firecrawl and Camofox default to loopback endpoints.

## Optional stock Orca companion

Orca is not required by Persephone or OMP ACP. Operators who want its desktop worktree-orchestration surface should use the unmodified upstream desktop package as a separate application. On Debian and WSL, install the stable `orca-ide_<version>_amd64.deb` (or `arm64`) release asset; do not clone the application source and do not substitute its AppImage for the native package. Orca does not replace the gateway, OMP, or Zed, and opening an ordinary worktree in Zed remains the native `zed .` command.

Persephone includes a small Debian lifecycle helper. It selects the current stable package for the host architecture, verifies GitHub's published SHA-256 digest and the package's `Package`, `Version`, and `Architecture` fields, compares against `dpkg-query -W orca-ide`, and delegates dependency-aware installation to `apt-get`. It deliberately detects `orca-ide`, not Debian's unrelated `orca` screen-reader package.

```bash
uv run scripts/orca-deb.py check
uv run scripts/orca-deb.py install --private
```

The second command needs an interactive `sudo` prompt. `--private` installs a per-user desktop override using Orca's documented `DO_NOT_TRACK=1` and `ORCA_TELEMETRY_DISABLED=1` kill switches. Packaged Orca follows its own stable auto-update channel; the helper remains useful for a deterministic version check, first install, or package repair without maintaining an Orca fork.

## Revised verdict

The original document's revised hypothesis was correct: **OMP plus a small sovereign control plane can credibly replace Hermes for this workstation's interactive, coding, research, scheduled, and messaging workflows.**

The result should be understood as a clean architectural equivalent, not a line-by-line Hermes recreation. Hermes may coexist during channel cutover, but one Signal account must have only one active consumer. Persephone is ready for that cutover once the operator enables the desired adapters and verifies their platform credentials.

The deliberately unclaimed edges are explicit: transport attachments, powered-off cron catch-up/history, and Hermes-style full operational identity lifecycle. None is hidden behind a misleading compatibility claim, and none changes the ownership model described above.
