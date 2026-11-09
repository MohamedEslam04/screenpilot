// In-browser stand-in for the Tauri commands (see dashboard/API.md). Deterministic fixtures.
const rng = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hash = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
const pick = (r, a) => a[Math.floor(r() * a.length)];

const EN = ["Onboarding tour", "Billing export", "Checkout flow", "Dark mode settings", "Invoice upload", "Team invite", "API keys page", "Release notes demo", "Search filters", "Mobile signup", "Dashboard overview", "Webhook setup"];
const AR = ["شرح تسجيل الدخول", "جولة في لوحة التحكم", "إنشاء فاتورة جديدة", "تصدير التقارير", "إضافة مستخدم جديد", "إعدادات الإشعارات"];
const ERRORS = [
  "ffmpeg exited with code 1: Invalid data found when processing input",
  "TTS provider elevenlabs: 401 invalid API key",
  "HyperFrames render timed out after 600 s",
  "الملف غير موجود: recording.mp4",
  "Storyboard invalid: narration[3].at is beyond the end of the source",
];
const ARNAR = ["أهلاً بكم في جولة سريعة على المنتج.", "نبدأ بتسجيل الدخول إلى حسابك.", "من هنا نفتح لوحة التحكم.", "اضغط على زر الإنشاء لإضافة فاتورة جديدة.", "اختر العميل ثم أضف البنود.", "وأخيراً نحفظ الفاتورة ونرسلها.", "بهذه البساطة انتهينا."];
const ENNAR = ["Let's take a quick look around.", "First, sign in to your account.", "The dashboard shows everything at a glance.", "Click New to start an invoice.", "Pick a customer and add the line items.", "Save it, and it is on its way.", "That is all it takes."];

let HIST = null;
function history() {
  if (HIST) return HIST;
  const r = rng(20260301), out = [];
  let t = Date.now() - 180000;
  for (let i = 0; i < 10000; i++) {
    t -= (20 + Math.floor(r() * 880)) * 1000;
    const x = r(), kind = x < 0.5 ? "render" : x < 0.68 ? "take" : x < 0.84 ? "record" : "sequence";
    const ar = r() < 0.2, name = ar ? pick(r, AR) : pick(r, EN), slug = (i % 37) ? name + (i % 7 ? "" : " v" + (i % 5 + 2)) : name;
    const d = new Date(t), stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1-$2");
    const base = "/home/mo/screenpilot/";
    const ev = { v: 1, at: new Date(t).toISOString(), kind, status: r() < 0.08 ? "failed" : "ok" };
    const dur = Math.round(12 + r() * 170);
    if (kind === "render" || kind === "sequence") {
      ev.path = base + "demos/" + slug + "/" + (kind === "render" ? "storyboard.json" : "sequence.json");
      ev.quality = pick(r, ["draft", "draft", "looks", "delivery"]);
      if (ev.status === "ok") { ev.output = base + "demos/" + slug + "/" + (kind === "render" ? "storyboard" : "sequence") + ".mp4"; ev.durationSec = dur; }
      ev.wallSeconds = Math.round(dur * (0.4 + r() * 3.5));
      if (kind === "render") ev.storyboard = ev.path;
    } else {
      ev.path = base + "sessions/" + (kind === "take" ? "take-" : "rec-") + stamp;
      if (ev.status === "ok") { ev.output = ev.path + "/recording.mp4"; ev.durationSec = dur; }
      if (kind === "take") ev.storyboard = ev.path + "/storyboard.json";
      if (r() < 0.06) ev.imported = true;
    }
    if (ev.status === "failed") ev.error = pick(r, ERRORS);
    out.push(ev);
  }
  return HIST = out;
}
function bsearch(arr, before) { // first index with at < before (arr is newest first)
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].at < before) hi = m; else lo = m + 1; }
  return lo;
}

