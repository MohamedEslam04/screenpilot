# Dashboard API contract

The UI (`ui/`) talks to Rust only through these Tauri commands (`window.__TAURI__.core.invoke(name, args)`).
`core/` (pure Rust, no Tauri, unit-tested) implements the logic. `src-tauri/` only wires commands to core.
Times are ISO strings. Argument names are snake_case. Errors come back as a string.

## Types

```ts
type HistoryEvent = {
  v: 1; at: string;
  kind: "record" | "take" | "render" | "sequence";
  status: "ok" | "failed";
  path: string;              // session dir (record, take), storyboard.json (render), sequence.json (sequence)
  storyboard?: string; output?: string; durationSec?: number;
  quality?: string; wallSeconds?: number; error?: string; imported?: boolean;
};
type JobInfo = {
  id: string; pid: number; kind: "render" | "sequence"; path: string; quality?: string;
  startedAt: string; updatedAt: string;
  step?: { label: string; index: number; total: number };
};
```

## Commands

| command | args | returns |
|---|---|---|
| `list_history` | `{before?: string, limit?: number}` (default 50) | `HistoryEvent[]` newest first; `before` = `at` of the last event of the previous page |
| `get_project` | `{path: string}` | `{storyboard: object\|null, meta: object\|null, files: {name: string, size: number}[]}`; a dir reads its `storyboard.json` + `meta.json`, a file is read as the storyboard/sequence |
| `jobs` | `{}` | `JobInfo[]` running now (dead pids ignored) |
| `stats` | `{}` | `{history_count: number, speed: {quality: string, runs: number, realtime: number}[]}` (`realtime` = video seconds per wall second) |
| `cache_size` | `{}` | `number` bytes of the render cache (slow, call once, lazily) |
| `thumbnail` | `{video: string}` | `string\|null` path of a small JPG (made once with ffmpeg, cached) |
| `open_path` | `{path: string, reveal?: boolean}` | `null` (opens with the OS default app; `reveal` opens the containing folder) |
| `run_render` | `{storyboard: string, quality: "draft"\|"looks"\|"delivery"}` | `{started: true}` spawns the screenpilot CLI detached; progress shows up in `jobs` |
| `providers` | `{}` | `{id: string, label: string, needs_key: boolean, key: "env"\|"file"\|null}[]` (edge, local, command, elevenlabs, gemini) |
| `list_voices` | `{provider: string}` | `{name: string, locale: string, gender?: string}[]` |
| `set_secret` | `{provider: string, key: string}` | `null` (key is piped to `screenpilot secret set` on stdin, never an argument) |
| `remove_secret` | `{provider: string}` | `boolean` |

Event emitted by Rust: `jobs-changed` with `JobInfo[]` (only while the window is visible).
The UI shows video through `convertFileSrc(path)` (asset protocol). Nothing in the UI sends a secret anywhere except `set_secret`.

## Files read (all produced by the screenpilot core)

- `<config>/history.jsonl`, `<config>/secrets.json` (never read by the dashboard, only via the CLI)
- `<cache>/jobs/*.json`, `<cache>/render-speed.json`, `<cache>/extract/`, `<cache>/thumbs/` (ours)
- `<config>` = `$XDG_CONFIG_HOME` or `~/.config` + `/screenpilot` (Windows `%APPDATA%`); `<cache>` = `$XDG_CACHE_HOME` or `~/.cache` + `/screenpilot` (macOS `~/Library/Caches/screenpilot`, Windows `%LOCALAPPDATA%\screenpilot\cache`).
- CLI: `$SCREENPILOT_BIN`, else `<app home>/dist/cli.js` run with `node`, else `screenpilot` on PATH. Command used: `screenpilot render <sb> -q <q>`, `screenpilot secret set|status|remove <provider>`, `screenpilot voices --provider <id>`, `screenpilot history`.
