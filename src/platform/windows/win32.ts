import type { Rect, ScreenInfo } from "../../record/input/types.js";
import { rectFromLTRB, toScreen, type LTRB } from "./geometry.js";
import type { Win32Input } from "./inputs.js";

// Win32 through koffi (x64). koffi is imported lazily by win32() so other
// OSes never load it. The process is made per-monitor DPI aware (V2) once,
// so every coordinate here is in physical pixels, like OBS/ffmpeg captures.

type Koffi = typeof import("koffi").default;
type Fn = (...args: unknown[]) => any;

let defined: ReturnType<typeof define> | undefined;

/** Struct and callback types (koffi type names are global, so defined once). */
export function defineTypes(koffi: Koffi) {
  return (defined ??= define(koffi));
}

function define(koffi: Koffi) {
  const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
  koffi.alias("HWND", HANDLE);
  koffi.alias("HMONITOR", HANDLE);
  koffi.alias("HDC", HANDLE);
  const POINT = koffi.struct("POINT", { x: "int32_t", y: "int32_t" });
  const RECT = koffi.struct("RECT", { left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
  const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
    dx: "int32_t",
    dy: "int32_t",
    mouseData: "uint32_t",
    dwFlags: "uint32_t",
    time: "uint32_t",
    dwExtraInfo: "uintptr_t",
  });
  const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
    wVk: "uint16_t",
    wScan: "uint16_t",
    dwFlags: "uint32_t",
    time: "uint32_t",
    dwExtraInfo: "uintptr_t",
  });
  const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", { uMsg: "uint32_t", wParamL: "uint16_t", wParamH: "uint16_t" });
  // The union is 8-aligned (ULONG_PTR), so it starts at offset 8: sizeof(INPUT) = 40 on x64.
  const INPUT = koffi.struct("INPUT", { type: "uint32_t", u: koffi.union("INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
  const MONITORINFOEXW = koffi.struct("MONITORINFOEXW", {
    cbSize: "uint32_t",
    rcMonitor: RECT,
    rcWork: RECT,
    dwFlags: "uint32_t",
    szDevice: koffi.array("char16_t", 32),
  });
  const DISPLAY_DEVICEW = koffi.struct("DISPLAY_DEVICEW", {
    cb: "uint32_t",
    DeviceName: koffi.array("char16_t", 32),
    DeviceString: koffi.array("char16_t", 128),
    StateFlags: "uint32_t",
    DeviceID: koffi.array("char16_t", 128),
    DeviceKey: koffi.array("char16_t", 128),
  });
  const WINDOWPLACEMENT = koffi.struct("WINDOWPLACEMENT", {
    length: "uint32_t",
    flags: "uint32_t",
    showCmd: "uint32_t",
    ptMinPosition: POINT,
    ptMaxPosition: POINT,
    rcNormalPosition: RECT,
  });
  const WNDENUMPROC = koffi.proto("int __stdcall WNDENUMPROC(HWND hwnd, intptr_t lParam)");
  const MONITORENUMPROC = koffi.proto("int __stdcall MONITORENUMPROC(HMONITOR hmon, HDC hdc, RECT *rect, intptr_t lParam)");
  return { HANDLE, POINT, RECT, MOUSEINPUT, KEYBDINPUT, HARDWAREINPUT, INPUT, MONITORINFOEXW, DISPLAY_DEVICEW, WINDOWPLACEMENT, WNDENUMPROC, MONITORENUMPROC };
}

/** A wrong INPUT size makes SendInput fail with ERROR_INVALID_PARAMETER, so check before using it. */
export function assertLayout(koffi: Koffi, t: ReturnType<typeof defineTypes>): void {
  const ptr = koffi.sizeof("void *");
  const want: [string, number, number][] = [
    ["INPUT", koffi.sizeof(t.INPUT), ptr === 8 ? 40 : 28],
    ["MONITORINFOEXW", koffi.sizeof(t.MONITORINFOEXW), 104],
    ["DISPLAY_DEVICEW", koffi.sizeof(t.DISPLAY_DEVICEW), 840],
    ["WINDOWPLACEMENT", koffi.sizeof(t.WINDOWPLACEMENT), 44],
  ];
  for (const [name, got, expected] of want) {
    if (got !== expected) throw new Error(`Win32 struct ${name} is ${got} bytes, expected ${expected}`);
  }
}

export type WindowPlacement = {
  length: number;
  flags: number;
  showCmd: number;
  ptMinPosition: { x: number; y: number };
  ptMaxPosition: { x: number; y: number };
  rcNormalPosition: LTRB;
};

export interface Monitor {
  handle: bigint;
  screen: ScreenInfo;
  /** Monitor area without the taskbar / docked app bars. */
  work: Rect;
  primary: boolean;
  /** Effective DPI of the monitor (96 = 100% scale); 96 when Windows can't say. */
  dpi: number;
}

export type Win32 = ReturnType<typeof bind>;

export const SW_RESTORE = 9;
export const SWP_NOZORDER = 0x0004;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_NOOWNERZORDER = 0x0200;
export const GWL_EXSTYLE = -20;
export const MONITOR_DEFAULTTONEAREST = 2;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const EDD_GET_DEVICE_INTERFACE_NAME = 1;
const MONITORINFOF_PRIMARY = 1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
const MDT_EFFECTIVE_DPI = 0;

let loaded: Promise<Win32> | undefined;

/** The Win32 bindings (loaded on first use). */
export function win32(): Promise<Win32> {
  return (loaded ??= import("koffi").then((m) => bind(m.default)));
}

/** Every function we call, per DLL, as koffi prototype strings. */
export const PROTOTYPES = {
  "user32.dll": {
    SendInput: "uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)",
    GetCursorPos: "int __stdcall GetCursorPos(_Out_ POINT *lpPoint)",
    SetCursorPos: "int __stdcall SetCursorPos(int X, int Y)",
    EnumWindows: "int __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)",
    GetWindowTextW: "int __stdcall GetWindowTextW(HWND hWnd, _Out_ void *lpString, int nMaxCount)",
    GetWindowTextLengthW: "int __stdcall GetWindowTextLengthW(HWND hWnd)",
    GetClassNameW: "int __stdcall GetClassNameW(HWND hWnd, _Out_ void *lpClassName, int nMaxCount)",
    GetWindowThreadProcessId: "uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)",
    IsWindow: "int __stdcall IsWindow(HWND hWnd)",
    IsWindowVisible: "int __stdcall IsWindowVisible(HWND hWnd)",
    IsIconic: "int __stdcall IsIconic(HWND hWnd)",
    IsZoomed: "int __stdcall IsZoomed(HWND hWnd)",
    GetWindowLongPtrW: "intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int nIndex)",
    GetForegroundWindow: "HWND __stdcall GetForegroundWindow()",
    SetForegroundWindow: "int __stdcall SetForegroundWindow(HWND hWnd)",
    BringWindowToTop: "int __stdcall BringWindowToTop(HWND hWnd)",
    ShowWindow: "int __stdcall ShowWindow(HWND hWnd, int nCmdShow)",
    SetWindowPos: "int __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)",
    GetWindowRect: "int __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)",
    GetWindowPlacement: "int __stdcall GetWindowPlacement(HWND hWnd, _Inout_ WINDOWPLACEMENT *lpwndpl)",
    SetWindowPlacement: "int __stdcall SetWindowPlacement(HWND hWnd, const WINDOWPLACEMENT *lpwndpl)",
    EnumDisplayMonitors: "int __stdcall EnumDisplayMonitors(HDC hdc, RECT *lprcClip, MONITORENUMPROC *lpfnEnum, intptr_t dwData)",
    GetMonitorInfoW: "int __stdcall GetMonitorInfoW(HMONITOR hMonitor, _Inout_ MONITORINFOEXW *lpmi)",
    MonitorFromWindow: "HMONITOR __stdcall MonitorFromWindow(HWND hwnd, uint32_t dwFlags)",
    EnumDisplayDevicesW:
      "int __stdcall EnumDisplayDevicesW(const char16_t *lpDevice, uint32_t iDevNum, _Inout_ DISPLAY_DEVICEW *lpDisplayDevice, uint32_t dwFlags)",
    GetSystemMetrics: "int __stdcall GetSystemMetrics(int nIndex)",
    AttachThreadInput: "int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)",
  },
  "kernel32.dll": {
    GetCurrentThreadId: "uint32_t __stdcall GetCurrentThreadId()",
    OpenProcess: "HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)",
    QueryFullProcessImageNameW:
      "int __stdcall QueryFullProcessImageNameW(HANDLE hProcess, uint32_t dwFlags, _Out_ void *lpExeName, _Inout_ uint32_t *lpdwSize)",
    CloseHandle: "int __stdcall CloseHandle(HANDLE hObject)",
  },
  "shcore.dll": {
    GetDpiForMonitor: "int32_t __stdcall GetDpiForMonitor(HMONITOR hmonitor, int dpiType, _Out_ uint32_t *dpiX, _Out_ uint32_t *dpiY)",
  },
  "dwmapi.dll": {
    DwmGetWindowAttribute: "int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t dwAttribute, _Out_ void *pvAttribute, uint32_t cbAttribute)",
  },
} as const;

type Protos = typeof PROTOTYPES;
type FnName = { [D in keyof Protos]: keyof Protos[D] }[keyof Protos];

// Windows 10 1703+; looked up separately so older systems still load.
const DPI_PROTO = "int __stdcall SetProcessDpiAwarenessContext(intptr_t value)";

function bind(koffi: Koffi) {
  const t = defineTypes(koffi);
  assertLayout(koffi, t);
  const fn = {} as Record<FnName, Fn>;
  for (const [dll, protos] of Object.entries(PROTOTYPES)) {
    const lib = koffi.load(dll);
    for (const [name, proto] of Object.entries(protos)) fn[name as FnName] = lib.func(proto) as Fn;
  }

  // Fails harmlessly when the awareness was already set (e.g. by a manifest).
  try {
    (koffi.load("user32.dll").func(DPI_PROTO) as Fn)(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  } catch {
    // older Windows: coordinates may be DPI-virtualized
  }


  const dpiOf = (h: bigint): number => {
    const x = [0];
    const y = [0];
    return fn.GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, x, y) === 0 && x[0]! > 0 ? x[0]! : 96;
  };

  const inputSize = koffi.sizeof(t.INPUT);
  const wide = (buf: Buffer, chars: number) => buf.toString("utf16le", 0, chars * 2);
  const exeCache = new Map<number, string>();

  const frameRect = (h: bigint): Rect | undefined => {
    const buf = Buffer.alloc(16);
    if (fn.DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0) {
      return rectFromLTRB({ left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) });
    }
    return windowRect(h);
  };
  const windowRect = (h: bigint): Rect | undefined => {
    const r: LTRB = { left: 0, top: 0, right: 0, bottom: 0 };
    return fn.GetWindowRect(h, r) ? rectFromLTRB(r) : undefined;
  };

  return {
    fn,

    /** Inject inputs; throws when Windows drops them (UIPI blocks input to elevated windows). */
    sendInput(inputs: Win32Input[]): void {
      if (!inputs.length) return;
      const n = Number(fn.SendInput(inputs.length, inputs, inputSize));
      if (n === 0) {
        throw new Error("SendInput was blocked (UIPI: is the target window running elevated? Run this tool as administrator too.)");
      }
      if (n !== inputs.length) throw new Error(`SendInput inserted only ${n} of ${inputs.length} input events`);
    },

    cursorPos(): { x: number; y: number } | undefined {
      const p = { x: 0, y: 0 };
      return fn.GetCursorPos(p) ? p : undefined;
    },

    virtualScreen(): Rect {
      return {
        x: fn.GetSystemMetrics(SM_XVIRTUALSCREEN),
        y: fn.GetSystemMetrics(SM_YVIRTUALSCREEN),
        w: fn.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        h: fn.GetSystemMetrics(SM_CYVIRTUALSCREEN),
      };
    },

    /** Monitors in EnumDisplayMonitors order (the order OBS's legacy monitor index used). */
    monitors(): Monitor[] {
      const handles: bigint[] = [];
      fn.EnumDisplayMonitors(null, null, (h: bigint) => {
        handles.push(h);
        return 1;
      }, 0);
      const out: Monitor[] = [];
      for (const handle of handles) {
        const mi = { cbSize: koffi.sizeof(t.MONITORINFOEXW) } as { cbSize: number; rcMonitor: LTRB; rcWork: LTRB; dwFlags: number; szDevice: string };
        if (!fn.GetMonitorInfoW(handle, mi)) continue;
        const dd = { cb: koffi.sizeof(t.DISPLAY_DEVICEW) } as { cb: number; DeviceString: string; DeviceID: string };
        const model = fn.EnumDisplayDevicesW(mi.szDevice, 0, dd, 0) ? dd.DeviceString : undefined;
        const di = { cb: koffi.sizeof(t.DISPLAY_DEVICEW) } as { cb: number; DeviceID: string };
        const deviceId = fn.EnumDisplayDevicesW(mi.szDevice, 0, di, EDD_GET_DEVICE_INTERFACE_NAME) ? di.DeviceID : undefined;
        out.push({
          handle,
          screen: toScreen(mi.szDevice, rectFromLTRB(mi.rcMonitor), model, deviceId),
          work: rectFromLTRB(mi.rcWork),
          primary: (mi.dwFlags & MONITORINFOF_PRIMARY) !== 0,
          dpi: dpiOf(handle),
        });
      }
      return out;
    },

    foreground(): bigint | null {
      return fn.GetForegroundWindow();
    },

    monitorOf(h: bigint): bigint | null {
      return fn.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    },

    /** Top-level windows, front to back (EnumWindows is in z-order). */
    topWindows(): bigint[] {
      const out: bigint[] = [];
      fn.EnumWindows((h: bigint) => {
        out.push(h);
        return 1;
      }, 0);
      return out;
    },

    title(h: bigint): string {
      const n = fn.GetWindowTextLengthW(h);
      if (n <= 0) return "";
      const buf = Buffer.alloc((n + 1) * 2);
      return wide(buf, fn.GetWindowTextW(h, buf, n + 1));
    },

    className(h: bigint): string {
      const buf = Buffer.alloc(256 * 2);
      return wide(buf, fn.GetClassNameW(h, buf, 256));
    },

    cloaked(h: bigint): boolean {
      const buf = Buffer.alloc(4);
      return fn.DwmGetWindowAttribute(h, DWMWA_CLOAKED, buf, 4) === 0 && buf.readUInt32LE(0) !== 0;
    },

    exStyle(h: bigint): number {
      return Number(fn.GetWindowLongPtrW(h, GWL_EXSTYLE));
    },

    /** Thread and process that own the window. */
    owner(h: bigint): { thread: number; pid: number } {
      const pid = [0];
      const thread = fn.GetWindowThreadProcessId(h, pid);
      return { thread, pid: pid[0]! };
    },

    /** Lower-case exe file name of a process ("chrome.exe"); "" when it can't be opened. */
    exeName(pid: number): string {
      const hit = exeCache.get(pid);
      if (hit !== undefined) return hit;
      const proc = fn.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!proc) return "";
      try {
        const buf = Buffer.alloc(1024 * 2);
        const size = [1024];
        if (!fn.QueryFullProcessImageNameW(proc, 0, buf, size)) return "";
        const name = (wide(buf, size[0]!).split(/[\\/]/).pop() ?? "").toLowerCase();
        exeCache.set(pid, name);
        return name;
      } finally {
        fn.CloseHandle(proc);
      }
    },

    /** Visible frame (DWM extended frame bounds, without invisible borders). */
    frameRect,
    /** GetWindowRect: the frame plus invisible resize borders. */
    windowRect,

    getPlacement(h: bigint): WindowPlacement | undefined {
      const wp = { length: koffi.sizeof(t.WINDOWPLACEMENT) } as WindowPlacement;
      return fn.GetWindowPlacement(h, wp) ? wp : undefined;
    },

    setPlacement(h: bigint, wp: WindowPlacement): boolean {
      return !!fn.SetWindowPlacement(h, { ...wp, length: koffi.sizeof(t.WINDOWPLACEMENT) });
    },
  };
}
