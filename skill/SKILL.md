---
name: screenpilot
description: Make a polished demo / product video from a screen recording of any desktop app (Linux, Windows, macOS). Use when the user wants to record an app, edit a screen recording with zooms, captions, highlights and voiceover (English or Arabic), cut idle time, or render a demo MP4 from a storyboard.
---

# screenpilot: record, storyboard, render

You record (or receive) a raw screen recording, look at it, write `storyboard.json`, and screenpilot renders an MP4 (HyperFrames, Edge TTS voiceover). You are the editor: you decide the cuts, zooms, captions and narration.

Each step has an MCP tool and a CLI form (`screenpilot ...`, or `node /abs/path/dist/cli.js ...`). Use whichever is available.

## Ground rules

- All times in the storyboard are **SOURCE seconds** (the raw recording), never output seconds. Only `check_output` / `screenpilot check` use output seconds.
- All positions are **normalized 0..1** of the source frame: x from the left, y from the top.
- Narration never overlaps: if a voice line is longer than its slot, render freezes the video (`autoHolds` in the result). Do not hand-tune for that; just keep lines short.
- Iterate with quality `draft`; use `delivery` only for the final render.

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
4. **Init.** MCP `storyboard_init` (target, suggest?, out?, voice?). CLI `screenpilot init <session-dir|video> --suggest [--voice ar-EG-SalmaNeural]`. Writes a starter storyboard; with suggest it pre-fills `segments` (idle time cut) and `zooms` (from clicks) for you to refine. `storyboard_schema` / `screenpilot schema` prints the full JSON Schema.
5. **Write the storyboard** (see example). Edit the file directly.
6. **Validate.** MCP `storyboard_validate` (path). CLI `screenpilot validate <storyboard>`. Fix every schema issue; read warnings (overlapping segments, items past the end of the video, callouts without x/y).
7. **Render a draft.** MCP `render` (storyboard, quality: "draft"). CLI `screenpilot render <storyboard> -q draft`. Slow (minutes); it makes the voice, cuts the video and renders. `build` / `screenpilot build` does everything except the final render; `preview` / `screenpilot preview` opens HyperFrames Studio for the user.
8. **Review.** MCP `check_output` (video, times?). CLI `screenpilot check <video> [--at 2,8,15]`. Times are OUTPUT seconds. Check: zoom lands on the right element, captions are not cut off or overlapping, nothing important is hidden by a caption, pacing feels right.
9. **Iterate** steps 5-8. Change one kind of thing at a time (timing, then zooms, then wording).
10. **Final render** with quality `delivery`: `screenpilot render <storyboard> -q delivery -o demo.mp4`. Tell the user the output path, duration and any warnings.

## Optional: you perform the demo (KDE Wayland, X11, GNOME Wayland, Windows)

Instead of asking the user to perform the demo, drive the desktop yourself and let screenpilot record it. Loop: **explore -> rehearse -> perform -> review storyboard -> render** (then the normal loop above, from step 2).

Requirements: KDE Wayland; the user approves the KDE "remote control" dialog once (select all monitors; token saved in `~/.config/screenpilot/state.json`); recording is native (OBS optional, with one capture source per monitor and `--map "Source=MONITOR"` if names don't match). On Windows driving works via SendInput (elevated apps need an elevated tool). X11 sessions (any desktop) use XTest with no dialog. GNOME and other Wayland desktops use the same portal dialog as KDE but have no window control: use `{screen, x, y}` targets only (no focus, waitForWindow, window or web targets). sway/Hyprland cannot be driven (recording works).

Rules for every drive tool: coordinates are normalized 0..1 per monitor; take a screenshot first, act, then screenshot again to verify; the real mouse and keyboard are used, so ask the user not to touch them (touching the mouse aborts); prefer `{web: selector}` targets inside the demo browser; secrets only as `{env: NAME}`, never as literal text.

1. **Explore.** MCP `screenshot` (grid: true), `windows`, `browser_open` (screen, url), `web_locate` (selector), and act with `focus_window`, `pointer_move`, `click`, `drag`, `scroll`, `key`, `type_text`. CLI: `screenpilot screenshot --grid`, `windows`, `browser`, `drive ...`. Check the result of each action with a new screenshot.
2. **Write `take.json`.** MCP `take_schema` / CLI `screenpilot take-schema`. Target forms: `{screen, x, y}`, `{web: selector}`, `{window: match, x, y}`.
3. **Rehearse.** MCP `perform` (take, dryRun: true) / CLI `screenpilot perform take.json --dry-run`. A failure returns `{failedStep, error, partial}` / names the step: fix it and repeat. MCP `abort` / Ctrl+C stops a run.
4. **Perform.** `perform` without dryRun: records all monitors, drives, and writes a session dir with video, `events.jsonl` and a starter `storyboard.json` (zooms, narration, captions, views).
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

Take tips: `say` with `wait: true` before an important click; 0.3-1 s `wait`s after navigation; `waitFor` instead of long waits; keep takes under ~90 s; `say` lines use `voice.name` unless overridden per line; `view` switches which monitor the camera shows (`"all"` for the full wall).

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
- `intro` / `outro`: title cards. `music`: `{ "src": "bgm.mp3", "volume": 0.12 }`. `keepSourceAudio`, `output` (1920x1080@30 default) and `theme` (background, padding, radius, accent, font, captionColor, captionBackground, clickRipples, `fonts`: extra Google Fonts, `css`: your own CSS) are optional; see "Design the look" below.
- Voices: MCP `voices` (lang: "ar-EG") / `screenpilot voices --lang ar-EG`. Egyptian Arabic: `ar-EG-SalmaNeural` (f), `ar-EG-ShakirNeural` (m). English: `en-US-AndrewNeural`, `en-US-AriaNeural`.

## Design the look (every video is different)

There is no house style: the defaults are a fallback, not a look. Before rendering, decide:

- **Who and where.** Developers on a GitHub README, customers on a landing page, a sales prospect, followers on Reels/TikTok, colleagues in a tutorial. That decides size (`output`: 1920x1080 for README/YouTube/slides, 1080x1920 for Reels/TikTok/Shorts, 1080x1080 for feeds), pace and tone.
- **Brand.** Take colors and type from the product being shown (its site, app or logo): `theme.background` (solid, gradient or image), `theme.accent`, `theme.font` + `theme.fonts` (any Google Fonts, e.g. `"Tajawal:wght@400;700"` for Arabic).
- **Details with `theme.css`.** Restyle anything: caption boxes (`.text.pill > span`, `.text.subtitle > span`, `.text.title > span`, lines `.text .ln`), intro/outro cards (`.card`, `.card h1`, `.card p`), highlights (`.hl`), callouts, ripples, the recording frame (`#frame`) and the stage (`#root`). `storyboard_schema` lists them.
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
