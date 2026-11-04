// Accessibility tree: what apps say about their own UI (role, name, where it is).
// A source reads the raw tree per OS (AT-SPI on Linux); everything else here is
// pure and shared, so it is tested without a desktop.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One element as the OS reports it. `rect` is in the source's own space (window-relative on Wayland). */
export interface RawNode {
  /** AT-SPI role name ("push button", "menu item", "text"...); other OSes are mapped to the same names. */
  role: string;
  name: string;
  rect: Rect | null;
  /** Subset of states that matter: showing, enabled, focused, checked, selected. */
  states: string[];
  children: RawNode[];
}

/** A top-level window of an app, with its tree. */
export interface RawWindow {
  app: string;
  pid: number;
  title: string;
  rect: Rect | null;
  root: RawNode;
  /** The depth or node budget cut the tree short. */
  truncated: boolean;
}

export interface SourceOptions {
  /** Keep apps whose name contains this, or whose pid is in `pids`. Without either: all apps. */
  app?: string;
  pids?: number[];
  maxDepth: number;
  maxNodes: number;
}

export interface A11ySource {
  readonly id: string;
  status(): Promise<{ ok: boolean; detail: string }>;
  windows(o: SourceOptions): Promise<{ windows: RawWindow[]; warnings: string[] }>;
}

/** An element with its rectangle in global desktop pixels. */
export interface A11yNode {
  role: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  states: string[];
  children: A11yNode[];
}

export interface PlacedWindow {
  app: string;
  pid: number;
  title: string;
  /** Desktop window this tree belongs to, when it could be matched. */
  window?: { id: string; caption: string; resourceClass: string };
  /** False when the window position is unknown: rects are then relative to the window. */
  placed: boolean;
  truncated: boolean;
  root: A11yNode;
}

export interface A11yQuery {
  app?: string;
  role?: string;
  name?: string;
  /** Match the whole name, not a part of it. */
  exact?: boolean;
  /** 1-based pick among several matches. */
  nth?: number;
}

export interface A11yMatch {
  role: string;
  name: string;
  app: string;
  window: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Centre, where a click lands. */
  cx: number;
  cy: number;
  states: string[];
}
