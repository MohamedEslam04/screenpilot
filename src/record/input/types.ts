export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenInfo extends Rect {
  name: string;
  manufacturer?: string;
  model?: string;
  /** Windows: monitor device interface path (what OBS's monitor_capture stores as monitor_id). */
  deviceId?: string;
}

/** Pointer event in global desktop pixels; `at` is performance.now() ms. */
export interface RawEvent {
  at: number;
  type: "move" | "down" | "up" | "scroll";
  px: number;
  py: number;
  button?: number;
}

export interface InputAdapter {
  readonly id: string;
  readonly events: RawEvent[];
  readonly warnings: string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Monitors known to the adapter (KWin reports them; others may not). */
  screens(): ScreenInfo[];
  /** Last known pointer position, if any. */
  cursor(): { x: number; y: number } | undefined;
}

/** The monitor an OBS source captures, guessed from its name (e.g. "Lenovo R24e | Monitor"). */
export function screenForSourceName(screens: ScreenInfo[], sourceName: string): ScreenInfo | undefined {
  const src = sourceName.toLowerCase();
  const hits = screens.filter((s) => {
    const words = [s.name, s.model].filter((w): w is string => !!w && w.length >= 3);
    return words.some((w) => src.includes(w.toLowerCase()));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

export function screenAt(screens: ScreenInfo[], x: number, y: number): ScreenInfo | undefined {
  return screens.find((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
}
