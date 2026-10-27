import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { evenTimes } from "../frames.js";
import { clicksOf, readEvents } from "../record/events.js";
import { run } from "../util/exec.js";
import { probeVideo } from "../util/media.js";
import { dwellPoints, idleSpans, parseFreezes, type ScreenRect, suggestSegments, suggestViews, suggestZooms, suggestWindowViews, type WindowReport, type WindowView } from "./detect.js";

// Public analysis API: what is in a recording, so an agent can write a storyboard.

export interface AnalyzeResult {
  video: string;
  duration: number;
  width: number;
  height: number;
  /** Spans with no input and (almost) no pixel change: candidates to cut or speed up. */
  idle: { start: number; end: number }[];
  clicks: { t: number; x: number; y: number }[];
  suggestedSegments: { in: number; out: number; speed: number }[];
  suggestedZooms: { at: number; dur: number; x: number; y: number; scale: number }[];
  /** Camera views across monitors; only for multi-monitor sessions (meta.canvasScreens). */
  suggestedViews?: { at: number; screen: string; transition: "pan" | "cut" }[];
  /** Camera views framing the window in use (sessions recorded on KDE). */
  suggestedWindowViews?: WindowView[];
  /** One image with labelled thumbnails across the recording. */
  contactSheet: string;
  frames: { t: number; file: string }[];
}

export interface AnalyzeOptions {
  /** Number of evenly spaced frames for the contact sheet. Default 12. */
  frames?: number;
}

/** Resolve a session dir (meta.json) or a video file to the video + events paths. */
export async function resolveTarget(target: string): Promise<{
  video: string;
  events: string | null;
  dir: string;
  canvasScreens?: ScreenRect[];
  windows?: string;
}> {
  const abs = resolve(target);
  if (statSync(abs).isDirectory()) {
    const metaPath = join(abs, "meta.json");
    if (!existsSync(metaPath)) throw new Error(`${abs} has no meta.json (not a demoreel session)`);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
      video: string;
      events: string | null;
      canvasScreens?: ScreenRect[];
      windows?: string | null;
    };
    return {
      video: join(abs, meta.video),
      events: meta.events ? join(abs, meta.events) : null,
      dir: abs,
      ...(meta.canvasScreens?.length ? { canvasScreens: meta.canvasScreens } : {}),
      ...(meta.windows ? { windows: join(abs, meta.windows) } : {}),
    };
  }
  const events = join(dirname(abs), "events.jsonl");
  return { video: abs, events: existsSync(events) ? events : null, dir: dirname(abs) };
}

/** `target` is a session directory (from `demoreel record`) or a video file. */
export async function analyze(target: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const { video, events, dir, canvasScreens, windows } = await resolveTarget(target);
  const info = await probeVideo(video);

  let clicks: { t: number; x: number; y: number }[] = [];
  let moves: { t: number; x: number; y: number }[] = [];
  if (events) {
    const all = await readEvents(events);
    clicks = clicksOf(all);
    moves = all.filter((e) => e.type === "move" && e.x !== undefined).map((e) => ({ t: e.t, x: e.x!, y: e.y! }));
    if (clicks.length === 0) clicks = dwellPoints(moves);
  }

  const windowReports: WindowReport[] = windows
    ? (await readFile(windows, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as WindowReport)
    : [];

  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-i",
    video,
    "-map",
    "0:v:0",
    "-vf",
    "scale=480:-2,freezedetect=n=0.002:d=1.5",
    "-f",
    "null",
    "-",
  ]);
  const idle = idleSpans(parseFreezes(stderr, info.duration), clicks);

  const outDir = join(dir, "analysis");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const frames = await contactFrames(video, evenTimes(info.duration, opts.frames ?? 12), outDir);
  const contactSheet = join(outDir, "contact.jpg");
  const cols = 4;
  const rows = Math.ceil(frames.length / cols);
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    join(outDir, "c_%03d.jpg"),
    "-vf",
    `tile=${cols}x${rows}:padding=6:color=0x111111`,
    "-frames:v",
    "1",
    "-pix_fmt", "yuvj420p", "-q:v",
    "3",
    contactSheet,
  ]);

  const result: AnalyzeResult = {
    video,
    duration: info.duration,
    width: info.width,
    height: info.height,
    idle,
    clicks,
    suggestedSegments: suggestSegments(info.duration, idle),
    suggestedZooms: suggestZooms(clicks),
    ...(canvasScreens ? { suggestedViews: suggestViews([...moves, ...clicks], canvasScreens) } : {}),
    ...(windowReports.length ? { suggestedWindowViews: suggestWindowViews(windowReports, { screens: canvasScreens }) } : {}),
    contactSheet,
    frames,
  };
  await writeFile(join(outDir, "analysis.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Thumbnails stamped with their source time, named for ffmpeg's tile filter. */
async function contactFrames(video: string, times: number[], outDir: string): Promise<{ t: number; file: string }[]> {
  const out: { t: number; file: string }[] = [];
  for (const [i, t] of times.entries()) {
    const file = join(outDir, `c_${String(i).padStart(3, "0")}.jpg`);
    const label = `drawtext=text='${t.toFixed(1)}s':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`;
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      video,
      "-frames:v",
      "1",
      "-vf",
      `scale=480:-2,${label}`,
      "-pix_fmt", "yuvj420p", "-q:v",
      "4",
      file,
    ]);
    out.push({ t, file });
  }
  return out;
}
