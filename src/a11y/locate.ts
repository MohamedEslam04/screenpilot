import { TargetError } from "../drive/errors.js";
import type { WindowInfo } from "../platform/types.js";
import type { A11yMatch, A11yNode, A11yQuery, PlacedWindow, RawNode, RawWindow } from "./types.js";

// Pure part of the accessibility locator: put raw trees in global desktop
// pixels, find elements, refuse to guess between several.

const ALIASES: Record<string, string[]> = {
  button: ["push button", "toggle button"],
  checkbox: ["check box"],
  radio: ["radio button"],
  tab: ["page tab"],
  textbox: ["entry", "text", "password text"],
  input: ["entry", "text", "password text"],
  menuitem: ["menu item", "check menu item", "radio menu item"],
  combobox: ["combo box"],
  listitem: ["list item"],
  treeitem: ["tree item"],
  spinbutton: ["spin button"],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]+/g, " ").trim();

/** Whether a node's AT-SPI role matches a role the caller typed ("button" matches "push button"). */
export function roleMatches(query: string, role: string): boolean {
  const q = norm(query);
  const r = norm(role);
  if (q === r) return true;
  return ALIASES[q.replace(/ /g, "")]?.includes(r) ?? false;
}

const INTERACTIVE = new Set([
  "push button",
  "toggle button",
  "check box",
  "radio button",
  "menu",
  "menu item",
  "check menu item",
  "radio menu item",
  "entry",
  "text",
  "password text",
  "combo box",
  "spin button",
  "slider",
  "link",
  "page tab",
  "list item",
  "tree item",
]);

