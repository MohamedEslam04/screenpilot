---
name: screenpilot
description: Make a polished demo / product video from a screen recording of any desktop app (Linux, Windows, macOS). Use when the user wants to record an app, edit a screen recording with zooms, captions, highlights and voiceover (English or Arabic), cut idle time, or render a demo MP4 from a storyboard.
---

# screenpilot: record, storyboard, render

You record (or receive) a raw screen recording, look at it, write `storyboard.json`, and screenpilot renders an MP4 (HyperFrames; voiceover with Edge voices by default, or local models or a user-defined command). You are the editor: you decide the cuts, zooms, captions and narration.

Each step has an MCP tool and a CLI form (`screenpilot ...`, or `node /abs/path/dist/cli.js ...`). Use whichever is available.

## Before you start: ask the user

Do not record, drive the desktop, build or render before the user has made the decisions only they can make: the goal and audience, where the recording comes from, the language, **which voice** (built-in, a website's voice such as Google AI Studio, their own program or recording, or none), the look, the camera, how they want to review it, and whether you may record and drive their mouse. Never answer for them and never install anything for them.

- MCP: call `brief` first. Its recommendations follow the existing video in the folder (its voice files, language, size), then the user's usual choices (remembered after every confirmed brief; the content is never saved). First ask ONE question: use the recommended setup shown in `shortcut` (a form shows it too), or choose each item? Only after the user says yes, call `brief` again with `use_recommended: true`; never on your own. To choose each item the user picks right in a form, or you show the option pickers (2 to 4 options each, recommended first) with your question tool exactly as given, ask the free-text one in chat, then call `brief` again with `answers`. The content question is optional. `brief` takes `project` (folder or storyboard.json to follow). `record_start`, `perform`, `render` and `sequence_render` refuse until it is done. It returns what to do next for the answers.
- CLI only: run `screenpilot brief [--project <path>]`. Offer `recommendedSetup` first as one question (use it, or choose each item), then ask the questions it lists the same way (at most 4 at a time; a question with `askWhen` only after its parent has that answer; the content one is optional), then continue.
- Skip a question only when the user already answered it in their request, and pass that answer. Unattended runs set `SCREENPILOT_SKIP_BRIEF=1`.

## Ground rules

- All times in the storyboard are **SOURCE seconds** (the raw recording), never output seconds. Only `check_output` / `screenpilot check` use output seconds.
- All positions are **normalized 0..1** of the source frame: x from the left, y from the top.
- Narration never overlaps: if a voice line is longer than its slot, render freezes the video (`autoHolds` in the result). Do not hand-tune for that; just keep lines short.
- Iterate with quality `draft`; use `delivery` only for the final render. When the user's desktop is idle, `--workers max` (MCP `workers: "max"`, or `SCREENPILOT_WORKERS=max`) renders faster by using all cores but two; the default is half the cores so the desktop stays responsive. Each finished render of 5 s or more is timed (`render-speed.json` in the cache folder), and when the next render is expected to take 2 minutes or more, the log starts with `estimated ~<time>` from the last renders at that quality (never printed without history).
- The render cache (extracted frames) lives in the user cache folder (`~/.cache/screenpilot/extract`, not /tmp) and is pruned to 4 GB before each render, oldest first, never entries from the last 10 minutes; `SCREENPILOT_RENDER_CACHE_GB` changes the cap, and `doctor` ("render cache") shows its size.

- Updates: `update_check` (MCP) or `screenpilot update --check` says whether a newer release exists and returns the command to run. Tell the user the command and let THEM run it in a terminal (never run `screenpilot update` yourself: it replaces installed code from the internet), then restart their AI apps. A small update only replaces the app files; if the dependencies or Node changed, or the install predates 0.6, it says to download the full package.

## The loop

1. **Record** (skip if the user gave a video).
   MCP `record_start` (dir?, input?, screen?, obsUrl?, obsPassword?) -> user performs the demo -> `record_stop`.
   CLI `screenpilot record` (Enter or Ctrl+C to finish, or `--duration <s>`; `--screen eDP-1` on multi-monitor setups). Records natively by default (no OBS needed: Wayland portal PipeWire/GStreamer, X11 and Windows ffmpeg); `recorder: "obs"` / `--recorder obs` uses OBS. Run `doctor` first if anything is off.
   Result: a session dir with the video, `events.jsonl` (pointer and clicks) and meta.
   To frame one window cleanly, pass `fitWindow` (MCP) / `--fit-window <class or title>` (CLI): it is resized to 16:9 during the recording and put back after.
   (OBS only) If record_stop warns that it assumed which monitor OBS records, check the frames; if the pointer does not line up, MCP `remap` (dir, screen) / CLI `screenpilot remap <session> --screen <name>`.

2. **Analyze.** MCP `analyze` (target = session dir or video). CLI `screenpilot analyze <target>`.
   Gives duration, `idle` spans (cut or speed these up), `clicks` (zoom targets), `suggestedSegments`, `suggestedZooms`, and a contact sheet image. Look at the contact sheet first to understand the story.
3. **Look closer.** MCP `get_frames` (video, times, grid: true). CLI `screenpilot frames <video> --at 1,4.5,10 --grid`.
   The grid labels 0..1 coordinates on the image: read the x/y of the button or field you want to zoom or highlight straight off it. Look at a frame just before and just after each click you plan to feature. Max 12 images per MCP call.
4. **Init.** MCP `storyboard_init` (target, suggest?, out?, voice?, provider?). CLI `screenpilot init <session-dir|video> --suggest [--voice ar-EG-SalmaNeural] [--provider local --voice voicetut:Sarah]`. Writes a starter storyboard; with suggest it pre-fills `segments` (idle time cut) and `zooms` (from clicks) for you to refine. `storyboard_schema` / `screenpilot schema` prints the full JSON Schema.
5. **Write the storyboard** (see example). Edit the file directly.
6. **Validate.** MCP `storyboard_validate` (path). CLI `screenpilot validate <storyboard>`. Fix every schema issue; read warnings (overlapping segments, items past the end of the video, callouts without x/y).
7. **Render a draft.** MCP `render` (storyboard, quality: "draft"). CLI `screenpilot render <storyboard> -q draft`. Slow (minutes); it makes the voice, cuts the video and renders. `build` / `screenpilot build` does everything except the final render; `preview` / `screenpilot preview` opens HyperFrames Studio for the user.
8. **Review.** MCP `check_output` (video, times?). CLI `screenpilot check <video> [--at 2,8,15]`. Times are OUTPUT seconds. Check: zoom lands on the right element, captions are not cut off or overlapping, nothing important is hidden by a caption, pacing feels right.
9. **Iterate** steps 5-8. Change one kind of thing at a time (timing, then zooms, then wording).
10. **Final render** with quality `delivery`: `screenpilot render <storyboard> -q delivery -o demo.mp4`. Tell the user the output path, duration and any warnings.

Long renders: a full render takes about as long as the video (more at delivery). For a long video iterate with quality `draft` and `from`/`to`, and use `workers: "max"` (`--workers max`) when the user is away from the desktop. A video (or `from`/`to` window) of 5 minutes or more renders automatically in cached chunks of about 3 minutes, cut only where nothing is in progress (narration, captions, cards, holds, transitions, camera moves, overlay videos and music fades never cross a cut): after an edit only the chunks it touched render again (`chunk 3/12 (...): unchanged, reusing` for the rest), then they are joined and loudness, subtitles and `also` run once on the joined file. An edit that shifts everything after it by whole seconds (a 2 s hold, a card) keeps the later chunks; a fractional shift (most narration-length changes) renders them again. `chunks: false` (`--no-chunks`) renders in one piece and `chunk_seconds` (`--chunk-seconds`) sets the length; a failed chunk names its output range and a retry resumes. Stop a render with MCP `abort` (or by cancelling the call) or Ctrl+C: it kills the whole render tree (HyperFrames, Chrome, ffmpeg; SIGTERM, then SIGKILL after 5 s; `taskkill /T /F` on Windows), and finished chunks and parts stay cached. The mp4 is written as `<name>.partial.mp4` and renamed when complete, so a file with the final name is always finished and playable; a failed or aborted render removes the partial file.

## Combine recordings (insert a feature clip, no re-recording)

One storyboard has one `source`. To insert another recording into the middle of a demo, record or `perform` only the new part, `init` a storyboard for it, then join storyboards with a `sequence.json`:

```json
{ "version": 1, "parts": [
  { "storyboard": "demo.json", "to": 42 },
  { "storyboard": "feature.json", "transition": { "type": "crossfade", "dur": 0.5 } },
  { "storyboard": "demo.json", "from": 42 } ] }
```

- MCP `sequence_validate` / `sequence_render` (quality, output) / `sequence_schema`; CLI `screenpilot sequence-validate|sequence|sequence-schema <sequence.json>`.
- `from`/`to` are SOURCE seconds of that part's storyboard, half-open `[from, to)`. Read the first storyboard's frames to pick the split second (a quiet moment between two actions). Narration that started before `from` is dropped; zooms/captions/highlights that straddle the cut are trimmed (dropped if under 0.5s is left); cards and overlays are clipped too.
- A part is one of `{storyboard}`, `{sequence: "group.json"}` (a nested sequence: rendered once to its own cached mp4, re-rendered only when one of its parts changes; no `from`/`to`; cycles fail validation with the chain printed) or `{video: "clip.mp4"}` (a finished mp4 used as is, scaled to the output size/fps if needed; `from`/`to` are seconds of that video). Transitions work between any two kinds: split a long video into groups of chapters, render each group, then join the groups with one sequence.
- Make the pieces look the same: give each storyboard `"extends": "base.json"` (shares theme, voice, output, music, keepSourceAudio, lint; the child wins; paths are relative to each file). Intro is used on the first part only, outro on the last; all parts get the first part's output size (override with `sequence.output`).
- Transitions on a part (how it enters from the previous one): `cut`, `crossfade`, `fade-black`, `wipe-left`, `wipe-right`, `slide-left`, `slide-right`; `dur` default 0.5, clamped to half of either neighbour. Unchanged parts are cached, so only edited parts re-render.
- Variants (another look, nothing edited): `screenpilot render storyboard.json --style dark.json` or `screenpilot sequence sequence.json --style dark.json -q draft` (MCP `style`). A style file is `{ "theme": { ... } }` only (any other key fails with its name); it is merged over every storyboard's theme (`motion`/`grade` key by key, `css` and `fonts` replace). Voice, size, cuts and timings stay. Output is `<name>.<style>.mp4` with its own `<name>.<style>.build`, so styles never overwrite each other and returning to one reuses its cache. `{video}` parts are finished files and are not styled.

## Subtitles (several languages, no second render)

Caption files come from `<video>.timeline.json` (written by every `render` and `sequence`), not from a render. Narration lines have an optional `id` (unique; default their position from 0); translations are keyed by it.

- Translation file (you or the user write it; nothing is machine translated): `{"<id or index>": "line"}` for one storyboard, or `{"<chapter>": ["line", ...]}` / `{"<chapter>": {"<id>": "line"}}` for a sequence (chapter = the part's storyboard folder name; an array needs exactly one line per narration line of that chapter, else the error names the chapter and both counts; a line with no translation is an error naming its id; keys that match nothing only warn).
- At render time: `screenpilot render demo.json --subtitle-lang ar,en=en.json,es=es.json` or `screenpilot sequence all.json --subtitle-lang ...` (MCP `render` / `sequence_render` `languages: {ar: "auto", en: "en.json"}`; `auto` = the video's own lines; `subtitles` picks formats, default srt and vtt). Files are `<video>.<code>.srt|vtt`; `--subtitle-chars 42` sets the line width. Without `--subtitle-lang`, `render --subtitles` writes the plain `<video>.srt|vtt` exactly as before.
- For a video that is already rendered: `screenpilot subs demo.mp4 --lang ar,en=en.json --formats srt,vtt` (MCP `subs`). A video joined by hand has no timeline: `--join a.timeline.json,b.timeline.json --transition 0.6` composes them with the same arithmetic as `sequence` (the overlap is clamped to half of either part). A timeline that differs from the video by more than 0.25 s is stale: an error that names the file.
- `--mux` adds the files as soft tracks with language metadata to `<video>.subs.mp4` (stream copy; `mov_text` for mp4/mov, `webvtt` for mkv/webm; the original is untouched).
- Every cue follows one rule set (`shapeCues`): at most 2 lines of about 42 characters, wrapped on spaces only (a long word stays whole), no cue overlaps the next, at least 0.7 s when there is room; a longer line becomes several cues. Right-to-left text is never reordered and no bidi marks are added.
- `screenpilot check demo.mp4` (MCP `check_output`) also compares each narration line's cue time with the first sound after it (ffmpeg `silencedetect`) and warns when they are more than 0.4 s apart (`--no-sync` / `sync: false` skips it). Background music keeps the video from ever being silent, so the check then sees nothing wrong.

Example (a sequence of two chapters, Arabic voice, English and Spanish files):

```sh
# es.json: {"setup": ["Abrimos los ajustes.", "Guardamos."], "ops": ["Listo."]}   (en.json has the same shape)
screenpilot sequence all.json -q delivery --subtitle-lang ar,en=en.json,es=es.json --subtitles srt,vtt
# -> all.mp4 all.timeline.json all.ar.srt all.ar.vtt all.en.srt all.en.vtt all.es.srt all.es.vtt
screenpilot subs all.mp4 --lang ar,en=en.json,es=es.json --mux   # later, no render: also writes all.subs.mp4 with 3 language tracks
```

## More editing tools

- **Chapter cards** `cards: [{ "at": 30, "title": "Step 2", "subtitle": "Export", "dur": 2.5 }]`: freezes the video at `at` and shows a full card (same look as intro/outro). An `at` in a cut region is dropped (warning). Put captions slightly after `at`.
- **Overlays** `overlays: [{ "src": "logo.png", "x": 0.82, "y": 0.04, "w": 0.14, "h": 0.08 }]`: image or video on the OUTPUT frame (0..1). No `at`/`dur` = whole video (watermark). Options: `fit` contain|cover, `opacity`, `radius`, `shadow`, `motion` (in/out like captions), `mute` (default true), `loop`. Paths relative to the storyboard.
- **Audio.** `segments[].volume` (0..4) or `mute: true` for the source audio (needs `keepSourceAudio`); `music.duck: { "amount": 0.6, "attack": 0.2, "release": 0.5, "under": ["narration", "overlays"] }` lowers the music while narration (and overlay sound) plays; music also takes `fadeIn`/`fadeOut` (s), `loop` (repeat a short track), `offset` (start inside the file) and `from`/`to` (source seconds). `audio: { "loudness": {} }` normalizes the finished video to -16 LUFS (`target` to change it), `audio: { "denoise": true }` cleans the recording's sound (needs `keepSourceAudio`). Use loudness on every final render so videos match in level.
- **Speed ramp and transitions.** `segments[].speedTo` ramps the speed over the segment (`speed: 1, speedTo: 8` eases into a fast-forward; use a segment of 1s+ ). `segments[].transition: { "type": "crossfade", "dur": 0.6 }` (also fade-black, fade-white, wipe-left/right, slide-left/right) blends into that segment instead of a hard cut; the two pieces overlap, so the video gets `dur` shorter. Not on the first segment. `theme.grade: { "contrast": 1.1, "saturation": 1.2 }` grades the recording only.
- **Annotations.** `annotations: [{ "type": "arrow", "at": 4, "from": {"x":0.2,"y":0.2}, "to": {"x":0.45,"y":0.4}, "label": "Start here" }, { "type": "box", "at": 8, "x": 0.55, "y": 0.15, "w": 0.3, "h": 0.12 }, { "type": "blur", "at": 12, "mode": "solid", "x": 0.1, "y": 0.1, "w": 0.35, "h": 0.06 }]`: positions 0..1 of the recording (they follow zooms). A box only outlines (a highlight also dims the rest). Hide anything secret (tokens, emails, names) with `blur` + `mode: "solid"`, a light blur can stay readable; check the frames. `typing[].keycaps: true` (with `text`) shows the typed words on screen.
- **Sound effects.** `sfx: [{ "at": 21.5, "src": "builtin:ding" }]` (built-ins: `builtin:click|key|whoosh|pop|ding`, made by ffmpeg at render time, or your own file) and `sounds: { "clicks": true, "typing": true, "cards": true, "volume": 0.5 }` for automatic sounds on recorded clicks (needs `events`), on `typing` spans (`typing: [{ "at": 12, "dur": 2.5, "text": "hello" }]`; the recorder never logs keys, a performed take marks them itself, for your own recording add them) and on intro/chapter/outro cards. Sparingly: clicks + cards is plenty.
- **Subtitle files and extras.** `render` with `subtitles: ["srt","vtt"]` writes caption files from the narration next to the video (every line, even `caption: false`), and `also: ["gif","webm","poster"]` makes a GIF, WebM or poster PNG from the finished video (`poster_at` sets the time). CLI: `--subtitles srt,vtt --also gif,poster`. Several languages without a second render: see "Subtitles" above. Every `render` and `sequence_render` also writes `<video>.timeline.json` (result field `timeline`): when each narration line and card is on screen in the finished video, in output seconds (`items: [{kind: narration|card|outro, id?, start, end, text, part?, chapter?}]`; a sequence's is offset across its transitions). Give a narration line an optional `id` (unique; default its position from 0) so files keyed by it survive reordering.
- **Fast review.** `render` with `from`/`to` (OUTPUT seconds) renders only that window into `<name>.part-A-B.mp4`; use it after editing one section.
- **Other formats.** `render` with `formats: ["16:9","9:16","1:1"]` (or `1280x720`) renders each into `<name>.<label>.mp4` (labels `16x9`, `9x16`, `1x1`). Portrait crops wide window-framed views, so check frames.
- **QA on pixels.** MCP `storyboard_qa` (path) / CLI `screenpilot qa <storyboard>` (needs ffmpeg) grabs source frames and warns `[empty-highlight]` (a highlight frames a flat area: the element is gone or hidden behind a dialog) and `[view-outside-window]` (a view shows over 8% outside the active window, so the desktop is visible; uses `windows.jsonl` next to the source). Run it after `validate`, before the delivery render.
- **Lint.** `validate` and render warnings flag narration over ~12 words or too fast, captions over 6 words, overlapping captions/zooms, zoom scale outside 1.4-2.5, zoom + highlight + callout stacked, speed over 8, and a final length over 90s or under 15s. Fix them unless there is a reason. Each warning starts with its rule id (`[narration-length]`, `[narration-speed]`, `[caption-length]`, `[duration]`, `[zoom-scale]`, `[stack]`, `[transition]`). For a long tutorial, raise the limits or silence a rule once with `"lint": {"narrationWords": 20, "captionWords": 8, "duration": {"min": 15, "max": 2400}, "off": ["duration"]}` (put it in the shared `extends` base) instead of fixing each warning.

## Optional: you perform the demo (KDE Wayland, X11, GNOME Wayland, Windows)

Instead of asking the user to perform the demo, drive the desktop yourself and let screenpilot record it. Loop: **explore -> rehearse -> perform -> review storyboard -> render** (then the normal loop above, from step 2).

Requirements: KDE Wayland; a person approves the KDE "remote control" dialog once (select all monitors; token saved in `~/.config/screenpilot/state.json`); recording is native (OBS optional, with one capture source per monitor and `--map "Source=MONITOR"` if names don't match). On Windows driving works via SendInput (elevated apps need an elevated tool). X11 sessions (any desktop) use XTest with no dialog. GNOME and other Wayland desktops use the same portal dialog as KDE but have no window control: use `{screen, x, y}` targets only (no focus, waitForWindow, window or web targets; `{a11y}` controls can be read but not clicked there). sway/Hyprland cannot be driven (recording works).

Rules for every drive tool: coordinates are normalized 0..1 per monitor; take a screenshot first, act, then screenshot again to verify; the real mouse and keyboard are used, so if a person is present ask them not to touch the mouse (moving it stops the action; MCP `resume` carries on from where the pointer is; for unattended runs start the server with `SCREENPILOT_INTERRUPT=off`); prefer `{web: selector}` targets inside the demo browser and `{a11y: {role, name}}` for native apps; secrets only as `{env: NAME}`, never as literal text.

1. **Explore.** MCP `screenshot` (grid: true), `windows`, `browser_open` (screen, url, id for a second browser), `web_locate` (selector, browser), and act with `focus_window`, `pointer_move`, `click`, `drag`, `scroll`, `key`, `type_text`. CLI: `screenpilot screenshot --grid`, `windows`, `browser`, `drive ...`. Check the result of each action with a new screenshot.
2. **Write `take.json`.** MCP `take_schema` / CLI `screenpilot take-schema`. Target forms: `{screen, x, y}`, `{web: selector}`, `{a11y: {role, name, app?, exact?, nth?}}`, `{window: match, x, y}`. A `{web}` click on an element that something covers (sticky header, clipping scroll box) fails with `TARGET_COVERED` (named cover in the message; nothing was clicked): scroll it clear or close what covers it; `"force": true` on the click skips the check.
   **Native apps (`{a11y}`).** Read the UI as data instead of guessing pixels: MCP `a11y_tree` (role, name, states, rect) and `a11y_find` (matches with centre `cx,cy`; one match means safe to click); CLI `screenpilot a11y tree [--app X] [--all]`, `screenpilot a11y find <role>:<name>`, `screenpilot drive click a11y:button:Save`. An `{a11y}` target only LOCATES the control; the real pointer then moves and clicks, so the cursor stays visible in the recording. It works in click, move, drag, `scroll.at` and `waitFor: {a11y: {...}, timeout}` (MCP `wait_for` takes `a11y` too). `role` is an alias (`button`, `checkbox`, `textbox`, `menuitem`, `tab`...) or an AT-SPI name (`push button`); `name` is contains, case-insensitive (`exact: true` for the whole name). Several matches is an error with the candidates: add `nth` (1-based) or a more specific name. Without `app` it searches the focused window's app. Linux (AT-SPI) works on KDE Wayland and X11; GNOME and wlroots give no window position, so controls are readable but not clickable (`POSITION_UNKNOWN`): use `{screen, x, y}`. macOS uses the AX API (tested on a real macOS runner in CI); Windows uses UI Automation (no extra install; tested on a real Windows runner; an app running as administrator cannot be read unless the tool is elevated too); apps whose controls UI Automation exposes only as plain panes (classic Notepad's text area) show no control there, so use `{window, x, y}` or `{screen, x, y}` for those. X11 was tested on a nested X server (Xephyr, no window manager). Qt apps only appear if launched with `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` (apps started by a take's `run`/`open` get it; restart an already running Qt app). Apps that draw their own UI expose little. Target errors have a `code` and `delivery: "not_delivered"`, `retry: "safe"`: nothing was sent, so fix the target and try again.
3. **Rehearse.** MCP `perform` (take, dryRun: true) / CLI `screenpilot perform take.json --dry-run`. A failure returns `{failedStep, error, partial}` / names the step: fix it and repeat. MCP `abort` / Ctrl+C stops a run.
4. **Perform.** `perform` without dryRun: records all monitors, drives, and writes a session dir with video, `events.jsonl` and a starter `storyboard.json` (zooms, narration, captions, views). With `dir` a retake never collides: if the folder already holds a take the new one goes to `<dir>-2`, `<dir>-3`, ...; use the `dir` in the result (`<dir>-latest` is a symlink to it). `overwrite: true` (CLI `--overwrite`) moves the old take to `<dir>.prev` and reuses `<dir>`.
5. **Review the storyboard** with `analyze` and `get_frames`, edit, `storyboard_validate`, render draft, `check_output`, final render.

Example take: web form, download, open the file locally, English lines plus one Egyptian Arabic line, a caption, and monitor switches.

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

Typing: `type` takes `method: "keys" | "paste" | "auto"` (default `auto`). Key-by-key injection drops letters in Arabic and other text outside Latin-1, so `auto` pastes those (clipboard set, `ctrl+v` / `cmd+v` on macOS, previous clipboard restored; `{env}` text is never left on it). Needs `wl-copy`/`wl-paste` (Wayland), `xclip` (X11) or the OS tools on macOS/Windows; `doctor` warns when missing. A paste still marks a `typing` span.

Take tips: `say` with `wait: true` before an important click; 0.3-1 s `wait`s after navigation; `waitFor` instead of long waits; keep takes under ~90 s; `say` lines use `voice.name` unless overridden per line; `view` switches which monitor the camera shows (`"all"` for the full wall). Two windows with one title (two browsers)? `focus: {match}` takes the active one, else the first, and logs the count: use `{"focus": {"browser": true}}` for the demo browser (found by process id). A `{web}` target, and the `type`/`key` after it, bring the demo browser to the front first. `run` starts a program and carries on, `{"run": [...], "wait": true, "timeout": 10}` waits for it to exit and fails the step on a non-zero exit code or timeout (e.g. `wl-copy` before `ctrl+v`).

Highlight a page element (a toast, a new row) without writing coordinates: `{"highlight": {"web": "[data-sonner-toast]", "label": "Saved", "until": "gone", "dur": 8}}` right after the click that shows it. Non-blocking: it is tracked in the background while later steps run and lands in `storyboard.highlights[]` in recording coordinates (on any monitor). `until: "gone"` (default) ends when the element is missing, hidden or covered for 0.8 s, `"next"` at the next `say`/`highlight`; `dur` caps it. Spans under 0.6 s and elements that never showed are dropped with a warning naming the selector; a dry run only checks the selector.

Two demo browsers in one take (an admin and a user, live effects): `{"browser": {"id": "user", "url": "..."}}` opens a second one with its own profile (`browser-user` in the config folder) and debugging port (main is 9333, others 9334, 9335, ... by first use). Every `{web}` target, `waitFor.web`, `goto` and `highlight` take `"browser": "user"` (default `"main"`); `{"focus": {"browser": "user"}}` brings it up, and a `{web}` target brings its own browser to the front. `{"tile": {"browsers": ["main", "user"], "screen": "eDP-1"}}` places them side by side, equal widths, the full height of the monitor's usable area (never under a panel, taskbar or dock; the whole monitor where the desktop cannot report it, e.g. GNOME or wlroots Wayland), left to right in list order (also for RTL apps). With 2+ browsers the generated storyboard gets one view of the tiled area (around their windows when nothing was tiled) instead of following windows, unless the take has `view` steps or `camera: "all"`; highlights map from the browser they were measured in. Explore it live over MCP before writing the take: `browser_open` with `id` (reused and navigated if that id is already open), then pass the same id as `browser` to `web_locate`, `wait_for` (the `web` form) and `page_text`; a second browser that is not open yet fails with "Call browser_open with id ... first". Ports and profiles are the ones `perform` uses.

## Storyboard example

Egyptian Arabic voice by default, one English line overriding it. Note the paths are relative to the storyboard file.

```json
{
  "version": 1,
  "source": "sessions/2026-10-27_14-02/video.mkv",
  "events": "sessions/2026-10-27_14-02/events.jsonl",
  "voice": { "name": "ar-EG-SalmaNeural", "rate": "+5%", "subtitles": true },
  "theme": { "accent": "#facc15" },
  "intro": { "title": "Acme Invoices", "subtitle": "Send an invoice in 20 seconds", "dur": 3 },
  "outro": { "title": "Try it today", "subtitle": "acme.example", "dur": 3 },
  "segments": [
    { "in": 0, "out": 6, "speed": 1 },
    { "in": 6, "out": 19, "speed": 6 },
    { "in": 19, "out": 41, "speed": 1 }
  ],
  "holds": [{ "at": 30.5, "dur": 1.5 }],
  "zooms": [
    { "at": 2.5, "dur": 3, "x": 0.18, "y": 0.22, "scale": 2 },
    { "at": 24, "dur": 4, "x": 0.82, "y": 0.9, "scale": 1.8 }
  ],
  "captions": [
    { "at": 1, "dur": 3, "text": "Start from the dashboard", "position": "bottom", "style": "pill" },
    { "at": 22, "dur": 3, "text": "One click to send", "style": "callout", "x": 0.82, "y": 0.9 },
    { "at": 36, "dur": 3, "text": "Done", "position": "center", "style": "title" }
  ],
  "highlights": [{ "at": 24, "dur": 2.5, "x": 0.72, "y": 0.85, "w": 0.2, "h": 0.1, "label": "Send" }],
  "narration": [
    { "at": 1, "text": "هنبدأ من لوحة التحكم." },
    { "at": 22, "text": "ضغطة واحدة وتتبعت الفاتورة." },
    { "at": 36, "text": "And that's it.", "voice": "en-US-AriaNeural" }
  ]
}
```

What each part does:

- `segments`: parts of the source to KEEP, in order, with `speed` (>1 fast-forwards, e.g. 6 for a loading screen). Gaps between segments are cut. Empty list = whole video. Must not overlap.
- `holds`: freeze the video at a source time (to give a caption or line room). Narration overruns add holds automatically.
- `zooms`: `at` is when the zoom is fully in, `dur` how long it stays, `x`,`y` the focus, `scale` 1..4.
- `captions`: `style` is `pill` (subtitle-like), `title` (big), or `callout` (bubble pointing at `x`,`y`; always give x/y). `position` is bottom/top/center.
- `highlights`: a box (`x`,`y` top-left, `w`,`h` size, all 0..1) with optional label.
- `narration`: `at` is the source time the line starts. Per-line `voice` overrides `voice.name`. A line placed in a cut region is dropped (warning). Lines also show as subtitles unless `caption: false` or `voice.subtitles: false`.
- `cards`, `overlays`, `sfx`/`sounds`, `extends`, segment `volume`/`mute` and `music.duck`: see "More editing tools" and "Combine recordings" above.
- `intro` / `outro`: title cards. `music`: `{ "src": "bgm.mp3", "volume": 0.12 }`. `keepSourceAudio`, `output` (1920x1080@30 default) and `theme` (background, padding, radius, accent, font, captionColor, captionBackground, clickRipples, `fonts`: extra Google Fonts, `css`: your own CSS) are optional; see "Design the look" below.
- Voices: MCP `voices` (lang: "ar-EG") / `screenpilot voices --lang ar-EG`. Egyptian Arabic: `ar-EG-SalmaNeural` (f), `ar-EG-ShakirNeural` (m). English: `en-US-AndrewNeural`, `en-US-AriaNeural`.
- Local and command voices: set `"voice": {"provider": "local", "name": "voicetut:Sarah", "rate": "+0%"}` (default provider `edge`). Local names: `voicetut` or `voicetut:<Voice>` (Egyptian Arabic and English, 19 voices) and `namaa` (Egyptian Arabic only). A line's own `voice` overrides the name within the same provider (e.g. `namaa` for an Arabic line, `voicetut:Sarah` for an English one); the language of each line is detected, and `rate` becomes a speed factor for voicetut (namaa ignores it). Arabic from VoiceTut is less accurate than English. List installed ones with MCP `voices` (provider: "local") / `screenpilot voices --provider local`, and check `doctor` ("local voice"). If the user wants free offline voices and none is installed, tell them to run `screenpilot voice-setup voicetut` in a terminal (about 10 GB, 30 minutes or more); do not start it yourself. `provider: "command"` voices (`name` = a key in the user's `voices.json`) are defined by the user; you cannot add commands from a storyboard; a command entry may list `cacheFiles` (clips or models it reads) so cached lines are remade when those files change. A dry run (`perform --dry-run`) never synthesizes: line lengths are estimated. Details: https://mohamedeslam04.github.io/screenpilot/guide/voices.html
- Cloud voices (optional; the narration text is sent to that service, free plans have limits and may forbid commercial use, so say so): `"voice": {"provider": "elevenlabs", "name": "<voice id or a voice name of the account>"}` (model `eleven_multilingual_v2`, env `ELEVENLABS_MODEL_ID`; `rate` becomes speed clamped 0.7-1.2) or `{"provider": "gemini", "name": "Kore"}` (30 prebuilt voices; model `gemini-3.8-flash-tts`, env `GEMINI_TTS_MODEL`; `rate` ignored). Set `name` explicitly: the default belongs to Edge. The key is `ELEVENLABS_API_KEY` / `GEMINI_API_KEY` (environment wins) or `secrets.json` in the config folder (mode 0600). Never ask for a key in chat or store it yourself: the user runs `screenpilot secret set elevenlabs|gemini` (key on stdin), `secret status` shows where each key comes from, `secret remove` deletes it. List voices with `screenpilot voices --provider elevenlabs|gemini`; `doctor` shows whether a key is set. Clips are cached per provider, voice, model, rate and text; failed requests retry up to 3 tries. Cost: before the first render with a paid voice run `screenpilot render storyboard.json --dry-run` (MCP `render` with `dryRun: true`; `sequence --dry-run` for a sequence): it prints lines, characters and estimated USD with nothing sent or written (cached lines are free), so tell the user the number and render after they agree. Every billed request is added to a ledger: `screenpilot spend [--since 2026-11-01] [--json]` totals it and MCP `voices` shows the running total. The price per credit is an estimate you can set in `voices.json` (`{"spend": {"usdPerCredit": {"elevenlabs": 0.00022}}}`).
- Dashboard: `screenpilot dashboard` opens a separate local desktop window (Library from the history with a thumbnail, Open video and Render draft/delivery buttons, Live renders, Voices and keys, Stats). It is a small native program (about 14 MB of memory). Releases newer than 0.10.0 ship it inside the package (not in the `.mcpb` files); `screenpilot setup` adds it to the Start Menu, `~/Applications` or the application menu with the ScreenPilot logo, and `screenpilot update` replaces it. For 0.10.0 or older it must be built from the repository (`cd dashboard && cargo build --release -p screenpilot-dashboard`); if it is not installed the command says so. It runs on the user's machine only; do not start it for them unless asked.
- History: `screenpilot history [--limit n] [--before iso] [--live]` prints what was recorded and rendered, newest first (JSON events: `at`, `kind` record|take|render|sequence, `status` ok|failed, `path`, `output`, `durationSec`, `quality`, `wallSeconds`, `error`); `--live` lists the renders running now. `screenpilot library import [--root dir...]` adds older recordings and renders found on disk. The file is `history.jsonl` in the config folder; parts of a sequence and the setup warm-up add nothing.
- Better voice from a website: `screenpilot script storyboard.json` (MCP `script_export`) writes the text to paste (one paragraph per line, no numbers). The user generates ONE audio file on a free web TTS site and gives it back; `screenpilot split-audio voice.mp3 --storyboard storyboard.json` (MCP `audio_import`) cuts it at the pauses and sets `narration[].audio` (path relative to the storyboard; the line plays that file and `text` stays the subtitle). Too few pauses: ask for a longer pause between lines or pass `--min-silence`. Free plans have limits and may forbid commercial use; say so.

## Design the look (every video is different)

There is no house style: the defaults are a fallback, not a look. Before rendering, decide:

- **Who and where.** Developers on a GitHub README, customers on a landing page, a sales prospect, followers on Reels/TikTok, colleagues in a tutorial. That decides size (`output`: 1920x1080 for README/YouTube/slides, 1080x1920 for Reels/TikTok/Shorts, 1080x1080 for feeds), pace and tone.
- **Brand.** Take colors and type from the product being shown (its site, app or logo): `theme.background` (solid, gradient or image), `theme.accent`, `theme.font` + `theme.fonts` (any Google Fonts, e.g. `"Tajawal:wght@400;700"` for Arabic).
- **Details with `theme.css`.** Restyle anything: caption boxes (`.text.pill > span`, `.text.subtitle > span`, `.text.title > span`, lines `.text .ln`), intro/outro cards (`.card`, `.card h1`, `.card p`), highlights (`.hl`), callouts, ripples, the recording frame (`#frame`) and the stage (`#root`). `storyboard_schema` lists them.
- **Motion.** Text animation is yours too: `theme.motion.captions` and `theme.motion.cards` set the defaults, `motion` on a caption overrides it. `in`/`out`: `fade`, `rise`, `drop`, `slide-left`, `slide-right`, `pop`, `zoom`, `blur`, `wipe` (uncovers in reading direction), `words` (word by word, Arabic too), `lines` (one line of a bilingual caption after the other), `none`; plus `duration`, any GSAP `ease` (`"expo.out"`, `"back.out(1.7)"`, `"elastic.out(1,0.5)"`) and `stagger`. Energetic social clips: `pop`/`words` with a bouncy ease; calm tutorials: `fade`/`rise`; titles: `wipe` or `words`.
- **Nothing private on screen.** Open web pages with `"browser": { "app": true }` (or `browser_open` `app: true`): no address bar or tabs, so local paths and other tabs never show. In a take, write page and file paths relative to the take.json (`"url": "site/index.html"`), never absolute paths from this machine.
- **The shot.** Pick what to record and show from the goal, not by habit. Monitors: one (`screens: ["eDP-1"]`), several, or `"all"`. Camera: `"window"` follows the app in use (product demos, hides the desktop), `"screen"` shows the whole monitor (OS-level how-tos, when the taskbar or other apps matter), `"all"` puts monitors side by side (flows that span screens: editor + app, dashboard + terminal). Change it mid-video with `view` steps in a take or `views` in the storyboard, and zoom only where detail matters.
- **Captions.** Social: big, bold, few words. Tutorials: calm, explanatory, lower third. Bilingual: one caption with two lines, `"English\nعربي"`; avoid a lone "و" between Latin words (it renders like "g"), use Arabic commas instead.

Render a draft and look at it with check_output before the final render.

## Style guidance for good demos

- **Short narration.** One sentence, under ~12 words, one idea. Say what the viewer is seeing or why it matters, not which button to press. Write Arabic narration in natural spoken Egyptian, not formal Arabic, when using an ar-EG voice.
- **Zoom on the thing being clicked.** Put the zoom `at` ~0.5s before the click, `dur` 2-4s, scale 1.6-2.2. Take x/y from a grid frame. Do not zoom when the whole screen matters; return to full view between zooms.
- **Cut idle time.** Remove or speed up (4-8x) loading, typing pauses, waiting and mistakes using the `idle` spans from analyze. Aim for no dead moment longer than ~1s at normal speed.
- **One idea per caption.** 2-6 words. Use `callout` only to point at one small element, `title` for chapter-like beats, `pill` for everything else. Don't caption what narration already says (turn off subtitles or caption only key moments).
- **Pace.** Narration line and the action it describes should start together; leave ~0.3s of air between lines. Total demo ideally 30-90s.
- **Don't stack effects.** A zoom + highlight + callout on the same click is too much; choose the one that points best.
- Start with a rough pass (segments + narration), review a draft, then add zooms and captions.

## Platform notes
- Works on KDE Plasma (Wayland), any X11 desktop, GNOME and other Wayland desktops (recording + screen-target driving; no window control), and Windows 10/11. Run MCP `doctor` / CLI `screenpilot doctor` first on a new machine.
- Take step `{ "open": "<file or URL>" }` opens it with the default app on any OS (prefer it over `run` with xdg-open/start).
- On Windows, apps running as administrator cannot be driven from a non-admin process.
