#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyze } from "./analyze/index.js";
import { audit, checkAppAllowed, checkEnvAllowed } from "./drive/guard.js";
import { Driver } from "./drive/index.js";
import { screenshot } from "./drive/see.js";
import { locate, openBrowser, waitForWeb, withPage } from "./drive/web.js";
import { doctor } from "./doctor.js";
import { evenTimes, grabFrames } from "./frames.js";
import { initStoryboard } from "./init.js";
import type { ScreenInfo } from "./record/input/types.js";
import { type ActiveRecording, startRecording } from "./record/index.js";
import { remapSession } from "./record/remap.js";
import { prepareBuild, renderStoryboard, startPreview } from "./render/index.js";
import { lintStoryboard, loadStoryboard, StoryboardError } from "./storyboard/load.js";
import { storyboardJsonSchema } from "./storyboard/schema.js";
import { type PerformResult, performTake, resolveTarget, TakeError } from "./take/perform.js";
import { TargetSchema, takeJsonSchema } from "./take/schema.js";
import { probeVideo } from "./util/media.js";
import { getProvider } from "./voice/index.js";
import { APP, APP_TITLE, named, OUTPUT_ENV, PERFORM_TIMEOUT_ENV, VERSION } from "./brand.js";
import { useBundledTools } from "./bundle.js";
import { findWindow, getDesktop } from "./platform/index.js";
import { defaultOutputDir } from "./setup/folders.js";

// stdout is the protocol channel: log to stderr only.
useBundledTools(import.meta.url);
// A hand-written client config may not set the output folder; the client's working
// directory can be anywhere (even read-only), so default to the Videos folder.
process.env[OUTPUT_ENV] ||= defaultOutputDir();
const log = (msg: string) => process.stderr.write(`${APP}: ${msg}\n`);

const MAX_IMAGES = 12;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const json = (data: unknown): string => (typeof data === "string" ? data : JSON.stringify(data, null, 2));
const text = (data: unknown): Result => ({ content: [{ type: "text", text: json(data) }] });
const fail = (err: unknown): Result => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});
const image = async (file: string): Promise<Content> => ({
  type: "image",
  data: (await readFile(file)).toString("base64"),
  mimeType: "image/jpeg",
});

/** Wrap a handler so thrown errors become tool errors instead of protocol errors. */
const safe =
  <A>(fn: (args: A) => Promise<Result>) =>
  async (args: A): Promise<Result> => {
    try {
      return await fn(args);
    } catch (err) {
      log(err instanceof Error ? (err.stack ?? err.message) : String(err));
      return fail(err);
    }
  };

async function framesResult(video: string, times: number[], opts: { outDir: string; grid?: boolean; width?: number; prefix?: string }): Promise<Result> {
  const picked = times.slice(0, MAX_IMAGES);
  const frames = await grabFrames(video, picked, opts);
  const note = times.length > picked.length ? `\n(capped at ${MAX_IMAGES} frames; ${times.length - picked.length} dropped, call again for the rest)` : "";
  return {
    content: [
      { type: "text", text: frames.map((f) => `t=${f.t}s -> ${f.file}`).join("\n") + note },
      ...(await Promise.all(frames.map((f) => image(f.file)))),
    ],
  };
}

let recording: ActiveRecording | null = null;

// One Driver for the whole server process, opened on first use. It can need the
// user to approve a "remote control" portal dialog once on Wayland (the token is then saved).
let driver: Driver | null = null;
let driverOpening: Promise<Driver> | null = null;
let performing: Driver | null = null;

async function getDriver(): Promise<Driver> {
  if (driver) return driver;
  driverOpening ??= Driver.open({ log, trimActions: true }).then(
    (d) => (driver = d),
    (err) => {
      driverOpening = null;
      throw err;
    },
  );
  return driverOpening;
}

/** Monitor layout: from the live driver if open, else straight from the desktop. */
async function getScreens(): Promise<ScreenInfo[]> {
  if (driver) return driver.screens();
  return (await getDesktop()).screens();
}

