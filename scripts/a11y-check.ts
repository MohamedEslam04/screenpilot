// Shared by the Windows and macOS smoke scripts: read an app's accessibility
// tree on a real desktop and check it against the window list. Throws on failure.
import { a11yFind, a11yTree } from "../src/a11y/index.js";
import type { Desktop, WindowInfo } from "../src/platform/index.js";

type Flat = { role: string; name: string; x: number; y: number; w: number; h: number; children: Flat[] };

/** `tol`: how far the tree's frame may differ from the window list (invisible borders, shadows). */
export async function a11yCheck(desktop: Desktop, app: string, win: WindowInfo, tol: number): Promise<string> {
  const tree = await a11yTree(desktop, { app, interactiveOnly: false, maxDepth: 12 });
  const w = tree.windows.find((x) => x.placed);
  if (!w) throw new Error(`no placed accessibility window for "${app}" (${tree.windows.length} window(s), warnings: ${tree.warnings.join("; ") || "none"})`);

  let nodes = 0;
  const walk = (n: Flat) => {
    nodes++;
    n.children.forEach(walk);
  };
  walk(w.root as Flat);
  if (nodes < 2) throw new Error(`the tree has only ${nodes} node(s)`);

  const f = w.root;
  const off = Math.max(Math.abs(f.x - win.x), Math.abs(f.y - win.y), Math.abs(f.w - win.w), Math.abs(f.h - win.h));
  if (off > tol) throw new Error(`tree frame (${f.x},${f.y} ${f.w}x${f.h}) is ${off.toFixed(0)} px off the window (${win.x},${win.y} ${win.w}x${win.h})`);

  // A text area exists in both Notepad and TextEdit: one match, and its centre lies inside the window.
  const m = await a11yFind(desktop, { app, role: "textbox" });
  const inside = m.cx >= win.x && m.cx <= win.x + win.w && m.cy >= win.y && m.cy <= win.y + win.h;
  if (!inside) throw new Error(`text area centre (${m.cx},${m.cy}) is outside the window (${win.x},${win.y} ${win.w}x${win.h})`);
  return `${nodes} nodes, frame ${off.toFixed(0)} px off the window list, text area "${m.role}" centre (${m.cx},${m.cy})`;
}
