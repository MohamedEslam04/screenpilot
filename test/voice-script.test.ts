import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoryboardSchema } from "../src/storyboard/schema.js";
import { attachAudio } from "../src/voice/attach.js";
import { buildScript } from "../src/voice/script.js";

const sb = (narration: unknown[], voice: Record<string, unknown> = {}) =>
  StoryboardSchema.parse({ source: "a.mp4", segments: [{ in: 0, out: 30, speed: 1 }], narration, voice });

describe("buildScript", () => {
  const board = sb(
    [
      { at: 10, text: "ثم نضغط على حفظ." },
      { at: 2, text: "مرحباً بكم في التطبيق." },
    ],
    { name: "ar-EG-SalmaNeural" },
  );

  it("orders the lines by time and gives each the room before the next one", () => {
    const s = buildScript(board);
    expect(s.lines.map((l) => l.text)).toEqual(["مرحباً بكم في التطبيق.", "ثم نضغط على حفظ."]);
    expect(s.lines[0]).toMatchObject({ number: 1, at: 2, room: 8 });
    expect(s.lines[1]).toMatchObject({ number: 2, at: 10, room: 20 }); // to the end of the kept video
  });

  it("gives a paste block with a blank line between lines and no numbers", () => {
    const s = buildScript(board);
    expect(s.plain).toBe("مرحباً بكم في التطبيق.\n\nثم نضغط على حفظ.");
  });

  it("names the dialect from the voice and asks for pauses in the prompt", () => {
    const s = buildScript(board);
    expect(s.language).toBe("Egyptian Arabic");
    expect(s.markdown).toContain("Egyptian Arabic");
    expect(s.markdown).toMatch(/pause/i);
    expect(s.markdown).toContain(s.plain);
  });

  it("falls back to English for English text and to the text language otherwise", () => {
    expect(buildScript(sb([{ at: 1, text: "Open the panel." }], { name: "en-US-AndrewNeural" })).language).toBe("English");
    expect(buildScript(sb([{ at: 1, text: "Open the panel." }], { name: "voicetut:Sarah" })).language).toBe("the language of the text");
  });

  it("is empty-safe", () => {
    const s = buildScript(sb([]));
    expect(s.lines).toEqual([]);
    expect(s.plain).toBe("");
  });
});

describe("attachAudio", () => {
  it("sets audio on the lines in time order, relative to the storyboard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-attach-"));
    const path = join(dir, "storyboard.json");
    await writeFile(path, JSON.stringify({ source: "a.mp4", narration: [{ at: 9, text: "b" }, { at: 1, text: "a" }] }));
    await attachAudio(path, [join(dir, "narration-audio", "01.wav"), join(dir, "narration-audio", "02.wav")]);
    const out = JSON.parse(await readFile(path, "utf8"));
    expect(out.narration[1].audio).toBe("narration-audio/01.wav"); // at 1 = first spoken
    expect(out.narration[0].audio).toBe("narration-audio/02.wav");
    expect(out.source).toBe("a.mp4");
  });

  it("refuses when the number of files does not match the lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-attach-"));
    const path = join(dir, "storyboard.json");
    await writeFile(path, JSON.stringify({ source: "a.mp4", narration: [{ at: 1, text: "a" }] }));
    await expect(attachAudio(path, [join(dir, "1.wav"), join(dir, "2.wav")])).rejects.toThrow(/2 audio file\(s\).*1 narration line/s);
  });
});
