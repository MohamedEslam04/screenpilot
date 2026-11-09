// Runs before first paint (external file: no inline script, CSP friendly).
try {
  const t = localStorage.getItem("sp-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
