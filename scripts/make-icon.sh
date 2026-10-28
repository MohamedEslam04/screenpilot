#!/usr/bin/env bash
# Regenerates assets/icon.png (512x512, transparent) from assets/logo/screenpilot.svg.
# Needs inkscape and ImageMagick. Run: bash scripts/make-icon.sh
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
inkscape assets/logo/screenpilot.svg -w 456 -h 456 -o "$tmp/icon.png"
magick "$tmp/icon.png" -background none -gravity center -extent 512x512 assets/icon.png
echo assets/icon.png
