import { describe, expect, it } from "vitest";
import { DESKTOP_ENV } from "../src/brand.js";
import { detectDesktop, isWlrootsEnv } from "../src/platform/detect.js";
import { distroFamily, installHint } from "../src/util/distro.js";

const linux = (env: Record<string, string>) => detectDesktop(env, "linux").id;

describe("desktop selection", () => {
  it("picks Windows on win32", () => {
    expect(detectDesktop({}, "win32").id).toBe("windows");
  });

  it("keeps KDE Wayland on the KWin + portal path", () => {
    expect(linux({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("kde");
    expect(linux({ WAYLAND_DISPLAY: "wayland-0", KDE_FULL_SESSION: "true" })).toBe("kde");
  });

  it("routes X11 sessions (any desktop, KDE included) to x11", () => {
    expect(linux({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" })).toBe("x11");
    expect(linux({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "X-Cinnamon", DISPLAY: ":0" })).toBe("x11");
    expect(linux({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE", DISPLAY: ":0" })).toBe("x11");
    // No session type (ssh -X, Xvfb in CI): DISPLAY without WAYLAND_DISPLAY.
    expect(linux({ DISPLAY: ":99" })).toBe("x11");
  });

  it("routes other Wayland desktops to the portal backend", () => {
    expect(linux({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("portal");
    expect(linux({ WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "sway" })).toBe("portal");
  });

  it("honours the override, and rejects unknown values", () => {
    expect(linux({ [DESKTOP_ENV]: "portal", XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" })).toBe("portal");
    expect(linux({ [DESKTOP_ENV]: "X11", WAYLAND_DISPLAY: "wayland-0" })).toBe("x11");
    expect(detectDesktop({ [DESKTOP_ENV]: "kde" }, "linux").reason).toMatch(/forced/);
    expect(() => linux({ [DESKTOP_ENV]: "mutter" })).toThrow(/not one of/);
  });

  it("explains when there is no graphical session", () => {
    expect(() => linux({})).toThrow(/No graphical session/);
    expect(() => detectDesktop({}, "darwin")).toThrow(/not supported on darwin/);
  });

  it("recognizes wlroots compositors", () => {
    expect(isWlrootsEnv({ XDG_CURRENT_DESKTOP: "sway" })).toBe(true);
    expect(isWlrootsEnv({ XDG_CURRENT_DESKTOP: "Hyprland" })).toBe(true);
    expect(isWlrootsEnv({ HYPRLAND_INSTANCE_SIGNATURE: "x" })).toBe(true);
    expect(isWlrootsEnv({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(false);
  });
});

describe("install hints", () => {
  it("reads the distro family from os-release", () => {
    expect(distroFamily('NAME="Nobara Linux"\nID=nobara\nID_LIKE="rhel centos fedora"\n')).toBe("fedora");
    expect(distroFamily("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n")).toBe("debian");
    expect(distroFamily("ID=ubuntu\nID_LIKE=debian\n")).toBe("debian");
    expect(distroFamily("ID=arch\n")).toBe("arch");
    expect(distroFamily("ID=opensuse-tumbleweed\nID_LIKE=\"opensuse suse\"\n")).toBe("suse");
    expect(distroFamily("ID=nixos\n")).toBe("other");
  });

  it("gives the command for the missing GStreamer pieces", () => {
    expect(installHint("gstreamer", "fedora")).toBe("sudo dnf install gstreamer1 pipewire-gstreamer gstreamer1-plugin-openh264");
    expect(installHint("gstreamer", "debian")).toMatch(/^sudo apt install .*gstreamer1\.0-pipewire/);
    expect(installHint("gstreamer", "other")).toMatch(/pipewiresrc/);
  });
});
