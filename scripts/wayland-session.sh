#!/usr/bin/env bash
# Headless sway + PipeWire + xdg-desktop-portal(-wlr) for the Wayland smoke test.
# Usage: scripts/wayland-session.sh <command...>
# Starts its own session bus and runs <command> inside it, then tears everything down.
#
# Two virtual outputs of different sizes: HEADLESS-1 1280x720 at 0,0 and
# HEADLESS-2 1024x768 at 1280,0. xdg-desktop-portal-wlr shares one output
# (chooser_type=none, no dialog): XDPW_OUTPUT, default HEADLESS-1.
set -euo pipefail
if [ -n "${WAYLAND_TRACE:-}" ]; then
  exec 2>>/tmp/trace.log
  set -x
fi

if [ -z "${SCREENPILOT_WAYLAND_SESSION:-}" ]; then
  export SCREENPILOT_WAYLAND_SESSION=1
  exec dbus-run-session -- "$0" "$@"
fi

LOGS="${WAYLAND_LOGS:-$PWD/wayland-smoke-report/logs}"
mkdir -p "$LOGS"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"
export XDG_CURRENT_DESKTOP=sway
export XDG_SESSION_TYPE=wayland
export XDG_SESSION_DESKTOP=sway
export HOME="${HOME:-/root}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
unset DISPLAY

PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

wait_for() { # <description> <timeout s> <command...>
  local what=$1 secs=$2
  shift 2
  for _ in $(seq $((secs * 10))); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "timed out waiting for $what" >&2
  return 1
}

# PipeWire + WirePlumber (no sound card needed; the video graph is what matters).
pipewire >"$LOGS/pipewire.log" 2>&1 &
PIDS+=($!)
wait_for "pipewire socket" 15 test -S "$XDG_RUNTIME_DIR/pipewire-0"
wireplumber >"$LOGS/wireplumber.log" 2>&1 &
PIDS+=($!)

# Headless sway.
mkdir -p "$XDG_CONFIG_HOME/sway"
cat >"$XDG_CONFIG_HOME/sway/config" <<'EOF'
# Intentionally empty: outputs are created over IPC by wayland-session.sh.
EOF
export WLR_BACKENDS=headless
export WLR_LIBINPUT_NO_DEVICES=1
# xdg-desktop-portal-wlr <= 0.7.1 refuses a compositor that offers no dmabuf screencopy format,
# and that needs a GLES2 renderer on a DRM render node (pixman only has shared memory).
# vkms (virtual KMS) has only a card node, which wlroots can render on when told so.
VKMS_CARD=""
for d in /sys/class/drm/card[0-9]*; do
  case "$(readlink -f "$d")" in
    */vkms/*) VKMS_CARD="/dev/dri/$(basename "$d")" ;;
  esac
done
if ls /dev/dri/renderD* >/dev/null 2>&1; then
  export WLR_RENDERER="${WLR_RENDERER:-gles2}"
  export WLR_RENDERER_ALLOW_SOFTWARE=1
elif [ -n "$VKMS_CARD" ]; then
  echo "using vkms $VKMS_CARD for the sway renderer" >&2
  export WLR_RENDERER="${WLR_RENDERER:-gles2}"
  export WLR_RENDERER_ALLOW_SOFTWARE=1
  export WLR_RENDER_DRM_DEVICE="$VKMS_CARD"
else
  export WLR_RENDERER="${WLR_RENDERER:-pixman}"
fi
sway --unsupported-gpu -c "$XDG_CONFIG_HOME/sway/config" >"$LOGS/sway.log" 2>&1 &
PIDS+=($!)
wait_for "sway socket" 20 bash -c 'ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock'
SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock | head -1)
export SWAYSOCK
WAYLAND_DISPLAY=$(cd "$XDG_RUNTIME_DIR" && ls wayland-* | grep -v '\.lock$' | head -1)
export WAYLAND_DISPLAY

swaymsg create_output >/dev/null
swaymsg output HEADLESS-1 mode 1280x720 position 0 0 >/dev/null
swaymsg output HEADLESS-2 mode 1024x768 position 1280 0 >/dev/null
swaymsg -t get_outputs -r >"$LOGS/outputs.json"

# Share HEADLESS-1 without any chooser dialog.
mkdir -p "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr" "$XDG_CONFIG_HOME/xdg-desktop-portal"
cat >"$XDG_CONFIG_HOME/xdg-desktop-portal-wlr/config" <<EOF
[screencast]
chooser_type=none
output_name=${XDPW_OUTPUT:-HEADLESS-1}
max_fps=30
EOF
cat >"$XDG_CONFIG_HOME/xdg-desktop-portal/portals.conf" <<'EOF'
[preferred]
default=wlr
EOF
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_RUNTIME_DIR SWAYSOCK 2>/dev/null || true

XDPW="${XDPW_BIN:-$(ls /usr/libexec/xdg-desktop-portal-wlr /usr/lib/xdg-desktop-portal-wlr 2>/dev/null | head -1 || true)}"
WAYLAND_DEBUG="${XDPW_WAYLAND_DEBUG:-}" "$XDPW" -l DEBUG -r -c "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr/config" >"$LOGS/xdpw.log" 2>&1 &
PIDS+=($!)
wait_for "xdpw on the bus" 15 busctl --user status org.freedesktop.impl.portal.desktop.wlr
XDP=$(ls /usr/libexec/xdg-desktop-portal /usr/lib/xdg-desktop-portal 2>/dev/null | head -1 || true)
"$XDP" -r >"$LOGS/xdg-desktop-portal.log" 2>&1 &
PIDS+=($!)
wait_for "xdg-desktop-portal on the bus" 15 busctl --user status org.freedesktop.portal.Desktop

echo "session ready: WAYLAND_DISPLAY=$WAYLAND_DISPLAY SWAYSOCK=$SWAYSOCK" >&2
"$@"
