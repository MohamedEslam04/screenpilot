import type { RecorderBackend } from "../backend.js";
import type { ScreenInfo } from "../input/types.js";
import { unionRect } from "../obs.js";
import { encodeArgs, FfmpegRecorder, FPS, progressFrame } from "./ffmpeg.js";

// Native recorder for Windows: ffmpeg's gdigrab grabs the monitors' area of
// the desktop (with the pointer) and encodes H.264 into an MKV, which
// survives an unclean stop.

export { progressFrame };

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
  return [
    "-hide_banner",
    "-f", "gdigrab",
    "-framerate", String(fps),
    "-draw_mouse", "1",
    "-offset_x", String(r.x),
    "-offset_y", String(r.y),
    "-video_size", `${r.w}x${r.h}`,
    "-i", "desktop",
    ...encodeArgs(r.w, r.h, file),
  ];
}

export function windowsFfmpegBackend(ffmpeg = "ffmpeg"): RecorderBackend {
  return new FfmpegRecorder(
    {
      kind: "gdigrab",
      source: "desktop",
      args: (screens, all, file) => gdigrabArgs(screens, all, file),
      missing: "ffmpeg was not found on PATH; it is needed to record on Windows (e.g. `winget install Gyan.FFmpeg`).",
    },
    ffmpeg,
  );
}

/** ffmpeg arguments for one still of a monitor (no OBS). */
export function gdigrabStillArgs(screen: ScreenInfo, file: string, width: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-f", "gdigrab",
    "-draw_mouse", "1",
    "-offset_x", String(screen.x),
    "-offset_y", String(screen.y),
    "-video_size", `${screen.w}x${screen.h}`,
    "-i", "desktop",
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "3",
    "-y",
    file,
  ];
}
