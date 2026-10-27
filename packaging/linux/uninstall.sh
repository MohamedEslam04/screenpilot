#!/usr/bin/env bash
# Removes ScreenPilot from your AI tools.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/bin/node" "$DIR/dist/cli.js" setup --remove "$@" >/dev/null
code=$?
if [ -n "${SCREENPILOT_IN_TERMINAL:-}" ]; then
  printf '\nPress Enter to close '
  read -r _ || true
fi
exit "$code"
