import type { A11ySource, RawNode, RawWindow, Rect } from "./types.js";

// macOS accessibility tree through the AX API (bindings in platform/macos/quartz.ts).
// The walk and the role mapping are pure over `AxElement`, so they are tested
// off-platform with a fake; only the koffi adapter needs a Mac.

/** One AX element, as much of it as the tree needs. Release it when done. */
export interface AxElement {
  str(attr: string): string | undefined;
  bool(attr: string): boolean | undefined;
  frame(): Rect | undefined;
  children(): AxElement[];
  release(): void;
}

const ROLES: Record<string, string> = {
  AXApplication: "application",
  AXWindow: "frame",
  AXSheet: "dialog",
  AXDialog: "dialog",
  AXButton: "push button",
  AXCheckBox: "check box",
  AXRadioButton: "radio button",
  AXTextField: "entry",
  AXSearchField: "entry",
  AXSecureTextField: "password text",
  AXTextArea: "text",
  AXComboBox: "combo box",
  AXPopUpButton: "combo box",
  AXMenuButton: "push button",
  AXMenuBar: "menu bar",
  AXMenuBarItem: "menu",
  AXMenu: "menu",
  AXMenuItem: "menu item",
  AXLink: "link",
  AXSlider: "slider",
  AXIncrementor: "spin button",
  AXStaticText: "label",
  AXImage: "image",
  AXToolbar: "tool bar",
  AXGroup: "filler",
  AXScrollArea: "scroll pane",
  AXList: "list",
  AXTable: "table",
  AXOutline: "tree",
  AXRow: "list item",
  AXTabGroup: "page tab list",
  AXSplitGroup: "split pane",
};

/** AX role (and subrole) as the AT-SPI role name the rest of the locator uses. */
export function axRoleName(role: string, subrole?: string): string {
  if (subrole === "AXTabButton") return "page tab";
  if (subrole === "AXToggle" || subrole === "AXSwitch") return "toggle button";
  return ROLES[role] ?? (role.startsWith("AX") ? role.slice(2).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : role.toLowerCase());
}

interface Budget {
  count: number;
  max: number;
  truncated: boolean;
}

/** Walk an element and its children into a raw node. Children are released; the element itself is the caller's. */
export function readAxNode(el: AxElement, depth: number, maxDepth: number, budget: Budget): RawNode {
  budget.count++;
  const axRole = el.str("AXRole") ?? "";
  const name = el.str("AXTitle") || el.str("AXDescription") || (axRole === "AXStaticText" ? (el.str("AXValue") ?? "") : "") || "";
  const states = ["showing"];
  if (el.bool("AXEnabled") !== false) states.push("enabled");
  if (el.bool("AXFocused")) states.push("focused");
  if (el.bool("AXSelected")) states.push("selected");
  const node: RawNode = { role: axRoleName(axRole, el.str("AXSubrole")), name, rect: el.frame() ?? null, states, children: [] };
  if (depth >= maxDepth || budget.count >= budget.max) {
    budget.truncated = true;
    return node;
  }
  const kids = el.children();
  try {
    for (const k of kids) {
      if (budget.count >= budget.max) {
        budget.truncated = true;
        break;
      }
      node.children.push(readAxNode(k, depth + 1, maxDepth, budget));
    }
  } finally {
    for (const k of kids) k.release();
  }
  return node;
}

export const axSource: A11ySource = {
  id: "macos-ax",

  async status() {
    const q = await (await import("../platform/macos/quartz.js")).quartz();
    return q.axTrusted()
      ? { ok: true, detail: "Accessibility API (the AI app has the Accessibility permission)" }
      : { ok: false, detail: "the AI app needs the Accessibility permission (System Settings > Privacy & Security > Accessibility)" };
  },

  async windows(o) {
    const q = await (await import("../platform/macos/quartz.js")).quartz();
    if (!q.axTrusted()) throw new Error("the AI app needs the Accessibility permission (System Settings > Privacy & Security > Accessibility)");
    const windows: RawWindow[] = [];
    const warnings: string[] = [];
    // AX has no registry of apps: it is asked per pid, so an app filter needs the pids of its windows.
    for (const pid of o.pids ?? []) {
      const app = q.axAppTitle(pid) ?? o.app ?? String(pid);
      for (const win of q.axTreeWindows(pid)) {
        try {
          const budget = { count: 0, max: o.maxNodes, truncated: false };
          const root = readAxNode(win, 0, o.maxDepth, budget);
          windows.push({ app, pid, title: root.name, rect: root.rect, root, truncated: budget.truncated });
        } catch (e) {
          warnings.push(`${app}: ${(e as Error).message}`);
        } finally {
          win.release();
        }
      }
    }
    if (!o.pids?.length) warnings.push("macOS reads an app's tree by pid: pass app (or focus the app) so its windows can be found");
    return { windows, warnings };
  },
};
