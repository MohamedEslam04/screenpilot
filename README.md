# ScreenPilot

Your AI pilot for screen videos: it records anything on your screen (or drives the apps itself), then edits it into a polished video with zooms, captions and voiceover.

1. **Record** the screen (built in, or through OBS) plus pointer, click and active-window events.
2. **Analyze**: the agent looks at a contact sheet and frames with a coordinate grid.
3. The agent writes `storyboard.json`: cuts, speed-ups, zooms, captions, highlights, voiceover lines.
4. **Render** an MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + GSAP) and Edge TTS voiceover.

## Get it (no terminal needed)

ScreenPilot is a tool for the AI app you already use. It needs no API key and no account. Your AI app does the thinking, and ScreenPilot gives it the screen, the recorder and the video editor. Download from [Releases](https://github.com/MohamedEslam04/screenpilot/releases):

- **Windows:** download and run `ScreenPilot-<version>-windows-setup.exe`. It installs for your user only (no administrator password) and adds ScreenPilot to your AI apps, then shows you what it did. Windows will probably say "Windows protected your PC" because the installer is not signed yet: click **More info**, then **Run anyway**. Your antivirus may also ask about it, because ScreenPilot watches mouse clicks to make good zooms; allow it. If you are updating and an AI app is open, the installer asks you to close it first. To remove it, use Windows Settings -> Apps -> ScreenPilot -> Uninstall.
  - Prefer a zip? Extract `ScreenPilot-<version>-windows.zip` first (right-click -> Extract All; do not run it from inside the zip), then double-click `ScreenPilot Setup.cmd`.
  - Only use Claude Desktop? `ScreenPilot-<version>-windows.mcpb` installs it there with one double-click.
- **macOS (Apple Silicon or Intel):** unzip `ScreenPilot-<version>-macos-arm64.zip` (Intel Macs: `-macos-x64.zip`), open the `ScreenPilot` folder and double-click `Install ScreenPilot.command`. The first time, macOS may say it can't verify the developer: open System Settings -> Privacy & Security and click **Open Anyway**. Only use Claude Desktop? Double-click `ScreenPilot-<version>-macos-<arch>.mcpb` instead. When you first record or let the AI drive, macOS asks you to allow your AI app under Screen Recording and Accessibility.
- **Linux:** extract `ScreenPilot-<version>-linux.tar.gz`, then double-click `install.sh` (choose "Run" if your file manager asks; it opens a terminal to show the result) or run `./install.sh`. It also checks that built-in screen recording has what it needs (GStreamer with PipeWire and an H.264 encoder) and, if not, prints the exact command for your distro (Fedora, Ubuntu/Debian, Arch, openSUSE) and offers to run it. This is optional: recording with OBS and editing existing videos work without it.

Setup copies the app to `%LOCALAPPDATA%\ScreenPilot`, `~/Library/Application Support/ScreenPilot` or `~/.local/share/screenpilot`, and adds it to every AI app it finds on the computer:

- Claude Desktop (including the Microsoft Store version) and Claude Code (with the workflow skill)
- Codex, OpenCode, Gemini CLI, Qwen Code, GitHub Copilot CLI, Amazon Q, Goose, Warp
- Cursor, Windsurf, Devin Desktop, Antigravity, Kiro, Zed, LM Studio
- VS Code, VS Code Insiders, VSCodium, and the Cline and Roo Code extensions in any of them

JetBrains AI Assistant has no config file: use its "Import from Claude" button after setup. For any other MCP-capable tool, `screenpilot setup --print` shows the entry to paste, and `screenpilot setup --list` shows which tools were found.

Each config file is backed up first (`<file>.screenpilot-backup`), and your other entries and comments are kept. Videos are saved to `ScreenPilot` inside your Videos folder (wherever Windows or your desktop keeps it, e.g. OneDrive or a translated folder name; `~/Movies` on macOS). Setup also downloads the video renderer (about 100 MB, once) and makes a 2-second test video, so your first real video starts right away. Restart your AI app and ask it something like "record my screen while I show the signup flow, then make a video with Arabic voiceover". To remove it, use the Windows uninstaller above (or `Uninstall ScreenPilot.cmd` from the zip), or run `uninstall.sh` on Linux.

The packages include Node, ffmpeg and ffprobe. Install another AI app later? Run setup again. Don't run setup with `sudo`: it installs for your user and needs no admin rights.

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

Status: KDE Wayland is used daily; Windows, X11 and macOS each have a CI smoke test on a real runner (`smoke:windows`; `smoke:x11` under Xvfb + openbox; `smoke:macos`, where steps that need a privacy permission the runner can't grant are reported as blocked). The `portal` backend was verified by forcing it on KDE Wayland (monitors from the portal streams, recording); GNOME's monitor names come from Mutter's `DisplayConfig`, sway's and Hyprland's from `swaymsg` / `hyprctl`, but those three have not been run on real hardware yet.

## Requirements

- Node 22+ and pnpm
- ffmpeg and ffprobe on `PATH`
- A screen recorder, one of:
  - **native (default):** on Wayland (KDE, GNOME, wlroots) it records the PipeWire monitor streams from the xdg screen-cast portal with GStreamer (`gst-launch-1.0` with `pipewiresrc` and an H.264 encoder: `x264enc`, `openh264enc` or VA-API, whichever is installed; on KDE it reuses the remote-control approval, so no extra dialog). `screenpilot doctor` prints the install command for your distro if a piece is missing (Fedora: `sudo dnf install gstreamer1 pipewire-gstreamer gstreamer1-plugin-openh264`; Debian/Ubuntu: `sudo apt install gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-ugly`). On X11 and Windows it records with ffmpeg; on macOS with ffmpeg's avfoundation (see [macOS](#macos)).
  - **OBS Studio 28+** (`--recorder obs`) with the WebSocket server enabled (Tools -> WebSocket Server Settings), if you prefer OBS's encoders and settings.
- Network access for Edge TTS (voiceover and `voices`)
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
# edit sessions/<ts>/storyboard.json
screenpilot validate sessions/<ts>/storyboard.json
screenpilot render sessions/<ts>/storyboard.json -q draft
screenpilot check sessions/<ts>/storyboard.mp4
screenpilot render sessions/<ts>/storyboard.json -q delivery -o demo.mp4
```

`screenpilot voices --lang ar-EG` lists voices. `screenpilot schema` prints the JSON Schema. `screenpilot preview` opens HyperFrames Studio.

## MCP setup

`screenpilot setup` does this for you:

- `--clients codex,opencode` limits it to those clients;
- `--remove` takes it out;
- `--output <dir>` sets where videos go.

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

The agent can operate the desktop itself while it records: it looks (`screenshot`, `windows`), acts (move, click, type, drag, scroll, keys, a clean demo browser), then writes a `take.json` and performs it. Each take produces a recording, `events.jsonl` and a starter `storyboard.json` (zooms, narration, captions, monitor switches) ready for the normal edit and render loop.

Requirements

- KDE Plasma or GNOME on Wayland: driving uses the RemoteDesktop portal; approve the "remote control" dialog once and select all monitors. The token is saved in `~/.config/screenpilot/state.json` (chmod 600), so later runs are silent. On GNOME there is no window control, so use `{screen, x, y}` targets (no `focus`, `waitForWindow`, `{window}` or `{web}` targets).
- X11 (any desktop with an EWMH window manager): XTest, no dialog. Everything works, including `{web}` targets and window framing.
- Windows: see [Windows](#windows).
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

- The real mouse and keyboard are used. Touching the mouse during a take aborts it. Ctrl+C (or MCP `abort`) stops it too.
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

## Storyboard reference

Times are source seconds; positions are normalized 0..1 (x from left, y from top). Paths are relative to the storyboard file. `screenpilot schema` is authoritative.

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

## Windows

Windows support is new and verified on every push by CI on a real Windows runner (`pnpm smoke:windows`): monitors, pointer injection (0–1 px), Notepad focus/16:9/fit-restore, Unicode typing incl. Arabic and emoji (checked through the clipboard), the Chrome demo browser with trusted clicks, native screenshots and recording (ffmpeg gdigrab, no OBS), and a recorded take that produces a storyboard. The runner has one 1024x768 monitor, so multi-monitor layouts and display scaling are not covered there: on your own PC run

```sh
pnpm install
pnpm windows:live   # doctor --input, smoke test, a narrated take across your monitors + draft render
```

and look at (or send) `windows-live-report/`. `screenpilot doctor` alone reports what is found (ffmpeg, monitors, OBS, browser, voices); add `--input` to also test pointer injection.

- Driving uses `SendInput`. Windows you run elevated (as administrator) cannot be controlled from a non-elevated process: run screenpilot elevated too.
- Coordinates are physical pixels.
- Holding notification popups and closing them are no-ops on Windows.
- Recording is native by default (ffmpeg `gdigrab`, mouse pointer included); `--recorder obs` maps OBS display-capture sources to monitors by their `monitor_id`.
- The demo browser is Chrome, Edge or Brave (first found); set `SCREENPILOT_BROWSER` to pick another.
- The `open` take step opens a file or URL with the default app (the URL protocol handler on Windows, `xdg-open` on Linux, `open` on macOS).

## macOS

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

CI: `.github/workflows/macos.yml` runs tests and `pnpm smoke:macos` on a real Apple Silicon runner when `src/platform/macos` or the macOS recorder changes (or by hand from the Actions tab); macOS minutes cost 10x on private repos, so the job is short. The runner cannot grant privacy permissions, so checks that need one are reported as "blocked" in `smoke-report/report.json` rather than failed. On your own Mac, run `pnpm smoke:macos` from a terminal that has the permissions above.

CI: GitHub Actions. `.github/workflows/ci.yml` (Linux: typecheck, tests, build; plus `smoke:x11` under Xvfb + openbox: monitors, XTest pointer read-back, typing "Hello مرحبا 123" into a Tk window and reading it back, window list/focus/fit-restore, the demo browser, an x11grab recording that must decode, and a recorded take → storyboard) runs on every push and pull request to `main`; `.github/workflows/windows.yml` (tests + `smoke:windows` on a real Windows runner) runs only when code that behaves differently on Windows changes (`src/platform`, `src/record`, `src/drive`, `src/take`, `src/util`, `scripts`, dependencies), or by hand from the Actions tab, since Windows minutes count double on private repos.

## Limitations

- Driving the desktop (`perform`, `drive`, `screenshot`) works on KDE Wayland, X11, GNOME Wayland (no window control), Windows and macOS; not on wlroots compositors.
- Wayland desktops other than KDE expose no window list and no pointer position: no window framing, no `{web}`/`{window}` targets, no pointer log for your own recordings.
- Voiceover uses Edge TTS only (needs network; unofficial service, may change).
- Native recording covers Linux (Wayland through the screen-cast portal, X11 through ffmpeg), Windows and macOS.
- X11 with fractional/HiDPI scaling is recorded in X pixels as reported by XRandR.
- Click capture on KDE Wayland needs the `input` group; on macOS the app that starts ScreenPilot needs Accessibility (and Input Monitoring).
- Rendering is not fast: use `draft` while iterating.
- Narration in cut regions is dropped; the agent must keep lines inside kept segments.

---

Docs synced to commit 2113564 ("ci: X11 smoke test under Xvfb + openbox", 2026-10-27).
