# ScreenPilot logo

The mark is a play button drawn as a small network: nodes at its corners joined by links, with a bright node in the middle. A video, made by a model.

| File | Use |
|---|---|
| `screenpilot.svg` | The app icon: the mark on a navy tile. Installer, MCP bundle, social avatar. |
| `screenpilot-on-dark.svg` | The mark alone, for dark backgrounds. |
| `screenpilot-on-light.svg` | The mark alone, for light backgrounds. |
| `favicon.svg` | A bolder version for 16 to 32 px. The full mark gets muddy that small. |
| `alternatives/` | Other directions we liked and kept in case the logo changes: `hub.svg` (one play button, every AI app around it), `p-play.svg` (a P whose bowl is a play button, works in one colour), `playhead.svg` (an editing timeline). |

Colours: navy `#0B132B`, teal `#5EEAD4` (on light backgrounds `#0F766E`), white for the centre node.

`assets/icon.png` (512 px, used by the installer and the MCP bundle) is generated from `screenpilot.svg`: run `bash scripts/make-icon.sh` (needs inkscape and ImageMagick).

Keep clear space around the mark of at least half a node's width, don't recolour it, and use `favicon.svg` below 32 px.
