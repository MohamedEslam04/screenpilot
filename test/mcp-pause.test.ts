import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

const tool = (name: string): Tool => h.tools.get(name) as Tool;
const call = (name: string, args: Record<string, unknown>) => tool(name).handler(args);
const accepts = (name: string, args: Record<string, unknown>) => z.object(tool(name).inputSchema).safeParse(args).success;

beforeAll(async () => {
  await import("../src/mcp.js");
});

describe("pause and resume on the MCP server", () => {
  it("pause drops the request into the sequence's build folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-mcp-pause-"));
    const r = await call("pause", { sequence: join(dir, "seq.json") });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ requested: [join(dir, "seq.build")] });
    expect(existsSync(join(dir, "seq.build", ".pause"))).toBe(true);
  });

  it("pause without a path when nothing runs says so", async () => {
    const r = await call("pause", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Nothing is rendering/);
  });

  it("resume with a sequence carries on a paused render, and says when nothing is paused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-mcp-pause-"));
    const r = await call("resume", { sequence: join(dir, "seq.json") });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Nothing paused/);
  });

  it("resume without arguments still carries on driving", async () => {
    const r = await call("resume", {});
    expect(JSON.parse(r.content[0]!.text)).toEqual({ resumed: false, reason: "no live driver; the next drive tool opens one" });
  });

  it("render, sequence_render and resume take the memory guard", () => {
    for (const name of ["render", "sequence_render", "resume"]) {
      expect(accepts(name, { storyboard: "a.json", sequence: "s.json", min_free_mem: 2000, mem_timeout: 60 }), name).toBe(true);
      expect(accepts(name, { storyboard: "a.json", sequence: "s.json", min_free_mem: -1 }), name).toBe(false);
    }
    expect(h.instructions).toMatch(/pause/);
    expect(h.instructions).toMatch(/min_free_mem/);
  });
});

describe("sequence_render with joins", () => {
  it("takes joins, join and out_dir, and refuses mixing them with a sequence", async () => {
    expect(accepts("sequence_render", { joins: { setup: ["g1.json", "g2.json"], full: ["setup", "g3.json"] }, join: { transition: "fade-black", dur: 0.6 }, out_dir: "out" })).toBe(true);
    expect(accepts("sequence_render", { joins: { "a/b": ["g1.json"] } })).toBe(false);
    expect(accepts("sequence_render", { joins: { a: [] } })).toBe(false);
    expect(accepts("sequence_render", { joins: { a: ["g1.json"] }, join: { transition: "dissolve" } })).toBe(false);
    const both = await call("sequence_render", { sequence: "s.json", joins: { a: ["g1.json"] } });
    expect(both.content[0]!.text).toMatch(/sequence or joins, not both/);
    const neither = await call("sequence_render", {});
    expect(neither.content[0]!.text).toMatch(/sequence or joins/);
    const output = await call("sequence_render", { joins: { a: ["g1.json"] }, output: "x.mp4" });
    expect(output.content[0]!.text).toMatch(/output does not go with joins/);
    expect(h.instructions).toMatch(/joins/);
  });

  it("dryRun prices every group once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sp-mcp-joins-"));
    await writeFile(join(dir, "a.json"), JSON.stringify({ source: "a.mp4", voice: { name: "en-US-AndrewNeural" }, narration: [{ at: 1, text: "Hello there" }] }));
    for (const g of ["g1", "g2"]) await writeFile(join(dir, `${g}.json`), JSON.stringify({ parts: [{ storyboard: "a.json" }] }));
    const r = await call("sequence_render", { joins: { one: [join(dir, "g1.json")], both: ["one", join(dir, "g2.json")] }, dryRun: true });
    expect(r.isError).toBeUndefined();
    const e = JSON.parse(r.content[0]!.text);
    // g1 and g2 hold the same line: it is counted once, like the voice cache would make it once.
    expect(e).toMatchObject({ dryRun: true, lines: 1, chars: "Hello there".length });
    expect(e.parts).toHaveLength(2);
  });
});
