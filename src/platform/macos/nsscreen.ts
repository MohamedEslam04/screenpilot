import { run } from "../../util/exec.js";
import type { NsScreen } from "./geometry.js";

// Display names and work areas come from AppKit's NSScreen, which is
// Objective-C: a tiny JXA script (osascript, no extra permission) reads them.

export const NSSCREEN_JXA = `
ObjC.import("AppKit");
var out = [];
var list = $.NSScreen.screens;
for (var i = 0; i < list.count; i++) {
  var s = list.objectAtIndex(i);
  var f = s.frame, v = s.visibleFrame;
  var name = "";
  try { name = ObjC.unwrap(s.localizedName) || ""; } catch (e) {} // macOS 10.15+
  out.push({
    id: ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber")),
    name: name || "",
    frame: [f.origin.x, f.origin.y, f.size.width, f.size.height],
    visible: [v.origin.x, v.origin.y, v.size.width, v.size.height]
  });
}
JSON.stringify(out);
`;

const rect = (a: unknown) => {
  const [x, y, w, h] = (Array.isArray(a) ? a : []).map(Number);
  return { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 };
};

/** osascript's output → screens; [] when it is not what we expect. */
export function parseNsScreens(stdout: string): NsScreen[] {
  try {
    const rows = JSON.parse(stdout.trim()) as { id: unknown; name: unknown; frame: unknown; visible: unknown }[];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), frame: rect(r.frame), visible: rect(r.visible) }))
      .filter((r) => Number.isFinite(r.id) && r.frame.w > 0 && r.frame.h > 0);
  } catch {
    return [];
  }
}

let cache: { key: string; screens: NsScreen[] } | undefined;

/** NSScreen info, cached while the display set (`key`) stays the same; [] if osascript fails. */
export async function nsScreens(key: string): Promise<NsScreen[]> {
  if (cache?.key === key) return cache.screens;
  let screens: NsScreen[] = [];
  try {
    screens = parseNsScreens((await run("osascript", ["-l", "JavaScript", "-e", NSSCREEN_JXA])).stdout);
  } catch {
    // fall back to Quartz-only names and full-bounds work areas
  }
  if (screens.length) cache = { key, screens };
  return screens;
}
