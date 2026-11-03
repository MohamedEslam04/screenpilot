#!/bin/sh
# Updates ScreenPilot to the latest release (only the app files, a few MB), then restart your AI apps.
# Run it from the installed copy: ~/.local/share/screenpilot/update.sh
cd "$(dirname "$0")" || exit 1
if [ ! -x bin/node ]; then
  echo "Run this from the installed ScreenPilot folder (~/.local/share/screenpilot)." >&2
  exit 1
fi
exec ./bin/node dist/cli.js update "$@"
