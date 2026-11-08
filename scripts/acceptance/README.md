# 0.9.0 acceptance fixtures

Fixtures for the live check of the 0.9.0 features on a real desktop. They are not run by CI or by `pnpm test` (only `test/acceptance-fixtures.test.ts` checks they parse).

**These takes drive the real mouse and keyboard. The user must be at the desk with hands off the mouse (touching it aborts the take).** Run one take at a time, from this folder (paths in a take are relative to the take file). No network and no secrets: `page.html` is opened as a `file://` URL.

- `page.html`: static page. `#show-toast` shows `#toast` for 3 s; `#covered-btn` sits under a sticky header on a page that cannot scroll (it stays covered); `#visible-btn` is a normal button (no-false-positive check); `#name` is the input for the Arabic paste.
- `take.json`: two demo browsers (`main`, `user`), `tile`, tracked highlight on the toast in each, Arabic `type` (auto = paste), `run` with `wait`, `focus` on the second browser.
- `covered.json`: clicks `#visible-btn` (must pass), then `#covered-btn` without `force` (must fail with `TARGET_COVERED`, `delivery: "not_delivered"`).
- `covered-force.json`: same, with `"force": true` (must click; the status line then shows "header clicked", because the pointer lands on the header).

```sh
cd scripts/acceptance
screenpilot perform take.json --dir acceptance-1
screenpilot perform covered.json --dir covered-1          # expected: fails TARGET_COVERED
screenpilot perform covered-force.json --dir covered-2    # expected: succeeds
```

For the second-monitor check, add `"screen": "<monitor name>"` to the `main` browser step in a copy of `take.json` (names: `screenpilot windows` or `doctor`).
