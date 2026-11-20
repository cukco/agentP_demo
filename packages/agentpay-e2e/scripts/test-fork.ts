import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// Only copy the public RPC/address configuration; never load signing keys into the test.
const path = fileURLToPath(new URL("../../../.env", import.meta.url));
const file = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
const env = { ...process.env, E2E_FORK: "1" };
for (const key of [
  "FUJI_RPC_URL_1",
  "FORK_FUNDING_ADDRESS",
  "BUYER_AUTO_ADDRESS",
])
  env[key] ??= file[key];
if (
  !env.FUJI_RPC_URL_1 ||
  !(env.FORK_FUNDING_ADDRESS || env.BUYER_AUTO_ADDRESS)
) {
  throw new Error(
    "Fork test requires FUJI_RPC_URL_1 and a funded public FORK_FUNDING_ADDRESS (or BUYER_AUTO_ADDRESS)",
  );
}
const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "test/e2e-fork", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
process.exit(result.status ?? 1);
