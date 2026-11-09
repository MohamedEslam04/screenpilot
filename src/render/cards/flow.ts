import type { z } from "zod";
import type { FlowCardDataSchema } from "../../storyboard/schema.js";
import { esc, type Geometry, textHeight } from "./common.js";

type Data = z.output<typeof FlowCardDataSchema>;

const KICKER = 30;
const TITLE = 72;
const LABEL = 42;
const TEXT = 30;
const FOOTER = 28;
const PAD = 26;
const ARROW = 64;

/** A wide frame with a few steps lays them out in a row; anything else stacks them top to bottom. */
export const isRow = (data: Data, g: Geometry) => g.wide && data.steps.length <= 4;

export function measure(data: Data, g: Geometry, s: number): number {
  const u = g.u * s;
  const row = isRow(data, g);
  const count = data.steps.length;
  const stepW = row ? (g.boxW - (count - 1) * ARROW * u) / count - 2 * PAD * u : g.boxW - 2 * PAD * u;
  const heights = data.steps.map((st) => 2 * PAD * u + textHeight(st.label, LABEL * u, stepW, 1.25) + (st.text ? 8 * u + textHeight(st.text, TEXT * u, stepW, 1.4) : 0));
  let h = 0;
  if (data.kicker) h += textHeight(data.kicker, KICKER * u, g.boxW, 1.3) + 10 * u;
  if (data.title) h += textHeight(data.title, TITLE * u, g.boxW, 1.2) + 28 * u;
  h += row ? Math.max(...heights) : heights.reduce((a, b) => a + b, 0) + (count - 1) * ARROW * u;
  if (data.footer) h += 28 * u + textHeight(data.footer, FOOTER * u, g.boxW, 1.3);
  return h;
}

// A chevron that points to the right; the css turns it to follow the reading direction (mirrored in rtl, down in a column).
const CHEVRON = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path d="M8 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function markup(data: Data, g: Geometry): string {
  const head =
    (data.kicker ? `<div class="dc-kicker">${esc(data.kicker)}</div>` : "") + (data.title ? `<h2 class="dc-title">${esc(data.title)}</h2>` : "");
  const steps = data.steps
    .map((st, i) => {
      const step = `<div class="dc-step"><strong class="dc-heading">${esc(st.label)}</strong>${st.text ? `<p class="dc-text">${esc(st.text)}</p>` : ""}</div>`;
      return i < data.steps.length - 1 ? `${step}<span class="dc-arrow" aria-hidden="true">${CHEVRON}</span>` : step;
    })
    .join("");
  return `${head}<div class="dc-steps" data-layout="${isRow(data, g) ? "row" : "column"}">${steps}</div>${data.footer ? `<div class="dc-footer">${esc(data.footer)}</div>` : ""}`;
}
