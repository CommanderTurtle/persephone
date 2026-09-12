# RoboOMP ADE contract

Persephone owns the repository-assistant process used by Diogenes. The process
runs in an existing RoboOMP issue worktree, uses a separate persistent OMP
session, and returns data through a versioned JSON contract. Diogenes is a
client of that contract; it does not start OMP, enter a container, or write Git
state itself.

## GitCito reference audit

The interaction audit is pinned to GitCito commit
`0bab066640ea4d73f4f7e5a580644031f125c1f3` (`v4.7.0`, MIT; copyright 2026
MyAppDesk). The relevant source is:

- `src/main/repoChat.ts`: repository questions and bounded context selection;
- `src/main/grounding.ts`: file-backed evidence returned with an answer;
- `src/renderer/src/lib/repoChatContext.ts`: pinned repository context;
- `src/renderer/src/components/ActionWidgets.tsx`: actions shown for review
  before execution;
- the matching repository-chat and action tests.

This is now a code-level derivation rather than a visual comparison:

- `integrations/robomp/workspace_agent.py` ports GitCito's bounded unified-diff
  hunk parser and opaque evidence identifiers. The model receives `[E#]`
  records, and Persephone resolves only identifiers that were in the supplied
  evidence set back to repository paths and line ranges.
- Diogenes ports GitCito's subsequence, contiguous-run, word-boundary fuzzy
  scorer and its bounded per-hunk diff breakdown into the RoboOMP command
  palette and worktree viewer.
- Selected context retains GitCito's append-in-order, deduplicate, hard-cap
  behavior while using RoboOMP's issue/diff/file/commit/run/artifact types.
- Reviewed operations retain GitCito's separation between a proposed action
  and execution, but the allowed action union remains RoboOMP's five existing
  owner operations rather than GitCito's broader desktop Git surface.

Repository discovery itself is not copied: GitCito discovers arbitrary local
worktrees, while RoboOMP exposes only configured repositories and issue
worktrees returned by its database/API. GitCito's Electron state, filesystem
discovery, branding, and theme are not included, and there is no runtime
dependency on a GitCito checkout.

## Query contract

`persephone git-agent workspace assistant FILE.json [--consume]` accepts at
most 1 MB of UTF-8 JSON:

```json
{
  "version": 1,
  "operation": "ask",
  "issue": "owner/repository#123",
  "question": "What changed and why?",
  "context": [
    { "kind": "file", "reference": "src/service.ts" },
    { "kind": "commit", "reference": "0123abcd" }
  ]
}
```

The owner validates and deduplicates up to sixteen context references, then
passes the request over stdin to a fixed helper inside the pinned RoboOMP
container. `operation: "history"` reads the separate ADE session without
starting an agent turn.

The response schema is `persephone.robomp.assistant.v1`. It contains the
bounded assistant history, model/session metadata, tool activity, existing
`path:line` citations, and typed action proposals.

## Mutation boundary

The assistant receives only OMP's `read`, `grep`, and `glob` repository tools.
OMP runs in `always-ask` mode and its headless approval handler declines any
unexpected write or execution request. Persephone resolves the selected Git
status, recent history, diff, and commit evidence into bounded prompt context
without exposing an arbitrary shell. A custom `propose_roboomp_action` tool
may return one of these existing owner mutations:

- `trigger.triage`
- `trigger.retry`
- `trigger.cancel`
- `issue.cleanup`
- `audit.dream`

Calling the tool records a deterministic proposal; it does not execute the
mutation. Diogenes displays the proposal and sends it through its existing
confirmation job only after an operator chooses Review. Host shell access,
staging, commits, and force operations are reported as unavailable instead of
being emulated in the browser.

## Session and process isolation

- Each issue uses `<issue-workspace>/.omp-ade-session`; the automated RoboOMP
  run continues to use `.omp-session`.
- A non-blocking issue lock permits one ADE turn at a time.
- The helper runs as the issue slot user with RoboOMP's existing environment,
  safe-directory, group, and Git identity preparation.
- The browser receives JSON only. It never receives a shell, filesystem
  descriptor, Git credential, or container command.
- Assistant requests and mutations use separate schemas and entry points.
