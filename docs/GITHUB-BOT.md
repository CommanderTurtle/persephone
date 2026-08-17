# GitHub bot integration

GitHub is not a Persephone chat transport. OMP already owns a stronger implementation in `python/robomp`, and Persephone keeps that security boundary intact.

`roboomp` receives signed GitHub webhooks, deduplicates them in SQLite, assigns one persistent OMP RPC session and isolated worktree to each issue, and writes back through a separate HMAC-authenticated `gh-proxy` container. The proxy alone holds the GitHub token. The agent receives narrow audited GitHub host tools rather than a general credential.

Use the OMP checkout's canonical workflow:

```bash
cd /path/to/oh-my-pi/python/robomp
cp .env.example .env
# Configure the documented webhook, bot identity, model, and repository allowlist values.
cd ../..
bun run pi:image
bun run robomp:build
bun run robomp:up
curl -fsS http://127.0.0.1:8080/healthz
```

The exact environment contract lives in OMP's `python/robomp/.env.example`; do not copy GitHub secrets into Persephone. Once the service is healthy, configure:

```json
{
  "roboomp": {
    "enabled": true,
    "url": "http://127.0.0.1:8080"
  }
}
```

Persephone then reports roboomp health alongside its own gateway without proxying webhooks, tokens, issue state, or write operations. This retains OMP's update path and avoids a second GitHub automation implementation drifting out of sync.
