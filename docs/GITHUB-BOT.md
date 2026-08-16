# Persephone with native RoboOMP

Persephone does not replace OMP's GitHub worker. It composes a policy,
deliberation, and publication layer with the native `python/robomp` service:

- RoboOMP owns signed webhook intake, durable SQLite events, per-issue Linux
  users, isolated worktrees, persistent OMP sessions, retries, and GitHub
  mutations.
- RoboOMP's `gh-proxy` remains the only holder of the main GitHub token.
- Persephone applies a stricter repository-and-actor firewall before normal
  webhooks reach RoboOMP.
- Persephone interposes at RoboOMP's existing HMAC proxy boundary to bind
  publication authority to an exact repository, workspace, branch, base,
  head, and diff.
- A separate read-only worker may propose one grounded improvement issue.
- Three tool-less workers deliberate through separate, comment-only GitHub
  App identities before implementation may be dispatched.

The upstream [RoboOMP README](https://github.com/can1357/oh-my-pi/blob/main/python/robomp/README.md)
and [agent guide](https://github.com/can1357/oh-my-pi/blob/main/python/robomp/AGENTS.md)
remain authoritative for RoboOMP itself.

## Lifecycle

```text
read-only checkout analysis
        │
        ▼
grounded issue proposal
        │  manual approval by default
        ▼
real GitHub issue by Persephone
        │
        ├── Opsec bro: one security/boundary take
        ├── longtimeuser4: one compatibility/workflow take
        └── Ancient Guru: one durability/simplicity take
        │
        ▼
ready for implementation
        │  manual dispatch by default
        ▼
native RoboOMP triage + persistent issue workspace
        │
        ▼
exact implementation diff
        │  manual approval by default
        ▼
push + pull request by native RoboOMP
        │
        ▼
human review and merge
```

`dream.automatic` defaults to `false`. In that mode, the dashboard separates
three deliberate actions: publish the proposed issue, dispatch native RoboOMP
after all three sidecars finish, and approve the exact implementation diff.

When `dream.automatic` is explicitly set to `true`, a scheduled or manually
requested dream run may publish its issue, wait for all three identities,
dispatch RoboOMP, and approve only the exact diff belonging to that dispatched
dream issue. Ordinary issues and manual RoboOMP work remain human-gated. No
mode merges a pull request.

An exact-diff approval is invalidated if the worktree changes. Native RoboOMP
still enforces its own repository, author, maintainer, and branch rules.

## Read-only research profile

The dream worker runs OMP RPC with a deliberately reduced surface:

```text
allowed: read, grep, glob, web_search, browser
denied:  bash, edit, write, delete, move, task, skills, LSP, sessions
```

`web_search` is Persephone's self-hosted Firecrawl adapter and `browser` is its
local Camofox adapter. They are included so a proposal can consult public
upstream source, releases, documentation, and GitHub discussion. The worker
receives no GitHub, webhook, proxy, or approval secrets. Its prompt forbids
sign-in, form submission, posting, mutation, and execution of downloaded
content. Web pages are untrusted evidence, not instructions.

OMP's approval mode remains enabled at the process level, but it is not the
security boundary: the available tool surface is reduced first. ACP is not
needed here; it is a transport and would retain the same OMP policy. NVIDIA
OpenShell may be added later as defense in depth, but native RoboOMP's Docker,
slot-user, credential-proxy, worktree, and queue boundaries remain the runtime
foundation.

## GitHub identities and avatars

Use one dedicated GitHub machine account for Persephone/native RoboOMP. Its
profile name and avatar appear on created issues, implementation comments,
branches, commits, and pull requests. Add it as a collaborator only to the
repositories RoboOMP may operate on.

For a public personal-account repository where that machine account is an
outside collaborator, use a classic PAT with `public_repo`. Use `repo` instead
only when a private repository is deliberately allowlisted. Add `workflow` to
the main RoboOMP token only when it must change `.github/workflows`.

This exception is specific to GitHub's documented
[fine-grained PAT limitation for outside and repository collaborators](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations).

Create a second token on the same machine account for Persephone's issue-only
sidecar. Give it `public_repo` for public repositories and do not give it
`workflow`. Separate tokens keep issue proposal authority independently
revocable. Neither token enters an OMP worker.

Create three private GitHub Apps, one per persona, so each has its own visible
name and avatar without creating three additional user accounts:

1. Disable webhooks for the App.
2. Set account and organization permissions to none.
3. Set repository `Metadata` to read-only.
4. Set repository `Issues` to read and write.
5. Set repository `Pull requests` to read and write only if that persona may
   comment on pull-request threads; otherwise leave it unset.
6. Install the App with **Only select repositories**.
7. Download one private key and store it as `ensemble-1.pem`,
   `ensemble-2.pem`, or `ensemble-3.pem` under
   `~/.config/persephone/github-apps/` with mode `0600`.
8. Record the App slug/login, numeric App ID, and numeric installation ID.

GitHub's issue-comment endpoint accepts either `Issues: write` or
`Pull requests: write`, depending on the target thread; see the official
[issue-comment permission reference](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

Each sidecar mints a short-lived installation token and exposes only its
signed `POST /v1/comment` capability on the private Compose network. Hidden
markers and an SQLite uniqueness constraint make each persona idempotent per
Persephone-authored source post.

## Native RoboOMP environment

Start with native RoboOMP's `.env.example`. For the first repository, the
important values are:

```dotenv
ROBOMP_REPO_ALLOWLIST=CommanderTurtle/diogenes
ROBOMP_MAINTAINER_LOGINS=CommanderTurtle
ROBOMP_BOT_LOGIN=your-main-machine-account
ROBOMP_GIT_AUTHOR_NAME=Persephone
ROBOMP_GIT_AUTHOR_EMAIL=your-main-machine-account@users.noreply.github.com
GITHUB_WEBHOOK_SECRET=generate-a-long-random-value
ROBOMP_REPLAY_TOKEN=generate-another-long-random-value
ROBOMP_GH_PROXY_HMAC_KEY=generate-another-long-random-value
GITHUB_TOKEN=main-machine-account-token
```

Keep native RoboOMP's webhook, replay, HMAC, model, worker, and rate-limit
settings intact. `~/.omp/agent/models.container.yml` must also exist and point
from the container to the chosen local model provider; native RoboOMP already
mounts that file as its model registry.

## Persephone secrets

Store these in `~/.config/persephone/.env`:

```dotenv
PERSEPHONE_GITHUB_APPROVAL_TOKEN=human-dashboard-bearer-token
PERSEPHONE_GITHUB_ISSUE_HMAC_KEY=issue-sidecar-capability-key
PERSEPHONE_GITHUB_ISSUE_TOKEN=second-main-account-token

PERSEPHONE_ENSEMBLE_1_LOGIN=opsec-app-slug
PERSEPHONE_ENSEMBLE_1_APP_ID=decimal-app-id
PERSEPHONE_ENSEMBLE_1_INSTALLATION_ID=decimal-installation-id
PERSEPHONE_ENSEMBLE_1_HMAC_KEY=first-capability-key

PERSEPHONE_ENSEMBLE_2_LOGIN=longtimeuser4-app-slug
PERSEPHONE_ENSEMBLE_2_APP_ID=decimal-app-id
PERSEPHONE_ENSEMBLE_2_INSTALLATION_ID=decimal-installation-id
PERSEPHONE_ENSEMBLE_2_HMAC_KEY=second-capability-key

PERSEPHONE_ENSEMBLE_3_LOGIN=ancient-guru-app-slug
PERSEPHONE_ENSEMBLE_3_APP_ID=decimal-app-id
PERSEPHONE_ENSEMBLE_3_INSTALLATION_ID=decimal-installation-id
PERSEPHONE_ENSEMBLE_3_HMAC_KEY=third-capability-key

# Optional only when the local research services require authentication.
FIRECRAWL_API_KEY=
CAMOFOX_API_KEY=
```

The Compose overlay reaches the local sovereign services through
`host.docker.internal`. Override their defaults only when necessary:

```dotenv
PERSEPHONE_FIRECRAWL_URL=http://host.docker.internal:3002
PERSEPHONE_CAMOFOX_URL=http://host.docker.internal:9377
```

## Persephone configuration

Copy the complete `roboomp.github` shape from
`persephone.config.example.json`. The identity-specific portion should look
like this:

```json
{
  "roboomp": {
    "github": {
      "enabled": true,
      "allowedRepositories": ["CommanderTurtle/diogenes"],
      "allowedActors": ["CommanderTurtle"],
      "persephoneBotLogin": "your-main-machine-account",
      "dream": {
        "enabled": true,
        "automatic": false,
        "intervalMinutes": 1440,
        "repositories": ["CommanderTurtle/diogenes"],
        "directiveAuthor": "CommanderTurtle"
      },
      "ensemble": {
        "enabled": true,
        "personas": [
          {
            "id": "opsec-bro",
            "name": "Opsec bro",
            "botLogin": "opsec-app-slug",
            "promptFile": "rules/ensemble/persona-1.md",
            "commentProxyUrl": "http://persephone-ensemble-1:8091",
            "commentProxyKeyEnv": "PERSEPHONE_ENSEMBLE_1_HMAC_KEY"
          },
          {
            "id": "longtimeuser4",
            "name": "longtimeuser4",
            "botLogin": "longtimeuser4-app-slug",
            "promptFile": "rules/ensemble/persona-2.md",
            "commentProxyUrl": "http://persephone-ensemble-2:8091",
            "commentProxyKeyEnv": "PERSEPHONE_ENSEMBLE_2_HMAC_KEY"
          },
          {
            "id": "ancient-guru",
            "name": "Ancient Guru",
            "botLogin": "ancient-guru-app-slug",
            "promptFile": "rules/ensemble/persona-3.md",
            "commentProxyUrl": "http://persephone-ensemble-3:8091",
            "commentProxyKeyEnv": "PERSEPHONE_ENSEMBLE_3_HMAC_KEY"
          }
        ]
      }
    }
  }
}
```

The dream repositories must also be in `allowedRepositories`.
`directiveAuthor` must be in both `allowedActors` and native
`ROBOMP_MAINTAINER_LOGINS`. Startup fails closed when a required identity,
allowlist, or secret is absent.

## Integrate and operate

The native checkout on this workstation is auto-detected at
`~/repos/oh-my-pi/python/robomp`; otherwise set `ROBOMP_ROOT` explicitly.

```bash
cd ~/Hermes/persephone
persephone integrate
./scripts/robomp-github.sh config
./scripts/robomp-github.sh up
./scripts/robomp-github.sh status
./scripts/robomp-github.sh open
```

`persephone integrate` creates the dream and ensemble OMP profiles. Runtime
flags still remove all unnecessary capabilities from each worker.

Point GitHub's webhook at the externally reachable `/webhook/github` route and
use the same `GITHUB_WEBHOOK_SECRET`. Enable issue, issue-comment, pull-request,
pull-request-review, and pull-request-review-comment events. The timer-driven
dream flow itself can run without an inbound webhook, but normal follow-up
comments and reviews require delivery.

The approval dashboard remains loopback-only by default at
`http://127.0.0.1:6544/`. It exposes manual native triage/review, immediate
dream analysis, proposal publication/rejection, ensemble retry, implementation
dispatch, and exact-diff approval/rejection.

```bash
./scripts/robomp-github.sh logs
./scripts/robomp-github.sh down
```

`down` retains SQLite state, Docker volumes, and native RoboOMP sessions and
worktrees. No command in this integration merges a pull request.
