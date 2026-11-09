import { execFileSync } from "node:child_process";

/** Calls the fake Edge voice received, in order (reset it in beforeEach). */
export const spoken: { text: string; voice: string; rate: string }[] = [];

/** A voice that writes a tone as long as 0.1 s per character of the text; ffmpeg is real. */
export const fakeEdge = {
  id: "edge",
  async synthesize(text: string, voice: string, rate: string, out: string) {
    spoken.push({ text, voice, rate });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${text.length * 0.1}`, out]);
  },
  async listVoices() {
    return [];
  },
};
