// The decisions the user makes before anything is recorded, built or rendered.
// Every choice has 2-4 options so a client can show it as an option picker; text
// questions are asked in chat. Pure: what this machine has is passed in.

export interface BriefEnv {
  /** A local voice model is set up (voices.json or the env var names a Python). */
  localVoice: boolean;
  /** Names of the user's `command` voices in voices.json. */
  commandVoices: string[];
  /** The desktop screenpilot can drive, when one was detected. */
  desktop?: { id: string; windowControl: boolean };
}

export interface BriefOption {
  value: string;
  label: string;
  description: string;
  available: boolean;
  recommended?: boolean;
}

export type BriefId =
  | "content"
  | "goal"
  | "source"
  | "language"
  | "voice_source"
  | "voice_builtin"
  | "voice_external"
  | "voice_own"
  | "look"
  | "shot"
  | "review"
  | "permissions";

export interface BriefQuestion {
  id: BriefId;
  kind: "choice" | "text";
  /** Chip text, at most 12 characters. */
  header: string;
  question: string;
  options: BriefOption[];
  /** Only asked when the earlier answer `id` is one of `in`. */
  askWhen?: { id: BriefId; in: string[] };
}

export interface Brief {
  questions: BriefQuestion[];
}

const opt = (value: string, label: string, description: string, extra: { available?: boolean; recommended?: boolean } = {}): BriefOption => ({
  value,
  label,
  description,
  available: extra.available ?? true,
  ...(extra.recommended ? { recommended: true } : {}),
});

