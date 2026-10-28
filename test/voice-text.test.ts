import { describe, expect, it } from "vitest";
import { type VoiceInfo, voiceMatchesLang } from "../src/voice/index.js";
import { detectLang, rateToSpeed } from "../src/voice/text.js";

describe("detectLang", () => {
  it("is Arabic when the line has Arabic letters", () => {
    expect(detectLang("أهلاً بيك")).toBe("ar");
    expect(detectLang("Open the مشروع tab")).toBe("ar");
  });
  it("is English otherwise", () => {
    expect(detectLang("Open the project")).toBe("en");
    expect(detectLang("123 !?")).toBe("en");
  });
});

describe("rateToSpeed", () => {
  it("turns an SSML rate into a speed factor", () => {
    expect(rateToSpeed("+0%")).toBe(1);
    expect(rateToSpeed("+10%")).toBe(1.1);
    expect(rateToSpeed("-5%")).toBe(0.95);
  });
  it("falls back to 1 for anything else", () => {
    expect(rateToSpeed("fast")).toBe(1);
    expect(rateToSpeed("-100%")).toBe(1);
  });
});

describe("voiceMatchesLang", () => {
  const v: VoiceInfo = { name: "voicetut:Sarah", locale: "ar-EG", gender: "", langs: ["ar", "en"] };
  it("matches the locale or any language the voice speaks", () => {
    expect(voiceMatchesLang(v, "ar")).toBe(true);
    expect(voiceMatchesLang(v, "ar-EG")).toBe(true);
    expect(voiceMatchesLang(v, "en")).toBe(true);
    expect(voiceMatchesLang(v, "fr")).toBe(false);
  });
  it("matches everything without a filter", () => {
    expect(voiceMatchesLang(v)).toBe(true);
  });
});
