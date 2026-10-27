import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Display } from "../../platform/macos/geometry.js";
import { run } from "../../util/exec.js";
import { canvasFor, type RecorderBackend } from "../backend.js";
import type { Rect, ScreenInfo } from "../input/types.js";
import { unionRect } from "../obs.js";
import { progressFrame } from "./windows-ffmpeg.js";

// Native recorder for macOS: ffmpeg's avfoundation grabs each display (with
// the pointer) and encodes H.264 into an MKV, which survives an unclean stop.
//
// Displays are opened by name, "Capture screen N", where N is the display's
// position in CGGetActiveDisplayList (that is how ffmpeg numbers them).
// avfoundation delivers backing PIXELS (2x points on Retina); every input is
// scaled to `scale` pixels per point and placed at its point position × scale,
// so the canvas is the monitors' point layout at a uniform pixel density.

const FPS = 30;
/** H.264 level 5.1 territory; keeps 5K / multi-monitor canvases encodable in real time. */
const MAX_W = 4096;
const MAX_H = 2304;

export interface AvInput {
  /** Position in CGGetActiveDisplayList. */
  index: number;
  /** Global points. */
  rect: Rect;
  /** Pixels per point of this display. */
  scale: number;
}

export type Encoder = "h264_videotoolbox" | "libx264";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Pixels per point for the canvas: the sharpest display's density, capped to a size we can encode live. */
export function captureScale(inputs: AvInput[]): number {
  const u = unionRect(inputs.map((i) => i.rect));
  const sharpest = Math.max(1, ...inputs.map((i) => i.scale));
  return Math.min(sharpest, MAX_W / u.w, MAX_H / u.h);
}

/** Canvas size and each input's place in it (pixels), for `scale` pixels per point. */
export function layout(inputs: AvInput[], scale: number): { w: number; h: number; places: Rect[] } {
  const u = unionRect(inputs.map((i) => i.rect));
  const places = inputs.map((i) => ({
    x: Math.round((i.rect.x - u.x) * scale),
    y: Math.round((i.rect.y - u.y) * scale),
    w: even(i.rect.w * scale),
    h: even(i.rect.h * scale),
  }));
  return { w: even(u.w * scale), h: even(u.h * scale), places };
}

