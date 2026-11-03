import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `windows-x64`, `macos-arm64`, `macos-x64`, `linux-x64`: the names the release assets use. */
export function platformKey(os: NodeJS.Platform | string, arch: string): string {
  return `${os === "win32" ? "windows" : os === "darwin" ? "macos" : os}-${arch}`;
}

const eol = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * Identity of everything an app-only update does NOT replace: node_modules
 * (from the lockfile and its build settings), the Node major and the platform.
 * Two builds with the same id can swap app files without a full reinstall.
 * Line endings are normalized so a Windows checkout hashes like a Linux one.
 */
export function runtimeId(i: { lock: string; workspace: string; nodeMajor: number; platform: string }): string {
  const hash = createHash("sha256").update(eol(i.lock)).update("\n--\n").update(eol(i.workspace)).digest("hex").slice(0, 16);
  return `${hash}-node${i.nodeMajor}-${i.platform}`;
}

/** The runtime id written into an install by the build (absent in installs made before updates existed). */
export function readRuntime(root: string): string | undefined {
  const file = join(root, "runtime.json");
  if (!existsSync(file)) return undefined;
  try {
    const r = (JSON.parse(readFileSync(file, "utf8")) as { runtime?: unknown }).runtime;
    return typeof r === "string" && r ? r : undefined;
  } catch {
    return undefined;
  }
}
