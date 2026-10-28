# Contributing to ScreenPilot

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

The sections after "Style" are the developer reference: how ScreenPilot works, the CLI, the MCP tools and the storyboard format.

Only the maintainer can push to this repository. Everyone else works from a fork and sends a pull request, which the maintainer reviews and merges.

## Report a bug or suggest something

Open an issue. For a bug, please include the output of `screenpilot doctor`, your operating system and desktop, and the ScreenPilot version. For a security problem, don't open an issue: see [SECURITY.md](SECURITY.md).

## Send a pull request

1. Fork the repository and create a branch from `main`.
2. Make one focused change. Small pull requests get reviewed faster. For something big, open an issue first so we can agree on the approach.
3. Add or update tests, and keep the README in step with user-visible changes.
4. Run the checks below.
5. Open the pull request and fill in the template.

The first pull request from a new contributor needs the maintainer to approve the automated checks before they run.

## Set up

You need Node 22+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev <args>      # run the CLI from source
pnpm typecheck
pnpm test
pnpm build
```

Tests run on every pull request. The platform smoke tests (Windows, macOS, X11, Wayland) also run in CI and drive a real desktop; don't run them on a desktop you are using. `AGENTS.md` has the architecture notes and conventions.

## Style

- TypeScript, ESM, `.js` import suffixes, 2-space indent, double quotes.
- Match the surrounding code: naming, structure, comment density.
- Anything OS-specific goes behind `src/platform`.
- The MCP server must never write anything but protocol messages to stdout; log to stderr.
- Never put secrets in a `take.json`, a test or a log.

## How it works

ScreenPilot works in four steps. To use it, see the [README](README.md).

1. **Record** the screen (built in, or through OBS) plus pointer, click and active-window events.
2. **Analyze**: the agent looks at a contact sheet and frames with a coordinate grid.
3. The agent writes `storyboard.json`: cuts, speed-ups, zooms, captions, highlights, voiceover lines.
4. **Render** an MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + GSAP) and the voiceover: Edge voices by default, or a local model or a user-defined command (see [Voice providers](#voice-providers)).

## Why

Playwright can only record a browser. screenpilot records anything on screen (native apps, IDEs, terminals, Electron) on Linux (KDE, GNOME, Cinnamon, MATE, Xfce, sway, Hyprland, on X11 or Wayland), Windows and macOS, and gives an AI agent the tools to see the footage and edit it.

## Platform support

screenpilot picks a desktop backend by itself (`screenpilot doctor` shows which one and what works); set `SCREENPILOT_DESKTOP=kde|x11|portal|windows|macos` to override.

| | Record (native) | Drive (pointer, keys, typing) | Windows (list, focus, fit to 16:9) | Pointer + click logging |
|---|---|---|---|---|
| **KDE Plasma, Wayland** (`kde`) | PipeWire portal streams + GStreamer | RemoteDesktop portal (approve once) | KWin scripts | KWin pointer; clicks need the `input` group |
| **Any X11 session** (`x11`): GNOME on Xorg, Linux Mint Cinnamon/MATE/Xfce, KDE X11, ... | ffmpeg `x11grab` | XTest (any Unicode text, no clipboard or layout switch) | EWMH window manager | XQueryPointer + global hook |
| **GNOME and other Wayland desktops** (`portal`) | PipeWire portal streams + GStreamer (asks once) | RemoteDesktop portal (approve once) | not available: focus/fit steps and `{web}` targets fail with a clear error; window-framed views fall back to monitor views | none (Wayland hides the pointer); performed takes still log their own clicks |
| **sway, Hyprland and other wlroots** (`portal`) | ScreenCast portal + GStreamer (asks once) | not available (no RemoteDesktop portal) | not available | none |
| **Windows 10/11** (`windows`) | ffmpeg `gdigrab` | SendInput | Win32 | cursor polling + global hook |
| **macOS 12+**, Apple Silicon and Intel (`macos`) | ffmpeg `avfoundation` (Screen Recording permission) | CGEvent (Accessibility permission) | Accessibility API | Quartz polling + global hook (Input Monitoring) |

Status: KDE Wayland is used daily; Windows, X11 and macOS each have a CI smoke test on a real runner (`smoke:windows`; `smoke:x11` under Xvfb + openbox; `smoke:macos`, where steps that need a privacy permission the runner can't grant are reported as blocked). The `portal` backend was verified by forcing it on KDE Wayland (monitors from the portal streams, recording); GNOME's monitor names come from Mutter's `DisplayConfig`, sway's and Hyprland's from `swaymsg` / `hyprctl`. CI (`wayland.yml`) runs a headless sway session: detection, monitors, doctor and the driving error are verified there, but recording can't run on hosted runners (xdg-desktop-portal-wlr needs a GPU render node). Multi-monitor and mixed DPI are verified on virtual displays: Windows 100% + 150% (`windows-multimon.yml`) and a macOS Retina second display (`macos-multidisplay.yml`). GNOME and Hyprland have not been run on real hardware yet.

## Requirements

- Node 22+ and pnpm
- ffmpeg and ffprobe on `PATH`
- A screen recorder, one of:
  - **native (default):** on Wayland (KDE, GNOME, wlroots) it records the PipeWire monitor streams from the xdg screen-cast portal with GStreamer (`gst-launch-1.0` with `pipewiresrc` and an H.264 encoder: `x264enc`, `openh264enc` or VA-API, whichever is installed; on KDE it reuses the remote-control approval, so no extra dialog). `screenpilot doctor` prints the install command for your distro if a piece is missing (Fedora: `sudo dnf install gstreamer1 pipewire-gstreamer gstreamer1-plugin-openh264`; Debian/Ubuntu: `sudo apt install gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-ugly`). On X11 and Windows it records with ffmpeg; on macOS with ffmpeg's avfoundation (see [macOS notes](#macos-notes)).
  - **OBS Studio 28+** (`--recorder obs`) with the WebSocket server enabled (Tools -> WebSocket Server Settings), if you prefer OBS's encoders and settings.
- Network access for the default Edge voices (voiceover and `voices`). The `local` and `command` voice providers need none (local models need `voice-setup` once, which needs `uv` and the internet).
- KDE Wayland: pointer position comes from a KWin script. Click capture needs your user to be in the `input` group (see below).
- Windows and X11: the pointer is polled and clicks come from a global hook (uiohook); the active window is logged too. macOS: the pointer and active window are polled from Quartz, clicks come from uiohook (Input Monitoring permission). Other Wayland compositors: no pointer logging (zooms come from a performed take's own clicks or the storyboard).
- Typing non-Latin text on Wayland goes through the clipboard and needs `wl-clipboard` (`wl-copy`); X11 and Windows type any Unicode directly.

With `--recorder obs`, the first recording creates a `screenpilot` scene in OBS with one screen-capture source; on Wayland the system asks once which screen to share. With several monitors, pass `--screen <name>` (e.g. `eDP-1`) so pointer coordinates are matched to the monitor OBS records; screenpilot first matches the OBS source name against monitor models reported by KWin (e.g. "Lenovo R24e | Monitor" → HDMI-A-5), then falls back to the monitor under the cursor. If it guessed wrong, fix the session afterwards with `screenpilot remap <session> --screen <name>` (the raw pointer log is kept in `pointer.raw.jsonl`). screenpilot reuses a screen-capture source you already have in OBS when one is showing pixels, so the portal picker does not reappear.

### KDE Wayland: the `input` group trade-off

Wayland does not let apps observe global input. screenpilot reads mouse buttons straight from `/dev/input` (evdev), which requires membership of the `input` group:

```sh
sudo usermod -aG input "$USER"   # then log out and back in
```

Be aware: members of `input` can read ALL keyboard and mouse input system-wide, including passwords typed in any app. Only do this on a machine and account you trust, and consider removing yourself afterwards (`sudo gpasswd -d "$USER" input`). Without it you can still record without click capture (input adapter `none`, or `kwin` for pointer only); you lose click ripples, and zoom suggestions fall back to where the pointer came to rest.

## Install from source (developers)

```sh
pnpm install
pnpm build
node dist/cli.js setup --in-place   # optional: add this checkout to your AI apps
```

Binaries: `dist/cli.js` (`screenpilot`) and `dist/mcp.js` (`screenpilot-mcp`).

`pnpm package --ffmpeg-dir <dir>` builds the release files for the OS it runs on (Node, ffmpeg and ffprobe included). Pushing a `v*` tag makes `.github/workflows/release.yml` build them on Windows and Linux runners and publish a GitHub Release.

## Quick start (CLI)

```sh
screenpilot record                          # perform your demo, then stop
screenpilot analyze sessions/<timestamp>    # contact sheet, idle spans, clicks
screenpilot frames sessions/<ts>/video.mkv --at 3,9,15 --grid
screenpilot init sessions/<ts> --suggest --voice ar-EG-SalmaNeural
# or a local voice: screenpilot init sessions/<ts> --suggest --provider local --voice voicetut:Sarah
# edit sessions/<ts>/storyboard.json
screenpilot validate sessions/<ts>/storyboard.json
screenpilot render sessions/<ts>/storyboard.json -q draft
screenpilot check sessions/<ts>/storyboard.mp4
screenpilot render sessions/<ts>/storyboard.json -q delivery -o demo.mp4
```

`screenpilot voices --lang ar-EG` lists Edge voices; `screenpilot voices --provider local|command` lists local models' voices or the command voices you defined. `screenpilot voice-setup [voicetut|namaa] [--dir <path>] [-y]` installs a local model (see [Voice providers](#voice-providers)). `screenpilot schema` prints the JSON Schema. `screenpilot preview` opens HyperFrames Studio.

More render options:

```sh
screenpilot render sessions/<ts>/storyboard.json -q draft --from 12 --to 20   # review only OUTPUT seconds 12-20 (writes storyboard.part-12-20.mp4)
screenpilot render sessions/<ts>/storyboard.json --formats 16:9,9:16,1:1      # one file per format: storyboard.16x9.mp4, .9x16.mp4, .1x1.mp4
screenpilot sequence sequence.json                                            # join several storyboards into one video (see Combine recordings)
```

`--formats` takes `16:9`, `9:16`, `1:1` or any `WxH` (even sizes), comma separated; `-o` then sets the base name and `--build-dir` is not allowed. Narration is synthesized once for all formats. A portrait or square export crops window-framed views from a landscape recording (they fill the frame); monitor views show the whole monitor.

## MCP setup

`screenpilot setup` does this for you:

- `--clients codex,opencode` limits it to those clients;
- `--remove` takes it out;
- `--output <dir>` sets where videos go;
- `--allow-tools` (Claude Code) lets the agent use every ScreenPilot tool without asking each time; it adds `mcp__screenpilot` to `permissions.allow` in `~/.claude/settings.json` (your other entries and comments stay, the file is backed up first, and `--remove` takes the rule out again).

To configure by hand: the server speaks stdio. Use an absolute path to the built file.

Claude Code:

```sh
claude mcp add screenpilot -- node /abs/path/to/screenpilot/dist/mcp.js
```

OpenCode (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "screenpilot": {
      "type": "local",
      "command": ["node", "/abs/path/to/screenpilot/dist/mcp.js"],
      "enabled": true
    }
  }
}
```

