import { run } from "../util/exec.js";
import type { A11ySource, RawNode, RawWindow } from "./types.js";

// Windows accessibility tree through UI Automation. It is read by a short
// PowerShell script (Windows PowerShell 5.1 ships with Windows and has the
// UIAutomationClient assembly), so no COM calls through koffi are needed. The
// script prints a flat node list; rebuilding the tree and the role mapping are
// pure and tested off-platform. Windows coordinates are physical pixels, the
// same unit as the desktop's window list.

const ROLES: Record<string, string> = {
  Button: "push button",
  SplitButton: "push button",
  CheckBox: "check box",
  RadioButton: "radio button",
  Edit: "entry",
  Document: "text",
  ComboBox: "combo box",
  MenuBar: "menu bar",
  Menu: "menu",
  MenuItem: "menu item",
  TabItem: "page tab",
  Tab: "page tab list",
  Hyperlink: "link",
  Slider: "slider",
  Spinner: "spin button",
  Text: "label",
  Image: "image",
  Window: "frame",
  Pane: "filler",
  Group: "filler",
  Custom: "filler",
  List: "list",
  ListItem: "list item",
  DataItem: "list item",
  Tree: "tree",
  TreeItem: "tree item",
  ToolBar: "tool bar",
  ScrollBar: "scroll bar",
  Table: "table",
  TitleBar: "title bar",
  StatusBar: "status bar",
};

/** "ControlType.Button" as the AT-SPI role name the rest of the locator uses. */
export function uiaRoleName(controlType: string): string {
  const t = controlType.replace(/^ControlType\./, "");
  if (!t) return "";
  return ROLES[t] ?? t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

interface UiaNode {
  i: number;
  /** Parent index, -1 for a top-level window. */
  p: number;
  t: string;
  n: string;
  x: number;
  y: number;
  w: number;
  h: number;
  e: boolean;
  f: boolean;
  o: boolean;
  /** Top-level windows only: owning process id and name. */
  a?: number;
  pn?: string;
}

/** Rebuild window trees from the script's flat node list (parents come before children). */
export function parseUiaOutput(stdout: string): RawWindow[] {
  let data: { truncated?: boolean; nodes?: UiaNode[] };
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`UI Automation script printed something unexpected: ${stdout.trim().slice(0, 120)}`);
  }
  const nodes = data.nodes ?? [];
  const built = new Map<number, RawNode>();
  const windows: RawWindow[] = [];
  for (const n of nodes) {
    const states: string[] = [];
    if (!n.o) states.push("showing");
    if (n.e && !n.o) states.push("enabled");
    if (n.f) states.push("focused");
    const node: RawNode = { role: uiaRoleName(n.t), name: n.n ?? "", rect: { x: n.x, y: n.y, w: n.w, h: n.h }, states, children: [] };
    built.set(n.i, node);
    if (n.p < 0) {
      windows.push({ app: n.pn ?? String(n.a ?? ""), pid: n.a ?? 0, title: node.name, rect: node.rect, root: node, truncated: !!data.truncated });
    } else {
      built.get(n.p)?.children.push(node);
    }
  }
  return windows;
}

/** The PowerShell program that dumps the UIA tree of these processes' top-level windows. */
export function buildUiaScript(pids: number[], maxDepth: number, maxNodes: number): string {
  if (!pids.every((p) => Number.isInteger(p) && p > 0)) throw new Error("pid must be a positive integer");
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$procIds = @(${pids.join(",")})
$maxDepth = ${Math.floor(maxDepth)}
$maxNodes = ${Math.floor(maxNodes)}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$nodes = New-Object System.Collections.ArrayList
$state = @{ count = 0; truncated = $false }
function Add-Node($el, $parent, $depth, $procId) {
  if ($state.count -ge $maxNodes) { $state.truncated = $true; return }
  $c = $el.Current
  $r = $c.BoundingRectangle
  $empty = $r.IsEmpty -or [double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Width)
  $idx = $state.count
  $state.count = $state.count + 1
  $n = [ordered]@{
    i = $idx; p = $parent; t = $c.ControlType.ProgrammaticName; n = [string]$c.Name
    x = $(if ($empty) { 0 } else { [math]::Round($r.X) }); y = $(if ($empty) { 0 } else { [math]::Round($r.Y) })
    w = $(if ($empty) { 0 } else { [math]::Round($r.Width) }); h = $(if ($empty) { 0 } else { [math]::Round($r.Height) })
    e = [bool]$c.IsEnabled; f = [bool]$c.HasKeyboardFocus; o = ($empty -or [bool]$c.IsOffscreen)
  }
  if ($parent -lt 0) { $n.a = $procId; $n.pn = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName }
  [void]$nodes.Add($n)
  if ($depth -ge $maxDepth) { if ($walker.GetFirstChild($el)) { $state.truncated = $true }; return }
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null) {
    Add-Node $child $idx ($depth + 1) $procId
    $child = $walker.GetNextSibling($child)
  }
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
foreach ($procId in $procIds) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$procId)
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) { Add-Node $w -1 0 $procId }
}
@{ truncated = $state.truncated; nodes = $nodes } | ConvertTo-Json -Depth 6 -Compress
`;
}

const POWERSHELL = "powershell.exe";
const psArgs = (script: string) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];

export const uiaSource: A11ySource = {
  id: "windows-uia",

  async status() {
    try {
      await run(POWERSHELL, psArgs("Add-Type -AssemblyName UIAutomationClient; 'ok'"), { timeoutMs: 20000 });
      return { ok: true, detail: "UI Automation through Windows PowerShell (elevated apps cannot be read from a non-elevated process)" };
    } catch (e) {
      return { ok: false, detail: `cannot run Windows PowerShell with UIAutomationClient: ${(e as Error).message}` };
    }
  },

  async windows(o) {
    // UIA is asked per process: an app filter needs the pids of its windows.
    const pids = o.pids ?? [];
    if (!pids.length) return { windows: [], warnings: ["Windows reads an app's tree by process: pass app (or focus the app) so its windows can be found"] };
    const { stdout } = await run(POWERSHELL, psArgs(buildUiaScript(pids, o.maxDepth, o.maxNodes)), { timeoutMs: 60000 });
    return { windows: parseUiaOutput(stdout), warnings: [] };
  },
};
