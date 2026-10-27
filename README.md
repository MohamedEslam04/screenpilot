# demoreel

Record any desktop app, let an AI agent write the storyboard, get a polished demo video.

1. **Record** the screen (OBS) plus pointer and click events.
2. **Analyze**: the agent looks at a contact sheet and frames with a coordinate grid.
3. The agent writes `storyboard.json`: cuts, speed-ups, zooms, captions, highlights, voiceover lines.
4. **Render** an MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + GSAP) and Edge TTS voiceover.

## Why

Playwright can only record a browser. demoreel records anything on screen (native apps, IDEs, terminals, Electron) on Linux (including KDE Wayland), Windows and macOS, and gives an AI agent the tools to see the footage and edit it.

## Requirements

- Node 22+ and pnpm
- ffmpeg and ffprobe on `PATH`
- OBS Studio 28+ with the WebSocket server enabled (Tools -> WebSocket Server Settings). OBS must be running while recording.
- Network access for Edge TTS (voiceover and `voices`)
- KDE Wayland: pointer position comes from a KWin script. Click capture needs your user to be in the `input` group (see below).
- Windows, macOS and X11: pointer and clicks come from a global hook (uiohook). Other Wayland compositors: no pointer logging yet (zooms come from the storyboard only).

The first recording creates a `demoreel` scene in OBS with one screen-capture source; on Wayland the system asks once which screen to share. With several monitors, pass `--screen <name>` (e.g. `eDP-1`) so pointer coordinates are matched to the monitor OBS records; demoreel first matches the OBS source name against monitor models reported by KWin (e.g. "Lenovo R24e | Monitor" → HDMI-A-5), then falls back to the monitor under the cursor. If it guessed wrong, fix the session afterwards with `demoreel remap <session> --screen <name>` (the raw pointer log is kept in `pointer.raw.jsonl`). demoreel reuses a screen-capture source you already have in OBS when one is showing pixels, so the portal picker does not reappear.

### KDE Wayland: the `input` group trade-off

Wayland does not let apps observe global input. demoreel reads mouse buttons straight from `/dev/input` (evdev), which requires membership of the `input` group:

```sh
sudo usermod -aG input "$USER"   # then log out and back in
```

Be aware: members of `input` can read ALL keyboard and mouse input system-wide, including passwords typed in any app. Only do this on a machine and account you trust, and consider removing yourself afterwards (`sudo gpasswd -d "$USER" input`). Without it you can still record without click capture (input adapter `none`, or `kwin` for pointer only); you lose click ripples, and zoom suggestions fall back to where the pointer came to rest.

## Install

```sh
pnpm install
pnpm build
```

Binaries: `dist/cli.js` (`demoreel`) and `dist/mcp.js` (`demoreel-mcp`).

## Quick start (CLI)

```sh
demoreel record                          # perform your demo, then stop
demoreel analyze sessions/<timestamp>    # contact sheet, idle spans, clicks
demoreel frames sessions/<ts>/video.mkv --at 3,9,15 --grid
demoreel init sessions/<ts> --suggest --voice ar-EG-SalmaNeural
# edit sessions/<ts>/storyboard.json
demoreel validate sessions/<ts>/storyboard.json
demoreel render sessions/<ts>/storyboard.json -q draft
demoreel check sessions/<ts>/storyboard.mp4
demoreel render sessions/<ts>/storyboard.json -q delivery -o demo.mp4
```

`demoreel voices --lang ar-EG` lists voices. `demoreel schema` prints the JSON Schema. `demoreel preview` opens HyperFrames Studio.

## MCP setup

The server speaks stdio. Use an absolute path to the built file.

Claude Code:

```sh
claude mcp add demoreel -- node /abs/path/to/demoreel/dist/mcp.js
```

