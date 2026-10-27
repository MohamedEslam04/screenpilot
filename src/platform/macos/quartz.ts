import type { Rect } from "../../record/input/types.js";
import type { MacEvent } from "./events.js";
import type { CgDisplay, CgWindow } from "./geometry.js";

// Quartz, CoreFoundation and the Accessibility (AX) API through koffi,
// loaded from the system frameworks on first use so other OSes never load
// koffi. Every coordinate is in global points (see geometry.ts).

type Koffi = typeof import("koffi").default;
type Fn = (...args: unknown[]) => any;
/** CF / AX object (koffi 3 pointers are BigInts; NULL is null). */
type Ptr = bigint | null;

const framework = (name: string) => `/System/Library/Frameworks/${name}.framework/${name}`;

/** Every function we call, per framework, as koffi prototype strings. */
export const PROTOTYPES = {
  CoreFoundation: {
    CFRelease: "void CFRelease(void *cf)",
    CFRetain: "void *CFRetain(void *cf)",
    CFGetTypeID: "unsigned long CFGetTypeID(void *cf)",
    CFStringGetTypeID: "unsigned long CFStringGetTypeID()",
    CFNumberGetTypeID: "unsigned long CFNumberGetTypeID()",
    CFBooleanGetTypeID: "unsigned long CFBooleanGetTypeID()",
    CFArrayGetCount: "long CFArrayGetCount(void *array)",
    CFArrayGetValueAtIndex: "void *CFArrayGetValueAtIndex(void *array, long idx)",
    CFDictionaryGetValue: "void *CFDictionaryGetValue(void *dict, void *key)",
    CFStringCreateWithCString: "void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)",
    CFStringGetLength: "long CFStringGetLength(void *str)",
    CFStringGetCString: "bool CFStringGetCString(void *str, _Out_ void *buffer, long bufferSize, uint32_t encoding)",
    CFNumberGetValue: "bool CFNumberGetValue(void *number, long theType, _Out_ void *valuePtr)",
    CFBooleanGetValue: "bool CFBooleanGetValue(void *boolean)",
  },
  CoreGraphics: {
    CGGetActiveDisplayList: "int32_t CGGetActiveDisplayList(uint32_t maxDisplays, _Out_ uint32_t *activeDisplays, _Out_ uint32_t *displayCount)",
    CGDisplayBounds: "CGRect CGDisplayBounds(uint32_t display)",
    CGDisplayIsBuiltin: "uint32_t CGDisplayIsBuiltin(uint32_t display)",
    CGDisplayCopyDisplayMode: "void *CGDisplayCopyDisplayMode(uint32_t display)",
    CGDisplayModeGetPixelWidth: "size_t CGDisplayModeGetPixelWidth(void *mode)",
    CGDisplayModeGetPixelHeight: "size_t CGDisplayModeGetPixelHeight(void *mode)",
    CGDisplayModeRelease: "void CGDisplayModeRelease(void *mode)",
    CGEventSourceCreate: "void *CGEventSourceCreate(int32_t stateID)",
    CGEventCreate: "void *CGEventCreate(void *source)",
    CGEventGetLocation: "CGPoint CGEventGetLocation(void *event)",
    CGEventCreateMouseEvent: "void *CGEventCreateMouseEvent(void *source, uint32_t mouseType, CGPoint mouseCursorPosition, uint32_t mouseButton)",
    CGEventCreateKeyboardEvent: "void *CGEventCreateKeyboardEvent(void *source, uint16_t virtualKey, bool keyDown)",
    CGEventCreateScrollWheelEvent2:
      "void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2, int32_t wheel3)",
    CGEventKeyboardSetUnicodeString: "void CGEventKeyboardSetUnicodeString(void *event, unsigned long length, const uint16_t *string)",
    CGEventSetFlags: "void CGEventSetFlags(void *event, uint64_t flags)",
    CGEventSetIntegerValueField: "void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)",
    CGEventPost: "void CGEventPost(uint32_t tap, void *event)",
    CGWindowListCopyWindowInfo: "void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)",
    CGRectMakeWithDictionaryRepresentation: "bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ CGRect *rect)",
    CGPreflightScreenCaptureAccess: "bool CGPreflightScreenCaptureAccess()",
    CGRequestScreenCaptureAccess: "bool CGRequestScreenCaptureAccess()",
  },
  ApplicationServices: {
    AXIsProcessTrusted: "bool AXIsProcessTrusted()",
    AXUIElementCreateApplication: "void *AXUIElementCreateApplication(int32_t pid)",
    AXUIElementCreateSystemWide: "void *AXUIElementCreateSystemWide()",
    AXUIElementCopyAttributeValue: "int32_t AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)",
    AXUIElementSetAttributeValue: "int32_t AXUIElementSetAttributeValue(void *element, void *attribute, void *value)",
    AXUIElementPerformAction: "int32_t AXUIElementPerformAction(void *element, void *action)",
    AXUIElementGetPid: "int32_t AXUIElementGetPid(void *element, _Out_ int32_t *pid)",
    AXValueCreate: "void *AXValueCreate(uint32_t theType, const void *valuePtr)",
    AXValueGetValue: "bool AXValueGetValue(void *value, uint32_t theType, _Out_ void *valuePtr)",
  },
  IOKit: {
    IOHIDCheckAccess: "uint32_t IOHIDCheckAccess(uint32_t requestType)",
  },
} as const;

