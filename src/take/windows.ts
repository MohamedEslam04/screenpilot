import type { WindowInfo } from "../platform/types.js";

/** Every window a match refers to: app class first, else caption (contains, case-insensitive). */
export function windowMatches(windows: WindowInfo[], match: string): WindowInfo[] {
  const m = match.toLowerCase();
  const byClass = windows.filter((w) => w.resourceClass.toLowerCase().includes(m));
  return byClass.length ? byClass : windows.filter((w) => w.caption.toLowerCase().includes(m));
}
