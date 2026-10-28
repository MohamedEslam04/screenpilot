# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

Only the maintainer can push to this repository. Everyone else works from a fork and sends a pull request, which the maintainer reviews and merges.

## Report a bug or suggest something

Open an issue. For a bug, please include the output of `screenpilot doctor`, your operating system and desktop, and the ScreenPilot version. For a security problem, don't open an issue: see [SECURITY.md](SECURITY.md).

## Send a pull request

1. Fork the repository and create a branch from `main`.
2. Make one focused change. Small pull requests get reviewed faster. For something big, open an issue first so we can agree on the approach.
3. Add or update tests, and keep the README in step with user-visible changes.
4. Run the checks below.
5. Open the pull request and fill in the template.

The first pull request from a new contributor needs the maintainer to approve the automated checks before they run.

## Set up

You need Node 22+ and [pnpm](https://pnpm.io).

```sh
pnpm install
pnpm dev <args>      # run the CLI from source
pnpm typecheck
pnpm test
pnpm build
```

Tests run on every pull request. The platform smoke tests (Windows, macOS, X11, Wayland) also run in CI and drive a real desktop; don't run them on a desktop you are using. `AGENTS.md` has the architecture notes and conventions.

## Style

- TypeScript, ESM, `.js` import suffixes, 2-space indent, double quotes.
- Match the surrounding code: naming, structure, comment density.
- Anything OS-specific goes behind `src/platform`.
- The MCP server must never write anything but protocol messages to stdout; log to stderr.
- Never put secrets in a `take.json`, a test or a log.

## License

By contributing you agree that your work is released under the [MIT license](LICENSE).
