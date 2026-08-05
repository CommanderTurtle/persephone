# Gateway audit

This audit compares behavior, not feature-count or popularity. The four systems
solve overlapping but different problems, so copying one wholesale would make
Persephone less coherent.

## Responsibility map

| System | What it does best | What Persephone should learn from it |
|---|---|---|
| [Hermes Gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-internals.md) | Long-lived messaging sessions, per-session concurrency guards, busy-message queues, urgent stop/approval routing, and channel lifecycle | Serialize normal work per conversation while allowing controls that can unblock or redirect a live turn to bypass the queue |
| [Pi Gateway](https://github.com/gamalan/pi-gateway) | Broad channel support, streaming edits, pairing, rate limits, per-chat reset policies, and background tasks | Keep explicit authorization and bounded queues; add platforms only when they are actually required |
| [Orca](https://github.com/stablyai/orca) | Human worktree UX, terminal/editor continuity, remote-host reconnection, source-control review, and host-authoritative session recovery | Keep worktree ownership and reconnect semantics in the coding-orchestration layer, not in a messaging adapter |
| [oh-my-pi RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) | Native persistent agent sessions, steering, follow-ups, event streams, and protocol negotiation | Remain a thin durable control plane around the native RPC session rather than reimplementing an agent runtime |

Orca is therefore complementary. It is not a stronger replacement for the
Signal/Discord/Slack control plane: its worktrees, editor, browser, terminals,
and reconnecting remote UI serve an operator. Persephone serves durable inbound
routes. Leetcoder, rather than Persephone, is where Orca's one-task/one-worktree
pattern belongs.

## Source-level findings

### 1. Same-route lifecycle operations could race

The inbox previously claimed several rows globally and started each row as an
independent promise. `OmpRpcWorker.runPrompt()` serialized prompt calls, but
commands such as `/new` and `/cwd` ran outside that queue and could drop a worker
while an earlier record still owned it.

Persephone now keeps a FIFO tail per `channel:peer`. Ordinary messages and
state-changing commands run in arrival order for that route, while unrelated
routes still use the configured worker pool concurrently. The in-memory route
chain is capped at 32 in-flight/queued messages so a stuck turn cannot create an
unbounded promise chain. Commands needed to
unblock or observe a live turn bypass the FIFO:

- `/approve` and `/deny` avoid an approval deadlock;
- `/steer` and `/follow` reach the active native OMP session;
- `/stop` invokes OMP's native abort while preserving its session and route;
- `/status` and `/help` remain available during a long turn.

This is the small invariant behind Hermes Gateway's more extensive busy-session
machinery. Persephone does not copy Hermes' platform-specific presentation or
media queue because it does not need those layers.

### 2. HTTP availability was mistaken for gateway health

Every core loop was started once. If a transport iterator, inbox consumer,
outbox sender, scheduler, or reaper threw, the error was logged and the loop
ended permanently. `/health` still returned `ok: true`.

Each loop is now supervised independently. Unexpected exit records the failure,
uses bounded exponential restart backoff, and stays visible in health output.
`ok` is true only while every configured loop is running. Health also exposes
restart counts, the last error, per-route queue depth, and core SQLite queue
counts. When an API bearer token is configured it protects `/health` as well as
the rest of the control API.

### 3. Existing strengths should remain native

Persephone already has the right local-first foundations:

- SQLite inbox/outbox deduplication and crash recovery;
- one persistent OMP RPC session per conversation route;
- OMP protocol-v2 chunk negotiation and native steer/follow-up calls;
- route-bound, expiring approval responses;
- fail-closed transport allowlists;
- systemd ownership and local-only Firecrawl/Camofox integration;
- no hosted relay, hosted search fallback, or duplicated GitHub orchestrator.

Pi Gateway's extra platforms, token streaming, and pairing UI are useful for a
public multi-user bridge, but they are not automatic improvements for this
private owner-operated workstation. Hermes' full channel command set is also
larger than Persephone needs. New surface should be added only for a concrete
route, not to make the gateway resemble a catalog.

## Remaining boundaries

- Adapter reconnect quality remains transport-specific. The supervisor restarts
  an adapter that exits, but it does not pretend to implement Discord resume or
  Slack/Signal protocol state above their adapters.
- A worktree is a Git isolation boundary, not a kernel sandbox. OMP's native
  subagent isolation applies to native task workers; root RPC workers remain
  constrained by their working directory, prompt contract, and tool policy.
- The outbox has bounded attempts but not delayed retry scheduling. That is
  adequate for the trusted local configuration; a high-volume public bridge
  would need persisted `next_attempt_at` backoff and platform rate-limit hints.
- Attachments and streaming message edits are deliberately absent. They should
  be designed per enabled platform if a real use case requires them.
