#!/bin/bash
# Double-click in Finder: adds ScreenPilot to every AI app on this Mac.
# If macOS says it can't verify the developer: System Settings -> Privacy & Security -> "Open Anyway".
cd "$(dirname "$0")" || exit 1
if [ ! -x bin/node ]; then
  echo "Please unzip the download first, then open the ScreenPilot folder and double-click this file again."
  read -r -p "Press Enter to close " _
  exit 1
fi
# Files from the internet are quarantined; the bundled ffmpeg is not notarized, so macOS would block it.
xattr -dr com.apple.quarantine . 2>/dev/null || true
./bin/node dist/cli.js setup "$@" >/dev/null
code=$?
[ "$code" -ne 0 ] && echo "Setup did not finish completely (see the message above)."
echo
read -r -p "Press Enter to close " _ || true
exit "$code"
