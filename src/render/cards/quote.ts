import type { z } from "zod";
import type { QuoteCardDataSchema } from "../../storyboard/schema.js";
import { esc, type Geometry, textHeight } from "./common.js";

type Data = z.output<typeof QuoteCardDataSchema>;

const KICKER = 30;
const QUOTE = 64;
const AUTHOR = 38;
const ROLE = 28;
const BAR = 10;
const BAR_GAP = 36;

export function measure(data: Data, g: Geometry, s: number): number {
  const u = g.u * s;
  const w = g.boxW - (BAR + BAR_GAP) * u;
  let h = textHeight(data.text, QUOTE * u, w, 1.4);
  if (data.kicker) h += textHeight(data.kicker, KICKER * u, g.boxW, 1.3) + 16 * u;
  if (data.author) h += 28 * u + textHeight(data.author, AUTHOR * u, w, 1.3);
  if (data.role) h += 6 * u + textHeight(data.role, ROLE * u, w, 1.3);
  return h;
}

export function markup(data: Data): string {
  return (
    `${data.kicker ? `<div class="dc-kicker">${esc(data.kicker)}</div>` : ""}` +
    `<blockquote class="dc-quote"><p class="dc-quote-text">${esc(data.text)}</p>` +
    `${data.author ? `<footer class="dc-author">${esc(data.author)}</footer>` : ""}${data.role ? `<div class="dc-role">${esc(data.role)}</div>` : ""}</blockquote>`
  );
}