OpenCode 2.x also accepts its newer layout, `mcp.servers.screenpilot` with `"disabled": false`. Setup uses that layout when your file already does.

Other clients: any MCP client that can launch a stdio server with that command. The server sends the workflow as MCP `instructions`, so agents without the skill still know the steps.

Copy or symlink `skill/` to `~/.claude/skills/screenpilot` to give Claude Code the workflow skill. Other agents can read `AGENTS.md`.

### Tools

| Tool | Purpose |
| --- | --- |
| `record_start`, `record_stop` | Start/stop a recording (one at a time) |
| `analyze` | Idle spans, clicks, suggestions + contact sheet image |
| `get_frames` | Source frames as images, optional 0..1 grid (max 12/call) |
| `storyboard_schema` | JSON Schema of the storyboard |
| `storyboard_init` | Starter storyboard for a session or video (`suggest` pre-fills cuts and zooms; `voice` and `provider` set the voice) |
| `storyboard_validate` | Schema errors and lint warnings |
| `voices` | List voices (`provider`: `edge` default, `local`, `command`; `lang` filters) |
| `build` | Voice + cut + HyperFrames project, no render |
| `render` | Render to MP4 (`draft` / `looks` / `delivery`); `from`/`to` (OUTPUT seconds) render only that window for a fast review; `formats` (`["16:9","9:16"]`, `"WxH"`) writes one file per format |
| `preview` | Open HyperFrames Studio |
| `sequence_schema`, `sequence_validate`, `sequence_render` | Join several storyboards (each with its own recording) into one video: schema of `sequence.json`, check it and every storyboard it uses, render it |
| `check_output` | Frames of the rendered video for review |
| `screenshot`, `windows` | See the desktop: per-monitor images (optional 0..1 grid) and the KWin window list |
| `focus_window`, `pointer_move`, `click`, `drag`, `scroll`, `key`, `type_text` | Drive the real mouse and keyboard (coordinates normalized 0..1 per monitor) |
| `browser_open`, `web_locate` | Clean demo browser; find an element's screen rectangle by selector |
| `wait_for`, `page_text` | Check an action worked: wait for a window or a browser element; read the demo browser's URL, title and visible text |
| `take_schema`, `perform`, `abort` | Schema of `take.json`; perform a take (`dryRun` to rehearse); stop driving |
| `resume` | Carry on after someone moved the pointer and stopped the action (the driver stays open) |

