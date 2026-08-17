#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
integration="$root/integrations/robomp"
compose_file="$integration/compose.yaml"
env_file="$integration/.env"
template="$integration/.env.example"

die() {
  printf 'persephone git-agent: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

compose() {
  docker compose --project-directory "$integration" --env-file "$env_file" -f "$compose_file" "$@"
}

validate_repository() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
    || die "repository must be owner/name"
}

timer_slug() {
  printf '%s' "$1" | tr '/[:upper:]' '-[:lower:]'
}

init_config() {
  require_command openssl
  if [ -e "$env_file" ]; then
    printf 'Existing configuration preserved: %s\n' "$env_file"
    return
  fi
  cp "$template" "$env_file"
  chmod 0600 "$env_file"
  local webhook hmac replay
  webhook="$(openssl rand -hex 32)"
  hmac="$(openssl rand -hex 32)"
  replay="$(openssl rand -hex 32)"
  sed -i \
    -e "s/^GITHUB_WEBHOOK_SECRET=$/GITHUB_WEBHOOK_SECRET=${webhook}/" \
    -e "s/^ROBOMP_GH_PROXY_HMAC_KEY=$/ROBOMP_GH_PROXY_HMAC_KEY=${hmac}/" \
    -e "s/^ROBOMP_REPLAY_TOKEN=$/ROBOMP_REPLAY_TOKEN=${replay}/" \
    "$env_file"
  printf 'Created %s with private random webhook, proxy, and trigger secrets.\n' "$env_file"
  printf 'Fill the GitHub identity, repository allowlist, maintainer list, and model fields before build/up.\n'
}

validate_config() {
  [ -f "$env_file" ] || die "run 'persephone git-agent init' first"
  local mode
  mode="$(stat -c '%a' "$env_file")"
  [ "$mode" = "600" ] || die "$env_file must have mode 600 (found $mode)"
  local key
  for key in OMP_VERSION OMP_COMMIT GITHUB_TOKEN GITHUB_WEBHOOK_SECRET \
             ROBOMP_GH_PROXY_HMAC_KEY ROBOMP_REPLAY_TOKEN ROBOMP_BOT_LOGIN \
             ROBOMP_GIT_AUTHOR_EMAIL ROBOMP_REPO_ALLOWLIST ROBOMP_MODEL; do
    [ -n "$(env_value "$key")" ] || die "$key is empty in $env_file"
  done
  [ -f "$HOME/.omp/agent/models.container.yml" ] \
    || die "missing $HOME/.omp/agent/models.container.yml"
}

doctor() {
  require_command docker
  docker compose version >/dev/null
  validate_config
  local pinned installed
  pinned="$(env_value OMP_VERSION)"
  installed="$(omp --version 2>/dev/null | sed -n 's#^omp/##p' | head -n 1 || true)"
  if [ -n "$installed" ] && [ "$installed" != "$pinned" ]; then
    printf 'warning: host OMP is %s while the isolated Git agent is pinned to %s\n' "$installed" "$pinned" >&2
  fi
  compose config --quiet
  printf 'ok: configuration, model mount, Docker Compose, and native version pin are coherent\n'
}

command="${1:-help}"
shift || true

case "$command" in
  init)
    init_config
    ;;
  doctor)
    doctor
    ;;
  build)
    doctor
    compose build --pull
    ;;
  up)
    doctor
    compose up -d --remove-orphans
    ;;
  down)
    [ -f "$env_file" ] || die "configuration does not exist"
    compose down
    ;;
  restart)
    doctor
    compose restart robomp gh-proxy
    ;;
  logs)
    [ -f "$env_file" ] || die "configuration does not exist"
    service="${1:-robomp}"
    compose logs -f --tail=200 "$service"
    ;;
  status)
    [ -f "$env_file" ] || die "configuration does not exist"
    compose ps
    port="$(env_value ROBOMP_PUBLIC_PORT)"
    curl -fsS "http://127.0.0.1:${port:-6543}/healthz"
    printf '\n'
    ;;
  triage)
    [ "$#" -eq 1 ] || die "usage: persephone git-agent triage owner/repo#123"
    validate_config
    compose exec -T robomp python -m robomp triage "$1"
    ;;
  cleanup)
    [ "$#" -eq 1 ] || die "usage: persephone git-agent cleanup owner/repo#123"
    validate_config
    compose exec -T robomp python -m robomp cleanup "$1"
    ;;
  dream)
    [ "$#" -ge 1 ] || die "usage: persephone git-agent dream owner/repo [bounded focus]"
    validate_config
    repo="$1"
    validate_repository "$repo"
    shift
    focus="$*"
    result="$(compose exec -T gh-proxy \
      /usr/local/libexec/persephone-scheduled-audit "$repo" --focus "$focus")"
    printf '%s\n' "$result" | jq .
    if [ "$(printf '%s\n' "$result" | jq -r '.created')" = "true" ]; then
      number="$(printf '%s\n' "$result" | jq -r '.number')"
      compose exec -T robomp python -m robomp triage "$repo#$number"
      printf 'Native RoboOMP triage queued for %s#%s. Implementation still requires a trusted directive.\n' "$repo" "$number"
    fi
    ;;
  dream-timer-enable)
    [ "$#" -ge 1 ] || die "usage: persephone git-agent dream-timer-enable owner/repo ['OnCalendar value']"
    require_command systemctl
    require_command systemd-analyze
    repo="$1"
    validate_repository "$repo"
    calendar="${2:-Sun *-*-* 05:00:00}"
    [[ "$calendar" != *$'\n'* && "$calendar" != *$'\r'* ]] \
      || die "calendar must be one line"
    systemd-analyze calendar "$calendar" >/dev/null \
      || die "invalid systemd OnCalendar value: $calendar"
    slug="$(timer_slug "$repo")"
    unit_dir="$HOME/.config/systemd/user"
    service="$unit_dir/persephone-robomp-dream-${slug}.service"
    timer="$unit_dir/persephone-robomp-dream-${slug}.timer"
    mkdir -p "$unit_dir"
    cat >"$service" <<EOF
