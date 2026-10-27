import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { run } from "../../util/exec.js";
import { canvasFor, type RecorderBackend } from "../backend.js";
import type { ScreenInfo } from "../input/types.js";
import { unionRect } from "../obs.js";

// Native recorder for Windows: ffmpeg's gdigrab grabs the monitors' area of
// the desktop (with the pointer) and encodes H.264 into an MKV, which
// survives an unclean stop.

const FPS = 30;

/**
 * ffmpeg arguments to record `screens` (global px, as ScreenInfo). gdigrab
 * offsets are desktop coordinates from the PRIMARY monitor's top-left (not
 * from the virtual screen's corner), so monitors left of / above it need
 * negative offsets. `allScreens` bounds the virtual desktop.
 */
export function gdigrabArgs(screens: ScreenInfo[], allScreens: ScreenInfo[], file: string, fps = FPS): string[] {
  const r = unionRect(screens);
  const v = unionRect(allScreens);
  if (r.x < v.x || r.y < v.y || r.x + r.w > v.x + v.w || r.y + r.h > v.y + v.h) {
    throw new Error(`Capture area ${r.w}x${r.h}+${r.x}+${r.y} is outside the desktop ${v.w}x${v.h}+${v.x}+${v.y}`);
  }
  // yuv420p needs even sizes.
  const ew = r.w - (r.w % 2);
  const eh = r.h - (r.h % 2);
  return [
    "-hide_banner",
    "-f", "gdigrab",
    "-framerate", String(fps),
    "-draw_mouse", "1",
    "-offset_x", String(r.x),
    "-offset_y", String(r.y),
    "-video_size", `${r.w}x${r.h}`,
    "-i", "desktop",
    ...(ew !== r.w || eh !== r.h ? ["-vf", `crop=${ew}:${eh}:0:0`] : []),
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

/** Frame counter of the last ffmpeg progress line in `text`, if any. */
export function progressFrame(text: string): number | undefined {
  const all = [...text.matchAll(/frame=\s*(\d+)/g)];
  const last = all.at(-1);
  return last ? Number(last[1]) : undefined;
}

const tailLines = (s: string) => s.split(/[\r\n]+/).filter(Boolean).slice(-10).join("\n");

class WindowsFfmpegRecorder implements RecorderBackend {
  readonly id = "native" as const;
  startedAt = 0;
  private screens: ScreenInfo[] = [];
  private allScreens: ScreenInfo[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private file = "";
  private log = "";

  constructor(private ffmpeg: string) {}

  async prepare(screens: ScreenInfo[], allScreens: ScreenInfo[], log: (m: string) => void) {
    if (!screens.length) throw new Error("No monitor to record");
    try {
      await run(this.ffmpeg, ["-hide_banner", "-version"]);
    } catch {
      throw new Error("ffmpeg was not found on PATH; it is needed to record on Windows (e.g. `winget install Gyan.FFmpeg`).");
    }
    gdigrabArgs(screens, allScreens, "check.mkv"); // fail now on a bad area, not at start
    this.screens = screens;
    this.allScreens = allScreens;
    log(`recording ${screens.map((s) => s.name).join(" + ")} with ffmpeg (gdigrab)`);
    return canvasFor(screens, FPS, "gdigrab", "desktop");
  }

  async start(dir: string): Promise<void> {
    this.file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.mkv`);
    const child = spawn(this.ffmpeg, gdigrabArgs(this.screens, this.allScreens, this.file), { stdio: "pipe", windowsHide: true });
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

export function windowsFfmpegBackend(ffmpeg = "ffmpeg"): RecorderBackend {
  return new WindowsFfmpegRecorder(ffmpeg);
}
