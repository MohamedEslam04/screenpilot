# ScreenPilot

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Latest release](https://img.shields.io/github/v/release/MohamedEslam04/screenpilot)](https://github.com/MohamedEslam04/screenpilot/releases/latest)

Ask your AI app for a screen video. ScreenPilot records your screen (or uses your apps itself) and edits the footage into an MP4 with zooms, captions and an AI voiceover in English, Arabic and many other languages. It works inside the AI app you already use (Claude, ChatGPT Codex, Cursor, OpenCode, Gemini CLI, Copilot, Windsurf, VS Code and [many more](#which-ai-apps-work)). It needs no API key and no account. Everything runs on your computer; only the default voiceover goes online (a local voice is optional).

[![ScreenPilot demo: the AI opens the page, clicks through the install steps and plays a finished video](assets/demo/screenpilot-demo.gif)](assets/demo/screenpilot-demo.mp4)

*ScreenPilot made this video itself: the AI drove the browser, recorded the screen, then chose the look and edited it ([full-quality MP4](assets/demo/screenpilot-demo.mp4), [how it was made](assets/demo)).*

**Website and docs:** https://mohamedeslam04.github.io/screenpilot/ (English and Arabic)

## Install

Download the file for your computer. It contains everything ScreenPilot needs.

| Your computer | Download |
|---|---|
| **Windows 10 or 11** | [ScreenPilot-windows-setup.exe](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-windows-setup.exe) |
| **Mac with Apple Silicon** (M1, M2, M3, M4…) | [ScreenPilot-macos-arm64.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-arm64.zip) |
| **Mac with Intel** | [ScreenPilot-macos-x64.zip](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-macos-x64.zip) |
| **Linux** (64-bit) | [ScreenPilot-linux.tar.gz](https://github.com/MohamedEslam04/screenpilot/releases/latest/download/ScreenPilot-linux.tar.gz) |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple Silicon, "Processor: Intel" means Intel. All versions are on the [Releases](https://github.com/MohamedEslam04/screenpilot/releases) page.

> **Mac downloads:** v0.3.0 (Windows and Linux) has no Mac build yet, so the two Mac links above don't work until the next release. The last Mac builds are on the [v0.2.3 release](https://github.com/MohamedEslam04/screenpilot/releases/tag/v0.2.3).

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

Your recordings and finished videos are saved in the **ScreenPilot** folder inside your Videos folder (on a Mac: Movies). The first video takes a little longer while everything warms up.

## Voices

The default voice (Microsoft Edge voices) works with nothing to install, but it needs the internet.

For free voices that run on your own computer, with no internet after setup, open a terminal and run `screenpilot voice-setup`. It needs [uv](https://docs.astral.sh/uv/getting-started/installation/), downloads about 10 GB (more while installing) and takes 30 minutes or more on a slow connection. You then ask your AI app to use a local voice.

- **VoiceTut:** Egyptian Arabic and English, 19 voices. Arabic is less accurate than English.
- **NAMAA:** Egyptian Arabic only (`screenpilot voice-setup namaa`, about 5.5 GB more).

Local voices were tested on Linux with an NVIDIA graphics card only. Windows, macOS and CPU-only machines were not tested. Any other speech model can be plugged in too. See [Voices](https://mohamedeslam04.github.io/screenpilot/guide/voices.html) on the website.

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

Docs synced to commit c0088eb ("docs: agent guide, skill and MCP instructions for sequence, cards, overlays, audio, partial render, formats", 2026-10-28).
