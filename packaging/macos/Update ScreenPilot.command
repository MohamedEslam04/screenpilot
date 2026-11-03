#!/bin/bash
# Double-click in Finder: updates ScreenPilot to the latest release (only the app files, a few MB).
# Run this copy from ~/Library/Application Support/ScreenPilot, the installed one. Then restart your AI apps.
cd "$(dirname "$0")" || exit 1
if [ ! -x bin/node ]; then
  echo "Run this from the installed ScreenPilot folder (~/Library/Application Support/ScreenPilot)."
  read -r -p "Press Enter to close " _
  exit 1
fi
./bin/node dist/cli.js update
read -r -p "Press Enter to close " _
