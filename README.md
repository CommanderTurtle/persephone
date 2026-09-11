<h1 align="center">Persephone</h1>

<p align="center">Obligatory greek goddess goth girl gateway compatibility layer for <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>.</p>

![persephone-krea-gen](https://huggingface.co/sHEL1562/shelling/resolve/main/src/persephone-cropped.jpg)

Persephone turns a normal OMP installation into an optional always-on local agent without forking or patching OMP. OMP remains the agent engine. Persephone owns only the operational layer that does not belong inside a coding harness: durable delivery queues, channel-to-session routing, persistent RPC workers, cron, service lifecycle, and remote approval correlation.

It uses Bun, SQLite, OMP's documented JSONL RPC protocol, native OMP plugins/MCP profiles, and a systemd user service. There is no Node runtime, cloud relay, analytics service, web framework, or second model abstraction.

## What it adds

- Persistent `omp --mode rpc` workers that resume the correct OMP session after restart.
- Durable SQLite inbox/outbox with crash recovery and bounded retries.
- Separate Signal, Discord, and Slack transports with one durable OMP routing contract.
- Standard five-field cron prompts with optional delivery to any enabled transport.
- Conversation-bound `/approve` and `/deny` replies for headless OMP UI requests.
- Mid-turn `/steer`, queued `/follow`, `/model`, `/thinking`, `/cwd`, and `/new` controls.
- A local authenticated health/control API.
- Delegated native registration of Context Mode, Librarian, Retrieval, and Camofox, plus direct Codebase Memory registration.
- Localflame's complete Firecrawl MCP surface, installed through Localflame's own repeatable OMP integration script.
- A real OMP-compatible `browser` tool backed by local Camofox rather than Puppeteer/Chromium.
- A small OMP extension with `/persephone`, `persephone_status`, and `persephone_submit`.
- Zed-first operation through OMP's own `omp acp` bridge.
- A pinned native RoboOMP deployment with isolated issue worktrees, credential-proxy separation, proposal-only scheduled audits, and Orca review handoff.

## What it deliberately does not add

OMP already provides editing, Hashline snapshots, LSP, plan-mode enforcement, tasks, subagents, swarm DAGs, async jobs, artifacts, compaction, ACP, model routing, MCP, skills, rules, and extension hooks. Persephone does not wrap or reimplement any of those. Localflame owns Firecrawl search, scrape, indexed reads, outlines, images, and retained resources as one stdio MCP. Persephone retains only the `browser` compatibility adapter that maps OMP's open/run/close workflow onto local Camofox.

It also does not install `pi-gateway`, `remote-pi`, Orca, Hermes, or another memory product. OMP's native Mnemopi backend remains OMP-owned; the interactive profile can use its project-scoped local SQLite memory without involving Persephone. Orca informed the durable run/dispatch/heartbeat model, but no Orca code or UI was copied. Hermes informed the platform-adapter boundary, but Hermes is not a runtime dependency. GitHub issue automation remains OMP's native `roboomp` service rather than a second, less-isolated implementation inside Persephone.

For operators who separately want Orca's desktop worktree view, `scripts/orca-deb.py` provides a version-aware installer for the official stable Debian package. It does not build Orca, clone its source, or make Orca a Persephone dependency. See [the OMP comparison](docs/OMP-THOUGHTS-COMPARISON.md#optional-stock-orca-companion).

![compatibility.jpg](https://huggingface.co/sHEL1562/shelling/resolve/main/src/persephone-harness.jpg)

## Install

Prerequisites:

- Linux or WSL with systemd user services;
- Bun 1.3.14 or newer (Sandwich is supported);
- a working, configured vanilla `omp` command;
- optional repositories under `~/Hermes` for the integrations you enable;
- optional `signal-cli` HTTP daemon for Signal;
- optional Discord bot or Slack Socket Mode app credentials for those channels.

```bash
git clone https://github.com/CommanderTurtle/persephone.git ~/Hermes/persephone
cd ~/Hermes/persephone
./scripts/install.sh
```

The installer creates, but does not guess secrets for:

- `~/.config/persephone/config.json`
- `~/.config/persephone/.env`

It also creates a managed `~/.local/bin/persephone` symlink to this clone and installs, but does not start, the systemd user unit. Set `PERSEPHONE_BIN_DIR` when `~/.local/bin` is not the desired command directory.

Edit those files, then run:

```bash
persephone integrate
persephone doctor
persephone install-service --start
```

The same operations have zero-knowledge repository entrypoints:

```bash
./scripts/integrate.sh
./scripts/doctor.sh              # configuration only; no service probes
./scripts/doctor.sh --runtime    # include configured local service probes
./scripts/restart-if-active.sh
./scripts/update.sh
```

`persephone doctor --integration-only` is the non-service verification used by dashboard installers; it does not require the daemon or Signal to be running.
The full `persephone doctor` additionally asks OMP itself to connect to the isolated Librarian MCP and report its tool count; it does not send a model prompt.

If no provider, model, or thinking level is set in Persephone, each new route inherits the selected OMP worker profile's native defaults. The shipped configuration separates the interactive `default` profile from a `persephone` worker profile. Integration copies model definitions, then disables Advisor and autonomous memory for the headless worker so one background route consumes one model sequence.

Every messaging transport is disabled by default and fails closed. Signal requires `SIGNAL_ACCOUNT`; Discord requires `DISCORD_BOT_TOKEN`; Slack requires both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Each enabled transport also requires an explicit user/group/server/channel allowlist unless its own `allowAll` flag is deliberately set.
Leave it disabled while Hermes owns the same Signal account. During a cutover, stop the Hermes gateway first, enable Persephone's allowlists/account, and then start Persephone so only one SSE consumer can route a message.

## Existing integrations

`persephone integrate` is idempotent and uses each project through its native surface:

|Project|OMP integration|
|---|---|
|Localflame|Its own `install.sh --target omp`; the result is the seven-tool Firecrawl stdio MCP plus its routing skill|
|Context Mode|Its own `integrate.sh --target omp`; the result is its native lifecycle plugin plus the bundled Bun stdio MCP|
|Librarian|Public stdio MCP plus a private `librarian` OMP RPC profile whose MCP surface contains only deterministic OKF tools|
|Retrieval|Its own `integrate.sh`; the result is its indexed stdio MCP, session-close hook, and routing skill|
|Codebase Memory|Its compiled, zero-dependency stdio server|
|Camofox|Its own `integrate.sh --target omp`; the result is its built stdio MCP launched by Bun|

### Local web backends

The default configuration expects Localflame at `~/Deepseek/localflame`, Firecrawl at `http://127.0.0.1:3002`, and Camofox at `http://127.0.0.1:9377`. `persephone integrate` delegates to each project's checked-in integration script with its configured service URL. Both services may be keyless on a trusted local host; set `FIRECRAWL_API_KEY` or `CAMOFOX_API_KEY` in `~/.config/persephone/.env` when their local authentication is enabled.

Codebase Memory is also reconciled by its own `integrate-local.sh --target omp`
contract. Persephone no longer copies its binary path or MCP definition, so a
Codebase Memory update has one owner and its public/private OMP profile rules
remain identical whether invoked directly or through `persephone integrate`.

Persephone no longer registers a second `web_search` implementation. Localflame is the single owner of the self-hosted Firecrawl transport and exposes `firecrawl_search`, `firecrawl_scrape`, `firecrawl_read`, `firecrawl_find`, `firecrawl_outline`, `firecrawl_images`, and `firecrawl_resources`. OMP's existing web providers are preserved; the small `localflame` routing skill tells agents to prefer the indexed Firecrawl path without removing other operator-configured choices. Exa remains disabled in Persephone's managed profiles because it is a hosted search service rather than software that can be installed locally.

Integration also disables OMP's passive startup and marketplace update checks in every managed profile. Updates remain explicit operator actions; no background version request is part of the normal agent lifecycle.

Camofox is HTTP/MCP rather than CDP. Persephone's `browser` adapter maps OMP's named-tab `open`, `run`, and `close` contract onto Camofox's local HTTP API. Browser code runs in a bounded Bun worker with `tab`, `page`, `browser`, `display`, `assert`, and `wait` helpers; normal observation, ref/selector interaction, navigation, evaluation, waits, and screenshots stay compatible. Camofox's MCP remains available for its larger extraction, download, profile, and batch surface. Raw Puppeteer-only APIs are deliberately absent, and Puppeteer never starts. A cold Camofox health response with no browser session is normal; the browser starts on first use.

Existing OMP MCP entries and config keys are preserved. Their pre-Persephone values are recorded once and restored by `persephone uninstall`. A malformed OMP config is never overwritten. Integration applies the workstation's eight-sequence policy through OMP's own `config set` command:

- the interactive profile has one primary turn, one Advisor, and up to four native OMP task workers;
- Persephone reserves one persistent worker;
- Librarian reserves one isolated delegated worker;
- brief Mnemopi extraction overlaps are queued by vLLM rather than creating another permanent worker.

Every built-in OMP model role is filled from the configured local default unless that role already has an explicit selector. Snapcompact remains native, while both remote-compaction switches, hosted search, automatic marketplace traffic, and model fallback are disabled. Interactive Mnemopi uses the local `smol` role for structured extraction every four user turns; durable gateway and Librarian profiles keep autonomous memory and Advisor disabled. Retrieval and Persephone expose one concise skill directory each instead of advertising the archived skill corpus.

The worker profiles receive managed copies of the interactive model definitions, but not its sessions, model cache, or credential database. The isolated Librarian profile contains only its deterministic `librarian-okf` MCP surface, preventing delegated work from recursively reaching the public Librarian or the ordinary external-tool stack. Librarian's Hermes configuration is not changed; the OMP MCP receives explicit environment overrides, so both backends can coexist.

## Messaging gateway

The three transports are independent adapters:

|Channel|Native protocol|Conversation route|
|---|---|---|
|Signal|Local signal-cli JSON-RPC + SSE|Contact or group|
|Discord|Gateway v10 WebSocket + REST|DM, channel, or Discord thread channel|
|Slack|Socket Mode WebSocket + Web API|DM, channel, or Slack thread|

Microsoft Teams is not implemented. Slack's `allowedTeams` setting refers to Slack workspace/team IDs.

Discord needs the Message Content privileged intent. Grant only View Channels, Send Messages, and Read Message History where the bot is meant to operate. With `requireMention: true` (the default), guild traffic is accepted only when the bot is mentioned; direct messages do not need a mention.

For Slack, enable Socket Mode, give the app token `connections:write`, and subscribe the bot to `app_mention` and `message.im`. Grant `app_mentions:read`, `chat:write`, and the history scopes for only the channel types you intend to use. If `requireMention` is disabled, subscribe to the corresponding channel message events as well.

Commands are identical on every channel:

```text
/status
/stop
/new
/steer corrective direction
/follow next task after this turn
/cwd /absolute/project/path
/model provider/model-id
/thinking high
/approve 12
/deny 12
```

Ordinary messages enter the OMP session mapped to that channel conversation. DMs, channels, Signal groups, Discord thread channels, and Slack threads remain distinct. Approval replies are accepted only from the exact originating transport and route.

`/status` includes the root session state and a compact native OMP `task`/`hub`
child tree. The local control API also reports cached per-worker child counts and
activity without introducing a second scheduler or child-management surface.

Persephone serializes ordinary work and state-changing commands per route, while `/approve`, `/deny`, `/steer`, `/follow`, `/stop`, `/status`, and `/help` bypass that queue. This preserves arrival order without deadlocking an approval or preventing an operator from steering or stopping an active turn. Core loops are supervised with bounded restart backoff, and `/health` reports their real state rather than treating a live HTTP socket as proof that the gateway is healthy. See [Gateway audit](docs/GATEWAY-AUDIT.md) for the source-level comparison with Hermes Gateway, Pi Gateway, Orca, and native OMP.

## Owner workspace contract

The checked-in CLI exposes the complete, versioned data contract used by the
Diogenes Persephone workspace:

```bash
persephone workspace show --limit 50
persephone workspace queue inbox 12
persephone workspace queue outbox 8
persephone workspace mutate /path/to/confirmed-mutation.json --consume
```

`workspace show` combines the public configuration, connector readiness,
copy-ready Signal/Discord/Slack setup steps, routes, schedules, bounded queue
previews, approvals, and worker state. Secret rows expose only their environment
variable name and whether a value is configured. The corresponding daemon
routes are `GET /v1/workspace?limit=50` and
`GET /v1/queue/{inbox|outbox}/{id}`; normal API bearer authentication still
applies.

`workspace mutate` accepts a typed JSON envelope rather than a command string.
Its supported actions are `configuration.replace`, `schedule.put`,
`schedule.remove`, `schedule.enable`, `route.remove`, `queue.retry`, and
`prompt.enqueue`. Configuration and secret-environment edits are validated and
written atomically with mode `0600`; secret values are write-only and never
appear in command output. A changed configuration takes effect after a normal
`persephone restart`. Diogenes persists and confirms every mutation plan before
it invokes this owner command, then uses `--consume` so the payload is removed
whether the owner operation succeeds or fails.

## Durable schedules

```bash
persephone schedule add morning "0 8 * * *" "Review the project task sheet"
persephone schedule add report "30 18 * * 1-5" "Summarize today's work" --to signal:+15555550123
persephone schedule add review "0 9 * * 1" "Review open work" --to discord:channel:1234567890
persephone schedule add audit "0 17 * * 5" "Audit this week" --to slack:channel:C123456
persephone schedule list
persephone schedule remove morning
```

Cron is evaluated in the service's local timezone. A minute is recorded before it can run twice, and failures remain visible in SQLite/status output.

## GitHub automation

OMP already ships `python/robomp`, a purpose-built GitHub issue/PR orchestrator with webhook HMAC verification, allowlisted repositories, durable SQLite state, per-issue OMP RPC sessions, isolated worktrees, and a credential-holding `gh-proxy` sidecar. Persephone builds that native service from a pinned OMP commit and exposes lifecycle commands without replacing its queue, worker, prompt, or GitHub tools:

```bash
persephone git-agent init
persephone git-agent doctor
persephone git-agent update
persephone git-agent build
persephone git-agent up
persephone git-agent workspace show
persephone git-agent workspace inspect CommanderTurtle/repository#123
persephone git-agent triage CommanderTurtle/repository#123
persephone git-agent review ~/Hermes/repository 123
```

`workspace show` is the versioned, redacted owner contract used by Diogenes. It
combines native RoboOMP status, events, issues, releases, logs, repository
browse data, container state, and the writable configuration schema without
returning token values. `workspace inspect` reads one isolated issue worktree,
its Git history/diff, OMP session metadata, artifacts, and bounded tool-call
history through a read-only helper inside the container. State changes use a
typed JSON envelope through `workspace mutate`; Diogenes plans and confirms
that envelope before invoking it.

`git-agent update` resolves the installed host OMP version to its signed source
tag, atomically updates the private version/commit pair, validates the complete
configuration, rebuilds, and replaces the running containers. It is deliberate
because rebuilding can interrupt active issue work. `build` never changes the
pin on its own.

The optional audit loop creates one proposal-only issue through the credential proxy, then hands it to native manual triage. Implementation still requires a trusted maintainer directive:

```bash
persephone git-agent dream CommanderTurtle/repository
persephone git-agent dream-timer-enable CommanderTurtle/repository \
  'Sun *-*-* 05:00:00'
```

Set `roboomp.enabled` after the service is healthy and `persephone doctor` will include its local `/healthz` endpoint. See [GitHub bot integration](docs/GITHUB-BOT.md) for the GitHub permissions, webhook events, isolation boundary, fork-reconciliation workflow, and Orca review path.

## Zed

Use OMP's native ACP server in Zed:

```bash
omp acp
```

`persephone zed /path/to/project` opens the project, but Persephone never inserts another editor bridge between Zed and OMP. Editor writes and permission requests therefore keep OMP's native ACP behavior.

OMP deliberately gives the ACP client ownership of MCP servers. Zed sessions do not fall back to OMP's normal on-disk MCP registry, although plugins, extensions, hooks, and skills still load. An ACP client must pass the desired stdio/HTTP/SSE definitions with session creation; whether a particular Zed build exposes that configuration is a Zed-side capability that must be verified. See the [OMP configuration research](docs/OMP-CONFIGURATION-RESEARCH.md#mcp-rpc-acp-and-librarian) for the exact boundary.

## Lifecycle

```bash
persephone status
persephone doctor
persephone start
persephone stop
persephone restart
persephone update
persephone uninstall
```

`update` refuses a dirty Persephone worktree, uses `git pull --ff-only`, runs the Bun lockfile install, re-applies the idempotent integration, and restarts only an already-active service. `uninstall` removes the service and Persephone plugin link while preserving config and SQLite state.

## Privacy and trust

![statue](https://huggingface.co/sHEL1562/shelling/resolve/main/src/persephone-statue.jpg)

- `OTEL_SDK_DISABLED=true` is forced for the daemon and every OMP RPC child.
- No collaboration relay is started.
- The API defaults to loopback. Non-loopback binding requires a bearer token.
- Signal, Discord, and Slack are allowlist-only unless their explicit `allowAll` switch is set.
- Approval IDs are bound to the originating conversation and expire.
- OMP's own per-tool approval policy remains authoritative.
- OMP extensions execute as trusted in-process code. Install Persephone only from a reviewed source tree.

See [Architecture](docs/ARCHITECTURE.md), [Capability matrix](docs/CAPABILITY-MATRIX.md), [planned-versus-delivered analysis](docs/OMP-THOUGHTS-COMPARISON.md), [OMP configuration research](docs/OMP-CONFIGURATION-RESEARCH.md), and [Security](docs/SECURITY.md).
