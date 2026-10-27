import dbus from "dbus-next";
import { APP } from "../brand.js";

// Do Not Disturb while recording: notification popups would land in the video.
// KDE (and other freedesktop servers) tie the inhibition to our D-Bus
// connection, so it also ends if we are killed mid-recording.

const DEST = "org.freedesktop.Notifications";
const PATH = "/org/freedesktop/Notifications";

export async function quietNotifications(reason = "Recording a demo"): Promise<() => Promise<void>> {
  // No session bus (headless, CI, some X11 setups) means no popups to hold either.
  let bus: dbus.MessageBus;
  try {
    bus = dbus.sessionBus();
  } catch {
    return async () => {};
  }
  bus.on("error", () => {});
  let cookie: number;
  try {
    const reply = await bus.call(
      new dbus.Message({ destination: DEST, path: PATH, interface: DEST, member: "Inhibit", signature: "ssa{sv}", body: [APP, reason, {}] }),
    );
    cookie = Number(reply?.body?.[0]);
  } catch {
    bus.disconnect();
    return async () => {}; // no notification server that supports it: nothing to undo
  }
  return async () => {
    try {
      await bus.call(new dbus.Message({ destination: DEST, path: PATH, interface: DEST, member: "UnInhibit", signature: "u", body: [cookie] }));
    } catch {
      // already gone
    } finally {
      bus.disconnect();
    }
  };
}
