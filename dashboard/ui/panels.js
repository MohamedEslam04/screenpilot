import { invoke } from "./api.js";
import { h, titleOf, fmtWall, fmtClock, bytes, copy, toast, errText } from "./util.js";

/* ================= Live ================= */
let jobs = [], liveRoot = null, liveShown = false, timer = 0;
const jobEls = new Map();
const elapsed = (j) => fmtClock((Date.now() - Date.parse(j.startedAt)) / 1000);

function jobEl(j) {
  const e = { root: null };
  e.kd = h("span", { class: "kd" });
  e.ti = h("div", { class: "ti", dir: "auto" });
  e.q = h("span", { class: "q" });
  e.el = h("span", { class: "el" });
  e.fill = h("div", { class: "fill" });
  e.track = h("div", { class: "track", role: "progressbar", "aria-label": "Render progress", "aria-valuemin": 0 }, e.fill);
  e.label = h("span");
  e.cnt = h("span", { class: "mono" });
  e.path = h("div", { class: "mono mute", dir: "ltr" });
  e.root = h("div", { class: "job" },
    h("div", { class: "job-h" }, e.kd, e.ti, e.q, e.el), e.track,
    h("div", { class: "job-s" }, e.label, e.cnt), e.path);
  return e;
}
function updateJob(e, j) {
  e.kd.textContent = j.kind; e.kd.dataset.k = j.kind;
  e.ti.textContent = titleOf(j); e.q.textContent = j.quality || "";
  e.path.textContent = j.path + "  ·  pid " + j.pid;
  const s = j.step;
  e.track.classList.toggle("ind", !s || !s.total);
  if (s && s.total) {
    const pct = Math.min(100, Math.round((s.index / s.total) * 100));
    e.fill.style.width = pct + "%";
    e.track.setAttribute("aria-valuemax", s.total); e.track.setAttribute("aria-valuenow", s.index);
    e.label.textContent = s.label; e.cnt.textContent = `${s.index}/${s.total} · ${pct}%`;
  } else { e.fill.style.width = ""; e.track.removeAttribute("aria-valuenow"); e.label.textContent = "Starting"; e.cnt.textContent = ""; }
  e.el.textContent = elapsed(j);
}
function paintLive() {
  if (!liveRoot) return;
  if (!liveRoot._init) {
    liveRoot._init = 1;
    liveRoot.append(h("div", { class: "wrap" }, h("h1", { text: "Live" }),
      h("p", { class: "mute", text: "Renders running right now. This page updates when a render moves to its next step." }),
      (liveRoot._list = h("div", { "aria-live": "off" })),
      (liveRoot._empty = h("div", { class: "card" }, h("b", { text: "Nothing is rendering" }), h("span", { class: "note", text: "Start a render from a storyboard in the Library and it shows up here." })))));
  }
  const seen = new Set();
  for (const j of jobs) {
    seen.add(j.id);
    let e = jobEls.get(j.id);
    if (!e) { e = jobEl(j); jobEls.set(j.id, e); liveRoot._list.append(e.root); }
    e.job = j; updateJob(e, j);
  }
  for (const [id, e] of jobEls) if (!seen.has(id)) { e.root.remove(); jobEls.delete(id); }
  liveRoot._empty.hidden = jobs.length > 0;
}
function tick() { for (const e of jobEls.values()) e.el.textContent = elapsed(e.job); }
function startTick() { if (!timer && liveShown && !document.hidden && jobs.length) timer = setInterval(tick, 1000); }
function stopTick() { clearInterval(timer); timer = 0; }
export const live = {
  set(j) { jobs = j; if (liveShown) { paintLive(); stopTick(); startTick(); } },
  show(root) { liveRoot = root; liveShown = true; paintLive(); tick(); startTick(); },
  hide() { liveShown = false; stopTick(); },
  pause: stopTick,
  resume() { if (liveShown) { tick(); startTick(); } },
};

