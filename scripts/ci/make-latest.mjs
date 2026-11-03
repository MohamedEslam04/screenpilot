// Write latest.json for a release from the app-<platform>.json notes the package jobs leave.
//   node scripts/ci/make-latest.mjs <folder with the release files> [--repo owner/name] [--tag v1.2.3]
// Run after the files got their version-free names. The notes are removed; latest.json is written.
// It checks every archive against its note, so a mismatch fails the release before it is published.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = process.argv[2];
const repo = arg("--repo") ?? process.env.GITHUB_REPOSITORY;
const tag = arg("--tag") ?? process.env.GITHUB_REF_NAME;
if (!dir || !repo || !tag) {
  console.error("usage: make-latest.mjs <folder> [--repo owner/name] [--tag v1.2.3]");
  process.exit(2);
}

const notes = readdirSync(dir).filter((f) => /^app-.+\.json$/.test(f));
if (!notes.length) throw new Error(`no app-*.json notes in ${dir}`);

const version = tag.replace(/^v/, "");
const platforms = {};
for (const f of notes.sort()) {
  const n = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (n.version !== version) throw new Error(`${f}: version ${n.version} is not the tag's ${version}`);
  const archive = join(dir, n.file);
  if (!existsSync(archive)) throw new Error(`${f}: ${n.file} is not in ${dir}`);
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (n.sha256 && n.sha256 !== sha256) throw new Error(`${f}: SHA-256 of ${n.file} differs from the package job's note`);
  if (platforms[n.key]) throw new Error(`two notes for ${n.key}`);
  platforms[n.key] = {
    file: n.file,
    url: `https://github.com/${repo}/releases/download/${tag}/${n.file}`,
    sha256,
    size: statSync(archive).size,
    runtime: n.runtime,
  };
  rmSync(join(dir, f));
}

writeFileSync(join(dir, "latest.json"), `${JSON.stringify({ version, platforms }, null, 2)}\n`);
console.log(`latest.json: ${version} for ${Object.keys(platforms).join(", ")}`);
