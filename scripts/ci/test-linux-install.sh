#!/usr/bin/env bash
# Extract the Linux tarball into a folder with a space and Arabic letters, run install.sh
# non-interactively against a throwaway home (also with a space), check, then uninstall.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tarball="$(ls "$root"/release/ScreenPilot-*-linux.tar.gz | head -1)"
work="${RUNNER_TEMP:-/tmp}/مجلد تجربة"
home="${RUNNER_TEMP:-/tmp}/fake home"
rm -rf "$work" "$home"
mkdir -p "$work" "$home/.codex" "$home/.config/opencode"
tar -xzf "$tarball" -C "$work"

export HOME="$home" XDG_DATA_HOME="$home/.local/share" XDG_CONFIG_HOME="$home/.config"
export SCREENPILOT_NO_TERMINAL=1 # a CI box has no desktop; never try to open a terminal

echo "install.sh (stdin is not a TTY, so it must not prompt):"
"$work/ScreenPilot/install.sh" --clients codex,opencode </dev/null

node "$root/scripts/ci/assert-registered.mjs" "$home" present
test -x "$home/.local/share/screenpilot/bin/node"
"$home/.local/share/screenpilot/bin/node" "$home/.local/share/screenpilot/dist/cli.js" doctor > "$work/doctor.json" || true
node -e "const d=require(process.argv[1]);console.log(d.summary);const f=d.checks.filter(c=>['ffmpeg','ffprobe','node'].includes(c.name)&&!c.ok);if(f.length){console.error(f);process.exit(1)}" "$work/doctor.json"

echo "uninstall.sh:"
"$work/ScreenPilot/uninstall.sh" --clients codex,opencode </dev/null
node "$root/scripts/ci/assert-registered.mjs" "$home" absent
echo "Linux installer test passed"
