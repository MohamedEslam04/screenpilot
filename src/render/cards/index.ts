import type { CardContent, Theme } from "../../storyboard/schema.js";
import { cardDirection, esc, geometry, n, type Geometry } from "./common.js";
import * as flow from "./flow.js";
import * as list from "./list.js";
import * as number from "./number.js";
import * as quote from "./quote.js";

// Data cards (overlay kind "card"): JSON data in, an HTML block out, drawn by the same page that draws
// captions. Everything here is pure, so the layout is tested without a browser (test/card-overlays.test.ts).
// Direction comes from the text (see cardDirection), never from a constant, and text wraps inside its box.

export { cardDirection } from "./common.js";

export interface DataCardLike {
  id?: string;
  start: number;
  end: number;
  dir: "ltr" | "rtl";
  lang?: string;
}

/** Every string a card shows, for finding its reading direction. */
export function cardTexts(card: CardContent): string[] {
  switch (card.template) {
    case "list":
      return [card.data.kicker, card.data.title, card.data.footer, ...card.data.items.flatMap((i) => [i.heading, i.text])].filter((x): x is string => !!x);
    case "flow":
      return [card.data.kicker, card.data.title, card.data.footer, ...card.data.steps.flatMap((i) => [i.label, i.text])].filter((x): x is string => !!x);
    case "number":
      return [card.data.kicker, String(card.data.value), card.data.label, card.data.footer].filter((x): x is string => !!x);
    case "quote":
      return [card.data.kicker, card.data.text, card.data.author, card.data.role].filter((x): x is string => !!x);
  }
}

const FLOOR = 0.4;
const STEP = 0.05;

/**
 * The largest scale (1 down to 0.4, in steps of 0.05) at which the card's text is estimated to fit the frame.
 * The estimate is deliberately wide (CHAR_EM), so a card errs towards smaller text instead of overflowing;
 * css wraps every word anywhere it must, so width never overflows whatever the estimate says.
 */
export function fitScale(card: CardContent, size: { width: number; height: number }): number {
  const g = geometry(size);
  for (let s = 1; s > FLOOR + 1e-9; s -= STEP) {
    const scale = Math.round(s * 100) / 100;
    if (measureCard(card, g, scale) <= g.boxH) return scale;
  }
  return FLOOR;
}

function measureCard(card: CardContent, g: Geometry, s: number): number {
  switch (card.template) {
    case "list":
      return list.measure(card.data, g, s);
    case "flow":
      return flow.measure(card.data, g, s);
    case "number":
      return number.measure(card.data, g, s);
    case "quote":
      return quote.measure(card.data, g, s);
  }
}

function markup(card: CardContent, g: Geometry): string {
  switch (card.template) {
    case "list":
      return list.markup(card.data, g);
    case "flow":
      return flow.markup(card.data, g);
    case "number":
      return number.markup(card.data, g);
    case "quote":
      return quote.markup(card.data);
  }
}

/** The card's element. `attrs` is the timing (data-start, data-duration) the page needs on every timed element. */
export function renderCard(card: CardContent & DataCardLike, i: number, size: { width: number; height: number }, attrs: string): string {
  const g = geometry(size);
  const lang = card.lang ? ` lang="${esc(card.lang)}"` : "";
  return (
    `<div id="dc${i}" class="clip dc dc-${card.template}" ${attrs} dir="${card.dir}"${lang} style="--fs:${n(fitScale(card, size))}">` +
    `<div class="dc-box">${markup(card, g)}</div></div>`
  );
}

/** Selector of the parts that come in one after another (the items of a list, the steps and arrows of a flow); none for the others. */
export function sequenceSelector(card: CardContent, i: number): string | undefined {
  if (card.template === "list") return `#dc${i} .dc-item`;
  if (card.template === "flow") return `#dc${i} .dc-step, #dc${i} .dc-arrow`;
  return undefined;
}

/** The card stylesheet: colors, font and background come from the theme; sizes from the frame. Written only when a plan has a card. */
export function cardCss(theme: Theme, size: { width: number; height: number }): string {
  const g = geometry(size);
  const { u } = g;
  const s = (px: number) => `calc(${n(px * u)}px * var(--fs))`;
  const padX = Math.round(size.width * 0.04);
  const padY = Math.round(size.height * 0.05);
  return `
.dc { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: ${padY}px ${padX}px;
  background: ${theme.background}; color: ${theme.captionColor}; font-family: ${theme.font}; text-align: start; --fs: 1; }
.dc * { min-width: 0; overflow-wrap: anywhere; word-break: normal; hyphens: manual; }
.dc-box { display: flex; flex-direction: column; width: 100%; max-width: ${n(g.boxW)}px; max-height: 100%; gap: ${s(20)}; }
.dc-kicker { color: ${theme.accent}; font-size: ${s(30)}; font-weight: 700; line-height: 1.3; }
.dc-title { font-size: ${s(72)}; font-weight: 800; line-height: 1.2; }
.dc-footer { margin-top: ${s(8)}; font-size: ${s(28)}; line-height: 1.3; opacity: 0.7; }
.dc-heading { display: block; font-weight: 700; line-height: 1.25; }
.dc-text { margin-top: ${s(8)}; line-height: 1.45; opacity: 0.86; }
.dc-items { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr); gap: ${s(20)}; }
.dc-items[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dc-item, .dc-step { min-width: 0; background: ${theme.captionBackground}; border-radius: ${s(20)}; padding: ${s(22)}; }
.dc-item { display: flex; align-items: flex-start; gap: ${s(22)}; }
.dc-item .dc-heading { font-size: ${s(44)}; }
.dc-item .dc-text { font-size: ${s(32)}; }
.dc-mark { flex: none; width: ${s(14)}; height: ${s(14)}; margin-top: ${s(17)}; border-radius: 50%; background: ${theme.accent}; }
.dc-body { flex: 1 1 0; }
.dc-steps { display: flex; gap: 0; }
.dc-steps[data-layout="row"] { flex-direction: row; align-items: stretch; }
.dc-steps[data-layout="column"] { flex-direction: column; align-items: stretch; }
.dc-step { flex: 1 1 0; padding: ${s(26)}; border: ${s(3)} solid ${theme.accent}; }
.dc-step .dc-heading { font-size: ${s(42)}; }
.dc-step .dc-text { font-size: ${s(30)}; }
.dc-arrow { flex: none; align-self: center; width: ${s(64)}; height: ${s(64)}; padding: ${s(14)}; color: ${theme.accent}; }
.dc[dir="rtl"] .dc-steps[data-layout="row"] .dc-arrow svg { transform: scaleX(-1); }
.dc-steps[data-layout="column"] .dc-arrow svg { transform: rotate(90deg); }
.dc-number .dc-box, .dc-number .dc-box > * { text-align: center; }
.dc-number .dc-box { align-items: center; }
.dc-value { color: ${theme.accent}; font-weight: 800; line-height: 1.1; max-width: 100%; }
.dc-label { font-size: ${s(56)}; font-weight: 700; line-height: 1.3; }
.dc-quote { border-inline-start: ${s(10)} solid ${theme.accent}; padding-inline-start: ${s(36)}; }
.dc-quote-text { font-size: ${s(64)}; font-weight: 700; line-height: 1.4; }
.dc-author { margin-top: ${s(28)}; color: ${theme.accent}; font-size: ${s(38)}; font-weight: 700; line-height: 1.3; }
.dc-role { margin-top: ${s(6)}; font-size: ${s(28)}; line-height: 1.3; opacity: 0.75; }
`;
}
