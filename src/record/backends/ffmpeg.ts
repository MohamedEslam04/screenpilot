import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { run } from "../../util/exec.js";
import { canvasFor, type RecorderBackend } from "../backend.js";
import type { ScreenInfo } from "../input/types.js";
import type { CaptureInfo } from "../obs.js";

// Recording the desktop with ffmpeg's own screen grabbers (gdigrab on
// Windows, x11grab on X11): H.264 into an MKV, which survives an unclean stop.

export const FPS = 30;

/** Frame counter of the last ffmpeg progress line in `text`, if any. */
export function progressFrame(text: string): number | undefined {
  const all = [...text.matchAll(/frame=\s*(\d+)/g)];
  const last = all.at(-1);
  return last ? Number(last[1]) : undefined;
}

/** H.264 output shared by the grabbers; odd sizes are cropped to even (yuv420p needs it). */
export function encodeArgs(w: number, h: number, file: string): string[] {
  const ew = w - (w % 2);
  const eh = h - (h % 2);
  return [
    ...(ew !== w || eh !== h ? ["-vf", `crop=${ew}:${eh}:0:0`] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-stats",
    "-stats_period", "0.1",
    "-y",
    file,
  ];
}

const tailLines = (s: string) => s.split(/[\r\n]+/).filter(Boolean).slice(-10).join("\n");

export interface Grabber {
  /** ffmpeg input format, e.g. "gdigrab" (also the CaptureInfo inputKind). */
  kind: string;
  /** CaptureInfo sourceName. */
  source: string;
  /** Full ffmpeg arguments; throws on an area it can't record. */
  args(screens: ScreenInfo[], allScreens: ScreenInfo[], file: string): string[];
  /** Said when ffmpeg is not on PATH. */
  missing: string;
}

export class FfmpegRecorder implements RecorderBackend {
  readonly id = "native" as const;
  startedAt = 0;
  private screens: ScreenInfo[] = [];
  private allScreens: ScreenInfo[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private file = "";
  private log = "";

  constructor(
    private grabber: Grabber,
    private ffmpeg = "ffmpeg",
  ) {}

  async prepare(screens: ScreenInfo[], allScreens: ScreenInfo[], log: (m: string) => void): Promise<CaptureInfo> {
    if (!screens.length) throw new Error("No monitor to record");
    try {
      await run(this.ffmpeg, ["-hide_banner", "-version"]);
    } catch {
      throw new Error(this.grabber.missing);
    }
    this.grabber.args(screens, allScreens, "check.mkv"); // fail now on a bad area, not at start
    this.screens = screens;
    this.allScreens = allScreens;
    log(`recording ${screens.map((s) => s.name).join(" + ")} with ffmpeg (${this.grabber.kind})`);
    return canvasFor(screens, FPS, this.grabber.kind, this.grabber.source);
  }

  async start(dir: string): Promise<void> {
    this.file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.mkv`);
    const child = spawn(this.ffmpeg, this.grabber.args(this.screens, this.allScreens, this.file), { stdio: "pipe", windowsHide: true });
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
        child.kill();
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
