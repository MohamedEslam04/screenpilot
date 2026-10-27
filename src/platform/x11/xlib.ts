import type { Rect } from "../../record/input/types.js";
import type { Keymap } from "./keymap.js";

// libX11 / libXrandr / libXtst through koffi, loaded on first use (by soname,
// so no -dev packages are needed). One display connection per process: Xlib
// is not thread safe, but all calls come from the JS thread. Assumes LP64
// (x86_64 / aarch64): long and XIDs are 64-bit.

type Koffi = typeof import("koffi").default;
type Fn = (...args: unknown[]) => any;

export interface XMonitor extends Rect {
  name: string;
  primary: boolean;
}

/** What the X11 desktop, injector and watcher use (a fake implements it in tests). */
export interface XApi {
  readonly root: number;
  atom(name: string): number;
  atomName(atom: number): string;
  /** Format-32 property as numbers (CARDINAL, WINDOW, ATOM); undefined when unset. */
  cardinals(win: number, prop: string): number[] | undefined;
  /** Format-8 property bytes; undefined when unset. */
  bytes(win: number, prop: string): { type: number; data: Uint8Array } | undefined;
  monitors(): XMonitor[];
  rootSize(): { w: number; h: number };
  pointer(): { x: number; y: number } | undefined;
  /** The window's client area in root coordinates; undefined when it is gone. */
  clientRect(win: number): Rect | undefined;
  /** A 32-bit ClientMessage to the root window (how EWMH requests go to the window manager). */
  clientMessage(win: number, type: string, data: number[]): void;
  moveResize(win: number, x: number, y: number, w: number, h: number): void;
  raiseAndFocus(win: number): void;
  hasXTest(): boolean;
  fakeMotion(x: number, y: number): void;
  fakeButton(button: number, down: boolean): void;
  fakeKey(code: number, down: boolean): void;
  keymap(): Keymap;
  setKeysyms(code: number, syms: number[]): void;
  /** Active XKB group (keyboard layout index), 0 when XKB is not there. */
  group(): number;
  flush(): void;
  sync(): void;
}

let loaded: Promise<XApi> | undefined;

/** The X11 connection (opened on first use, on $DISPLAY). */
export function x11(): Promise<XApi> {
  return (loaded ??= import("koffi").then((m) => bind(m.default)));
}

const PROTOTYPES = {
  "libX11.so.6": {
    XOpenDisplay: "XDisplay *XOpenDisplay(const char *name)",
    XDefaultRootWindow: "unsigned long XDefaultRootWindow(XDisplay *d)",
    XDefaultScreen: "int XDefaultScreen(XDisplay *d)",
    XDisplayWidth: "int XDisplayWidth(XDisplay *d, int screen)",
    XDisplayHeight: "int XDisplayHeight(XDisplay *d, int screen)",
    XInternAtom: "unsigned long XInternAtom(XDisplay *d, const char *name, int onlyIfExists)",
    XGetAtomName: "void *XGetAtomName(XDisplay *d, unsigned long atom)",
    XGetWindowProperty:
      "int XGetWindowProperty(XDisplay *d, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)",
    XFree: "int XFree(void *data)",
    XQueryPointer:
      "int XQueryPointer(XDisplay *d, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)",
    XGetGeometry:
      "int XGetGeometry(XDisplay *d, unsigned long drawable, _Out_ unsigned long *root, _Out_ int *x, _Out_ int *y, _Out_ unsigned int *w, _Out_ unsigned int *h, _Out_ unsigned int *border, _Out_ unsigned int *depth)",
    XTranslateCoordinates:
      "int XTranslateCoordinates(XDisplay *d, unsigned long src, unsigned long dst, int srcX, int srcY, _Out_ int *dstX, _Out_ int *dstY, _Out_ unsigned long *child)",
    XSendEvent: "int XSendEvent(XDisplay *d, unsigned long w, int propagate, long mask, void *event)",
    XMoveResizeWindow: "int XMoveResizeWindow(XDisplay *d, unsigned long w, int x, int y, unsigned int width, unsigned int height)",
    XMapRaised: "int XMapRaised(XDisplay *d, unsigned long w)",
    XSetInputFocus: "int XSetInputFocus(XDisplay *d, unsigned long w, int revertTo, unsigned long time)",
    XDisplayKeycodes: "int XDisplayKeycodes(XDisplay *d, _Out_ int *min, _Out_ int *max)",
    XGetKeyboardMapping: "void *XGetKeyboardMapping(XDisplay *d, uint8_t first, int count, _Out_ int *perKeycode)",
    XChangeKeyboardMapping: "int XChangeKeyboardMapping(XDisplay *d, int first, int perKeycode, unsigned long *keysyms, int count)",
    XkbGetState: "int XkbGetState(XDisplay *d, unsigned int deviceSpec, void *state)",
    XSetErrorHandler: "void *XSetErrorHandler(XErrorHandler *handler)",
    XFlush: "int XFlush(XDisplay *d)",
    XSync: "int XSync(XDisplay *d, int discard)",
  },
  "libXrandr.so.2": {
    XRRGetMonitors: "void *XRRGetMonitors(XDisplay *d, unsigned long w, int getActive, _Out_ int *count)",
    XRRFreeMonitors: "void XRRFreeMonitors(void *monitors)",
  },
  "libXtst.so.6": {
    XTestQueryExtension: "int XTestQueryExtension(XDisplay *d, _Out_ int *event, _Out_ int *error, _Out_ int *major, _Out_ int *minor)",
    XTestFakeMotionEvent: "int XTestFakeMotionEvent(XDisplay *d, int screen, int x, int y, unsigned long delay)",
    XTestFakeButtonEvent: "int XTestFakeButtonEvent(XDisplay *d, unsigned int button, int press, unsigned long delay)",
    XTestFakeKeyEvent: "int XTestFakeKeyEvent(XDisplay *d, unsigned int keycode, int press, unsigned long delay)",
  },
} as const;