[Unit]
Description=Seed one proposal-only Persephone audit for $repo
After=docker.service

[Service]
Type=oneshot
ExecStart=$root/scripts/robomp.sh dream $repo
EOF
    cat >"$timer" <<EOF
[Unit]
Description=Scheduled proposal-only Persephone audit for $repo

[Timer]
OnCalendar=$calendar
Persistent=true
RandomizedDelaySec=15m
Unit=persephone-robomp-dream-${slug}.service

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "persephone-robomp-dream-${slug}.timer"
    systemctl --user list-timers "persephone-robomp-dream-${slug}.timer" --no-pager
    ;;
  dream-timer-disable)
    [ "$#" -eq 1 ] || die "usage: persephone git-agent dream-timer-disable owner/repo"
    require_command systemctl
    repo="$1"
    validate_repository "$repo"
    slug="$(timer_slug "$repo")"
    unit_dir="$HOME/.config/systemd/user"
    systemctl --user disable --now "persephone-robomp-dream-${slug}.timer" 2>/dev/null || true
    rm -f \
      "$unit_dir/persephone-robomp-dream-${slug}.service" \
      "$unit_dir/persephone-robomp-dream-${slug}.timer"
    systemctl --user daemon-reload
    printf 'Removed the scheduled audit timer for %s. Existing GitHub issues and RoboOMP state were preserved.\n' "$repo"
    ;;
  review)
    [ "$#" -ge 1 ] || die "usage: persephone git-agent review /path/to/repo [PR_NUMBER]"
    repo="$1"
    [ -d "$repo/.git" ] || git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 \
      || die "not a Git worktree: $repo"
    if [ "$#" -ge 2 ]; then
      pr="$2"
      [[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "pull request number must be a positive integer"
      git -C "$repo" fetch --no-tags origin \
        "+refs/pull/${pr}/head:refs/remotes/persephone/pr-${pr}"
      base_ref="$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
      printf 'Fetched PR #%s as persephone/pr-%s without checking it out.\n' "$pr" "$pr"
      if [ -n "$base_ref" ]; then
        printf 'Review range: %s...persephone/pr-%s\n' "$base_ref" "$pr"
      fi
    fi
    if command -v orca-ide >/dev/null 2>&1; then
      orca-ide open >/dev/null
      orca-ide repo add --path "$repo" --json >/dev/null 2>&1 || true
      printf 'Registered the host clone in Orca'
    elif command -v gitcito >/dev/null 2>&1; then
      gitcito "$repo" >/dev/null 2>&1 &
      printf 'Opened the host clone in GitCito. Use Preview pull request locally'
    else
      die "neither gitcito nor orca-ide is installed"
    fi
    if [ "$#" -ge 2 ]; then
      printf ' for PR #%s' "$pr"
    fi
    printf '. The isolated RoboOMP worktree remains untouched.\n'
    ;;
  config)
    printf '%s\n' "$env_file"
    ;;
  help|-h|--help)
    cat <<'EOF'
Persephone native Git agent (RoboOMP)

  persephone git-agent init
  persephone git-agent doctor
  persephone git-agent build | up | down | restart
  persephone git-agent logs [robomp|gh-proxy]
  persephone git-agent status
  persephone git-agent triage owner/repo#123
  persephone git-agent cleanup owner/repo#123
  persephone git-agent dream owner/repo [bounded focus]
  persephone git-agent dream-timer-enable owner/repo ['OnCalendar value']
  persephone git-agent dream-timer-disable owner/repo
  persephone git-agent review /path/to/host/clone [PR_NUMBER]
  persephone git-agent config
EOF
    ;;
  *)
    die "unknown command: $command"
    ;;
esac