const DRIVE_NOTE =
  "Coordinates are normalized 0..1 per monitor (x from left, y from top). Take a screenshot first, act, then screenshot again to verify. " +
  "This uses the REAL mouse and keyboard. If a person is at the machine, ask them not to touch the mouse (moving it stops the action; call resume to carry on). Unattended, set SCREENPILOT_INTERRUPT=off. " +
  "Prefer {web: selector} targets inside the demo browser (browser_open). " +
  "The first use may need a person to approve a remote-control dialog (once, on Wayland; the approval is saved); on macOS the AI app needs Accessibility and Screen Recording permission (errors say where). " +
  "On macOS shortcuts use cmd (e.g. cmd+c), not ctrl. " +
  "Run doctor to see what this desktop supports: on GNOME/other Wayland there is no window control (use {screen, x, y} targets only).";
const norm = z.number().min(0).max(1);

// Sent to every MCP client on connect (Claude, Codex, OpenCode, Cursor…), so
// any agent knows the workflow without a client-specific skill.
const INSTRUCTIONS = `${APP_TITLE} makes screen videos. Typical loops:
1. User records: record_start (screens "all" or one), user works, record_stop → analyze (look at the contact sheet) → storyboard_init with suggest → edit the storyboard (narration lines, captions, highlights, zooms) → render quality "draft" → check_output frames → fix → render "delivery".
2. You perform it: screenshot to see the monitors, windows to see apps, browser_open for websites (app: true hides the address bar and tabs, so nothing about this machine shows); in take.json, file paths are relative to the take, so it runs on any machine; try the flow live with pointer_move/click/type_text; then write a take.json (take_schema) and call perform (it records, logs clicks/windows and writes a storyboard), add intro/outro/zooms, render.
Design every video for its purpose; there is no house style. Before rendering, decide who it's for and where it will be shown, then set the storyboard to match: output size (1920x1080 for YouTube/README/slides, 1080x1920 for Reels/TikTok/Shorts, 1080x1080 for feeds), theme (background, padding, radius, accent, font, caption colors), theme.fonts (any Google Fonts), theme.css (your own CSS for captions, cards, highlights; storyboard_schema lists the classes) and text motion (theme.motion.captions / .cards, or motion per caption: in/out presets fade, rise, drop, slide-left, slide-right, pop, zoom, blur, wipe, words, lines, none; duration, any GSAP ease, stagger). Match the product's brand when you can see it (colors and type from its site or app). Pace and wording follow the audience: short punchy captions for social, calm explanatory ones for tutorials, bilingual lines ("English\nعربي") when asked. Defaults are only a fallback.
Choose the shot the same way: which monitors to record (record_start screens / take "screens": one, several or "all") and what the camera shows: "window" follows the app in use (clean product demos), "screen" the whole monitor (OS-level how-tos, context matters), "all" every monitor side by side (work that spans screens, e.g. code on one and the app on the other). Switch per moment with view steps / storyboard views, and zoom only where detail matters.
Rules: storyboard times are SOURCE seconds and positions are 0..1 of the recording; take targets are {screen,x,y} 0..1 per monitor, {web: selector} in the demo browser, or {window: match, x, y}. Keep narration lines short; the render freezes video so lines never overlap. Use voices like en-US-AndrewNeural or ar-EG-SalmaNeural (voices tool). The camera frames the window in use by default. You can run the whole loop yourself: drive live, write the take, perform, render, check_output. If a person is present, ask them not to touch the mouse while you drive; moving it stops the action with a message, and resume carries on from where the pointer is. For unattended runs start the server with SCREENPILOT_INTERRUPT=off. Run doctor first on a new machine.`;