const ANY_PROPERTY_TYPE = 0;
const CLIENT_MESSAGE = 33;
const SUBSTRUCTURE_NOTIFY = 1 << 19;
const SUBSTRUCTURE_REDIRECT = 1 << 20;
const XEVENT_SIZE = 192; // sizeof(XEvent) on LP64
const REVERT_TO_PARENT = 2;
const XKB_USE_CORE_KBD = 0x100;

/** XClientMessageEvent (format 32) in an XEvent-sized buffer, LP64 layout. */
export function clientMessageEvent(win: number, type: number, data: number[]): Buffer {
  const ev = Buffer.alloc(XEVENT_SIZE);
  ev.writeInt32LE(CLIENT_MESSAGE, 0); // type
  ev.writeInt32LE(1, 16); // send_event
  ev.writeBigUInt64LE(BigInt(win), 32); // window
  ev.writeBigUInt64LE(BigInt(type), 40); // message_type
  ev.writeInt32LE(32, 48); // format
  for (let i = 0; i < 5; i++) ev.writeBigInt64LE(BigInt(Math.trunc(data[i] ?? 0)), 56 + i * 8); // data.l[i]
  return ev;
}

function bind(koffi: Koffi): XApi {
  if (koffi.sizeof("long") !== 8) throw new Error("X11 support needs a 64-bit system");
  koffi.opaque("XDisplay");
  const handlerType = koffi.pointer(koffi.proto("int XErrorHandler(XDisplay *d, void *event)"));
  const monitorInfo = koffi.struct("XRRMonitorInfo", {
    name: "unsigned long",
    primary: "int",
    automatic: "int",
    noutput: "int",
    x: "int",
    y: "int",
    width: "int",
    height: "int",
    mwidth: "int",
    mheight: "int",
    outputs: "void *",
  });

  const fn = {} as Record<string, Fn>;
  for (const [lib, protos] of Object.entries(PROTOTYPES)) {
    let handle: ReturnType<Koffi["load"]>;
    try {
      handle = koffi.load(lib);
    } catch {
      throw new Error(`${lib} is missing (install the X11 client libraries: libx11, libxrandr, libxtst).`);
    }
    for (const [name, proto] of Object.entries(protos)) fn[name] = handle.func(proto) as Fn;
  }

  const d = fn.XOpenDisplay!(null);
  if (!d) throw new Error(`Cannot open the X display ${process.env.DISPLAY ?? "(DISPLAY is not set)"}`);

  // Xlib's default error handler exits the process (e.g. BadWindow when a
  // window closes between two calls). Ignore errors; calls report failure.
  const onError = koffi.register(() => 0, handlerType);
  fn.XSetErrorHandler!(onError);

  const root = Number(fn.XDefaultRootWindow!(d));
  const screen = fn.XDefaultScreen!(d) as number;
  const atoms = new Map<string, number>();
  let xtest: boolean | undefined;

  const atom = (name: string): number => {
    let a = atoms.get(name);
    if (a === undefined) {
      a = Number(fn.XInternAtom!(d, name, 0));
      atoms.set(name, a);
    }
    return a;
  };

  const atomName = (a: number): string => {
    const p = fn.XGetAtomName!(d, a);
    if (!p) return "";
    try {
      return koffi.decode(p, "char", -1) as string;
    } finally {
      fn.XFree!(p);
    }
  };

  /** Raw property read; the caller decodes by format. */
  const property = (win: number, prop: string): { type: number; format: number; n: number; ptr: unknown } | undefined => {
    const type = [0];
    const format = [0];
    const n = [0];
    const after = [0];
    const data: unknown[] = [null];
    const status = fn.XGetWindowProperty!(d, win, atom(prop), 0, 1 << 20, 0, ANY_PROPERTY_TYPE, type, format, n, after, data);
    if (status !== 0 || !data[0]) return undefined;
    if (!Number(type[0])) {
      fn.XFree!(data[0]);
      return undefined; // property not set
    }
    return { type: Number(type[0]), format: Number(format[0]), n: Number(n[0]), ptr: data[0] };
  };

  return {
    root,
    atom,

    atomName,

    cardinals(win, prop) {
      const p = property(win, prop);
      if (!p) return undefined;
      try {
        if (p.format !== 32 || p.n === 0) return p.format === 32 ? [] : undefined;
        // Format-32 data comes back as C longs (64-bit here).
        return Array.from(koffi.decode(p.ptr, "long", p.n) as ArrayLike<number | bigint>, Number);
      } finally {
        fn.XFree!(p.ptr);
      }
    },

    bytes(win, prop) {
      const p = property(win, prop);
      if (!p) return undefined;
      try {
        if (p.format !== 8) return undefined;
        const data = p.n ? Uint8Array.from(koffi.decode(p.ptr, "uint8_t", p.n) as ArrayLike<number>) : new Uint8Array();
        return { type: p.type, data };
      } finally {
        fn.XFree!(p.ptr);
      }
    },

    monitors() {
      const count = [0];
      const ptr = fn.XRRGetMonitors!(d, root, 1, count);
      if (!ptr) return [];
      try {
        const raw = (count[0]! > 0 ? koffi.decode(ptr, monitorInfo, count[0]!) : []) as {
          name: number;
          primary: number;
          x: number;
          y: number;
          width: number;
          height: number;
        }[];
        return raw.map((m) => ({ name: atomName(Number(m.name)), primary: !!m.primary, x: m.x, y: m.y, w: m.width, h: m.height }));
      } finally {
        fn.XRRFreeMonitors!(ptr);
      }
    },

    rootSize() {
      return { w: fn.XDisplayWidth!(d, screen) as number, h: fn.XDisplayHeight!(d, screen) as number };
    },

    pointer() {
      const r = [0];
      const c = [0];
      const x = [0];
      const y = [0];
      const wx = [0];
      const wy = [0];
      const mask = [0];
      return fn.XQueryPointer!(d, root, r, c, x, y, wx, wy, mask) ? { x: x[0]!, y: y[0]! } : undefined;
    },

    clientRect(win) {
      const r = [0];
      const gx = [0];
      const gy = [0];
      const w = [0];
      const h = [0];
      const border = [0];
      const depth = [0];
      if (!fn.XGetGeometry!(d, win, r, gx, gy, w, h, border, depth)) return undefined;
      const x = [0];
      const y = [0];
      const child = [0];
      if (!fn.XTranslateCoordinates!(d, win, root, 0, 0, x, y, child)) return undefined;
      return { x: x[0]!, y: y[0]!, w: w[0]!, h: h[0]! };
    },

    clientMessage(win, type, data) {
      fn.XSendEvent!(d, root, 0, SUBSTRUCTURE_REDIRECT | SUBSTRUCTURE_NOTIFY, clientMessageEvent(win, atom(type), data));
      fn.XFlush!(d);
    },

    moveResize(win, x, y, w, h) {
      fn.XMoveResizeWindow!(d, win, Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
      fn.XFlush!(d);
    },

    raiseAndFocus(win) {
      fn.XMapRaised!(d, win);
      fn.XSetInputFocus!(d, win, REVERT_TO_PARENT, 0);
      fn.XFlush!(d);
    },

    hasXTest() {
      if (xtest === undefined) xtest = !!fn.XTestQueryExtension!(d, [0], [0], [0], [0]);
      return xtest;
    },

    fakeMotion(x, y) {
      fn.XTestFakeMotionEvent!(d, -1, Math.round(x), Math.round(y), 0);
      fn.XFlush!(d);
    },

    fakeButton(button, down) {
      fn.XTestFakeButtonEvent!(d, button, down ? 1 : 0, 0);
      fn.XFlush!(d);
    },

    fakeKey(code, down) {
      fn.XTestFakeKeyEvent!(d, code, down ? 1 : 0, 0);
      fn.XFlush!(d);
    },

    keymap() {
      const min = [0];
      const max = [0];
      fn.XDisplayKeycodes!(d, min, max);
      const count = max[0]! - min[0]! + 1;
      const per = [0];
      const ptr = fn.XGetKeyboardMapping!(d, min[0]!, count, per);
      if (!ptr) return { min: min[0]!, per: 1, syms: [] };
      try {
        return { min: min[0]!, per: per[0]!, syms: Array.from(koffi.decode(ptr, "unsigned long", count * per[0]!) as ArrayLike<number | bigint>, Number) };
      } finally {
        fn.XFree!(ptr);
      }
    },

    setKeysyms(code, syms) {
      fn.XChangeKeyboardMapping!(d, code, syms.length, syms, 1);
      fn.XSync!(d, 0);
    },

    group() {
      const state = Buffer.alloc(32); // XkbStateRec; `group` is its first byte
      return fn.XkbGetState!(d, XKB_USE_CORE_KBD, state) === 0 ? state[0]! : 0;
    },

    flush() {
      fn.XFlush!(d);
    },

    sync() {
      fn.XSync!(d, 0);
    },
  };
}
