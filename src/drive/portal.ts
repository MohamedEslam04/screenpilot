import dbus from "dbus-next";

// xdg-desktop-portal RemoteDesktop session: the official Wayland way to inject
// pointer and keyboard input. Paired with a ScreenCast source selection so we
// get per-monitor streams, which absolute pointer motion is expressed in.

const DEST = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const RD = "org.freedesktop.portal.RemoteDesktop";
const SC = "org.freedesktop.portal.ScreenCast";

const KEYBOARD = 1;
const POINTER = 2;
const MONITOR = 1;
const PERSIST_UNTIL_REVOKED = 2;

const { Variant } = dbus;

export interface PortalStream {
  node: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class PortalCancelled extends Error {}

export class RemoteDesktopSession {
  private bus = dbus.sessionBus();
  private session = "";
  private tokenSeq = 0;
  streams: PortalStream[] = [];
  restoreToken?: string;

  /** Opens the session; KDE asks the user once unless `restoreToken` is still valid. */
  async open(restoreToken?: string): Promise<void> {
    // Our unique bus name (needed to predict request paths) is known only after Hello.
    await this.bus.call(
      new dbus.Message({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "GetId" }),
    );
    const created = await this.request(RD, "CreateSession", "a{sv}", [
      { session_handle_token: new Variant("s", this.token("s")) },
    ]);
    this.session = String(created.session_handle);

    const devOpts: Record<string, dbus.Variant> = {
      types: new Variant("u", KEYBOARD | POINTER),
      persist_mode: new Variant("u", PERSIST_UNTIL_REVOKED),
    };
    if (restoreToken) devOpts.restore_token = new Variant("s", restoreToken);
    await this.request(RD, "SelectDevices", "oa{sv}", [this.session, devOpts]);

    await this.request(SC, "SelectSources", "oa{sv}", [
      this.session,
      { types: new Variant("u", MONITOR), multiple: new Variant("b", true), cursor_mode: new Variant("u", 2) },
    ]);

    const started = await this.request(RD, "Start", "osa{sv}", [this.session, "", {}]);
    this.restoreToken = started.restore_token ? String(started.restore_token) : undefined;
    this.streams = parseStreams(started.streams);
    if (this.streams.length === 0) throw new Error("Remote control was granted without any screen; pick the monitors to control.");
  }

  async motionAbsolute(stream: number, x: number, y: number): Promise<void> {
    await this.notify("NotifyPointerMotionAbsolute", "oa{sv}udd", [this.session, {}, stream, x, y]);
  }

  /** evdev button code (BTN_LEFT=272), pressed true/false. */
  async button(code: number, pressed: boolean): Promise<void> {
    await this.notify("NotifyPointerButton", "oa{sv}iu", [this.session, {}, code, pressed ? 1 : 0]);
  }

  /** axis 0 = vertical, 1 = horizontal; steps are wheel clicks (positive = down/right). */
  async axisDiscrete(axis: 0 | 1, steps: number): Promise<void> {
    await this.notify("NotifyPointerAxisDiscrete", "oa{sv}ui", [this.session, {}, axis, steps]);
  }

  async keysym(sym: number, pressed: boolean): Promise<void> {
    await this.notify("NotifyKeyboardKeysym", "oa{sv}iu", [this.session, {}, sym, pressed ? 1 : 0]);
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.bus
        .call(new dbus.Message({ destination: DEST, path: this.session, interface: "org.freedesktop.portal.Session", member: "Close" }))
        .catch(() => {});
    }
    this.bus.disconnect();
  }

  private token(prefix: string): string {
    return `demoreel_${prefix}${process.pid}_${++this.tokenSeq}`;
  }

  private async notify(member: string, signature: string, body: unknown[]): Promise<void> {
    await this.bus.call(new dbus.Message({ destination: DEST, path: PATH, interface: RD, member, signature, body }));
  }

  /**
   * Portal calls return a Request object; the real answer arrives later as a
   * Response signal on a path we can predict from our handle_token, so we
   * subscribe before calling to never miss it.
   */
  private async request(iface: string, member: string, signature: string, body: unknown[]): Promise<Record<string, unknown>> {
    const handleToken = this.token("r");
    const opts = body.at(-1) as Record<string, dbus.Variant>;
    opts.handle_token = new Variant("s", handleToken);
    const sender = ((this.bus as unknown as { name?: string }).name ?? "").replace(/^:/, "").replace(/\./g, "_");
    const reqPath = `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`;
    const rule = `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${reqPath}'`;
    await this.bus.call(
      new dbus.Message({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [rule],
      }),
    );

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (msg: dbus.Message) => {
        if (msg.path !== reqPath || msg.member !== "Response") return;
        this.bus.removeListener("message", onMessage);
        const [code, results] = msg.body as [number, Record<string, dbus.Variant>];
        const plain = Object.fromEntries(Object.entries(results ?? {}).map(([k, v]) => [k, v.value]));
        if (code === 0) resolve(plain);
        else reject(new PortalCancelled(code === 1 ? `${member}: cancelled by the user` : `${member}: failed (${code})`));
      };
      this.bus.on("message", onMessage);
    });

    await this.bus.call(new dbus.Message({ destination: DEST, path: PATH, interface: iface, member, signature, body }));
    return response;
  }
}

/** Start's `streams` is a(ua{sv}); position/size are (ii) in logical desktop pixels. */
export function parseStreams(raw: unknown): PortalStream[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const [node, props] = entry as [number, Record<string, dbus.Variant | unknown>];
    const val = (k: string) => {
      const v = props?.[k];
      return v instanceof Variant ? v.value : v;
    };
    const pos = (val("position") as number[] | undefined) ?? [0, 0];
    const size = (val("size") as number[] | undefined) ?? [0, 0];
    return { node: Number(node), x: Number(pos[0]), y: Number(pos[1]), w: Number(size[0]), h: Number(size[1]) };
  });
}
