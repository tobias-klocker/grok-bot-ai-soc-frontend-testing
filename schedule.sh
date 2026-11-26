#!/bin/bash
# Switches the weekly visual review (scheduled.sh) on and off, as a macOS
# launchd job of this user. Day, time and budget come from schedule.conf.
#
#   .grok-bot/schedule.sh status      on or off, when, and the last runs
#   .grok-bot/schedule.sh install     switch it on (again after changing schedule.conf)
#   .grok-bot/schedule.sh uninstall   switch it off
#   .grok-bot/schedule.sh test        one run now, the way the schedule runs it (uses the Grok budget)
#   AI=0 .grok-bot/schedule.sh test   the same without Grok: free
#   .grok-bot/schedule.sh plist       show the launchd file that install writes
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="local.grok-bot.$(basename "$(dirname "$KIT")")"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
WEEKDAY=1 HOUR=6 MINUTE=42
[ -f "$KIT/schedule.conf" ] && . "$KIT/schedule.conf"
DAYS=(Sunday Monday Tuesday Wednesday Thursday Friday Saturday Sunday)
WHEN="$(printf '%ss at %02d:%02d' "${DAYS[$WEEKDAY]}" "$HOUR" "$MINUTE")"

plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$KIT/scheduled.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>$WEEKDAY</integer>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$KIT/runs/launchd.log</string>
  <key>StandardErrorPath</key><string>$KIT/runs/launchd.log</string>
</dict>
</plist>
PLIST
}

case "${1:-status}" in
  plist) plist ;;
  install)
    mkdir -p "$(dirname "$PLIST")" "$KIT/runs"
    plist > "$PLIST"
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "On: the visual review of ${BASE:-main} runs $WHEN (budget: $([ "${MAX_USD:-3}" = none ] && echo "no limit" || echo "\${MAX_USD:-3}")). Switch off: .grok-bot/schedule.sh uninstall"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Off: the weekly review will not run."
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then echo "On: runs $WHEN."; else echo "Off (ready: .grok-bot/schedule.sh install switches it on for $WHEN)."; fi
    last="$(ls -t "$KIT"/runs/scheduled-*.log 2>/dev/null | head -3 || true)"
    [ -z "$last" ] || { echo "Last scheduled runs:"; for f in $last; do echo "  $(basename "$f"): $(grep '^notification:' "$f" | tail -1 | cut -c15-)"; done; }
    ;;
  test)
    echo "Running it now, as the schedule would; the log: .grok-bot/runs/scheduled-<time>.log"
    /bin/bash "$KIT/scheduled.sh"
    f="$(ls -t "$KIT"/runs/scheduled-*.log | head -1)"
    grep '^notification:' "$f" | tail -1
    ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