function encoderArgs(enc: Encoder, w: number, h: number, fps: number): string[] {
  if (enc === "h264_videotoolbox") {
    // Hardware encoder (every Mac since 2011): live 4K without loading the CPU. Screen content needs a generous bitrate.
    const kbps = Math.round((w * h * fps * 0.12) / 1000);
    return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-allow_sw", "1", "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps * 2}k`];
  }
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"];
}

/** ffmpeg arguments to record `inputs` side by side as on the desktop. */
export function avfoundationArgs(inputs: AvInput[], file: string, enc: Encoder = "h264_videotoolbox", fps = FPS): string[] {
  if (!inputs.length) throw new Error("No display to record");
  const scale = captureScale(inputs);
  const { w, h, places } = layout(inputs, scale);
  const src = inputs.flatMap((i) => [
    "-f", "avfoundation",
    "-framerate", String(fps),
    "-capture_cursor", "1",
    "-capture_mouse_clicks", "0",
    "-thread_queue_size", "1024",
    "-i", `Capture screen ${i.index}:none`,
  ]);
  let graph: string;
  if (inputs.length === 1) {
    const p = places[0]!;
    graph = `[0:v]scale=${p.w}:${p.h}:flags=bicubic,fps=${fps},format=yuv420p[out]`;
  } else {
    const parts = [`color=c=black:s=${w}x${h}:r=${fps}[bg]`];
    places.forEach((p, i) => parts.push(`[${i}:v]scale=${p.w}:${p.h}:flags=bicubic[s${i}]`));
    let prev = "bg";
    places.forEach((p, i) => {
      const next = i === places.length - 1 ? "mix" : `o${i}`;
      parts.push(`[${prev}][s${i}]overlay=${p.x}:${p.y}:shortest=1[${next}]`);
      prev = next;
    });
    parts.push(`[mix]fps=${fps},format=yuv420p[out]`);
    graph = parts.join(";");
  }
  return [
    "-hide_banner",
    ...src,
    "-filter_complex", graph,
    "-map", "[out]",
    ...encoderArgs(enc, w, h, fps),
    "-stats",
    "-stats_period", "0.1",
    "-y",
    file,
  ];
}

/** Screens in an `ffmpeg -f avfoundation -list_devices true -i ""` listing: device number → display position. */
export function parseAvfoundationScreens(stderr: string): { device: number; screen: number }[] {
  const out: { device: number; screen: number }[] = [];
  let video = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) video = true;
    else if (/AVFoundation audio devices/i.test(line)) video = false;
    const m = video ? /\[(\d+)\]\s+Capture screen (\d+)\s*$/.exec(line) : null;
    if (m) out.push({ device: Number(m[1]), screen: Number(m[2]) });
  }
  return out;
}

/** Run ffmpeg for its stderr whatever the exit code (listing devices always "fails"). */
export function ffmpegStderr(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.once("error", (e) => reject(new Error(`${ffmpeg}: ${e.message}`)));
    child.once("close", () => resolve(err));
  });
}

export async function listAvfoundationScreens(ffmpeg = "ffmpeg"): Promise<{ device: number; screen: number }[]> {
  return parseAvfoundationScreens(await ffmpegStderr(ffmpeg, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]));
}

async function pickEncoder(ffmpeg: string): Promise<Encoder> {
  try {
    const { stdout } = await run(ffmpeg, ["-hide_banner", "-encoders"]);
    if (/\bh264_videotoolbox\b/.test(stdout)) return "h264_videotoolbox";
  } catch {
    // fall through
  }
  return "libx264";
}

const tailLines = (s: string) => s.split(/[\r\n]+/).filter(Boolean).slice(-10).join("\n");

/** Hooks into the macOS desktop (injected so tests and Linux never load koffi). */
export interface MacCaptureApi {
  displays(): Promise<Display[]>;
  /** Throws a clear "allow Screen Recording" error when not allowed. */
  ensureScreenCapture(): Promise<void>;
}

class MacAvfoundationRecorder implements RecorderBackend {
  readonly id = "native" as const;
  startedAt = 0;
  private inputs: AvInput[] = [];
  private enc: Encoder = "libx264";
  private child?: ChildProcessWithoutNullStreams;
  private file = "";
  private log = "";

  constructor(
    private api: MacCaptureApi,
    private ffmpeg: string,
  ) {}

  async prepare(screens: ScreenInfo[], _all: ScreenInfo[], log: (m: string) => void) {
    if (!screens.length) throw new Error("No monitor to record");
    try {
      await run(this.ffmpeg, ["-hide_banner", "-version"]);
    } catch {
      throw new Error("ffmpeg was not found; it is needed to record on macOS (install it with `brew install ffmpeg`).");
    }
    await this.api.ensureScreenCapture();
    const displays = await this.api.displays();
    this.inputs = screens.map((s) => {
      const d = displays.find((x) => String(x.id) === s.deviceId) ?? displays.find((x) => x.screen.name === s.name);
      if (!d) throw new Error(`Display ${s.name} is not connected any more`);
      return { index: d.index, rect: d.screen, scale: d.scale };
    });
    this.enc = await pickEncoder(this.ffmpeg);
    const scale = captureScale(this.inputs);
    const { w, h } = layout(this.inputs, scale);
    log(`recording ${screens.map((s) => s.name).join(" + ")} with ffmpeg (avfoundation, ${w}x${h}, ${this.enc})`);
    // Pointer/window logs are normalized against the point rects; only the video is in pixels.
    return { ...canvasFor(screens, FPS, `avfoundation+${this.enc}`, screens.map((s) => s.name).join(" + ")), sourceWidth: w, sourceHeight: h, canvas: { width: w, height: h, fps: FPS } };
  }

  async start(dir: string): Promise<void> {
    this.file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.mkv`);
    const child = spawn(this.ffmpeg, avfoundationArgs(this.inputs, this.file, this.enc), { stdio: "pipe" });
    this.child = child;
    this.log = "";
    child.stdout.resume();
    await new Promise<void>((resolve, reject) => {
      let started = false;
      // Keep reading stderr for the whole recording, or ffmpeg blocks on a full pipe.
      child.stderr.on("data", (d: Buffer) => {
        this.log = (this.log + d.toString()).slice(-8000);
        if (!started && progressFrame(this.log) !== undefined) {
          started = true;
          this.startedAt = performance.now();
          resolve();
        }
      });
      child.once("error", (err) => reject(new Error(`ffmpeg: ${err.message}`)));
      child.once("exit", (code) => {
        if (!started) reject(new Error(`ffmpeg stopped before recording (exit ${code}):\n${tailLines(this.log)}`));
      });
    });
  }

  async stop(): Promise<string> {
    const child = this.child;
    if (!child) throw new Error("Not recording");
    this.child = undefined;
    let killed = false;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.stdin.end("q"); // ffmpeg's "quit" key: finishes the file cleanly
      const timer = setTimeout(() => {
        killed = true; // an MKV cut short is still playable
        child.kill("SIGINT");
      }, 10_000);
      await exited;
      clearTimeout(timer);
    }
    if (!killed && child.exitCode !== 0) throw new Error(`ffmpeg failed while recording (exit ${child.exitCode ?? child.signalCode}):\n${tailLines(this.log)}`);
    return this.file;
  }

  async restore(): Promise<void> {}

  async dispose(): Promise<void> {
    // Only after an error: never leave a recorder running.
    this.child?.kill();
    this.child = undefined;
  }
}

export function macAvfoundationBackend(api: MacCaptureApi, ffmpeg = "ffmpeg"): RecorderBackend {
  return new MacAvfoundationRecorder(api, ffmpeg);
}

/** `screencapture` arguments for one still of a display (global points; the image is in pixels). */
export function screencaptureArgs(screen: Rect, file: string): string[] {
  const r = [screen.x, screen.y, screen.w, screen.h].map((n) => String(Math.round(n))).join(",");
  return ["-x", "-C", `-R${r}`, "-t", "png", file];
}
