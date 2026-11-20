/**
 * Keeper process. Env: KEEPER_PRIVATE_KEY, FUJI_RPC_URL_1 (+ optional FUJI_RPC_URL_2), AGENTPAY_ESCROW,
 * KEEPER_FROM_BLOCK (default: DEPLOYMENTS.fuji.deployBlock), KEEPER_STATE (default ./keeper-state.json),
 * KEEPER_INTERVAL_MS (default 15000).
 */
import { createPublicClient, createWalletClient, fallback, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { DEPLOYMENTS } from "@agentpay/core";
import { createKeeper } from "./keeper.js";
import { fileStore } from "./fileStore.js";

function env(name: string, fallbackValue?: string): string {
  const v = process.env[name] ?? fallbackValue;
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const rpcs = [env("FUJI_RPC_URL_1"), process.env.FUJI_RPC_URL_2].filter(Boolean) as string[];
// A rate-limited public RPC (HTTP 429) drops behind the other one.
const transport = fallback(rpcs.map((u) => http(u)), { rank: { interval: 60_000 } });
const account = privateKeyToAccount(env("KEEPER_PRIVATE_KEY") as Hex);
const publicClient = createPublicClient({ chain: avalancheFuji, transport });
const walletClient = createWalletClient({ chain: avalancheFuji, transport, account });

const keeper = createKeeper({
  publicClient,
  walletClient,
  escrow: env("AGENTPAY_ESCROW", DEPLOYMENTS.fuji.escrow) as Address,
  store: fileStore(env("KEEPER_STATE", "./keeper-state.json")),
  fromBlock: BigInt(env("KEEPER_FROM_BLOCK", String(DEPLOYMENTS.fuji.deployBlock ?? 0n))),
  logger: {
    info: (m, meta) => console.log(JSON.stringify({ level: "info", m, ...meta })),
    warn: (m, meta) => console.warn(JSON.stringify({ level: "warn", m, ...meta })),
  },
});

console.log(JSON.stringify({ level: "info", m: "keeper started", keeper: account.address }));
keeper.start(Number(env("KEEPER_INTERVAL_MS", "15000")));
