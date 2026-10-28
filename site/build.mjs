// Builds the website into docs/ (GitHub Pages: "Deploy from a branch", main, /docs). No dependencies, no CI:
//   node site/build.mjs
// Sources: site/content/<lang>/<page>.html (see CONTENT_SPEC.md), site/landing.mjs, site/static/*.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { landing, T } from "./landing.mjs";

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SITE, "..");
const OUT = join(ROOT, "docs");
const URL_BASE = "https://mohamedeslam04.github.io/screenpilot/";
const REPO = "https://github.com/MohamedEslam04/screenpilot";
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const LANGS = {
  en: { dir: "ltr", name: "English", prefix: "", other: "ar" },
  ar: { dir: "rtl", name: "العربية", prefix: "ar/", other: "en" },
};
const GROUPS = [
  { id: "start", pages: ["getting-started", "install"] },
  { id: "use", pages: ["cli", "tools", "storyboard", "sequence", "agent-drive"] },
  { id: "ref", pages: ["safety", "platforms", "faq"] },
];
const UI = {
  en: {
    docs: "Docs", install: "Install", github: "GitHub", theme: "Switch theme", skip: "Skip to content", toc: "On this page", menu: "Documentation",
    groups: { start: "Start", use: "Use it", ref: "Reference" }, prev: "Previous", next: "Next", copy: "Copy", copied: "Copied",
    indexTitle: "Documentation", indexSummary: "Install ScreenPilot, ask your AI app for a video, and learn every tool, command and setting.",
    notFound: "Page not found", notFoundText: "That page does not exist. Start from the home page or the documentation.", home: "Home", anchor: "Link to this section",
  },
  ar: {
    docs: "التوثيق", install: "التثبيت", github: "GitHub", theme: "تبديل المظهر", skip: "انتقل إلى المحتوى", toc: "في هذه الصفحة", menu: "التوثيق",
    groups: { start: "البداية", use: "الاستخدام", ref: "المراجع" }, prev: "السابق", next: "التالي", copy: "نسخ", copied: "تم النسخ",
    indexTitle: "التوثيق", indexSummary: "ثبّت ScreenPilot، واطلب من تطبيقك الذكي فيديو، وتعرّف على كل أداة وأمر وإعداد.",
    notFound: "الصفحة غير موجودة", notFoundText: "هذه الصفحة غير موجودة. ابدأ من الصفحة الرئيسية أو من التوثيق.", home: "الرئيسية", anchor: "رابط إلى هذا القسم",
  },
};
const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const write = (rel, text) => { const f = join(OUT, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

// ---------- content ----------
function loadPage(lang, id) {
  const f = join(SITE, "content", lang, `${id}.html`);
  if (!existsSync(f)) return null;
  const raw = readFileSync(f, "utf8");
  const m = raw.match(/^\s*<!--\s*title:\s*(.+?)\s*\n\s*summary:\s*([\s\S]+?)\s*-->\s*/);
  if (!m) throw new Error(`${f}: missing title/summary comment`);
  return { id, title: m[1].trim(), summary: m[2].trim().replace(/\s+/g, " "), body: raw.slice(m[0].length) };
}
const pages = Object.fromEntries(Object.keys(LANGS).map((l) => [l, Object.fromEntries(GROUPS.flatMap((g) => g.pages).map((p) => [p, loadPage(l, p)]))]));
const order = GROUPS.flatMap((g) => g.pages);

// ---------- path helpers: every link is relative, so the site works under /screenpilot/ or at a domain root ----------
const up = (rel) => "../".repeat(rel.split("/").length - 1);

function head({ lang, rel, title, desc, alt, type = "website", noindex = false }) {
  const u = up(rel);
  const canonical = URL_BASE + rel.replace(/index\.html$/, "");
  return `<!doctype html>
<html lang="${lang}" dir="${LANGS[lang].dir}" data-copy="${UI[lang].copy}" data-copied="${UI[lang].copied}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${canonical}">`}
${alt ? ["en", "ar"].map((l) => `<link rel="alternate" hreflang="${l}" href="${URL_BASE}${alt[l].replace(/index\.html$/, "")}">`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${URL_BASE}${alt.en.replace(/index\.html$/, "")}">` : ""}
<meta property="og:type" content="${type}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}"><meta property="og:image" content="${URL_BASE}assets/og.png"><meta property="og:site_name" content="ScreenPilot"><meta property="og:locale" content="${lang === "ar" ? "ar" : "en_US"}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0b132b">
<link rel="icon" href="${u}assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${u}assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${u}assets/site.css">
<script>try{var t=localStorage.getItem("sp-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>`;
}

const MARK = `<svg viewBox="24 12 92 104" aria-hidden="true"><path d="M44 32L44 96L96 64Z" class="m-fill" fill-opacity=".14"/><path d="M44 32L44 96L96 64ZM44 32L62 64L44 96M62 64L96 64" fill="none" class="m-line" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/><circle cx="44" cy="32" r="8" class="m-node"/><circle cx="44" cy="96" r="8" class="m-node"/><circle cx="96" cy="64" r="8" class="m-node"/><circle cx="62" cy="64" r="6" class="m-core"/></svg>`;
const GH = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const THEME = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>`;

function header({ lang, rel, altRel, current }) {
  const u = up(rel), ui = UI[lang], L = LANGS[lang], O = LANGS[L.other];
  const root = u + L.prefix;
  const links = `<a href="${root}guide/index.html"${current === "docs" ? " aria-current=page" : ""}>${ui.docs}</a><a href="${root}guide/install.html"${current === "install" ? " aria-current=page" : ""} class="hide-s">${ui.install}</a><a class="gh hide-s" href="${REPO}" rel="noopener">${GH}<span>${ui.github}</span></a>`;
  return `<body>
<a class="skip" href="#main">${ui.skip}</a>
<header class="top"><div class="wrap">
  <a class="brand" href="${root}index.html" aria-label="ScreenPilot">${MARK}<span>ScreenPilot</span></a>
  <nav class="nav" aria-label="Main">${links}<a class="lang" href="${altRel}" lang="${L.other}" hreflang="${L.other}">${O.name}</a><button class="theme" type="button" aria-label="${ui.theme}">${THEME}</button></nav>
</div></header>`;
}

function footer(lang, rel) {
  const u = up(rel), t = T[lang].foot, root = u + LANGS[lang].prefix;
  return `<footer class="foot"><div class="wrap">
  <div><a class="brand" href="${root}index.html">${MARK}<span>ScreenPilot</span></a><small>${esc(t.about)}</small><small>${esc(t.names)}</small></div>
  <div><h3>${t.learn}</h3><ul><li><a href="${root}guide/getting-started.html">${esc(pages[lang]["getting-started"]?.title ?? "Getting started")}</a></li><li><a href="${root}guide/tools.html">${esc(pages[lang].tools?.title ?? "Tools")}</a></li><li><a href="${root}guide/storyboard.html">${esc(pages[lang].storyboard?.title ?? "Storyboard")}</a></li><li><a href="${root}guide/faq.html">${esc(pages[lang].faq?.title ?? "FAQ")}</a></li></ul></div>
  <div><h3>${t.project}</h3><ul><li><a href="${REPO}">GitHub</a></li><li><a href="${REPO}/releases">${t.releases}</a></li><li><a href="${REPO}/issues">${t.issues}</a></li><li><a href="${REPO}/blob/main/CONTRIBUTING.md">${t.contributing}</a></li><li><a href="${REPO}/blob/main/SECURITY.md">${t.security}</a></li><li><a href="${REPO}/blob/main/LICENSE">${t.license}</a></li><li><a href="${REPO}/blob/main/THIRD_PARTY_NOTICES.md">${t.notices}</a></li></ul></div>
</div></footer>
<script src="${u}assets/app.js" defer></script>`;
}

// ---------- docs pages ----------
function prepareBody(body, lang, rel) {
  const root = up(rel) + LANGS[lang].prefix;
  const heads = [];
  let html = body.replace(/href="@/g, `href="${root}`);
  html = html.replace(/<(h[23])\s+id="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g, (_, tag, id, rest, inner) => {
    if (tag === "h2") heads.push({ id, text: inner.replace(/<[^>]+>/g, "") });
    return `<${tag} id="${id}"${rest}>${inner}<a class="a" href="#${id}" aria-label="${UI[lang].anchor}">#</a></${tag}>`;
  });
  return { html, heads };
}

function docPage(lang, id) {
  const p = pages[lang][id]; if (!p) return;
  const L = LANGS[lang], ui = UI[lang];
  const rel = `${L.prefix}guide/${id}.html`;
  const alt = { en: `guide/${id}.html`, ar: `ar/guide/${id}.html` };
  const altHref = (L.other === "ar" ? "../ar/guide/" : "../../guide/") + `${id}.html`;
  const { html, heads } = prepareBody(p.body, lang, rel);
  const i = order.indexOf(id), prev = pages[lang][order[i - 1]], next = pages[lang][order[i + 1]];
  const nav = GROUPS.map((g) => `<h3>${ui.groups[g.id]}</h3>${g.pages.filter((x) => pages[lang][x]).map((x) => `<a href="${x}.html"${x === id ? " aria-current=page" : ""}>${esc(pages[lang][x].title)}</a>`).join("")}`).join("");
  const toc = heads.length > 1 ? `<aside class="toc" aria-label="${ui.toc}"><h3>${ui.toc}</h3>${heads.map((h) => `<a href="#${h.id}">${esc(h.text)}</a>`).join("")}</aside>` : "";
  const pager = `<nav class="pager" aria-label="Pager">${prev ? `<a href="${order[i - 1]}.html" rel="prev"><small>${ui.prev}</small>${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a href="${order[i + 1]}.html" rel="next"><small>${ui.next}</small>${esc(next.title)}</a>` : "<span></span>"}</nav>`;
  write(rel, `${head({ lang, rel, title: `${p.title} · ScreenPilot`, desc: p.summary, alt, type: "article" })}
${header({ lang, rel, altRel: altHref, current: id === "install" ? "install" : "docs" })}
<main id="main"><div class="wrap docs">
  <nav class="side" aria-label="${ui.menu}"><details open><summary>${ui.menu}</summary>${nav}</details></nav>
  <article class="doc"><h1>${esc(p.title)}</h1><p class="summary">${esc(p.summary)}</p>${html}${pager}</article>
  ${toc}
</div></main>
${footer(lang, rel)}
</body></html>`);
}

function docIndex(lang) {
  const L = LANGS[lang], ui = UI[lang], rel = `${L.prefix}guide/index.html`;
  const alt = { en: "guide/index.html", ar: "ar/guide/index.html" };
  const altHref = L.other === "ar" ? "../ar/guide/index.html" : "../../guide/index.html";
  const groups = GROUPS.map((g) => `<h2 style="margin-top:2.2em">${ui.groups[g.id]}</h2><ul class="index-list">${g.pages.filter((x) => pages[lang][x]).map((x) => `<li><a href="${x}.html"><b>${esc(pages[lang][x].title)}</b><span>${esc(pages[lang][x].summary)}</span></a></li>`).join("")}</ul>`).join("");
  write(rel, `${head({ lang, rel, title: `${ui.indexTitle} · ScreenPilot`, desc: ui.indexSummary, alt })}
${header({ lang, rel, altRel: altHref, current: "docs" })}
<main id="main"><div class="wrap" style="padding:48px 0 90px;max-width:820px"><div class="doc" style="max-width:none"><h1>${ui.indexTitle}</h1><p class="summary">${ui.indexSummary}</p>${groups}</div></div></main>
${footer(lang, rel)}
</body></html>`);
}

function home(lang) {
  const L = LANGS[lang], t = T[lang], rel = `${L.prefix}index.html`;
  const alt = { en: "index.html", ar: "ar/index.html" };
  const altHref = L.other === "ar" ? "ar/index.html" : "../index.html";
  const guide = "guide/";
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "ScreenPilot", applicationCategory: "MultimediaApplication", operatingSystem: "Windows, macOS, Linux", softwareVersion: VERSION, license: "https://opensource.org/licenses/MIT", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, url: URL_BASE, inLanguage: ["en", "ar"] });
  write(rel, `${head({ lang, rel, title: t.ogTitle, desc: t.ogDesc, alt })}
<script type="application/ld+json">${ld.replace(/</g, "\\u003c")}</script>
${header({ lang, rel, altRel: altHref, current: "" })}
<div class="rail" aria-hidden="true"><div class="rail-head" data-tc="00:00"></div></div>
<main id="main">${landing(lang, { guide, media: up(rel) + "media/" })}</main>
${footer(lang, rel)}
<script src="${up(rel)}assets/editor.js" defer></script>
</body></html>`);
}

function notFound() {
  const lang = "en", rel = "404.html", ui = UI.en;
  write(rel, `${head({ lang, rel, title: `${ui.notFound} · ScreenPilot`, desc: ui.notFoundText, noindex: true })}
${header({ lang, rel, altRel: "ar/index.html", current: "" })}
<main id="main"><div class="wrap" style="padding:90px 0"><div class="doc"><h1>${ui.notFound}</h1><p class="summary">${ui.notFoundText}</p><p><a class="btn btn-primary" href="index.html">${ui.home}</a> <a class="btn btn-quiet" href="guide/index.html">${ui.docs}</a></p></div></div></main>
${footer(lang, rel)}
</body></html>`);
}

// ---------- run ----------
for (const f of ["guide", "ar", "assets", "index.html", "404.html", "sitemap.xml", "robots.txt"]) rmSync(join(OUT, f), { recursive: true, force: true });
mkdirSync(join(OUT, "assets"), { recursive: true });
for (const f of readdirSync(join(SITE, "static"))) copyFileSync(join(SITE, "static", f), join(OUT, "assets", f));
copyFileSync(join(ROOT, "assets", "logo", "favicon.svg"), join(OUT, "assets", "favicon.svg"));
copyFileSync(join(ROOT, "assets", "logo", "screenpilot.svg"), join(OUT, "assets", "screenpilot.svg"));
for (const lang of Object.keys(LANGS)) { home(lang); docIndex(lang); for (const id of order) docPage(lang, id); }
notFound();
const urls = ["", "ar/", "guide/", "ar/guide/", ...order.flatMap((p) => [`guide/${p}.html`, `ar/guide/${p}.html`])].filter((u) => !u.includes("guide/") || u.endsWith("/") || existsSync(join(OUT, u)));
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${URL_BASE}${u}</loc></url>`).join("\n")}\n</urlset>\n`);
write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${URL_BASE}sitemap.xml\n`);
const missing = Object.entries(pages).flatMap(([l, ps]) => Object.entries(ps).filter(([, v]) => !v).map(([k]) => `${l}/${k}`));
console.log(`built docs/ (${urls.length} pages)${missing.length ? `; missing content: ${missing.join(", ")}` : ""}`);

// ---------- check every relative link and asset ----------
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const broken = [];
for (const f of walk(OUT).filter((x) => x.endsWith(".html"))) {
  const html = readFileSync(f, "utf8");
  for (const [, , ref] of html.matchAll(/\s(href|src|poster)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|data:|#|\/\/)/.test(ref)) continue;
    const target = resolve(dirname(f), decodeURI(ref.split("#")[0].split("?")[0] || "."));
    const ok = existsSync(target) && (!statSync(target).isDirectory() || existsSync(join(target, "index.html")));
    if (!ok) broken.push(`${f.slice(OUT.length + 1)} -> ${ref}`);
    else if (ref.includes("#") && target.endsWith(".html") && !readFileSync(target, "utf8").includes(`id="${ref.split("#")[1]}"`)) broken.push(`${f.slice(OUT.length + 1)} -> ${ref} (no such anchor)`);
  }
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) if (!html.includes(`id="${id}"`)) broken.push(`${f.slice(OUT.length + 1)} -> #${id}`);
}
if (broken.length) { console.error(`broken links (${broken.length}):\n  ${broken.join("\n  ")}`); process.exitCode = 1; } else console.log("all internal links resolve");
