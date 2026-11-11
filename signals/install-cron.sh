#!/bin/zsh
# Schedules the signal bot to run every hour at :05 on this Mac (launchd).
#   ./signals/install-cron.sh            install + start
#   ./signals/install-cron.sh uninstall  stop + remove
set -euo pipefail

LABEL="com.signalbot.hourly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="${0:A:h}"
LOG="$HOME/Library/Logs/signal-bot.log"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi

if [[ "$HERE" == *"/.claude/worktrees/"* ]]; then
  echo "This copy lives in a temporary worktree. Merge the branch and run the installer from the main checkout." >&2
  exit 1
fi

NODE="$(command -v node || true)"
[[ -x "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }

"$NODE" "$HERE/signal-bot.js" test-ping || {
  echo "\nTest ping was not delivered. Set NTFY_TOPIC (or Telegram) in .env first — see signals/README.md." >&2
  exit 1
}

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$HERE/signal-bot.js</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>5</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Runs every hour at :05. Log: $LOG"
