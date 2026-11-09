# ScreenPilot dashboard: Tauri shell

A thin Tauri v2 shell. All logic is in `../core` (`screenpilot-dashboard-core`, pure Rust, unit-tested without any GUI library). This crate only registers the commands of `../API.md` (`src/commands.rs`, each one runs on the blocking pool) and the jobs watcher (`src/watch.rs`). The UI is `../ui` (plain HTML/JS, served as `frontendDist`, `window.__TAURI__` is on).

## Build and run

System packages (Fedora/Nobara): `sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel libappindicator-gtk3-devel`.

```sh
cd dashboard/src-tauri
cargo check                    # first compile; downloads Tauri
cargo install tauri-cli --locked   # once, gives `cargo tauri`
cargo tauri dev                # runs the app (no dev server: it serves ../ui directly)
cargo tauri build              # bundles
```

The core tests need none of that: `cd dashboard && cargo test -p screenpilot-dashboard-core`.

## Icons

`icons/` holds a placeholder set (a play button on a dark rounded square) so the first build works: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico`, `icon.icns`, and `source.png` (512x512). To use a real logo, run once: `cargo tauri icon icons/source.png` after replacing `source.png` (it rewrites every file in `icons/` and adds the mobile ones).

## Why `tauri.conf.json` looks the way it does (JSON has no comments)

- **`assetProtocol` scope.** The UI plays recordings and shows thumbnails through `convertFileSrc(path)`, i.e. `asset://` URLs, and Tauri refuses any path outside the scope. Recordings and renders live where the user keeps them, so the scope allows `$HOME/**`, plus the usual big-disk mounts `/data/**`, `/mnt/**` and `/run/media/**` (external drives on Linux). `requireLiteralLeadingDot` stays on, so dot folders such as `~/.ssh` and `~/.config/screenpilot` (where `secrets.json` lives) are never served. The thumbnails sit in a dot folder (`~/.cache/screenpilot/thumbs`), so their cache folders are listed explicitly for Linux, macOS (`$CACHE`) and Windows (`$LOCALDATA/screenpilot/cache/thumbs`). A recording on another Windows drive (`D:\`) is not in scope: add `"D:/**/*"` to `app.security.assetProtocol.scope.allow` for it.
- **`csp`.** Only `self`, the `asset:` protocol (`http://asset.localhost` on Windows) and Tauri's own IPC (`ipc:`, `http://ipc.localhost`). No remote origin anywhere, no inline script, no `eval`. Inline `style` attributes and `<style>` are allowed (`'unsafe-inline'` for styles only). Tauri adds its nonces/hashes at build time.
- **`capabilities/default.json`.** `core:default` plus listening to events (the `jobs-changed` event). The app's own commands need no permission entry.
- **`withGlobalTauri: true`, no `devUrl`.** The UI has no build step, so `cargo tauri dev` loads `../ui` from disk.

## The jobs watcher

`notify` watches `<cache>/jobs/` only while the window is shown (not minimized or hidden; an unfocused window still counts, so a render can be followed from a second monitor). Events are debounced (250 ms) and answered with the full job list on `jobs-changed`; coming back to the window sends a fresh list. A job that crashed without removing its file produces no event, so the list corrects itself on the next change or when the window is shown again. There is no polling loop.

## Not verified in the machine that wrote this

This crate could not be compiled there (no GTK/WebKit development packages). See the report that came with it: run `cargo check` first.
