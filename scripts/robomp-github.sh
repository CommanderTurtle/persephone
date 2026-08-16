#!/usr/bin/env bash
set -euo pipefail

action="${1:-help}"
persephone_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_file="${PERSEPHONE_CONFIG:-${HOME}/.config/persephone/config.json}"
robomp_root="${ROBOMP_ROOT:-}"

if [[ -z "$robomp_root" ]]; then
  for candidate in "$HOME/repos/oh-my-pi/python/robomp" "$HOME/oh-my-pi/python/robomp" "$HOME/src/oh-my-pi/python/robomp"; do
    if [[ -f "$candidate/docker-compose.yml" ]]; then robomp_root="$candidate"; break; fi
  done
fi

if [[ -z "$robomp_root" || ! -f "$robomp_root/docker-compose.yml" ]]; then
  echo "Set ROBOMP_ROOT to the native oh-my-pi/python/robomp directory." >&2
  exit 2
fi
if [[ ! -f "$config_file" ]]; then
  echo "Persephone config not found: $config_file (run: persephone init)" >&2
  exit 2
fi
if [[ ! -f "$robomp_root/.env" ]]; then
  echo "Native RoboOMP environment not found: $robomp_root/.env" >&2
  exit 2
fi

export PERSEPHONE_ROOT="$persephone_root"
export PERSEPHONE_CONFIG_FILE="$config_file"
overlay="$persephone_root/integrations/robomp/docker-compose.persephone.yml"
persephone_env="$(dirname "$config_file")/.env"
compose=(docker compose --project-directory "$robomp_root" --env-file "$robomp_root/.env")
if [[ -f "$persephone_env" ]]; then compose+=(--env-file "$persephone_env"); fi
compose+=(-f "$robomp_root/docker-compose.yml" -f "$overlay")

ensemble_enabled="$(bun -e 'const c=JSON.parse(await Bun.file(process.argv[1]).text()); process.stdout.write(c?.roboomp?.github?.ensemble?.enabled ? "true" : "false")' "$config_file")"
if [[ "$ensemble_enabled" == "true" ]]; then compose+=(--profile ensemble); fi
dream_enabled="$(bun -e 'const c=JSON.parse(await Bun.file(process.argv[1]).text()); process.stdout.write(c?.roboomp?.github?.dream?.enabled ? "true" : "false")' "$config_file")"
if [[ "$dream_enabled" == "true" ]]; then compose+=(--profile dream); fi

case "$action" in
  up)
    "${compose[@]}" up -d --build
    ;;
  down)
    "${compose[@]}" down
    ;;
  restart)
    "${compose[@]}" restart persephone-github robomp
    ;;
  logs)
    "${compose[@]}" logs -f --tail=200 persephone-github robomp
    ;;
  status)
    "${compose[@]}" ps
    curl --fail --silent --show-error http://127.0.0.1:"${PERSEPHONE_GITHUB_PORT:-6544}"/healthz
    printf '\n'
    ;;
  config)
    "${compose[@]}" config
    ;;
  open)
    xdg-open "http://127.0.0.1:${PERSEPHONE_GITHUB_PORT:-6544}/" >/dev/null 2>&1 || \
      echo "Open http://127.0.0.1:${PERSEPHONE_GITHUB_PORT:-6544}/"
    ;;
  *)
    cat <<'EOF'
Usage: ./scripts/robomp-github.sh up|down|restart|logs|status|config|open

This composes Persephone's approval/dream/ensemble layer with native OMP RoboOMP.
It does not fork RoboOMP, expose its PAT, or create a second GitHub worker.
Set ROBOMP_ROOT when oh-my-pi is not in a standard checkout location.
EOF
    ;;
esac
