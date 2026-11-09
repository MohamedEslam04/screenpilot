import { invoke, listen, fileSrc, isMock } from "./api.js";
import { $, h, titleOf, fmtDur, fmtWall, fmtClock, rel, fmtDate, bytes, plural, copy, toast, errText, basename } from "./util.js";
import { live, voices, stats } from "./panels.js";

const PAGE = 50, RH = 56, OVER = 3;
const KIND = { record: "Record", take: "Take", render: "Render", sequence: "Sequence" };
const S = { all: [], view: [], kinds: new Set(), failed: false, q: "", exhausted: false, loading: false, cur: -1, sel: null, tab: "library" };

const list = $("#list"), sp = $("#sp"), emptyEl = $("#empty"), detail = $("#detail"), lib = $("#p-library");
const params = new URLSearchParams(location.search);

/* ---------- theme ---------- */
$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("sp-theme", root.dataset.theme); } catch {}
});

/* ---------- thumbnails (lazy, visible rows only, <=200 cached) ---------- */
const thumbs = new Map(), inflight = new Set();
let tTimer = 0, tBusy = 0;
const kick = () => { if (!tTimer && !document.hidden) tTimer = setTimeout(pumpThumbs, 90); };
function paint(el) {
  const ev = S.view[el._i], src = ev && ev.output && thumbs.get(ev.output);
  if (src) { if (el._th.getAttribute("src") !== src) el._th.src = src; el._th.hidden = false; }
  else { el._th.hidden = true; el._th.removeAttribute("src"); }
}
function pumpThumbs() {
  tTimer = 0;
  const st = list.scrollTop, vf = Math.floor(st / RH), vl = Math.ceil((st + list.clientHeight) / RH);
  for (const el of pool) {
    if (tBusy >= 2) break;
    const i = el._i, ev = S.view[i];
    if (el.hidden || i < vf || i > vl || !ev || !ev.output || thumbs.has(ev.output) || inflight.has(ev.output)) continue;
    const v = ev.output;
    inflight.add(v); tBusy++;
    invoke("thumbnail", { video: v })
      .then((p) => p || null, () => null)
      .then((p) => {
        inflight.delete(v); tBusy--;
        thumbs.delete(v); thumbs.set(v, p ? fileSrc(p) : null);
        if (thumbs.size > 200) thumbs.delete(thumbs.keys().next().value);
        for (const e of pool) if (!e.hidden && S.view[e._i]?.output === v) paint(e);
        kick();
      });
  }
}

/* ---------- virtual list ---------- */
const pool = [];
let raf = 0, ver = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };

function makeRow() {
  const el = h("div", { class: "row", role: "option" });
  el._th = h("img", { class: "th", alt: "", decoding: "async", hidden: true });
  el._ti = h("div", { class: "ti", dir: "auto" });
  el._q = h("span", { class: "q" });
  el._sx = document.createTextNode("");
  el._sb = h("div", { class: "sb" }, el._q, el._sx);
  el._mt = h("span", { class: "mt" });
  el.append(el._th, h("div", { class: "mn" }, el._ti, el._sb), el._mt);
  return el;
}
function subText(ev) {
  if (ev.status === "failed") return "Failed" + (ev.error ? ": " + ev.error : "");
  const p = [KIND[ev.kind] || ev.kind];
  if (ev.durationSec != null) p.push(fmtDur(ev.durationSec));
  if (ev.wallSeconds != null) p.push("took " + fmtWall(ev.wallSeconds));
  if (ev.imported) p.push("imported");
  return p.join(" \u00b7 ");
}
function bind(el, i) {
  const ev = S.view[i];
  el._i = i; el._ver = ver; el.hidden = false;
  el.style.transform = "translateY(" + i * RH + "px)";
  el.id = "row-" + i;
  el.dataset.k = ev.kind;
  el.title = ev.status === "failed" && ev.error ? ev.error : "";
  el.classList.toggle("bad", ev.status === "failed");
  el._ti.textContent = ev._t || (ev._t = titleOf(ev));
  el._q.textContent = ev.quality || "";
  el._sx.nodeValue = subText(ev);
  el._mt.textContent = rel(ev.at);
  el.setAttribute("aria-posinset", i + 1);
  el.setAttribute("aria-setsize", S.view.length);
  el.setAttribute("aria-label", `${KIND[ev.kind]} ${el._ti.textContent}, ${ev.status}, ${el._mt.textContent}`);
  paint(el);
}
function render() {
  raf = 0;
  if (S.tab !== "library") return;
  const n = S.view.length;
  sp.style.height = n * RH + "px";
  const st = list.scrollTop, vh = list.clientHeight;
  const first = Math.max(0, Math.floor(st / RH) - OVER), last = Math.min(n - 1, Math.ceil((st + vh) / RH) + OVER);
  const need = Math.max(0, last - first + 1);
  while (pool.length < need) { const el = makeRow(); el._i = -1; el.hidden = true; sp.append(el); pool.push(el); }
  const N = pool.length;
  let active = "";
  for (let s = 0; s < N; s++) {
    const el = pool[s], i = first + (((s - first) % N) + N) % N;
    if (i > last || i >= n) { if (!el.hidden) { el.hidden = true; el._i = -1; } continue; }
    if (el._i !== i || el._ver !== ver) bind(el, i);
    const c = i === S.cur, sel = S.view[i] === S.sel;
    el.classList.toggle("cur", c); el.classList.toggle("sel", sel);
    el.setAttribute("aria-selected", sel);
    if (c) active = el.id;
  }
  if (active) list.setAttribute("aria-activedescendant", active); else list.removeAttribute("aria-activedescendant");
  updateEmpty(); updateFoot();
  kick();
  if (!S.exhausted && !S.loading && !S.q && last >= n - 12) loadMore();
  debug();
}

/* ---------- data ---------- */
function matches(ev) {
  if (S.kinds.size && !S.kinds.has(ev.kind)) return false;
  if (S.failed && ev.status !== "failed") return false;
  if (S.q) {
    const s = ev._s || (ev._s = (titleOf(ev) + " " + (ev.path || "") + " " + (ev.quality || "") + " " + (ev.error || "")).toLowerCase());
    if (!s.includes(S.q)) return false;
  }
  return true;
}
function refilter(keepScroll) {
  S.view = S.all.filter(matches);
  ver++;
  if (!keepScroll) { list.scrollTop = 0; S.cur = S.view.length ? 0 : -1; }
  schedule();
}
async function loadMore() {
  if (S.loading || S.exhausted) return;
  S.loading = true; updateFoot();
  try {
    const last = S.all[S.all.length - 1];
    const page = await invoke("list_history", last ? { before: last.at, limit: PAGE } : { limit: PAGE });
    if (!page.length) S.exhausted = true;
    else { S.all.push(...page); if (page.length < PAGE) S.exhausted = true; }
    refilter(true);
  } catch (e) { S.exhausted = true; toast(errText(e)); }
  S.loading = false; schedule();
}
async function refreshHead() {
  try {
    const page = await invoke("list_history", { limit: PAGE });
    const top = S.all[0] ? Date.parse(S.all[0].at) : 0;
    const fresh = page.filter((e) => Date.parse(e.at) > top);
    if (fresh.length) { S.all.unshift(...fresh); if (S.cur >= 0) S.cur += fresh.length; refilter(true); }
    else if (!S.all.length) { S.all = page; refilter(); }
  } catch {}
}
function updateEmpty() {
  let t = null;
  if (!S.view.length) {
    if (S.loading || (!S.exhausted && !S.all.length)) t = ["Loading history", ""];
    else if (!S.all.length) t = ["Nothing here yet", "Recordings, takes and renders appear after you make one with ScreenPilot."];
    else t = ["No matches", S.exhausted ? "Try another search or clear the filters." : "Nothing matches in the rows loaded so far. Load older rows to search further."];
  }
  emptyEl.hidden = !t;
  if (t && emptyEl._t !== t[0] + t[1]) { emptyEl._t = t[0] + t[1]; emptyEl.replaceChildren(h("b", { text: t[0] }), t[1]); }
}
function updateFoot() {
  const n = S.all.length, v = S.view.length;
  $("#count").textContent = S.loading && !n ? "" : (v !== n ? `${v.toLocaleString()} of ${n.toLocaleString()} loaded` : `${n.toLocaleString()} loaded`) + (S.exhausted ? "" : "+");
  $("#more").hidden = S.exhausted || S.loading;
}

