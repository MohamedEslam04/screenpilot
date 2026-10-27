#!/bin/sh
# Stand-in for ffmpeg in tests: gdigrab only exists on Windows, so record a
# test pattern with the same stats/stdin behaviour into the requested file.
for last; do :; done
if [ "$2" = "-version" ]; then exec ffmpeg -hide_banner -version; fi
exec ffmpeg -hide_banner -f lavfi -i testsrc=size=320x240:rate=30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -stats -stats_period 0.1 -y "$last"
