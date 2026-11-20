import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { USDC } from "@agentpay/core";
import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { z } from "zod";
import { createApp } from "./app.js";

export { createApp } from "./app.js";
export const COMPONENT = "@agentpay/facilitator" as const;

const rpcUrl = z.string().url().refine(value => /^https?:\/\//i.test(value));
const envSchema = z.object({
  FACILITATOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  AGENTPAY_ESCROW: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/.test(value)),
  FUJI_RPC_URL_1: rpcUrl,
  FUJI_RPC_URL_2: rpcUrl,
  PORT: z.coerce.number().int().min(1).max(65535).default(8786),
});

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error("Missing or invalid Facilitator configuration: " +
      parsed.error.issues.map(issue => issue.path.join(".")).join(", "));
  }
  const env = parsed.data;
  const chain = avalancheFuji;
  const account = privateKeyToAccount(env.FACILITATOR_PRIVATE_KEY as `0x${string}`);
  // A rate-limited public RPC (HTTP 429) drops behind the other one.
  const transport = fallback([http(env.FUJI_RPC_URL_1), http(env.FUJI_RPC_URL_2)], { rank: { interval: 60_000 } });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const clock = () => Math.floor(Date.now() / 1000);
  const app = createApp({ publicClient, walletClient, escrow: env.AGENTPAY_ESCROW as `0x${string}`, usdc: USDC.fuji, clock });
  serve({ fetch: app.fetch, port: env.PORT, hostname: process.env.HOST ?? "127.0.0.1" });
}
