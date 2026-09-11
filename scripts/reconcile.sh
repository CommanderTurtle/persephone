#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
command -v bun >/dev/null 2>&1 || {
  printf 'Bun 1.3.14 or newer is required. Install Bun or Sandwich first.\n' >&2
  exit 1
}
exec bun src/cli.ts reconcile "$@"
