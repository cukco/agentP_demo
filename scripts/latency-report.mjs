#!/usr/bin/env node
// B9 · Verifier latency (p50/p95) from the relay log lines the Verifier already writes.
// verifierMs = totalMs − sellerMs, so the Seller's own time is excluded (target: p95 < 800 ms).
// Usage: flyctl logs -a agentpay-verifier --no-tail | node scripts/latency-report.mjs [--json]
//        node scripts/latency-report.mjs verifier.log
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const file = args.find(arg => !arg.startsWith("--"));
const lines = createInterface({ input: file ? createReadStream(file) : process.stdin, crlfDelay: Infinity });

const samples = [];
const seen = new Set();
for await (const line of lines) {
  const start = line.indexOf('{"event":"relay"');
  if (start < 0) continue;
  let entry;
  try {
    entry = JSON.parse(line.slice(start, line.lastIndexOf("}") + 1));
  } catch {
    continue;
  }
  const key = `${entry.sessionId}:${entry.seq}`;
  if (!Number.isFinite(entry.verifierMs) || seen.has(key)) continue;
  seen.add(key);
  samples.push(entry);
}

// Nearest-rank percentile; slow requests are kept (no outlier removal).
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
};
const summary = field => {
  const values = samples.map(entry => entry[field]).filter(Number.isFinite);
  return { p50: Math.round(percentile(values, 50)), p95: Math.round(percentile(values, 95)), max: Math.round(Math.max(...values)) };
};

if (samples.length === 0) {
  console.error("No relay log lines found (expected JSON lines with event \"relay\").");
  process.exit(1);
}
const report = {
  requests: samples.length,
  sessions: new Set(samples.map(entry => entry.sessionId)).size,
  outcomes: samples.reduce((count, entry) => ({ ...count, [entry.outcome]: (count[entry.outcome] ?? 0) + 1 }), {}),
  verifierMs: summary("verifierMs"),
  sellerMs: summary("sellerMs"),
  totalMs: summary("totalMs"),
};
report.targetMet = report.verifierMs.p95 < 800;
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.requests} requests in ${report.sessions} sessions`);
  for (const field of ["verifierMs", "sellerMs", "totalMs"]) {
    const { p50, p95, max } = report[field];
    console.log(`${field.padEnd(11)} p50 ${String(p50).padStart(5)} ms · p95 ${String(p95).padStart(5)} ms · max ${max} ms`);
  }
  console.log(`Target p95(verifierMs) < 800 ms: ${report.targetMet ? "met" : "NOT met"}`);
}