type Protos = typeof PROTOTYPES;
type FnName = { [F in keyof Protos]: keyof Protos[F] }[keyof Protos];

const kCFStringEncodingUTF8 = 0x08000100;
const kCFNumberSInt64Type = 4;
const kCFNumberDoubleType = 13;
const kCGEventSourceStateHIDSystemState = 1;
const kCGHIDEventTap = 0;
const kCGMouseEventClickState = 1;
const kCGScrollEventUnitLine = 1;
const kCGWindowListOptionOnScreenOnly = 1;
const kCGWindowListExcludeDesktopElements = 16;
const kAXValueCGPointType = 1;
const kAXValueCGSizeType = 2;
const kAXErrorSuccess = 0;
const kIOHIDRequestTypeListenEvent = 1;
const MAX_DISPLAYS = 32;

export type Access = "granted" | "denied" | "unknown";

/** A window as the Accessibility API sees it (released with release()). */
export interface AxWindow {
  frame(): Rect | undefined;
  setFrame(r: Rect): void;
  bool(attr: "AXMinimized" | "AXFullScreen" | "AXMain"): boolean | undefined;
  setBool(attr: "AXMinimized" | "AXFullScreen" | "AXMain", v: boolean): boolean;
  raise(): void;
  release(): void;
}

export type Quartz = ReturnType<typeof bind>;

let loaded: Promise<Quartz> | undefined;

/** The macOS bindings (loaded on first use). */
export function quartz(): Promise<Quartz> {
  return (loaded ??= import("koffi").then((m) => bind(m.default)));
}

/** Private but long-stable (used by most window managers): the CGWindowID of an AX window. */
export const AX_GET_WINDOW = "int32_t _AXUIElementGetWindow(void *element, _Out_ uint32_t *wid)";

let defined: ReturnType<typeof define> | undefined;

/** Struct types (koffi type names are global, so defined once). */
export function defineTypes(koffi: Koffi) {
  return (defined ??= define(koffi));
}

function define(koffi: Koffi) {
  const CGPoint = koffi.struct("CGPoint", { x: "double", y: "double" });
  const CGSize = koffi.struct("CGSize", { width: "double", height: "double" });
  const CGRect = koffi.struct("CGRect", { origin: CGPoint, size: CGSize });
  return { CGPoint, CGSize, CGRect };
}

