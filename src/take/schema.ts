import { z } from "zod";

// take.json: a demo the agent performs on the real desktop while recording.
// Positions: {screen, x, y} normalized per monitor, {web: selector} in the
// demo browser, {a11y: {role, name}} for a control in any app (found through
// the accessibility tree), or {window: match, x, y} normalized inside a window.

const norm = z.number().min(0).max(1);

export const A11yQuerySchema = z
  .object({
    role: z.string().optional().describe('Control type: "button", "checkbox", "textbox", "menuitem", "tab", or an AT-SPI role like "push button"'),
    name: z.string().optional().describe("The control's visible label or accessible name (contains, case-insensitive)"),
    app: z.string().optional().describe("App to look in: window class or title contains. Default: the focused window's app"),
    exact: z.boolean().optional().describe("Match the whole name, not a part of it"),
    nth: z.number().int().min(1).optional().describe("1-based pick when several controls match (without it, several matches are an error)"),
  })
  .strict()
  .refine((q) => q.role !== undefined || q.name !== undefined, "give a role or a name");

export const TargetSchema = z.union([
  z.object({ a11y: A11yQuerySchema }).strict(),
  z.object({ web: z.string().describe("Playwright selector in the demo browser: CSS, text=…, role=…") }).strict(),
  z.object({ window: z.string().describe("Window class or title contains"), x: norm, y: norm }).strict(),
  z.object({ screen: z.string().optional(), x: norm, y: norm }).strict(),
]);

const TextSchema = z.union([z.string(), z.object({ env: z.string().describe("Read from this env var; never logged") }).strict()]);

export const StepSchema = z.union([
  z.object({ say: z.string(), voice: z.string().optional(), wait: z.boolean().optional().describe("Block until the line ends") }).strict(),
  z.object({ caption: z.string(), dur: z.number().positive().optional(), position: z.enum(["bottom", "top", "center"]).optional() }).strict(),
  z.object({ view: z.string().describe('Monitor name or "all" (camera); without views the camera follows the pointer') }).strict(),
  z
    .object({
      browser: z
        .object({
          screen: z.string().optional(),
          url: z.string().optional().describe("URL, or a file path relative to this take.json (e.g. site/index.html)"),
          app: z.boolean().optional().describe("App window: no address bar or tabs, so the recording shows only the page"),
        })
        .strict(),
    })
    .strict(),
  z.object({ goto: z.string().describe("Navigate the demo browser: URL, or a file path relative to this take.json") }).strict(),
  z.object({ move: TargetSchema, dur: z.number().positive().optional() }).strict(),
  z
    .object({
      click: TargetSchema,
      button: z.enum(["left", "right", "middle"]).optional(),
      count: z.number().int().min(1).max(3).optional(),
    })
    .strict(),
  z.object({ drag: z.object({ from: TargetSchema, to: TargetSchema }).strict(), dur: z.number().positive().optional() }).strict(),
  z.object({ type: TextSchema, cps: z.number().positive().optional() }).strict(),
  z.object({ key: z.string().describe('Combo like "ctrl+l", "enter", "alt+tab" (macOS: "cmd+l")') }).strict(),
  z.object({ scroll: z.number().int(), at: TargetSchema.optional(), horizontal: z.boolean().optional() }).strict(),
  z.object({ wait: z.number().min(0) }).strict(),
  z
    .object({
      waitFor: z.union([
        z.object({ web: z.string(), timeout: z.number().positive().optional() }).strict(),
        z.object({ a11y: A11yQuerySchema, timeout: z.number().positive().optional() }).strict(),
      ]),
    })
    .strict(),
  z.object({ waitForWindow: z.object({ match: z.string(), timeout: z.number().positive().optional() }).strict() }).strict(),
  z
    .object({
      focus: z
        .object({
          match: z.string().optional().describe("Window class or title contains. With several windows of one title it picks the active one, else the first: use browser: true for the demo browser"),
          browser: z.literal(true).optional().describe("Focus the demo browser (found by its process id, never by title)"),
          screen: z.string().optional(),
        })
        .strict()
        .refine((f) => (f.match !== undefined) !== (f.browser !== undefined), "give either match or browser: true, not both"),
    })
    .strict(),
  z.object({ open: z.string().describe("File path (~ ok) or URL; opens with the OS default app (xdg-open / start / open)") }).strict(),
  z.object({ run: z.array(z.string()).min(1).describe("Launch a program (no shell), e.g. [\"xdg-open\", \"~/Downloads/x.pdf\"]") }).strict(),
]);

export const TakeSchema = z.object({
  name: z.string().optional(),
  screens: z.union([z.literal("all"), z.array(z.string()).min(1)]).default("all"),
  voice: z
    .object({
      provider: z.enum(["edge", "local", "command"]).default("edge"),
      name: z.string().default("en-US-AndrewNeural"),
      rate: z.string().default("+0%"),
      gap: z.number().min(0).default(0.35),
    })
    .prefault({}),
  /** Done before the recording starts (open apps, position windows). */
  setup: z.array(StepSchema).default([]),
  steps: z.array(StepSchema).min(1),
  /** Seconds kept after the last step / line. */
  tail: z.number().min(0).default(1),
  /**
   * Camera in the generated storyboard: "window" frames the window in use
   * (no panel/tray), "screen" follows the monitor, "all" shows everything.
   * Explicit `view` steps always win.
   */
  camera: z.enum(["window", "screen", "all"]).default("window"),
});

export type Take = z.output<typeof TakeSchema>;
export type Step = z.output<typeof StepSchema>;
export type Target = z.output<typeof TargetSchema>;
export type A11yTarget = z.output<typeof A11yQuerySchema>;

export function takeJsonSchema(): unknown {
  return z.toJSONSchema(TakeSchema, { io: "input" });
}
