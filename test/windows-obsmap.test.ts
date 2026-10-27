import { describe, expect, it } from "vitest";
import { sourceMonitor } from "../src/platform/windows/obsmap.js";

const GUID = "{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";
const screens = [
  { name: "\\\\.\\DISPLAY1", x: 0, y: 0, w: 2560, h: 1440, deviceId: `\\\\?\\DISPLAY#GSM5B7F#5&1a2b3c&0&UID4352#${GUID}` },
  { name: "\\\\.\\DISPLAY2", x: -1920, y: 0, w: 1920, h: 1080, deviceId: `\\\\?\\DISPLAY#DEL41A8#5&1a2b3c&0&UID4353#${GUID}` },
];

describe("OBS monitor_capture → monitor", () => {
  it("matches monitor_id to the device interface path, ignoring case", () => {
    const settings = { monitor_id: `\\\\?\\display#del41a8#5&1A2B3C&0&uid4353#${GUID.toUpperCase()}` };
    expect(sourceMonitor("monitor_capture", settings, screens)).toBe("\\\\.\\DISPLAY2");
  });

  it("matches when only the interface GUID differs", () => {
    const settings = { monitor_id: "\\\\?\\DISPLAY#GSM5B7F#5&1a2b3c&0&UID4352#{00000000-0000-0000-0000-000000000000}" };
    expect(sourceMonitor("monitor_capture", settings, screens)).toBe("\\\\.\\DISPLAY1");
  });

  it("falls back to the legacy monitor index (enumeration order)", () => {
    expect(sourceMonitor("monitor_capture", { monitor: 1 }, screens)).toBe("\\\\.\\DISPLAY2");
    expect(sourceMonitor("monitor_capture", { monitor: 5 }, screens)).toBeUndefined();
  });

  it("prefers monitor_id over the legacy index", () => {
    expect(sourceMonitor("monitor_capture", { monitor_id: screens[0]!.deviceId, monitor: 1 }, screens)).toBe("\\\\.\\DISPLAY1");
  });

  it("knows nothing about other source kinds or unknown ids", () => {
    expect(sourceMonitor("window_capture", { monitor: 0 }, screens)).toBeUndefined();
    expect(sourceMonitor("monitor_capture", { monitor_id: "DUMMY" }, screens)).toBeUndefined();
  });
});
