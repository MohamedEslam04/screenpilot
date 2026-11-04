import { TargetError } from "../drive/errors.js";
import type { DesktopId } from "../platform/detect.js";
import type { Desktop, WindowInfo } from "../platform/types.js";
import { appPids, findMatches, pickMatch, placeWindows, pruneTree } from "./locate.js";
import type { A11yMatch, A11yQuery, A11ySource, PlacedWindow } from "./types.js";

export type { A11yMatch, A11yNode, A11yQuery, PlacedWindow } from "./types.js";

// Accessibility locator: find a control by role and name instead of by pixels.
// It only LOCATES. The real pointer still moves there and clicks, so a recording
// shows a normal cursor. Rects come back in global desktop pixels.

type DesktopLike = Pick<Desktop, "id" | "windowControl" | "listWindows">;

/** The OS accessibility source, loaded on demand; undefined where none is built yet. */
export async function sourceFor(id: DesktopId): Promise<A11ySource | undefined> {
  switch (id) {
    case "kde":
    case "x11":
    case "portal":
      return (await import("./atspi.js")).atspiSource;
    case "macos":
      return (await import("./ax.js")).axSource;
    case "windows":
      return (await import("./uia.js")).uiaSource;
  }
}

const NO_SOURCE = (id: string) =>
  new TargetError("A11Y_UNAVAILABLE", `Accessibility targets are not available on ${id} yet (Linux has AT-SPI, macOS the AX API, Windows UI Automation). Use {window, x, y} or {screen, x, y} targets there.`);

async function need(desktop: DesktopLike, source?: A11ySource): Promise<A11ySource> {
  const s = source ?? (await sourceFor(desktop.id));
  if (!s) throw NO_SOURCE(desktop.id);
  return s;
}

async function desktopWindows(d: DesktopLike): Promise<WindowInfo[]> {
  if (!d.windowControl) return [];
  try {
    return await d.listWindows();
  } catch {
    return [];
  }
}

export interface TreeOptions {
  app?: string;
  maxDepth?: number;
  maxNodes?: number;
  /** Keep only controls and the containers that lead to them. Default true. */
  interactiveOnly?: boolean;
}

/** Read raw windows for an app (default: the focused window's app when the desktop can tell, else every app) and place them. */
async function read(desktop: DesktopLike, o: { app?: string; maxDepth: number; maxNodes: number }, source?: A11ySource) {
  const s = await need(desktop, source);
  const windows = await desktopWindows(desktop);
  let pids: number[] | undefined;
  if (o.app) pids = appPids(windows, o.app);
  else {
    const active = windows.find((w) => w.active);
    if (active && active.pid > 0) pids = [active.pid];
  }
  let raw;
  try {
    raw = await s.windows({ ...(o.app ? { app: o.app } : {}), ...(pids?.length ? { pids } : {}), maxDepth: o.maxDepth, maxNodes: o.maxNodes });
  } catch (e) {
    throw new TargetError("A11Y_UNAVAILABLE", `Cannot read the accessibility tree: ${(e as Error).message}`);
  }
  if (!raw.windows.length) {
    throw new TargetError(
      "APP_NOT_FOUND",
      o.app
        ? `No accessible app matches "${o.app}". Is it running? Qt apps need QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 when they are launched.`
        : "No accessible app found for the focused window. Pass app, or focus the app first.",
    );
  }
  const minimized = new Set(windows.filter((w) => w.minimized).map((w) => w.id));
  const placed = placeWindows(raw.windows, windows, desktop.id === "x11" || desktop.id === "macos" || desktop.id === "windows").filter((p) => !(p.window && minimized.has(p.window.id)));
  return { placed, warnings: raw.warnings };
}

export interface TreeResult {
  windows: PlacedWindow[];
  warnings: string[];
}

export async function a11yTree(desktop: DesktopLike, o: TreeOptions = {}, source?: A11ySource): Promise<TreeResult> {
  const { placed, warnings } = await read(desktop, { app: o.app, maxDepth: o.maxDepth ?? 20, maxNodes: o.maxNodes ?? 1500 }, source);
  const interactiveOnly = o.interactiveOnly ?? true;
  return { windows: placed.map((p) => ({ ...p, root: pruneTree(p.root, interactiveOnly) })), warnings };
}

async function matches(desktop: DesktopLike, q: A11yQuery, source?: A11ySource): Promise<A11yMatch[]> {
  const { placed } = await read(desktop, { app: q.app, maxDepth: 30, maxNodes: 5000 }, source);
  return findMatches(placed, q);
}

/** Exactly one element, as a rectangle in global pixels; throws a coded error otherwise. */
export async function a11yFind(desktop: DesktopLike, q: A11yQuery, source?: A11ySource): Promise<A11yMatch> {
  return pickMatch(await matches(desktop, q, source), q);
}

/** Every matching element (for the agent to look at, not to click blindly). */
export async function a11yFindAll(desktop: DesktopLike, q: A11yQuery, source?: A11ySource): Promise<A11yMatch[]> {
  return matches(desktop, q, source);
}

/** Wait until an element shows up (several matches count as shown). */
export async function a11yWait(desktop: DesktopLike, q: A11yQuery, timeoutMs: number, source?: A11ySource): Promise<A11yMatch> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const m = await matches(desktop, q, source);
      if (m.length) return m[0]!;
      last = "no matching element";
    } catch (e) {
      if (!(e instanceof TargetError) || e.code === "A11Y_UNAVAILABLE" || e.code === "POSITION_UNKNOWN") throw e;
      last = e.message;
    }
    if (Date.now() > deadline) throw new TargetError("TIMEOUT", `Element did not show up within ${Math.round(timeoutMs / 1000)}s (${last})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function a11yStatus(id: DesktopId): Promise<{ ok: boolean; detail: string; skipped?: boolean }> {
  const s = await sourceFor(id);
  if (!s) return { ok: true, skipped: true, detail: `not built for ${id} yet (Linux has AT-SPI, macOS the AX API, Windows UI Automation)` };
  return s.status();
}

/** Env for apps screenpilot launches, so Qt apps show up on the accessibility bus. */
export function launchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, QT_LINUX_ACCESSIBILITY_ALWAYS_ON: env.QT_LINUX_ACCESSIBILITY_ALWAYS_ON ?? "1", QT_ACCESSIBILITY: env.QT_ACCESSIBILITY ?? "1" };
}
