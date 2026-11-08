# screenpilot: agent guide

Turn a screen recording of any desktop app into a polished demo MP4. You write `storyboard.json` (cuts, zooms, captions, highlights, voiceover); screenpilot renders it with HyperFrames and a text-to-speech voice (Edge by default; local models or a user-defined command are optional). Run the CLI as `screenpilot` (or `node dist/cli.js`). An MCP server (`dist/mcp.js`) exposes the same steps as tools; see CONTRIBUTING.md. Claude Code users also get `skill/SKILL.md` with a longer walkthrough and a full storyboard example.

## Before you start: ask the user

Do not record, drive the desktop, build or render before the user has made the decisions only they can make: the goal and audience, where the recording comes from, the language, **which voice** (built-in, a website's voice such as Google AI Studio, their own program or recording, or none), the look, the camera, how they want to review it, and whether you may record and drive their mouse. Never answer for them and never install anything for them.

- MCP: call `brief` first. Its recommendations follow the existing video in the folder (its voice files, language, size), then the user's usual choices (remembered after every confirmed brief; the content is never saved). First ask ONE question: use the recommended setup shown in `shortcut` (a form shows it too), or choose each item? Only after the user says yes, call `brief` again with `use_recommended: true`; never on your own. To choose each item the user picks right in a form, or you show the option pickers (2 to 4 options each, recommended first) with your question tool exactly as given, ask the free-text one in chat, then call `brief` again with `answers`. The content question is optional. `brief` takes `project` (folder or storyboard.json to follow). `record_start`, `perform`, `render` and `sequence_render` refuse until it is done. It returns what to do next for the answers.
- CLI only: run `screenpilot brief [--project <path>]`. Offer `recommendedSetup` first as one question (use it, or choose each item), then ask the questions it lists the same way (at most 4 at a time; a question with `askWhen` only after its parent has that answer; the content one is optional), then continue.
- Skip a question only when the user already answered it in their request, and pass that answer. Unattended runs set `SCREENPILOT_SKIP_BRIEF=1`.

## Rules

- Storyboard times are SOURCE seconds (the raw recording). Positions are normalized 0..1 (x from left, y from top). Only `check` uses output seconds.
- Paths inside a storyboard are relative to the storyboard file.
- Narration never overlaps: render auto-freezes the video when a line overruns. Keep lines short.
- Iterate with `-q draft`; use `-q delivery` only for the final render.
- Voice providers: `"voice": {"provider": "local", "name": "voicetut:Sarah", "rate": "+0%"}` (default provider is `edge`). `local` names are `voicetut`, `voicetut:<Voice>` (Egyptian Arabic and English) and `namaa` (Egyptian Arabic only); a line's own `voice` overrides the name, and each line's language is detected. Run `screenpilot voices --provider local` and `screenpilot doctor` ("local voice") to see what is installed. If the user wants free offline voices and none is installed, tell them to run `screenpilot voice-setup voicetut` in a terminal (about 10 GB download); never start it yourself. `command` voices (`"provider": "command"`, `name` = a key in the user's `voices.json`) are defined by the user; you cannot add commands from a storyboard; a command entry may list `cacheFiles` (clips or models it reads) so cached lines are remade when those files change. A dry run (`perform --dry-run`) does not synthesize: line lengths are estimated. Details: https://mohamedeslam04.github.io/screenpilot/guide/voices.html
- Better voice from a website (free web TTS): `screenpilot script storyboard.json` (MCP `script_export`) writes the text to paste (one paragraph per line, no numbers); the user generates ONE audio file and gives it back; `screenpilot split-audio voice.mp3 --storyboard storyboard.json` (MCP `audio_import`) cuts it at the pauses and sets `narration[].audio` (path relative to the storyboard; the line then plays that file, `text` stays the subtitle). Too few pauses: ask for a longer pause between lines or pass `--min-silence`. Free plans have limits and may forbid commercial use; say so.

- Updates: `update_check` (MCP) or `screenpilot update --check` says whether a newer release exists and returns the command to run. Tell the user the command and let THEM run it in a terminal (never run `screenpilot update` yourself: it replaces installed code from the internet), then restart their AI apps. A small update only replaces the app files; if the dependencies or Node changed, or the install predates 0.6, it says to download the full package.

## Workflow

1. Record (or use an existing video): `screenpilot record` -> session dir with video, `events.jsonl` and `windows.jsonl`. Records natively by default (Wayland: portal PipeWire + GStreamer; X11, Windows and macOS: ffmpeg); `--recorder obs` uses OBS instead. `screenpilot doctor` checks the setup.
   `--fit-window <class or title>` resizes that window to 16:9 for the recording (restored after) so window framing shows it whole.
   If `record` warns it assumed which monitor OBS records and that was wrong: `screenpilot remap <session> --screen <name>` (names in meta.json `screens`).
2. Analyze: `screenpilot analyze <session-dir|video>` -> idle spans, clicks, suggested segments/zooms, contact sheet image. View the contact sheet.
3. Look closer: `screenpilot frames <video> --at 1,4.5,10 --grid`. The grid shows 0..1 coordinates; read zoom/highlight/callout positions from it. View the images.
4. Start: `screenpilot init <session-dir|video> --suggest [--voice ar-EG-SalmaNeural]` (`--suggest` pre-fills idle cuts and click zooms). Schema: `screenpilot schema`. Voices: `screenpilot voices --lang ar-EG` (Edge), `screenpilot voices --provider local` (installed local models), `--provider command` (voices the user defined). `init` also takes `--provider local --voice voicetut:Sarah`.
5. Edit `storyboard.json`: `segments` (keep parts, `speed` to fast-forward and `speedTo` to ramp it; `transition: {type, dur}` blends into a segment: crossfade, fade-black, fade-white, wipe-left/right, slide-left/right, and shortens the video by `dur`; optional `volume`/`mute` of source audio), `holds`, `zooms` (at, dur, x, y, scale), `captions` (style pill/title/callout; callout needs x,y), `highlights` (x,y,w,h), `annotations` (`arrow` from/to, `box` x,y,w,h, `blur` x,y,w,h with `mode: "solid"` for anything secret; positions 0..1 of the recording), `narration` (at, text, optional per-line `voice`), `intro`/`outro`, `cards` (chapter card at a source time, freezes the video), `overlays` (logo/image/video on the output frame, 0..1), `theme.grade` (color grade of the recording: brightness, contrast, saturation, gamma), `music` (`duck` lowers it under narration or overlays; `fadeIn`/`fadeOut`, `loop`, `offset`, `from`/`to`), `audio` (`loudness: {}` normalizes the final mix to -16 LUFS; `denoise` cleans the recording's sound), `sfx` (sound effects at source times, `builtin:click|key|whoosh|pop|ding` or a file) and `sounds` (automatic click/typing/card sounds; clicks need `events`) with `typing` spans (`{at, dur, text?, keycaps?}`: keys are never recorded, `perform` marks its own `type` steps), `extends` (inherit theme/voice/output/music/lint from a base storyboard so clips match).
6. Validate: `screenpilot validate storyboard.json`. Then `screenpilot qa storyboard.json` (MCP `storyboard_qa`; needs ffmpeg) looks at the pixels: `[empty-highlight]` = a highlight frames a flat area (element gone or hidden), `[view-outside-window]` = a view shows over 8% outside the active window (reads `windows.jsonl` next to the source). Fix or accept each warning before the delivery render.
7. Draft: `screenpilot render storyboard.json -q draft`.
8. Review: `screenpilot check storyboard.mp4 --at 2,8,15` (output seconds) and view the frames. Fix and repeat 5-8.
9. Final: `screenpilot render storyboard.json -q delivery -o demo.mp4` (add `--subtitles srt,vtt` for caption files from the narration, `--also gif,webm,poster` for a GIF, WebM or poster PNG).

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
- `validate` also warns about style (long narration/captions, overlapping or stacked effects, duration over 90s or under 15s). Every warning starts with its rule id (`[narration-length]`, `[narration-speed]`, `[caption-length]`, `[duration]`, `[zoom-scale]`, `[stack]`, `[transition]`). For a long tutorial set `lint: {narrationWords, captionWords, duration: {min, max}, off: [ids]}` in the storyboard (or its `extends` base) instead of fixing every warning.

## Agent drives the desktop (KDE Wayland, X11, GNOME Wayland, Windows)

Instead of asking the user to perform the demo, you can perform it. Loop: explore, rehearse, perform, review, render. `screenpilot doctor` says what the desktop supports: on GNOME/other Wayland there is no window control (use only `{screen, x, y}` targets; no `focus`, `waitForWindow`, `{window}`, `{web}` or clicking `{a11y}` targets), and wlroots (sway, Hyprland) cannot be driven at all (recording works).

1. Explore: `screenshot --grid` (MCP `screenshot`) and `windows`; `browser --url ...` for web apps. Act with `drive` (MCP `click`, `type_text`, ...), screenshot after each action to verify.
2. Write `take.json` (`screenpilot take-schema`, or MCP `take_schema`). Use `{web: selector}` targets inside the demo browser; they are exact; if something covers the element (sticky header, modal, clipping scroll box) the step fails with `TARGET_COVERED` instead of clicking the wrong thing (`"force": true` on the click skips the check). For a native app use `{a11y: {role, name, app?, exact?, nth?}}` (see below).
3. Rehearse: `screenpilot perform take.json --dry-run`. Fix the failing step (errors name the step) and repeat until clean.
4. Perform: `screenpilot perform take.json` -> session dir with video, events and a starter `storyboard.json`. With `--dir x` a retake never collides: if `x` already holds a take, the new one goes to `x-2`, `x-3`, ... (the result's `dir` is the path used; `x-latest` is a symlink to it); `--overwrite` (MCP `overwrite`) instead moves the old take to `x.prev` and reuses `x`.
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

Typing: `type` has `method: "keys" | "paste" | "auto"` (default `auto`). Key-by-key injection drops letters in Arabic and other text outside Latin-1, so `auto` pastes those: it sets the clipboard, presses `ctrl+v` (`cmd+v` on macOS), waits 150 ms and restores the previous clipboard. `{env}` text is pasted the same way and is never left on the clipboard. Paste needs `wl-copy`/`wl-paste` (KDE, GNOME Wayland), `xclip` (X11), or the built-in tools on macOS and Windows; `doctor` warns when missing. A paste still marks a `typing` span.

Take tips: put `say` with `wait: true` before an important click so the viewer hears it first; keep 0.3-1 s `wait`s after navigation; use `waitFor` instead of long waits; keep takes under ~90 s. `say` lines default to `voice.name`; override per line with `voice`. Two windows with one title (two browsers)? `focus: {match}` takes the active one, else the first, and logs the count: use `{"focus": {"browser": true}}` for the demo browser (found by process id). A `{web}` target, and the `type`/`key` after it, bring the demo browser to the front first. `run` starts a program and carries on; add `wait: true` (optional `timeout` seconds, default 30, only with `wait`) to wait for it to exit: a non-zero exit code or a timeout fails the step and the program is killed (use it for `wl-copy` before `ctrl+v`).

## Native apps: `{a11y}` targets

`{a11y: {role?, name?, app?, exact?, nth?}}` (needs a role or a name) finds a control through the OS accessibility tree and resolves to its centre in global pixels; the real pointer then moves and clicks, so the recording keeps a visible cursor. It works wherever a target is accepted (click, move, drag, `scroll.at`) and as `waitFor: {a11y: {...}, timeout}`.

- Read first: MCP `a11y_tree` (role, name, states, rect; `interactiveOnly` default true) or `screenpilot a11y tree [--app X] [--all]`; check with MCP `a11y_find` or `screenpilot a11y find <role>:<name> [--app X] [--exact]`; click from the shell with `screenpilot drive click a11y:<role>:<name>`. MCP `wait_for` takes `a11y` too.
- Roles: aliases (`button`, `checkbox`, `radio`, `tab`, `textbox`, `menuitem`, `combobox`, `listitem`...) or AT-SPI names (`push button`, `menu item`, `entry`...). `name` is contains, case-insensitive (`exact: true` = whole name).
- Several matches is an error (`AMBIGUOUS_TARGET`, with the candidates): add `nth` (1-based) or a more specific name; it never guesses. Without `app` it looks in the focused window's app if the desktop can tell, else every app.
- Linux (AT-SPI) works on KDE Wayland and X11. On GNOME and wlroots Wayland the desktop gives no window position, so controls can be read (`a11y_tree`, `positionKnown: false`) but not clicked (`POSITION_UNKNOWN`): use `{screen, x, y}`. macOS uses the AX API (Accessibility permission; tested on a real macOS runner in CI). Windows uses UI Automation read by a short Windows PowerShell 5.1 script (no extra install; physical pixels; an app running as administrator cannot be read from a non-elevated process); verified by a diagnostic on a real Windows runner (the Paint smoke check passed on a real Windows runner: 21 nodes, `Close` button found with its centre inside the window, frame 14 px off the window list (shadow)); apps whose controls UI Automation exposes only as plain panes (classic Notepad's text area) show no control there: use `{window, x, y}` or `{screen, x, y}` for those. `A11Y_UNAVAILABLE` means the OS source failed (no accessibility bus, PowerShell missing).
- Qt apps only show up if launched with `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`; apps a take starts with `run`/`open` get it automatically (a Qt app that is already running must be restarted). Apps that draw their own UI (some Electron/GPU apps) expose little; Chromium needs `--force-renderer-accessibility` (the demo browser uses `{web}` instead).
- Target errors carry a code (`ELEMENT_NOT_FOUND`, `AMBIGUOUS_TARGET`, `APP_NOT_FOUND`, `WINDOW_NOT_FOUND`, `A11Y_UNAVAILABLE`, `POSITION_UNKNOWN`, `TARGET_COVERED`, `TIMEOUT`) and always `delivery: "not_delivered"`, `retry: "safe"` (no input was sent). MCP tool errors end with a JSON line `{code, delivery, retry}`; a failed `perform` returns code, delivery, retry and candidates next to `failedStep`.

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
- The HyperFrames extract cache is pointed at `cacheHome()/extract` (`src/brand.ts`) by `hyperframesEnv()` unless the user set `HYPERFRAMES_EXTRACT_CACHE_DIR`; `renderStoryboard` prunes it with `pruneCache` (`src/render/cache.ts`, cap `SCREENPILOT_RENDER_CACHE_GB`, default 4; entries touched in the last 10 minutes are never deleted). Sequence parts render through `renderStoryboard`, so they get both. `doctor` prints the cache dir and size.
- The MCP server must never write to stdout except protocol messages; log to stderr.
- Renaming the project: the name lives only in `src/brand.ts` (`APP`). Change it, add the old name to `PREVIOUS_NAMES` (users' config folder is moved over on first run), then update `package.json` (`name`, `bin`), the docs, and rename the GitHub repo.
- Accessibility targets live in `src/a11y/`: `locate.ts` (pure: roles, matching, placing trees in global pixels, no guessing), `atspi.ts` (Linux transport: raw D-Bus calls through dbus-next, because Qt apps do not answer introspection), `ax.ts` (macOS AX API), `uia.ts` (Windows UI Automation: PowerShell script + pure parser and role mapping), `index.ts` (orchestrator: `a11yTree`, `a11yFind`, `a11yWait`, `launchEnv`). Target errors are `TargetError` in `src/drive/errors.ts`. X11 was verified on a nested Xephyr display with no window manager (extents are global: a window moved to 200,150 gave the same offset for its controls; the EWMH window-match path was then exercised against a real window manager through KWin's Xwayland with an xcb Qt app, which found and fixed an offset of the window border and title bar when the window list reports the outer frame). macOS (AX API) is verified on a real GitHub Actions macOS runner by `pnpm smoke:macos` (`scripts/a11y-check.ts`: TextEdit tree readable, frame 0 px off the window list, one text area with its centre inside the window); the same smoke clicks the TextEdit text area through an `{a11y}` target with the real pointer, types a sentence and reads it back through the clipboard (passed on a runner). Windows is verified by a diagnostic run on a real Windows runner (the `pnpm smoke:windows` Paint check passed on a real Windows runner: 21 nodes, `Close` button found, frame 14 px off the window list, and a real pointer click on Paint's Maximize button through an `{a11y}` target resized the window from 805x607 to 1024x720): the PowerShell script runs, the window is found and placed, and controls are read with correct roles. For Paint the tree matches UI Automation's raw walker exactly (window frame, 14 panes, title bar, menu bar, menu item, Minimize/Maximize/Close buttons). The runner's Notepad is the classic Win32 one, whose edit area UI Automation itself exposes as a plain `Pane` (class `Edit`, no name; 2 panes in the control, content and raw views), so no text-area role exists there: a limit of that app, not of the source. The smoke check therefore uses Paint's `Close` button (centre inside the window, frame within 24 px of the window list).
- Combining recordings lives in `src/sequence/` (schema, ffmpeg concat/xfade, per-part build dirs `<seq>.build/part-<i>/` with a cache key); `src/storyboard/clip.ts` slices a storyboard by source range; `extends` resolves in `loadStoryboard`. Partial render (`src/render/window.ts`) shifts the RenderPlan, so any new plan field with times must be handled there too. Multi-format is `src/render/formats.ts`.
- Platforms: everything OS-specific is behind `src/platform` (`Desktop`, `Injector`, `Watcher`), picked by `detect.ts` (override: `SCREENPILOT_DESKTOP=kde|x11|portal|windows|macos`, name in `src/brand.ts`): `kde.ts` (portal + KWin), `x11/` (libX11/XRandR/XTest via koffi, EWMH), `wayland.ts` (generic xdg-portal desktop: GNOME, wlroots; monitors from Mutter DisplayConfig / swaymsg / hyprctl / portal streams), shared portal code in `portal.ts`, `windows/` (Win32 via koffi) and `macos/` (Quartz + Accessibility API via koffi, JXA for NSScreen names). Recording backends are in `src/record/backends` (native: portal PipeWire/GStreamer `pipewire.ts`, ffmpeg x11grab / gdigrab / avfoundation; or OBS).
- macOS coordinates are points (Quartz global space), never pixels; only the avfoundation recorder and screenshots deal with Retina pixels (`src/platform/macos/geometry.ts` explains). Permission errors name the host app (`src/platform/macos/permissions.ts`). Verified in CI by `pnpm smoke:macos` (`.github/workflows/macos.yml`); checks blocked by missing permissions are reported, not failed.
- End users are not developers: they get a release package and run `screenpilot setup` (`src/setup`). It registers the server with every AI client it finds (`src/setup/clients.ts`: one entry per client with its config path and format). Config edits must keep the user's comments and other entries (jsonc-parser for JSON, a table rewrite for Codex TOML), and the file is backed up first. Test setup only with a fake `HOME`/`APPDATA`, never against real configs. Adding a client = one `CLIENTS` entry + a test. The MCP server's `instructions` (in `src/mcp.ts`) carry the workflow for clients without the skill.
- X11 is verified in CI by `pnpm smoke:x11` under Xvfb + openbox (`.github/workflows/ci.yml`; locally only on a throwaway X display, it drives XTest). Windows is verified in CI by `pnpm smoke:windows` on a real runner; on a real PC run `pnpm windows:live` (doctor, smoke, a narrated take across monitors + render into `windows-live-report/`). `screenpilot doctor [--input]` checks any machine.
- The website (GitHub Pages, "Deploy from a branch", `main`, `/docs`) is generated: edit `site/` (`landing.mjs` for the home page in both languages, `content/<en|ar>/*.html` for the docs, `static/` for CSS and JS; format in `site/CONTENT_SPEC.md`), then run `node site/build.mjs`, which rewrites `docs/` and checks every internal link. No CI step builds it, so commit `docs/` with the change. Media under `docs/media` is exempt from Git LFS (Pages cannot serve LFS files).