`record_start` also takes `screens` (`"all"` or monitor names) and `map` (OBS source name to monitor name). Drive tools open one remote-control session on first use and keep it for the life of the server.

## Let the agent drive

The agent can operate the desktop itself while it records: it looks (`screenshot`, `windows`), acts (move, click, type, drag, scroll, keys, a clean demo browser), then writes a `take.json` and performs it. Each take produces a recording, `events.jsonl` and a starter `storyboard.json` (zooms, narration, captions, monitor switches) ready for the normal edit and render loop.

Requirements

- KDE Plasma or GNOME on Wayland: driving uses the RemoteDesktop portal; approve the "remote control" dialog once and select all monitors. The token is saved in `~/.config/screenpilot/state.json` (chmod 600), so later runs are silent. On GNOME there is no window control, so use `{screen, x, y}` targets (no `focus`, `waitForWindow`, `{window}` or `{web}` targets).
- X11 (any desktop with an EWMH window manager): XTest, no dialog. Everything works, including `{web}` targets and window framing.
- Windows: see [Windows notes](#windows-notes).
- Recording uses the native recorder by default. With `--recorder obs`, OBS needs one capture source per monitor (or one for the whole desktop); names usually match the monitors, otherwise pass `--map "Source Name=HDMI-A-1"` (saved for next time). `screenshot` reads the OBS sources.
- The demo browser (`screenpilot browser`) uses its own profile at `~/.config/screenpilot/browser`, with downloads going to `~/Downloads` without prompts. Your normal browser is untouched.

Commands

```sh
screenpilot screenshot [--screen eDP-1] [--grid]   # what each monitor shows
screenpilot windows                                # open windows and their geometry
screenpilot browser --screen HDMI-A-1 --url https://example.com
screenpilot drive move eDP-1,0.5,0.5               # also: drive click, type, key, scroll (testing)
screenpilot perform take.json --dry-run            # rehearse: same actions, no recording
screenpilot perform take.json                      # record + drive; writes session dir + storyboard.json
screenpilot record --screens all                   # record every monitor side by side (manual demos too)
```

Targets in a take: `{screen, x, y}` (normalized 0..1 per monitor), `{web: "selector"}` (Playwright selector in the demo browser; preferred) or `{window: "match", x, y}`. `screenpilot take-schema` / MCP `take_schema` print the full `take.json` schema.

Safety

- The real mouse and keyboard are used. Touching the mouse during a take aborts it. Ctrl+C (or MCP `abort`) stops it too. Live MCP driving stops the same way, and `resume` carries on afterwards; set `SCREENPILOT_INTERRUPT=off` for unattended agent runs (only `abort` stops it then).
- Optional limits for unattended agents (all unset by default): `SCREENPILOT_ALLOW_APPS` (comma list of apps that may receive clicks and typing), `SCREENPILOT_ALLOW_ENV` (env vars `{env}` may type), `SCREENPILOT_PERFORM_TIMEOUT` (seconds before a take is aborted). Every MCP drive action is logged to `audit.jsonl` in the config folder (typed text is never logged). `screenpilot setup --allow-tools` lets Claude Code use the tools without a prompt each time.
- Never put secrets in `take.json`: use `{"type": {"env": "VAR"}}`; the value is read from the environment and never logged or echoed.
- Rehearse with `--dry-run` before recording.

Limitations: see [Platform support](#platform-support). On wlroots compositors (sway, Hyprland) driving is not possible (no RemoteDesktop portal); recording still works.

## Framing two monitors

Four ways to frame what was recorded (all tested on KDE Wayland with two 1920x1080 monitors):

| You want | take.json / record | storyboard |
|---|---|---|
| The window being used, nothing else (no panel, tray or other apps); pans when you switch windows. **Default** for `perform` and `init --suggest` | `"camera": "window"` (default) | `views` with `rect` (filled from `windows.jsonl`; `init --frame window`) |
| One monitor only; the other never appears | `"screens": ["HDMI-A-5"]` (CLI `record --screens HDMI-A-5`) | nothing special |
| Both recorded, the video shows one at a time and pans to where the action is | `"screens": "all"` | `views` (filled from the pointer by `perform` / `init --suggest`; edit or add `{at, screen, transition: "pan"\|"cut"}`) |
| Both side by side the whole time | `"screens": "all"` | `"views": []` and an ultrawide `"output": {"width": 2560, "height": 720}` |

With window framing, KWin reports the active window over time (`windows.jsonl`, the part not covered by panels), and takes place windows at 16:9 inside the monitor's usable area so the camera shows them whole. For your own recordings, `screenpilot record --fit-window <class or title>` does the same for one window and puts it back afterwards (MCP `record_start` `fitWindow`). A window view fills the frame (its longer side is trimmed if it is not 16:9); monitor views show the whole monitor.

Zooms, highlights and callouts use coordinates normalized to the whole recording (both monitors), so they work in all three. If OBS has one source that shows the whole desktop, screenpilot uses it (cropped for a single monitor); otherwise it places one source per monitor. Which source shows which monitor is worked out by comparing the pictures.

While recording, screenpilot closes notification popups already on screen (KDE) and asks the desktop to hold new ones (freedesktop `Notifications.Inhibit`; released when recording stops or the process dies). Plasma already does this during screen sharing; critical notifications (e.g. low memory) still show. Notification servers without `Inhibit` (GNOME Shell, most X11 daemons) are left alone: turn on Do Not Disturb yourself.

Window framing needs the active window over time: KDE, X11 and Windows log it; on other Wayland desktops window views fall back to monitor views.

Renders use 2 headless-Chrome workers by default (`--workers`): more is faster but can push a desktop that is also running OBS and browsers out of memory.

## Look and shot are the agent's choice

ScreenPilot has no house style. The defaults are only a fallback: the MCP server tells every connected AI app to design each video for its purpose and audience. That covers the output size (16:9, 9:16 for Reels/TikTok, 1:1), the theme, any Google Font, its own CSS for captions and cards, bilingual captions (`"English\nعربي"`), and the shot (which monitors to record, and whether the camera follows the window, the whole screen or all screens side by side, switching per moment). [`assets/demo`](assets/demo) has the README video's take, storyboard and theme as an example.

## Combine recordings

A `sequence.json` joins several storyboards, each with its own recording, into one MP4. Its main use: **insert a feature clip into the middle of an existing demo without re-recording the demo.** Record only the new feature, give it a storyboard, and split the demo's storyboard at the second where the feature belongs:

```json
{
  "version": 1,
  "parts": [
    { "storyboard": "demo.json", "to": 42 },
    { "storyboard": "feature/feature.json", "transition": { "type": "crossfade" } },
    { "storyboard": "demo.json", "from": 42, "transition": { "type": "crossfade" } }
  ]
}
```

`feature.json` can take the demo's look with `"extends": "../demo.json"` (it inherits `theme`, `voice`, `output`, `music` and `keepSourceAudio`) and only adds its own `source`, `segments`, captions and narration. Then:

```sh
screenpilot sequence-validate sequence.json   # checks the sequence and every storyboard it uses
screenpilot sequence sequence.json -q draft   # writes sequence.mp4 (-o to change it)
```

- `parts`: storyboards in playing order. Paths are relative to `sequence.json`. The same storyboard can appear more than once.
- `from` / `to` on a part: a source range `[from, to)` of that storyboard, in source seconds. The slices `{to: 42}` and `{from: 42}` together keep everything once. Narration that started before `from` is dropped; zooms, captions and highlights that straddle an edge are cut to the range (dropped if under 0.5 s is left); the camera view in force at `from` carries in; cards and overlays are clipped too.
- `transition` on a part: how it enters from the previous one: `cut` (default), `crossfade`, `fade-black`, `wipe-left`, `wipe-right`, `slide-left`, `slide-right`; `dur` defaults to 0.5 s and is clamped to half of either neighbouring part. Ignored on the first part.
- `output` (optional): `width`, `height`, `fps` for every part. Default: the first part's `output`. All parts are rendered at that one size.
- `intro` plays only on the first part and `outro` only on the last; the others are ignored.
- Each part is rendered like a storyboard and cached in `sequence.build/`; unchanged parts are reused on the next run. The join is a stream copy when all parts are cut together with the same encoding, otherwise a re-encode.

`screenpilot sequence-schema` (MCP `sequence_schema`) prints the JSON Schema; `sequence_validate` and `sequence_render` are the MCP equivalents of the two commands above (`sequence_render` takes `sequence`, `output`, `quality`).

## Storyboard reference

Times are source seconds; positions are normalized 0..1 (x from left, y from top). Paths are relative to the storyboard file. `screenpilot schema` is authoritative.

Top level

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `version` | `1` | 1 | |
| `extends` | string | | Base storyboard (relative path; it may extend another, cycles are an error) to take `theme`, `voice`, `output`, `music` and `keepSourceAudio` from. Objects merge key by key with this file winning, arrays replace; `music.src` is rebased. Nothing else is inherited |
| `source` | string | required | Raw recording |
| `events` | string | | `events.jsonl` from `record` (click ripples) |
| `keepSourceAudio` | boolean | false | |
| `segments` | Segment[] | [] | Parts to keep, in order; empty = whole video |
| `holds` | Hold[] | [] | Freeze frames |
| `zooms` | Zoom[] | [] | |
| `captions` | Caption[] | [] | |
| `highlights` | Highlight[] | [] | |
| `narration` | Narration[] | [] | |
| `intro`, `outro` | Card | | Title cards |
| `cards` | ChapterCard[] | [] | Chapter cards in the middle of the video |
| `overlays` | Overlay[] | [] | Images, video or logos on top of the output frame |
| `music` | Music | | Background music |
| `output`, `theme`, `voice` | objects | defaults | |

Items

| Item | Fields |
| --- | --- |
| Segment | `in`, `out` (out > in), `speed` 0.25..16 (1), `volume` 0..4 and `mute` (source audio of this segment; need `keepSourceAudio` and a recording with sound) |
| Hold | `at`, `dur` |
| Zoom | `at` (fully in), `dur`, `x`, `y`, `scale` 1..4 (1.8) |
| Caption | `at`, `dur` (3), `text`, `position` bottom/top/center (bottom), `style` pill/title/callout (pill), `x`,`y` (callout anchor) |
| Highlight | `at`, `dur` (2), `x`, `y`, `w`, `h`, `label?` |
| Narration | `at`, `text`, `voice?`, `caption?` |
| Card | `title`, `subtitle?`, `dur` (3) |
| ChapterCard | `at` (source time; the video freezes there), `dur` (2.5), `title`, `subtitle?`. A full card with fades; dropped with a warning if `at` is in a cut region |
| Overlay | `src` (image or video), `x`, `y`, `w`, `h` (0..1 of the OUTPUT frame), `at?`, `dur?` (source time; omit both for the whole video, `at` alone = until the end), `fit` contain/cover (contain), `opacity` 0..1 (1), `radius?` (output px), `shadow?`, `motion?` (default fade), `mute` (true), `loop` (false) |
| Music | `src`, `volume` 0..1 (0.12), `duck?` (`amount` 0..1 (0.6), `attack` 0..5 s (0.2), `release` 0..5 s (0.5)) lowers the music under narration |
| output | `width` 1920, `height` 1080, `fps` 30 |
| voice | `provider` edge (or `local`, `command`), `name` en-US-AndrewNeural (`voicetut`, `voicetut:Sarah`, `namaa`, or a `voices.json` key), `rate` +0%, `subtitles` true, `gap` 0.3, `volume` 1 |
| theme | `background`, `padding` 0.05, `radius` 16, `shadow`, `accent`, `font`, `captionColor`, `captionBackground`, `clickRipples` true, `fonts` (extra Google Fonts), `css` (your own CSS; classes listed in `storyboard_schema`) |

When a narration line is longer than its slot, the render freezes the video automatically so lines never overlap.

`validate` also warns about style problems (it never blocks a render): narration over 12 words or too fast to speak, captions over 6 words, captions or zooms that overlap, zoom scale outside 1.4-2.5, a zoom, highlight and callout stacked on one point, segment speed over 8x, an output shorter than 15 s or longer than 90 s, and cards in cut regions.

## Voice providers

`voice.provider` in a storyboard (or in `take.json`'s `voice`, which takes `provider` and `name`) picks who speaks. The default is `edge`, so existing storyboards are unchanged.

| Provider | `name` | Notes |
| --- | --- | --- |
| `edge` | An Edge voice, e.g. `en-US-AndrewNeural` | Needs the internet; unofficial service, may change |
| `local` | `voicetut`, `voicetut:<Voice>` or `namaa` | Speech models on this computer; installed by `screenpilot voice-setup` |
| `command` | A key of `commands` in `voices.json` | Any program that writes audio to `{out}`; defined by the user, never in a storyboard |

A narration line's own `voice` overrides `name` within the same provider. For `local`, the language of each line is detected (Arabic letters mean Arabic, otherwise English); `rate` becomes a speed factor for VoiceTut and NAMAA ignores it.

- **Local models** run in one long-lived Python worker, `python/tts_worker.py`, started once per render (the model loads in about 20 s; clips are cached). TypeScript talks to it over stdin/stdout, one JSON object per line (protocol 1: a `ready` line, then requests `synth`, `voices`, `doctor`, `quit`, each with an `id`). Stdout is reserved for the protocol; the worker logs to stderr. The TypeScript side is `src/voice/local.ts` (`LocalWorker`, `createLocalProvider`).
- **Command voices** (`src/voice/command.ts`) are read from `voices.json` (`src/voice/config.ts`): `~/.config/screenpilot/voices.json` on Linux and macOS, `%APPDATA%\screenpilot\voices.json` on Windows, or the file named by `SCREENPILOT_VOICES_FILE`. Each entry has `command` (program and arguments, no shell; placeholders `{text} {rate} {speed} {lang} {out}`), optional `stdin`, `ext`, `timeout` and `env`. The file lives with the user so a shared or AI-written storyboard can never run a program. The same file can set `local.python` and `local.env`.
- **`voice-setup`** (`src/setup/voice.ts`) installs a model with `uv` (which also fetches Python 3.11) into a folder outside the app folder, because setup wipes the app folder on every update: `~/.local/share/screenpilot-voices` (Linux), `%LOCALAPPDATA%\ScreenPilot-voices` (Windows), `~/Library/Application Support/ScreenPilot-voices` (macOS), or `--dir`. It checks free disk, asks to confirm unless `-y`, installs PyTorch and third-party code pinned to tested commits (OmniVoice and VoiceTut; chatterbox-tts for NAMAA), downloads the model and speaks one test line. VoiceTut is about 10.5 GB (up to 15 GB while installing); NAMAA adds about 5.5 GB.
- **Your own Python:** `SCREENPILOT_LOCAL_PYTHON` names a Python with the model packages; `SCREENPILOT_LOCAL_DEVICE` is `auto` (default), `cuda`, `cpu` or `mps`.
- **Adding a model:** an adapter class in `python/tts_worker.py`, its name in `LOCAL_MODELS` (`src/voice/local.ts`), and its install step in `src/setup/voice.ts`.
- **Tests:** `test/voice-*.test.ts` use fake workers in `test/fixtures` (`fake-tts-worker.mjs`, `fake-command-tts.mjs`), so CI needs no models. `python/smoke_test.py` is a manual end-to-end check that needs the models installed.

Measured on an NVIDIA RTX 2050 with 4 GB on Linux: VoiceTut peaks at 2.1 GB of GPU memory and runs about 1.4 times slower than real time; NAMAA peaks at 3.2 GB at a similar speed. Windows, macOS and CPU speed were not tested. VoiceTut's authors report a word error rate of 0.40 for Arabic against 0.07 for English; NAMAA's model card says it can miss the "ق" sound and misread numbers.

## Windows notes

Windows support is new and verified on every push by CI on a real Windows runner (`pnpm smoke:windows`): monitors, pointer injection (0–1 px), Notepad focus/16:9/fit-restore, Unicode typing incl. Arabic and emoji (checked through the clipboard), the Chrome demo browser with trusted clicks, native screenshots and recording (ffmpeg gdigrab, no OBS), and a recorded take that produces a storyboard. The runner has one 1024x768 monitor, so multi-monitor layouts and display scaling are not covered there: on your own PC run

```sh
pnpm install
pnpm windows:live   # doctor --input, smoke test, a narrated take across your monitors + draft render
```

and look at (or send) `windows-live-report/`. `screenpilot doctor` alone reports what is found (ffmpeg, monitors, OBS, browser, voices, and a "local voice" check that is skipped until `voice-setup` has run); add `--input` to also test pointer injection.

- Driving uses `SendInput`. Windows you run elevated (as administrator) cannot be controlled from a non-elevated process: run screenpilot elevated too.
- Coordinates are physical pixels.
- Holding notification popups and closing them are no-ops on Windows.
- Recording is native by default (ffmpeg `gdigrab`, mouse pointer included); `--recorder obs` maps OBS display-capture sources to monitors by their `monitor_id`.
- The demo browser is Chrome, Edge or Brave (first found); set `SCREENPILOT_BROWSER` to pick another.
- The `open` take step opens a file or URL with the default app (the URL protocol handler on Windows, `xdg-open` on Linux, `open` on macOS).

## macOS notes

macOS 12+ on Apple Silicon and Intel. Recording, screenshots, driving (pointer, clicks, typing incl. Arabic and emoji, shortcuts), the window list, focusing/placing windows and the demo browser all work without OBS. The macOS download includes ffmpeg; from source you need it yourself (`brew install ffmpeg`). Web demos need Chrome, Edge or Brave in `/Applications`.

macOS asks for privacy permissions, and grants them to the app that starts ScreenPilot (Claude, Cursor, VS Code, Terminal...), not to ScreenPilot itself. Open System Settings > Privacy & Security and turn that app on under:

| Permission | Needed for | Without it |
|---|---|---|
| Accessibility | moving the mouse, clicking, typing, focusing and resizing windows | driving fails with these same steps in the error |
| Screen & System Audio Recording (Screen Recording on macOS 14 and older) | recording, screenshots, window titles | recording fails with these steps; macOS adds the app to the list the first time |
| Input Monitoring | logging your own clicks while you record (click zooms/ripples) | recordings have no click events (optional) |

Then quit and reopen that app. When a permission is missing ScreenPilot opens the right settings pane and its error names the app to allow. `screenpilot doctor` lists all three plus ffmpeg, avfoundation and the browser.

- Coordinates are points (the unit macOS, its window list and web pages use), not pixels: a Retina display is reported at its "looks like" size. Recordings keep full Retina detail (2 pixels per point), capped at 4096x2304 for 5K and multi-monitor canvases; pointer and window logs are normalized to the video, so zooms land right either way.
- Monitors are named as in System Settings ("Built-in Retina Display", "DELL U2720Q"); identical models get " (2)".
- Shortcuts are literal: `ctrl+c` is Control-C. Use `cmd+c` (`super`/`meta`/`win` also mean Command, `alt`/`option` mean Option).
- Notification banners and Focus modes have no public API: turn on Do Not Disturb yourself before recording.
- Minimized windows and windows on other Spaces are not listed. Full-screen windows leave full screen when a take places them.

CI: `.github/workflows/macos.yml` runs tests and `pnpm smoke:macos` on a real Apple Silicon runner when `src/platform/macos` or the macOS recorder changes (or by hand from the Actions tab); macOS minutes cost 10x on private repos, so the job is short. The runner cannot grant privacy permissions, so checks that need one are reported as "blocked" in `smoke-report/report.json` rather than failed. On your own Mac, run `pnpm smoke:macos` from a terminal that has the permissions above. `.github/workflows/macos-multidisplay.yml` (manual, or pushes to `ci/macos-multidisplay`) adds a virtual 1512x982-point HiDPI display next to the runner's display (private CGVirtualDisplay API, `scripts/macos/vdisplay.swift`) and runs `pnpm smoke:macos-multidisplay`: display rects/pixels/scale, pointer read-back on both, TextEdit on the Retina display, screenshot and recording sizes and layout.

CI: GitHub Actions. `.github/workflows/ci.yml` (Linux: typecheck, tests, build; plus `smoke:x11` under Xvfb + openbox: monitors, XTest pointer read-back, typing "Hello مرحبا 123" into a Tk window and reading it back, window list/focus/fit-restore, the demo browser, an x11grab recording that must decode, and a recorded take → storyboard) runs on every push and pull request to `main`; `.github/workflows/windows.yml` (tests + `smoke:windows` on a real Windows runner) runs only when code that behaves differently on Windows changes (`src/platform`, `src/record`, `src/drive`, `src/take`, `src/util`, `scripts`, dependencies), or by hand from the Actions tab, since Windows minutes count double on private repos.

## Limitations

- Driving the desktop (`perform`, `drive`, `screenshot`) works on KDE Wayland, X11, GNOME Wayland (no window control), Windows and macOS; not on wlroots compositors.
- Wayland desktops other than KDE expose no window list and no pointer position: no window framing, no `{web}`/`{window}` targets, no pointer log for your own recordings.
- The default Edge voices need the internet and are an unofficial service that may change. Local voices (`voice-setup`) were tested on Linux with an NVIDIA GPU only; Windows, macOS and CPU speed are untested. `voice-setup` needs `uv` and about 10 GB; local models are slower than real time on a 4 GB card.
- Native recording covers Linux (Wayland through the screen-cast portal, X11 through ffmpeg), Windows and macOS.
- X11 with fractional/HiDPI scaling is recorded in X pixels as reported by XRandR.
- Click capture on KDE Wayland needs the `input` group; on macOS the app that starts ScreenPilot needs Accessibility (and Input Monitoring).
- Rendering is not fast: use `draft` while iterating.
- Narration in cut regions is dropped; the agent must keep lines inside kept segments.
- `sequence` has no `--from`/`--to` or `--formats`: render a part's storyboard for those, or run it per format with a `sequence.json` whose `output` has that size.

## License

By contributing you agree that your work is released under the [MIT license](LICENSE).
