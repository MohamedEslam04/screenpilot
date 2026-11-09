import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHistory, recordEvent } from "../src/history/index.js";
import { PROJECT_FILE } from "../src/project.js";
import { newSessionDir } from "../src/record/index.js";

let root: string;
let oldOut: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sp-recproj-"));
  oldOut = process.env.SCREENPILOT_OUTPUT;
  process.env.SCREENPILOT_OUTPUT = join(root, "default");
  vi.spyOn(process, "cwd").mockReturnValue(root); // never the real working directory: a .screenpilot.json there would change the result
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldOut === undefined) delete process.env.SCREENPILOT_OUTPUT;
  else process.env.SCREENPILOT_OUTPUT = oldOut;
  rmSync(root, { recursive: true, force: true });
});

const project = () => {
  const p = join(root, "proj");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, PROJECT_FILE), JSON.stringify({ output: "videos" }));
  return p;
};
const at = new Date(2026, 10, 9, 20, 30, 15);

describe("where a new recording goes", () => {
  it("the project's video folder when it has a .screenpilot.json", () => {
    const p = project();
    expect(newSessionDir({ project: join(p, "src") }, at)).toBe(join(p, "videos", "2026-11-09_20-30-15"));
  });

  it("an explicit dir beats the project", () => {
    expect(newSessionDir({ dir: join(root, "mine"), project: project() }, at)).toBe(join(root, "mine"));
  });

  it("the default folder when the project has no file, or none is given", () => {
    expect(newSessionDir({ project: join(root, "nofile") }, at)).toBe(join(root, "default", "2026-11-09_20-30-15"));
    expect(newSessionDir({}, at)).toBe(resolve(root, "default", "2026-11-09_20-30-15"));
  });

  it("a recording in a project folder still shows in the history (the dashboard reads it)", async () => {
    const file = join(root, "history.jsonl");
    const path = newSessionDir({ project: project() }, at);
    await recordEvent({ kind: "record", status: "ok", path }, file);
    const rows = await readHistory({ file });
    expect(rows.map((r) => r.path)).toEqual([path]);
    expect(path.startsWith(process.env.SCREENPILOT_OUTPUT!)).toBe(false);
  });
});