/* ---------- list interaction ---------- */
list.addEventListener("scroll", schedule, { passive: true });
new ResizeObserver(schedule).observe(list);
list.addEventListener("click", (e) => {
  const el = e.target.closest(".row");
  if (el && el._i >= 0) { S.cur = el._i; openDetail(S.view[el._i]); schedule(); }
});
function move(to) {
  const n = S.view.length;
  if (!n) return;
  S.cur = Math.max(0, Math.min(n - 1, to));
  const top = S.cur * RH, st = list.scrollTop, vh = list.clientHeight;
  if (top < st) list.scrollTop = top; else if (top + RH > st + vh) list.scrollTop = top + RH - vh;
  schedule();
}
list.addEventListener("keydown", (e) => {
  const page = Math.max(1, Math.floor(list.clientHeight / RH) - 1);
  const k = e.key;
  if (k === "ArrowDown") move(S.cur + 1);
  else if (k === "ArrowUp") move(S.cur - 1);
  else if (k === "PageDown") move(S.cur + page);
  else if (k === "PageUp") move(S.cur - page);
  else if (k === "Home") move(0);
  else if (k === "End") move(S.view.length - 1);
  else if (k === "Enter" || k === " ") { if (S.view[S.cur]) openDetail(S.view[S.cur]); }
  else return;
  e.preventDefault();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); setTab("library"); $("#q").focus();
  } else if (e.key === "Escape") {
    if (document.activeElement === $("#q") && $("#q").value) { $("#q").value = ""; S.q = ""; refilter(); }
    else if (!detail.hidden) closeDetail(true);
  }
});
let qTimer = 0;
$("#q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { S.q = e.target.value.trim().toLowerCase(); refilter(); }, 120);
});
$("#chips").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const on = b.getAttribute("aria-pressed") !== "true";
  b.setAttribute("aria-pressed", on);
  if (b.dataset.kind) S.kinds[on ? "add" : "delete"](b.dataset.kind);
  else S.failed = on;
  refilter();
});
$("#more").addEventListener("click", loadMore);

