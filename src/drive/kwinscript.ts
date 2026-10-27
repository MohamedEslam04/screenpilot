import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dbus from "dbus-next";
import { DBUS_NAME, DBUS_PATH, named } from "../brand.js";
import { findWindow, type Placement, type WindowInfo } from "../platform/types.js";

export { findWindow, type WindowInfo };

// Run a one-shot KWin script that reports back one string over D-Bus. KWin
// scripts are the only way to read window geometry/focus on Wayland.

const IFACE = `${DBUS_NAME}.Result`;
const OBJ = `${DBUS_PATH}/Result`;
let seq = 0;

/** `body` must end by calling `reply(<string>)`. */
export async function runKwinScript(body: string, timeoutMs = 3000): Promise<string> {
  const bus = dbus.sessionBus();
  const id = `${process.pid}_${++seq}`;
  const service = `${DBUS_NAME}.Q${id}`;
  const name = named(`q-${id}`);
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

/**
 * Raise + focus a window. `place` either gives an exact frame rect, or a
 * monitor whose usable area (without panels) the window should fill, inset by
 * `margin` (fraction of the shorter side) so it never sits under a panel.
 */
export async function focusWindow(
  id: string,
  place?: Placement,
): Promise<void> {
  let geo = "";
  if (place && "screen" in place) {
    // Default 16:9 so a window-framed camera shows it whole with nothing cropped.
    geo = `
var out = workspace.screens.filter(function (o) { return o.name === ${JSON.stringify(place.screen)}; })[0];
if (out) {
  var a = workspace.clientArea(KWin.MaximizeArea, out, workspace.currentDesktop);
  var m = Math.round(Math.min(a.width, a.height) * ${place.margin ?? 0.02});
  var bw = a.width - 2 * m, bh = a.height - 2 * m, r = ${place.aspect ?? 16 / 9};
  var ww = Math.min(bw, Math.round(bh * r)), hh = Math.min(bh, Math.round(ww / r));
  w.frameGeometry = { x: a.x + Math.round((a.width - ww) / 2), y: a.y + Math.round((a.height - hh) / 2), width: ww, height: hh };
}`;
  } else if (place) {
    geo = `w.frameGeometry = { x: ${Math.round(place.x)}, y: ${Math.round(place.y)}, width: ${Math.round(place.w)}, height: ${Math.round(place.h)} };`;
  }
  await runKwinScript(`
var w = workspace.windowList().filter(function (x) { return String(x.internalId) === ${JSON.stringify(id)}; })[0];
if (w) { if (w.minimized) w.minimized = false; ${geo} workspace.activeWindow = w; }
reply(w ? "ok" : "missing");
`);
}

/** Dismiss notification popups already on screen (Do Not Disturb only stops new ones). */
export async function closeNotificationPopups(): Promise<number> {
  const n = await runKwinScript(`
var n = 0;
workspace.windowList().forEach(function (w) { if (w.notification || w.criticalNotification) { w.closeWindow(); n++; } });
reply(n);
`);
  return Number(n);
}

/**
 * Resize a window to 16:9 inside its monitor's usable area so a
 * window-framed camera shows it whole; returns a function that puts the
 * window back where it was.
 */
export async function fitWindow(match: string, aspect = 16 / 9): Promise<{ window: WindowInfo; restore: () => Promise<void> }> {
  const win = findWindow(await listWindows(), match);
  if (!win) throw new Error(`No window matching "${match}" to fit`);
  const before = JSON.parse(
    await runKwinScript(`
var w = workspace.windowList().filter(function (x) { return String(x.internalId) === ${JSON.stringify(win.id)}; })[0];
var g = w.frameGeometry;
reply(JSON.stringify({ x: g.x, y: g.y, w: g.width, h: g.height, max: w.maximizeMode !== undefined ? w.maximizeMode : 0 }));
`),
  ) as { x: number; y: number; w: number; h: number; max: number };
  if (before.max) {
    // A maximized window ignores geometry changes; un-maximize first.
    await runKwinScript(`
var w = workspace.windowList().filter(function (x) { return String(x.internalId) === ${JSON.stringify(win.id)}; })[0];
if (w) w.setMaximize(false, false);
reply("ok");
`);
  }
  await focusWindow(win.id, { screen: win.output, aspect });
  return {
    window: win,
    restore: async () => {
      await runKwinScript(`
var w = workspace.windowList().filter(function (x) { return String(x.internalId) === ${JSON.stringify(win.id)}; })[0];
if (w) {
  w.frameGeometry = { x: ${before.x}, y: ${before.y}, width: ${before.w}, height: ${before.h} };
  // maximizeMode: 1 = vertical, 2 = horizontal, 3 = both
  if (${before.max}) w.setMaximize(${(before.max & 1) !== 0}, ${(before.max & 2) !== 0});
}
reply("ok");
`).catch(() => {});
    },
  };
}
