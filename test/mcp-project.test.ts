import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { z } from "zod";

type Tool = { description: string; inputSchema: Record<string, z.ZodType>; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }> };
const h = vi.hoisted(() => ({ tools: new Map<string, unknown>(), instructions: "", start: vi.fn(), perform: vi.fn() }));

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
vi.mock("../src/record/index.js", async (orig) => ({ ...(await orig<typeof import("../src/record/index.js")>()), startRecording: h.start }));
vi.mock("../src/take/perform.js", async (orig) => ({ ...(await orig<typeof import("../src/take/perform.js")>()), performTake: h.perform }));
vi.mock("../src/drive/index.js", async (orig) => ({ ...(await orig<typeof import("../src/drive/index.js")>()), Driver: { open: async () => ({ screens: () => [], close: async () => {} }) } }));

const tool = (name: string): Tool => h.tools.get(name) as Tool;

beforeAll(async () => {
  process.env.SCREENPILOT_SKIP_BRIEF = "1";
  await import("../src/mcp.js");
});
beforeEach(() => {
  h.start.mockReset().mockResolvedValue({ dir: "/x", inputAdapter: "none", stop: async () => ({}) });
  h.perform.mockReset().mockResolvedValue({ dir: "/x" });
});

describe("project on the MCP tools", () => {
  it("record_start and perform accept a project and say where videos go", () => {
    for (const name of ["record_start", "perform"]) {
      expect(z.object(tool(name).inputSchema).safeParse({ take: "t.json", project: "/p" }).success, name).toBe(true);
      expect(tool(name).inputSchema.project?.description).toMatch(/\.screenpilot\.json/);
    }
    expect(h.instructions).toMatch(/pass that project's folder as `project`/);
  });

  it("perform passes the project on, resolved, and leaves it out when absent", async () => {
    await tool("perform").handler({ take: "t.json", project: "rel/proj" });
    expect(h.perform.mock.calls[0]![1]).toMatchObject({ project: resolve("rel/proj") });
    await tool("perform").handler({ take: "t.json" });
    expect(h.perform.mock.calls[1]![1].project).toBeUndefined();
  });

  it("record_start passes the project on", async () => {
    await tool("record_start").handler({ project: "/some/proj" });
    expect(h.start.mock.calls[0]![0]).toMatchObject({ project: resolve("/some/proj") });
  });
});
