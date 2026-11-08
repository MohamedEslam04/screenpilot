import { spawn } from "node:child_process";
import { run } from "../util/exec.js";

// Paste typing: key-by-key injection drops characters in RTL / non-Latin text, so
// such text goes through the clipboard and a paste shortcut instead. The clipboard
// I/O is behind `Clipboard` so tests use a fake and never touch the real one.

export interface Clipboard {
  /** Current text, or undefined when it is empty or not text. */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export type TypeMethod = "keys" | "paste" | "auto";

/** The commands that set and read the text clipboard on this platform and desktop (`DesktopId`). */
export function clipboardCommands(platform: NodeJS.Platform, desktop: string): { set: string[]; get: string[] } {
  if (platform === "win32") {
    return {
      set: ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
      get: ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
    };
  }
  if (platform === "darwin") return { set: ["pbcopy"], get: ["pbpaste"] };
  if (desktop === "x11") return { set: ["xclip", "-selection", "clipboard", "-i"], get: ["xclip", "-selection", "clipboard", "-o"] };
  return { set: ["wl-copy"], get: ["wl-paste", "-n"] };
}

/** `auto` pastes when a character is outside Latin-1 (Arabic, Hebrew, CJK, emoji...), else types keys. */
export function resolveTypeMethod(method: TypeMethod | undefined, text: string): "keys" | "paste" {
  if (method === "keys" || method === "paste") return method;
  return /[^\u0000-ÿ]/.test(text) ? "paste" : "keys";
}

export function pasteCombo(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "cmd+v" : "ctrl+v";
}

const TOOL_MS = 5000;

/** The OS clipboard through its command line tool. */
export function systemClipboard(platform: NodeJS.Platform, desktop: string): Clipboard {
  const { set, get } = clipboardCommands(platform, desktop);
  return {
    async read() {
      try {
        return (await run(get[0]!, get.slice(1), { timeoutMs: TOOL_MS })).stdout;
      } catch {
        return undefined; // empty, or holds something that is not text
      }
    },
    write(text) {
      return new Promise((resolve, reject) => {
        // wl-copy forks to keep serving the selection, so wait for the exit, not for the pipes to close.
        const child = spawn(set[0]!, set.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`${set[0]} did not finish in ${TOOL_MS / 1000} s`));
        }, TOOL_MS);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`Pasting needs ${set[0]} (run "screenpilot doctor" for how to install it).`) : err);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`${set[0]} exited with ${code}`));
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(text);
      });
    },
  };
}

export interface PasteOptions {
  /** The text came from `{env}`: never logged, and never left on the clipboard. */
  secret?: boolean;
  /** Wait after the paste key before the clipboard is restored (ms). Default 150. */
  settleMs?: number;
}

/**
 * Put `text` on the clipboard, send the paste key, then restore what was there before,
 * also when the key fails. With nothing to restore the clipboard is cleared, so the text
 * (a secret above all) never stays on it.
 */
export async function pasteText(clip: Clipboard, sendPaste: () => Promise<void>, text: string, opts: PasteOptions = {}): Promise<void> {
  const previous = await clip.read();
  try {
    await clip.write(text);
    await new Promise((r) => setTimeout(r, 80));
    await sendPaste();
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 150));
  } finally {
    await clip.write(previous ?? "").catch(() => {});
  }
}
