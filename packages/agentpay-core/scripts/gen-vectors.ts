// Writes vectors/freeze.json: typehashes, constants and hash vectors that
// contracts/test/AgentPayFreeze.t.sol must reproduce. Run: pnpm --filter @agentpay/core gen:vectors
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildFreezeVectors } from "../src/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, "../vectors/freeze.json");
writeFileSync(file, JSON.stringify(buildFreezeVectors(), null, 2) + "\n");
console.log(`wrote ${file}`);
