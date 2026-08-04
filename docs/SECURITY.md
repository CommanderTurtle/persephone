# Security model

Persephone assumes one trusted local owner and treats every transported message, retrieved document, page, tool result, and model output as untrusted data.

## Enforced boundaries

1. Signal is disabled by default.
2. Signal startup fails unless a sender or group allowlist is nonempty.
3. Direct messages and groups have separate route keys.
4. Remote approval IDs are bound to the originating route and expire.
5. A restart expires in-flight approvals rather than recovering them permissively.
6. The control API binds to loopback by default.
7. A non-loopback bind is rejected without a bearer token.
8. OMP RPC confirmation requests fail closed when Signal is unavailable.
9. OMP's native tool policies still run before execution.
10. SQLite/config/state directories use owner-only modes where the platform permits.
11. OpenTelemetry is disabled in both the daemon and RPC children.
12. Self-hosted Firecrawl fails closed by default; a local outage does not silently disclose a query to a hosted provider.
13. Firecrawl and Camofox API keys are read only from the owner-only Persephone environment file and are not written to logs.

A Signal group is one shared route. Any member of an allowlisted group can respond to that route's pending approval prompt; use a direct-message allowlist for owner-only approval control.

## Trusted-code boundary

OMP extensions are in-process code with the user's permissions. Persephone therefore must be treated like OMP itself, not like a sandboxed MCP. `omp plugin link` is invoked only on the current reviewed repository and the known local Context Mode repository.

MCP servers remain separate child processes. Persephone writes only named entries into OMP's existing MCP JSON and refuses malformed source configuration.

The Librarian worker profile copies operational OMP settings and model-definition files so a local default model remains usable, and its child environment opts local unauthenticated vLLM discovery in with OMP's documented non-secret sentinel. It does not copy `agent.db` credentials, sessions, or `models.db` caches. Cloud credentials must be provided through OMP's normal environment or auth-broker path if that profile needs them.

## Tool authorization

Remote message authorization is not tool authorization. Set OMP's `tools.approvalMode` and per-tool `tools.approval.*` values for each profile. Use explicit `deny` for capabilities a remote route must never acquire. Persephone cannot turn an OMP `deny` into an allow.

## Network posture

Persephone itself makes network calls only to:

- the configured local Signal HTTP endpoint;
- the configured local control endpoint when its OMP extension queries status;
- the configured Firecrawl search endpoint;
- the configured Camofox health endpoint;
- whatever model/MCP endpoints OMP itself is configured to use.

The default Firecrawl and Camofox addresses are loopback. Operators may choose another trusted LAN URL, but should enable each service's authentication and populate its corresponding environment key before doing so. `web.firecrawl.nativeFallback` is deliberately false in the shipped configuration.

It does not start OMP Collab, a remote relay, analytics, or a credential broker.
