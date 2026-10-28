# screenpilot: agent guide

Turn a screen recording of any desktop app into a polished demo MP4. You write `storyboard.json` (cuts, zooms, captions, highlights, voiceover); screenpilot renders it with HyperFrames and a text-to-speech voice (Edge by default; local models or a user-defined command are optional). Run the CLI as `screenpilot` (or `node dist/cli.js`). An MCP server (`dist/mcp.js`) exposes the same steps as tools; see CONTRIBUTING.md. Claude Code users also get `skill/SKILL.md` with a longer walkthrough and a full storyboard example.

## Rules

- Storyboard times are SOURCE seconds (the raw recording). Positions are normalized 0..1 (x from left, y from top). Only `check` uses output seconds.
- Paths inside a storyboard are relative to the storyboard file.
- Narration never overlaps: render auto-freezes the video when a line overruns. Keep lines short.
- Iterate with `-q draft`; use `-q delivery` only for the final render.
- Voice providers: `"voice": {"provider": "local", "name": "voicetut:Sarah", "rate": "+0%"}` (default provider is `edge`). `local` names are `voicetut`, `voicetut:<Voice>` (Egyptian Arabic and English) and `namaa` (Egyptian Arabic only); a line's own `voice` overrides the name, and each line's language is detected. Run `screenpilot voices --provider local` and `screenpilot doctor` ("local voice") to see what is installed. If the user wants free offline voices and none is installed, tell them to run `screenpilot voice-setup voicetut` in a terminal (about 10 GB download); never start it yourself. `command` voices (`"provider": "command"`, `name` = a key in the user's `voices.json`) are defined by the user; you cannot add commands from a storyboard. Details: https://mohamedeslam04.github.io/screenpilot/guide/voices.html

## Workflow

1. Record (or use an existing video): `screenpilot record` -> session dir with video, `events.jsonl` and `windows.jsonl`. Records natively by default (Wayland: portal PipeWire + GStreamer; X11, Windows and macOS: ffmpeg); `--recorder obs` uses OBS instead. `screenpilot doctor` checks the setup.
   `--fit-window <class or title>` resizes that window to 16:9 for the recording (restored after) so window framing shows it whole.
   If `record` warns it assumed which monitor OBS records and that was wrong: `screenpilot remap <session> --screen <name>` (names in meta.json `screens`).
2. Analyze: `screenpilot analyze <session-dir|video>` -> idle spans, clicks, suggested segments/zooms, contact sheet image. View the contact sheet.
3. Look closer: `screenpilot frames <video> --at 1,4.5,10 --grid`. The grid shows 0..1 coordinates; read zoom/highlight/callout positions from it. View the images.
4. Start: `screenpilot init <session-dir|video> --suggest [--voice ar-EG-SalmaNeural]` (`--suggest` pre-fills idle cuts and click zooms). Schema: `screenpilot schema`. Voices: `screenpilot voices --lang ar-EG` (Edge), `screenpilot voices --provider local` (installed local models), `--provider command` (voices the user defined). `init` also takes `--provider local --voice voicetut:Sarah`.
5. Edit `storyboard.json`: `segments` (keep parts, `speed` to fast-forward; optional `volume`/`mute` of source audio), `holds`, `zooms` (at, dur, x, y, scale), `captions` (style pill/title/callout; callout needs x,y), `highlights` (x,y,w,h), `narration` (at, text, optional per-line `voice`), `intro`/`outro`, `cards` (chapter card at a source time, freezes the video), `overlays` (logo/image/video on the output frame, 0..1), `music` (`duck` lowers it under narration), `extends` (inherit theme/voice/output/music from a base storyboard so clips match).
6. Validate: `screenpilot validate storyboard.json`.
7. Draft: `screenpilot render storyboard.json -q draft`.
8. Review: `screenpilot check storyboard.mp4 --at 2,8,15` (output seconds) and view the frames. Fix and repeat 5-8.
9. Final: `screenpilot render storyboard.json -q delivery -o demo.mp4`.

`screenpilot build` prepares everything without rendering; `screenpilot preview` opens HyperFrames Studio.

## Combine recordings (insert a feature clip without re-recording)

A storyboard has one `source`. To put another recording in the middle, write `sequence.json` and run `screenpilot sequence sequence.json -q draft` (MCP `sequence_render`; `sequence-validate`, `sequence-schema`). Each part is a full storyboard (own source, zooms, narration), rendered alone and joined:

```json
{ "version": 1, "parts": [
  { "storyboard": "demo.json", "to": 42 },
  { "storyboard": "feature.json", "transition": { "type": "crossfade", "dur": 0.5 } },
  { "storyboard": "demo.json", "from": 42 } ] }
```

- `from`/`to` are SOURCE seconds of that part's storyboard, half-open `[from, to)`: the same storyboard twice with `to: 42` and `from: 42` keeps every item once. Narration that started before `from` is dropped.
- Intro only on the first part, outro only on the last; every part is forced to one output size. Give every storyboard the same `extends` base so the look matches.
- Transitions (how a part enters from the previous): cut, crossfade, fade-black, wipe-left, wipe-right, slide-left, slide-right; `dur` is clamped to half of either neighbour.
- Review fast: `render ... --from 12 --to 20` (OUTPUT seconds) renders only that window. Other sizes: `render ... --formats 16:9,9:16,1:1`.
- `validate` also warns about style (long narration/captions, overlapping or stacked effects, duration over 90s or under 15s).

## Agent drives the desktop (KDE Wayland, X11, GNOME Wayland, Windows)

Instead of asking the user to perform the demo, you can perform it. Loop: explore, rehearse, perform, review, render. `screenpilot doctor` says what the desktop supports: on GNOME/other Wayland there is no window control (use only `{screen, x, y}` targets; no `focus`, `waitForWindow`, `{window}` or `{web}`), and wlroots (sway, Hyprland) cannot be driven at all (recording works).

1. Explore: `screenshot --grid` (MCP `screenshot`) and `windows`; `browser --url ...` for web apps. Act with `drive` (MCP `click`, `type_text`, ...), screenshot after each action to verify.
2. Write `take.json` (`screenpilot take-schema`, or MCP `take_schema`). Use `{web: selector}` targets inside the demo browser; they are exact.
3. Rehearse: `screenpilot perform take.json --dry-run`. Fix the failing step (errors name the step) and repeat until clean.
4. Perform: `screenpilot perform take.json` -> session dir with video, events and a starter `storyboard.json`.
5. Review the storyboard (`analyze`, `frames --grid`), refine, `validate`, render `-q draft`, `check`, then `-q delivery`.

The real mouse and keyboard are used: tell the user to keep their hands off (touching the mouse aborts). Secrets: `{"type": {"env": "VAR"}}`, never literal text.

```json
{
  "name": "Submit a support ticket",
  "screens": "all",
  "voice": { "name": "en-US-AndrewNeural", "rate": "+0%" },
  "setup": [{ "browser": { "screen": "HDMI-A-1", "url": "https://app.example.com/support" } }],
  "steps": [
    { "view": "HDMI-A-1" },
    { "say": "Let's open a support ticket.", "wait": true },
    { "wait": 0.6 },
    { "click": { "web": "input[name=subject]" } },
    { "type": "Cannot export my report" },
    { "click": { "web": "textarea[name=body]" } },
    { "type": "The export button spins forever on large reports." },
    { "caption": "Describe the problem", "dur": 3 },
    { "say": "Then we send it.", "wait": true },
    { "click": { "web": "text=Submit" } },
    { "waitFor": { "web": "text=Download receipt", "timeout": 20 } },
    { "click": { "web": "text=Download receipt" } },
    { "wait": 1.5 },
    { "run": ["xdg-open", "~/Downloads/receipt.pdf"] },
    { "waitForWindow": { "match": "receipt", "timeout": 15 } },
    { "view": "eDP-1" },
    { "focus": { "match": "receipt", "screen": "eDP-1" } },
    { "say": "ورقة التأكيد وصلت وبتتفتح على طول.", "voice": "ar-EG-SalmaNeural", "wait": true },
    { "scroll": 3, "at": { "screen": "eDP-1", "x": 0.5, "y": 0.5 } }
  ],
  "tail": 1.5
}
```

On macOS, shortcuts use `cmd` (`cmd+l`, `cmd+c`), not `ctrl`, and the AI app needs Accessibility and Screen Recording permission (errors name the app and the settings pane).

Take tips: put `say` with `wait: true` before an important click so the viewer hears it first; keep 0.3-1 s `wait`s after navigation; use `waitFor` instead of long waits; keep takes under ~90 s. `say` lines default to `voice.name`; override per line with `voice`.

## Style

- Narration: one sentence, under ~12 words, one idea.
- Zoom on what is about to be clicked (start ~0.5s before, 2-4s, scale 1.6-2.2).
- Cut or speed up (4-8x) idle time, loading and mistakes.
- Captions: 2-6 words, one idea each. Do not stack zoom + highlight + callout on one click.
- Target 30-90s total.

## Dev notes

- Package manager: pnpm. Node 22+. ESM TypeScript with `.js` import suffixes, 2-space indent, double quotes.
- `pnpm test` (vitest), `pnpm typecheck`, `pnpm build` (tsc to `dist/`), `pnpm dev <args>` runs the CLI from source.
- Keep ALL dependencies on latest: `pnpm deps:latest`.
- HyperFrames telemetry is disabled through env vars in `src/render/index.ts` (`hyperframesEnv()`); keep it that way for every HyperFrames subprocess.
- The MCP server must never write to stdout except protocol messages; log to stderr.
- Renaming the project: the name lives only in `src/brand.ts` (`APP`). Change it, add the old name to `PREVIOUS_NAMES` (users' config folder is moved over on first run), then update `package.json` (`name`, `bin`), the docs, and rename the GitHub repo.
- Combining recordings lives in `src/sequence/` (schema, ffmpeg concat/xfade, per-part build dirs `<seq>.build/part-<i>/` with a cache key); `src/storyboard/clip.ts` slices a storyboard by source range; `extends` resolves in `loadStoryboard`. Partial render (`src/render/window.ts`) shifts the RenderPlan, so any new plan field with times must be handled there too. Multi-format is `src/render/formats.ts`.
- Platforms: everything OS-specific is behind `src/platform` (`Desktop`, `Injector`, `Watcher`), picked by `detect.ts` (override: `SCREENPILOT_DESKTOP=kde|x11|portal|windows|macos`, name in `src/brand.ts`): `kde.ts` (portal + KWin), `x11/` (libX11/XRandR/XTest via koffi, EWMH), `wayland.ts` (generic xdg-portal desktop: GNOME, wlroots; monitors from Mutter DisplayConfig / swaymsg / hyprctl / portal streams), shared portal code in `portal.ts`, `windows/` (Win32 via koffi) and `macos/` (Quartz + Accessibility API via koffi, JXA for NSScreen names). Recording backends are in `src/record/backends` (native: portal PipeWire/GStreamer `pipewire.ts`, ffmpeg x11grab / gdigrab / avfoundation; or OBS).
- macOS coordinates are points (Quartz global space), never pixels; only the avfoundation recorder and screenshots deal with Retina pixels (`src/platform/macos/geometry.ts` explains). Permission errors name the host app (`src/platform/macos/permissions.ts`). Verified in CI by `pnpm smoke:macos` (`.github/workflows/macos.yml`); checks blocked by missing permissions are reported, not failed.
- End users are not developers: they get a release package and run `screenpilot setup` (`src/setup`). It registers the server with every AI client it finds (`src/setup/clients.ts`: one entry per client with its config path and format). Config edits must keep the user's comments and other entries (jsonc-parser for JSON, a table rewrite for Codex TOML), and the file is backed up first. Test setup only with a fake `HOME`/`APPDATA`, never against real configs. Adding a client = one `CLIENTS` entry + a test. The MCP server's `instructions` (in `src/mcp.ts`) carry the workflow for clients without the skill.
- X11 is verified in CI by `pnpm smoke:x11` under Xvfb + openbox (`.github/workflows/ci.yml`; locally only on a throwaway X display, it drives XTest). Windows is verified in CI by `pnpm smoke:windows` on a real runner; on a real PC run `pnpm windows:live` (doctor, smoke, a narrated take across monitors + render into `windows-live-report/`). `screenpilot doctor [--input]` checks any machine.
- The website (GitHub Pages, "Deploy from a branch", `main`, `/docs`) is generated: edit `site/` (`landing.mjs` for the home page in both languages, `content/<en|ar>/*.html` for the docs, `static/` for CSS and JS; format in `site/CONTENT_SPEC.md`), then run `node site/build.mjs`, which rewrites `docs/` and checks every internal link. No CI step builds it, so commit `docs/` with the change. Media under `docs/media` is exempt from Git LFS (Pages cannot serve LFS files).
