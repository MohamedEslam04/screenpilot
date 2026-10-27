# The README demo video

Made with ScreenPilot from Claude Code through its MCP tools:

1. `site/index.html` is a small product page; `browser_open` put it in the demo browser on the external monitor.
2. `take.json` is what the agent performed: it scrolls, clicks the install tabs and plays a sample video, with bilingual captions (`"English\nعربي"`). `perform` drove the real mouse while recording that one monitor, with the camera following the browser window.
3. `perform` wrote a storyboard (zooms from the clicks, the captions, the window view). The agent then added the intro/outro and chose a look for a GitHub README audience, matching the page's colors: `storyboard.json` → `theme` (background glows, Tajawal for Arabic, glass captions via `theme.css`).
4. `screenpilot render storyboard.json -q delivery` → `screenpilot-demo.mp4`; the GIF is a 12 fps preview for the README.

To redo it on your machine, point the take's `screens`/`browser.screen` at one of your monitors (`screenpilot doctor` lists them).
