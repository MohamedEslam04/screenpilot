import type { Motion } from "../storyboard/schema.js";
import type { RenderPlan, TextItem } from "./plan.js";

// Pure: RenderPlan -> HyperFrames index.html. Overlays that must track the
// recording (ripples, highlights, callouts) live inside #cam so they follow
// zooms; captions and subtitles live on the stage so they stay readable.
// #frame is an untimed container: only the <video> carries data-start, since
// HyperFrames resolves video frames from the video's own timing.

const COMPOSITION_ID = "main";
const BASE_FONTS = ["Cairo:wght@500;700;800", "Inter:wght@500;600;800"];

/** Google Fonts css2 URL for the default fonts plus the storyboard's own. */
export function fontsUrl(extra: string[] = []): string {
  const families = [...new Set([...BASE_FONTS, ...extra])].map((f) => `family=${encodeURIComponent(f.trim()).replace(/%20/g, "+").replace(/%3A/gi, ":").replace(/%40/g, "@").replace(/%3B/gi, ";").replace(/%2C/gi, ",")}`);
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => String(Math.round(v * 1000) / 1000);
const timed = (start: number, end: number) => `data-start="${n(start)}" data-duration="${n(Math.max(0.04, end - start))}"`;
const mediaStart = (s?: number) => (s ? ` data-media-start="${n(s)}"` : "");

export function renderHtml(plan: RenderPlan, opts: { gsapSrc: string }): string {
  const { width: W, height: H, frame, theme, cam } = plan;
  const subtitleBottom = H - (frame.top + frame.h) + Math.round(H * 0.045);
  const els: string[] = [];
  const camEls: string[] = [];
  const js: string[] = [];

  // Cards
  plan.cards.forEach((c, i) => {
    const end = c.start + c.dur;
    els.push(
      `<div id="card${i}" class="clip card" ${timed(c.start, end)}><div class="card-inner">` +
        `<h1 dir="auto">${cardText(c.title, theme.motion.cards?.in)}</h1>${c.subtitle ? `<p dir="auto">${cardText(c.subtitle, theme.motion.cards?.in)}</p>` : ""}</div></div>`,
    );
    if (c.fadeIn > 0) js.push(`tl.fromTo("#card${i}", { opacity: 0 }, { opacity: 1, duration: ${n(c.fadeIn)} }, ${n(c.start)});`);
    const cm = theme.motion.cards;
    if (cm?.in) {
      // The agent's motion: title, then the subtitle a beat later; the card itself fades out.
      const t0 = c.start + c.fadeIn + 0.1;
      js.push(...motionJs(`#card${i} h1`, { ...cm, out: "none" }, t0, end, "text", c.title));
      if (c.subtitle) js.push(...motionJs(`#card${i} p`, { ...cm, out: "none" }, t0 + 0.25, end, "text", c.subtitle));
    } else {
      js.push(
        `tl.fromTo("#card${i} h1", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, ${n(c.start + c.fadeIn + 0.1)});`,
      );
      if (c.subtitle) {
        js.push(
          `tl.fromTo("#card${i} p", { opacity: 0, y: 24 }, { opacity: 0.85, y: 0, duration: 0.6, ease: "power3.out" }, ${n(c.start + c.fadeIn + 0.35)});`,
        );
      }
    }
    if (i === 0 && c.start === 0 && plan.video.start > 0) {
      js.push(`tl.to("#card${i}", { opacity: 0, duration: 0.4 }, ${n(end - 0.4)});`);
    }
    if (c.fadeOut) js.push(`tl.to("#card${i}", { opacity: 0, duration: ${n(c.fadeOut)} }, ${n(end - c.fadeOut)});`);
  });

  // Overlays: an untimed box carries the motion; the timed media inside shows only while it plays.
  const overlayEls: string[] = [];
  plan.overlays.forEach((o, i) => {
    const box = `left:${n(o.x * W)}px;top:${n(o.y * H)}px;width:${n(o.w * W)}px;height:${n(o.h * H)}px`;
    const look =
      `object-fit:${o.fit};opacity:${n(o.opacity)};` +
      `${o.radius ? `border-radius:${n(o.radius)}px;` : ""}${o.shadow ? "box-shadow:0 12px 40px rgba(0,0,0,.45);" : ""}`;
    const media = o.clips.map((c, k) => {
      const attrs = `id="ov${i}m${k}" class="clip ov-media" ${timed(c.start, c.start + c.duration)} src="${esc(o.src)}"`;
      return o.kind === "video" ? `<video ${attrs} muted playsinline style="${look}"></video>` : `<img ${attrs} alt="" style="${look}" />`;
    });
    overlayEls.push(`<div id="ov${i}" class="ov" style="${box}">${media.join("")}</div>`);
    // words/lines/wipe need text markup; an overlay fades instead.
    const m = { in: "fade", out: "fade", ...o.motion } as Motion;
    if (m.in === "words" || m.in === "lines" || m.in === "wipe") m.in = "fade";
    if (m.out === "words" || m.out === "lines" || m.out === "wipe") m.out = "fade";
    js.push(...motionJs(`#ov${i}`, m, o.start, o.end, "text", ""));
  });

  // Ripples
  plan.ripples.forEach((r, i) => {
    camEls.push(
      `<div id="rp${i}" class="clip ripple" ${timed(r.t, r.t + 0.7)} style="left:${n(r.x * cam.w)}px;top:${n(r.y * cam.h)}px"></div>`,
    );
    js.push(
      `tl.fromTo("#rp${i}", { scale: 0.2, opacity: 0.95 }, { scale: 1.7, opacity: 0, duration: 0.65, ease: "power2.out" }, ${n(r.t)});`,
    );
  });

  // Highlights (spotlight box)
  plan.highlights.forEach((h, i) => {
    const style = `left:${n(h.x * cam.w)}px;top:${n(h.y * cam.h)}px;width:${n(h.w * cam.w)}px;height:${n(h.h * cam.h)}px`;
    camEls.push(
      `<div id="hl${i}" class="clip hl" ${timed(h.start, h.end)} style="${style}">` +
        `${h.label ? `<span dir="auto">${esc(h.label)}</span>` : ""}</div>`,
    );
    js.push(`tl.fromTo("#hl${i}", { opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1, duration: 0.35, ease: "power2.out" }, ${n(h.start)});`);
    js.push(`tl.to("#hl${i}", { opacity: 0, duration: 0.3 }, ${n(Math.max(h.start + 0.35, h.end - 0.3))});`);
  });

  // Texts
  const subtitles = plan.texts.filter((t) => t.style === "subtitle");
  plan.texts.forEach((t, i) => {
    const id = `tx${i}`;
    const motion = { ...theme.motion.captions, ...t.motion };
    const inner = textMarkup(t.text, motion.in === "words");
    if (t.style === "callout") {
      const x = (t.x ?? 0.5) * cam.w;
      const y = (t.y ?? 0.5) * cam.h;
      const below = (t.y ?? 0.5) < 0.3;
      camEls.push(
        `<div id="${id}" class="clip callout ${below ? "below" : "above"}" ${timed(t.start, t.end)} style="left:${n(x)}px;top:${n(y)}px">${inner}</div>`,
      );
    } else {
      els.push(`<div id="${id}" class="clip text ${t.style} ${placement(t, subtitles)}" ${timed(t.start, t.end)}>${inner}</div>`);
    }
    js.push(...motionJs(`#${id}`, motion, t.start, t.end, t.style === "title" ? "title" : "text", t.text));
  });

  // Camera
  for (const c of plan.camera) {
    if (c.dur === 0) {
      js.push(`tl.set("#cam", { x: ${n(c.x)}, y: ${n(c.y)}, scale: ${n(c.scale)} }, ${n(c.t)});`);
      continue;
    }
    js.push(
      `tl.to("#cam", { x: ${n(c.x)}, y: ${n(c.y)}, scale: ${n(c.scale)}, duration: ${n(c.dur)}, ease: "power2.inOut" }, ${n(c.t)});`,
    );
  }

  // Frame entrance after an intro card
  if (plan.video.start > 0) {
    js.unshift(
      `tl.fromTo("#frame", { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.6, ease: "power3.out" }, ${n(plan.video.start)});`,
    );
  }

  // Music ducking: HyperFrames samples an audio element's volume from the timeline.
  plan.audio.forEach((a, i) => {
    for (const d of a.duck ?? []) {
      js.push(
        `tl.fromTo("#au${i}", { volume: ${n(d.from)} }, { volume: ${n(d.to)}, duration: ${n(d.dur)}, ease: "none", immediateRender: false }, ${n(d.t)});`,
      );
    }
  });

  const audioEls = plan.audio.map(
    (a, i) =>
      `<audio id="au${i}" ${timed(a.start, a.start + a.duration)} data-volume="${n(a.volume)}"${mediaStart(a.mediaStart)}` +
      `${a.fadeIn ? ` data-fade-in="${n(a.fadeIn)}"` : ""}${a.fadeOut ? ` data-fade-out="${n(a.fadeOut)}"` : ""} src="${esc(a.src)}"></audio>`,
  );

  const v = plan.video;
  const videoAttrs = v.hasAudio ? `data-has-audio="true"` : "muted";
  const videoEnd = v.start + v.duration;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<link rel="stylesheet" href="${esc(fontsUrl(theme.fonts))}" />
<script src="${esc(opts.gsapSrc)}"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${theme.background}; font-family: ${theme.font}; }
#frame { position: absolute; left: ${frame.left}px; top: ${frame.top}px; width: ${frame.w}px; height: ${frame.h}px;
  border-radius: ${theme.padding > 0 ? theme.radius : 0}px; overflow: hidden; background: #000;
  ${theme.shadow && theme.padding > 0 ? "box-shadow: 0 40px 100px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08);" : ""} }
