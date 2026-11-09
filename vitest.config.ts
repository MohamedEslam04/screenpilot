import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/ and carry their own copy of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Tests that run real ffmpeg take ~2 s here but pass 5 s on slow CI runners (macOS Intel) or a busy machine.
    testTimeout: 30_000,
    // Real renders run in the tests: they must not write into the developer's own history.
    // Likewise a mocked voice request must not add a row to the developer's own spend ledger.
    env: { SCREENPILOT_NO_HISTORY: "1", SCREENPILOT_NO_SPEND: "1" },
  },
});