/* ---- jobs ---- */
const LABELS = ["Preparing", "Cutting video", "Synthesizing voice", "Rendering frames", "Mixing audio", "Encoding"];
let jobs = [], nextId = 1; const subs = new Set();
const mkJob = (path, kind, quality, total) => { const now = new Date().toISOString(); return { id: "job-" + nextId++, pid: 4100 + nextId, kind, path, quality, startedAt: now, updatedAt: now, step: { label: LABELS[0], index: 0, total } }; };
const emit = () => { if (document.visibilityState === "visible") for (const f of subs) f({ payload: jobs.map((j) => ({ ...j, step: j.step && { ...j.step } })) }); };
jobs = [
  mkJob("/home/mo/screenpilot/demos/جولة في لوحة التحكم/storyboard.json", "render", "draft", 90),
  mkJob("/home/mo/screenpilot/demos/Checkout flow/sequence.json", "sequence", "delivery", 40),
];
jobs[0].startedAt = new Date(Date.now() - 23000).toISOString();
setInterval(() => {
  if (document.visibilityState !== "visible" || !jobs.length) return;
  const done = [];
  for (const j of jobs) {
    j.step.index++; j.updatedAt = new Date().toISOString();
    j.step.label = LABELS[Math.min(LABELS.length - 1, Math.floor((j.step.index / j.step.total) * LABELS.length))];
    if (j.step.index >= j.step.total) done.push(j);
  }
  for (const j of done) {
    jobs = jobs.filter((x) => x !== j);
    const hist = history();
    hist.unshift({ v: 1, at: new Date().toISOString(), kind: j.kind, status: "ok", path: j.path, quality: j.quality, output: j.path.replace(/\.json$/, ".mp4"), durationSec: 48, wallSeconds: j.step.total });
  }
  emit();
}, 1000);

/* ---- providers / secrets ---- */
const prov = { edge: null, local: null, command: null, elevenlabs: null, gemini: "env" };
const P = [
  { id: "edge", label: "Edge (online)", needs_key: false }, { id: "local", label: "Local models", needs_key: false },
  { id: "command", label: "Custom command", needs_key: false }, { id: "elevenlabs", label: "ElevenLabs", needs_key: true },
  { id: "gemini", label: "Gemini", needs_key: true },
];
function voicesFor(id) {
  if (id === "edge") {
    const base = [["ar-EG-SalmaNeural", "ar-EG", "Female"], ["ar-EG-ShakirNeural", "ar-EG", "Male"], ["en-US-AndrewNeural", "en-US", "Male"], ["en-US-AvaNeural", "en-US", "Female"], ["en-GB-SoniaNeural", "en-GB", "Female"]];
    const r = rng(7), loc = ["de-DE", "fr-FR", "es-ES", "it-IT", "ja-JP", "pt-BR", "tr-TR", "ar-SA", "hi-IN"];
    for (let i = 0; i < 300; i++) { const l = loc[i % loc.length]; base.push([`${l}-Voice${i}Neural`, l, r() < 0.5 ? "Female" : "Male"]); }
    return base.map(([name, locale, gender]) => ({ name, locale, gender }));
  }
  if (id === "local") return [{ name: "voicetut:Sarah", locale: "en", gender: "Female" }, { name: "voicetut:Salma", locale: "ar-EG", gender: "Female" }, { name: "namaa", locale: "ar-EG" }];
  if (id === "command") return [{ name: "my-studio-voice", locale: "en" }];
  if (id === "gemini") return ["Kore", "Puck", "Charon", "Zephyr"].map((name) => ({ name, locale: "multi" }));
  return null;
}

