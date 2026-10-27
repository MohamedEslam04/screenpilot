#!/usr/bin/env bash
# Adds ScreenPilot to every AI tool on this computer.
# Usage: ./install.sh [--output <videos folder>] [--clients codex,opencode,...]
# Works when double-clicked in a file manager too (it opens a terminal to show the result).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Double-click from a file manager: no terminal attached, so open one --------------------
if [ -z "${SCREENPILOT_IN_TERMINAL:-}" ] && [ -z "${SCREENPILOT_NO_TERMINAL:-}" ] &&
  [ ! -t 0 ] && [ ! -t 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  export SCREENPILOT_IN_TERMINAL=1
  for term in x-terminal-emulator konsole gnome-terminal xfce4-terminal kitty alacritty; do
    command -v "$term" >/dev/null 2>&1 || continue
    case "$term" in
      gnome-terminal) "$term" -- bash "$DIR/install.sh" "$@" && exit 0 ;;
      xfce4-terminal) "$term" -x bash "$DIR/install.sh" "$@" && exit 0 ;;
      kitty) "$term" bash "$DIR/install.sh" "$@" && exit 0 ;;
      *) "$term" -e bash "$DIR/install.sh" "$@" && exit 0 ;;
    esac
  done
  unset SCREENPILOT_IN_TERMINAL # no terminal worked: carry on without one
fi

finish() {
  if [ -n "${SCREENPILOT_IN_TERMINAL:-}" ]; then
    printf '\nPress Enter to close '
    read -r _ || true
  fi
  exit "${1:-0}"
}

# --- Native screen recording needs GStreamer with PipeWire and an H.264 encoder ------------
missing_recording_bits() {
  local gaps=()
  if ! command -v gst-launch-1.0 >/dev/null 2>&1 || ! command -v gst-inspect-1.0 >/dev/null 2>&1; then
    gaps+=("gst-launch-1.0")
  else
    gst-inspect-1.0 pipewiresrc >/dev/null 2>&1 || gaps+=("pipewiresrc")
    if ! gst-inspect-1.0 openh264enc >/dev/null 2>&1 && ! gst-inspect-1.0 x264enc >/dev/null 2>&1; then
      gaps+=("an H.264 encoder (openh264enc or x264enc)")
    fi
  fi
  printf '%s\n' "${gaps[@]+"${gaps[@]}"}"
}

install_command() {
  local id="" like="" fam=""
  if [ -r /etc/os-release ]; then
    id="$(. /etc/os-release && echo "${ID:-}")"
    like="$(. /etc/os-release && echo "${ID_LIKE:-}")"
  fi
  for w in $id $like; do
    case "$w" in
      fedora | rhel | centos | rocky | almalinux) fam=fedora ;;
      debian | ubuntu | linuxmint | pop) fam=debian ;;
      arch | manjaro | endeavouros) fam=arch ;;
      opensuse* | suse | sles) fam=suse ;;
    esac
    [ -n "$fam" ] && break
  done
  case "$fam" in
    fedora) echo "sudo dnf install -y gstreamer1 pipewire-gstreamer gstreamer1-plugin-openh264" ;;
    debian) echo "sudo apt install -y gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-ugly" ;;
    arch) echo "sudo pacman -S --needed gstreamer gst-plugin-pipewire gst-plugins-ugly" ;;
    suse) echo "sudo zypper install gstreamer gstreamer-plugin-pipewire gstreamer-plugins-ugly" ;;
    *) echo "" ;;
  esac
}

gaps="$(missing_recording_bits)"
if [ -n "$gaps" ]; then
  echo "Built-in screen recording needs a few system packages that are missing:"
  # shellcheck disable=SC2001
  echo "$gaps" | sed 's/^/  - /'
  cmd="$(install_command)"
  if [ -n "$cmd" ]; then
    echo
    echo "To add them, run:"
    echo "  $cmd"
    if [ -t 0 ]; then
      printf 'Run it now? [y/N] '
      read -r answer || answer=""
      case "$answer" in
        [yY]*)
          if bash -c "$cmd"; then
            gaps="$(missing_recording_bits)"
            [ -z "$gaps" ] && echo "Recording support is ready." || echo "Still missing after install: $(echo "$gaps" | tr '\n' ',' | sed 's/,$//')"
          else
            echo "That did not work; you can run the command yourself later."
          fi
          ;;
        *) echo "Skipped. You can run the command yourself later." ;;
      esac
    fi
  else
    echo "Install GStreamer (gst-launch-1.0) with its PipeWire plugin and an H.264 encoder (x264 or openh264) using your distro's package manager."
  fi
  echo "This is optional: recording through OBS and editing existing videos work without it."
  echo
fi

# --- Register with the AI tools ---------------------------------------------------------------
"$DIR/bin/node" "$DIR/dist/cli.js" setup "$@" >/dev/null
code=$?
if [ "$code" -ne 0 ]; then
  echo "Setup did not finish (see the message above). Close your AI apps and try again." >&2
fi
finish "$code"
