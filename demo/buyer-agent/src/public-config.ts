/**
 * Settings a fresh clone needs to pay the hosted Fuji demo, so the MCP server and its helper scripts run without a
 * team .env. Values from process.env (or the repo .env, when present) win. The only per-user secret is the agent key.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { DEPLOYMENTS } from "@agentpay/core";
import { generatePrivateKey } from "viem/accounts";

export const PUBLIC_DEFAULTS = {
  FUJI_RPC_URL_1: "https://avalanche-fuji-c-chain-rpc.publicnode.com",
  AVAX_MAINNET_RPC_URL_1: "https://avalanche-c-chain-rpc.publicnode.com",
  FACILITATOR_URL: "https://agentpay-facilitator.fly.dev",
  SCORER_URL: "https://agentpay-scorer.fly.dev",
  VERIFIER_URL: "https://agentpay-verifier.fly.dev/v1",
  VERIFIER_ADDRESS: DEPLOYMENTS.fuji.verifier,
  SELLER_URL: "https://agentpay-seller.fly.dev/v1/price/AVAX",
  LOW_SCORE_SELLER_URL: "https://agentpay-low-seller.fly.dev/v1/price/AVAX",
} as const;

export const FAUCETS = {
  usdc: "https://faucet.circle.com (chọn Avalanche Fuji)",
  avax: "https://build.avax.network/console/primary-network/faucet",
};

/** Agent key file created by `pnpm agentpay:wallet`. Testnet only: the key is stored unencrypted. */
export const walletFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.AGENTPAY_WALLET_FILE ?? join(homedir(), ".agentpay", "agent-wallet.key");

const isKey = (value: string | undefined): value is `0x${string}` => !!value && /^0x[0-9a-f]{64}$/i.test(value);

export async function loadEnv(): Promise<NodeJS.ProcessEnv> {
  const repo = await readFile(new URL("../../../.env", import.meta.url), "utf8").then(parseEnv).catch(() => ({}));
  const env: NodeJS.ProcessEnv = { ...PUBLIC_DEFAULTS, ...repo, ...process.env };
  // api.avax-test.network rate-limits busy IPs (429); publicnode is steadier for the agent.
  env.FUJI_RPC_URL_1 = env.AGENTPAY_MCP_RPC_URL ?? PUBLIC_DEFAULTS.FUJI_RPC_URL_1;
  if (!env.AGENTPAY_AGENT_KEY && !env.AGENTPAY_KEYSTORE_PATH) {
    const file = walletFile(env);
    const saved = existsSync(file) ? (await readFile(file, "utf8")).trim() : undefined;
    // Order: explicit env → wallet created by `agentpay:wallet` → team .env buyer-auto (private repo only).
    const key = isKey(saved) ? saved : env.BUYER_AUTO_PRIVATE_KEY;
    if (isKey(key)) env.AGENTPAY_AGENT_KEY = key;
  }
  return env;
}

/** Creates the agent key file once; returns whether a new key was written. */
export async function ensureWallet(env: NodeJS.ProcessEnv): Promise<boolean> {
  const file = walletFile(env);
  if (existsSync(file)) return false;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, generatePrivateKey() + "\n", { mode: 0o600, flag: "wx" });
  return true;
}
