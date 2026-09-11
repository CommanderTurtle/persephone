#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if systemctl --user is-active --quiet persephone.service; then
  exec bun src/cli.ts restart
fi
printf 'Persephone is inactive; no restart was needed.\n'