/** On screen: a real size, not the "off screen" sentinel, and showing when the app says so. */
export function isVisible(n: Pick<A11yNode, "x" | "y" | "w" | "h" | "states">): boolean {
  if (n.w <= 0 || n.h <= 0) return false;
  if (n.x < -100000 || n.y < -100000) return false;
  return n.states.length === 0 || n.states.includes("showing");
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** The desktop window an AT-SPI frame belongs to: same pid, then title, then size, then the only candidate. */
function matchWindow(w: RawWindow, windows: WindowInfo[]): WindowInfo | undefined {
  const pool = w.pid > 0 ? windows.filter((x) => x.pid === w.pid) : windows;
  if (!pool.length) return undefined;
  const title = w.title.toLowerCase();
  const exact = pool.filter((x) => x.caption.toLowerCase() === title);
  if (exact.length) return pickSized(exact, w);
  const sized = w.rect ? pool.filter((x) => near(x.w, w.rect!.w) && near(x.h, w.rect!.h)) : [];
  if (sized.length) return sized[0];
  const partial = pool.filter((x) => title && (x.caption.toLowerCase().includes(title) || title.includes(x.caption.toLowerCase())));
  if (partial.length) return pickSized(partial, w);
  return pool.length === 1 ? pool[0] : undefined;
}

function pickSized(c: WindowInfo[], w: RawWindow): WindowInfo | undefined {
  if (c.length === 1 || !w.rect) return c[0];
  return c.find((x) => near(x.w, w.rect!.w) && near(x.h, w.rect!.h)) ?? c[0];
}

function convert(n: RawNode, dx: number, dy: number): A11yNode {
  return {
    role: n.role,
    name: n.name,
    x: n.rect ? n.rect.x + dx : 0,
    y: n.rect ? n.rect.y + dy : 0,
    w: n.rect?.w ?? 0,
    h: n.rect?.h ?? 0,
    states: n.states,
    children: n.children.map((c) => convert(c, dx, dy)),
  };
}

/**
 * Put raw trees in global desktop pixels. On Wayland extents are relative to
 * the window, so the window's position (from the desktop's window list) is
 * added; where extents are already global (X11) the same formula adds ~0.
 * With no matching window the tree stays relative and `placed` is false,
 * unless `assumeGlobal` says extents are global anyway (X11).
 */
export function placeWindows(raw: RawWindow[], windows: WindowInfo[], assumeGlobal: boolean): PlacedWindow[] {
  return raw.map((w) => {
    const frame = w.rect ?? w.root.rect;
    const dw = matchWindow(w, windows);
    let dx = 0;
    let dy = 0;
    let placed = assumeGlobal;
    if (dw && frame) {
      dx = dw.x - frame.x;
      dy = dw.y - frame.y;
      placed = true;
    }
    return {
      app: w.app,
      pid: w.pid,
      title: w.title,
      ...(dw ? { window: { id: dw.id, caption: dw.caption, resourceClass: dw.resourceClass } } : {}),
      placed,
      truncated: w.truncated,
      root: convert(w.root, dx, dy),
    };
  });
}

export function flatten(p: PlacedWindow): A11yNode[] {
  const out: A11yNode[] = [];
  const walk = (n: A11yNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(p.root);
  return out;
}

const matchOf = (n: A11yNode, p: PlacedWindow): A11yMatch => ({
  role: n.role,
  name: n.name,
  app: p.app,
  window: p.title,
  x: Math.round(n.x),
  y: Math.round(n.y),
  w: Math.round(n.w),
  h: Math.round(n.h),
  cx: Math.round(n.x + n.w / 2),
  cy: Math.round(n.y + n.h / 2),
  states: n.states,
});

/** Visible elements matching the query, in document order. Throws when only windows with unknown position match. */
export function findMatches(placed: PlacedWindow[], q: A11yQuery): A11yMatch[] {
  if (!q.role && !q.name) throw new Error("Give a role or a name to look for.");
  const name = q.name?.toLowerCase();
  const hit = (n: A11yNode) =>
    isVisible(n) &&
    (!q.role || roleMatches(q.role, n.role)) &&
    (name === undefined || (q.exact ? n.name.toLowerCase() === name : n.name.toLowerCase().includes(name)));

  const found: A11yMatch[] = [];
  let unplaced = 0;
  for (const p of placed) {
    const hits = flatten(p).filter(hit);
    if (!p.placed) unplaced += hits.length;
    else found.push(...hits.map((n) => matchOf(n, p)));
  }
  if (!found.length && unplaced) {
    throw new TargetError(
      "POSITION_UNKNOWN",
      `Found ${unplaced} matching element(s), but this desktop does not say where their window is, so they cannot be clicked. Use a {screen, x, y} target, or read the element with a11y_tree.`,
    );
  }
  return found;
}

const describe = (m: A11yMatch) => `${m.role} "${m.name}" at ${m.x},${m.y} ${m.w}x${m.h} (${m.app}: ${m.window})`;
const sig = (m: A11yMatch) => `${m.role}|${m.name}|${m.x},${m.y},${m.w},${m.h}`;

/** Exactly one element, or an error that says what to do: never a guess. */
export function pickMatch(matches: A11yMatch[], q: A11yQuery): A11yMatch {
  const seen = new Set<string>();
  const unique = matches.filter((m) => !seen.has(sig(m)) && seen.add(sig(m)));
  const what = [q.role, q.name && `"${q.name}"`, q.app && `in ${q.app}`].filter(Boolean).join(" ");
  if (!unique.length) {
    throw new TargetError("ELEMENT_NOT_FOUND", `No visible element matches ${what}. Read the UI with a11y_tree (or wait_for) and check the role and name; Qt apps need QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 at launch.`);
  }
  if (q.nth) {
    if (q.nth > unique.length) throw new TargetError("ELEMENT_NOT_FOUND", `Asked for match ${q.nth} of ${what}, but only ${unique.length} match.`, unique.map(describe));
    return unique[q.nth - 1]!;
  }
  if (unique.length > 1) {
    const candidates = unique.slice(0, 8).map(describe);
    throw new TargetError(
      "AMBIGUOUS_TARGET",
      `${unique.length} elements match ${what}; add nth (1-${unique.length}), exact, or a more specific name. Candidates:\n${candidates.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`,
      candidates,
    );
  }
  return unique[0]!;
}

/** Tree for reading: invisible parts dropped; with `interactiveOnly`, only controls and the containers that lead to them. */
export function pruneTree(n: A11yNode, interactiveOnly: boolean): A11yNode {
  const children = n.children
    .filter(isVisible)
    .map((c) => pruneTree(c, interactiveOnly))
    .filter((c) => !interactiveOnly || INTERACTIVE.has(c.role) || c.children.length > 0);
  return { ...n, children };
}

/** Pids of desktop windows whose class or title contains `app`. */
export function appPids(windows: WindowInfo[], app: string): number[] {
  const a = app.toLowerCase();
  const pids: number[] = [];
  for (const w of windows) {
    if ((w.resourceClass.toLowerCase().includes(a) || w.caption.toLowerCase().includes(a)) && w.pid > 0 && !pids.includes(w.pid)) pids.push(w.pid);
  }
  return pids;
}
