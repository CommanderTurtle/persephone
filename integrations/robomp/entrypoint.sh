#!/usr/bin/env bash
set -euo pipefail

# Match RoboOMP's native slot model: one unprivileged Linux identity per
# concurrent issue, with only the shared git pool group in common.
umask 0002

is_proxy=0
if [ "${1:-}" = "python" ] && [ "${2:-}" = "-m" ] && [[ "${3:-}" == robomp.proxy* ]]; then
  is_proxy=1
fi

/usr/sbin/groupadd -f -g 2000 omp
max_slots="${ROBOMP_MAX_CONCURRENCY:-2}"
for i in $(seq 1 "$max_slots"); do
  user="omp-$i"
  group="omp-$i"
  slot_id=$((2000 + i))
  /usr/sbin/groupadd -f -g "$slot_id" "$group"
  id -u "$user" >/dev/null 2>&1 || /usr/sbin/useradd -u "$slot_id" -g "$group" -G omp -M -N -s /usr/sbin/nologin "$user"
  /usr/sbin/usermod -g "$group" -a -G omp "$user"
done

if [ "$is_proxy" -eq 1 ]; then
  exec "$@"
fi

mkdir -p \
  /data/workspaces/_pool \
  /data/logs \
  /data/cache/cargo \
  /data/cache/cargo-target \
  /data/cache/rustup
chown -R root:omp /data/workspaces/_pool /data/cache
find /data/workspaces/_pool /data/cache -type d -exec chmod 2770 {} +
find /data/workspaces/_pool /data/cache -type f -perm /111 -exec chmod 0770 {} +
find /data/workspaces/_pool /data/cache -type f ! -perm /111 -exec chmod 0660 {} +
chmod 0700 /data/logs

rm -rf /srv/agent-home/.agent /srv/agent-home/.omp/agent
mkdir -p /srv/agent-home/.agent /srv/agent-home/.omp/agent
cp -a /srv/agent-home-stage/.agent/. /srv/agent-home/.agent/
cp -a /srv/agent-home-stage/.omp/agent/. /srv/agent-home/.omp/agent/
chown -R root:root /srv/agent-home
find /srv/agent-home -type d -exec chmod 0755 {} +
find /srv/agent-home -type f -exec chmod 0644 {} +

mkdir -p /srv/agent-home/.omp/run
chgrp -R omp /srv/agent-home/.omp/run
chmod -R g+rwX /srv/agent-home/.omp/run
find /srv/agent-home/.omp/run -type d -exec chmod 2770 {} +

touch /data/robomp.sqlite
chown root:root /data/robomp.sqlite
chmod 0600 /data/robomp.sqlite

exec "$@"
