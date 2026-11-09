import type { z } from "zod";
import type { NumberCardDataSchema } from "../../storyboard/schema.js";
import { CHAR_EM, esc, type Geometry, textHeight } from "./common.js";

type Data = z.output<typeof NumberCardDataSchema>;

const KICKER = 30;
const LABEL = 56;
const FOOTER = 28;
const VALUE_MAX = 260;

export const valueText = (data: Data) => String(data.value);

/** The figure as large as one line of the box holds (a long "98.6 million" gets smaller, never wider than the box). */
export function valuePx(data: Data, g: Geometry, s: number): number {
  const chars = [...valueText(data)].length;
  return Math.min(VALUE_MAX * g.u, g.boxW / (chars * CHAR_EM)) * s;
}

export function measure(data: Data, g: Geometry, s: number): number {
  const u = g.u * s;
  let h = valuePx(data, g, s) * 1.1;
  if (data.kicker) h += textHeight(data.kicker, KICKER * u, g.boxW, 1.3) + 16 * u;
  if (data.label) h += 12 * u + textHeight(data.label, LABEL * u, g.boxW, 1.3);
  if (data.footer) h += 36 * u + textHeight(data.footer, FOOTER * u, g.boxW, 1.3);
  return h;
}

export function markup(data: Data, g: Geometry): string {
  return (
    `${data.kicker ? `<div class="dc-kicker">${esc(data.kicker)}</div>` : ""}` +
    `<div class="dc-value" style="font-size:calc(${Math.round(valuePx(data, g, 1) * 100) / 100}px * var(--fs))">${esc(valueText(data))}</div>` +
    `${data.label ? `<div class="dc-label">${esc(data.label)}</div>` : ""}${data.footer ? `<div class="dc-footer">${esc(data.footer)}</div>` : ""}`
  );
}
