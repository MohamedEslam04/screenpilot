// A stand-in for a TTS program. Writes what it was given to the output file so tests can check it.
// usage: fake-command-tts.mjs <out> [--stdin | --args <text> <rate> <lang> | --silent | --hang]
import { readFileSync, writeFileSync } from "node:fs";

const [out, mode, ...rest] = process.argv.slice(2);
if (mode === "--hang") setTimeout(() => {}, 60_000);
else if (mode === "--silent") process.exit(0);
else if (mode === "--stdin") writeFileSync(out, readFileSync(0, "utf8"));
else writeFileSync(out, rest.join("|"));
