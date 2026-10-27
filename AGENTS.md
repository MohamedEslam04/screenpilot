# demoreel: agent guide

Turn a screen recording of any desktop app into a polished demo MP4. You write `storyboard.json` (cuts, zooms, captions, highlights, voiceover); demoreel renders it with HyperFrames and Edge TTS. Run the CLI as `demoreel` (or `node dist/cli.js`). An MCP server (`dist/mcp.js`) exposes the same steps as tools; see README. Claude Code users also get `skill/SKILL.md` with a longer walkthrough and a full storyboard example.

## Rules

- Storyboard times are SOURCE seconds (the raw recording). Positions are normalized 0..1 (x from left, y from top). Only `check` uses output seconds.
- Paths inside a storyboard are relative to the storyboard file.
- Narration never overlaps: render auto-freezes the video when a line overruns. Keep lines short.
- Iterate with `-q draft`; use `-q delivery` only for the final render.

## Workflow

1. Record (or use an existing video): `demoreel record` -> session dir with video + `events.jsonl`. Needs OBS Studio with WebSocket server enabled.
   If `record` warns it assumed which monitor OBS records and that was wrong: `demoreel remap <session> --screen <name>` (names in meta.json `screens`).
2. Analyze: `demoreel analyze <session-dir|video>` -> idle spans, clicks, suggested segments/zooms, contact sheet image. View the contact sheet.
3. Look closer: `demoreel frames <video> --at 1,4.5,10 --grid`. The grid shows 0..1 coordinates; read zoom/highlight/callout positions from it. View the images.
4. Start: `demoreel init <session-dir|video> --suggest [--voice ar-EG-SalmaNeural]` (`--suggest` pre-fills idle cuts and click zooms). Schema: `demoreel schema`. Voices: `demoreel voices --lang ar-EG`.
5. Edit `storyboard.json`: `segments` (keep parts, `speed` to fast-forward), `holds`, `zooms` (at, dur, x, y, scale), `captions` (style pill/title/callout; callout needs x,y), `highlights` (x,y,w,h), `narration` (at, text, optional per-line `voice`), `intro`/`outro`, `music`.
6. Validate: `demoreel validate storyboard.json`.
7. Draft: `demoreel render storyboard.json -q draft`.
8. Review: `demoreel check storyboard.mp4 --at 2,8,15` (output seconds) and view the frames. Fix and repeat 5-8.
9. Final: `demoreel render storyboard.json -q delivery -o demo.mp4`.

`demoreel build` prepares everything without rendering; `demoreel preview` opens HyperFrames Studio.

## Agent drives the desktop (KDE Wayland)

Instead of asking the user to perform the demo, you can perform it. Loop: explore, rehearse, perform, review, render.

1. Explore: `screenshot --grid` (MCP `screenshot`) and `windows`; `browser --url ...` for web apps. Act with `drive` (MCP `click`, `type_text`, ...), screenshot after each action to verify.
2. Write `take.json` (`demoreel take-schema`, or MCP `take_schema`). Use `{web: selector}` targets inside the demo browser; they are exact.
3. Rehearse: `demoreel perform take.json --dry-run`. Fix the failing step (errors name the step) and repeat until clean.
4. Perform: `demoreel perform take.json` -> session dir with video, events and a starter `storyboard.json`.
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
