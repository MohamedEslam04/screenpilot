import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import dbus from "dbus-next";
import { EvdevButtons } from "./evdev.js";
import type { InputAdapter, RawEvent, ScreenInfo } from "./types.js";
import { DBUS_NAME, DBUS_PATH, named } from "../../brand.js";

// KDE Plasma (Wayland or X11): a tiny KWin script pushes the pointer position
// and monitor layout to us over D-Bus; buttons come from evdev.

const IFACE = `${DBUS_NAME}.Pointer`;
const OBJ = `${DBUS_PATH}/Pointer`;

export function kwinScript(service: string): string {
  return `
var svc = ${JSON.stringify(service)};
function send() {
  var p = workspace.cursorPos;
  callDBus(svc, ${JSON.stringify(OBJ)}, ${JSON.stringify(IFACE)}, "cursor", p.x, p.y);
}
var s = JSON.stringify(workspace.screens.map(function (o) {
  var g = o.geometry;
  return { name: o.name, x: g.x, y: g.y, w: g.width, h: g.height, manufacturer: o.manufacturer || "", model: o.model || "" };
}));
callDBus(svc, ${JSON.stringify(OBJ)}, ${JSON.stringify(IFACE)}, "screens", s);
send();
workspace.cursorPosChanged.connect(send);

// Which window is being used, and where it is: the camera can frame it.
function sendFocus() {
  var w = workspace.activeWindow;
  if (!w) return;
  var g = w.frameGeometry; // with its title bar: that is how the window looks
  // Only the part not covered by panels: framing it must not show the panel.
  var a = workspace.clientArea(KWin.MaximizeArea, w);
  var x0 = Math.max(g.x, a.x), y0 = Math.max(g.y, a.y);
  var x1 = Math.min(g.x + g.width, a.x + a.width), y1 = Math.min(g.y + g.height, a.y + a.height);
  if (x1 <= x0 || y1 <= y0) return;
  callDBus(svc, ${JSON.stringify(OBJ)}, ${JSON.stringify(IFACE)}, "focus", JSON.stringify({
    id: String(w.internalId), cls: String(w.resourceClass), title: w.caption, x: x0, y: y0, w: x1 - x0, h: y1 - y0
  }));
}
var tracked = null;
function track(w) {
  if (tracked) tracked.frameGeometryChanged.disconnect(sendFocus);
  tracked = w;
  if (w) w.frameGeometryChanged.connect(sendFocus);
  sendFocus();
}
workspace.windowActivated.connect(track);
track(workspace.activeWindow);
`;
}

export function parseScreens(s: string): ScreenInfo[] {
  return (JSON.parse(s) as ScreenInfo[]).map((o) => ({
    name: String(o.name),
    x: Number(o.x),
    y: Number(o.y),
    w: Number(o.w),
    h: Number(o.h),
    ...(o.manufacturer ? { manufacturer: String(o.manufacturer) } : {}),
    ...(o.model ? { model: String(o.model) } : {}),
  }));
}

export function isKde(): boolean {
  return /kde/i.test(process.env.XDG_CURRENT_DESKTOP ?? "") || process.env.KDE_FULL_SESSION === "true";
}

let instances = 0;

export interface FocusEvent {
  at: number; // performance.now()
  id: string;
  cls: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class KwinAdapter implements InputAdapter {
  readonly id = "kwin";
  readonly events: RawEvent[] = [];
  readonly warnings: string[] = [];
  /** Active window over time (global logical px), for window-framed views. */
  readonly focus: FocusEvent[] = [];
  private bus?: dbus.MessageBus;
  // Unique per instance: the driver and the recorder each run one in the same process.
  private readonly tag = `${process.pid}_${++instances}`;
  private scriptName = named(this.tag);
  private scriptPath = join(tmpdir(), `${named(this.tag)}.js`);
  private screenList: ScreenInfo[] = [];
  private pos?: { x: number; y: number };
  private buttons = new EvdevButtons((e) => {
    if (!this.pos) return;
    this.events.push({ at: performance.now(), type: e.down ? "down" : "up", px: this.pos.x, py: this.pos.y, button: e.button });
  });

  screens(): ScreenInfo[] {
    return this.screenList;
  }

  cursor(): { x: number; y: number } | undefined {
    return this.pos;
  }

  async start(): Promise<void> {
    const bus = dbus.sessionBus();
    this.bus = bus;
    const service = `${DBUS_NAME}.Rec${this.tag}`;
    await bus.requestName(service, 0);

    const adapter = this;
    class Pointer extends dbus.interface.Interface {
      cursor(x: number, y: number) {
        adapter.pos = { x, y };
        adapter.events.push({ at: performance.now(), type: "move", px: x, py: y });
      }
      screens(s: string) {
        adapter.screenList = parseScreens(s);
      }
      focus(s: string) {
        adapter.focus.push({ at: performance.now(), ...(JSON.parse(s) as Omit<FocusEvent, "at">) });
      }
    }
    Pointer.configureMembers({
      methods: {
        cursor: { inSignature: "ii", outSignature: "" },
        screens: { inSignature: "s", outSignature: "" },
        focus: { inSignature: "s", outSignature: "" },
      },
    });
    bus.export(OBJ, new Pointer(IFACE));

    await writeFile(this.scriptPath, kwinScript(service));
    await this.unloadScript();
    // loadScript is overloaded (s / ss), so build the call by hand.
    const reply = await this.kwinCall("/Scripting", "org.kde.kwin.Scripting", "loadScript", "ss", [this.scriptPath, this.scriptName]);
    const id = Number(reply?.body?.[0]);
    if (!(id >= 0)) throw new Error("KWin refused to load the pointer script");
    await this.kwinCall(`/Scripting/Script${id}`, "org.kde.kwin.Script", "run", "", []);

    // Wait briefly for the first report so screens() is populated.
    const deadline = Date.now() + 2000;
    while ((!this.pos || this.screenList.length === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.pos) this.warnings.push("KWin script loaded but reported no pointer position");

    await this.buttons.start();
    this.warnings.push(...this.buttons.warnings);
  }

  async stop(): Promise<void> {
    this.buttons.stop();
    await this.unloadScript();
    await unlink(this.scriptPath).catch(() => {});
    this.bus?.disconnect();
  }

  private async unloadScript(): Promise<void> {
    await this.kwinCall("/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", [this.scriptName]).catch(() => {});
  }

  private kwinCall(path: string, iface: string, member: string, signature: string, body: unknown[]) {
    if (!this.bus) throw new Error("not connected");
    return this.bus.call(new dbus.Message({ destination: "org.kde.KWin", path, interface: iface, member, signature, body }));
  }
}
