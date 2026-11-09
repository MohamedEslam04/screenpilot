import type { z } from "zod";
import type { ListCardDataSchema } from "../../storyboard/schema.js";
import { esc, type Geometry, textHeight } from "./common.js";

type Data = z.output<typeof ListCardDataSchema>;

// Sizes for a 1080 px short side. `s` (0.4..1) is the fit scale chosen by fitScale.
const KICKER = 30;
const TITLE = 72;
const HEADING = 44;
const TEXT = 32;
const FOOTER = 28;
const GAP = 20;
const PAD = 22;
const MARK = 14;
const MARK_GAP = 22;

const columns = (data: Data, g: Geometry) => (g.wide && data.items.length > 4 ? 2 : 1);

/** Estimated height (px) of the card's content at fit scale `s`. */
export function measure(data: Data, g: Geometry, s: number): number {
  const u = g.u * s;
  const cols = columns(data, g);
  const colW = (g.boxW - (cols - 1) * GAP * u) / cols;
  const itemW = colW - (2 * PAD + MARK + MARK_GAP) * u;
  let h = 0;
  if (data.kicker) h += textHeight(data.kicker, KICKER * u, g.boxW, 1.3) + 10 * u;
  if (data.title) h += textHeight(data.title, TITLE * u, g.boxW, 1.2) + 28 * u;
  const heights = data.items.map((it) => 2 * PAD * u + textHeight(it.heading, HEADING * u, itemW, 1.25) + (it.text ? 8 * u + textHeight(it.text, TEXT * u, itemW, 1.45) : 0));
  const rows = Math.ceil(heights.length / cols);
  for (let r = 0; r < rows; r++) h += Math.max(...heights.slice(r * cols, r * cols + cols)) + (r > 0 ? GAP * u : 0);
  if (data.footer) h += 28 * u + textHeight(data.footer, FOOTER * u, g.boxW, 1.3);
  return h;
}

export function markup(data: Data, g: Geometry): string {
  const cols = columns(data, g);
  const head =
    (data.kicker ? `<div class="dc-kicker">${esc(data.kicker)}</div>` : "") + (data.title ? `<h2 class="dc-title">${esc(data.title)}</h2>` : "");
  const items = data.items
    .map(
      (it) =>
        `<li class="dc-item"><span class="dc-mark"></span><div class="dc-body"><strong class="dc-heading">${esc(it.heading)}</strong>` +
        `${it.text ? `<p class="dc-text">${esc(it.text)}</p>` : ""}</div></li>`,
    )
    .join("");
  return `${head}<ul class="dc-items" data-cols="${cols}">${items}</ul>${data.footer ? `<div class="dc-footer">${esc(data.footer)}</div>` : ""}`;
}
