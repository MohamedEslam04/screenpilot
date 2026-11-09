import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outputRoot } from "../src/brand.js";
import { findProjectFile, PROJECT_FILE, projectOutput, writeProjectOutput } from "../src/project.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sp-project-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (dir: string, json: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PROJECT_FILE), typeof json === "string" ? json : JSON.stringify(json));
};

describe(".screenpilot.json", () => {
  it("is found in a parent folder, from a folder or a file path", () => {
    put(root, { output: "videos" });
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "x.json"), "{}");
    expect(findProjectFile(deep)).toBe(join(root, PROJECT_FILE));
    expect(projectOutput(deep)).toBe(join(root, "videos"));
    expect(projectOutput(join(deep, "x.json"))).toBe(join(root, "videos"));
    expect(projectOutput(join(deep, "not-yet-created", "y.json"))).toBe(join(root, "videos"));
  });

  it("the nearest file wins and output is relative to its own folder", () => {
    put(root, { output: "outer" });
    put(join(root, "app"), { output: "media/demos" });
    expect(projectOutput(join(root, "app", "src"))).toBe(join(root, "app", "media", "demos"));
    expect(projectOutput(join(root, "other"))).toBe(join(root, "outer"));
  });

  it("is undefined when no file exists up the tree", () => {
    expect(projectOutput(join(root, "x"))).toBeUndefined();
  });

  it("rejects an output outside the project folder", () => {
    for (const output of ["/etc", resolve("/tmp/x"), "../up", "a/../../up", "", "."]) {
      put(root, { output });
      expect(() => projectOutput(root), output).toThrow(PROJECT_FILE);
    }
  });

  it("names the file for bad JSON and unknown keys", () => {
    put(root, "{nope");
    expect(() => projectOutput(root)).toThrow(join(root, PROJECT_FILE));
    put(root, { output: "v", extra: 1 });
    expect(() => projectOutput(root)).toThrow(/extra/);
    put(root, {});
    expect(() => projectOutput(root)).toThrow(/output/);
  });

  it("writeProjectOutput creates the file and refuses an outside folder", () => {
    const file = writeProjectOutput(root, "videos");
    expect(file).toBe(join(root, PROJECT_FILE));
    expect(projectOutput(root)).toBe(join(root, "videos"));
    expect(() => writeProjectOutput(root, "../x")).toThrow(/inside/);
    expect(projectOutput(root)).toBe(join(root, "videos"));
  });

  it("outputRoot: project folder, else the env folder", () => {
    const old = process.env.SCREENPILOT_OUTPUT;
    process.env.SCREENPILOT_OUTPUT = join(root, "default");
    try {
      expect(outputRoot(join(root, "p"))).toBe(join(root, "default"));
      put(join(root, "p"), { output: "videos" });
      expect(outputRoot(join(root, "p", "src"))).toBe(join(root, "p", "videos"));
    } finally {
      if (old === undefined) delete process.env.SCREENPILOT_OUTPUT;
      else process.env.SCREENPILOT_OUTPUT = old;
    }
  });
});
