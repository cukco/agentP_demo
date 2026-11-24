import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";

export default defineConfig({ plugins: [react(), {
  name: "local-deployment",
  configureServer(server) {
    server.middlewares.use("/deployments/local.json", async (_req, res) => {
      try { const data = await readFile(new URL("../../deployments/local.json", import.meta.url));
        res.setHeader("Content-Type", "application/json"); res.end(data); }
      catch { res.statusCode = 404; res.end("Local deployment not found"); }
    });
  },
}], build: { rollupOptions: { input: { app: "index.html", site: "site.html" } } }, server: { host: "127.0.0.1", port: 5173, proxy: {
  // Point the dev proxy at hosted services (the Verifier sends no CORS headers), e.g.
  // DASHBOARD_VERIFIER_TARGET=https://agentpay-verifier.fly.dev DASHBOARD_SCORER_TARGET=https://agentpay-scorer.fly.dev
  "/api/verifier": { target: process.env.DASHBOARD_VERIFIER_TARGET ?? "http://127.0.0.1:8787", changeOrigin: true,
    rewrite: p => p.replace(/^\/api\/verifier/, "") },
  "/api/scorer": { target: process.env.DASHBOARD_SCORER_TARGET ?? "http://127.0.0.1:8788", changeOrigin: true,
    rewrite: p => p.replace(/^\/api\/scorer/, "") },
} } });
