import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../brand.js";
import { loadVoiceConfig } from "./config.js";

// The spend ledger: one JSON line per BILLED request to a paid voice service, kept in the
// config folder (spend.jsonl). A cache hit, a failed request or a free voice adds nothing.
// A row holds the voice name and counts, never a key or the text itself.

/** Set to anything: no ledger row is written to the default file (the test suite sets it); an explicit file is always written. */
export const NO_SPEND_ENV = "SCREENPILOT_NO_SPEND";

/**
 * USD per credit when voices.json has no `spend.usdPerCredit` for the provider. These are
 * estimates to plan with, not an invoice: check your plan, and set your own price in voices.json.
 * - elevenlabs: a credit is a character; 0.0003 is the pay-as-you-go rate (about $0.30 per 1000
 *   characters). A plan's included credits cost less per credit; Flash and Turbo models use half
 *   a credit per character, so halve the price for them.
 * - gemini: a credit is one audio output token (25 per second of speech); 0.00001 is $10 per
 *   million tokens. The text you send is billed too but is small next to the audio.
 */
export const DEFAULT_USD_PER_CREDIT: Record<string, number> = { elevenlabs: 0.0003, gemini: 0.00001 };
const GEMINI_TOKENS_PER_SECOND = 25;

export const spendFile = () => join(configDir(), "spend.jsonl");

/** What a provider tells the ledger about one billed request. */
export interface SpendInput {
  provider: string;
  model: string;
  voice: string;
  /** Characters of the text sent. */
  chars: number;
  /** Seconds of audio that came back. */
  audio_s: number;
}

/** One line of spend.jsonl. */
export interface SpendRow extends SpendInput {
  /** ISO time of the request. */
  t: string;
  credits: number;
  usd: number;
}

/** Credits a request uses: ElevenLabs characters, Gemini audio tokens, 0 for a free voice. */
export function creditsFor(provider: string, chars: number, audioSeconds: number): number {
  if (provider === "elevenlabs") return chars;
  if (provider === "gemini") return Math.round(audioSeconds * GEMINI_TOKENS_PER_SECOND);
  return 0;
}

/** The price of one credit: voices.json (`spend.usdPerCredit`), else the default; 0 for a free voice. A broken voices.json never fails a request. */
export function usdPerCredit(provider: string): number {
  try {
    const set = loadVoiceConfig().spend.usdPerCredit[provider];
    if (set !== undefined) return set;
  } catch {
    // fall back to the default
  }
  return DEFAULT_USD_PER_CREDIT[provider] ?? 0;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Characters the services count: code points, not UTF-16 units. */
export const countChars = (text: string): number => [...text].length;

/** Add one row to the ledger. Never throws: bookkeeping must not fail a render. */
export async function recordSpend(input: SpendInput, file?: string): Promise<void> {
  if (!file && process.env[NO_SPEND_ENV]) return;
  try {
    const credits = creditsFor(input.provider, input.chars, input.audio_s);
    const row: SpendRow = {
      t: new Date().toISOString(),
      provider: input.provider,
      model: input.model,
      voice: input.voice,
      chars: input.chars,
      audio_s: round(input.audio_s, 3),
      credits,
      usd: round(credits * usdPerCredit(input.provider), 6),
    };
    const target = file ?? spendFile();
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(row)}\n`);
  } catch {
    // ignored on purpose
  }
}

const valid = (r: unknown): r is SpendRow => {
  const x = r as SpendRow | null;
  return !!x && typeof x.t === "string" && typeof x.provider === "string" && Number.isFinite(x.chars) && Number.isFinite(x.usd);
};

/** The rows of the ledger, oldest first; torn lines are skipped and a missing file is empty. */
export async function readSpend(opts: { file?: string; since?: Date } = {}): Promise<SpendRow[]> {
  let raw: string;
  try {
    raw = await readFile(opts.file ?? spendFile(), "utf8");
  } catch {
    return [];
  }
  const rows: SpendRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (valid(row) && (!opts.since || Date.parse(row.t) >= opts.since.getTime())) rows.push(row);
    } catch {
      // torn line
    }
  }
  return rows;
}

export interface SpendTotal {
  requests: number;
  chars: number;
  audio_s: number;
  credits: number;
  usd: number;
}

export interface SpendSummary extends SpendTotal {
  byProvider: Record<string, SpendTotal>;
}

const empty = (): SpendTotal => ({ requests: 0, chars: 0, audio_s: 0, credits: 0, usd: 0 });
function add(total: SpendTotal, r: SpendRow): void {
  total.requests += 1;
  total.chars += r.chars;
  total.audio_s = round(total.audio_s + (r.audio_s || 0), 3);
  total.credits += r.credits || 0;
  total.usd = round(total.usd + r.usd, 6);
}

export function summarizeSpend(rows: SpendRow[]): SpendSummary {
  const sum: SpendSummary = { ...empty(), byProvider: {} };
  for (const r of rows) {
    add(sum, r);
    add((sum.byProvider[r.provider] ??= empty()), r);
  }
  return sum;
}

/** `--since` value: a day (YYYY-MM-DD, from the start of that day on this computer) or a full date-time. */
export function parseSince(value: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--since "${value}" is not a date: use 2026-11-01 or an ISO time`);
  return date;
}

export const usd = (n: number): string => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** The summary as text, for the terminal. */
export function formatSpend(sum: SpendSummary, since?: Date): string {
  const when = since ? ` since ${since.toISOString().slice(0, 10)}` : "";
  if (sum.requests === 0) return `Nothing spent${when}.`;
  const line = (name: string, t: SpendTotal) => `${name.padEnd(12)} ${String(t.requests).padStart(6)} requests  ${String(t.chars).padStart(8)} chars  ${String(Math.round(t.audio_s)).padStart(6)} s  ${String(t.credits).padStart(9)} credits  ${usd(t.usd).padStart(8)}`;
  return [`Voice spend${when} (estimates from your price per credit):`, ...Object.entries(sum.byProvider).map(([p, t]) => line(p, t)), line("total", sum)].join("\n");
}
