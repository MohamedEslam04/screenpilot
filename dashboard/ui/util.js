const NS = "http://www.w3.org/2000/svg";
export const $ = (s, r = document) => r.querySelector(s);

/** Tiny element builder: h("div", {class, text, onclick}, ...children). */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c);
  return e;
}
export { NS };

export const basename = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
export const parentName = (p) => basename(String(p || "").replace(/[\\/][^\\/]*$/, ""));

/** Display title: storyboard/sequence file name, or the folder name for storyboard.json. */
export function titleOf(ev) {
  const p = ev.path || ev.storyboard || "";
  const b = basename(p);
  if (/^(storyboard|sequence)\.json$/i.test(b)) return parentName(p) || b;
  return b.replace(/\.json$/i, "") || p;
}

export function fmtDur(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.round(s);
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + ":" + String(r).padStart(2, "0");
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}
export function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}
export function fmtWall(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.round(s);
  if (s < 60) return s + " s";
  return Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
}
export function rel(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 45) return "just now";
  if (d < 3600) return Math.round(d / 60) + " min ago";
  if (d < 86400) return Math.round(d / 3600) + " h ago";
  if (d < 14 * 86400) return Math.round(d / 86400) + " d ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
export const fmtDate = (iso) => (Date.parse(iso) ? new Date(iso).toLocaleString() : "");
export function bytes(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
}
export const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const t = h("textarea", { class: "sr", "aria-hidden": "true" });
  t.value = text;
  document.body.append(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  t.remove();
  return ok;
}

let toastTimer = 0;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3200);
}

export const errText = (e) => (typeof e === "string" ? e : e?.message || "Something went wrong");
