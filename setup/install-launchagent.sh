#!/bin/zsh
# Installs (or reinstalls) the LaunchAgent that keeps the estimator
# dashboard running on the Mac: starts at login, relaunches on crash,
# keeps the machine awake while running, logs to logs/server.log.
#
# Run once from the repo root on the Mac:
#   ./setup/install-launchagent.sh
#
# Safe to re-run any time (e.g. after moving the repo or updating node) —
# it replaces the existing agent and restarts the server.
set -euo pipefail

LABEL=com.epoxycreations.estimator
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[[ -x "$NODE" ]] || { echo "node not found on PATH"; exit 1; }
mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"

# caffeinate -s keeps the system awake for as long as the server runs
# (mac mini on AC power). KeepAlive relaunches it if it ever exits, so
# `kill $(lsof -ti :8788)` remains the standard "restart after update".
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>$NODE</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/server.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- server spawns node / claude / npx as children; launchd's default
         PATH is bare, so include the dirs they actually live in -->
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL"
echo "  dashboard: http://localhost:8788"
echo "  logs:      tail -f $ROOT/logs/server.log"
echo
echo "For full survive-a-reboot coverage, also set (one time, in System Settings):"
echo "  1. Users & Groups -> Automatically log in as your user"
echo "     (requires FileVault to be off; otherwise the Mac waits at the"
echo "      unlock screen after a reboot and nothing can start)"
echo "  2. Energy -> Start up automatically after a power failure"
echo "  3. General -> Sharing -> Remote Login ON (fix anything via SSH/Tailscale)"