function bind(koffi: Koffi) {
  defineTypes(koffi);

  const fn = {} as Record<FnName, Fn>;
  const libs = {} as Record<keyof Protos, ReturnType<Koffi["load"]>>;
  for (const [fw, protos] of Object.entries(PROTOTYPES) as [keyof Protos, Record<string, string>][]) {
    const lib = (libs[fw] = koffi.load(framework(fw)));
    for (const [name, proto] of Object.entries(protos)) fn[name as FnName] = lib.func(proto) as Fn;
  }
  let axGetWindow: Fn | undefined;
  try {
    axGetWindow = libs.ApplicationServices.func(AX_GET_WINDOW) as Fn;
  } catch {
    // matched by position and size instead
  }
  const cfTrue = koffi.decode(libs.CoreFoundation.symbol("kCFBooleanTrue"), "void *") as Ptr;
  const cfFalse = koffi.decode(libs.CoreFoundation.symbol("kCFBooleanFalse"), "void *") as Ptr;

  const types = {
    string: Number(fn.CFStringGetTypeID()),
    number: Number(fn.CFNumberGetTypeID()),
    boolean: Number(fn.CFBooleanGetTypeID()),
  };
  const release = (p: Ptr) => {
    if (p) fn.CFRelease(p);
  };

  // CFStrings for dictionary keys and AX attribute names, made once.
  const strings = new Map<string, Ptr>();
  const cfstr = (s: string): Ptr => {
    let p = strings.get(s);
    if (!p) {
      p = fn.CFStringCreateWithCString(null, s, kCFStringEncodingUTF8) as Ptr;
      strings.set(s, p);
    }
    return p;
  };

  const toString = (p: Ptr): string | undefined => {
    if (!p || Number(fn.CFGetTypeID(p)) !== types.string) return undefined;
    const size = Number(fn.CFStringGetLength(p)) * 4 + 1; // UTF-16 units → at most 4 UTF-8 bytes each
    const buf = Buffer.alloc(size);
    if (!fn.CFStringGetCString(p, buf, size, kCFStringEncodingUTF8)) return undefined;
    const end = buf.indexOf(0);
    return buf.toString("utf8", 0, end < 0 ? size : end);
  };
  const toNumber = (p: Ptr): number | undefined => {
    if (!p) return undefined;
    const t = Number(fn.CFGetTypeID(p));
    if (t === types.boolean) return fn.CFBooleanGetValue(p) ? 1 : 0;
    if (t !== types.number) return undefined;
    const buf = Buffer.alloc(8);
    return fn.CFNumberGetValue(p, kCFNumberDoubleType, buf) ? buf.readDoubleLE(0) : undefined;
  };
  const toInt = (p: Ptr): number | undefined => {
    if (!p || Number(fn.CFGetTypeID(p)) !== types.number) return toNumber(p);
    const buf = Buffer.alloc(8);
    return fn.CFNumberGetValue(p, kCFNumberSInt64Type, buf) ? Number(buf.readBigInt64LE(0)) : undefined;
  };
  const get = (dict: Ptr, key: string): Ptr => (dict ? (fn.CFDictionaryGetValue(dict, cfstr(key)) as Ptr) : null);
  const rectOf = (dict: Ptr): Rect | undefined => {
    if (!dict) return undefined;
    const r = {} as { origin: { x: number; y: number }; size: { width: number; height: number } };
    return fn.CGRectMakeWithDictionaryRepresentation(dict, r) ? { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height } : undefined;
  };

  const copyAttr = (el: Ptr, attr: string): Ptr => {
    const out: Ptr[] = [null];
    return fn.AXUIElementCopyAttributeValue(el, cfstr(attr), out) === kAXErrorSuccess ? (out[0] ?? null) : null;
  };
  const axValue = (v: Ptr, type: number): number[] | undefined => {
    const buf = Buffer.alloc(16);
    return v && fn.AXValueGetValue(v, type, buf) ? [buf.readDoubleLE(0), buf.readDoubleLE(8)] : undefined;
  };
  const setPair = (el: Ptr, attr: string, type: number, a: number, b: number): boolean => {
    const buf = Buffer.alloc(16);
    buf.writeDoubleLE(a, 0);
    buf.writeDoubleLE(b, 8);
    const v = fn.AXValueCreate(type, buf) as Ptr;
    try {
      return fn.AXUIElementSetAttributeValue(el, cfstr(attr), v) === kAXErrorSuccess;
    } finally {
      release(v);
    }
  };

  const axWindow = (el: Ptr): AxWindow => ({
    frame() {
      const pv = copyAttr(el, "AXPosition");
      const sv = copyAttr(el, "AXSize");
      try {
        const p = axValue(pv, kAXValueCGPointType);
        const s = axValue(sv, kAXValueCGSizeType);
        return p && s ? { x: p[0]!, y: p[1]!, w: s[0]!, h: s[1]! } : undefined;
      } finally {
        release(pv);
        release(sv);
      }
    },
    setFrame(r) {
      // Position, size, then position again: a window grown past the screen edge gets pushed back.
      setPair(el, "AXPosition", kAXValueCGPointType, r.x, r.y);
      setPair(el, "AXSize", kAXValueCGSizeType, r.w, r.h);
      setPair(el, "AXPosition", kAXValueCGPointType, r.x, r.y);
    },
    bool(attr) {
      const v = copyAttr(el, attr);
      try {
        const n = toNumber(v);
        return n === undefined ? undefined : n !== 0;
      } finally {
        release(v);
      }
    },
    setBool(attr, v) {
      return fn.AXUIElementSetAttributeValue(el, cfstr(attr), v ? cfTrue : cfFalse) === kAXErrorSuccess;
    },
    raise() {
      fn.AXUIElementPerformAction(el, cfstr("AXRaise"));
    },
    release() {
      release(el);
    },
  });

  const source = fn.CGEventSourceCreate(kCGEventSourceStateHIDSystemState) as Ptr;

  return {
    fn,

    /** Active displays in CGGetActiveDisplayList order (the main display first; ffmpeg's avfoundation order). */
    displays(): CgDisplay[] {
      const ids = new Array<number>(MAX_DISPLAYS).fill(0);
      const count = [0];
      if (fn.CGGetActiveDisplayList(MAX_DISPLAYS, ids, count) !== 0) return [];
      return ids.slice(0, count[0]).map((id) => {
        const b = fn.CGDisplayBounds(id) as { origin: { x: number; y: number }; size: { width: number; height: number } };
        const bounds = { x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height };
        const mode = fn.CGDisplayCopyDisplayMode(id) as Ptr;
        let pixelW = bounds.w;
        let pixelH = bounds.h;
        if (mode) {
          pixelW = Number(fn.CGDisplayModeGetPixelWidth(mode)) || pixelW;
          pixelH = Number(fn.CGDisplayModeGetPixelHeight(mode)) || pixelH;
          fn.CGDisplayModeRelease(mode);
        }
        return { id, bounds, pixelW, pixelH, builtin: !!fn.CGDisplayIsBuiltin(id) };
      });
    },

    /** Pointer position (global points). */
    cursor(): { x: number; y: number } {
      const e = fn.CGEventCreate(null) as Ptr;
      try {
        const p = fn.CGEventGetLocation(e) as { x: number; y: number };
        return { x: p.x, y: p.y };
      } finally {
        release(e);
      }
    },

    /** Create, post (HID level) and release one event. */
    post(ev: MacEvent): void {
      let e: Ptr;
      if (ev.kind === "mouse") {
        e = fn.CGEventCreateMouseEvent(source, ev.type, { x: ev.x, y: ev.y }, ev.button) as Ptr;
        if (e && ev.clickState) fn.CGEventSetIntegerValueField(e, kCGMouseEventClickState, ev.clickState);
      } else if (ev.kind === "key") {
        e = fn.CGEventCreateKeyboardEvent(source, ev.keycode, ev.down) as Ptr;
        if (e) {
          fn.CGEventSetFlags(e, ev.flags);
          if (ev.text) {
            const units = new Uint16Array(ev.text.length);
            for (let i = 0; i < units.length; i++) units[i] = ev.text.charCodeAt(i);
            fn.CGEventKeyboardSetUnicodeString(e, units.length, units);
          }
        }
      } else {
        e = fn.CGEventCreateScrollWheelEvent2(source, kCGScrollEventUnitLine, 2, ev.wheel1, ev.wheel2, 0) as Ptr;
      }
      if (!e) throw new Error(`Quartz could not create a ${ev.kind} event`);
      try {
        fn.CGEventPost(kCGHIDEventTap, e);
      } finally {
        release(e);
      }
    },

    /** On-screen windows, front to back. */
    windows(): CgWindow[] {
      const list = fn.CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, 0) as Ptr;
      if (!list) return [];
      try {
        const out: CgWindow[] = [];
        const n = Number(fn.CFArrayGetCount(list));
        for (let i = 0; i < n; i++) {
          const d = fn.CFArrayGetValueAtIndex(list, i) as Ptr;
          const bounds = rectOf(get(d, "kCGWindowBounds"));
          const id = toInt(get(d, "kCGWindowNumber"));
          if (!bounds || id === undefined) continue;
          out.push({
            id,
            pid: toInt(get(d, "kCGWindowOwnerPID")) ?? 0,
            owner: toString(get(d, "kCGWindowOwnerName")) ?? "",
            name: toString(get(d, "kCGWindowName")) ?? "",
            layer: toInt(get(d, "kCGWindowLayer")) ?? 0,
            alpha: toNumber(get(d, "kCGWindowAlpha")) ?? 1,
            onScreen: (toNumber(get(d, "kCGWindowIsOnscreen")) ?? 1) !== 0,
            bounds,
          });
        }
        return out;
      } finally {
        release(list);
      }
    },

    /** Accessibility permission for this process (really: for the app that launched it). */
    axTrusted(): boolean {
      return !!fn.AXIsProcessTrusted();
    },

    /** Screen Recording permission (without it captures show only the wallpaper and window titles are hidden). */
    screenCaptureAllowed(): boolean {
      return !!fn.CGPreflightScreenCaptureAccess();
    },

    /** Ask for Screen Recording once (adds the app to the list in System Settings). */
    requestScreenCapture(): boolean {
      return !!fn.CGRequestScreenCaptureAccess();
    },

    /** Input Monitoring permission (global mouse hook for click logging). */
    inputMonitoring(): Access {
      const r = Number(fn.IOHIDCheckAccess(kIOHIDRequestTypeListenEvent));
      return r === 0 ? "granted" : r === 1 ? "denied" : "unknown";
    },

    /** pid of the app with keyboard focus (needs Accessibility). */
    focusedPid(): number | undefined {
      const sys = fn.AXUIElementCreateSystemWide() as Ptr;
      try {
        const app = copyAttr(sys, "AXFocusedApplication");
        if (!app) return undefined;
        try {
          const pid = [0];
          return fn.AXUIElementGetPid(app, pid) === kAXErrorSuccess ? pid[0] : undefined;
        } finally {
          release(app);
        }
      } finally {
        release(sys);
      }
    },

    /** The app's AX windows with their CG window ids (when known) and frames. Release each. */
    appWindows(pid: number): { win: AxWindow; wid?: number; frame?: Rect }[] {
      const app = fn.AXUIElementCreateApplication(pid) as Ptr;
      try {
        const arr = copyAttr(app, "AXWindows");
        if (!arr) return [];
        try {
          const out: { win: AxWindow; wid?: number; frame?: Rect }[] = [];
          const n = Number(fn.CFArrayGetCount(arr));
          for (let i = 0; i < n; i++) {
            // Retained: the array (and with it its elements) is released below.
            const el = fn.CFRetain(fn.CFArrayGetValueAtIndex(arr, i)) as Ptr;
            const win = axWindow(el);
            const wid = [0];
            const ok = axGetWindow ? axGetWindow(el, wid) === kAXErrorSuccess : false;
            out.push({ win, ...(ok ? { wid: wid[0] } : {}), frame: win.frame() });
          }
          return out;
        } finally {
          release(arr);
        }
      } finally {
        release(app);
      }
    },

    /** Make the app frontmost (AXFrontmost) and its window main + raised. */
    activate(pid: number, win: AxWindow): void {
      const app = fn.AXUIElementCreateApplication(pid) as Ptr;
      try {
        fn.AXUIElementSetAttributeValue(app, cfstr("AXFrontmost"), cfTrue);
      } finally {
        release(app);
      }
      win.setBool("AXMain", true);
      win.raise();
    },
  };
}
