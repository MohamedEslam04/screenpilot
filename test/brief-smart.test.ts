import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject, loadUsual, mergeSuggested, saveUsual } from "../src/brief/context.js";
import { type ElicitRequest, elicitBrief } from "../src/brief/elicit.js";
import { applyAnswers, askView, buildBrief, type BriefEnv, nextBatch, pending, recommendedAnswers, summaryLines } from "../src/brief/questions.js";

const baseEnv: BriefEnv = { localVoice: false, commandVoices: [], desktop: { id: "kde", windowControl: true } };

let dir: string;
let oldXdg: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brief-smart-"));
  oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "config"); // never the real config folder
});
afterEach(() => {
  if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldXdg;
});

const writeSb = (sb: unknown, name = "storyboard.json", where = dir) => {
  const p = join(where, name);
  writeFileSync(p, JSON.stringify(sb));
  return p;
};

describe("detectProject", () => {
  it("reads the choices an existing video was made with (website voice, Egyptian Arabic, landscape)", async () => {
    writeSb({
      source: "raw.mkv",
      voice: { provider: "edge", name: "ar-EG-SalmaNeural" },
      output: { width: 1920, height: 1080 },
      narration: [
        { at: 1, text: "ده أول سطر", audio: "voice/01.mp3" },
        { at: 5, text: "وده تاني", audio: "voice/02.mp3" },
      ],
    });
    const hint = await detectProject(dir);
    expect(hint).toBeDefined();
    expect(hint!.answers).toMatchObject({ voice_source: "external", voice_external: "other", language: "ar-EG", goal: "youtube", source: "existing" });
    expect(hint!.summary).toMatch(/2 narration lines/);
    expect(hint!.content).toMatch(/ده أول سطر/);
  });

  it("keeps the built-in voice when lines have no audio files, and tells local models and command voices apart", async () => {
    writeSb({ voice: { provider: "edge", name: "en-US-AndrewNeural" }, narration: [{ at: 1, text: "Hello there" }] });
    expect((await detectProject(dir))!.answers).toMatchObject({ voice_source: "builtin", voice_builtin: "edge", language: "en" });
    writeSb({ voice: { provider: "local", name: "voicetut:Sarah" }, narration: [{ at: 1, text: "Hello" }] });
    expect((await detectProject(dir))!.answers).toMatchObject({ voice_source: "builtin", voice_builtin: "local" });
    writeSb({ voice: { provider: "command", name: "piper" }, narration: [{ at: 1, text: "Hello" }] });
    expect((await detectProject(dir))!.answers).toMatchObject({ voice_source: "own", voice_own: "command" });
  });

  it("maps the output size to where the video is shown", async () => {
    writeSb({ output: { width: 1080, height: 1920 }, narration: [] });
    expect((await detectProject(dir))!.answers.goal).toBe("social-vertical");
    writeSb({ output: { width: 1080, height: 1080 }, narration: [] });
    expect((await detectProject(dir))!.answers.goal).toBe("social-square");
  });

  it("recognises Arabic text and bilingual lines when the voice does not say", async () => {
    writeSb({ narration: [{ at: 1, text: "مرحبا بكم في الشرح" }] });
    expect((await detectProject(dir))!.answers.language).toBe("ar-EG");
    writeSb({ narration: [{ at: 1, text: "Welcome مرحبا" }] });
    expect((await detectProject(dir))!.answers.language).toBe("bilingual");
  });

  it("takes a file path, the newest storyboard in a folder, or nothing", async () => {
    expect(await detectProject(join(dir, "nope"))).toBeUndefined();
    expect(await detectProject(dir)).toBeUndefined();
    writeFileSync(join(dir, "storyboard.json"), "{ not json");
    expect(await detectProject(dir)).toBeUndefined();
    const old = writeSb({ voice: { provider: "edge", name: "en-US-AndrewNeural" }, narration: [{ at: 1, text: "Hi" }] }, "old.storyboard.json");
    utimesSync(old, new Date(2020, 1, 1), new Date(2020, 1, 1));
    writeSb({ voice: { provider: "edge", name: "ar-EG-SalmaNeural" }, narration: [{ at: 1, text: "Hi" }] }, "new.storyboard.json");
    expect((await detectProject(dir))!.answers.language).toBe("ar-EG");
    expect((await detectProject(old))!.answers.language).toBe("en");
  });

  it("looks one level down for a session folder's storyboard", async () => {
    const sub = join(dir, "2026-11-04T10-00-00");
    mkdirSync(sub);
    writeSb({ voice: { provider: "edge", name: "en-US-AndrewNeural" }, narration: [{ at: 1, text: "Hi" }] }, "storyboard.json", sub);
    expect((await detectProject(dir))!.file).toContain("2026-11-04T10-00-00");
  });
});

