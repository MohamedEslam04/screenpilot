// Picks the real Tauri bridge or the in-browser mock.
const T = window.__TAURI__;
export const isMock = new URLSearchParams(location.search).has("mock") || !T;
const api = isMock
  ? await import("./mock.js")
  : { invoke: T.core.invoke, listen: T.event.listen, convertFileSrc: T.core.convertFileSrc };
export const invoke = api.invoke;
export const listen = api.listen;
export const fileSrc = api.convertFileSrc;
