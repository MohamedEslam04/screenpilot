import { existsSync } from "node:fs";
import { loadVoiceConfig, updateVoiceConfig, voicesFile } from "./config.js";

// Where a cloud voice provider's API lives. An account with data residency (ElevenLabs EU, India,
// Singapore) or a company gateway talks to another host than the public default, and a key made
// for one host is refused (401) by the others. The address is read from the user's own settings,
// never from a storyboard: env var first, then voices.json, then the public default.

export type CloudProvider = "elevenlabs" | "gemini";

interface EndpointSpec {
  envVar: string;
  /** The public host, without the API version part (each provider adds its own paths). */
  defaultUrl: string;
  /** Names accepted instead of an address. */
  regions: Record<string, string>;
  /** API path parts a user may paste at the end of the address; they are cut off. Longest first. */
  suffixes: string[];
}

export const ENDPOINTS: Record<CloudProvider, EndpointSpec> = {
  elevenlabs: {
    envVar: "ELEVENLABS_BASE_URL",
    defaultUrl: "https://api.elevenlabs.io",
    // https://elevenlabs.io/docs/overview/administration/data-residency
    regions: {
      us: "https://api.us.elevenlabs.io",
      eu: "https://api.eu.residency.elevenlabs.io",
      in: "https://api.in.residency.elevenlabs.io",
      sg: "https://api.sg.residency.elevenlabs.io",
    },
    suffixes: ["/v1"],
  },
  gemini: {
    envVar: "GEMINI_BASE_URL",
    defaultUrl: "https://generativelanguage.googleapis.com",
    regions: {},
    suffixes: ["/v1beta/models", "/v1beta", "/v1"],
  },
};

export interface ResolvedEndpoint {
  /** No trailing slash and no API version. */
  url: string;
  source: "env" | "file" | "default";
  /** True when the address is the public default, whatever way it was written. */
  isDefault: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Turn what the user wrote (address or region name) into a clean base address, or throw why not. */
export function normalizeBaseUrl(provider: CloudProvider, input: string): string {
  const spec = ENDPOINTS[provider];
  const text = input.trim();
  if (!text) throw new Error("the address is empty");
  const region = spec.regions[text.toLowerCase()];
  if (region) return region;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    const names = Object.keys(spec.regions);
    throw new Error(`"${text}" is not a web address${names.length ? ` or a region name (${names.join(", ")})` : ""}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`"${text}" must start with https:// (http:// is only allowed for localhost)`);
  }
  if (url.username || url.password) {
    throw new Error("the address must not contain a user name or password (the API key is sent as a header, not in the address)");
  }
  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of spec.suffixes) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return `${url.origin}${path}`;
}

/** The address a provider talks to and where it was set. A bad value throws and says where it came from. */
export function resolveEndpoint(provider: CloudProvider): ResolvedEndpoint {
  const spec = ENDPOINTS[provider];
  const fromEnv = process.env[spec.envVar]?.trim();
  const fromFile = fromEnv ? undefined : loadVoiceConfig().providers[provider]?.baseUrl?.trim();
  const raw = fromEnv || fromFile;
  if (!raw) return { url: spec.defaultUrl, source: "default", isDefault: true };
  const source = fromEnv ? "env" : "file";
  let url: string;
  try {
    url = normalizeBaseUrl(provider, raw);
  } catch (err) {
    const where = fromEnv ? spec.envVar : `providers.${provider}.baseUrl in ${voicesFile()}`;
    throw new Error(`Bad ${provider} base URL from ${where}: ${(err as Error).message}`);
  }
  return { url, source, isDefault: url === spec.defaultUrl };
}

export const baseUrlFor = (provider: CloudProvider): string => resolveEndpoint(provider).url;

/** The host part, for messages and the cache key. */
export const hostOf = (url: string): string => new URL(url).host;

type RawProviders = Record<string, Record<string, unknown> | undefined>;

/** Save the address of a provider in voices.json (after checking it), keeping the rest of the file. */
export async function setEndpoint(provider: CloudProvider, input: string): Promise<{ url: string; file: string }> {
  let url: string;
  try {
    url = normalizeBaseUrl(provider, input);
  } catch (err) {
    throw new Error(`Bad ${provider} base URL: ${(err as Error).message}`);
  }
  const file = await updateVoiceConfig((raw) => {
    const providers = ((raw.providers as RawProviders | undefined) ??= {});
    providers[provider] = { ...providers[provider], baseUrl: url };
  });
  return { url, file };
}

/** Remove the saved address of a provider (an environment variable stays). True when there was one. */
export async function clearEndpoint(provider: CloudProvider): Promise<boolean> {
  if (!existsSync(voicesFile())) return false;
  let had = false;
  await updateVoiceConfig((raw) => {
    const providers = raw.providers as RawProviders | undefined;
    const entry = providers?.[provider];
    if (!providers || !entry || !("baseUrl" in entry)) return;
    had = true;
    delete entry.baseUrl;
    if (!Object.keys(entry).length) delete providers[provider];
    if (!Object.keys(providers).length) delete raw.providers;
  });
  return had;
}
