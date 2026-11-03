import { z } from "zod";

const EntrySchema = z.object({
  file: z.string().min(1).describe("Asset file name"),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 hex digits"),
  size: z.number().int().nonnegative(),
  runtime: z.string().min(1).describe("Runtime id: what an app-only update does not replace"),
});

/** latest.json, published with every release. */
export const LatestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must look like 1.2.3"),
  platforms: z.record(z.string(), EntrySchema),
});

export type Latest = z.output<typeof LatestSchema>;
export type PlatformEntry = z.output<typeof EntrySchema>;

export function parseLatest(data: unknown): Latest {
  return LatestSchema.parse(data);
}

export function pickPlatform(latest: Latest, key: string): PlatformEntry | undefined {
  return latest.platforms[key];
}
