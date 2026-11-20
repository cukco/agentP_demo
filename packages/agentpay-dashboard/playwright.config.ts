import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", timeout: 120000, workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 1080 }, trace: "retain-on-failure" },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1", url: "http://127.0.0.1:5173",
    reuseExistingServer: false, env: { VITE_LOCAL: "true" } },
});
