import { spawn } from "node:child_process";

/** Command that opens a file or URL with the OS default app. */
export function openCommand(target: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  // Not `cmd /c start`: cmd would split a URL at "&" and other metacharacters.
  if (platform === "win32") return { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target] };
  if (platform === "darwin") return { cmd: "open", args: [target] };
  return { cmd: "xdg-open", args: [target] };
}

/** Fire and forget: the app outlives us. */
export function openWithDefaultApp(target: string): void {
  const { cmd, args } = openCommand(target);
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
