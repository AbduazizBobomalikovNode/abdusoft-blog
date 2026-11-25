import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Render smoke test (opt-in via MOTION_RENDER_TESTS=1) boots a headless browser.
    testTimeout: 30_000,
  },
});
