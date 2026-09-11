# Capability matrix

This matrix is the implementation answer to the original OMP migration analysis.

|Need|Owner|State|
|---|---|---|
|Hashline editing, LSP, plan enforcement|OMP|Native; untouched|
|TUI steering/follow-up queues|OMP|Native; exposed remotely by Persephone|
|Tasks, subagents, Agent Hub|OMP|Native; untouched|
|Swarm/DAG orchestration|OMP `@oh-my-pi/swarm-extension`|Native; schedule it rather than recreate it|
|Async shell/agent jobs|OMP|Native; process-lifetime work remains OMP-owned|
|Zed integration|OMP ACP|Native `omp acp`; no Orca/Monaco fork|
|Model/provider routing|OMP|Native; route may pin provider/model|
|Coding session persistence|OMP|Native files; Persephone persists route mapping|
|Always-on process supervision|Persephone|Implemented with systemd + worker pool|
|Durable inbox/outbox|Persephone|Implemented with SQLite WAL|
|Signal direct/group messaging|Persephone + signal-cli|Implemented, allowlist-only|
|Discord DM/channel/thread messaging|Persephone|Implemented with Gateway v10 + REST, mention-gated and allowlist-only|
|Slack DM/channel/thread messaging|Persephone|Implemented with Socket Mode + Web API, mention-gated and allowlist-only|
|Remote approvals|Persephone + OMP RPC UI|Implemented, route-bound and expiring|
|Durable cron|Persephone|Implemented, five-field local-time cron|
|Health/control endpoint|Persephone|Implemented, loopback by default|
|Large external corpus containment|Context Mode|Native OMP plugin hooks plus its bundled stdio MCP launched with Bun|
|Archived skills/session semantic search|Retrieval|Native stdio MCP integration|
|Code graph/wiki/coverage|Codebase Memory|Native compiled stdio MCP integration|
|Delegated retrieval/synthesis|Librarian|Native OMP JSONL RPC backend + private profile|
|Agent browser|Persephone + Camofox|OMP-compatible `browser` adapter plus native Camofox stdio MCP|
|Web search, scrape, and indexed reads|Localflame + self-hosted Firecrawl|Seven-tool stdio MCP installed through Localflame's own OMP integration|
|SearXNG|Firecrawl internal backend|Not exposed as a competing OMP provider|
|Puppeteer/Chromium browser|OMP|Same-name tool is replaced; the Puppeteer backend is never started|
|OMP-specific autonomous memory|OMP Mnemopi|Enabled only for the interactive profile, project-scoped and locally embedded|
|Hermes gateway|Hermes|Not required by Persephone; may coexist during migration|
|Orca desktop UI|Orca|Optional stock review surface for RoboOMP PRs; never an agent runtime dependency|
|`pi-gateway`|Third party|Excluded: outdated runtime and prompt-only policy boundary|
|`remote-pi` cloud relay|Third party|Excluded: plaintext relay and Node runtime conflict with requirements|
|OMP collaboration relay|OMP|Excluded by default; no cloud relay is started|
|GitHub issue/PR agent|OMP roboomp|Pinned native service with slot users, issue worktrees/sessions, credential proxy, lifecycle CLI, and health integration|
|Proposal-only repository audits|Persephone seed + OMP roboomp|Narrow issue creation in the credential proxy; native triage and trusted implementation directive|
|GitHub diff review|Orca|Host-clone review handoff; RoboOMP's isolated worktree stays private|

## Original analysis: completion check

- Persistent daemon supervisor: **implemented**.
- Durable event queue and retry state: **implemented**.
- Contact/thread/channel → OMP session registry: **implemented**.
- Durable scheduler: **implemented**.
- Remote approval correlation: **implemented**.
- Operational profiles: **uses OMP native profiles**, with per-route selection.
- Signal gateway: **implemented against signal-cli's local HTTP/SSE API**.
- Discord and Slack gateways: **implemented as independent Bun-native platform adapters**.
- GitHub bot: **delegated to OMP's native roboomp implementation, with a pinned deployment, health/lifecycle commands, and no duplicated worker pool or webhook path**.
- Local model support: **left native to OMP**, with route-level provider/model selection.
- Context Mode, Retrieval, Librarian, Codebase Memory, Camofox: **native integration implemented**.
- Self-hosted Firecrawl research: **delegated to Localflame's stdio MCP**.
- Camofox-first browsing: **implemented through OMP's native extension seam plus Camofox MCP**.
- Zed: **native ACP path preserved**.
- Telemetry-off local operation: **forced for Persephone/child processes**.
- Sandwich/Bun: **Bun-only runtime; no Node executable or pnpm**.

The detailed closure against the original workstation analysis, including the deliberately unclaimed edges, is in [OMP migration: planned versus delivered](OMP-THOUGHTS-COMPARISON.md).
