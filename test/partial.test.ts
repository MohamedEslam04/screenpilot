import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { partialPath, writeAtomically } from "../src/util/partial.js";

describe("partial output file", () => {
  it("names <name>.partial.<ext>", () => {
    expect(partialPath("/v/demo.mp4")).toBe("/v/demo.partial.mp4");
    expect(partialPath("/v/demo.part-1-2.mp4")).toBe("/v/demo.part-1-2.partial.mp4");
  });

  it("renames the partial file on success: the final name never holds a half-written file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-partial-"));
    const out = join(dir, "demo.mp4");
    const r = await writeAtomically(out, async (tmp) => {
      expect(tmp).toBe(join(dir, "demo.partial.mp4"));
      await writeFile(tmp, "video");
      expect(existsSync(out)).toBe(false);
      return 7;
    });
    expect(r).toBe(7);
    expect(await readFile(out, "utf8")).toBe("video");
    expect(existsSync(partialPath(out))).toBe(false);
  });

  it("removes the partial file on failure and keeps an earlier finished file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-partial-"));
    const out = join(dir, "demo.mp4");
    await writeFile(out, "old");
    await expect(
      writeAtomically(out, async (tmp) => {
        await writeFile(tmp, "half");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(partialPath(out))).toBe(false);
    expect(await readFile(out, "utf8")).toBe("old");
  });
});
