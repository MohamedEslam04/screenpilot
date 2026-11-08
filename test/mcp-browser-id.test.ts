import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type Tool = { description: string; inputSchema: Record<string, z.ZodType>; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> };
const h = vi.hoisted(() => ({ tools: new Map<string, unknown>(), instructions: "" }));

// Load src/mcp.ts for real, but capture the tools it registers instead of speaking MCP on stdio.
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    constructor(_info: unknown, opts: { instructions: string }) {
      h.instructions = opts.instructions;
    }
    registerTool(name: string, def: { description: string; inputSchema: unknown }, handler: unknown) {
      h.tools.set(name, { ...def, handler });
    }
    async connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../src/drive/index.js", async (orig) => ({ ...(await orig<typeof import("../src/drive/index.js")>()), Driver: { open: async () => ({ screens: () => [], close: async () => {} }) } }));
vi.mock("../src/platform/index.js", async (orig) => ({ ...(await orig<typeof import("../src/platform/index.js")>()), getDesktop: async () => ({ screens: async () => [] }) }));

import { DemoBrowser } from "../src/drive/web.js";

const tool = (name: string): Tool => h.tools.get(name) as Tool;
const call = (name: string, args: Record<string, unknown>) => tool(name).handler(args);
const accepts = (name: string, key: string, value: unknown) => z.object(tool(name).inputSchema).safeParse({ selector: "a", [key]: value }).success;

const proto = DemoBrowser.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const ids = (spy: { mock: { contexts: unknown[] } }) => spy.mock.contexts.map((c) => (c as DemoBrowser).id);

beforeAll(async () => {
  await import("../src/mcp.js");
});

describe("browser id on the MCP tools", () => {
  let open: ReturnType<typeof vi.spyOn>;
  let locate: ReturnType<typeof vi.spyOn>;
  let waitFor: ReturnType<typeof vi.spyOn>;
  let withPage: ReturnType<typeof vi.spyOn>;
  let up: Record<string, boolean>;

  beforeEach(() => {
    up = { user: true };
    open = vi.spyOn(proto, "open").mockResolvedValue({ note: "opened" });
    locate = vi.spyOn(proto, "locate").mockResolvedValue({ x: 1, y: 2, w: 3, h: 4 });
    waitFor = vi.spyOn(proto, "waitFor").mockResolvedValue(undefined);
    withPage = vi.spyOn(proto, "withPage").mockImplementation(async function (this: DemoBrowser, fn: unknown) {
      return (fn as (p: unknown) => unknown)({ evaluate: async () => `text of ${this.id}`, url: () => `https://${this.id}.test/`, title: async () => this.id });
    });
    vi.spyOn(proto, "cdpUp").mockImplementation(async function (this: DemoBrowser) {
      return up[this.id] ?? false;
    });
  });

  it("accepts a string browser id and rejects a number on every tool", () => {
    for (const [name, key] of [["browser_open", "id"], ["web_locate", "browser"], ["wait_for", "browser"], ["page_text", "browser"]] as const) {
      expect(accepts(name, key, "user"), `${name} accepts a string`).toBe(true);
      expect(accepts(name, key, 2), `${name} rejects a number`).toBe(false);
      expect(tool(name).description + JSON.stringify(Object.values(tool(name).inputSchema).map((s) => s.description))).toMatch(/second|browser id|id of/i);
    }
  });

  it("browser_open with an id opens that browser (and passes url and app)", async () => {
    await call("browser_open", { id: "user", url: "https://u.test", app: true });
    expect(ids(open)).toEqual(["user"]);
    expect(open.mock.calls[0]![0]).toMatchObject({ url: "https://u.test", app: true });
  });

  it("without an id every tool uses the main browser", async () => {
    await call("browser_open", {});
    await call("web_locate", { selector: "#a" });
    await call("wait_for", { web: "#a" });
    await call("page_text", {});
    expect([ids(open), ids(locate), ids(waitFor), ids(withPage)]).toEqual([["main"], ["main"], ["main"], ["main"]]);
  });

  it("web_locate, wait_for and page_text query the named browser", async () => {
    const r = await call("web_locate", { selector: "#a", browser: "user" });
    expect(ids(locate)).toEqual(["user"]);
    expect(r.content[0]!.text).toContain('"w": 3');
    await call("wait_for", { web: "#b", browser: "user", timeout: 5 });
    expect(ids(waitFor)).toEqual(["user"]);
    expect(waitFor.mock.calls[0]).toEqual(["#b", 5000]);
    const t = await call("page_text", { browser: "user" });
    expect(ids(withPage)).toEqual(["user"]);
    expect(t.content[0]!.text).toContain("text of user");
  });

  it("a browser that is not open fails and tells the agent to call browser_open with that id", async () => {
    for (const [name, args] of [["web_locate", { selector: "#a" }], ["wait_for", { web: "#a" }], ["page_text", {}]] as const) {
      const r = await call(name, { ...args, browser: "ghost" });
      expect(r.isError, name).toBe(true);
      expect(r.content[0]!.text, name).toMatch(/not open.*browser_open.*"ghost"/s);
    }
    expect([locate, waitFor, withPage].map((s) => s.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("a bad browser id is a tool error, not a crash", async () => {
    const r = await call("page_text", { browser: "bad id" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Bad browser id/);
  });

  it("the server instructions explain the second browser", () => {
    expect(h.instructions).toMatch(/browser_open with `?id`?.*same `?browser`?.*web_locate.*wait_for.*page_text/s);
  });
});
