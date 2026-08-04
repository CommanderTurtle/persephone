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
|Large external corpus containment|Context Mode|Native OMP plugin integration|
|Archived skills/session semantic search|Retrieval|Native stdio MCP integration|
|Code graph/wiki/coverage|Codebase Memory|Native compiled stdio MCP integration|
|Delegated retrieval/synthesis|Librarian|Native OMP JSONL RPC backend + private profile|
|Agent browser|Camofox|Native stdio MCP integration|
|Live web search|Persephone + self-hosted Firecrawl|OMP-compatible `web_search`; local-first and fail-closed|
|SearXNG|Firecrawl internal backend|Not exposed as a competing OMP provider|
|Puppeteer/Chromium browser|OMP|Replaced in the active set while Camofox is enabled|
|OMP-specific autonomous memory|OMP Mnemopi|Intentionally disabled initially to avoid duplicate recall|
|Hermes gateway|Hermes|Not required by Persephone; may coexist during migration|
|Orca desktop UI|Orca|Excluded; Zed + OMP already cover it|
|`pi-gateway`|Third party|Excluded: outdated runtime and prompt-only policy boundary|
|`remote-pi` cloud relay|Third party|Excluded: plaintext relay and Node runtime conflict with requirements|
|OMP collaboration relay|OMP|Excluded by default; no cloud relay is started|
|GitHub issue/PR agent|OMP roboomp|Reused as its independently isolated service; optional health integration|

## Original analysis: completion check

- Persistent daemon supervisor: **implemented**.
- Durable event queue and retry state: **implemented**.
- Contact/thread/channel → OMP session registry: **implemented**.
- Durable scheduler: **implemented**.
- Remote approval correlation: **implemented**.
- Operational profiles: **uses OMP native profiles**, with per-route selection.
- Signal gateway: **implemented against signal-cli's local HTTP/SSE API**.
- Discord and Slack gateways: **implemented as independent Bun-native platform adapters**.
- GitHub bot: **delegated to OMP's native roboomp implementation, with health integration and no duplicated credentials or webhook path**.
- Local model support: **left native to OMP**, with route-level provider/model selection.
- Context Mode, Retrieval, Librarian, Codebase Memory, Camofox: **native integration implemented**.
- Self-hosted Firecrawl search and Camofox-first browsing: **implemented through native OMP extension seams**.
- Zed: **native ACP path preserved**.
- Telemetry-off local operation: **forced for Persephone/child processes**.
- Sandwich/Bun: **Bun-only runtime; no Node executable or pnpm**.

The detailed closure against the original workstation analysis, including the deliberately unclaimed edges, is in [OMP migration: planned versus delivered](OMP-THOUGHTS-COMPARISON.md).