export function buildBrief(env: BriefEnv): Brief {
  const d = env.desktop;
  const driveText = !d
    ? "Could not detect desktop control here; run `doctor` first. If it works, I perform the demo with your real mouse and keyboard while you keep your hands off."
    : d.windowControl
      ? "I perform the demo with your real mouse and keyboard while you keep your hands off. Touching the mouse stops me."
      : "I perform the demo with your real mouse and keyboard (hands off). This desktop has no window control, so I can only point at monitor positions.";
  const commandText = env.commandVoices.length
    ? `A voice you defined in voices.json: ${env.commandVoices.join(", ")}.`
    : "A program in your voices.json (Piper, a script that calls an API). None is defined yet; you add it, I cannot from a storyboard.";

  const questions: BriefQuestion[] = [
    {
      id: "content",
      kind: "text",
      header: "Content",
      question: "What should the video show, and is anything on screen private (keys, emails, customer data)?",
      options: [],
    },
    {
      id: "goal",
      kind: "choice",
      header: "Audience",
      question: "Where will the video be shown?",
      options: [
        opt("youtube", "YouTube or website", "Landscape 1920x1080, calm explanatory pace, 30 to 90 seconds."),
        opt("social-vertical", "Reels, TikTok, Shorts", "Vertical 1080x1920, short punchy captions."),
        opt("docs", "README, docs or slides", "Landscape 1920x1080, short and focused."),
        opt("social-square", "Social feed", "Square 1080x1080."),
      ],
    },
    {
      id: "source",
      kind: "choice",
      header: "Source",
      question: "Where does the recording come from?",
      options: [
        opt("record", "Record it myself", "You do the demo while I record. I do not touch your mouse."),
        opt("existing", "Use a video I have", "Give me the file; I analyze it and build the storyboard."),
        opt("agent", "You drive it", driveText, { available: !!d }),
      ],
    },
    {
      id: "language",
      kind: "choice",
      header: "Language",
      question: "Which language are the narration and the on-screen text?",
      options: [
        opt("en", "English", "For example the voice en-US-AndrewNeural."),
        opt("ar-EG", "Egyptian Arabic", "For example the voice ar-EG-SalmaNeural or ar-EG-ShakirNeural."),
        opt("ar", "Modern Standard Arabic", "Formal Arabic."),
        opt("bilingual", "English and Arabic", "Every caption has both languages."),
      ],
    },
    {
      id: "voice_source",
      kind: "choice",
      header: "Voice",
      question: "Where should the voice come from?",
      options: [
        opt("builtin", "Built-in voice", "Free Edge voice (needs internet) or a local model if one is set up. Works now, no account.", { recommended: true }),
        opt(
          "external",
          "A website's voice",
          "Better quality from a web text-to-speech site (Google AI Studio, ElevenLabs...). I write the script, you generate one audio file there, I put it on the video. Free plans have limits, some forbid commercial use, and the text is sent to that site.",
        ),
        opt("own", "My own voice or program", "Your own recording, or a program you configured in voices.json (Piper, an ElevenLabs script...)."),
        opt("silent", "No voice", "Captions only."),
      ],
    },
    {
      id: "voice_builtin",
      kind: "choice",
      header: "Built-in",
      question: "Which built-in voice?",
      askWhen: { id: "voice_source", in: ["builtin"] },
      options: [
        opt("edge", "Edge voice", "Free, needs internet. Egyptian Arabic and English voices.", { recommended: true }),
        opt(
          "local",
          "Local model",
          env.localVoice
            ? "Offline VoiceTut or NAMAA, already set up on this computer."
            : "Not set up yet: you must run `screenpilot voice-setup voicetut` in a terminal (about 10 GB). I never run it myself.",
          { available: env.localVoice },
        ),
      ],
    },
    {
      id: "voice_external",
      kind: "choice",
      header: "Website",
      question: "Which website makes the voice?",
      askWhen: { id: "voice_source", in: ["external"] },
      options: [
        opt("gemini", "Google AI Studio", "Gemini voices, supports Egyptian Arabic. Reported free tier is small (about 10 requests a day), so one audio file for the whole script."),
        opt("elevenlabs", "ElevenLabs", "High quality. Reported free plan: about 10 minutes a month, personal use only, credit to ElevenLabs required."),
        opt("other", "Another site", "You pick it. Check its free limits and commercial terms first."),
      ],
    },
    {
      id: "voice_own",
      kind: "choice",
      header: "Own voice",
      question: "Which of your own?",
      askWhen: { id: "voice_source", in: ["own"] },
      options: [
        opt("recording", "My own recording", "You record the voice; I cut it per line, or you give one file per line."),
        opt("command", "A program I set up", commandText, { available: env.commandVoices.length > 0 }),
      ],
    },
    {
      id: "look",
      kind: "choice",
      header: "Look",
      question: "How should it look?",
      options: [
        opt("default", "Clean default", "A tidy theme that fits the audience.", { recommended: true }),
        opt("brand", "Match my product", "I read the colors and fonts from your site or app."),
        opt("custom", "My own style", "You give the logo, colors, font, music, intro and outro."),
      ],
    },
    {
      id: "shot",
      kind: "choice",
      header: "Camera",
      question: "What should the camera show?",
      options: [
        opt("window", "Follow the app window", "Clean product demos.", { recommended: true }),
        opt("screen", "The whole monitor", "OS-level how-tos where context matters."),
        opt("all", "All monitors", "Work that spans screens, such as code on one and the app on another."),
      ],
    },
    {
      id: "review",
      kind: "choice",
      header: "Review",
      question: "How should I deliver it?",
      options: [
        opt("draft-first", "Show me a draft first", "A fast draft, we check the frames together, then the final render.", { recommended: true }),
        opt("final-only", "Final straight away", "Render the delivery quality once the storyboard validates."),
      ],
    },
    {
      id: "permissions",
      kind: "choice",
      header: "Permissions",
      question: "May I start recording and drive your mouse and keyboard?",
      options: [
        opt("allow", "Yes, go ahead", "Start recording and perform when ready. Nothing gets installed."),
        opt("ask", "Ask me each time", "Check with you before every recording or driven step."),
      ],
    },
  ];
  return { questions };
}

export type Answers = Record<string, string>;

/** At most this many questions go to the user at once (a picker shows four). */
const BATCH = 4;

/** The next questions to ask: unanswered, applicable, and whose parent answer is known. */
export function nextBatch(brief: Brief, answers: Answers): BriefQuestion[] {
  const out: BriefQuestion[] = [];
  for (const q of brief.questions) {
    if (out.length >= BATCH) break;
    if (answers[q.id] !== undefined) continue;
    if (q.askWhen) {
      const parent = answers[q.askWhen.id];
      if (parent === undefined || !q.askWhen.in.includes(parent)) continue;
    }
    out.push(q);
  }
  return out;
}

