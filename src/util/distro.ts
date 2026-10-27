import { readFileSync } from "node:fs";

// Install commands for what Linux recording/driving needs, per distro family
// (read from /etc/os-release), so errors and `doctor` can say exactly what to run.

export type DistroFamily = "fedora" | "debian" | "arch" | "suse" | "other";

export function distroFamily(osRelease: string): DistroFamily {
  const field = (k: string) => new RegExp(`^${k}=["']?([^"'\\n]*)`, "m").exec(osRelease)?.[1]?.toLowerCase() ?? "";
  const ids = `${field("ID")} ${field("ID_LIKE")}`;
  if (/\b(fedora|rhel|centos|nobara)\b/.test(ids)) return "fedora";
  if (/\b(debian|ubuntu|linuxmint|pop)\b/.test(ids)) return "debian";
  if (/\b(arch|manjaro|endeavouros)\b/.test(ids)) return "arch";
  if (/\b(suse|opensuse)\b/.test(ids)) return "suse";
  return "other";
}

let cached: DistroFamily | undefined;
export function currentDistro(): DistroFamily {
  if (cached) return cached;
  try {
    cached = distroFamily(readFileSync("/etc/os-release", "utf8"));
  } catch {
    cached = "other";
  }
  return cached;
}

export type Need = "gstreamer" | "ffmpeg" | "x11-libs" | "wl-clipboard";

const PACKAGES: Record<Exclude<DistroFamily, "other">, { cmd: string; pkgs: Record<Need, string> }> = {
  fedora: {
    cmd: "sudo dnf install",
    pkgs: {
      gstreamer: "gstreamer1 pipewire-gstreamer gstreamer1-plugin-openh264",
      ffmpeg: "ffmpeg-free",
      "x11-libs": "libX11 libXrandr libXtst",
      "wl-clipboard": "wl-clipboard",
    },
  },
  debian: {
    cmd: "sudo apt install",
    pkgs: {
      gstreamer: "gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-ugly",
      ffmpeg: "ffmpeg",
      "x11-libs": "libx11-6 libxrandr2 libxtst6",
      "wl-clipboard": "wl-clipboard",
    },
  },
  arch: {
    cmd: "sudo pacman -S",
    pkgs: {
      gstreamer: "gstreamer gst-plugin-pipewire gst-plugins-ugly",
      ffmpeg: "ffmpeg",
      "x11-libs": "libx11 libxrandr libxtst",
      "wl-clipboard": "wl-clipboard",
    },
  },
  suse: {
    cmd: "sudo zypper install",
    pkgs: {
      gstreamer: "gstreamer-utils gstreamer-plugin-pipewire gstreamer-plugins-ugly",
      ffmpeg: "ffmpeg",
      "x11-libs": "libX11-6 libXrandr2 libXtst6",
      "wl-clipboard": "wl-clipboard",
    },
  },
};

const GENERIC: Record<Need, string> = {
  gstreamer: "GStreamer's gst-launch-1.0, its PipeWire plugin (pipewiresrc) and an H.264 encoder (x264enc or openh264enc)",
  ffmpeg: "ffmpeg",
  "x11-libs": "the X11 client libraries (libX11, libXrandr, libXtst)",
  "wl-clipboard": "wl-clipboard",
};

/** "sudo dnf install ..." for this distro, or what to install in words. */
export function installHint(need: Need, family: DistroFamily = currentDistro()): string {
  if (family === "other") return `install ${GENERIC[need]}`;
  const d = PACKAGES[family];
  return `${d.cmd} ${d.pkgs[need]}`;
}
