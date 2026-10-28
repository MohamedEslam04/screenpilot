/* The hero editor: a real storyboard running live. Source seconds are drawn on the tracks;
   "Edited" applies zooms, captions, highlights and the 8x speed-up, "Raw" plays the footage as recorded. */
(() => {
  const root = document.getElementById("editor");
  if (!root) return;
  const $ = (s, el = root) => el.querySelector(s);
  const W = 1280, H = 720, D = 18;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- the storyboard (same field names as storyboard.json) ----
  const SEG = [{ in: 0, out: 4, speed: 1 }, { in: 4, out: 13, speed: 8 }, { in: 13, out: 18, speed: 1 }];
  const ZOOMS = [
    { at: 1.4, dur: 1.6, cx: 260, cy: 250, scale: 1.9 },
    { at: 3.5, dur: 1.2, cx: 1010, cy: 190, scale: 1.9 },
    { at: 13.5, dur: 2.0, cx: 1000, cy: 560, scale: 1.8 },
  ];
  const CAPS = [
    { at: 0.9, dur: 2.1, en: "Open the reports page", ar: "افتح صفحة التقارير" },
    { at: 3.2, dur: 1.8, en: "Export it as a PDF", ar: "صدّرها بصيغة PDF" },
    { at: 5.2, dur: 7.6, en: "Waiting skipped: 8× faster", ar: "تخطّينا الانتظار: أسرع 8 مرات" },
    { at: 13.3, dur: 2.7, en: "Done. The file is ready.", ar: "تم. الملف جاهز." },
  ];
  const HLS = [
    { at: 1.6, dur: 1.5, r: [12, 230, 176, 46] },
    { at: 3.6, dur: 1.2, r: [1052, 92, 186, 52] },
    { at: 13.4, dur: 2.0, r: [872, 590, 376, 96] },
  ];
  const VOICE = [
    { at: 0.8, dur: 2.2, en: "Let's open the reports page.", ar: "نفتح صفحة التقارير." },
    { at: 3.2, dur: 1.8, en: "Now export it as a PDF.", ar: "الآن نصدّرها بصيغة PDF." },
    { at: 13.2, dur: 2.8, en: "And it's ready.", ar: "وها هي جاهزة." },
  ];
  const PATH = [[0, 700, 420], [1.0, 700, 420], [1.9, 100, 253], [2.6, 100, 253], [3.9, 1145, 118], [12.9, 1145, 118], [14.3, 1182, 638], [14.6, 1182, 638], [17.5, 820, 380], [18, 820, 380]];
  const CLICKS = [[2.0, 100, 253], [4.0, 1145, 118], [14.5, 1182, 638]];

  // ---- state ----
  let lang = root.dataset.lang || "en";
  let mode = "edited";
  let t = reduced ? 3.9 : 0;
  let playing = !reduced;
  let last = 0;
  let hold = 0;
  let visible = true;
  const rel = (v) => (v / D) * 100;
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  const speedAt = (x) => (mode === "edited" ? (SEG.find((s) => x >= s.in && x < s.out) || { speed: 1 }).speed : 1);
  const outTime = (x) => (mode === "raw" ? x : SEG.reduce((a, s) => a + Math.max(0, Math.min(x, s.out) - s.in) / s.speed, 0));
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---- build the stage ----
  const stage = $(".stage");
  stage.innerHTML = `
    <div class="app-side"><div class="app-logo">Northwind</div>
      <div class="app-item" data-i="overview">Overview</div><div class="app-item" data-i="reports">Reports</div>
      <div class="app-item">Customers</div><div class="app-item">Settings</div></div>
    <div class="app-top"><h4 class="vt">Overview</h4><div class="search"></div><div class="av"></div></div>
    <div class="view v-overview">
      <div class="metric" style="left:0"><small>Revenue</small><strong>$48,210</strong></div>
      <div class="metric" style="left:340px"><small>Orders</small><strong>1,284</strong></div>
      <div class="metric" style="left:680px"><small>Customers</small><strong>9,402</strong></div>
      <div class="chart">${[40, 62, 48, 80, 66, 92, 74, 58, 86, 70].map((h) => `<i style="height:${h}%"></i>`).join("")}</div>
    </div>
    <div class="view v-reports">
      <div class="rep-btn">Export PDF</div>
      ${["Q3 revenue", "Orders by region", "Top customers", "Refunds", "Returns", "Shipping times", "Stock levels"].map((n, i) => `<div class="rep-row" style="top:${60 + i * 62}px"><span>${n}</span><span>Updated today</span><span>${(i + 3) * 120} rows</span></div>`).join("")}
    </div>
    <div class="modal"><div class="spin"></div><b>Generating report…</b><div class="bar"><i></i></div></div>
    <div class="toast">Report ready<small>Q3-report.pdf</small><u>Open</u></div>
    <div class="filecard"><b>Q3-report.pdf</b><i></i><i></i><i style="width:70%"></i><i></i><i style="width:55%"></i></div>
    <div class="hl"></div>
    <svg class="curs" viewBox="0 0 18 26"><path d="M0 0V22L6 17L10 26L14 24.2L10 15.5H18Z" fill="#ffc857" stroke="#0b132b" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <div class="ripple"></div>`;
  const vt = $(".vt"), bar = $(".bar i"), hl = $(".hl"), curs = $(".curs"), rip = $(".ripple");
  const items = [...stage.querySelectorAll(".app-item")], repBtn = $(".rep-btn");
  const wrap = $(".stage-wrap"), capEl = $(".cap span"), badge = $(".badge-speed");

  // ---- build the timeline ----
  const JSONS = {};
  const lane = (key) => $(`[data-lane="${key}"]`);
  const add = (key, cls, a, b, label, json) => {
    const el = document.createElement("button");
    el.type = "button"; el.className = `blk ${cls}`; el.style.left = rel(a) + "%"; el.style.width = rel(b - a) + "%";
    el.innerHTML = label; el.dataset.a = a; el.dataset.b = b; el.setAttribute("aria-label", `${key}: ${label.replace(/<[^>]+>/g, "")} (${a}s to ${b}s)`);
    el.dataset.json = json; lane(key).appendChild(el); return el;
  };
  const j = (o) => JSON.stringify(o).replace(/"(\w+)":/g, '"$1": ').replace(/,"/g, ', "');
  const norm = (v, m) => +(v / m).toFixed(2);
  const blocks = { video: [], zoom: [], cap: [], hl: [], voice: [] };
  SEG.forEach((s) => blocks.video.push(add("video", s.speed > 1 ? "k-cut" : "k-clip", s.in, s.out, s.speed > 1 ? `<span data-t="cut"></span>` : "clip", `"segments": [${j({ in: s.in, out: s.out, speed: s.speed })}]`)));
  ZOOMS.forEach((z) => blocks.zoom.push(add("zoom", "k-zoom", z.at - 0.5, z.at + z.dur + 0.5, z.scale + "×", `"zooms": [${j({ at: z.at, dur: z.dur, x: norm(z.cx, W), y: norm(z.cy, H), scale: z.scale })}]`)));
  CAPS.forEach((c) => blocks.cap.push(add("cap", "k-cap", c.at, c.at + c.dur, `<span class="cl" data-en="${c.en}" data-ar="${c.ar}"></span>`, `"captions": [${j({ at: c.at, dur: c.dur, text: c.en, style: "pill" })}]`)));
  HLS.forEach((h) => blocks.hl.push(add("hl", "k-hl", h.at, h.at + h.dur, "ring", `"highlights": [${j({ at: h.at, dur: h.dur, x: norm(h.r[0], W), y: norm(h.r[1], H), w: norm(h.r[2], W), h: norm(h.r[3], H) })}]`)));
  VOICE.forEach((v) => blocks.voice.push(add("voice", "k-voice", v.at, v.at + v.dur, `<span class="vl" data-en="${v.en}" data-ar="${v.ar}"></span>`, `"narration": [${j({ at: v.at, text: v.en })}]`)));
  const ruler = lane("ruler");
  for (let s = 0; s <= D; s += 2) ruler.insertAdjacentHTML("beforeend", `<i style="left:${rel(s)}%">${s}s</i>`);
  const phs = [...root.querySelectorAll(".ph")];
  const allBlocks = Object.values(blocks).flat();

  // ---- tooltip ----
  const tip = $(".tip");
  const showTip = (el) => {
    tip.textContent = el.dataset.json; tip.classList.add("on");
    const rb = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    tip.style.left = clamp(r.left - rb.left, 8, rb.width - tip.offsetWidth - 8) + "px";
    tip.style.top = r.top - rb.top - tip.offsetHeight - 8 + "px";
  };
  allBlocks.forEach((el) => {
    el.addEventListener("mouseenter", () => showTip(el)); el.addEventListener("focus", () => showTip(el));
    el.addEventListener("mouseleave", () => tip.classList.remove("on")); el.addEventListener("blur", () => tip.classList.remove("on"));
    el.addEventListener("click", () => { t = +el.dataset.a; hold = 0; render(); });
  });

  // ---- camera, cursor, ui ----
  const cursorAt = (x) => {
    let i = 0; while (i < PATH.length - 2 && x >= PATH[i + 1][0]) i++;
    const a = PATH[i], b = PATH[i + 1], u = ease((x - a[0]) / (b[0] - a[0] || 1));
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  };
  const camera = (x) => {
    let wsum = 0, cx = 0, cy = 0, s = 0;
    for (const z of ZOOMS) {
      const w = ease((x - (z.at - 0.5)) / 0.5) * (1 - ease((x - (z.at + z.dur)) / 0.5));
      if (w <= 0) continue;
      const hx = W / (2 * z.scale), hy = H / (2 * z.scale);
      wsum += w; cx += w * clamp(z.cx, hx, W - hx); cy += w * clamp(z.cy, hy, H - hy); s += w * z.scale;
    }
    const rest = 1 - Math.min(1, wsum);
    return { cx: cx + rest * W / 2, cy: cy + rest * H / 2, s: s + rest };
  };
  const within = (list, x) => list.find((o) => x >= o.at && x < o.at + o.dur);

  function render() {
    const fit = wrap.clientWidth / W;
    const edited = mode === "edited";
    const cam = edited ? camera(t) : { cx: W / 2, cy: H / 2, s: 1 };
    stage.style.transform = `scale(${fit}) translate(${W / 2 - cam.cx * cam.s}px, ${H / 2 - cam.cy * cam.s}px) scale(${cam.s})`;
    const view = t >= 2.0 ? "reports" : "overview";
    stage.dataset.view = view; vt.textContent = view === "reports" ? "Reports" : "Overview";
    items.forEach((it) => it.classList.toggle("on", it.dataset.i === view));
    stage.dataset.export = t >= 4 && t < 13 ? "busy" : "idle";
    stage.dataset.ready = t >= 13 ? "1" : "0"; stage.dataset.preview = t >= 14.5 ? "1" : "0";
    repBtn.classList.toggle("press", t >= 4.0 && t < 4.25);
    bar.style.width = clamp((t - 4) / 9, 0, 1) * 100 + "%";
    const [cxp, cyp] = cursorAt(t); curs.style.transform = `translate(${cxp - 2}px, ${cyp - 2}px)`;
    const c = CLICKS.find((k) => t >= k[0] && t < k[0] + 0.6);
    if (c) { const u = (t - c[0]) / 0.6; rip.style.cssText = `left:${c[1]}px;top:${c[2]}px;opacity:${1 - u};transform:scale(${1 + u * 3.2})`; } else rip.style.opacity = 0;
    const h = edited ? within(HLS, t) : null;
    hl.classList.toggle("on", !!h);
    if (h) hl.style.cssText = `left:${h.r[0]}px;top:${h.r[1]}px;width:${h.r[2]}px;height:${h.r[3]}px`;
    const cp = edited ? within(CAPS, t) : null;
    capEl.classList.toggle("on", !!cp); if (cp) capEl.textContent = cp[lang]; capEl.dir = lang === "ar" ? "rtl" : "ltr";
    badge.classList.toggle("on", edited && speedAt(t) > 1);
    // timeline
    phs.forEach((p) => (p.style.left = rel(t) + "%"));
    allBlocks.forEach((el) => el.classList.toggle("act", t >= +el.dataset.a && t < +el.dataset.b));
    $(".tcn").textContent = fmt(outTime(t)); $(".tct").textContent = fmt(outTime(D));
    slider.setAttribute("aria-valuenow", t.toFixed(1)); slider.setAttribute("aria-valuetext", `${t.toFixed(1)} s`);
    window.dispatchEvent(new CustomEvent("sp-editor", { detail: { t } }));
  }

  // ---- loop ----
  function frame(now) {
    if (playing && visible && !document.hidden) {
      const dt = Math.min(0.1, (now - last) / 1000);
      if (hold > 0) hold -= dt; else {
        t += dt * speedAt(t);
        if (t >= D) { t = D; hold = 1.2; setTimeout(() => { if (t >= D) t = 0; }, 1200); }
      }
      render();
    }
    last = now; requestAnimationFrame(frame);
  }
  new IntersectionObserver((e) => (visible = e[0].isIntersecting), { threshold: 0.1 }).observe(root);
  new ResizeObserver(render).observe(wrap);

  // ---- controls ----
  const playBtn = $(".play");
  const setPlay = (on) => { playing = on; playBtn.setAttribute("aria-label", on ? playBtn.dataset.pause : playBtn.dataset.play); playBtn.innerHTML = on ? '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>'; };
  playBtn.addEventListener("click", () => { if (t >= D) t = 0; setPlay(!playing); });
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode; root.dataset.mode = mode;
    root.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    cutLabel(); render();
  }));
  root.querySelectorAll("[data-cl]").forEach((b) => b.addEventListener("click", () => {
    lang = b.dataset.cl; root.querySelectorAll("[data-cl]").forEach((x) => x.setAttribute("aria-pressed", x === b)); labels(); render();
  }));
  function cutLabel() {
    const cut = root.querySelector('[data-t="cut"]');
    if (cut) cut.textContent = mode === "edited" ? `${SEG[1].speed}× · ${root.dataset.tCut}` : root.dataset.tWait;
  }
  function labels() {
    root.querySelectorAll(".cl,.vl").forEach((el) => { el.textContent = el.dataset[lang]; el.dir = lang === "ar" ? "rtl" : "ltr"; });
  }
  // scrubbing
  const slider = $(".scrub");
  const setFrom = (ev) => { const r = lane("video").getBoundingClientRect(); t = clamp(((ev.clientX - r.left) / r.width) * D, 0, D); hold = 0; render(); };
  let drag = false;
  root.querySelectorAll(".lane:not(.ruler), .lane.ruler, .scrub").forEach((el) => el.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest(".blk")) return; drag = true; el.setPointerCapture?.(ev.pointerId); setPlay(false); setFrom(ev);
  }));
  addEventListener("pointermove", (ev) => drag && setFrom(ev)); addEventListener("pointerup", () => (drag = false));
  slider.addEventListener("keydown", (ev) => {
    const d = { ArrowRight: 0.5, ArrowLeft: -0.5, PageUp: 2, PageDown: -2 }[ev.key]; if (d === undefined) return;
    ev.preventDefault(); t = clamp(t + d, 0, D); setPlay(false); render();
  });
  labels(); cutLabel(); setPlay(playing); render();
  if (!reduced) requestAnimationFrame(frame);
})();