#cam { position: absolute; left: 0; top: 0; width: ${n(cam.w)}px; height: ${n(cam.h)}px; transform-origin: 0 0; }
#cam video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; display: block; }
.ripple { position: absolute; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
  border: 5px solid ${theme.accent}; box-shadow: 0 0 18px ${theme.accent}; pointer-events: none; }
.hl { position: absolute; border: 4px solid ${theme.accent}; border-radius: 12px; box-shadow: 0 0 0 9999px rgba(2,6,23,.45); }
.hl span { position: absolute; left: -4px; bottom: calc(100% + 10px); white-space: nowrap; background: ${theme.accent};
  color: #111; font-weight: 700; font-size: 26px; padding: 6px 14px; border-radius: 10px; }
.callout { position: absolute; transform-origin: 50% 100%; }
.callout span { position: absolute; left: 0; transform: translateX(-50%); white-space: nowrap; background: ${theme.accent};
  color: #111; font-weight: 800; font-size: 30px; padding: 10px 18px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
.callout.above span { bottom: 22px; }
.callout.below span { top: 22px; }
.text { position: absolute; left: 0; right: 0; text-align: center; }
.text > span { display: inline-block; max-width: ${Math.round(W * 0.8)}px; }
.text .ln { display: block; }
.text .w, .callout .w, .card .w { display: inline-block; }
/* Gradient text (background-clip: text) on a title must reach words that animate on their own. */
.card .w { background: inherit; -webkit-background-clip: inherit; background-clip: inherit; -webkit-text-fill-color: inherit; }
.text.pill > span, .text.subtitle > span { color: ${theme.captionColor}; background: ${theme.captionBackground};
  padding: 14px 30px; border-radius: 16px; font-weight: 700; line-height: 1.35; }
.text.pill > span { font-size: 44px; }
.text.subtitle > span { font-size: 38px; font-weight: 600; }
.text.title > span { color: #fff; font-size: 84px; font-weight: 800; letter-spacing: -0.02em; text-shadow: 0 8px 40px rgba(0,0,0,.55); }
.pos-bottom { bottom: ${subtitleBottom}px; }
.pos-bottom-raised { bottom: ${subtitleBottom + 110}px; }
.pos-top { top: ${frame.top + Math.round(H * 0.045)}px; }
.pos-center { top: 50%; margin-top: -60px; }
.ov { position: absolute; }
.ov-media { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.card { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: ${theme.background}; }
.card-inner { text-align: center; color: #fff; padding: 0 8%; }
.card h1 { font-size: 104px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; }
.card p { margin-top: 28px; font-size: 44px; font-weight: 500; }
</style>
${theme.css.trim() ? `<style id="theme-css">\n${theme.css.replace(/<\/style/gi, "<\\/style")}\n</style>` : ""}
</head>
<body>
<div id="root" data-composition-id="${COMPOSITION_ID}" data-start="0" data-duration="${n(plan.duration)}" data-width="${W}" data-height="${H}" data-fps="${plan.fps}">
<div id="frame">
<div id="cam">
<video id="rec" class="clip" ${timed(v.start, videoEnd)}${mediaStart(v.mediaStart)} src="${esc(v.src)}" ${videoAttrs} playsinline></video>
${camEls.join("\n")}
</div>
</div>
${overlayEls.join("\n")}
${els.join("\n")}
${audioEls.join("\n")}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${js.join("\n")}
window.__timelines = window.__timelines || {};
window.__timelines["${COMPOSITION_ID}"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;
}

function placement(t: TextItem, subtitles: TextItem[]): string {
  if (t.position === "top") return "pos-top";
  if (t.position === "center" || t.style === "title") return "pos-center";
  if (t.style === "subtitle") return "pos-bottom";
  const clashes = subtitles.some((s) => s.start < t.end && t.start < s.end);
  return clashes ? "pos-bottom-raised" : "pos-bottom";
}

// --- Text motion: presets the agent picks per caption or in theme.motion ---

const ARABIC = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LATIN = /[A-Za-z\u00c0-\u024f]/;
const rtl = (text: string) => {
  for (const ch of text) {
    if (ARABIC.test(ch)) return true;
    if (LATIN.test(ch)) return false;
  }
  return false;
};

/** Card title/subtitle: plain, or one .w per word for word-by-word motion; wipe needs an inner span. */
function cardText(text: string, preset: string | undefined): string {
  if (preset === "words") return wordSpans(text);
  if (preset === "wipe") return `<span style="display:inline-block">${esc(text)}</span>`;
  return esc(text);
}

/** Caption markup: one .ln per "\n" line (own direction), words in .w spans for word-by-word motion. */
export function textMarkup(text: string, words: boolean): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const line = (l: string) => (words ? wordSpans(l) : esc(l));
  if (lines.length > 1) return `<span>${lines.map((l) => `<span class="ln" dir="auto">${line(l)}</span>`).join("")}</span>`;
  return `<span dir="auto">${line(text)}</span>`;
}

/**
 * Words as inline blocks. Inline blocks are laid out in the line's direction, so a
 * run of the other script ("API key" inside Arabic) stays one block to keep its order.
 */
function wordSpans(line: string): string {
  const base = rtl(line);
  const tokens = line.split(/(\s+)/).filter((x) => x !== "");
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(`<span class="w">${esc(run.join(""))}</span>`);
    run = [];
  };
  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      if (run.length) run.push(tok);
      else out.push(esc(tok));
      continue;
    }
    const foreign = base ? !ARABIC.test(tok) && LATIN.test(tok) : ARABIC.test(tok);
    if (foreign) {
      run.push(tok);
      continue;
    }
    if (run.length) {
      // trailing spaces of the run go back outside it
      const trail: string[] = [];
      while (run.length && /^\s+$/.test(run[run.length - 1]!)) trail.unshift(run.pop()!);
      flush();
      out.push(...trail.map(esc));
    }
    out.push(`<span class="w">${esc(tok)}</span>`);
  }
  flush();
  return out.join("");
}

const FROM: Record<string, string> = {
  fade: "opacity: 0",
  rise: "opacity: 0, y: 28",
  drop: "opacity: 0, y: -28",
  "slide-left": "opacity: 0, x: -90",
  "slide-right": "opacity: 0, x: 90",
  pop: "opacity: 0, scale: 0.6",
  zoom: "opacity: 0, scale: 1.3",
  blur: 'opacity: 0, filter: "blur(14px)"',
};
const OUT: Record<string, string> = {
  fade: "opacity: 0",
  rise: "opacity: 0, y: -20",
  drop: "opacity: 0, y: 20",
  "slide-left": "opacity: 0, x: -90",
  "slide-right": "opacity: 0, x: 90",
  pop: "opacity: 0, scale: 0.6",
  zoom: "opacity: 0, scale: 1.2",
  blur: 'opacity: 0, filter: "blur(14px)"',
};
const REST: Record<string, string> = {
  fade: "opacity: 1",
  rise: "opacity: 1, y: 0",
  drop: "opacity: 1, y: 0",
  "slide-left": "opacity: 1, x: 0",
  "slide-right": "opacity: 1, x: 0",
  pop: "opacity: 1, scale: 1",
  zoom: "opacity: 1, scale: 1",
  blur: 'opacity: 1, filter: "blur(0px)"',
};

/**
 * GSAP tweens for one text element. Without a motion it keeps the original look:
 * captions rise 18px, titles scale from 0.92, both fade out over 0.25s.
 */
export function motionJs(sel: string, m: Motion, start: number, end: number, kind: "text" | "title", text: string): string[] {
  const js: string[] = [];
  const dur = m.duration ?? 0.3;
  const inPreset = m.in ?? (kind === "title" ? "title" : "caption");
  const ease = m.ease ?? (inPreset === "pop" ? "back.out(1.7)" : "power2.out");
  const at = n(start);
  const q = (x: string) => JSON.stringify(x);
  switch (inPreset) {
    case "none":
      break;
    case "caption":
      js.push(`tl.fromTo("${sel}", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: ${n(dur)}, ease: ${q(ease)} }, ${at});`);
      break;
    case "title":
      js.push(`tl.fromTo("${sel}", { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: ${n(dur)}, ease: ${q(ease)} }, ${at});`);
      break;
    case "wipe": {
      const from = rtl(text) ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)";
      js.push(`tl.fromTo("${sel} > span", { clipPath: "${from}" }, { clipPath: "inset(0 0% 0 0%)", duration: ${n(Math.max(dur, 0.5))}, ease: ${q(m.ease ?? "power2.inOut")} }, ${at});`);
      break;
    }
    case "words":
    case "lines": {
      const parts = inPreset === "words" ? `${sel} .w` : `${sel} .ln`;
      js.push(
        `tl.fromTo("${parts}", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: ${n(dur)}, ease: ${q(ease)}, stagger: ${n(m.stagger ?? (inPreset === "words" ? 0.08 : 0.18))} }, ${at});`,
      );
      break;
    }
    default:
      js.push(`tl.fromTo("${sel}", { ${FROM[inPreset]} }, { ${REST[inPreset]}, duration: ${n(dur)}, ease: ${q(ease)} }, ${at});`);
  }
  const outPreset = m.out ?? "fade";
  if (outPreset !== "none") {
    const outDur = 0.25;
    const t = n(Math.max(start + dur, end - outDur));
    if (outPreset === "wipe") {
      const to = rtl(text) ? "inset(0 100% 0 0)" : "inset(0 0 0 100%)";
      js.push(`tl.to("${sel} > span", { clipPath: "${to}", duration: ${n(outDur)}, ease: "power2.in" }, ${t});`);
    } else {
      js.push(`tl.to("${sel}", { ${OUT[outPreset] ?? OUT.fade}, duration: ${n(outDur)} }, ${t});`);
    }
  }
  return js;
}
