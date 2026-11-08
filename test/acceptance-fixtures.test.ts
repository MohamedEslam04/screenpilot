import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pageUrl } from "../src/take/perform.js";
import { type Step, TakeSchema } from "../src/take/schema.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "acceptance");
const page = readFileSync(join(dir, "page.html"), "utf8");

function load(name: string) {
  return TakeSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
}

/** Every `#id` selector a take uses in a web target, highlight or browser step. */
function selectors(steps: Step[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if ("click" in s && "web" in s.click) out.push(s.click.web);
    if ("highlight" in s) out.push(s.highlight.web);
    if ("waitFor" in s && "web" in s.waitFor) out.push(s.waitFor.web);
  }
  return out;
}

describe("acceptance fixtures", () => {
  for (const name of ["take.json", "covered.json", "covered-force.json"]) {
    it(`${name} parses with the take schema and only uses ids the page has`, () => {
      const take = load(name);
      const all = [...take.setup, ...take.steps];
      for (const sel of selectors(all)) {
        expect(sel).toMatch(/^#[\w-]+$/);
        expect(page, sel).toContain(`id="${sel.slice(1)}"`);
      }
    });

    it(`${name} opens the page through a path that resolves to a file URL`, () => {
      const take = load(name);
      const urls = [...take.setup, ...take.steps].flatMap((s) => ("browser" in s && "url" in s.browser && s.browser.url ? [s.browser.url] : []));
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) {
        expect(pageUrl(u, dir)).toMatch(/^file:\/\/.*\/scripts\/acceptance\/page\.html$/);
      }
    });
  }

  it("take.json exercises the 0.9.0 features", () => {
    const take = load("take.json");
    const all = [...take.setup, ...take.steps];
    const ids = all.flatMap((s) => ("browser" in s && "id" in s.browser && s.browser.id ? [s.browser.id] : []));
    expect(ids).toEqual(["main", "user"]);
    expect(all.some((s) => "tile" in s && s.tile.browsers.join() === "main,user")).toBe(true);
    expect(all.filter((s) => "highlight" in s && s.highlight.until === "gone")).toHaveLength(2);
    expect(all.some((s) => "type" in s && s.method === "auto" && /[؀-ۿ]/.test(String(s.type)))).toBe(true);
    expect(all.some((s) => "run" in s && s.wait === true)).toBe(true);
    expect(all.some((s) => "focus" in s && s.focus.browser === "user")).toBe(true);
  });

  it("covered.json has no force, covered-force.json forces only the covered click", () => {
    const clicks = (name: string) => load(name).steps.filter((s) => "click" in s && "web" in s.click) as Extract<Step, { click: unknown }>[];
    const plain = clicks("covered.json");
    expect(plain.map((s) => (s.click as { web: string }).web)).toEqual(["#visible-btn", "#covered-btn"]);
    expect(plain.every((s) => s.force === undefined)).toBe(true);
    const forced = clicks("covered-force.json");
    expect(forced.map((s) => s.force)).toEqual([undefined, true]);
  });

  it("the covered button is under a sticky header on a page that cannot scroll", () => {
    expect(page).toMatch(/#site-header\s*\{[^}]*position:\s*sticky/);
    expect(page).toMatch(/overflow:\s*hidden/);
    expect(page).toContain('id="covered-btn"');
    expect(page).toContain('id="visible-btn"');
  });
});
