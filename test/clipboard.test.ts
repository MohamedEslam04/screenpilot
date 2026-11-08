import { describe, expect, it } from "vitest";
import { type Clipboard, clipboardCommands, pasteText, resolveTypeMethod } from "../src/drive/clipboard.js";
import { Driver } from "../src/drive/index.js";
import type { Desktop, Injector, Watcher } from "../src/platform/types.js";

describe("clipboardCommands", () => {
  it("uses wl-copy / wl-paste on KDE and other Wayland desktops", () => {
    for (const desktop of ["kde", "portal"]) {
      expect(clipboardCommands("linux", desktop)).toEqual({ set: ["wl-copy"], get: ["wl-paste", "-n"] });
    }
  });

  it("uses xclip on X11", () => {
    expect(clipboardCommands("linux", "x11")).toEqual({
      set: ["xclip", "-selection", "clipboard", "-i"],
      get: ["xclip", "-selection", "clipboard", "-o"],
    });
  });

  it("uses pbcopy / pbpaste on macOS", () => {
    expect(clipboardCommands("darwin", "macos")).toEqual({ set: ["pbcopy"], get: ["pbpaste"] });
  });

  it("uses PowerShell on Windows", () => {
    expect(clipboardCommands("win32", "windows")).toEqual({
      set: ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
      get: ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
    });
  });
});

describe("resolveTypeMethod", () => {
  it("auto pastes text outside Latin-1 and types the rest", () => {
    expect(resolveTypeMethod(undefined, "مرحبا")).toBe("paste");
    expect(resolveTypeMethod("auto", "مرحبا")).toBe("paste");
    expect(resolveTypeMethod(undefined, "hello")).toBe("keys");
    expect(resolveTypeMethod("auto", "café ÿ")).toBe("keys");
    expect(resolveTypeMethod(undefined, "hello €")).toBe("paste");
  });

  it("an explicit method always wins", () => {
    expect(resolveTypeMethod("keys", "مرحبا")).toBe("keys");
    expect(resolveTypeMethod("paste", "hello")).toBe("paste");
  });
});

function fakeClipboard(initial: string | undefined): Clipboard & { value: string | undefined; writes: string[] } {
  const c = {
    value: initial,
    writes: [] as string[],
    read: async () => c.value,
    write: async (text: string) => {
      c.writes.push(text);
      c.value = text;
    },
  };
  return c;
}

describe("pasteText", () => {
  it("sets the text, presses the paste key, then restores the previous clipboard", async () => {
    const clip = fakeClipboard("old");
    const seen: (string | undefined)[] = [];
    await pasteText(clip, async () => void seen.push(clip.value), "مرحبا", { settleMs: 0 });
    expect(seen).toEqual(["مرحبا"]);
    expect(clip.value).toBe("old");
  });

  it("restores the previous clipboard when the paste key throws", async () => {
    const clip = fakeClipboard("old");
    await expect(
      pasteText(clip, async () => {
        throw new Error("key failed");
      }, "hello", { settleMs: 0 }),
    ).rejects.toThrow("key failed");
    expect(clip.value).toBe("old");
  });

  it("does not leave a secret on the clipboard when the paste key throws", async () => {
    const clip = fakeClipboard("old");
    await expect(
      pasteText(clip, async () => {
        throw new Error("key failed");
      }, "s3cret", { settleMs: 0, secret: true }),
    ).rejects.toThrow("key failed");
    expect(clip.value).toBe("old");
    expect(clip.value).not.toBe("s3cret");
  });

  it("clears the clipboard when there was nothing to restore", async () => {
    const clip = fakeClipboard(undefined);
    await pasteText(clip, async () => {}, "s3cret", { settleMs: 0, secret: true });
    expect(clip.value).toBe("");
  });

  it("never puts the secret into an error message", async () => {
    const clip = fakeClipboard("old");
    clip.write = async () => {
      throw new Error("wl-copy is missing");
    };
    const err = await pasteText(clip, async () => {}, "s3cret", { settleMs: 0, secret: true }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain("s3cret");
  });
});

describe("Driver.paste", () => {
  it("presses ctrl+v (cmd+v on macOS) with the text on the clipboard and restores it after, even when the key throws", async () => {
    const clip = fakeClipboard("keep me");
    const combos: string[] = [];
    let onClipboard: string | undefined;
    let fail = false;
    const input = {
      moveTo: async () => true,
      button: async () => {},
      wheel: async () => {},
      pressCombo: async (combo: string) => {
        combos.push(combo);
        onClipboard = clip.value;
        if (fail) throw new Error("no key");
      },
      typeText: async () => {},
      close: async () => {},
    } as Injector;
    const watcher = { cursor: () => ({ x: 0, y: 0 }), screens: () => [], focus: [] } as unknown as Watcher;
    const d = Driver.from({ id: "kde" } as Desktop, input, watcher, { clipboard: clip, interrupt: "off", pasteSettleMs: 0 });

    await d.paste("مرحبا");
    expect(combos).toEqual([process.platform === "darwin" ? "cmd+v" : "ctrl+v"]);
    expect(onClipboard).toBe("مرحبا");
    expect(clip.value).toBe("keep me");

    fail = true;
    await expect(d.paste("s3cret", { secret: true })).rejects.toThrow("no key");
    expect(clip.value).toBe("keep me");
  });
});
