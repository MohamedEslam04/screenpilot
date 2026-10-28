# Docs content spec

The docs site is built from small HTML fragments by `site/build.mjs` (not part of this spec). One fragment per page and language:

    site/content/en/<page>.html
    site/content/ar/<page>.html

## Pages

| page | what it is |
|---|---|
| getting-started | What ScreenPilot does, and your first video in three asks |
| install | Install on Windows, macOS, Linux; add to other AI apps; uninstall; if something goes wrong |
| cli | The command line: record, analyze, frames, init, validate, render (partial `--from`/`--to`, `--formats`), sequence, check, build, preview, voices, doctor, setup |
| tools | The MCP tools an AI app gets, grouped by job |
| storyboard | `storyboard.json` reference: segments, zooms, captions, highlights, narration, intro/outro, chapter cards, overlays, music (and ducking), extends, theme, style warnings |
| sequence | `sequence.json`: join several storyboards into one video, insert a feature clip into an existing demo, `from`/`to` ranges, transitions |
| agent-drive | Let the agent drive the desktop: takes (`take.json`), targets, steps, tips |
| safety | What the agent can touch and how to limit it: abort/resume, env vars, audit log, `setup --allow-tools` |
| platforms | Platform support table, requirements, per-OS notes, limitations |
| faq | Short answers and troubleshooting |

## Fragment format

Each file starts with a comment holding two lines, then the body:

    <!--
    title: Install ScreenPilot
    summary: One sentence (under 160 characters) saying what the page covers.
    -->
    <p>Body starts here…</p>

Rules:

- No `<h1>`: the page title becomes the h1. Start with a paragraph, then use `<h2>` and `<h3>`.
- Every `<h2>` and `<h3>` has a short ASCII `id` (lowercase, hyphens). The id is the SAME in the English and Arabic file so anchors and language switching line up.
- Allowed elements: `p`, `ul`, `ol`, `li`, `h2`, `h3`, `table` (with `thead`/`tbody`), `pre><code`, `code`, `kbd`, `strong`, `em`, `a`, `div`.
- Callouts: `<div class="note">…</div>` for tips and context, `<div class="warn">…</div>` for things that can go wrong or cost the user something.
- Code blocks: `<pre><code class="language-sh">…</code></pre>` (also `language-json`). Escape `<`, `>` and `&` inside code.
- Internal links start with `@` and name a page under the language root: `<a href="@guide/tools.html">`. Link to the home page with `@index.html`. Anchors work: `@guide/tools.html#screenshot`. External links are normal absolute URLs.
- No inline styles, no scripts, no images, no emoji.
- The repo is `https://github.com/MohamedEslam04/screenpilot`; releases are at `/releases/latest`.

## Voice

Write for someone who uses an AI app and has never opened a terminal, unless the page is for developers (`cli`, `tools`, `storyboard`, `agent-drive`). Plain verbs, sentence case, short sentences, active voice. Say what a thing does, not that it is powerful. Say what the user sees and what to do when something fails. No marketing adjectives, no filler, no "simply" or "just".

## Arabic

Write natural Modern Standard Arabic that a developer in Egypt or the Gulf reads comfortably: short sentences, no word-for-word translation, no mixing of dialect. Keep these in English exactly as they are: product and tool names (ScreenPilot, Claude Code, Cursor), commands, flags, file names, JSON keys, MCP tool names, environment variables, and code blocks. Use Western digits. Put English terms inside Arabic sentences as they are (the page handles direction). Translate the meaning of headings, not their ids. Do not translate a table's code cells.

## Accuracy

Every statement must be backed by the repository: `README.md`, `AGENTS.md`, `skill/SKILL.md`, `src/mcp.ts` (tool names and descriptions), `src/cli.ts` (commands and flags), `src/storyboard/schema.ts`, `src/sequence/schema.ts`, `src/storyboard/lint.ts`, `src/take/schema.ts`, `src/setup/`, `src/drive/guard.ts`. Read the source for the page you write. Do not invent flags, tools, defaults or platform support. If the README and the code disagree, trust the code and say nothing about the disagreement. Known facts that the README may lag on:

- v0.3.0 (current release) has Windows and Linux builds only. The two Mac downloads are missing from it until the next release; the last Mac builds are on the v0.2.3 release.
- New MCP tools: `resume`, `wait_for`, `page_text`.
- New environment variables: `SCREENPILOT_INTERRUPT=off`, `SCREENPILOT_ALLOW_APPS`, `SCREENPILOT_ALLOW_ENV`, `SCREENPILOT_PERFORM_TIMEOUT`. Drive actions are logged to `audit.jsonl` in the config folder (typed text is never logged).
- `screenpilot setup --allow-tools` adds `mcp__screenpilot` to Claude Code's `permissions.allow`.
