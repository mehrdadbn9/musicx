#!/bin/sh
# MusicX local disk guard (WSL). Runs nightly via cron.daily.
# 1. Prune docker build cache and images unused for 72h (keeps the running
#    stack's images, drops stale rebuild layers).
# 2. Warn in the log if the host filesystem crosses 90%.
# Log line only; silent when healthy. Root cron, so docker access is direct.
LOG=/var/log/musicx-disk-guard.log
exec >>"$LOG" 2>&1
echo "=== $(date -Is) ==="

docker system prune -af --filter until=72h --volumes=false >/dev/null 2>&1
echo "prune done: $(docker system df --format '{{.Size}} used, {{.Reclaimable}} reclaimable' 2>/dev/null)"

used=$(df -P / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "${used:-0}" -ge 90 ]; then
  echo "WARN: root fs at ${used}%"
fi
