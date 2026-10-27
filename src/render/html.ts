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
        `<h1 dir="auto">${esc(c.title)}</h1>${c.subtitle ? `<p dir="auto">${esc(c.subtitle)}</p>` : ""}</div></div>`,
    );
    if (c.fadeIn > 0) js.push(`tl.fromTo("#card${i}", { opacity: 0 }, { opacity: 1, duration: ${n(c.fadeIn)} }, ${n(c.start)});`);
    js.push(
      `tl.fromTo("#card${i} h1", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, ${n(c.start + c.fadeIn + 0.1)});`,
    );
    if (c.subtitle) {
      js.push(
        `tl.fromTo("#card${i} p", { opacity: 0, y: 24 }, { opacity: 0.85, y: 0, duration: 0.6, ease: "power3.out" }, ${n(c.start + c.fadeIn + 0.35)});`,
      );
    }
    if (i === 0 && c.start === 0 && plan.video.start > 0) {
      js.push(`tl.to("#card${i}", { opacity: 0, duration: 0.4 }, ${n(end - 0.4)});`);
    }
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
    // One line per "\n", each with its own direction, so "English\nعربي" reads right in both.
    const lines = t.text.split("\n").filter((l) => l.trim());
    const inner =
      lines.length > 1 ? `<span>${lines.map((l) => `<span class="ln" dir="auto">${esc(l)}</span>`).join("")}</span>` : `<span dir="auto">${esc(t.text)}</span>`;
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
    const from = t.style === "title" ? "{ opacity: 0, scale: 0.92 }" : "{ opacity: 0, y: 18 }";
    const to = t.style === "title" ? "{ opacity: 1, scale: 1" : "{ opacity: 1, y: 0";
    js.push(`tl.fromTo("#${id}", ${from}, ${to}, duration: 0.3, ease: "power2.out" }, ${n(t.start)});`);
    js.push(`tl.to("#${id}", { opacity: 0, duration: 0.25 }, ${n(Math.max(t.start + 0.3, t.end - 0.25))});`);
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

  const audioEls = plan.audio.map(
    (a, i) =>
      `<audio id="au${i}" ${timed(a.start, a.start + a.duration)} data-volume="${n(a.volume)}"` +
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
.text.pill > span, .text.subtitle > span { color: ${theme.captionColor}; background: ${theme.captionBackground};
  padding: 14px 30px; border-radius: 16px; font-weight: 700; line-height: 1.35; }
.text.pill > span { font-size: 44px; }
.text.subtitle > span { font-size: 38px; font-weight: 600; }
.text.title > span { color: #fff; font-size: 84px; font-weight: 800; letter-spacing: -0.02em; text-shadow: 0 8px 40px rgba(0,0,0,.55); }
.pos-bottom { bottom: ${subtitleBottom}px; }
.pos-bottom-raised { bottom: ${subtitleBottom + 110}px; }
.pos-top { top: ${frame.top + Math.round(H * 0.045)}px; }
.pos-center { top: 50%; margin-top: -60px; }
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
<video id="rec" class="clip" ${timed(v.start, videoEnd)} src="${esc(v.src)}" ${videoAttrs} playsinline></video>
${camEls.join("\n")}
</div>
</div>
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
