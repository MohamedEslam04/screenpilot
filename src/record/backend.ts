import type { ScreenInfo } from "./input/types.js";
import type { CaptureInfo } from "./obs.js";

// Who actually captures the screen. "obs" drives OBS Studio over its
// websocket; "native" needs nothing but what the tool already requires
// (PipeWire + GStreamer on KDE, ffmpeg on Windows).

export type RecorderId = "obs" | "native";

export interface RecorderBackend {
  readonly id: RecorderId;
  /**
   * Get ready to record `screens` (one or more monitors, side by side as on
   * the desktop). `allScreens` is every monitor, for layout decisions.
   */
  prepare(screens: ScreenInfo[], allScreens: ScreenInfo[], log: (m: string) => void): Promise<CaptureInfo>;
  /** Start writing into `dir`; resolves once the first frame is being recorded. */
  start(dir: string): Promise<void>;
  /** performance.now() when recording really started (for syncing pointer/window logs). */
  readonly startedAt: number;
  /** Stop and finalize the file; returns its path. */
  stop(): Promise<string>;
  /** Undo anything changed for the recording (best effort; also called on errors). */
  restore(): Promise<void>;
  dispose(): Promise<void>;
}

/** Canvas info for monitors laid out side by side as on the desktop (shared by native backends). */
export function canvasFor(screens: ScreenInfo[], fps: number, inputKind: string, sourceName: string): CaptureInfo {
  const x0 = Math.min(...screens.map((s) => s.x));
  const y0 = Math.min(...screens.map((s) => s.y));
  const w = Math.max(...screens.map((s) => s.x + s.w)) - x0;
  const h = Math.max(...screens.map((s) => s.y + s.h)) - y0;
  return {
    sourceWidth: w,
    sourceHeight: h,
    contentRect: { x: 0, y: 0, w: 1, h: 1 },
    canvas: { width: w, height: h, fps },
    inputKind,
    sourceName,
    ...(screens.length > 1
      ? { canvasScreens: screens.map((s) => ({ name: s.name, x: (s.x - x0) / w, y: (s.y - y0) / h, w: s.w / w, h: s.h / h })) }
      : {}),
  };
}
