// Production server for the showcase page (/) and the built Dashboard (/app) (no dependencies): serves dist/ and forwards read-only
// /api/verifier/* and /api/scorer/* GET requests to the hosted services (the Verifier sends no CORS headers).
//   VERIFIER_TARGET=https://agentpay-verifier.fly.dev SCORER_TARGET=https://agentpay-scorer.fly.dev node server.mjs
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "dist");
const port = Number(process.env.PORT ?? 8080);
const targets = {
  "/api/verifier": process.env.VERIFIER_TARGET ?? "https://agentpay-verifier.fly.dev",
  "/api/scorer": process.env.SCORER_TARGET ?? "https://agentpay-scorer.fly.dev",
};
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

async function proxy(req, res, prefix) {
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  const path = req.url.slice(prefix.length);
  if (!/^\/v1\/[A-Za-z0-9/_?=&.-]*$/.test(path)) { res.writeHead(400).end(); return; }
  try {
    const upstream = await fetch(targets[prefix] + path, { signal: AbortSignal.timeout(8000) });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { res.writeHead(502, { "content-type": "application/json" }).end('{"error":"upstream unavailable"}'); }
}

async function file(req, res) {
  const url = new URL(req.url, "http://x");
  // "/" is the showcase page, "/app" (and any unknown path) is the Dashboard.
  if (url.pathname === "/" || url.pathname === "/site.html") url.pathname = "/site.html";
  else if (url.pathname === "/app" || url.pathname.startsWith("/app/")) url.pathname = "/index.html";
  let path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try { if ((await stat(path)).isDirectory()) path = join(path, "index.html"); }
  catch { path = join(root, "index.html"); }
  const body = await readFile(path);
  const immutable = path.includes(`${join(root, "assets")}`);
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" });
  res.end(body);
}

createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
  const prefix = Object.keys(targets).find(p => req.url.startsWith(`${p}/`));
  (prefix ? proxy(req, res, prefix) : file(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
}).listen(port, () => console.log(`dashboard on :${port}`));