describe("usual choices", () => {
  it("are saved after a video and read back, without the content", () => {
    expect(loadUsual()).toEqual({});
    saveUsual({ content: "a private demo", goal: "youtube", language: "ar-EG", voice_source: "external", permissions: "allow" });
    expect(loadUsual()).toEqual({ goal: "youtube", language: "ar-EG", voice_source: "external", permissions: "allow" });
  });

  it("survive a broken file", () => {
    saveUsual({ goal: "youtube" });
    writeFileSync(join(process.env.XDG_CONFIG_HOME!, "screenpilot", "brief.json"), "{{");
    expect(loadUsual()).toEqual({});
  });
});

describe("mergeSuggested", () => {
  it("prefers the project over the usual choices and says where each came from", () => {
    const s = mergeSuggested({ file: "/x/storyboard.json", summary: "s", answers: { language: "ar-EG", voice_source: "external" } }, { language: "en", goal: "docs" });
    expect(s.answers).toEqual({ language: "ar-EG", voice_source: "external", goal: "docs" });
    expect(s.from).toEqual({ language: "project", voice_source: "project", goal: "usual" });
  });
});

describe("buildBrief with suggestions", () => {
  const suggested = mergeSuggested({ file: "/x/storyboard.json", summary: "s", answers: { voice_source: "external", language: "ar-EG" }, content: "Update the safha demo" }, { shot: "screen" });
  const brief = buildBrief({ ...baseEnv, suggested });

  it("recommends the project's voice instead of the fixed built-in one, first in the list", () => {
    const q = brief.questions.find((x) => x.id === "voice_source")!;
    expect(q.options[0]!.value).toBe("external");
    expect(q.options[0]!.recommended).toBe(true);
    expect(q.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(q.options[0]!.description).toMatch(/existing video/i);
    expect(askView([q]).choices[0]!.options[0]!.label).toMatch(/\(Recommended\)$/);
  });

  it("uses the user's usual choice where the project says nothing, and keeps the static one elsewhere", () => {
    expect(brief.questions.find((x) => x.id === "shot")!.options[0]!.value).toBe("screen");
    expect(brief.questions.find((x) => x.id === "shot")!.options[0]!.description).toMatch(/usual/i);
    expect(brief.questions.find((x) => x.id === "review")!.options[0]!.value).toBe("draft-first");
  });

  it("never recommends an option that is not available here", () => {
    const b = buildBrief({ ...baseEnv, suggested: mergeSuggested(undefined, { voice_builtin: "local", voice_source: "builtin" }) });
    const q = b.questions.find((x) => x.id === "voice_builtin")!;
    expect(q.options.find((o) => o.recommended)!.value).toBe("edge");
  });

  it("makes content optional and offers the project's description as its suggestion", () => {
    const q = brief.questions.find((x) => x.id === "content")!;
    expect(q.optional).toBe(true);
    expect(q.suggestion).toBe("Update the safha demo");
  });
});

describe("optional content", () => {
  const brief = buildBrief(baseEnv);
  const all = { goal: "youtube", source: "record", language: "en", voice_source: "silent", look: "default", shot: "window", review: "draft-first", permissions: "ask" };

  it("does not block: the brief is done without it", () => {
    expect(pending(brief, all)).toEqual([]);
    expect(pending(brief, {}).map((q) => q.id)).not.toContain("content");
  });

  it("still shows up among the questions so the user can fill it in", () => {
    expect(nextBatch(brief, {}).map((q) => q.id)).toContain("content");
  });

  it("can be skipped with a blank answer without being reported as rejected", () => {
    const r = applyAnswers(brief, {}, { content: "   " });
    expect(r.rejected).toEqual([]);
    expect(r.answers.content).toBe("");
    expect(nextBatch(brief, r.answers).map((q) => q.id)).not.toContain("content");
  });
});

describe("recommendedAnswers", () => {
  it("fills every question that applies with the recommended option, following the follow-ups", () => {
    const suggested = mergeSuggested({ file: "/x", summary: "s", answers: { voice_source: "external", voice_external: "other", language: "ar-EG" } }, undefined);
    const brief = buildBrief({ ...baseEnv, suggested });
    const a = recommendedAnswers(brief, {});
    expect(a).toMatchObject({ voice_source: "external", voice_external: "other", language: "ar-EG", review: "draft-first", shot: "window", look: "default" });
    expect(a.voice_builtin).toBeUndefined();
    expect(pending(brief, a)).toEqual([]);
  });

  it("keeps answers already given and uses the content suggestion only when there is one", () => {
    const brief = buildBrief({ ...baseEnv, suggested: mergeSuggested({ file: "/x", summary: "s", answers: {}, content: "Update the demo" }, undefined) });
    const a = recommendedAnswers(brief, { language: "en" });
    expect(a.language).toBe("en");
    expect(a.content).toBe("Update the demo");
    expect(recommendedAnswers(buildBrief(baseEnv), {}).content).toBeUndefined();
  });

  it("describes the setup in one line per decision", () => {
    const brief = buildBrief(baseEnv);
    const lines = summaryLines(brief, recommendedAnswers(brief, {}));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.join("\n")).toMatch(/Voice: Built-in voice/);
    expect(lines.join("\n")).not.toMatch(/Content/);
  });
});

