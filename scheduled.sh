#!/bin/bash
# The weekly visual review, as launchd starts it (schedule.sh) with nobody
# watching: the branch of schedule.conf, every page, Grok within its budget.
# Says how it went in a notification either way, and in runs/scheduled-<time>.log.
set -uo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$KIT/runs"
LOGFILE="$KIT/runs/scheduled-$STAMP.log"
exec >>"$LOGFILE" 2>&1

# launchd starts with a bare PATH: add Docker Desktop, Homebrew and gh.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

notify() {
  echo "notification: $1 — $2"
  osascript -e "display notification \"$2\" with title \"Grok bot\" subtitle \"$1\"" >/dev/null 2>&1 || true
}
fail() {
  notify "Weekly review failed" "$1. Log: .grok-bot/runs/$(basename "$LOGFILE")"
  exit 1
}

BASE=main MAX_USD=3 KEEP_RUNS=8 SWEEP_VARIANTS="" REVIEW_VARIANTS="" BACKUP=1
[ -f "$KIT/schedule.conf" ] && . "$KIT/schedule.conf"
echo "== $(date): weekly visual review of $BASE, Grok budget \$$MAX_USD"

# Docker Desktop is started when it is not running, and given three minutes.
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running; starting Docker Desktop"
  open -ga Docker 2>/dev/null || fail "Docker Desktop is not installed"
  for _ in $(seq 36); do
    sleep 5
    docker info >/dev/null 2>&1 && break
  done
  docker info >/dev/null 2>&1 || fail "Docker Desktop did not start"
fi

export BASE MAX_USD UNATTENDED=1
[ -n "$SWEEP_VARIANTS" ] && export SWEEP_VARIANTS
[ -n "$REVIEW_VARIANTS" ] && export REVIEW_VARIANTS
"$KIT/run.sh" visual || fail "The run stopped (exit $?)"

OUT="$(ls -td "$KIT"/runs/2*-visual 2>/dev/null | head -1)"
[ -n "$OUT" ] && [ -f "$OUT/findings.json" ] || fail "The run wrote no report"
new="$(sed -nE 's/^New since the previous run: ([0-9]+) page findings, ([0-9]+) text findings.*/\1 new on pages, \2 in texts/p' "$OUT/review.log")"
cost="$(sed -nE 's/^Grok cost this run: (\$[0-9.]+).*/\1/p' "$OUT/review.log")"
left="$(grep -c 'were not reviewed: the budget' "$OUT/review.log" || true)"
notify "Weekly review ready" "${new:-first run, nothing to compare}; Grok ${cost:-\$0}$([ "${left:-0}" -gt 0 ] && echo ', budget reached'). Report: .grok-bot/runs/$(basename "$OUT")/report.html"

# Older runs go, the newest KEEP_RUNS stay.
if [ "${KEEP_RUNS:-0}" -gt 0 ]; then
  ls -td "$KIT"/runs/2*-visual 2>/dev/null | tail -n +$((KEEP_RUNS + 1)) | while read -r d; do
    echo "deleting the old run $(basename "$d")"
    rm -rf "$d"
  done
  ls -t "$KIT"/runs/scheduled-*.log 2>/dev/null | tail -n +$((KEEP_RUNS + 1)) | while read -r f; do rm -f "$f"; done
fi
# The kit to GitHub (backup.sh): notes, accepted findings, the review cache.
if [ "${BACKUP:-0}" = 1 ]; then
  "$KIT/backup.sh" "Weekly run $STAMP" || notify "Backup failed" "The review ran; the push to GitHub did not. Log: .grok-bot/runs/$(basename "$LOGFILE")"
fi
echo "== $(date): done"