OpenCode (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "demoreel": {
      "type": "local",
      "command": ["node", "/abs/path/to/demoreel/dist/mcp.js"],
      "enabled": true
    }
  }
}
```

Other clients: any MCP client that can launch a stdio server with that command.

Copy or symlink `skill/` to `~/.claude/skills/demoreel` to give Claude Code the workflow skill. Other agents can read `AGENTS.md`.

### Tools

| Tool | Purpose |
| --- | --- |
| `record_start`, `record_stop` | Start/stop a recording (one at a time) |
| `analyze` | Idle spans, clicks, suggestions + contact sheet image |
| `get_frames` | Source frames as images, optional 0..1 grid (max 12/call) |
| `storyboard_schema` | JSON Schema of the storyboard |
| `storyboard_init` | Starter storyboard for a session or video (`suggest` pre-fills cuts and zooms) |
| `storyboard_validate` | Schema errors and lint warnings |
| `voices` | List Edge TTS voices |
| `build` | Voice + cut + HyperFrames project, no render |
| `render` | Render to MP4 (`draft` / `looks` / `delivery`) |
| `preview` | Open HyperFrames Studio |
| `check_output` | Frames of the rendered video for review |
| `screenshot`, `windows` | See the desktop: per-monitor images (optional 0..1 grid) and the KWin window list |
| `focus_window`, `pointer_move`, `click`, `drag`, `scroll`, `key`, `type_text` | Drive the real mouse and keyboard (coordinates normalized 0..1 per monitor) |
| `browser_open`, `web_locate` | Clean demo browser; find an element's screen rectangle by selector |
| `take_schema`, `perform`, `abort` | Schema of `take.json`; perform a take (`dryRun` to rehearse); stop driving |

`record_start` also takes `screens` (`"all"` or monitor names) and `map` (OBS source name to monitor name). Drive tools open one remote-control session on first use and keep it for the life of the server.

## Let the agent drive

The agent can operate the desktop itself while OBS records: it looks (`screenshot`, `windows`), acts (move, click, type, drag, scroll, keys, a clean demo browser), then writes a `take.json` and performs it. Each take produces a recording, `events.jsonl` and a starter `storyboard.json` (zooms, narration, captions, monitor switches) ready for the normal edit and render loop.

Requirements

- KDE Plasma on Wayland. Driving uses the RemoteDesktop portal; approve the KDE "remote control" dialog once and select all monitors. The token is saved in `~/.config/demoreel/state.json` (chmod 600), so later runs are silent.
- OBS with one capture source per monitor. Names usually match the monitors; otherwise pass `--map "Source Name=HDMI-A-1"` (saved for next time). Screenshots and `record --screens all` use these sources.
- The demo browser (`demoreel browser`) uses its own profile at `~/.config/demoreel/browser`, with downloads going to `~/Downloads` without prompts. Your normal browser is untouched.

Commands

```sh
demoreel screenshot [--screen eDP-1] [--grid]   # what each monitor shows
demoreel windows                                # open windows and their geometry
demoreel browser --screen HDMI-A-1 --url https://example.com
demoreel drive move eDP-1,0.5,0.5               # also: drive click, type, key, scroll (testing)
demoreel perform take.json --dry-run            # rehearse: same actions, no recording
demoreel perform take.json                      # record + drive; writes session dir + storyboard.json
demoreel record --screens all                   # record every monitor side by side (manual demos too)
```

Targets in a take: `{screen, x, y}` (normalized 0..1 per monitor), `{web: "selector"}` (Playwright selector in the demo browser; preferred) or `{window: "match", x, y}`. `demoreel take-schema` / MCP `take_schema` print the full `take.json` schema.

Safety

- The real mouse and keyboard are used. Touching the mouse during a take aborts it. Ctrl+C (or MCP `abort`) stops it too.
- Never put secrets in `take.json`: use `{"type": {"env": "VAR"}}`; the value is read from the environment and never logged or echoed.
- Rehearse with `--dry-run` before recording.

Limitations: driving is KDE Wayland only for now (Windows later). Recording on other platforms still works as described above.

## Framing two monitors

Four ways to frame what was recorded (all tested on KDE Wayland with two 1920x1080 monitors):

| You want | take.json / record | storyboard |
|---|---|---|
| The window being used, nothing else (no panel, tray or other apps); pans when you switch windows. **Default** for `perform` and `init --suggest` | `"camera": "window"` (default) | `views` with `rect` (filled from `windows.jsonl`; `init --frame window`) |
| One monitor only; the other never appears | `"screens": ["HDMI-A-5"]` (CLI `record --screens HDMI-A-5`) | nothing special |
| Both recorded, the video shows one at a time and pans to where the action is | `"screens": "all"` | `views` (filled from the pointer by `perform` / `init --suggest`; edit or add `{at, screen, transition: "pan"\|"cut"}`) |
| Both side by side the whole time | `"screens": "all"` | `"views": []` and an ultrawide `"output": {"width": 2560, "height": 720}` |

With window framing, KWin reports the active window over time (`windows.jsonl`, the part not covered by panels), and takes place windows at 16:9 inside the monitor's usable area so the camera shows them whole. For your own recordings, `demoreel record --fit-window <class or title>` does the same for one window and puts it back afterwards (MCP `record_start` `fitWindow`). A window view fills the frame (its longer side is trimmed if it is not 16:9); monitor views show the whole monitor.

Zooms, highlights and callouts use coordinates normalized to the whole recording (both monitors), so they work in all three. If OBS has one source that shows the whole desktop, demoreel uses it (cropped for a single monitor); otherwise it places one source per monitor. Which source shows which monitor is worked out by comparing the pictures.

While recording, demoreel closes notification popups already on screen (KDE) and asks the desktop to hold new ones (freedesktop `Notifications.Inhibit`; released when recording stops or the process dies). Plasma already does this during screen sharing; critical notifications (e.g. low memory) still show.

Renders use 2 headless-Chrome workers by default (`--workers`): more is faster but can push a desktop that is also running OBS and browsers out of memory.

## Storyboard reference

Times are source seconds; positions are normalized 0..1 (x from left, y from top). Paths are relative to the storyboard file. `demoreel schema` is authoritative.

Top level

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `version` | `1` | 1 | |
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
| `music` | Music | | |
| `output`, `theme`, `voice` | objects | defaults | |

Items

| Item | Fields |
| --- | --- |
| Segment | `in`, `out` (out > in), `speed` 0.25..16 (1) |
| Hold | `at`, `dur` |
| Zoom | `at` (fully in), `dur`, `x`, `y`, `scale` 1..4 (1.8) |
| Caption | `at`, `dur` (3), `text`, `position` bottom/top/center (bottom), `style` pill/title/callout (pill), `x`,`y` (callout anchor) |
| Highlight | `at`, `dur` (2), `x`, `y`, `w`, `h`, `label?` |
| Narration | `at`, `text`, `voice?`, `caption?` |
| Card | `title`, `subtitle?`, `dur` (3) |
| Music | `src`, `volume` 0..1 (0.12) |
| output | `width` 1920, `height` 1080, `fps` 30 |
| voice | `provider` edge, `name` en-US-AndrewNeural, `rate` +0%, `subtitles` true, `gap` 0.3, `volume` 1 |
| theme | `background`, `padding` 0.05, `radius` 16, `shadow`, `accent`, `font`, `captionColor`, `captionBackground`, `clickRipples` true |

When a narration line is longer than its slot, the render freezes the video automatically so lines never overlap.

## Limitations

- Driving the desktop (`perform`, `drive`, `screenshot`) works on KDE Wayland only; Windows support is planned.
- Voiceover uses Edge TTS only (needs network; unofficial service, may change).
- Recording requires OBS; demoreel does not bundle a capture backend.
- Click capture on Wayland needs the `input` group; macOS will likely need Input Monitoring permission for the host app (untested).
- Rendering is not fast: use `draft` while iterating.
- Narration in cut regions is dropped; the agent must keep lines inside kept segments.

---

Docs synced to commit 6d2be88 ("feat: record --fit-window resizes one window to 16:9 while recording", 2026-10-27).
