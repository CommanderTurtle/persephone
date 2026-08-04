---
name: persephone-operations
description: Operate Persephone's durable OMP gateway, schedules, routes, and health checks.
---

# Persephone operations

Use the `persephone` CLI for service lifecycle and durable automation:

- `persephone status` — control-plane, queue, worker, Signal, and schedule status.
- `persephone doctor` — read-only dependency and integration audit.
- `persephone schedule list` — list persistent cron prompts.
- `persephone schedule add NAME CRON PROMPT` — create or replace a schedule.
- `persephone schedule remove NAME` — delete one schedule.
- `persephone route list` — show channel-to-session mappings without exposing message bodies.
- `persephone integrate` — idempotently merge native OMP plugin and MCP registrations.

Do not use Persephone to replace OMP-native tasks, swarm definitions, editing, ACP, or memory.
