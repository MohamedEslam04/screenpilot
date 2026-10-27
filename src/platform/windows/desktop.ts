import type { Desktop } from "../types.js";

// Placeholder until the Win32 implementation lands.
const notYet = async (): Promise<never> => {
  throw new Error("Windows desktop control is not implemented yet.");
};

export const windowsDesktop: Desktop = {
  id: "windows",
  screens: notYet,
  listWindows: notYet,
  focusWindow: notYet,
  fitWindow: notYet,
  closeNotificationPopups: async () => 0,
  quietNotifications: async () => async () => {},
  useLatinLayout: async () => async () => {},
  openInjector: notYet,
  createWatcher() {
    throw new Error("Windows desktop control is not implemented yet.");
  },
};
