import type { Storyboard } from "../storyboard/schema.js";

// The narration of a storyboard as a script to paste into an external TTS site.

export interface ScriptLine {
  /** 1-based, in speaking order. */
  number: number;
  /** Source second the line starts. */
  at: number;
  /** Source seconds before the next line (or the end of the kept video); null when unknown. */
  room: number | null;
  words: number;
  text: string;
}

export interface Script {
  language: string;
  lines: ScriptLine[];
  /** The text to paste: one paragraph per line, a blank line between them, no numbers. */
  plain: string;
  markdown: string;
}

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

function languageOf(sb: Storyboard): string {
  const voice = sb.voice.name.toLowerCase();
  if (voice.startsWith("ar-eg")) return "Egyptian Arabic";
  if (voice.startsWith("ar")) return "Arabic";
  if (voice.startsWith("en")) return "English";
  return "the language of the text";
}

export function buildScript(sb: Storyboard, title = "Narration script"): Script {
  const sorted = sb.narration.map((n, i) => ({ n, i })).sort((a, b) => a.n.at - b.n.at || a.i - b.i);
  const end = sb.segments.length ? Math.max(...sb.segments.map((s) => s.out)) : null;
  const lines: ScriptLine[] = sorted.map(({ n }, k) => {
    const next = sorted[k + 1]?.n.at ?? end;
    return { number: k + 1, at: n.at, room: next === null ? null : +(next - n.at).toFixed(2), words: countWords(n.text), text: n.text };
  });
  const language = languageOf(sb);
  const plain = lines.map((l) => l.text).join("\n\n");

  const table = lines.map((l) => `| ${l.number} | ${l.at} | ${l.room ?? "?"} | ${l.words} | ${cell(l.text)} |`);
  const markdown = [
    `# ${title}`,
    "",
    `${lines.length} line(s) · ${language}`,
    "",
    "## 1. Prompt (paste first if the site has an instructions or style box)",
    "",
    "```text",
    `Read the text below in ${language}, in a natural, friendly, steady voice. ` +
      "Leave a pause of about 1.5 seconds between paragraphs. Read only the words: no numbers, no headings.",
    "```",
    "",
    "## 2. Text to paste (one paragraph per line; the blank line is the pause)",
    "",
    "```text",
    plain,
    "```",
    "",
    "Do not paste the numbers from the table below: the voice would read them aloud.",
    "",
    "## 3. Lines and the room each has (source seconds)",
    "",
    "| # | at | room | words | text |",
    "|---|---:|-----:|------:|------|",
    ...table,
    "",
    "A line longer than its room is fine: render freezes the video until it ends.",
    "",
    "## 4. Put the audio on the video",
    "",
    "Download one audio file with all the lines, then:",
    "",
    "```sh",
    "screenpilot split-audio voice.mp3 --storyboard storyboard.json",
    "screenpilot render storyboard.json -q draft",
    "```",
    "",
    "Or download one file per line and set `audio` on each narration line in the storyboard.",
    "",
  ].join("\n");
  return { language, lines, plain, markdown };
}
