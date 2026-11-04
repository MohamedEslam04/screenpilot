import dbus from "dbus-next";
import type { A11ySource, RawNode, RawWindow, Rect, SourceOptions } from "./types.js";

// Linux accessibility tree over AT-SPI (D-Bus). Raw method calls on purpose:
// Qt apps do not answer introspection, so dbus-next's proxy objects fail on them.

const { Message } = dbus;
type Bus = dbus.MessageBus;

const REGISTRY = "org.a11y.atspi.Registry";
const ROOT = "/org/a11y/atspi/accessible/root";
const ACCESSIBLE = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const CALL_TIMEOUT_MS = 3000;
const IN_FLIGHT = 32;

// AT-SPI state bit numbers worth reporting.
const STATE_BITS: Record<number, string> = { 4: "checked", 8: "enabled", 12: "focused", 23: "selected", 25: "showing" };

/** AT-SPI sends states as a bitfield in two uint32 words. */
export function decodeStates(words: number[]): string[] {
  const out: string[] = [];
  for (const [bit, name] of Object.entries(STATE_BITS)) {
    const n = Number(bit);
    if (((words[n >> 5] ?? 0) >>> n % 32) & 1) out.push(name);
  }
  return out;
}

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= IN_FLIGHT) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

class A11yConnection {
  private limiter = new Limiter();
  constructor(readonly bus: Bus) {}

  call(destination: string, path: string, iface: string, member: string, signature?: string, body?: unknown[]): Promise<unknown[]> {
    return this.limiter.run(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${member} on ${destination} timed out`)), CALL_TIMEOUT_MS);
          this.bus
            .call(new Message({ destination, path, interface: iface, member, ...(signature ? { signature, body } : {}) }))
            .then((m) => resolve((m?.body as unknown[]) ?? []), reject)
            .finally(() => clearTimeout(timer));
        }),
    );
  }

  async prop(dest: string, path: string, iface: string, name: string): Promise<unknown> {
    const body = await this.call(dest, path, "org.freedesktop.DBus.Properties", "Get", "ss", [iface, name]);
    return (body[0] as { value: unknown } | undefined)?.value;
  }

  close(): void {
    this.bus.disconnect();
  }
}

/** Connect to the accessibility bus (a separate bus from the session bus). */
async function connect(): Promise<A11yConnection> {
  const session = dbus.sessionBus();
  let address: string;
  try {
    const reply = await session.call(new Message({ destination: "org.a11y.Bus", path: "/org/a11y/bus", interface: "org.a11y.Bus", member: "GetAddress" }));
    address = String(reply?.body?.[0] ?? "");
  } finally {
    session.disconnect();
  }
  if (!address) throw new Error("The accessibility bus (org.a11y.Bus) gave no address");
  return new A11yConnection(dbus.sessionBus({ busAddress: address }));
}

type Ref = [string, string];

async function pidOf(c: A11yConnection, name: string): Promise<number> {
  try {
    const body = await c.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", [name]);
    return Number(body[0] ?? 0);
  } catch {
    return 0;
  }
}

interface Budget {
  count: number;
  max: number;
  truncated: boolean;
}

async function readNode(c: A11yConnection, [dest, path]: Ref, depth: number, maxDepth: number, budget: Budget): Promise<RawNode> {
  budget.count++;
  const [name, role, rect, states, kids] = await Promise.all([
    c.prop(dest, path, ACCESSIBLE, "Name").catch(() => ""),
    c.call(dest, path, ACCESSIBLE, "GetRoleName").then((b) => String(b[0] ?? "")).catch(() => ""),
    c
      .call(dest, path, COMPONENT, "GetExtents", "u", [0])
      .then((b): Rect => {
        const [x, y, w, h] = b[0] as number[];
        return { x: x!, y: y!, w: w!, h: h! };
      })
      .catch(() => null),
    c.call(dest, path, ACCESSIBLE, "GetState").then((b) => decodeStates(b[0] as number[])).catch(() => [] as string[]),
    c.call(dest, path, ACCESSIBLE, "GetChildren").then((b) => b[0] as Ref[]).catch(() => [] as Ref[]),
  ]);
  const node: RawNode = { role, name: String(name ?? ""), rect, states, children: [] };
  if (!kids.length) return node;
  if (depth >= maxDepth || budget.count >= budget.max) {
    budget.truncated = true;
    return node;
  }
  node.children = await Promise.all(kids.map((k) => readNode(c, k, depth + 1, maxDepth, budget)));
  return node;
}

async function readWindows(c: A11yConnection, o: SourceOptions): Promise<{ windows: RawWindow[]; warnings: string[] }> {
  const windows: RawWindow[] = [];
  const warnings: string[] = [];
  const apps = ((await c.call(REGISTRY, ROOT, ACCESSIBLE, "GetChildren"))[0] ?? []) as Ref[];
  const wanted = o.app?.toLowerCase();
  const budget: Budget = { count: 0, max: o.maxNodes, truncated: false };

  await Promise.all(
    apps.map(async (app) => {
      try {
        const pid = await pidOf(c, app[0]);
        const appName = String(await c.prop(app[0], app[1], ACCESSIBLE, "Name").catch(() => ""));
        const filtering = wanted !== undefined || (o.pids?.length ?? 0) > 0;
        const keep = !filtering || (o.pids?.includes(pid) ?? false) || (wanted !== undefined && appName.toLowerCase().includes(wanted));
        if (!keep) return;
        const tops = ((await c.call(app[0], app[1], ACCESSIBLE, "GetChildren"))[0] ?? []) as Ref[];
        for (const top of tops) {
          const mine: Budget = { count: 0, max: Math.max(1, Math.floor(budget.max / Math.max(1, tops.length))), truncated: false };
          const root = await readNode(c, top, 0, o.maxDepth, mine);
          windows.push({ app: appName, pid, title: root.name, rect: root.rect, root, truncated: mine.truncated });
        }
      } catch (e) {
        warnings.push(`${app[0]}: ${(e as Error).message}`);
      }
    }),
  );
  return { windows, warnings };
}

export const atspiSource: A11ySource = {
  id: "at-spi",

  async status() {
    let c: A11yConnection | undefined;
    try {
      c = await connect();
      const apps = ((await c.call(REGISTRY, ROOT, ACCESSIBLE, "GetChildren"))[0] ?? []) as Ref[];
      return { ok: true, detail: `AT-SPI bus is up, ${apps.length} app(s) registered (Qt apps need QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 when launched)` };
    } catch (e) {
      return { ok: false, detail: `no AT-SPI accessibility bus: ${(e as Error).message} (install at-spi2-core and log in to a graphical session)` };
    } finally {
      c?.close();
    }
  },

  async windows(o) {
    const c = await connect();
    try {
      return await readWindows(c, o);
    } finally {
      c.close();
    }
  },
};
