import { installHint } from "../../util/distro.js";
import { run } from "../../util/exec.js";
import type { RecorderBackend } from "../backend.js";
import type { ScreenInfo } from "../input/types.js";
import { unionRect } from "../obs.js";
import { encodeArgs, FfmpegRecorder, FPS } from "./ffmpeg.js";

// Native recorder for X11 sessions: ffmpeg's x11grab grabs the monitors'
// area of the root window (with the pointer). Several monitors are one
// grab of their bounding box, laid out as on the desktop.

/** ffmpeg arguments to record `screens` (root-window px) from X display `display`. */
export function x11grabArgs(screens: ScreenInfo[], allScreens: ScreenInfo[], file: string, display = process.env.DISPLAY ?? ":0", fps = FPS): string[] {
  const r = unionRect(screens);
  const v = unionRect(allScreens);
  if (r.x < 0 || r.y < 0 || r.x + r.w > v.x + v.w || r.y + r.h > v.y + v.h) {
    throw new Error(`Capture area ${r.w}x${r.h}+${r.x}+${r.y} is outside the X screen ${v.x + v.w}x${v.y + v.h}`);
  }
  return [
    "-hide_banner",
    "-f", "x11grab",
    "-framerate", String(fps),
    "-draw_mouse", "1",
    "-video_size", `${r.w}x${r.h}`,
    "-i", `${display}+${r.x},${r.y}`,
    ...encodeArgs(r.w, r.h, file),
  ];
}

export function x11FfmpegBackend(ffmpeg = "ffmpeg"): RecorderBackend {
  return new FfmpegRecorder(
    {
      kind: "x11grab",
      source: process.env.DISPLAY ?? ":0",
      args: (screens, all, file) => x11grabArgs(screens, all, file),
      missing: `ffmpeg was not found on PATH; it is needed to record on X11 (${installHint("ffmpeg")}).`,
    },
    ffmpeg,
  );
}

/** ffmpeg arguments for one still of a monitor. */
export function x11grabStillArgs(screen: ScreenInfo, file: string, width: number, display = process.env.DISPLAY ?? ":0"): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "x11grab",
    "-draw_mouse", "1",
    "-video_size", `${screen.w}x${screen.h}`,
    "-i", `${display}+${screen.x},${screen.y}`,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "3",
    "-y",
    file,
  ];
}

/** Whether this ffmpeg was built with x11grab. */
export async function hasX11grab(ffmpeg = "ffmpeg"): Promise<boolean> {
  try {
    return /\bx11grab\b/.test((await run(ffmpeg, ["-hide_banner", "-devices"])).stdout);
  } catch {
    return false;
  }
}
