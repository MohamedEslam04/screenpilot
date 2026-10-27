import type { PortalStream } from "../drive/portal.js";
import type { ScreenInfo } from "../record/input/types.js";

// Monitor layouts from Wayland compositors that are not KDE, as global
// logical pixels (what the portal streams and pointer motion use). Pure
// parsers; the D-Bus / CLI calls are in wayland.ts.

type Variantish = { value: unknown } | unknown;
const val = (v: Variantish): unknown => (v && typeof v === "object" && "value" in v && !Array.isArray(v) ? (v as { value: unknown }).value : v);

/** Mutter's layout mode: 1 = logical (sizes divided by scale), 2 = physical. */
const LAYOUT_LOGICAL = 1;

/**
 * org.gnome.Mutter.DisplayConfig.GetCurrentState body:
 * (u serial, a((ssss)a(siiddada{sv})a{sv}) monitors,
 *  a(iiduba(ssss)a{sv}) logical_monitors, a{sv} properties).
 * One ScreenInfo per logical monitor, named after its first connector.
 */
export function parseMutterState(body: unknown[]): ScreenInfo[] {
  const [, monitors, logical, props] = body as [number, unknown[][], unknown[][], Record<string, Variantish>];
  const layoutMode = Number(val(props?.["layout-mode"]) ?? LAYOUT_LOGICAL);
  const byConnector = new Map<string, { w: number; h: number; vendor: string; product: string; display?: string }>();
  for (const m of monitors ?? []) {
    const [[connector, vendor, product], modes, mprops] = m as [[string, string, string, string], unknown[][], Record<string, Variantish>];
    const current = (modes ?? []).find((mode) => val((mode[6] as Record<string, Variantish>)?.["is-current"]) === true);
    if (!current) continue; // monitor is off
    const display = val(mprops?.["display-name"]);
    byConnector.set(connector, {
      w: Number(current[1]),
      h: Number(current[2]),
      vendor,
      product,
      ...(typeof display === "string" ? { display } : {}),
    });
  }
  const out: ScreenInfo[] = [];
  for (const lm of logical ?? []) {
    const [x, y, scale, transform, , specs] = lm as [number, number, number, number, boolean, [string, string, string, string][]];
    const mon = specs?.map((s) => ({ connector: s[0], info: byConnector.get(s[0]) })).find((s) => s.info);
    if (!mon) continue;
    const rotated = Number(transform) % 2 === 1; // 90/270 (and flipped variants)
    let w = rotated ? mon.info!.h : mon.info!.w;
    let h = rotated ? mon.info!.w : mon.info!.h;
    if (layoutMode === LAYOUT_LOGICAL && scale > 0) {
      w = Math.round(w / scale);
      h = Math.round(h / scale);
    }
    out.push({
      name: mon.connector,
      x: Number(x),
      y: Number(y),
      w,
      h,
      ...(mon.info!.vendor ? { manufacturer: mon.info!.vendor } : {}),
      ...(mon.info!.display || mon.info!.product ? { model: mon.info!.display ?? mon.info!.product } : {}),
    });
  }
  return out;
}

/** Layout order (top to bottom, then left to right), as KWin lists monitors. */
const byPosition = (a: ScreenInfo, b: ScreenInfo) => a.y - b.y || a.x - b.x;

/** `swaymsg -t get_outputs -r` (rect is already logical). */
export function parseSwayOutputs(json: string): ScreenInfo[] {
  const outputs = JSON.parse(json) as { name: string; active?: boolean; make?: string; model?: string; rect: { x: number; y: number; width: number; height: number } }[];
  return outputs
    .filter((o) => o.active !== false && o.rect && o.rect.width > 0)
    .map((o) => ({
      name: o.name,
      x: o.rect.x,
      y: o.rect.y,
      w: o.rect.width,
      h: o.rect.height,
      ...(o.make ? { manufacturer: o.make } : {}),
      ...(o.model ? { model: o.model } : {}),
    }))
    .sort(byPosition);
}

/** `hyprctl monitors -j` (width/height are the mode in physical px; positions are logical). */
export function parseHyprMonitors(json: string): ScreenInfo[] {
  const mons = JSON.parse(json) as { name: string; x: number; y: number; width: number; height: number; scale?: number; transform?: number; make?: string; model?: string; disabled?: boolean }[];
  return mons
    .filter((m) => !m.disabled)
    .map((m) => {
      const rotated = (m.transform ?? 0) % 2 === 1;
      const scale = m.scale && m.scale > 0 ? m.scale : 1;
      const w = Math.round((rotated ? m.height : m.width) / scale);
      const h = Math.round((rotated ? m.width : m.height) / scale);
      return { name: m.name, x: m.x, y: m.y, w, h, ...(m.make ? { manufacturer: m.make } : {}), ...(m.model ? { model: m.model } : {}) };
    })
    .sort(byPosition);
}

/**
 * Last resort: monitors as the portal streams describe them. Streams without
 * a position (some portals omit it) are laid out left to right.
 */
export function screensFromStreams(streams: PortalStream[]): ScreenInfo[] {
  const positioned = streams.some((s) => s.x !== 0 || s.y !== 0) || streams.length === 1;
  let nextX = 0;
  return streams
    .filter((s) => s.w > 0 && s.h > 0)
    .sort((a, b) => (positioned ? a.y - b.y || a.x - b.x : 0))
    .map((s, i) => {
      const x = positioned ? s.x : nextX;
      nextX += s.w;
      return { name: `screen-${i + 1}`, x, y: positioned ? s.y : 0, w: s.w, h: s.h };
    });
}
