# OMP configuration research for the local workstation

This is a source-grounded operational map of oh-my-pi (OMP), followed by a configuration recommendation for the current local workstation and Persephone deployment. It is intentionally a research and decision document, not a list of speculative Persephone features.

## Research basis

The review used two sources together:

- DeepWiki's interactive Deep Research over `can1357/oh-my-pi`, last indexed at commit `403931b9` on July 27, 2026;
- the installed OMP command surface, model catalog, active configuration, MCP registry, plugin registry, and compiled source on the workstation, re-audited at `18.1.16` for the reconciliation pass.

The live installation is newer than the DeepWiki snapshot, so live read-only inspection was used to validate defaults and exact behavior where it mattered. The primary DeepWiki references are [architecture](https://deepwiki.com/can1357/oh-my-pi/3-architecture), [system prompts](https://deepwiki.com/can1357/oh-my-pi/4.4-system-prompts), [RPC mode](https://deepwiki.com/can1357/oh-my-pi/6.5-rpc-mode), [remote and web tools](https://deepwiki.com/can1357/oh-my-pi/7.5-remote-and-web-tools), [extension system](https://deepwiki.com/can1357/oh-my-pi/11-extension-system), [MCP integration](https://deepwiki.com/can1357/oh-my-pi/12.3-mcp-integration), [async jobs](https://deepwiki.com/can1357/oh-my-pi/12.4-async-jobs-and-background-execution), [autonomous memory](https://deepwiki.com/can1357/oh-my-pi/12.5-autonomous-memory), [autoresearch](https://deepwiki.com/can1357/oh-my-pi/12.6-autoresearch), [roboomp](https://deepwiki.com/can1357/oh-my-pi/12.7-roboomp-github-triage-bot), and the [settings schema](https://deepwiki.com/can1357/oh-my-pi/13.1-settings-schema).

## Executive conclusion

OMP already owns nearly every interactive-agent concern that looked like a possible Persephone feature: precise editing, LSP, planning, steering, tasks, subagents, async work, model roles, skills, rules, MCP, ACP, RPC, compaction, local memory, and extensions. Persephone should continue to own only durable process, transport, scheduling, routing, and local web-backend concerns.

The most valuable changes are configuration, not more middleware:

1. disable every Exa feature in the normal local profile;
2. disable passive startup and marketplace update requests, and leave AutoQA off, for an explicit zero-telemetry posture;
3. correct explicitly declared multimodal model metadata to advertise image input and keep Snapcompact enabled;
4. enable Advisor experimentally with the same local A1 endpoint, read-only tools, and a one-turn synchronization threshold;
5. reduce task concurrency from 32 to a workstation-realistic value such as 4;
6. keep OMP memory disabled while Retrieval remains the semantic/session owner;
7. keep only a tiny set of essential skills visible and let Retrieval search the archive;
8. supply MCP definitions from Zed itself in ACP sessions, because OMP deliberately does not read its normal MCP file in ACP mode.

## Native subsystem inventory

|Subsystem|Default/activation|What it actually provides|Recommendation here|
|---|---|---|---|
|Advisor|Off|A second complete agent watches turn deltas and injects graded advice.|Trial it interactively with the same local A1 model and read-only tools.|
|Tasks and Agent Hub|On|Concurrent subagents, bounded recursion, structured results, optional isolation.|Keep native; reduce concurrency to 4.|
|Async jobs|On|Background shell and agent jobs owned by the running OMP process.|Use for session-lifetime work; Persephone remains the durable owner.|
|Swarm|Separate experimental extension|YAML DAG orchestration through `omp-swarm` or `/swarm`.|Install only for a concrete DAG workflow.|
|Autoresearch|Inactive until `/autoresearch`|Branch-scoped experiment loops with SQLite history and scope checks.|Useful for benchmarkable optimization, not ordinary coding.|
|Skills|On|One-level discovery, metadata in the prompt, lazy bodies through `skill://`.|Keep a small visible core; search the archive with Retrieval.|
|Rules and context files|On|Project instructions and always-apply rules enter the prompt directly.|Keep them short; large reference material belongs in Retrieval.|
|MCP|No servers by default|Stdio, HTTP, and SSE servers with reconnect and live tool refresh.|Use the current local MCP set; keep ownership explicit.|
|External-device tools (`xdev`)|On|Large external schemas are fetched lazily instead of all entering the prompt.|Keep enabled.|
|Memory|Mnemopi for the interactive profile|Local, Hindsight, or Mnemopi backends with optional recall and retention.|Use native project-scoped Mnemopi for OMP decisions; leave it off in gateway/Librarian workers.|
|Compaction|Snapcompact|Several maintenance strategies, including image-based Snapcompact.|Keep Snapcompact after correcting the A1 image capability metadata.|
|ACP|Explicit `omp acp`|Native editor protocol, permissions, sessions, extensions, and client-owned MCPs.|Use in Zed; configure MCPs on the Zed side.|
|RPC|Explicit mode|JSONL prompts, steering, sessions, model control, host tools, and UI requests.|Persephone already uses the correct boundary.|
|Web search|Provider chain|Exa plus many hosted and local providers.|Persephone's local Firecrawl replacement remains authoritative.|
|Browser|Persephone adapter|OMP's browser open/run/close contract backed by local Camofox.|Keep Camofox authoritative; never start Puppeteer.|
|Collaboration|Explicit `/collab` or `omp join`|Encrypted live sharing through a public relay by default.|Leave unused; it is not required by Persephone.|
|Stats|Explicit `omp stats`|Local SQLite session metrics and a localhost dashboard.|Useful and private; safe to use.|
|Garbage collection|Dry-run by default|Blob cleanup, cold session archives, and SQLite WAL checkpoints.|Run manually after reviewing the dry run.|
|Tiny local models|Explicit download/config|Local title, memory, and thinking-classifier work through ONNX.|Optional; useful for removing trivial work from A1.|
|Speech/TTS|Explicit setup/use|Local STT and Kokoro TTS, with optional cloud fallbacks.|Leave unconfigured unless voice is wanted.|
|Auth broker/gateway|Explicit service|Local credential vault and provider proxy for less-trusted workers.|Unnecessary for a single local vLLM endpoint.|
|roboomp|Separate service|GitHub webhook automation with durable state and isolated worktrees.|Reuse when GitHub automation is wanted; do not recreate it.|

## Less-obvious command surfaces

OMP's command line exposes several tools that are easy to miss when treating it only as a TUI:

|Command|Purpose|Operational note|
|---|---|---|
|`omp agents unpack`|Writes bundled scout, designer, reviewer, librarian, task, and sonic definitions as editable files.|Use this to customize native agents instead of rebuilding delegation in Persephone.|
|`omp auth-broker`|Runs or manages the local SQLite credential broker.|Useful for many less-trusted workers; unnecessary for the current local provider.|
|`omp auth-gateway`|Proxies several provider wire formats through the broker without giving clients raw credentials.|Introduces another local service and real provider egress.|
|`omp bench`|Measures TTFT and generation speed against selected models.|Calls the model for real; useful for local A1 tuning, not a correctness test.|
|`omp browser-relay`|Installs/serves a local CDP bridge for controlling a user's Chrome tabs.|Present in live `17.2.7`, absent from the older DeepWiki command table; do not use beside Camofox.|
|`omp cleanse`|Runs weighted, file-disjoint diagnostic fixes through parallel subagents.|Present in live `17.2.7`, absent from the older DeepWiki command table; cap agents at the same local concurrency budget.|
|`omp commit`|Generates commit messages or split plans, using map-reduce for large diffs.|Can make several model calls on a large change.|
|`omp completions`|Emits shell completion scripts.|Local and harmless.|
|`omp config`|Lists, reads, sets, resets, and locates layered settings.|The canonical configuration interface.|
|`omp dry-balance`|Shows OAuth account routing; `--bench` can call every account.|Irrelevant to the single local endpoint.|
|`omp gallery`|Renders built-in tool UI states for developer QA.|Not an operator feature.|
|`omp gc`|Dry-runs or applies blob cleanup, session gzip archival, and WAL checkpoints.|Review the dry run before `--apply`.|
|`omp grep`, `read`, `search`, `shell`|Expose the corresponding agent tools directly from the CLI.|Useful for scripts; `search` inherits provider/egress policy.|
|`omp grievances`|Lists, cleans, or explicitly pushes AutoQA reports.|`push` is an intentional network action.|
|`omp install` / `omp plugin`|Installs, links, upgrades, validates, enables, and disables extensions and marketplaces.|This is the native Persephone and Context Mode lifecycle surface.|
|`omp join`|Joins a collaboration session through the configured relay.|Leave unused for the sovereign local profile.|
|`omp models`|Lists, searches, refreshes, and validates the resolved model catalog.|`refresh` can perform provider discovery/network work.|
|`omp setup python`|Probes for Python 3; it does not install Python.|The workstation's UV-managed interpreter policy remains separate.|
|`omp setup speech`, `say`, `ttsr`|Sets up local speech, performs TTS, and inspects/tests streaming rules.|Optional and unrelated to agent correctness.|
|`omp ssh`|Manages project/user SSH host definitions.|Present in live `17.2.7`; this is OMP's agent SSH registry, not Persephone's transport.|
|`omp stats`|Builds a local session analytics database and dashboard.|Useful for prompt/cache/latency evaluation without cloud telemetry.|
|`omp tiny-models`|Downloads local ONNX helper models.|A good later optimization for titles/classifiers.|
|`omp token` / `omp usage`|Inspects provider credentials and usage state.|May reveal secrets or contact provider endpoints.|
|`omp update`|Updates OMP and keeps native-addon versions aligned.|Run deliberately after disabling the passive startup check.|
|`omp worktree`|Lists and clears agent-managed worktrees.|Use native cleanup rather than deleting worktrees blindly.|

Autoresearch is an in-session mode, Swarm is a separate extension/binary, and roboomp and metaharness are separate services/packages. They are not ordinary top-level `omp` commands.

## Advisor

Advisor is not merely another prompt. It is a second OMP `Agent` with its own model role, session, transcript, append-only context manager, and optional tools. After each primary turn it receives only the new primary transcript delta: reasoning, intended tool calls, tool results, delegated-task results, and edit diffs. Its own previous advice is filtered out, and detected secrets are obfuscated.

It emits one graded message at a time:

- `nit` is a non-interrupting aside;
- `concern` is a stronger steering signal;
- `blocker` is preserved as an explicit interruption.

Advisor configuration can live in ordinary settings and in `WATCHDOG.md`/`WATCHDOG.yml`. The latter can define multiple advisors, models, tool sets, and instructions. `/advisor on`, `/advisor off`, `/advisor status`, `/advisor dump`, and `/advisor configure` manage it interactively.

Important behavior:

- `advisor.syncBacklog` controls whether the primary loop waits for a small advice backlog before continuing;
- `advisor.immuneTurns` prevents repetitive interruptions for a number of turns;
- `task.agentAdvisor` selects advisor behavior per delegated agent (`"on"`, `"off"`, or a model pattern); the generic delegated agent is keyed as `task`;
- the default Advisor tool grant is already read-only; current OMP approval-wraps explicitly granted mutating tools as well, but a passive reviewer should still remain read-only;
- each watched turn is another inference request, even when the Advisor has nothing useful to add.

Recommended first trial:

```yaml
modelRoles:
  advisor: vllm/compute1/Agents-A1-GPTQ-INT4-Sym

advisor:
  enabled: true
  syncBacklog: "1"
  immuneTurns: 3

task:
  agentAdvisor:
    task: "off"
```

Use it first in the TUI and Zed ACP sessions, where its intervention is visible. Do not enable it for every Persephone message immediately: that would double routine gateway inference and add latency to short Signal/Discord/Slack turns. The same local endpoint can serve both roles, and vLLM can batch concurrent requests, but OMP does not deduplicate their prompt work.

Advisor is most valuable for long refactors, architecture-sensitive work, unfamiliar APIs, false-completion detection, and tasks where the agent may drift from a detailed specification. It is mostly overhead for one-file edits, factual questions, and routine commands.

## Exa

Exa is a hosted neural/semantic web-search platform. Its practical differentiator is meaning-based ranking rather than only keyword matching. Current OMP exposes it as a web-search provider behind the single `exa.enabled` switch; the former standalone Researcher and Websets toggles have been removed.

OMP can use an Exa API key through its normal credential path. More importantly for privacy, ordinary Exa search also has a keyless public MCP fallback. A missing API key therefore does not prove that a query remains local. Query text, domain filters, and date filters are sent to Exa whenever that provider is selected.

For this workstation, Exa adds little that justifies another outbound owner. Firecrawl already fronts local SearXNG for search, and Camofox handles interactive pages. OMP `18.1.16` selects native search providers through `providers.webSearchOrder` and `providers.webSearchExclude`, so the local configuration keeps Firecrawl first and removes only Firecrawl from the exclusion list. Other entries retain their operator-selected order and exclusion state. The hosted Exa feature remains disabled:

```yaml
exa:
  enabled: false
```

If Exa is ever desired, put it in a clearly named cloud-research OMP profile rather than the default profile. Authenticate intentionally, enable only search at first, and treat every submitted query as public-cloud egress. Persephone should not proxy or disguise it as local search.

## Prompt budget and skill architecture

OMP's native skill design is already unusually good for a large library:

- only a visible skill's name and description enter the system prompt;
- its body is loaded only when the model reads the corresponding `skill://` resource;
- providers are priority-resolved and duplicate skill names are deduplicated;
- discovery is one directory level, not an uncontrolled recursive scan;
- `includeSkills` can act as an allowlist and `ignoredSkills` as a denylist;
- `hide: true` keeps a skill addressable without advertising it in the prompt;
- `skills.enableSkillCommands` controls whether each visible skill also becomes a slash command.

By contrast, `AGENTS.md`, other selected context files, and always-apply rule bodies enter directly. Those are the places where prompt bloat is most easily created.

The current workstation is healthier than the raw file count suggests. There are roughly 875 `SKILL.md` files under `~/Hermes`, but that tree is not configured as an OMP skill discovery directory. The normal OMP roots expose only the small active core. Consequently, OMP is not currently inserting hundreds of skill descriptions into every prompt.

The recommended two-tier design is:

```text
OMP-visible core
├── local MCP/runtime operation
├── Retrieval lookup instructions
├── project-critical build/release behavior
└── genuinely frequent cross-project methods

Retrieval archive
├── highly specific framework skills
├── cybersecurity reference collections
├── historical or generated skills
├── bulky examples and playbooks
└── inactive variants
```

Retrieval should semantically search archived skill bodies and return the smallest useful result: skill name, why it matched, canonical source/path, and either the required section or a resource that OMP can read. One concise visible lookup skill can teach the agent that route. OMP then retains native lazy skill loading for the core while Retrieval supplies the semantic index OMP does not natively provide.

Do not point `skills.customDirectories` at all of `~/Hermes`. Do not duplicate every archive item into `~/.agents/skills`, `~/.codex/skills`, and an OMP-managed directory. If the visible core ever becomes large, disable `skills.enableSkillCommands` to avoid hundreds of redundant slash commands; this does not disable skill discovery.

## Memory ownership

OMP's optional Mnemopi backend is a real memory system, not a placeholder. It maintains SQLite-backed working, episodic, fact, and embedding data; supports local or remote embeddings; and can automatically recall before turns and retain after turns. Hindsight and simpler local modes are also available.

That strength is why it is restricted rather than duplicated here. Retrieval, Librarian, Codebase Memory, and Context Mode retain distinct owners:

- Retrieval owns archived skills and semantic/session material;
- Librarian owns delegated search and synthesis;
- Codebase Memory owns code graph and wiki knowledge;
- Context Mode owns intentionally indexed bulk working material;
- native OMP sessions own their chronological coding transcript.

Mnemopi owns only OMP-specific cross-session decisions. It uses a separate project-scoped SQLite database, local embeddings, a 2,000-token injection ceiling, and the local `smol` model role for structured extraction every four user turns. Retrieval does not mirror this database or automatically inject the same material. Headless Persephone and Librarian profiles keep `memory.backend: off`.

## MCP, RPC, ACP, and Librarian

### TUI and RPC

Normal TUI and RPC sessions discover the configured local MCP servers and keep their managers alive with reconnect and tool-refresh behavior. External schemas remain economical when `tools.xdev: true`: OMP advertises a compact external-device summary and fetches complete schemas only when needed.

The current Retrieval, Librarian, Codebase Memory, Camofox, and Context Mode ownership remains sound. Librarian's isolated OMP profile is especially useful because it keeps delegated RPC work from inheriting the entire public MCP surface.

OMP's RPC setting resolution also removes the need for another Persephone overlay. Explicit values in global, project, named-profile, `--config`, or runtime override layers beat RPC host defaults. The setting resolver is layer-blind; it cares whether a path is explicitly configured, not which file supplied it.

### Zed ACP

OMP deliberately creates every ACP session with native MCP discovery disabled. This is a hard invariant, not an accidental omission. ACP assigns MCP ownership to the client so host-discovered and client-supplied tools cannot shadow one another.

Zed must therefore pass its desired MCP servers in ACP `session/new`/`session/load`. OMP accepts client-supplied stdio, HTTP, and SSE definitions, connects them, and refreshes tools when late servers become ready. If the ACP client supplies none, OMP clears the ACP session's MCP manager; it does not fall back to `~/.omp/agent/mcp.json`.

Extensions, hooks, skills, and plugin tools are independent of this switch. Persephone and the Context Mode plugin still load under ACP. Only ordinary MCP definitions have to come from Zed.

This produces one genuine follow-up seam: Persephone may eventually export its canonical MCP definitions in a Zed-consumable form and verify that the installed Zed ACP client passes them. It should not patch OMP core or re-enable duplicate MCP discovery.

## Local model and context behavior

The vLLM discovery response originally described `vllm/compute1/Agents-A1-GPTQ-INT4-Sym` as:

- context window: 172,032 tokens;
- text input only;
- no separate reasoning/thinking channel.

The first item was incomplete discovery metadata, not a checkpoint limitation. A1 is multimodal. OMP uses the catalog's `input` field to decide whether to pass image blocks natively, so the narrow persistent correction is:

```yaml
providers:
  vllm:
    modelOverrides:
      compute1/Agents-A1-GPTQ-INT4-Sym:
        input:
          - text
          - image
```

This belongs in the profile's `models.yml`. It retains dynamic vLLM discovery while overriding only the incorrect capability. The resolved catalog then reports `input: ["text", "image"]`, allowing native image blocks and Snapcompact. The active workstation selector is now `vllm/qwen3.8-27b`; `omp.imageModels` in Persephone names the exact selectors (or `@role` aliases) that receive this narrow correction. Keep `compaction.methodOrder: [snapcompact, soft]`.

OMP drops image content before transport when the resolved model metadata lacks `image`, even when the vLLM endpoint itself accepts OpenAI-compatible base64 image parts. This is why the correction belongs at the OMP catalog boundary. `images.autoResize: true` and `images.blockImages: false` retain OMP's native direct-image path; Persephone does not introduce another encoder.

`provider.appendOnlyContext: auto` should remain `auto` until prefix caching is confirmed on the vLLM endpoint. If vLLM prefix caching is deliberately enabled and measured, forcing append-only context can improve cache reuse. It should not be changed merely because the context window is large.

`tools.format: auto` is also the correct first choice. OMP will prefer provider-native tool calls and can fall back to an owned dialect when the model catalog says native tools are unsupported. Change it only in response to a reproducible parsing failure.

`features.unexpectedStopDetection: smart` is a reasonable local-model hardening option. It includes the mechanical empty-stop retry and uses the configured small model to classify text-only stops. It is not a substitute for tests or Advisor review.

## Task and long-horizon settings

The live default `task.maxConcurrency: 32` is excessive for one 32 GB RTX 5090 serving a large local model. It permits OMP to create a request storm even if the server eventually queues or batches those requests. Start with:

```yaml
task:
  maxConcurrency: 4
  maxRecursionDepth: 2
  isolation:
    mode: auto
```

Use `isolation.mode: auto` when delegated workers may edit concurrently; OMP can select a supported CoW, overlay, ProjFS, worktree, or copy fallback. `none` remains appropriate for read-only scouts or when every worker must intentionally share one worktree.

`prewalk` is not useful while the strong and cheap roles resolve to the same A1 model. It becomes valuable only after assigning a materially faster local `smol` role: the strong model plans and begins the implementation, then hands the remaining todos to the cheaper model.

Native async jobs remain process-lifetime mechanisms. Persephone should continue to own schedules and external-message delivery that must survive process exit or reboot.

## Privacy and egress hardening

Three defaults deserve explicit treatment:

```yaml
startup:
  checkUpdate: false

dev:
  autoqa: false

providers:
  fetch: native
```

- `startup.checkUpdate: true` performs a passive npm-registry version request on launch. Disable it and run `omp update` deliberately.
- AutoQA is consent-gated and does not silently push reports in a headless process, but `dev.autoqa: false` removes the surface entirely.
- `providers.fetch: auto` tries local native extraction first but can fall through to local Trafilatura/Lynx and then hosted Parallel/Jina readers. `native` keeps URL retrieval direct. Use Camofox or local Firecrawl when the native reader cannot render a dynamic page.

Leave `/collab` unused, or point its relay URL at an operator-owned service if collaboration is later required. The default relay sees encrypted payloads rather than plaintext, but it is still an external dependency.

`omp stats` is local-only and safe to use. `omp usage` and provider login/token commands can contact provider endpoints or reveal credentials; use them only when intentional. `omp token --raw` prints a secret to stdout.

## Current configuration proposal

This is the normal workstation profile applied on August 3, 2026.

```yaml
modelRoles:
  default: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  smol: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  slow: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  vision: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  plan: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  designer: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  commit: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  tiny: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  advisor: vllm/compute1/Agents-A1-GPTQ-INT4-Sym
  task: vllm/compute1/Agents-A1-GPTQ-INT4-Sym

advisor:
  enabled: true
  subagents: false
  syncBacklog: "1"
  immuneTurns: 3

compaction:
  strategy: snapcompact
  remoteEnabled: false
  remoteStreamingV2Enabled: false

memory:
  backend: mnemopi

task:
  maxConcurrency: 4
  maxRecursionDepth: 2
  isolation:
    mode: auto

exa:
  enabled: false
  enableSearch: false
  enableResearcher: false
  enableWebsets: false

retry:
  modelFallback: false

startup:
  checkUpdate: false

dev:
  autoqa: false

providers:
  fetch: native

tools:
  xdev: true
  format: auto

features:
  unexpectedStopDetection: smart
```

Keep the current project/profile settings, local model catalog, and MCP registry intact around this patch. Do not replace Localflame's MCP with another Firecrawl process, and do not enable OMP's built-in Chromium browser while Camofox is configured.

The durable post-update path is now:

```bash
persephone reconcile
persephone doctor
```

The first command reads every owned value before writing. It repairs Firecrawl-first native search only on profiles that activate Localflame, disables OMP's Puppeteer browser only on profiles that activate Camofox, and patches only models listed in `omp.imageModels`. The second command checks those values plus the effective RPC tools and MCP handshakes without sending a model prompt or web request. OMP plugin links are also profile-scoped, so full `persephone integrate` links the Camofox adapter into each discovered owned profile.

### Native command sequence

OMP's config CLI treats `modelRoles` as one record, so set that value atomically. Every other recommendation is an ordinary native setting:

```bash
omp config set modelRoles '{"default":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","smol":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","slow":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","vision":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","plan":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","designer":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","commit":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","tiny":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","task":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym","advisor":"vllm/compute1/Agents-A1-GPTQ-INT4-Sym"}'

omp config set advisor.enabled true
omp config set advisor.syncBacklog 1
omp config set advisor.immuneTurns 3
omp config set task.agentAdvisor '{"task":"off"}'

omp config set compaction.methodOrder '["snapcompact","soft"]'
omp config set compaction.remoteStreamingV2Enabled false
omp config set images.describeForTextModels true
omp config set memory.backend mnemopi
omp config set mnemopi.scoping per-project
omp config set mnemopi.llmMode smol
omp config set mnemopi.injectionTokenLimit 2000
omp config set mnemopi.recallLimit 6
omp config set mnemopi.enhancedRecall true

omp config set task.maxConcurrency 4
omp config set task.maxRecursionDepth 2
omp config set task.isolation.mode auto
omp config set task.batch true
omp config set prewalk.enabled false

omp config set exa.enabled false
omp config set retry.modelFallback false

omp config set startup.checkUpdate false
omp config set marketplace.autoUpdate off
omp config set dev.autoqa false
omp config set providers.fetch native
omp config set provider.appendOnlyContext auto
omp config set tools.xdev true
omp config set tools.format auto
omp config set features.unexpectedStopDetection smart
omp config set skills.enableSkillCommands true
```

The multimodal `models.yml` override is separate because model capability overrides belong to OMP's model registry rather than `config.yml`. After writing it, verify the resolved result with:

```bash
omp models vllm --json
```

The selected model must report `"input":["text","image"]`. `/advisor status` should then report Advisor enabled on the same selector. Persephone's native integration is applied and checked with:

```bash
persephone integrate
persephone restart
persephone doctor
```

## Prioritized next actions

### Configuration only

1. Apply the zero-egress defaults, corrected multimodal model metadata, explicit Snapcompact strategy, and task concurrency limit.
2. Enable Advisor for interactive sessions and give it a small, read-only `WATCHDOG.yml` policy.
3. Observe one substantial Zed or TUI task before enabling Advisor on Persephone routes.
4. Keep Mnemopi project-scoped and keep the current small visible skill set; Retrieval remains the separate archive.

### Existing integrations to tighten

1. Keep the Context Mode lifecycle plugin and bundled MCP together; Persephone delegates installation to Context Mode's checked-in integration contract and verifies the resulting plugin and MCP registrations.
2. Confirm or configure Zed's ACP MCP payload, then document exactly how Retrieval, Librarian, Codebase Memory, and Camofox are passed.
3. Ensure the Retrieval MCP exposes one compact, stable skill-search contract suitable for a visible core lookup skill.
4. Keep the Librarian private profile isolated and deterministic.

### Genuine Persephone candidates

1. A read-only `persephone config recommend` or doctor section that reports relevant OMP defaults without rewriting them.
2. A canonical MCP export for ACP clients such as Zed.
3. Optional Advisor policy guidance for interactive versus transport routes.

### Do not add

- another memory database;
- a second web-search owner;
- a Chromium/Puppeteer process beside Camofox;
- an OMP core patch to bypass ACP MCP isolation;
- a wrapper around native tasks, Agent Hub, swarm, autoresearch, stats, or roboomp;
- recursive exposure of the entire `~/Hermes` skill archive;
- a cloud Exa fallback hidden behind a local-search label.

## Final assessment

OMP is complex because it contains several unusually mature systems, not because every system belongs in every installation. The correct configuration here is restrained: local A1 for the main and Advisor roles, Firecrawl for search, Camofox for browsing, Retrieval for semantic archives, Librarian for delegated synthesis, Codebase Memory for project knowledge, Context Mode for bulk working context, OMP native sessions for chronological work, and Persephone for durable routing and scheduling.

That division preserves OMP's innovations while avoiding the exact failure mode that made the Hermes environment feel bloated: several subsystems independently claiming the same memory, browser, search, skill, or process-lifecycle responsibility.
