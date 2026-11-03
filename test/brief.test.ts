import { describe, expect, it } from "vitest";
import { applyAnswers, askView, buildBrief, guidance, nextBatch, type BriefEnv } from "../src/brief/questions.js";

const env: BriefEnv = { localVoice: false, commandVoices: [], desktop: { id: "kde", windowControl: true } };
const brief = buildBrief(env);
const choice = brief.questions.filter((q) => q.kind === "choice");

describe("buildBrief", () => {
  it("fits the option pickers clients show: 2 to 4 options, short headers", () => {
    for (const q of choice) {
      expect(q.options.length, q.id).toBeGreaterThanOrEqual(2);
      expect(q.options.length, q.id).toBeLessThanOrEqual(4);
      expect(q.header.length, q.id).toBeLessThanOrEqual(12);
      expect(q.question.endsWith("?"), q.id).toBe(true);
      expect(new Set(q.options.map((o) => o.value)).size, q.id).toBe(q.options.length);
    }
  });

  it("covers every decision the user must make before anything is built", () => {
    const ids = brief.questions.map((q) => q.id);
    for (const id of ["goal", "content", "source", "language", "voice_source", "look", "shot", "review", "permissions"]) expect(ids).toContain(id);
  });

  it("offers the voice choices: none, built-in, a website, or the user's own", () => {
    const q = brief.questions.find((x) => x.id === "voice_source")!;
    expect(q.options.map((o) => o.value)).toEqual(["builtin", "external", "own", "silent"]);
    expect(q.options.find((o) => o.value === "external")!.description).toMatch(/Google AI Studio/);
    expect(q.options.find((o) => o.value === "external")!.description).toMatch(/commercial/i);
  });

  it("says what is installed on this machine", () => {
    const withLocal = buildBrief({ localVoice: true, commandVoices: ["piper"], desktop: undefined });
    const builtin = withLocal.questions.find((q) => q.id === "voice_builtin")!;
    expect(builtin.options.find((o) => o.value === "local")!.available).toBe(true);
    expect(brief.questions.find((q) => q.id === "voice_builtin")!.options.find((o) => o.value === "local")!.description).toMatch(/voice-setup/);
    expect(withLocal.questions.find((q) => q.id === "voice_own")!.options.find((o) => o.value === "command")!.description).toContain("piper");
    expect(withLocal.questions.find((q) => q.id === "source")!.options.find((o) => o.value === "agent")!.description).toMatch(/could not detect|doctor/i);
  });

  it("the recommended option comes first", () => {
    const q = brief.questions.find((x) => x.id === "review")!;
    expect(q.options[0]!.value).toBe("draft-first");
    expect(q.options[0]!.recommended).toBe(true);
  });
});

describe("nextBatch", () => {
  it("asks up to four at a time and never a follow-up with its parent in the same batch", () => {
    const first = nextBatch(brief, {});
    expect(first.length).toBeLessThanOrEqual(4);
    expect(first.some((q) => q.id.startsWith("voice_") && q.id !== "voice_source")).toBe(false);
  });

  it("asks only the follow-up that matches the voice answer", () => {
    const ids = (a: Record<string, string>) => nextBatch(brief, a).map((q) => q.id);
    const base = { content: "x", goal: "youtube", source: "record", language: "en", voice_source: "external" };
    expect(ids(base)).toContain("voice_external");
    expect(ids(base)).not.toContain("voice_builtin");
    expect(ids({ ...base, voice_source: "silent" })).not.toContain("voice_external");
  });

  it("is empty once everything that applies is answered", () => {
    const all: Record<string, string> = { content: "x", goal: "youtube", source: "record", language: "en", voice_source: "silent", look: "default", shot: "window", review: "draft-first", permissions: "ask" };
    expect(nextBatch(brief, all)).toEqual([]);
  });
});

describe("applyAnswers", () => {
  it("accepts a value, a label, a custom text and 'default'", () => {
    const r = applyAnswers(brief, {}, { source: "Record it myself", review: "default", goal: "A talk at my meetup", language: "ar-EG" });
    expect(r.answers.source).toBe("record");
    expect(r.answers.review).toBe("draft-first");
    expect(r.answers.goal).toBe("A talk at my meetup");
    expect(r.answers.language).toBe("ar-EG");
  });

  it("ignores a label's (Recommended) suffix and unknown ids, and reports blank answers", () => {
    const r = applyAnswers(brief, {}, { review: "Show me a draft first (Recommended)", nonsense: "x", shot: "  " });
    expect(r.answers.review).toBe("draft-first");
    expect(r.answers.nonsense).toBeUndefined();
    expect(r.answers.shot).toBeUndefined();
    expect(r.rejected).toEqual(["shot"]);
  });
});

describe("askView", () => {
  it("renders a batch the way a question tool takes it, recommended marked", () => {
    const view = askView(nextBatch(brief, { content: "x" }));
    const q = view.choices.find((c) => c.id === "source")!;
    expect(q.multiSelect).toBe(false);
    expect(q.options[0]).toEqual({ label: expect.any(String), description: expect.any(String) });
    const review = askView(brief.questions.filter((x) => x.id === "review")).choices[0]!;
    expect(review.options[0]!.label).toMatch(/\(Recommended\)$/);
    expect(askView(brief.questions.filter((x) => x.id === "content")).chat).toHaveLength(1);
  });
});

describe("guidance", () => {
  it("turns the answers into the next steps", () => {
    const g = guidance({ voice_source: "external", voice_external: "gemini", source: "agent", permissions: "ask", review: "draft-first" });
    const text = g.join("\n");
    expect(text).toMatch(/script_export/);
    expect(text).toMatch(/audio_import/);
    expect(text).toMatch(/hands off|mouse/i);
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/ask .*before/i);
  });

  it("never starts voice-setup for the user", () => {
    expect(guidance({ voice_source: "builtin", voice_builtin: "local" }).join("\n")).toMatch(/do not run it yourself|terminal/i);
  });
});
