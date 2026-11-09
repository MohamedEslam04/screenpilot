import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../brand.js";

// API keys for the cloud voice providers. The environment wins; otherwise a JSON map in the
// config folder (mode 0600). A key is never logged, put in a cache key or in an error message.

export type SecretName = "ELEVENLABS_API_KEY" | "GEMINI_API_KEY";

export const secretsFile = () => join(configDir(), "secrets.json");

function readSecrets(): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(secretsFile(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The key from the environment, else from secrets.json; undefined when neither has it. */
export function findSecret(name: SecretName): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const fromFile = readSecrets()[name];
  return typeof fromFile === "string" && fromFile ? fromFile : undefined;
}

export function getSecret(name: SecretName): string {
  const value = findSecret(name);
  if (value) return value;
  throw new Error(`${name} is not set. Export ${name} or add it to ${secretsFile()} as {"${name}": "<your key>"}.`);
}

/** Store a key in secrets.json (0600), keeping the other keys. Written to a temp file and renamed. */
export function setSecret(name: SecretName, value: string): void {
  const file = secretsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...readSecrets(), [name]: value }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // the mode above only applies to a newly created file
  renameSync(tmp, file);
}