/* ---------- detail ---------- */
let detTok = 0, lastFocus = null;
function releaseVideo() {
  const v = detail.querySelector("video");
  if (v) { v.pause(); v.removeAttribute("src"); v.removeAttribute("poster"); v.load(); }
}
function closeDetail(restore) {
  detTok++; releaseVideo();
  S.sel = null; detail.hidden = true; detail.replaceChildren();
  lib.classList.remove("has-detail");
  schedule();
  if (restore) (lastFocus && document.contains(lastFocus) ? lastFocus : list).focus();
}
const q = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : '"' + s.replace(/(["\\$`])/g, "\\$1") + '"');
const sbPath = (ev) => (ev.kind === "render" ? ev.path : ev.kind === "take" || ev.kind === "record" ? ev.storyboard : null);

function openDetail(ev) {
  if (!ev) return;
  lastFocus = document.activeElement;
  releaseVideo();
  const tok = ++detTok;
  S.sel = ev; schedule();
  lib.classList.add("has-detail"); detail.hidden = false;
  const title = titleOf(ev);
  const closeBtn = h("button", { class: "btn", type: "button", onclick: () => closeDetail(true) }, "Close");
  const body = h("div", { class: "d-body" }, h("div", { class: "skel" }), h("div", { class: "skel" }));
  detail.replaceChildren(
    h("div", { class: "d-head" }, h("h2", { dir: "auto", text: title }), closeBtn),
    body
  );
  detail.scrollTop = 0;
  closeBtn.focus({ preventScroll: true });
  invoke("get_project", { path: ev.path }).then(
    (p) => tok === detTok && fillDetail(body, ev, p, null),
    (e) => tok === detTok && fillDetail(body, ev, null, errText(e))
  );
}

function outSize(o) {
  if (!o) return "";
  if (o.width && o.height) return `${o.width}\u00d7${o.height}` + (o.fps ? ` @ ${o.fps} fps` : "");
  if (o.size) return Array.isArray(o.size) ? o.size.join("\u00d7") : String(o.size);
  return "";
}
function fillDetail(body, ev, proj, err) {
  const sb = proj && proj.storyboard, meta = proj && proj.meta;
  const kv = [];
  const add = (k, v, mono) => { if (v != null && v !== "") kv.push(h("dt", { text: k }), h("dd", { class: mono ? "mono" : "", dir: mono ? "ltr" : "auto", text: String(v) })); };
  add("Kind", KIND[ev.kind]); add("When", fmtDate(ev.at));
  add("Status", ev.status === "failed" ? "Failed" : "OK" + (ev.imported ? " (imported)" : ""));
  if (ev.durationSec != null) add("Duration", fmtDur(ev.durationSec));
  add("Quality", ev.quality); if (ev.wallSeconds != null) add("Wall time", fmtWall(ev.wallSeconds));
  add("Path", ev.path, true);
  if (ev.output) add("Output", ev.output, true);
  if (sb) {
    add("Output size", outSize(sb.output));
    const v = sb.voice; if (v) add("Voice", [v.provider || "edge", v.name].filter(Boolean).join(" \u00b7 "));
    add("Source", sb.source, true);
    const c = (k, w) => (Array.isArray(sb[k]) && sb[k].length ? plural(sb[k].length, w) : null);
    const counts = [c("narration", "narration line"), c("captions", "caption"), c("zooms", "zoom"), c("highlights", "highlight"), c("segments", "segment"), c("parts", "part")].filter(Boolean);
    if (counts.length) add("Contains", counts.join(", "));
  }
  if (meta) for (const [k, v] of Object.entries(meta).slice(0, 8)) if (v != null && typeof v !== "object") add(k, v);

  const out = [];
  if (ev.status === "failed" && ev.error) out.push(h("div", { class: "errbox", role: "alert", dir: "auto", text: ev.error }));
  if (err) out.push(h("div", { class: "errbox", text: "Could not read the project: " + err }));

  const target = ev.output || ev.path;
  const sbp = sbPath(ev);
  if (ev.output) {
    const v = h("video", { controls: true, preload: "none", src: fileSrc(ev.output) });
    const t = thumbs.get(ev.output); if (t) v.poster = t;
    out.push(v);
  }
  out.push(h("dl", { class: "kv" }, kv));

  const btns = h("div", { class: "btns" });
  if (ev.output) btns.append(h("button", { class: "btn", type: "button", onclick: () => act(invoke("open_path", { path: ev.output }), "Opening video") }, "Open video"));
  btns.append(h("button", { class: "btn", type: "button", onclick: () => act(invoke("open_path", { path: target, reveal: true }), "Opened folder") }, "Show in folder"));
  if (sbp) {
    btns.append(h("button", { class: "btn", type: "button", onclick: () => startRender(sbp, "draft") }, "Render draft"));
    const del = h("button", { class: "btn primary", type: "button" }, "Render delivery");
    let armed = 0;
    del.addEventListener("click", () => {
      if (!armed) { del.textContent = "Confirm delivery render"; armed = setTimeout(() => { armed = 0; del.textContent = "Render delivery"; }, 4000); return; }
      clearTimeout(armed); armed = 0; del.textContent = "Render delivery"; startRender(sbp, "delivery");
    });
    btns.append(del);
  }
  const cmdPath = sbp || ev.path;
  const cmd = ev.kind === "sequence" ? `screenpilot sequence ${q(cmdPath)} -q draft` : `screenpilot render ${q(cmdPath)} -q draft`;
  btns.append(h("button", { class: "btn", type: "button", onclick: async () => toast((await copy(cmd)) ? "Command copied" : "Copy failed") }, "Copy command"));
  out.push(btns);

  const nar = sb && Array.isArray(sb.narration) ? sb.narration : [];
  if (nar.length) {
    out.push(h("div", {}, h("h2", { text: "Narration" }),
      h("ul", { class: "narr", "aria-label": "Narration lines" }, nar.slice(0, 300).map((l) =>
        h("li", {}, h("time", { text: fmtClock(l.at || 0) }), h("span", { dir: "auto", text: l.text || "" }))))));
  }
  if (sb && Array.isArray(sb.parts) && sb.parts.length) {
    out.push(h("div", {}, h("h2", { text: "Parts" }), h("ul", { class: "narr" }, sb.parts.map((p) =>
      h("li", {}, h("time", { text: (p.from != null || p.to != null) ? `${p.from ?? 0}\u2013${p.to ?? "end"}` : "all" }), h("span", { dir: "auto", class: "mono", text: p.storyboard || p.sequence || p.video || "" }))))));
  }
  const files = (proj && proj.files) || [];
  if (files.length) out.push(h("details", {}, h("summary", { text: plural(files.length, "file") }), h("dl", { class: "kv" },
    files.slice(0, 40).map((f) => [h("dt", { class: "mono", text: f.name }), h("dd", { text: bytes(f.size) })]))));
  body.replaceChildren(...out);
}
async function act(p, msg) { try { await p; toast(msg); } catch (e) { toast(errText(e)); } }
async function startRender(path, quality) {
  try { await invoke("run_render", { storyboard: path, quality }); toast(`${quality[0].toUpperCase() + quality.slice(1)} render started. Follow it on the Live tab.`); }
  catch (e) { toast(errText(e)); }
}

/* ---------- tabs ---------- */
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = { library: lib, live: $("#p-live"), voices: $("#p-voices"), stats: $("#p-stats") };
const views = { live, voices, stats };
function setTab(name) {
  if (S.tab === name) return;
  views[S.tab]?.hide?.();
  S.tab = name;
  for (const t of tabs) { const on = t.dataset.tab === name; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; panels[t.dataset.tab].hidden = !on; }
  if (name === "library") { ver++; schedule(); } else views[name].show(panels[name]);
}
for (const t of tabs) t.addEventListener("click", () => setTab(t.dataset.tab));
$(".tabs").addEventListener("keydown", (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i < 0 || !/^Arrow(Left|Right)$|^(Home|End)$/.test(e.key)) return;
  const rtl = getComputedStyle(document.body).direction === "rtl";
  let j = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1) + tabs.length) % tabs.length;
  tabs[j].focus(); setTab(tabs[j].dataset.tab); e.preventDefault();
});

/* ---------- live jobs: one initial call, then events only ---------- */
const badge = $("#live-badge");
let prevIds = new Set();
function onJobs(jobs) {
  badge.hidden = !jobs.length; badge.textContent = jobs.length;
  live.set(jobs);
  const ids = new Set(jobs.map((j) => j.id));
  if ([...prevIds].some((id) => !ids.has(id))) refreshHead();
  prevIds = ids;
}
listen("jobs-changed", (e) => onJobs(e.payload || [])).catch(() => {});
invoke("jobs", {}).then(onJobs, () => {});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) views[S.tab]?.pause?.(); else { views[S.tab]?.resume?.(); kick(); if (S.tab === "library") { ver++; schedule(); } }
});

/* ---------- debug (?debug=1) ---------- */
const dbg = $("#debug");
function debug() {
  if (!params.has("debug")) return;
  dbg.hidden = false;
  const heap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " MB heap" : "heap n/a";
  dbg.textContent = `${document.getElementsByTagName("*").length} DOM nodes \u00b7 ${pool.length} rows pooled \u00b7 ${S.view.length} rows \u00b7 ${heap}`;
}
if (isMock) window.__sp = { S, pool, list };

/* ---------- start ---------- */
loadMore();
