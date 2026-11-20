import { defineConfig } from "vitest/config";
// Real-worker check tests hold the production 500 ms per-check limit. On a 2-CPU CI runner, running
// test files in parallel (next to the other packages) can push a check past it (INCONCLUSIVE 21).
export default defineConfig({ test: { testTimeout: 30_000, fileParallelism: false } });
