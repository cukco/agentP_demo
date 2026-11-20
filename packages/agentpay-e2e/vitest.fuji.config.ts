import { defineConfig } from "vitest/config";
// Real Fuji run (D7): sequential, long timeouts, opt-in through E2E_TARGET.
export default defineConfig({
  test: {
    include: ["test/e2e-fuji/**/*.test.ts"],
    env: { E2E_TARGET: "fuji" },
    testTimeout: 25 * 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
