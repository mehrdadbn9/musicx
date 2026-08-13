#!/usr/bin/env bash
# MusicX local disk guard — keeps the WSL vhdx (real C: disk) from filling.
#
# The WSL virtual disk is a sparse vhdx on C:; `df /` reports the virtual
# ceiling, NOT real free space. Real usage = the vhdx file on Windows.
# So this guard watches both:
#   1. Real C: free space (what actually runs out)
#   2. Docker reclaimable junk (images + build cache), pruned when large
#
# Runs every few hours via cron. Silent when healthy; prints an alert line
# (and exits 1) when a threshold is breached so the cron wrapper can flag it.

set -u

FREE_GB_ALERT=10        # alert when C: free drops below this (GB)
FREE_GB_PRUNE=20        # prune docker junk when C: free is below this (GB)
PRUNE_RECLAIM_GB=3      # prune when docker reclaimable exceeds this (GB)

LOG=/var/log/musicx-disk-guard.log
ts() { date '+%F %T'; }

# --- 1. Real Windows C: free space ---------------------------------------
# Best-effort: the vhdx lives under /mnt/c/Users/<user>/AppData/Local/...
# `df -P /mnt/c` reads the real filesystem, which is what we want.
C_FREE_KB=$(df -Pk /mnt/c 2>/dev/null | awk 'NR==2 {print $4}')
if [ -z "$C_FREE_KB" ]; then
  echo "$(ts) WARN: cannot read /mnt/c free space" >> "$LOG"
  C_FREE_GB=999
else
  C_FREE_GB=$((C_FREE_KB / 1024 / 1024))
fi

# --- 2. Docker reclaimable junk ------------------------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RECLAIM_KB=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null \
               | awk -F'[^0-9]*' '{s+=$1} END {printf "%d", s/1024/1024}')
  RECLAIM_GB=${RECLAIM_KB:-0}
else
  RECLAIM_GB=0
fi

echo "$(ts) C:free=${C_FREE_GB}G docker_reclaimable=${RECLAIM_GB}G" >> "$LOG"

# --- 3. Act ---------------------------------------------------------------
ALERT=""
if [ "$C_FREE_GB" -lt "$FREE_GB_ALERT" ]; then
  ALERT="CRITICAL: C: free is ${C_FREE_GB}G (alert below ${FREE_GB_ALERT}G)"
fi

if [ "$C_FREE_GB" -lt "$FREE_GB_PRUNE" ] || [ "$RECLAIM_GB" -gt "$PRUNE_RECLAIM_GB" ]; then
  echo "$(ts) pruning docker junk (reclaim ${RECLAIM_GB}G)" >> "$LOG"
  docker system prune -af --volumes=false >> "$LOG" 2>&1
  docker builder prune -af >> "$LOG" 2>&1
fi

if [ -n "$ALERT" ]; then
  echo "$ALERT"
  exit 1
fi
exit 0