const stripRecommended = (s: string) => s.replace(/\s*\(recommended\)\s*$/i, "").trim().toLowerCase();

/**
 * Merge answers given as an option value, an option label, "default" or free
 * text. Unknown ids are ignored; blank answers are reported back.
 */
export function applyAnswers(brief: Brief, current: Answers, given: Record<string, string>): { answers: Answers; rejected: string[] } {
  const answers = { ...current };
  const rejected: string[] = [];
  for (const [id, raw] of Object.entries(given)) {
    const q = brief.questions.find((x) => x.id === id);
    if (!q) continue;
    const text = String(raw ?? "").trim();
    if (!text) {
      rejected.push(id);
      continue;
    }
    if (q.kind === "text") {
      answers[id] = text;
      continue;
    }
    const key = stripRecommended(text);
    const hit =
      key === "default"
        ? (q.options.find((o) => o.recommended) ?? q.options[0])
        : q.options.find((o) => o.value.toLowerCase() === key || stripRecommended(o.label) === key);
    answers[id] = hit ? hit.value : text;
  }
  return { answers, rejected };
}

export interface AskView {
  /** Option pickers, one per question, ready for a client's question tool. */
  choices: { id: string; header: string; question: string; multiSelect: false; options: { label: string; description: string }[] }[];
  /** Free-text questions: ask these in chat. */
  chat: { id: string; question: string }[];
}

export function askView(batch: BriefQuestion[]): AskView {
  const choices: AskView["choices"] = [];
  const chat: AskView["chat"] = [];
  for (const q of batch) {
    if (q.kind === "text") {
      chat.push({ id: q.id, question: q.question });
      continue;
    }
    choices.push({
      id: q.id,
      header: q.header,
      question: q.question,
      multiSelect: false,
      options: q.options.map((o) => ({ label: o.recommended ? `${o.label} (Recommended)` : o.label, description: o.description })),
    });
  }
  return { choices, chat };
}

/** What to do next, from the answers. */
export function guidance(a: Answers): string[] {
  const out: string[] = [];
  switch (a.source) {
    case "agent":
      out.push("You drive the desktop: tell the user to keep their hands off the mouse and keyboard while you perform (touching the mouse stops you). Secrets go in env vars, never as literal text.");
      break;
    case "record":
      out.push("The user performs the demo: record_start, let them work, record_stop. Do not touch their mouse.");
      break;
    case "existing":
      out.push("Ask for the video path, then analyze it and build the storyboard.");
      break;
  }
  switch (a.voice_source) {
    case "external":
      out.push(
        "Voice from a website: write the narration, call script_export, ask the user to generate ONE audio file on the chosen site and give it back, then call audio_import. " +
          "Free plans have limits and may forbid commercial use, and the script text is sent to that site.",
      );
      break;
    case "builtin":
      out.push(
        a.voice_builtin === "local"
          ? "Local model: if it is not set up, the user must run `screenpilot voice-setup voicetut` in a terminal (about 10 GB). Do not run it yourself."
          : "Edge voice (needs internet): pick one that matches the language, e.g. ar-EG-SalmaNeural or en-US-AndrewNeural.",
      );
      break;
    case "own":
      out.push(
        a.voice_own === "command"
          ? 'Use provider "command" with a voice name from the user\'s voices.json; you cannot add one from a storyboard.'
          : "Ask for the audio file, then audio_import (or set narration[].audio per line).",
      );
      break;
    case "silent":
      out.push("No voice: leave narration empty and use captions.");
      break;
  }
  if (a.review === "draft-first") out.push("Render quality draft first, show frames with check_output, and ask before the delivery render.");
  else if (a.review === "final-only") out.push("Render delivery once the storyboard validates.");
  out.push(
    a.permissions === "ask"
      ? "Ask the user before every record_start and every step that moves their mouse or keyboard."
      : "The user allowed recording and driving the desktop.",
  );
  out.push("Never install anything or start voice-setup for the user.");
  return out;
}
