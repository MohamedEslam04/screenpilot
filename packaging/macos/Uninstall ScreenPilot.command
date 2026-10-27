#!/bin/bash
# Double-click in Finder: removes ScreenPilot from your AI apps.
cd "$(dirname "$0")" || exit 1
xattr -dr com.apple.quarantine . 2>/dev/null || true
./bin/node dist/cli.js setup --remove "$@" >/dev/null
code=$?
echo
read -r -p "Press Enter to close " _ || true
exit "$code"
