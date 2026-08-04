<h1 align="center">Persephone</h1>

<p align="center">A small, sovereign control plane for <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a>.</p>

Persephone turns a normal OMP installation into an optional always-on local agent without forking or patching OMP. OMP remains the agent engine. Persephone owns only the operational layer that does not belong inside a coding harness: durable delivery queues, channel-to-session routing, persistent RPC workers, cron, service lifecycle, and remote approval correlation.

It uses Bun, SQLite, OMP's documented JSONL RPC protocol, native OMP plugins/MCP profiles, and a systemd user service. There is no Node runtime, cloud relay, analytics service, web framework, or second model abstraction.

## What it adds

- Persistent `omp --mode rpc` workers that resume the correct OMP session after restart.
- Durable SQLite inbox/outbox with crash recovery and bounded retries.
- Signal support through an existing local `signal-cli` HTTP/SSE daemon.
- Standard five-field cron prompts with optional Signal delivery.
- Conversation-bound `/approve` and `/deny` replies for headless OMP UI requests.
- Mid-turn `/steer`, queued `/follow`, `/model`, `/thinking`, `/cwd`, and `/new` controls.
- A local authenticated health/control API.
- Native registration of Context Mode, Librarian, Retrieval, Codebase Memory, and Camofox.
- A small OMP extension with `/persephone`, `persephone_status`, and `persephone_submit`.
- Zed-first operation through OMP's own `omp acp` bridge.

## What it deliberately does not add

OMP already provides editing, Hashline snapshots, LSP, plan-mode enforcement, tasks, subagents, swarm DAGs, async jobs, artifacts, compaction, browser tooling, ACP, model routing, MCP, skills, rules, and extension hooks. Persephone does not wrap or reimplement any of those.

It also does not install `pi-gateway`, `remote-pi`, Orca, Hermes, Mnemopi, or another memory database. Orca informed the durable run/dispatch/heartbeat model, but no Orca code or UI was copied. Hermes informed the Signal transport contract, but Hermes is not a runtime dependency.

## Install

Prerequisites:

- Linux or WSL with systemd user services;
- Bun 1.3.14 or newer (Sandwich is supported);
- a working, configured vanilla `omp` command;
- optional repositories under `~/Hermes` for the integrations you enable;
- optional `signal-cli` HTTP daemon for Signal.

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

`persephone doctor --integration-only` is the non-service verification used by dashboard installers; it does not require the daemon or Signal to be running.
The full `persephone doctor` additionally asks OMP itself to connect to the isolated Librarian MCP and report its tool count; it does not send a model prompt.

If no provider, model, or thinking level is set in Persephone, each new route inherits the selected OMP profile's native defaults.

Signal is disabled by default and fails closed. Enabling it requires `SIGNAL_ACCOUNT` and at least one explicit `allowedSenders` or `allowedGroups` entry.
Leave it disabled while Hermes owns the same Signal account. During a cutover, stop the Hermes gateway first, enable Persephone's allowlists/account, and then start Persephone so only one SSE consumer can route a message.

## Existing integrations

`persephone integrate` is idempotent and uses each project through its native surface:

|Project|OMP integration|
|---|---|
|Context Mode|`omp plugin link` using its own `omp.extensions` manifest|
|Librarian|Public stdio MCP plus a private `librarian` OMP RPC profile whose MCP surface contains only deterministic OKF tools|
|Retrieval|Its watcher-backed `start.sh` stdio MCP|
|Codebase Memory|Its compiled, zero-dependency stdio server|
|Camofox|Its built stdio MCP launched by Bun|

Existing OMP MCP entries and config keys are preserved. Their pre-Persephone values are recorded once and restored by `persephone uninstall`. A malformed OMP config is never overwritten. The private Librarian profile receives a managed copy of the active profile's OMP settings/model definitions, but not its sessions, MCP registry, model cache, or credential database. Librarian's Hermes configuration is not changed; the OMP MCP receives explicit environment overrides, so both backends can coexist.

## Signal commands

```text
/status
/new
/steer corrective direction
/follow next task after this turn
/cwd /absolute/project/path
/model provider/model-id
/thinking high
/approve 12
/deny 12
```

Ordinary messages enter the OMP session mapped to that Signal contact or group. Group and direct-message routes are distinct.

## Durable schedules

```bash
persephone schedule add morning "0 8 * * *" "Review the project task sheet"
persephone schedule add report "30 18 * * 1-5" "Summarize today's work" --to signal:+15555550123
persephone schedule list
persephone schedule remove morning
```

Cron is evaluated in the service's local timezone. A minute is recorded before it can run twice, and failures remain visible in SQLite/status output.

## Zed

Use OMP's native ACP server in Zed:

```bash
omp acp
```

`persephone zed /path/to/project` opens the project, but Persephone never inserts another editor bridge between Zed and OMP. Editor writes and permission requests therefore keep OMP's native ACP behavior.

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

- `OTEL_SDK_DISABLED=true` is forced for the daemon and every OMP RPC child.
- No collaboration relay is started.
- The API defaults to loopback. Non-loopback binding requires a bearer token.
- Signal is allowlist-only.
- Approval IDs are bound to the originating conversation and expire.
- OMP's own per-tool approval policy remains authoritative.
- OMP extensions execute as trusted in-process code. Install Persephone only from a reviewed source tree.

See [Architecture](docs/ARCHITECTURE.md), [Capability matrix](docs/CAPABILITY-MATRIX.md), and [Security](docs/SECURITY.md).
