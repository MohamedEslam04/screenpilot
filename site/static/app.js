/* Small shared behaviour: theme switch, code copy buttons, install tabs, the landing chapter rail, the docs table of contents. */
(() => {
  const root = document.documentElement;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  // theme: system by default, then light/dark on click
  const themeBtn = document.querySelector(".theme");
  const isDark = () => root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  themeBtn?.addEventListener("click", () => { const next = isDark() ? "light" : "dark"; root.dataset.theme = next; store.set("sp-theme", next); });

  // copy buttons on code blocks
  document.querySelectorAll(".doc pre").forEach((pre) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "copy"; b.textContent = document.documentElement.dataset.copy || "Copy";
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText); b.textContent = root.dataset.copied || "Copied"; } catch { b.textContent = "!"; }
      setTimeout(() => (b.textContent = root.dataset.copy || "Copy"), 1600);
    });
    pre.appendChild(b);
  });
  // wrap tables so wide ones scroll on small screens
  document.querySelectorAll(".doc table").forEach((t) => { const w = document.createElement("div"); w.className = "tw"; t.replaceWith(w); w.appendChild(t); });

  // install tabs (landing): pick the visitor's system first
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  if (tabs.length) {
    const pick = (id) => tabs.forEach((t) => {
      const on = t.dataset.os === id; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
    const ua = navigator.userAgent;
    pick(/Windows/i.test(ua) ? "windows" : /Mac/i.test(ua) ? "macos" : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? "linux" : "windows");
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => pick(t.dataset.os));
      t.addEventListener("keydown", (e) => {
        const n = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!n) return;
        const nx = tabs[(i + n + tabs.length) % tabs.length]; nx.focus(); pick(nx.dataset.os);
      });
    });
  }

  // landing: a chapter rail whose playhead follows the scroll position
  const rail = document.querySelector(".rail");
  if (rail) {
    const chapters = [...document.querySelectorAll("[data-chapter]")];
    const head = rail.querySelector(".rail-head");
    const total = () => document.documentElement.scrollHeight - innerHeight;
    const place = () => {
      const p = Math.min(1, Math.max(0, scrollY / Math.max(1, total())));
      head.style.top = p * 100 + "%";
      const s = Math.round(p * 96); head.dataset.tc = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    const layout = () => {
      rail.querySelectorAll("i,b").forEach((n) => n.remove());
      chapters.forEach((c) => {
        const y = (c.getBoundingClientRect().top + scrollY) / Math.max(1, document.documentElement.scrollHeight) * 100;
        const i = document.createElement("i"); i.style.top = y + "%"; const b = document.createElement("b"); b.style.top = y + "%"; b.textContent = c.dataset.chapter;
        rail.append(i, b);
      });
    };
    addEventListener("scroll", place, { passive: true }); addEventListener("resize", () => { layout(); place(); });
    addEventListener("load", () => { layout(); place(); }); layout(); place();
  }

  // docs: highlight the section in view in the table of contents
  const toc = [...document.querySelectorAll(".toc a")];
  if (toc.length && "IntersectionObserver" in window) {
    const map = new Map(toc.map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { toc.forEach((a) => a.classList.remove("on")); map.get(e.target.id)?.classList.add("on"); } }), { rootMargin: "-80px 0px -70% 0px" });
    map.forEach((_, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
