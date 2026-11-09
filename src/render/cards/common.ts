// Shared by the card templates: escaping, reading direction, and the box the text has to fit.
// Pure: nothing here touches the page, so the layout is testable without a browser.

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** The output frame and the box a card lays its text in. All template sizes are written for a 1080 px short side (u = 1). */
export interface Geometry {
  width: number;
  height: number;
  /** Short side / 1080: scales every size so 16:9, 9:16 and 1:1 read alike. */
  u: number;
  /** Width the content may use (px). */
  boxW: number;
  /** Height the content may use (px). */
  boxH: number;
  /** A frame wider than tall: lists use two columns, flows run in a row. */
  wide: boolean;
}

export function geometry(size: { width: number; height: number }): Geometry {
  const { width, height } = size;
  const u = Math.min(width, height) / 1080;
  return { width, height, u, boxW: Math.min(width * 0.84, 1400 * u), boxH: height * 0.86, wide: width >= height * 1.2 };
}

/** Em per character that holds for Arabic (Cairo) and Latin (Inter) alike; a little wide on purpose, so an estimate errs towards smaller text. */
export const CHAR_EM = 0.62;
const WRAP_SLACK = 0.9;

/** Height of text of `px` size that wraps inside `width` (lines of a paragraph break at word ends, so a line holds a little less). */
export function textHeight(text: string | undefined, px: number, width: number, lineHeight: number): number {
  if (!text) return 0;
  const perLine = Math.max(1, Math.floor((width / (px * CHAR_EM)) * WRAP_SLACK));
  let lines = 0;
  for (const para of text.split("\n")) lines += Math.max(1, Math.ceil([...para].length / perLine));
  return lines * px * lineHeight;
}

const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LATIN = /[A-Za-zÀ-ɏ]/;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const HEBREW = /[֐-׿יִ-ﭏ]/;
const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "iw"]);

const primary = (lang: string) => lang.toLowerCase().split(/[-_]/)[0]!;

/**
 * Reading direction and language of a card. No direction is hard-coded: an explicit `lang` wins,
 * then the script the text is written in (Arabic and Hebrew count as right to left, and the
 * script with more words wins, so "API" or a long URL inside an Arabic card does not flip it), then the
 * language of the voice for text without letters ("42%").
 */
export function cardDirection(texts: string[], opts: { lang?: string; voiceLang?: string } = {}): { dir: "ltr" | "rtl"; lang?: string } {
  if (opts.lang) return { dir: RTL_LANGS.has(primary(opts.lang)) ? "rtl" : "ltr", lang: opts.lang };
  // Count words, not letters: one long URL or product name must not outvote a sentence of Arabic.
  let rtl = 0;
  let latin = 0;
  let arabic = 0;
  let hebrew = 0;
  for (const word of texts.join(" ").split(/\s+/)) {
    for (const ch of word) {
      if (RTL_SCRIPT.test(ch)) {
        rtl++;
        if (ARABIC.test(ch)) arabic++;
        else if (HEBREW.test(ch)) hebrew++;
        break;
      }
      if (LATIN.test(ch)) {
        latin++;
        break;
      }
    }
  }
  if (rtl > 0 && rtl >= latin) return { dir: "rtl", lang: hebrew > arabic ? "he" : "ar" };
  if (latin > 0) return { dir: "ltr" };
  if (opts.voiceLang) return { dir: RTL_LANGS.has(primary(opts.voiceLang)) ? "rtl" : "ltr", lang: opts.voiceLang };
  return { dir: "ltr" };
}

/** `calc(Npx * var(--fs))`: a size of the template, scaled to the frame (u) and to the fit of this card (--fs). */
export const sz = (px: number, u: number) => `calc(${n(px * u)}px * var(--fs))`;
