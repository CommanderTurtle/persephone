# Persephone with native RoboOMP

Persephone does not replace OMP's GitHub worker. It composes a policy and
approval layer with OMP's native `python/robomp` service:

- RoboOMP still owns signed webhook intake, durable events, per-issue Linux
  users, isolated worktrees, persistent JSONL sessions, host tools, retries,
  and GitHub mutations.
- RoboOMP's existing `gh-proxy` still holds the main GitHub token.
- Persephone verifies a stricter repository-and-actor allowlist before an
  event reaches RoboOMP.
- Persephone interposes only at the existing HMAC proxy boundary to require
  exact-diff approval before `git push` and pull-request creation.
- A read-only dream worker may draft grounded improvement issues. It cannot
  create an issue until a human approves the draft.
- Three optional ensemble workers have no tools or credentials. Each may add
  one distinct, useful comment through its own comment-only identity sidecar.

The upstream behavior and isolation model remain documented in the native
[RoboOMP README](https://github.com/can1357/oh-my-pi/blob/main/python/robomp/README.md)
and [RoboOMP agent guide](https://github.com/can1357/oh-my-pi/blob/main/python/robomp/AGENTS.md).

## Authority flow

```text
signed GitHub webhook
        │
        ▼
Persephone repo + actor firewall
        │
        ▼
native RoboOMP queue/session/worktree
        │
        ├── comments/labels/reviews through native gh-proxy
        │
        └── push/PR request
                 │
                 ▼
          exact base/head diff
          human approve/reject
                 │
                 ▼
          same native request resumes
```

An approval is not a merge. It authorizes only the recorded base commit, head
commit, repository, branch, and RoboOMP workspace. If the worktree changes,
Persephone marks the proposal conflicted and requires a new review.

## Proactive dream loop

The loop is intentionally two-stage:

1. On its configured interval, Persephone refreshes RoboOMP's native shared
   clone and creates a detached temporary worktree.
2. OMP receives only `read`, `grep`, and `glob`. Sessions, Bash, write/edit,
   LSP, extensions, and skills are disabled. GitHub and approval secrets are
   removed from the child environment.
3. The model either skips or drafts one concrete `But what about …?` proposal
   citing files, symbols, and acceptance checks.
4. The proposal appears on the loopback dashboard. Nothing is posted yet.
5. Human approval sends the exact draft to an issue-only sidecar. That process
   can create an issue but cannot comment, push, label, review, or open a PR.
6. Persephone manually triages that real issue through native RoboOMP and
   records the approving maintainer directive in RoboOMP's signed event path.
   This is internal authorization metadata from the dashboard action, not a
   fabricated public GitHub comment.
7. RoboOMP performs the implementation in its normal persistent issue
   workspace. Any eventual push stops at the separate exact-diff gate.

The schedule initializes at startup and waits one full interval; it does not
immediately scan every repository. Only one pending/approved dream may exist
per repository. A failed issue publication is idempotent and can be retried.
There is no automatic merge or self-approval path.

## GitHub identities and avatars

Use one human-created GitHub machine account for native RoboOMP's main bot.
GitHub's terms permit one free machine account in addition to a free personal
account, so the three ensemble identities should be private GitHub Apps rather
than three more machine accounts. Each App has its own name, slug, avatar,
private key, installation, and narrow repository permissions.

For a personal-account repository such as `CommanderTurtle/diogenes`, GitHub
currently does not allow a fine-grained PAT to contribute as a repository
collaborator. Give the main machine account collaborator access and use a
classic PAT with `public_repo` for a public repository (`repo` only if a
private repository is deliberately added later). Add the classic `workflow`
scope to the main RoboOMP token only when a permitted branch may add or update
`.github/workflows`; the Diogenes upstream-sync test needs it. RoboOMP's HMAC
proxy and both repository allowlists still confine where that credential may
be used. Create a second `public_repo` token without `workflow` on the same
account for the approved-dream issue sidecar, so it can be revoked
independently.

Create each ensemble App with webhooks disabled, no account or organization
permissions, and only these repository permissions:

- Metadata: read-only (automatic);
- Issues: read and write;
- Pull requests: read and write.

Install each App with **Only select repositories** and select only the
allowlisted repository. Download each App private key into
`~/.config/persephone/github-apps/ensemble-1.pem` (then `-2.pem` and `-3.pem`)
and set mode `0600`. The comment sidecar mints an installation token on demand,
renews it before GitHub's one-hour expiry, verifies the App slug, and exposes
only `POST /v1/comment` on the private Compose network. The private key and
installation token never enter Persephone's OMP workers or native RoboOMP.

For each main Persephone issue, PR, or issue comment, every persona is queued
once. The model must skip agreement, praise, repetition, and roleplay-only
chatter. An SQLite uniqueness constraint and a hidden GitHub marker make the
one-comment-per-persona-per-source rule idempotent across restarts.

Customize the three prompt files under `rules/ensemble/`. Prompts shape tone;
separate tokens and capability sidecars enforce authority.

## Configuration

Start with native RoboOMP's `.env.example`; it remains authoritative for its
main token, bot login, HMAC keys, webhook secret, repository allowlist,
maintainers, model, and worker settings. The important values must agree:

```dotenv
# Native python/robomp/.env
ROBOMP_REPO_ALLOWLIST=CommanderTurtle/diogenes
ROBOMP_MAINTAINER_LOGINS=CommanderTurtle
ROBOMP_BOT_LOGIN=your-main-machine-account
ROBOMP_GIT_AUTHOR_NAME=Persephone
ROBOMP_GIT_AUTHOR_EMAIL=your-main-machine-account@users.noreply.github.com
GITHUB_WEBHOOK_SECRET=generate-a-long-random-value
ROBOMP_REPLAY_TOKEN=generate-another-long-random-value
ROBOMP_GH_PROXY_HMAC_KEY=generate-another-long-random-value
GITHUB_TOKEN=classic-public_repo-plus-workflow-token-for-main-machine-account
```

In `~/.config/persephone/.env`:

```dotenv
PERSEPHONE_GITHUB_APPROVAL_TOKEN=human-dashboard-bearer-token
PERSEPHONE_GITHUB_ISSUE_HMAC_KEY=issue-sidecar-capability-key
PERSEPHONE_GITHUB_ISSUE_TOKEN=second-classic-public_repo-token-for-main-machine-account

PERSEPHONE_ENSEMBLE_1_LOGIN=first-app-slug
PERSEPHONE_ENSEMBLE_1_APP_ID=decimal-app-id
PERSEPHONE_ENSEMBLE_1_INSTALLATION_ID=decimal-installation-id
PERSEPHONE_ENSEMBLE_1_HMAC_KEY=first-capability-key
# Repeat for identities 2 and 3.
```

In `~/.config/persephone/config.json`, enable `roboomp.github`, then copy the
complete GitHub shape from `persephone.config.example.json`. In particular:

```json
{
  "roboomp": {
    "github": {
      "allowedRepositories": ["CommanderTurtle/diogenes"],
      "allowedActors": ["CommanderTurtle"],
      "persephoneBotLogin": "your-main-machine-account",
      "dream": {
        "enabled": true,
        "intervalMinutes": 1440,
        "repositories": ["CommanderTurtle/diogenes"],
        "directiveAuthor": "CommanderTurtle"
      },
      "ensemble": {
        "enabled": true,
        "personas": [
          {
            "id": "persona-1",
            "name": "Ensemble I",
            "botLogin": "first-app-slug",
            "promptFile": "rules/ensemble/persona-1.md",
            "commentProxyUrl": "http://persephone-ensemble-1:8091",
            "commentProxyKeyEnv": "PERSEPHONE_ENSEMBLE_1_HMAC_KEY"
          }
        ]
      }
    }
  }
}
```

The real config must contain exactly three persona records. Dream repositories
must also be in `allowedRepositories`; `directiveAuthor` must also be in
`allowedActors` and native `ROBOMP_MAINTAINER_LOGINS`. Startup fails closed
when a required list or secret is absent.

## Start and operate

Point `ROBOMP_ROOT` at the native OMP directory containing RoboOMP's
`docker-compose.yml` and `.env`:

```bash
cd ~/Hermes/persephone
persephone integrate
export ROBOMP_ROOT=/path/to/oh-my-pi/python/robomp
./scripts/robomp-github.sh config
./scripts/robomp-github.sh up
./scripts/robomp-github.sh status
./scripts/robomp-github.sh open
```

`persephone integrate` creates the configured dream and ensemble OMP profiles
with the same local model definitions and sovereign worker defaults used by
the main gateway profile. Runtime flags still remove their tools/sessions.

Configure GitHub's webhook to the externally reachable
`/webhook/github` path on Persephone's bridge, using the same
`GITHUB_WEBHOOK_SECRET`. Keep the approval dashboard bound to loopback; its
default local address is `http://127.0.0.1:6544/`.

The dashboard supports:

- manual native triage of `owner/repo#123`;
- manual native review of a pull request;
- immediate read-only dream analysis for a configured repository;
- approve/reject of issue drafts;
- approve/reject of exact implementation diffs.

Shutdown retains SQLite state and native RoboOMP sessions/worktrees:

```bash
./scripts/robomp-github.sh down
```

`down` does not delete volumes. No command in this integration posts to GitHub
until a real signed webhook, explicit manual triage/review, approved dream
issue, or approved native publication request supplies the corresponding
authority.
