import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RemoteDesktopSession } from "../../drive/portal.js";
import { mapStreams, openRemoteDesktop } from "../../platform/kde.js";
import { run } from "../../util/exec.js";
import { canvasFor, type RecorderBackend } from "../backend.js";
import type { ScreenInfo } from "../input/types.js";
import type { CaptureInfo } from "../obs.js";

// Native recording on KDE Plasma: the xdg portal gives us a PipeWire stream
// per monitor (already approved for remote control, so no dialog), and
// GStreamer composes the chosen monitors side by side and encodes H.264.

const FPS = 30;
const ENCODERS = ["x264enc", "openh264enc", "vah264enc", "vaapih264enc"] as const;

export async function gstAvailable(): Promise<boolean> {
  try {
    await run("gst-inspect-1.0", ["pipewiresrc"]);
    return (await pickEncoder()) !== undefined;
  } catch {
    return false;
  }
}

let encoder: string | undefined | null = null;
async function pickEncoder(): Promise<string | undefined> {
  if (encoder !== null) return encoder;
  encoder = undefined;
  for (const e of ENCODERS) {
    try {
      await run("gst-inspect-1.0", [e]);
      encoder = e;
      break;
    } catch {
      // not installed
    }
  }
  return encoder;
}

function encoderArgs(name: string): string[] {
  switch (name) {
    case "x264enc":
      return ["x264enc", "speed-preset=veryfast", "tune=zerolatency", "bitrate=16000", "key-int-max=60"];
    case "openh264enc":
      return ["openh264enc", "bitrate=16000000", "rate-control=bitrate", "usage-type=screen", "gop-size=60"];
    default:
      return [name, "bitrate=16000"];
  }
}

export interface StreamPlacement {
  node: number;
  /** Position/size in the output canvas (pixels). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** gst-launch arguments: one pipewiresrc per monitor, composed side by side, encoded into Matroska. */
export function buildPipeline(streams: StreamPlacement[], canvas: { w: number; h: number }, enc: string, out: string): string[] {
  const tail = ["videoconvert", "!", "video/x-raw,format=I420", "!", ...encoderArgs(enc), "!", "h264parse", "!", "matroskamux", "!", "filesink", `location=${out}`];
  const src = (s: StreamPlacement) => ["pipewiresrc", `path=${s.node}`, "do-timestamp=true", "keepalive-time=100", "!", "videoconvert", "!", "videorate", "!", `video/x-raw,framerate=${FPS}/1`];
  if (streams.length === 1) {
    const s = streams[0]!;
    return ["-e", ...src(s), "!", "videoscale", "!", `video/x-raw,width=${s.w},height=${s.h}`, "!", ...tail];
  }
  const pads = streams.flatMap((s, i) => [`sink_${i}::xpos=${s.x}`, `sink_${i}::ypos=${s.y}`, `sink_${i}::width=${s.w}`, `sink_${i}::height=${s.h}`]);
  const args = ["-e", "compositor", "name=mix", "background=black", ...pads, "!", `video/x-raw,width=${canvas.w},height=${canvas.h},framerate=${FPS}/1`, "!", "queue", "!", ...tail];
  streams.forEach((s, i) => args.push(...src(s), "!", "queue", "!", `mix.sink_${i}`));
  return args;
}

export class KdePipewireBackend implements RecorderBackend {
  readonly id = "native" as const;
  startedAt = 0;
  private portal?: RemoteDesktopSession;
  private gst?: ChildProcess;
  private output = "";
  private placements: StreamPlacement[] = [];
  private canvas = { w: 0, h: 0 };
  private enc = "";
  private log: (m: string) => void = () => {};

  async prepare(screens: ScreenInfo[], _all: ScreenInfo[], log: (m: string) => void): Promise<CaptureInfo> {
    this.log = log;
    const enc = await pickEncoder();
    if (!enc) throw new Error("No GStreamer H.264 encoder (install gstreamer1-plugin-openh264 or x264).");
    this.enc = enc;
    this.portal = await openRemoteDesktop(log);
    const streamOf = mapStreams(this.portal.streams, screens);
    const missing = screens.filter((s) => !streamOf.has(s.name));
    if (missing.length) throw new Error(`No screen stream for ${missing.map((s) => s.name).join(", ")} (allow all monitors in the KDE dialog)`);
    const capture = canvasFor(screens, FPS, `pipewire+${enc}`, screens.map((s) => s.name).join(" + "));
    const x0 = Math.min(...screens.map((s) => s.x));
    const y0 = Math.min(...screens.map((s) => s.y));
    this.canvas = { w: capture.canvas.width, h: capture.canvas.height };
    this.placements = screens.map((s) => ({ node: streamOf.get(s.name)!.node, x: s.x - x0, y: s.y - y0, w: s.w, h: s.h }));
    return capture;
  }

  async start(dir: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.output = join(dir, `${stamp}.mkv`);
    const args = buildPipeline(this.placements, this.canvas, this.enc, this.output);
    const gst = spawn("gst-launch-1.0", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.gst = gst;
    let logText = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`GStreamer did not start:\n${logText.slice(-800)}`)), 15_000);
      const onData = (d: Buffer) => {
        logText += d;
        // The pipeline clock starts with PLAYING; frames are timestamped from there.
        if (!this.startedAt && /Setting pipeline to PLAYING/.test(logText)) {
          this.startedAt = performance.now();
          clearTimeout(timer);
          resolve();
        }
      };
      gst.stdout!.on("data", onData);
      gst.stderr!.on("data", onData);
      gst.on("error", (e) => reject(e));
      gst.on("exit", (code) => {
        if (!this.startedAt) reject(new Error(`GStreamer exited (${code}):\n${logText.slice(-800)}`));
      });
    });
    this.log(`native recording (${this.enc})`);
  }

  async stop(): Promise<string> {
    const gst = this.gst;
    if (gst && gst.exitCode === null) {
      const done = new Promise((r) => gst.on("close", r));
      gst.kill("SIGINT"); // -e: send EOS so the file is finalized
      const t = setTimeout(() => gst.kill("SIGKILL"), 20_000);
      await done;
      clearTimeout(t);
    }
    await this.portal?.close();
    this.portal = undefined;
    return this.output;
  }

  async restore(): Promise<void> {
    if (this.gst && this.gst.exitCode === null) this.gst.kill("SIGKILL");
    await this.portal?.close().catch(() => {});
    this.portal = undefined;
  }

  async dispose(): Promise<void> {}
}
