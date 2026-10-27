import dbus from "dbus-next";

// KDE keyboard layouts. KWin switches layouts by itself to inject a keysym
// the active layout lacks, flashing an OSD on screen; picking a Latin layout
// up front (before recording) keeps that popup out of the video.

const call = async (member: string, signature = "", body: unknown[] = []) => {
  const bus = dbus.sessionBus();
  try {
    const reply = await bus.call(
      new dbus.Message({ destination: "org.kde.keyboard", path: "/Layouts", interface: "org.kde.KeyboardLayouts", member, signature, body }),
    );
    return reply?.body?.[0] as unknown;
  } finally {
    bus.disconnect();
  }
};

const LATIN = /^(us|gb|uk|en)/i;

/** Switch to a Latin layout if needed; returns a function that puts the previous one back. */
export async function useLatinLayout(): Promise<() => Promise<void>> {
  try {
    const layouts = (await call("getLayoutsList")) as [string, string, string][];
    const current = Number(await call("getLayout"));
    const latin = layouts.findIndex(([short]) => LATIN.test(short));
    if (latin < 0 || latin === current) return async () => {};
    await call("setLayout", "u", [latin]);
    return async () => {
      await call("setLayout", "u", [current]).catch(() => {});
    };
  } catch {
    return async () => {}; // not KDE, or no layout service: nothing to do
  }
}