/* ================= Voices ================= */
const SERVICE = {
  edge: "Microsoft's online Edge voice service",
  elevenlabs: "ElevenLabs",
  gemini: "Google (Gemini API)",
};
const LOCAL = {
  local: "Runs on this computer with models you installed. Nothing leaves it.",
  command: "Runs a program you defined in voices.json. What it sends, and where, is up to that program.",
};
let vRoot = null, vLoaded = false;

async function loadProviders() {
  let ps;
  try { ps = await invoke("providers", {}); } catch (e) { vRoot.replaceChildren(h("div", { class: "wrap errbox", text: errText(e) })); return; }
  const cards = ps.map(card);
  vRoot._cards.replaceChildren(...cards);
}
function card(p) {
  const status = p.key === "env" ? "Key set by environment variable"
    : p.key === "file" ? "Key saved" : p.needs_key ? "No key" : "No key needed";
  const head = h("div", { class: "card-h" }, h("h2", { text: p.label }), h("span", { class: "mono mute", text: p.id }),
    h("span", { class: "ks" + (p.key ? " ok" : ""), text: status }));
  const c = h("div", { class: "card" }, head);
  const svc = SERVICE[p.id];
  c.append(h("div", { class: "note", text: svc ? `Narration text is sent to ${svc} to make audio.` : LOCAL[p.id] || "" }));

  if (p.needs_key) {
    if (p.key === "env") {
      c.append(h("div", { class: "note", text: "The key comes from an environment variable, so the dashboard cannot change or remove it. Unset the variable to manage a key here." }));
    } else {
      const input = h("input", { type: "password", "aria-label": `${p.label} API key`, placeholder: "Paste API key", autocomplete: "off", spellcheck: "false", name: "k-" + p.id });
      const save = h("button", { class: "btn primary", type: "button", disabled: true }, "Save key");
      input.addEventListener("input", () => { save.disabled = !input.value.trim(); });
      const submit = async () => {
        const key = input.value.trim();
        if (!key) return;
        save.disabled = true;
        try {
          await invoke("set_secret", { provider: p.id, key });
          toast(`${p.label} key saved`);
          await loadProviders();
        } catch (e) { toast(errText(e)); }
        finally { input.value = ""; save.disabled = true; }
      };
      save.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      const f = h("div", { class: "form" }, input, save);
      if (p.key === "file") f.append(h("button", { class: "btn danger", type: "button", onclick: async () => {
        try { await invoke("remove_secret", { provider: p.id }); toast(`${p.label} key removed`); await loadProviders(); } catch (e) { toast(errText(e)); }
      } }, "Remove key"));
      c.append(f);
    }
    const cmd = `screenpilot secret set ${p.id}`;
    c.append(h("div", {}, h("div", { class: "note", text: "Or set it from a terminal. The command reads the key from standard input, so it never appears in your shell history:" }),
      h("div", { class: "cli" }, h("code", { text: cmd }), h("button", { class: "btn", type: "button", onclick: async () => toast((await copy(cmd)) ? "Command copied" : "Copy failed") }, "Copy"))));
  }
  c.append(voiceList(p));
  return c;
}
function voiceList(p) {
  const d = h("details", {}, h("summary", { text: "Voices" }));
  let done = false;
  d.addEventListener("toggle", async () => {
    if (!d.open || done) return;
    done = true;
    const box = h("div", { class: "note", text: "Loading voices…" });
    d.append(box);
    let vs;
    try { vs = await invoke("list_voices", { provider: p.id }); } catch (e) { done = false; box.textContent = errText(e); return; }
    if (!vs.length) { box.textContent = "No voices found for this provider."; return; }
    const CAP = 120;
    const lst = h("div", { class: "vlist", tabindex: "0", role: "table", "aria-label": `${p.label} voices` });
    const flt = h("input", { class: "vfilter", type: "search", placeholder: `Filter ${vs.length} voices`, "aria-label": "Filter voices" });
    const more = h("div", { class: "note" });
    const draw = () => {
      const t = flt.value.trim().toLowerCase();
      const m = t ? vs.filter((v) => (v.name + " " + v.locale + " " + (v.gender || "")).toLowerCase().includes(t)) : vs;
      lst.replaceChildren(...m.slice(0, CAP).map((v) => h("div", { role: "row" }, h("span", { class: "mono", dir: "ltr", text: v.name }), h("span", { class: "mute", text: v.locale }), h("span", { class: "mute", text: v.gender || "" }))));
      more.textContent = m.length > CAP ? `${m.length - CAP} more. Use the filter to narrow the list.` : `${plural(m.length)}`;
    };
    flt.addEventListener("input", draw);
    box.replaceWith(flt, lst, more);
    draw();
  });
  return d;
}
const plural = (n) => (n === 1 ? "1 voice" : n + " voices");

