# Security model

Persephone assumes one trusted local owner and treats every transported message, retrieved document, page, tool result, and model output as untrusted data.

## Enforced boundaries

1. Signal, Discord, and Slack are disabled by default.
2. Each enabled transport fails startup unless an allowlist is nonempty or its explicit `allowAll` switch is set.
3. Direct messages and groups have separate route keys.
4. Remote approval IDs are bound to the originating route and expire.
5. A restart expires in-flight approvals rather than recovering them permissively.
6. The control API binds to loopback by default.
7. A non-loopback bind is rejected without a bearer token.
8. OMP RPC confirmation requests fail closed when the originating transport is unavailable.
9. OMP's native tool policies still run before execution.
10. SQLite/config/state directories use owner-only modes where the platform permits.
11. OpenTelemetry is disabled in both the daemon and RPC children.
12. Self-hosted Firecrawl always fails closed; a local outage cannot disclose a query to a hosted provider.
13. Firecrawl and Camofox API keys are read only from the owner-only Persephone environment file and are not written to logs.
14. Passive OMP and marketplace update checks are disabled in every managed profile; update traffic occurs only after an explicit operator command.
15. RoboOMP GitHub intake is repository-and-actor allowlisted before native event routing.
16. Native RoboOMP push and PR operations are bound to the exact recorded repository, workspace, branch, base, head, and diff; worktree drift invalidates approval. Manual approval is required except for the exact issue workspace created and dispatched by an explicitly enabled automatic dream policy.
17. Dream analysis receives only read/grep/glob and Persephone's local Firecrawl/Camofox tools, no session, Bash, writes, skills, or LSP, and a child environment scrubbed of GitHub/approval secrets. Its one explicit extension is the reviewed source that provides those local research tools.
18. Dream issues pass through an issue-only capability process. Ensemble identities pass through independent comment-only capability processes, and implementation dispatch waits for every configured identity to finish.
19. Manual mode keeps issue publication, RoboOMP dispatch, and exact-diff approval distinct. Automatic mode advances only its own dream issue. No component merges a pull request.

A Signal group or shared Discord/Slack channel is one shared route. Any permitted member of that route can respond to its pending approval prompt; use an allowlisted direct message for owner-only approval control. Slack threads are isolated from their parent channel, and Discord thread channels have their own route.

## Trusted-code boundary

OMP extensions are in-process code with the user's permissions. Persephone therefore must be treated like OMP itself, not like a sandboxed MCP. `omp plugin link` is invoked only on the current reviewed repository and the known local Context Mode repository.

MCP servers remain separate child processes. Persephone writes only named entries into OMP's existing MCP JSON and refuses malformed source configuration.

The Persephone and Librarian worker profiles copy operational OMP settings and model-definition files so the local default model remains usable, and their child environments opt local unauthenticated vLLM discovery in with OMP's documented non-secret sentinel. They do not copy `agent.db` credentials, sessions, or `models.db` caches. Advisor and autonomous memory are disabled in these profiles; the eight-sequence budget reserves one worker for each while leaving four interactive task slots. No cloud credential is required or configured.

Integration explicitly disables OMP remote compaction, hosted Exa features, automatic model fallback, startup update checks, marketplace auto-update, and AutoQA. All built-in model roles resolve to the configured local default unless the operator explicitly supplied another role. The default profile's Mnemopi extraction uses that local role; worker profiles have memory disabled.

## Tool authorization

Remote message authorization is not tool authorization. Set OMP's `tools.approvalMode` and per-tool `tools.approval.*` values for each profile. Use explicit `deny` for capabilities a remote route must never acquire. Persephone cannot turn an OMP `deny` into an allow.

## Network posture

Persephone itself makes network calls only to:

- the configured local Signal HTTP endpoint;
- Discord's Gateway and REST API, only when Discord is enabled;
- Slack's Socket Mode and Web API, only when Slack is enabled;
- the configured local control endpoint when its OMP extension queries status;
- the configured Firecrawl search endpoint;
- the configured Camofox browser endpoint;
- the configured local roboomp health endpoint, only when its integration is enabled;
- native RoboOMP and gh-proxy addresses inside the private Compose network when the GitHub bridge is enabled;
- GitHub's API only from native gh-proxy and the explicitly enabled issue-only/comment-only identity sidecars;
- whatever model/MCP endpoints OMP itself is configured to use.

The default Firecrawl and Camofox addresses are loopback. Operators may choose another trusted LAN URL, but should enable each service's authentication and populate its corresponding environment key before doing so. Firecrawl has no hosted fallback, Exa is disabled in every managed profile, and automatic OMP/marketplace update checks are off.

OMP retains explicit operator-facing cloud commands as part of its native installation (for example `/share`, Smithery, and provider login), and Context Mode retains its optional Insight launcher. Persephone neither removes nor calls them. Its always-on rule forbids agents from invoking those surfaces in this local-only configuration; using one requires deliberate operator reconfiguration.

Discord and Slack necessarily send their enabled channel traffic to those platforms. They are opt-in and do not create a third-party relay beyond the platform the operator selected. It does not start OMP Collab, another remote relay, analytics, or a general credential broker. The main GitHub credential remains inside RoboOMP's `gh-proxy`; ensemble GitHub App private keys and their automatically renewed installation tokens live only in their respective comment-only sidecars, and the separately revocable approved-dream token lives only in an issue-only sidecar. OMP children receive none of them.
