import type { ScreenInfo } from "../../record/input/types.js";

// Which monitor an OBS "monitor_capture" source shows. OBS 27+ stores the
// monitor's device interface path in `monitor_id`; older versions stored an
// index (`monitor`) into the EnumDisplayMonitors order.

/** Device path without its trailing interface-class GUID ("...#{e6f07b5f-...}"). */
const stem = (id: string) => id.toLowerCase().replace(/#\{[0-9a-f-]+\}$/, "");

export function sourceMonitor(inputKind: string, settings: Record<string, unknown>, screens: ScreenInfo[]): string | undefined {
  if (inputKind !== "monitor_capture") return undefined;
  const id = settings.monitor_id;
  if (typeof id === "string" && id) {
    const want = id.toLowerCase();
    const hit =
      screens.find((s) => s.deviceId?.toLowerCase() === want) ?? screens.find((s) => s.deviceId && stem(s.deviceId) === stem(id));
    if (hit) return hit.name;
  }
  // Legacy index: our screens() keeps EnumDisplayMonitors order, as OBS did.
  const index = settings.monitor;
  if (typeof index === "number" && Number.isInteger(index)) return screens[index]?.name;
  return undefined;
}