const server = new McpServer({ name: APP, title: APP_TITLE, version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "record_start",
  {
    description:
      "Start recording the desktop (built-in recorder, no OBS needed; plus pointer/click/active-window events). Only one recording at a time. " +
      "Tell the user to perform the demo, then call record_stop. recorder \"obs\" records through a running OBS Studio instead.",
    inputSchema: {
      dir: z.string().optional().describe("Session directory. Default: a new folder in the user's Videos/ScreenPilot"),
      input: z.enum(["auto", "kwin", "uiohook", "none"]).optional().describe("Pointer/click capture adapter. Default auto"),
      screen: z.string().optional().describe("Monitor name to normalize pointer coordinates against (e.g. eDP-1)"),
      obsUrl: z.string().optional().describe("obs-websocket URL. Default ws://127.0.0.1:4455"),
      obsPassword: z.string().optional().describe("obs-websocket password. Default: read from the local OBS config"),
      recorder: z.enum(["native", "obs"]).optional().describe("native: no OBS needed (Wayland PipeWire portal / X11, Windows and macOS ffmpeg). Default: native when available"),
      fitWindow: z
        .string()
        .optional()
        .describe("Resize the window whose class/title contains this to 16:9 for the recording (window framing shows it whole); restored after"),
      screens: z
        .union([z.literal("all"), z.array(z.string()).min(1)])
        .optional()
        .describe('Record several monitors side by side: "all" or monitor names (see the monitors check in doctor)'),
      map: z.record(z.string(), z.string()).optional().describe("OBS capture source name -> monitor name, when names don't make it obvious"),
    },
  },
  safe(async (a) => {
    if (recording) throw new Error(`A recording is already running (dir: ${recording.dir}). Call record_stop first.`);
    recording = await startRecording({ ...a, log });
    return text({ recording: true, dir: recording.dir, inputAdapter: recording.inputAdapter, startedAt: new Date().toISOString() });
  }),
);

server.registerTool(
  "record_stop",
  {
    description: "Stop the running recording. Returns the session dir, video path, events.jsonl path, duration and warnings. Next: analyze.",
  },
  safe(async () => {
    if (!recording) throw new Error("No recording is running. Call record_start first.");
    const active = recording;
    const result = await active.stop();
    recording = null;
    return text(result);
  }),
);

server.registerTool(
  "remap",
  {
    description:
      "Re-map a session's pointer events to another monitor, when record_stop warned it guessed which monitor OBS records. " +
      "meta.json lists the monitors (screens).",
    inputSchema: {
      dir: z.string().describe("Session directory"),
      screen: z.string().describe("Monitor name OBS actually recorded, e.g. HDMI-A-1"),
    },
  },
  safe(async ({ dir, screen }) => text(await remapSession(dir, screen))),
);

server.registerTool(
  "analyze",
  {
    description:
      "Analyze a recording (session dir or video file): duration, idle spans, clicks, suggested segments/zooms. " +
      "Also returns a contact sheet image of labelled thumbnails across the video. All times are SOURCE seconds; " +
      "positions are normalized 0..1 (x from left, y from top). Use get_frames with grid=true to read exact coordinates.",
    inputSchema: { target: z.string().describe("Session directory or video file") },
  },
  safe(async ({ target }) => {
    const r = await analyze(resolve(target));
    return { content: [{ type: "text", text: json(r) }, await image(r.contactSheet)] };
  }),
);

server.registerTool(
  "get_frames",
  {
    description:
      `Extract frames of the SOURCE recording at the given times (source seconds) and return them as images (max ${MAX_IMAGES} per call). ` +
      "grid=true overlays a 0..1 coordinate grid so you can read zoom/highlight/callout positions off the image. " +
      "Frames are also saved to a frames/ folder next to the video.",
    inputSchema: {
      video: z.string().describe("Path to the raw recording"),
      times: z.array(z.number().min(0)).min(1).describe("Source seconds"),
      grid: z.boolean().optional().describe("Overlay a 0..1 coordinate grid"),
      width: z.number().int().min(160).max(3840).optional().describe("Frame width in px. Default 1280"),
    },
  },
  safe(async ({ video, times, grid, width }) => {
    const v = resolve(video);
    return framesResult(v, times, { outDir: join(dirname(v), "frames"), grid, width });
  }),
);

server.registerTool(
  "storyboard_schema",
  {
    description: "JSON Schema of storyboard.json. Times are SOURCE seconds; positions are normalized 0..1. Read it before writing a storyboard.",
  },
  safe(async () => text(storyboardJsonSchema())),
);

server.registerTool(
  "storyboard_init",
  {
    description:
      "Write a starter storyboard.json for a recording or a record_start/record_stop session (picks up events.jsonl). " +
      "suggest=true pre-fills segments (idle time cut) and zooms (from clicks) via analyze. Then edit the file to add captions, highlights and narration.",
    inputSchema: {
      target: z.string().describe("Session directory or path to the raw recording"),
      out: z.string().optional().describe("Storyboard path. Default: storyboard.json in the session / next to the video"),
      suggest: z.boolean().optional().describe("Pre-fill segments and zooms from analyze"),
      voice: z.string().optional().describe("Default Edge TTS voice. Default en-US-AndrewNeural"),
      force: z.boolean().optional().describe("Overwrite an existing storyboard"),
    },
  },
  safe(async (a) => text(await initStoryboard(a.target, a))),
);

server.registerTool(
  "storyboard_validate",
  {
    description: "Validate a storyboard.json against the schema and the source video. Returns schema errors and lint warnings as text (never throws). Run before every render.",
    inputSchema: { path: z.string().describe("Path to storyboard.json") },
  },
  safe(async ({ path }) => {
    try {
      const { sb, baseDir } = await loadStoryboard(path);
      const src = resolve(baseDir, sb.source);
      const warnings = existsSync(src) ? lintStoryboard(sb, (await probeVideo(src)).duration) : [`source not found: ${src}`];
      return text({ valid: true, warnings });
    } catch (err) {
      if (err instanceof StoryboardError) return text({ valid: false, issues: err.issues });
      throw err;
    }
  }),
);

server.registerTool(
  "voices",
  {
    description: "List Edge TTS voices (needs network). Filter by locale prefix, e.g. ar-EG (Egyptian Arabic: ar-EG-SalmaNeural, ar-EG-ShakirNeural) or en-US.",
    inputSchema: { lang: z.string().optional().describe("Locale prefix, e.g. ar or en-US") },
  },
  safe(async ({ lang }) => {
    const voices = await getProvider("edge").listVoices();
    return text(voices.filter((v) => !lang || v.locale.toLowerCase().startsWith(lang.toLowerCase())));
  }),
);

server.registerTool(
  "build",
  {
    description: "Generate voice, cut the video and write the HyperFrames project without rendering. Reports the output duration, auto-inserted freezes and warnings.",
    inputSchema: { storyboard: z.string().describe("Path to storyboard.json") },
  },
  safe(async ({ storyboard }) => {
    const r = await prepareBuild(storyboard, { log });
    return text({ buildDir: r.buildDir, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings });
  }),
);

server.registerTool(
  "render",
  {
    description:
      "Render a storyboard to MP4. Narration never overlaps: when a voice line is longer than its slot the video auto-freezes (see autoHolds in the result). " +
      'Use quality "draft" while iterating (fast), "looks" for a normal render, "delivery" only for the final file. ' +
      "Slow (minutes). Follow with check_output to review the result.",
    inputSchema: {
      storyboard: z.string().describe("Path to storyboard.json"),
      output: z.string().optional().describe("Output mp4. Default: <storyboard>.mp4"),
      quality: z.enum(["draft", "looks", "delivery"]).optional().describe("Default looks"),
    },
  },
  safe(async ({ storyboard, output, quality }) => {
    const r = await renderStoryboard(storyboard, { output, quality, log });
    return text({ output: r.output, duration: r.plan.duration, autoHolds: r.autoHolds, warnings: r.warnings });
  }),
);

server.registerTool(
  "preview",
  {
    description: "Build the storyboard and open the HyperFrames Studio preview for the user to scrub through. Returns the preview URL/output.",
    inputSchema: { storyboard: z.string().describe("Path to storyboard.json") },
  },
  safe(async ({ storyboard }) => {
    const r = await prepareBuild(storyboard, { log });
    return text(await startPreview(r.buildDir));
  }),
);

server.registerTool(
  "check_output",
  {
    description:
      `Review a RENDERED video: returns frames as images (max ${MAX_IMAGES} per call). Times here are OUTPUT seconds (not source). ` +
      "Omit times to get 8 evenly spaced frames. Look for clipped captions, zooms on the wrong spot and awkward freezes, then edit the storyboard and re-render.",
    inputSchema: {
      video: z.string().describe("Rendered mp4"),
      times: z.array(z.number().min(0)).optional().describe("Output seconds. Default: 8 evenly spaced"),
    },
  },
  safe(async ({ video, times }) => {
    const v = resolve(video);
    const info = await probeVideo(v);
    const t = times?.length ? times : evenTimes(info.duration, 8);
    const r = await framesResult(v, t, { outDir: join(dirname(v), `${basename(v)}.check`), width: 960, prefix: "out" });
    r.content.unshift({ type: "text", text: `duration=${info.duration.toFixed(2)}s hasAudio=${info.hasAudio}` });
    return r;
  }),
);

// Every drive action is logged (audit.jsonl); with SCREENPILOT_ALLOW_APPS set, input only goes to those apps.
const driveTool = <A>(tool: string, fn: (a: A, d: Driver) => Promise<unknown>) =>
  safe<A>(async (a) => {
    const d = await getDriver();
    await audit(tool, a);
    if (tool !== "focus_window" && tool !== "pointer_move") await checkAppAllowed(d.desktop);
    return text((await fn(a, d)) ?? { ok: true });
  });

server.registerTool(
  "screenshot",
  {
    description:
      "Picture of each monitor (built-in capture, or OBS when recording through it), as image blocks plus warnings. " +
      "grid=true overlays a 0..1 coordinate grid; read the x/y for pointer_move/click straight off it. " +
      "Take one before acting and another after, to verify. Read-only.",
    inputSchema: {
      screen: z.string().optional().describe("Only this monitor (e.g. eDP-1). Default: all"),
      grid: z.boolean().optional().describe("Overlay a 0..1 coordinate grid"),
      width: z.number().int().min(160).max(3840).optional().describe("Image width in px. Default 1280"),
    },
  },
  safe(async ({ screen, grid, width }) => {
    const r = await screenshot(await getScreens(), { only: screen, grid, width, outDir: join(tmpdir(), named("screens")) });
    return {
      content: [
        { type: "text", text: json({ shots: r.shots, warnings: r.warnings }) },
        ...(await Promise.all(r.shots.map((s) => image(s.file)))),
      ],
    };
  }),
);

server.registerTool(
  "windows",
  {
    description:
      "List open windows (id, caption, class/app, pid, active, geometry in global desktop coordinates, monitor). Read-only. " +
      "Empty on Wayland desktops without window control (GNOME, sway): use screen targets there.",
  },
  safe(async () => text(await (await getDesktop()).listWindows())),
);

server.registerTool(
  "focus_window",
  {
    description: `Raise and focus the first window whose class or title contains \`match\`; optionally move it onto a monitor (with a small margin). ${DRIVE_NOTE}`,
    inputSchema: {
      match: z.string().describe("Window class or title contains (case-insensitive)"),
      screen: z.string().optional().describe("Move/resize the window onto this monitor"),
    },
  },
  driveTool("focus_window", async ({ match, screen }: { match: string; screen?: string }, d) => {
    const desktop = await getDesktop();
    const w = findWindow(await desktop.listWindows(), match);
    if (!w) throw new Error(`No window matching "${match}"`);
    const s = screen ? d.screens().find((x) => x.name === screen) : undefined;
    if (screen && !s) throw new Error(`Unknown monitor "${screen}" (have: ${d.screens().map((x) => x.name).join(", ")})`);
    await desktop.focusWindow(w.id, s ? { screen: s.name } : undefined);
    await new Promise((r) => setTimeout(r, 350));
    return { focused: w.caption };
  }),
);

server.registerTool(
  "pointer_move",
  {
    description: `Glide the real pointer to a point on a monitor. ${DRIVE_NOTE}`,
    inputSchema: {
      screen: z.string().optional().describe("Monitor name. Default: the monitor under the pointer"),
      x: norm,
      y: norm,
      dur: z.number().positive().optional().describe("Seconds for the glide"),
    },
  },
  driveTool("pointer_move", async ({ screen, x, y, dur }: { screen?: string; x: number; y: number; dur?: number }, d) => {
    await d.moveTo({ screen, x, y }, { dur });
  }),
);

server.registerTool(
  "click",
  {
    description:
      "Move the real pointer to a target and click. Target is one of {screen?, x, y} (monitor-normalized), {web: selector} " +
      `(Playwright selector in the demo browser, most reliable) or {window, x, y} (normalized inside a window). ${DRIVE_NOTE}`,
    inputSchema: {
      target: TargetSchema,
      button: z.enum(["left", "right", "middle"]).optional(),
      count: z.number().int().min(1).max(3).optional().describe("2 = double click"),
    },
  },
  driveTool("click", async ({ target, button, count }: { target: z.output<typeof TargetSchema>; button?: "left" | "right" | "middle"; count?: number }, d) => {
    await d.moveToGlobal(await resolveTarget(target, d));
    await new Promise((r) => setTimeout(r, 120));
    await d.click(undefined, { button, count });
  }),
);

server.registerTool(
  "drag",
  {
    description: `Press at \`from\`, move to \`to\`, release. Targets as in click. ${DRIVE_NOTE}`,
    inputSchema: { from: TargetSchema, to: TargetSchema },
  },
  driveTool("drag", async ({ from, to }: { from: z.output<typeof TargetSchema>; to: z.output<typeof TargetSchema> }, d) => {
    const a = await resolveTarget(from, d);
    const b = await resolveTarget(to, d);
    await d.moveToGlobal(a);
    await d.dragTo(b);
  }),
);

server.registerTool(
  "scroll",
  {
    description: `Scroll the wheel (positive = down/right), optionally after moving to a target. ${DRIVE_NOTE}`,
    inputSchema: {
      steps: z.number().int().describe("Wheel notches; negative = up/left"),
      at: TargetSchema.optional().describe("Move here first"),
      horizontal: z.boolean().optional(),
    },
  },
  driveTool("scroll", async ({ steps, at, horizontal }: { steps: number; at?: z.output<typeof TargetSchema>; horizontal?: boolean }, d) => {
    if (at) await d.moveToGlobal(await resolveTarget(at, d));
    await d.scroll(steps, { horizontal });
  }),
);

server.registerTool(
  "key",
  {
    description: `Press a key combo in the focused window, e.g. "ctrl+l", "enter", "alt+tab". ${DRIVE_NOTE}`,
    inputSchema: { combo: z.string() },
  },
  driveTool("key", async ({ combo }: { combo: string }, d) => {
    await d.key(combo);
  }),
);

server.registerTool(
  "type_text",
  {
    description:
      "Type text into the focused field like a person. For secrets pass {env: NAME} so the value is read from the server's environment " +
      `and never shown; typed text is never echoed back. ${DRIVE_NOTE}`,
    inputSchema: { text: z.union([z.string(), z.object({ env: z.string() }).strict()]) },
  },
  driveTool("type_text", async ({ text: t }: { text: string | { env: string } }, d) => {
    if (typeof t !== "string") checkEnvAllowed(t.env);
    const value = typeof t === "string" ? t : process.env[t.env];
    if (value === undefined) throw new Error(`env var ${typeof t === "string" ? "" : t.env} is not set`);
    await d.type(value);
    return { typed: [...value].length };
  }),
);

server.registerTool(
  "browser_open",
  {
    description:
      "Open (or reuse) the clean demo browser (its own profile; downloads go to ~/Downloads without prompts) and place it on a monitor. " +
      "Then use {web: selector} targets and web_locate. Read-only for the desktop except for launching/moving the browser window.",
    inputSchema: {
      screen: z.string().optional().describe("Monitor to put it on"),
      url: z.string().optional().describe("Page to open"),
      app: z.boolean().optional().describe("App window without address bar and tabs, so recordings show only the page (restarts the demo browser when switching)"),
    },
  },
  safe(async ({ screen, url, app }) => {
    const screens = await getScreens();
    const scr = screen ? screens.find((s) => s.name === screen) : undefined;
    if (screen && !scr) throw new Error(`Unknown monitor "${screen}" (have: ${screens.map((s) => s.name).join(", ")})`);
    return text(await openBrowser({ screen: scr, url, app, log }));
  }),
);

server.registerTool(
  "web_locate",
  {
    description:
      "Find an element in the demo browser by Playwright selector (CSS, text=..., role=...) and return its rectangle in global screen pixels (x, y, w, h). " +
      "Use it to check a {web} target exists before clicking. Read-only.",
    inputSchema: { selector: z.string() },
  },
  safe(async ({ selector }) => text(await locate(selector, await getDriver()))),
);

server.registerTool(
  "wait_for",
  {
    description:
      "Wait until something shows up, so you can verify an action worked without guessing with sleeps: a window (class or title contains `window`) or an element in the demo browser (Playwright selector `web`). " +
      "Give exactly one of them. Fails with an error when the timeout passes. Read-only.",
    inputSchema: {
      window: z.string().optional().describe("Window class or title substring"),
      web: z.string().optional().describe("Playwright selector in the demo browser"),
      timeout: z.number().positive().max(120).optional().describe("Seconds, default 15"),
    },
  },
  safe(async ({ window, web, timeout }) => {
    if (!!window === !!web) throw new Error("Give exactly one of window or web.");
    const ms = (timeout ?? 15) * 1000;
    if (web) {
      await waitForWeb(web, ms);
      return text({ found: { web } });
    }
    const desktop = await getDesktop();
    const deadline = Date.now() + ms;
    for (;;) {
      const w = findWindow(await desktop.listWindows(), window!);
      if (w) return text({ found: { window: w.caption, class: w.resourceClass } });
      if (Date.now() > deadline) throw new Error(`No window matching "${window}" appeared within ${timeout ?? 15}s`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }),
);

server.registerTool(
  "page_text",
  {
    description:
      "Read the demo browser's current tab as data: URL, title and visible text (truncated to maxChars). Use it to check what a page says instead of reading a screenshot. Read-only.",
    inputSchema: { maxChars: z.number().int().positive().max(50000).optional().describe("Default 4000") },
  },
  safe(async ({ maxChars }) =>
    text(
      await withPage(async (page) => {
        const body = await page.evaluate(() => document.body?.innerText ?? "");
        const limit = maxChars ?? 4000;
        return { url: page.url(), title: await page.title(), text: body.slice(0, limit), truncated: body.length > limit };
      }),
    ),
  ),
);

server.registerTool(
  "doctor",
  {
    description:
      "Check this machine and report {summary, checks:[{name, ok, detail, skipped?}]}: node, ffmpeg, desktop, monitors, windows, OBS, demo browser, voices. Never fails; read the report. " +
      "input=true also tests input injection and briefly moves the real pointer.",
    inputSchema: { input: z.boolean().optional().describe("Also test input injection (moves the pointer)") },
  },
  safe(async ({ input }) => {
    if (input) await closeDriver(); // one remote-control session at a time
    return text(await doctor({ input }));
  }),
);

server.registerTool(
  "take_schema",
  {
    description:
      "JSON Schema of take.json (a demo the agent performs on the real desktop while recording: say/caption/view/browser/goto/move/click/drag/type/key/scroll/wait/waitFor/waitForWindow/focus/open/run). Read it before writing a take.",
  },
  safe(async () => text(takeJsonSchema())),
);

server.registerTool(
  "perform",
  {
    description:
      "Perform a take.json on the real desktop: records (built-in recorder) while driving mouse/keyboard, and writes a storyboard from what happened. " +
      "dryRun=true rehearses the same actions WITHOUT recording: always rehearse first. " +
      `On failure returns {failedStep, error, partial} as an error. Takes about as long as the take. ${DRIVE_NOTE}`,
    inputSchema: {
      take: z.string().describe("Path to take.json"),
      dir: z.string().optional().describe("Session directory. Default: a new folder in the user's Videos/ScreenPilot"),
      dryRun: z.boolean().optional().describe("Rehearse without recording"),
    },
  },
  safe(async ({ take, dir, dryRun }): Promise<Result> => {
    if (performing) throw new Error("A take is already running. Call abort to stop it.");
    // performTake opens its own driver; release the live one so two remote-control sessions don't compete.
    await closeDriver();
    // SCREENPILOT_PERFORM_TIMEOUT=<seconds>: an unattended take that hangs is aborted instead of holding the mouse forever.
    const limit = Number(process.env[PERFORM_TIMEOUT_ENV]);
    const timer = limit > 0 ? setTimeout(() => performing?.abort(), limit * 1000) : undefined;
    try {
      const r: PerformResult = await performTake(resolve(take), { dir, dryRun, log, onDriver: (d) => (performing = d) });
      return text(r);
    } catch (err) {
      if (err instanceof TakeError) {
        const result = text({ failedStep: { index: err.index, step: err.step }, error: err.cause.message, partial: err.partial });
        return { ...result, isError: true };
      }
      throw err;
    } finally {
      clearTimeout(timer);
      performing = null;
    }
  }),
);

server.registerTool(
  "resume",
  {
    description:
      "Carry on driving after a click/move/type stopped because the pointer was moved by someone else. Adopts the pointer where it is now; keeps the driver open (no new approval dialog). Take a screenshot afterwards: the screen may have changed.",
  },
  safe(async () => {
    if (!driver) return text({ resumed: false, reason: "no live driver; the next drive tool opens one" });
    driver.resume();
    return text({ resumed: true });
  }),
);

server.registerTool(
  "abort",
  {
    description: "Stop whatever the agent is driving right now: the live driver and a running perform. Safe to call any time. It closes the driver; the next drive tool reopens it. To carry on after the pointer was moved by someone else, use resume instead.",
  },
  safe(async () => {
    const stopped: string[] = [];
    if (performing) {
      performing.abort();
      stopped.push("perform");
    }
    if (driver) {
      driver.abort();
      stopped.push("driver");
      await closeDriver(); // abort is sticky; the next drive tool reopens a fresh driver
    }
    return text({ aborted: stopped });
  }),
);

async function closeDriver(): Promise<void> {
  const d = driver ?? (await driverOpening?.catch(() => null)) ?? null;
  driver = null;
  driverOpening = null;
  if (d) await d.close().catch((err) => log(`could not close driver: ${(err as Error).message}`));
}

// Never leave OBS recording (and switched to our scene) when the client goes away.
async function shutdown(): Promise<never> {
  if (recording) {
    const active = recording;
    recording = null;
    try {
      const r = await active.stop();
      log(`client closed during a recording; saved it to ${r.dir}`);
    } catch (err) {
      log(`could not stop recording: ${(err as Error).message}`);
    }
  }
  performing?.abort();
  await closeDriver();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("end", () => void shutdown());
await server.connect(new StdioServerTransport());
log("mcp server ready");
