# The README demo video

Made with ScreenPilot from Claude Code through its MCP tools:

1. `site/index.html` is a small product page. The take opens it as `"url": "site/index.html"` (relative to the take, so it runs from any checkout) in an app window (`"app": true`: no address bar or tabs, so nothing about the machine shows).
2. `take.json` is what the agent performed: it scrolls, clicks the install tabs and plays a sample video, with bilingual captions (`"English\nعربي"`). `perform` drove the real mouse while recording that one monitor, with the camera following the browser window.
3. `perform` wrote a storyboard (zooms from the clicks, the captions, the window view). The agent then added the intro/outro and chose a look for a GitHub README audience, matching the page's colors: `storyboard.json` → `theme` (background glows, Tajawal for Arabic, glass captions via `theme.css`, and `theme.motion`: captions reveal line by line, the intro and outro word by word).
4. `screenpilot render storyboard.json -q delivery` → `screenpilot-demo.mp4`; the GIF is a 12 fps preview for the README.

The page's sample video was made the same way from `sample/take.json`, with a deliberately different look (light, orange, 720p, word-by-word pop captions): see `sample/storyboard.json`.

To redo it on your machine, point the take's `screens`/`browser.screen` at one of your monitors (`screenpilot doctor` lists them).
