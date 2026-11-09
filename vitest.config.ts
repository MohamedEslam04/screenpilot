import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/ and carry their own copy of the tests.
    exclude: [...configDefaults.exclude, ".claude/**"],
    // Tests that run real ffmpeg take ~2 s here but pass 5 s on slow CI runners (macOS Intel) or a busy machine.
    testTimeout: 30_000,
    // Real renders run in the tests: they must not write into the developer's own history.
    env: { SCREENPILOT_NO_HISTORY: "1" },
  },
});
