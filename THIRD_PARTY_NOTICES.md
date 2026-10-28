# Third-party notices

ScreenPilot itself is MIT licensed (see [LICENSE](LICENSE)). It uses the software below. The release packages also bundle Node.js and static ffmpeg/ffprobe builds.

## Runtime dependencies

| Package | License |
|---|---|
| @modelcontextprotocol/sdk | MIT |
| commander | MIT |
| dbus-next | MIT |
| gsap | [GSAP Standard "no charge" license](https://gsap.com/standard-license) |
| hyperframes | Apache-2.0 |
| jsonc-parser | MIT |
| koffi | MIT |
| msedge-tts | MIT |
| obs-websocket-js | MIT |
| playwright-core | Apache-2.0 |
| uiohook-napi | MIT |
| yaml | ISC |
| zod | MIT |

Their own dependencies (about 280 more packages) are almost all MIT, ISC, BSD or Apache-2.0. Run `pnpm licenses list --prod` for the full list.

Two are not permissive:

- **GSAP** is free to use, including commercially, under its own license. It is not open source. Read it at https://gsap.com/standard-license before you redistribute it or build on it. ScreenPilot copies `gsap.min.js` into each video project it renders.
- **libvips** (`@img/sharp-libvips-*`, pulled in by `sharp` through `hyperframes`) is LGPL-3.0-or-later. It ships as a separate shared library that you can replace.

## Bundled in the release packages

- **Node.js**: MIT license, https://github.com/nodejs/node/blob/main/LICENSE
- **ffmpeg and ffprobe**: static builds, https://ffmpeg.org. Their license is LGPL-2.1-or-later or GPL-2.0-or-later (some builds GPL-3.0), depending on the build. Source code and license text: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html

Chrome, Edge, Brave, OBS Studio and GStreamer are not bundled: ScreenPilot uses the ones already on your computer.