export const voices = {
  show(root) {
    vRoot = root;
    if (vLoaded) return;
    vLoaded = true;
    root.append(h("div", { class: "wrap" }, h("h1", { text: "Voices" }),
      h("p", { class: "mute", text: "Choose where narration audio comes from. Keys are stored by the ScreenPilot CLI, never by this page." }),
      h("div", { class: "privacy", role: "note" }, h("b", { text: "Privacy. " }),
        "Online voices (Edge, ElevenLabs, Gemini) receive the narration text of every line they speak. Free plans can forbid commercial use, so check the terms before you publish a video made with them."),
      (root._cards = h("div"))));
    loadProviders();
  },
};

/* ================= Stats ================= */
let sRoot = null, sLoaded = false;
async function loadCache(out, btn) {
  btn.disabled = true; out.textContent = "calculating…";
  try { out.textContent = bytes(await invoke("cache_size", {})); } catch (e) { out.textContent = errText(e); }
  btn.disabled = false; btn.textContent = "Recalculate";
}
export const stats = {
  async show(root) {
    sRoot = root;
    if (sLoaded) return;
    sLoaded = true;
    const count = h("div", { class: "big", text: "…" });
    const rows = h("div");
    const cache = h("div", { class: "big", text: "" });
    const cbtn = h("button", { class: "btn", type: "button" }, "Calculate");
    cbtn.addEventListener("click", () => loadCache(cache, cbtn));
    root.append(h("div", { class: "wrap" }, h("h1", { text: "Stats" }),
      h("div", { class: "card" }, h("h2", { text: "History" }), count, h("div", { class: "note", text: "Events recorded: recordings, takes, renders and sequences." })),
      h("div", { class: "card" }, h("h2", { text: "Render speed" }), h("div", { class: "note", text: "Video seconds produced per wall-clock second, from your finished renders. Above 1× is faster than real time." }), rows),
      h("div", { class: "card" }, h("h2", { text: "Render cache" }), cache, h("div", { class: "form" }, cbtn), h("div", { class: "note", text: "Cached frames and chunks that make repeat renders faster. Measuring can take a while on a large cache." }))));
    loadCache(cache, cbtn);
    try {
      const s = await invoke("stats", {});
      count.textContent = s.history_count.toLocaleString();
      const max = Math.max(1, ...s.speed.map((r) => r.realtime));
      rows.replaceChildren(...(s.speed.length ? s.speed.map((r) => {
        const bar = h("div", { class: "stat-bar" }, h("i")); bar.firstChild.style.width = Math.max(2, (r.realtime / max) * 100) + "%";
        return h("div", { class: "stat-row" }, h("b", { text: r.quality }), bar,
          h("div", {}, h("div", { text: r.realtime.toFixed(r.realtime < 10 ? 1 : 0) + "×" }), h("div", { class: "note", text: `${r.runs} runs · 1 min video ≈ ${fmtWall(60 / r.realtime)}` })));
      }) : [h("div", { class: "note", text: "No timed renders yet. Renders of 5 s or more are measured." })]));
    } catch (e) { rows.textContent = errText(e); }
  },
};
