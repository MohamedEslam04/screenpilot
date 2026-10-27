import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dbus from "dbus-next";

// Run a one-shot KWin script that reports back one string over D-Bus. KWin
// scripts are the only way to read window geometry/focus on Wayland.

const IFACE = "dev.demoreel.Result";
const OBJ = "/dev/demoreel/Result";
let seq = 0;

/** `body` must end by calling `reply(<string>)`. */
export async function runKwinScript(body: string, timeoutMs = 3000): Promise<string> {
  const bus = dbus.sessionBus();
  const id = `${process.pid}_${++seq}`;
  const service = `dev.demoreel.Q${id}`;
  const name = `demoreel-q-${id}`;
  const path = join(tmpdir(), `${name}.js`);
  try {
    await bus.requestName(service, 0);
    const result = new Promise<string>((resolve, reject) => {
      class Result extends dbus.interface.Interface {
        done(s: string) {
          resolve(s);
        }
      }
      Result.configureMembers({ methods: { done: { inSignature: "s", outSignature: "" } } });
      bus.export(OBJ, new Result(IFACE));
      setTimeout(() => reject(new Error("KWin script did not answer")), timeoutMs);
    });
    await writeFile(
      path,
      `function reply(s) { callDBus(${JSON.stringify(service)}, ${JSON.stringify(OBJ)}, ${JSON.stringify(IFACE)}, "done", String(s)); }\n${body}\n`,
    );
    const call = (p: string, iface: string, member: string, signature: string, b: unknown[]) =>
      bus.call(new dbus.Message({ destination: "org.kde.KWin", path: p, interface: iface, member, signature, body: b }));
    const reply = await call("/Scripting", "org.kde.kwin.Scripting", "loadScript", "ss", [path, name]);
    await call(`/Scripting/Script${Number(reply?.body?.[0])}`, "org.kde.kwin.Script", "run", "", []);
    try {
      return await result;
    } finally {
      await call("/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", [name]).catch(() => {});
    }
  } finally {
    await unlink(path).catch(() => {});
    bus.disconnect();
  }
}

export interface WindowInfo {
  id: string;
  caption: string;
  resourceClass: string;
  pid: number;
  active: boolean;
  minimized: boolean;
  /** Client area (no decorations) in global logical pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  output: string;
}

const LIST = `
var out = workspace.windowList().filter(function (w) { return w.normalWindow; }).map(function (w) {
  var g = w.clientGeometry;
  return { id: String(w.internalId), caption: w.caption, resourceClass: String(w.resourceClass), pid: w.pid,
    active: w.active, minimized: w.minimized, x: g.x, y: g.y, w: g.width, h: g.height, output: w.output ? w.output.name : "" };
});
reply(JSON.stringify(out));
`;

export async function listWindows(): Promise<WindowInfo[]> {
  return JSON.parse(await runKwinScript(LIST)) as WindowInfo[];
}

/** First window whose caption or class contains `match` (case-insensitive). */
export function findWindow(windows: WindowInfo[], match: string): WindowInfo | undefined {
  const m = match.toLowerCase();
  return windows.find((w) => w.resourceClass.toLowerCase().includes(m)) ?? windows.find((w) => w.caption.toLowerCase().includes(m));
}

/** Raise + focus a window; optionally move/resize its frame onto a monitor rect. */
export async function focusWindow(id: string, place?: { x: number; y: number; w: number; h: number }): Promise<void> {
  const geo = place
    ? `w.frameGeometry = { x: ${Math.round(place.x)}, y: ${Math.round(place.y)}, width: ${Math.round(place.w)}, height: ${Math.round(place.h)} };`
    : "";
  await runKwinScript(`
var w = workspace.windowList().filter(function (x) { return String(x.internalId) === ${JSON.stringify(id)}; })[0];
if (w) { if (w.minimized) w.minimized = false; ${geo} workspace.activeWindow = w; }
reply(w ? "ok" : "missing");
`);
}