const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
const thumbSvg = (v) => { const h = hash(v) % 360; return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='128' height='72'><defs><linearGradient id='g'><stop offset='0' stop-color='hsl(${h} 45% 40%)'/><stop offset='1' stop-color='hsl(${(h + 50) % 360} 50% 22%)'/></linearGradient></defs><rect width='128' height='72' fill='url(#g)'/><rect x='14' y='14' width='${40 + h % 50}' height='6' rx='3' fill='white' fill-opacity='.5'/><rect x='14' y='28' width='60' height='30' rx='4' fill='white' fill-opacity='.2'/></svg>`); };

function project(path) {
  const r = rng(hash(path)), ar = /[؀-ۿ]/.test(path), isDir = !/\.json$/.test(path);
  const files = [{ name: "storyboard.json", size: 4200 + Math.floor(r() * 9000) }, { name: "recording.mp4", size: 8e6 + Math.floor(r() * 4e7) }, { name: "events.jsonl", size: 18000 }, { name: "windows.jsonl", size: 9000 }];
  if (/sequence\.json$/.test(path)) return { storyboard: { version: 1, parts: [{ storyboard: "intro.json", to: 42 }, { storyboard: "feature.json" }, { storyboard: "intro.json", from: 42 }] }, meta: null, files: [files[0]] };
  const lines = ar ? ARNAR : ENNAR, n = 4 + Math.floor(r() * 4), nar = [];
  for (let i = 0; i < n; i++) nar.push({ at: Math.round(i * (5 + r() * 6) * 10) / 10, text: lines[i % lines.length] });
  const sb = {
    version: 1, source: "recording.mp4", output: { width: 1920, height: 1080, fps: 30 },
    voice: { provider: ar ? "edge" : pick(r, ["edge", "local", "gemini"]), name: ar ? "ar-EG-SalmaNeural" : "en-US-AndrewNeural" },
    narration: nar, captions: new Array(2 + Math.floor(r() * 5)).fill({}), zooms: new Array(Math.floor(r() * 6)).fill({}), highlights: new Array(Math.floor(r() * 3)).fill({}), segments: new Array(1 + Math.floor(r() * 4)).fill({}),
  };
  return { storyboard: sb, meta: isDir ? { screens: 2, fps: 30, recorder: "native", startedAt: "2026-03-01T10:22:11Z" } : null, files };
}

const handlers = {
  list_history: ({ before, limit = 50 } = {}) => { const a = history(), i = before ? bsearch(a, before) : 0; return wait(15, a.slice(i, i + limit).map((e) => ({ ...e }))); },
  get_project: ({ path }) => wait(25, project(path)),
  jobs: () => wait(10, jobs.map((j) => ({ ...j }))),
  stats: () => wait(20, { history_count: history().length, speed: [{ quality: "draft", runs: 412, realtime: 3.8 }, { quality: "looks", runs: 120, realtime: 1.6 }, { quality: "delivery", runs: 88, realtime: 0.9 }] }),
  cache_size: () => wait(900, 3412000000),
  thumbnail: ({ video }) => wait(40 + (hash(video) % 120), /\.mp4$/.test(video) ? thumbSvg(video) : null),
  open_path: () => wait(10, null),
  run_render: ({ storyboard, quality }) => {
    if (!/\.json$/.test(storyboard)) return Promise.reject("Not a storyboard: " + storyboard);
    jobs = [...jobs, mkJob(storyboard, "render", quality, 30)]; emit(); return wait(10, { started: true });
  },
  providers: () => wait(10, P.map((p) => ({ ...p, key: prov[p.id] }))),
  list_voices: ({ provider }) => {
    if (provider === "elevenlabs") return prov.elevenlabs ? wait(200, [{ name: "Rachel", locale: "en", gender: "Female" }, { name: "Adam", locale: "en", gender: "Male" }]) : Promise.reject("ElevenLabs key is not set. Save a key first.");
    return wait(120, voicesFor(provider) || []);
  },
  set_secret: ({ provider, key }) => { if (!key || !(provider in prov)) return Promise.reject("Invalid request"); prov[provider] = "file"; return wait(150, null); },
  remove_secret: ({ provider }) => { const had = prov[provider] === "file"; if (had) prov[provider] = null; return wait(80, had); },
};

export function invoke(cmd, args) {
  const f = handlers[cmd];
  return f ? Promise.resolve().then(() => f(args || {})) : Promise.reject("Unknown command: " + cmd);
}
export function listen(name, cb) {
  if (name === "jobs-changed") subs.add(cb);
  return Promise.resolve(() => subs.delete(cb));
}
export const convertFileSrc = (p) => p;
