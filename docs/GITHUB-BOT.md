# Native GitHub agent

Persephone uses OMP's native `python/robomp` implementation. It does not
translate GitHub into a chat transport and does not own a second agent pool.

The checked-in integration builds the exact OMP release declared in
`integrations/robomp/.env`, installs its published OMP CLI, and retains the
native architecture:

```text
signed GitHub webhook or manual triage
                  │
        durable RoboOMP SQLite queue
                  │
     one worktree + OMP session per issue
                  │
       unprivileged Linux worker slot
                  │
       narrow audited GitHub host tools
                  │ HMAC
       separate credential proxy ─── GitHub
```

The orchestrator never receives the GitHub token. The OMP child receives
neither the token nor the webhook, replay, or proxy secrets. GitHub mutations
go through the HMAC-authenticated proxy, whose API is narrower than a shell
with `gh` credentials.

## GitHub identity

Use a dedicated GitHub user account for Persephone. Its account avatar and
display name are the identity users see on issues, comments, commits, and pull
requests. A fine-grained personal access token is the practical native
credential because RoboOMP expects a stable `GITHUB_TOKEN`; a short-lived
GitHub App installation token requires an external refresh service.

On each selected repository grant only:

- Metadata: read-only (automatic);
- Contents: read and write;
- Issues: read and write;
- Pull requests: read and write.

Add Workflows read/write only for repositories where Persephone is explicitly
allowed to modify `.github/workflows`. Do not grant organization, package,
administration, or account-wide access for the normal workflow. Add the bot as
a repository collaborator with the same narrow repository scope.

The human operator configures a repository webhook. Select JSON content and
these events:

- Issues;
- Issue comments;
- Pull requests;
- Pull request reviews;
- Pull request review comments.

The payload URL is `<public RoboOMP URL>/webhook/github`, and its secret is the
generated `GITHUB_WEBHOOK_SECRET`. A public webhook URL requires an
operator-owned HTTPS reverse proxy or tunnel; the dashboard remains bound to
loopback by default. Manual `triage` and scheduled audits do not require public
webhook ingress, but follow-up GitHub comments cannot resume automatically
without it.

## Configure and start

```bash
cd ~/Hermes/persephone
persephone git-agent init
persephone git-agent config
```

Edit the printed owner-only `.env` file. The minimum operator-owned values are:

```dotenv
GITHUB_TOKEN=<fine-grained token for the Persephone account>
ROBOMP_BOT_LOGIN=<exact GitHub login>
ROBOMP_GIT_AUTHOR_EMAIL=<bot account commit email>
ROBOMP_REPO_ALLOWLIST=CommanderTurtle/repository-one,CommanderTurtle/repository-two
ROBOMP_MAINTAINER_LOGINS=CommanderTurtle
ROBOMP_RATE_LIMIT_UNLIMITED=CommanderTurtle
ROBOMP_MODEL=<OMP model alias from models.container.yml>
```

`persephone git-agent init` generates the webhook, replay, and HMAC secrets and
never replaces an existing configuration. The source pair is pinned: the build
fails when `OMP_COMMIT` does not contain the declared `OMP_VERSION`.

The default submitter limits are zero. Repository owners, members,
collaborators, configured maintainers, and explicitly unlimited logins retain
native authorization; arbitrary public issue authors cannot spend model time.

```bash
persephone git-agent doctor
persephone git-agent build
persephone git-agent up
persephone git-agent status
persephone git-agent logs robomp
```

RoboOMP listens at `http://127.0.0.1:6543` by default. Set this in Persephone's
normal configuration to include native health in `persephone doctor`:

```json
{
  "roboomp": {
    "enabled": true,
    "url": "http://127.0.0.1:6543"
  }
}
```

The container model file is the existing
`~/.omp/agent/models.container.yml`; on this workstation it points at the host
vLLM endpoint through `llm-gateway.internal`. The container does not copy OMP
credentials, sessions, or the host's normal agent database.

## Native workflows

### Existing issue

```bash
persephone git-agent triage CommanderTurtle/repository#123
```

This calls RoboOMP's native manual-triage command. Bugs and documentation
issues may progress to an implementation and pull request. Enhancements and
proposals stop after analysis until a repository owner or configured
maintainer posts an implementation directive. Follow-up comments and PR
reviews resume the same persistent OMP session.

### Proposal-only audit loop

```bash
persephone git-agent dream CommanderTurtle/repository
persephone git-agent dream CommanderTurtle/repository "dependency update and integration contracts"
```

The first step runs a narrow helper inside the credential proxy. It creates at
most one open `[Persephone audit]` issue for the configured bot identity. The
wrapper then hands that issue number to native RoboOMP manual triage. RoboOMP
comments one evidence-backed proposal and stops; the issue text explicitly
withholds implementation authority. A trusted maintainer can continue the
same session with:

```text
@Persephone implement
```

Scheduled audits use a normal systemd user timer and the same command:

```bash
persephone git-agent dream-timer-enable CommanderTurtle/repository \
  'Sun *-*-* 05:00:00'

persephone git-agent dream-timer-disable CommanderTurtle/repository
```

The timer is persistent across downtime and adds a small randomized delay. It
does not create another issue while a previous Persephone audit remains open,
and it never changes the approval rule.

### Fork reconciliation

Open a narrowly written issue on the fork that names the upstream URL and base
branch, then trigger it manually. The staged `AGENTS.md` requires the agent to
fetch upstream under a temporary remote, preserve `origin`, explain conflicts,
resolve them semantically in the isolated issue branch, and open a PR against
the fork. It may not merge, force-push, or modify the production checkout.

## Review with Orca

RoboOMP owns its isolated worktree. Orca owns the human review surface against
an ordinary host clone:

```bash
persephone git-agent review ~/Hermes/Diogenes 123
```

The command fetches the GitHub pull-request head into the namespaced
`persephone/pr-123` remote-tracking ref without checking it out, then registers
and opens the host clone in stock `orca-ide`. It never opens or mutates
RoboOMP's private worktree or the host working tree. Inspect the printed
`origin/<default>...persephone/pr-123` range in Orca, then approve or reject on
GitHub. GitCito is accepted as a stock fallback viewer when Orca is unavailable,
but it has no current
JSON-RPC, ACP, or plugin boundary and is not patched into the agent runtime.

## Lifecycle

```bash
persephone git-agent restart
persephone git-agent down
persephone git-agent cleanup CommanderTurtle/repository#123
```

`down` preserves the Docker volume containing SQLite state, sessions, clones,
and worktrees. `cleanup` is native RoboOMP cleanup for one issue. No command in
this integration merges a pull request or writes to a production checkout.

## OpenShell decision

OpenShell was evaluated as an additional policy sandbox. It can run custom
images, default-deny network egress, and route local OpenAI-compatible inference
through `inference.local`. It also forbids a root agent process. Native RoboOMP
uses root only at the orchestrator boundary to assign each issue to a distinct
unprivileged Linux UID and reap that UID's stray processes. Running the whole
service as an OpenShell child would silently disable that per-slot boundary.

The native container-plus-slot-plus-credential-proxy design is therefore the
supported baseline. A future OpenShell mode should sandbox one OMP worker leaf
per issue; it must not wrap the whole orchestrator by trading away native slot
isolation.
