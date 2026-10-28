# ScreenPilot

Ask your AI app for a screen video and get a finished one: ScreenPilot records your screen (or uses your apps itself), then edits the footage into a polished MP4 with zooms, captions and an AI voiceover in English, Arabic and many other languages. No video editing, and no screen recorder to set up.

ScreenPilot works inside the AI app you already use: Claude, ChatGPT Codex, Cursor, OpenCode, Gemini CLI, Copilot, Windsurf, VS Code and [many more](#which-ai-apps-work). It needs no API key and no account: your AI app does the thinking, and ScreenPilot gives it the screen, the recorder and the video editor. Everything runs on your computer.

[![ScreenPilot demo: the AI opens the page, clicks through the install steps and plays a finished video](assets/demo/screenpilot-demo.gif)](assets/demo/screenpilot-demo.mp4)

*This video was made by ScreenPilot itself: the AI drove the browser, recorded the screen, then chose the look and edited it ([full-quality MP4](assets/demo/screenpilot-demo.mp4), [how it was made](assets/demo)).*

## Install

Pick the download for your computer. Everything ScreenPilot needs is inside it; you don't need to install anything else.

| Your computer | Download |
|---|---|
| **Windows 10 or 11** | [ScreenPilot-windows-setup.exe](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows-setup.exe) |
| **Mac with Apple Silicon** (M1, M2, M3, M4…) | [ScreenPilot-macos-arm64.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-arm64.zip) |
| **Mac with Intel** | [ScreenPilot-macos-x64.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-x64.zip) |
| **Linux** (64-bit) | [ScreenPilot-linux.tar.gz](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-linux.tar.gz) |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple Silicon, "Processor: Intel" means Intel. All versions are on the [Releases](https://github.com/MohamedEslam04/screenpilot/releases) page.

Install your AI app first (and open it once), then ScreenPilot: the installer adds itself to every AI app it finds. Installed a new AI app later? Run the ScreenPilot installer again.

### Windows

1. Download **ScreenPilot-windows-setup.exe** and double-click it.
2. If Windows says **"Windows protected your PC"**, click **More info**, then **Run anyway**. (The installer isn't signed yet.)
3. Click **Install**. You don't need an administrator password. The first install takes a minute or two: it also downloads the video renderer (about 100 MB, only once).
4. The last page lists the AI apps ScreenPilot was added to. Click **Finish**.
5. **Restart your AI app**: quit it completely (for Claude Desktop: right-click its icon next to the clock → Quit), then open it again.

If your antivirus asks about ScreenPilot, allow it: ScreenPilot watches mouse clicks while recording so it can zoom in on them.

- **Update:** download the new installer and run it. If an AI app is open, the installer asks you to close it first.
- **Uninstall:** Settings → Apps → Installed apps → ScreenPilot → Uninstall. It also removes ScreenPilot from your AI apps.
- **Claude Desktop only?** You can instead double-click [ScreenPilot-windows.mcpb](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows.mcpb) and click Install in Claude.
- **Can't run installers?** Use [ScreenPilot-windows.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows.zip): right-click it → **Extract All**, open the extracted folder and double-click **ScreenPilot Setup.cmd**.

### macOS

1. Download the zip for your Mac and double-click it to unzip. You get a **ScreenPilot** folder.
2. Open the folder and double-click **Install ScreenPilot.command**.
3. The first time, macOS says it can't verify the developer. Click **Done**, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to "Install ScreenPilot.command", then confirm. (ScreenPilot isn't notarized by Apple yet.)
4. A Terminal window shows what was installed. Press **Enter** to close it. You can delete the downloaded folder now.
5. **Restart your AI app** (Cmd+Q, then open it again).
6. The first time you ask for a recording, macOS asks you to allow your **AI app** (Claude, Cursor, Terminal…, not ScreenPilot itself) in **System Settings → Privacy & Security**:
   - **Screen & System Audio Recording**: needed to record.
   - **Accessibility**: needed when the AI uses your apps for you (mouse and keyboard).
   - **Input Monitoring** (optional): lets recordings zoom in on your own clicks.

   Turn the AI app on in each list, then quit and reopen it.

- **Uninstall:** double-click **Uninstall ScreenPilot.command** in the downloaded folder (download it again if you deleted it).
- **Claude Desktop only?** Double-click [ScreenPilot-macos-arm64.mcpb](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-arm64.mcpb) (Intel: [ScreenPilot-macos-x64.mcpb](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-x64.mcpb)) and click Install in Claude.

### Linux

1. Download **ScreenPilot-linux.tar.gz**, right-click it → **Extract Here**. You get a **ScreenPilot** folder.
2. Open the folder and double-click **install.sh** (choose **Run** or **Run in Terminal** if asked). A terminal window shows what happens. Or open a terminal in the folder and run `./install.sh`.
3. Built-in recording on Wayland desktops needs a few system packages (GStreamer). If they're missing, the installer shows the exact command for your distribution (Fedora, Ubuntu/Debian/Mint, Arch, openSUSE) and asks whether to run it: type `y` and your password. You can skip this and do it later.
4. **Restart your AI app.**
5. The first time you record (or let the AI use your desktop), your desktop asks once to allow screen sharing or remote control. Allow it.

Don't run the installer with `sudo`: it installs for your user and needs no admin rights.

What works depends on the desktop:

| Desktop | Record | AI uses your apps | Arranges windows |
|---|---|---|---|
| KDE Plasma | yes | yes | yes |
| GNOME / Ubuntu (Wayland) | yes | yes | no |
| X11 desktops (Linux Mint, Xfce, MATE, GNOME on Xorg…) | yes | yes | yes |
| sway, Hyprland | yes | no | no |

- **Uninstall:** run `./uninstall.sh` in the downloaded folder.

## Use it

Restart your AI app, then just ask, for example:

- "Record my screen while I show the signup flow, then make a short video with captions."
- "Make a demo video of our dashboard: open it, show the reports page, and add an Arabic voiceover."
- "Turn this recording into a tutorial with zooms on every click: `~/Videos/demo.mp4`."

Your recordings and finished videos are saved in the **ScreenPilot** folder inside your Videos folder (on a Mac: Movies). The first video takes a little longer while everything warms up.

## Which AI apps work

The installer adds ScreenPilot to each of these it finds:

- Claude Desktop (including the Microsoft Store version) and Claude Code
- Codex, OpenCode, Gemini CLI, Qwen Code, GitHub Copilot CLI, Amazon Q, Goose, Warp
- Cursor, Windsurf, Devin Desktop, Antigravity, Kiro, Zed, LM Studio
- VS Code, VS Code Insiders and VSCodium, plus the Cline and Roo Code extensions

JetBrains AI Assistant has no settings file: after installing, use its **Import from Claude** button. Any other app that supports MCP servers works too; see [Add it to another app](#add-it-to-another-app).

## If something goes wrong

- **The AI app doesn't know ScreenPilot:** quit the AI app completely and open it again. Still nothing? Run the installer again: it lists which apps it added ScreenPilot to.
- **"No AI tool found":** install your AI app, open it once, then run the ScreenPilot installer again.
- **The installer says to close your AI apps:** an open AI app is using the old ScreenPilot. Quit it and click Retry.
- **"Video renderer: not ready":** the one-time download needs internet. Nothing to do: your first video downloads it.
- **Recording or mouse control fails on a Mac:** allow your AI app under Screen & System Audio Recording and Accessibility (see [macOS notes](#macos-notes)), then quit and reopen the AI app.
- **Check everything at once:** ask your AI app to "run the ScreenPilot doctor". It checks the recorder, permissions, voices and more, and says how to fix what's missing.

### Add it to another app

For an AI app that isn't in the list, add an MCP server by hand. This command prints the settings to copy:

- Windows (Command Prompt): `"%LOCALAPPDATA%\ScreenPilot\bin\node.exe" "%LOCALAPPDATA%\ScreenPilot\dist\cli.js" setup --print`
- macOS: `~/Library/Application\ Support/ScreenPilot/bin/node ~/Library/Application\ Support/ScreenPilot/dist/cli.js setup --print`
- Linux: `~/.local/share/screenpilot/bin/node ~/.local/share/screenpilot/dist/cli.js setup --print`

It prints a standard `mcpServers` entry (command, arguments, environment) that most apps accept.

---

# For developers

Everything below is about building and changing ScreenPilot. To use it, see [Install](#install).

How it works:

1. **Record** the screen (built in, or through OBS) plus pointer, click and active-window events.
2. **Analyze**: the agent looks at a contact sheet and frames with a coordinate grid.
3. The agent writes `storyboard.json`: cuts, speed-ups, zooms, captions, highlights, voiceover lines.
4. **Render** an MP4 with [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + GSAP) and Edge TTS voiceover.

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
| theme | `background`, `padding` 0.05, `radius` 16, `shadow`, `accent`, `font`, `captionColor`, `captionBackground`, `clickRipples` true, `fonts` (extra Google Fonts), `css` (your own CSS; classes listed in `storyboard_schema`) |

When a narration line is longer than its slot, the render freezes the video automatically so lines never overlap.

## Windows notes

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
- Voiceover uses Edge TTS only (needs network; unofficial service, may change).
- Native recording covers Linux (Wayland through the screen-cast portal, X11 through ffmpeg), Windows and macOS.
- X11 with fractional/HiDPI scaling is recorded in X pixels as reported by XRandR.
- Click capture on KDE Wayland needs the `input` group; on macOS the app that starts ScreenPilot needs Accessibility (and Input Monitoring).
- Rendering is not fast: use `draft` while iterating.
- Narration in cut regions is dropped; the agent must keep lines inside kept segments.

---

Docs synced to commit 6278d6f ("ci(macos): also run on input and driving changes", 2026-10-27).