describe("elicitBrief with the one-question shortcut", () => {
  const suggested = mergeSuggested({ file: "/x", summary: "s", answers: { voice_source: "external", voice_external: "other", language: "ar-EG" } }, undefined);
  const brief = buildBrief({ ...baseEnv, suggested });

  it("asks one question first and confirms the whole recommended setup on 'use'", async () => {
    const forms: ElicitRequest[] = [];
    const r = await elicitBrief(
      brief,
      async (req) => {
        forms.push(req);
        return { action: "accept", content: { setup: "use" } };
      },
      {},
      { quick: true },
    );
    expect(forms).toHaveLength(1);
    expect(Object.keys(forms[0]!.requestedSchema.properties)).toEqual(["setup"]);
    expect(forms[0]!.message).toMatch(/Voice: A website's voice/);
    expect(r.status).toBe("confirmed");
    expect(r.answers).toMatchObject({ voice_source: "external", language: "ar-EG", review: "draft-first" });
  });

  it("falls back to the detailed forms on 'choose', with the recommended option as each default", async () => {
    const forms: ElicitRequest[] = [];
    await elicitBrief(
      brief,
      async (req) => {
        forms.push(req);
        return forms.length === 1 ? { action: "accept", content: { setup: "choose" } } : { action: "cancel" };
      },
      {},
      { quick: true },
    );
    expect(forms).toHaveLength(2);
    expect(forms[1]!.requestedSchema.properties.language!.default).toBe("ar-EG");
    expect(forms[1]!.requestedSchema.required).not.toContain("content");
  });

  it("does not offer the shortcut when asked not to", async () => {
    const forms: ElicitRequest[] = [];
    await elicitBrief(brief, async (req) => (forms.push(req), { action: "cancel" }), {});
    expect(Object.keys(forms[0]!.requestedSchema.properties)).not.toContain("setup");
  });
});
