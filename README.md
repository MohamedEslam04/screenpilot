# ScreenPilot

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Latest release](https://img.shields.io/github/v/release/MohamedEslam04/screenpilot)](https://github.com/MohamedEslam04/screenpilot/releases/latest)

Ask your AI app for a screen video. ScreenPilot records your screen (or uses your apps itself) and edits the footage into an MP4 with zooms, captions and an AI voiceover in English, Arabic and many other languages. It works inside the AI app you already use (Claude, ChatGPT Codex, Cursor, OpenCode, Gemini CLI, Copilot, Windsurf, VS Code and [many more](#which-ai-apps-work)). It needs no API key and no account. Everything runs on your computer; only the default voiceover goes online (a local voice is optional).

[![ScreenPilot demo: the AI opens the page, clicks through the install steps and plays a finished video](assets/demo/screenpilot-demo.gif)](assets/demo/screenpilot-demo.mp4)

*ScreenPilot made this video itself: the AI drove the browser, recorded the screen, then chose the look and edited it ([full-quality MP4](assets/demo/screenpilot-demo.mp4), [how it was made](assets/demo)).*

**Website and docs:** https://mohamedeslam04.github.io/screenpilot/ (English and Arabic)

## What's new

### Unreleased

- **History:** every recording, take, render and sequence (failures too) is logged to `history.jsonl` in the config folder, and a running render leaves a small job file with its progress. `screenpilot history [--live]` shows them, and `screenpilot library import` adds work made before.
- **Dashboard (new, built from source for now):** a small native desktop program (about 14 MB of memory, no web view) that lists everything ScreenPilot made, with a thumbnail, Open video, running renders, render speed and the voice setup. It has no background process: closing the window ends it. Open it with `screenpilot dashboard`. See [Dashboard](https://mohamedeslam04.github.io/screenpilot/guide/dashboard.html).
- **Cloud voices (optional):** `elevenlabs` and `gemini` voice providers. Keys go in `ELEVENLABS_API_KEY` / `GEMINI_API_KEY` or in `secrets.json` (mode 0600 on Linux and macOS) through `screenpilot secret set <provider>` (key on stdin). They have been tested against mocked requests only. The default voice still needs no account.

### 0.10.0 ([release notes](https://github.com/MohamedEslam04/screenpilot/releases/tag/v0.10.0))

- **Style variants:** `--style <file>` on `render` and `sequence` (MCP `style`) renders the same video with another look; a style file carries only a `theme`, and each style has its own build folder and output name.
- **Faster long renders:** `--workers auto|max|N` (or `SCREENPILOT_WORKERS`), a render time estimate in the log, and `pnpm bench:render` to measure your machine.
- **Chunked renders:** outputs of 300 seconds or more render in cached chunks, so an edit re-renders only the chunks it touched (`--no-chunks`, `--chunk-seconds`).
- **Tiling uses the work area:** `tile` places browsers inside the monitor's usable area, not under panels, taskbars or docks, where the desktop reports it.
- **Second demo browser over MCP:** `browser_open` takes an `id`, and `web_locate`, `wait_for` and `page_text` take `browser`.

### 0.9.0 ([release notes](https://github.com/MohamedEslam04/screenpilot/releases/tag/v0.9.0))

- **Fixes:** views before the first kept segment, `focus` and `{web}` steps on the wrong window, clicks on a covered element (`TARGET_COVERED`), and `run` steps that could not wait.
- **Tracked highlights:** a `highlight` step follows a page element and ends when it disappears.
- **A second demo browser** and the `tile` step to place two browsers side by side.
- **Paste typing:** `type` pastes text outside Latin-1 (Arabic) so letters are not dropped, and restores your clipboard.
- **Smaller changes:** command voices take `cacheFiles`, the render cache moved out of `/tmp` and is capped (4 GB), retakes into a used folder go to `<dir>-2`, `-3`, a storyboard `lint` field sets limits, `screenpilot qa` checks the pixels, and a sequence part can be another sequence or a finished video.

### 0.8.0 ([release notes](https://github.com/MohamedEslam04/screenpilot/releases/tag/v0.8.0))

- **Smarter brief:** the questions before a video recommend from the existing video in the folder and your usual choices, the content question is optional, and one question offers the whole recommended setup.

## Install

Download the file for your computer. It contains everything ScreenPilot needs.

| Your computer | Download |
|---|---|
| **Windows 10 or 11** | [ScreenPilot-windows-setup.exe](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows-setup.exe) |
| **Mac with Apple Silicon** (M1, M2, M3, M4…) | [ScreenPilot-macos-arm64.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-arm64.zip) |
| **Mac with Intel** | [ScreenPilot-macos-x64.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-x64.zip) |
| **Linux** (64-bit) | [ScreenPilot-linux.tar.gz](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-linux.tar.gz) |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple Silicon, "Processor: Intel" means Intel. All versions are on the [Releases](https://github.com/MohamedEslam04/screenpilot/releases) page.

Install your AI app first and open it once, then install ScreenPilot. The installer adds ScreenPilot to every AI app it finds. If you install another AI app later, run the ScreenPilot installer again.

### Windows

1. Download **ScreenPilot-windows-setup.exe** and double-click it.
2. If Windows says **"Windows protected your PC"**, click **More info**, then **Run anyway**. (The installer isn't signed yet.)
3. Click **Install**. You don't need an administrator password. The first install takes a minute or two: it also downloads the video renderer (about 100 MB, once).
4. The last page lists the AI apps ScreenPilot was added to. Click **Finish**.
5. **Restart your AI app**: quit it completely (for Claude Desktop: right-click its icon next to the clock → Quit), then open it again.

If your antivirus asks about ScreenPilot, allow it. ScreenPilot watches mouse clicks while recording so it can zoom in on them.

- **Update:** download the new installer and run it. If an AI app is open, the installer asks you to close it first.
- **Uninstall:** Settings → Apps → Installed apps → ScreenPilot → Uninstall. It also removes ScreenPilot from your AI apps.
- **Claude Desktop only?** Double-click [ScreenPilot-windows.mcpb](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows.mcpb) and click Install in Claude.
- **Can't run installers?** Download [ScreenPilot-windows.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows.zip), right-click it → **Extract All**, open the folder and double-click **ScreenPilot Setup.cmd**.

### macOS

1. Download the zip for your Mac and double-click it to unzip. You get a **ScreenPilot** folder.
2. Open the folder and double-click **Install ScreenPilot.command**.
3. The first time, macOS says it can't verify the developer. Click **Done**, open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to "Install ScreenPilot.command", then confirm. (Apple hasn't notarized ScreenPilot yet.)
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

When the AI types Arabic or other non-Latin text into an app, it pastes it (your clipboard is put back afterwards). On Linux this needs `wl-clipboard` (Wayland) or `xclip` (X11); `screenpilot doctor` tells you if it is missing.

Don't run the installer with `sudo`. It installs for your user and needs no admin rights.

What works depends on the desktop:

| Desktop | Record | AI uses your apps | Arranges windows |
|---|---|---|---|
| KDE Plasma | yes | yes | yes |
| GNOME / Ubuntu (Wayland) | yes | yes | no |
| X11 desktops (Linux Mint, Xfce, MATE, GNOME on Xorg…) | yes | yes | yes |
| sway, Hyprland | yes | no | no |

- **Uninstall:** run `./uninstall.sh` in the downloaded folder.

## Check that it works

1. Quit your AI app completely and open it again.
2. Ask it: **"Run the ScreenPilot doctor."** It reports the recorder, permissions, voices and video renderer, and says how to fix what's missing. If you get that report, ScreenPilot is connected.
3. To double-check, look for `screenpilot` in your AI app's tools or MCP list. In Claude Code, run `/mcp` (or `claude mcp list` in a terminal): it should say **Connected**.
4. Try a real request: "Take a screenshot of my screen." The first time, your desktop may ask to allow screen sharing: allow it.

Nothing shows up? See [If something goes wrong](#if-something-goes-wrong).

## Use it

Then ask, for example:

- "Record my screen while I show the signup flow, then make a short video with captions."
- "Make a demo video of our dashboard: open it, show the reports page, and add an Arabic voiceover."
- "Turn this recording into a tutorial with zooms on every click: `~/Videos/demo.mp4`."
- "Show the admin turning off a permission and the user's page reacting, in two browsers side by side."

Your recordings and finished videos are saved in the **ScreenPilot** folder inside your Videos folder (on a Mac: Movies). The first video takes a little longer while everything warms up.

## Voices

The default voice (Microsoft Edge voices) works with nothing to install, but it needs the internet.

For free voices that run on your own computer, with no internet after setup, open a terminal and run `screenpilot voice-setup`. It needs [uv](https://docs.astral.sh/uv/getting-started/installation/), downloads about 10 GB (more while installing) and takes 30 minutes or more on a slow connection. You then ask your AI app to use a local voice.

- **VoiceTut:** Egyptian Arabic and English, 19 voices. Arabic is less accurate than English.
- **NAMAA:** Egyptian Arabic only (`screenpilot voice-setup namaa`, about 5.5 GB more).

Local voices were tested on Linux with an NVIDIA graphics card only. Windows, macOS and CPU-only machines were not tested. Any other speech model can be plugged in too (a `command` voice can list `cacheFiles`, so replaced clips are never served from the cache). See [Voices](https://mohamedeslam04.github.io/screenpilot/guide/voices.html) on the website.

## Which AI apps work

The installer adds ScreenPilot to each of these it finds:

- Claude Desktop (including the Microsoft Store version) and Claude Code
- Codex, OpenCode, Gemini CLI, Qwen Code, GitHub Copilot CLI, Amazon Q, Goose, Warp
- Cursor, Windsurf, Devin Desktop, Antigravity, Kiro, Zed, LM Studio
- VS Code, VS Code Insiders and VSCodium, plus the Cline and Roo Code extensions

JetBrains AI Assistant has no settings file: after installing, use its **Import from Claude** button. Any other app that supports MCP servers works too: see [Add it to another app](#add-it-to-another-app).

## If something goes wrong

- **The AI app doesn't know ScreenPilot:** quit the AI app completely and open it again. Still nothing? Run the installer again: it lists which apps it added ScreenPilot to.
- **"No AI tool found":** install your AI app, open it once, then run the ScreenPilot installer again.
- **The installer says to close your AI apps:** an open AI app is using the old ScreenPilot. Quit it and click Retry.
- **"Video renderer: not ready":** the one-time download needs internet. Your first video downloads it.
- **Renders refuse to start or the disk fills up:** the renderer's frame cache lives in your user cache folder (`~/.cache/screenpilot` on Linux) and is trimmed to 4 GB before each render (old entries first). Change the limit with `SCREENPILOT_RENDER_CACHE_GB`; `screenpilot doctor` shows where it is and how big.
- **Recording or mouse control fails on a Mac:** allow your AI app under Screen & System Audio Recording and Accessibility (see [macOS](#macos) step 6), then quit and reopen the AI app.

### Add it to another app

For an AI app that isn't in the list, add an MCP server by hand. This command prints the settings to copy:

- Windows (Command Prompt): `"%LOCALAPPDATA%\ScreenPilot\bin\node.exe" "%LOCALAPPDATA%\ScreenPilot\dist\cli.js" setup --print`
- macOS: `~/Library/Application\ Support/ScreenPilot/bin/node ~/Library/Application\ Support/ScreenPilot/dist/cli.js setup --print`
- Linux: `~/.local/share/screenpilot/bin/node ~/.local/share/screenpilot/dist/cli.js setup --print`

It prints a standard `mcpServers` entry (command, arguments, environment) that most apps accept.

## More

- [Website and docs](https://mohamedeslam04.github.io/screenpilot/): guides in English and Arabic.
- [CONTRIBUTING.md](CONTRIBUTING.md): for developers (build from source, CLI, storyboard reference).
- [License](LICENSE): MIT. Third-party software: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

Docs synced to commit f254f06 ("fix(voice): Gemini default model gemini-3.8-flash-tts (current docs), 404 points at GEMINI_TTS_MODEL", 2026-11-09).
