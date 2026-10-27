// Fail when the longest file in a package would exceed Windows' practical path limit
// once extracted (Explorer's zip extractor and many tools break past ~260 chars).
//   node scripts/ci/check-paths.mjs <stage folder> [limit=250]
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [stage, limitArg] = process.argv.slice(2);
if (!stage) throw new Error("usage: check-paths.mjs <stage folder> [limit]");
const limit = Number(limitArg ?? 250);
const version = process.env.PKG_VERSION ?? "0.1.0";

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(relative(stage, p).split(sep).join("\\"));
  }
})(stage);
files.sort((a, b) => b.length - a.length);
const longest = files[0] ?? "";

// Worst realistic places: a zip extracted in Downloads by a user with a long name, and the per-user install folder.
const prefixes = {
  zip: `C:\\Users\\abcdefghijklmnopqrst\\Downloads\\ScreenPilot-${version}-windows\\ScreenPilot\\`,
  install: `C:\\Users\\abcdefghijklmnopqrst\\AppData\\Local\\ScreenPilot\\`,
};
let bad = false;
console.log(`${files.length} files; longest relative path is ${longest.length} chars:\n  ${longest}`);
for (const [name, prefix] of Object.entries(prefixes)) {
  const total = prefix.length + longest.length;
  console.log(`${name}: ${prefix.length} + ${longest.length} = ${total} (limit ${limit})`);
  if (total > limit) bad = true;
}
if (bad) {
  console.error("Path too long. Longest files:");
  for (const f of files.slice(0, 10)) console.error(`  ${f.length}  ${f}`);
  process.exit(1);
}
