# RoboOMP ADE contract

Persephone owns the repository-assistant process used by Diogenes. The process
runs in an existing RoboOMP issue worktree, uses a separate persistent OMP
session, and returns data through a versioned JSON contract. Diogenes is a
client of that contract; it does not start OMP, enter a container, or write Git
state itself.

## GitCito reference audit

The interaction audit used GitCito commit
`0bab066640ea4d73f4f7e5a580644031f125c1f3` as a read-only reference. The
relevant source was:

- `src/main/repoChat.ts`: repository questions and bounded context selection;
- `src/main/grounding.ts`: file-backed evidence returned with an answer;
- `src/renderer/src/lib/repoChatContext.ts`: pinned repository context;
- `src/renderer/src/components/ActionWidgets.tsx`: actions shown for review
  before execution;
- the matching repository-chat and action tests.

Persephone adopts those interaction patterns through its existing OMP and
RoboOMP interfaces. It does not vendor GitCito, run Electron, share GitCito
state, or depend on a GitCito checkout.

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

The assistant receives read-oriented repository tools. OMP retains write
approval mode, and the headless approval handler declines write prompts. A
custom `propose_roboomp_action` tool may return one of these existing owner
mutations:

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
