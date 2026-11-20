import { serve } from "@hono/node-server";
import { DEPLOYMENTS } from "@agentpay/core";
import {
  createPublicClient,
  fallback,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { createApp } from "./app.js";
import { createChain } from "./chain.js";
import { openDatabase } from "./db.js";
import { createBlocklist } from "./sources/blocklist.js";

export function startScorer(env: NodeJS.ProcessEnv) {
  if (!/^0x[\da-f]{64}$/i.test(env.SCORER_PRIVATE_KEY ?? ""))
    throw new Error("Invalid SCORER_PRIVATE_KEY");
  if (!/^https?:\/\//.test(env.FUJI_RPC_URL_1 ?? ""))
    throw new Error("Missing FUJI_RPC_URL_1");
  const deployment = DEPLOYMENTS.fuji;
  const escrow = env.AGENTPAY_ESCROW ?? deployment.escrow;
  if (!isAddress(escrow, { strict: false }))
    throw new Error("Invalid AGENTPAY_ESCROW");
  if (
    escrow.toLowerCase() !== deployment.escrow.toLowerCase() &&
    !env.AGENTPAY_ESCROW_START_BLOCK
  )
    throw new Error("Custom escrow requires AGENTPAY_ESCROW_START_BLOCK");
  const port = Number(env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const db = openDatabase(env.SCORER_DB ?? "./scorer.db");
  const client = createPublicClient({
    chain: avalancheFuji,
    transport: fallback(
      [env.FUJI_RPC_URL_1, env.FUJI_RPC_URL_2]
        .filter((url): url is string => Boolean(url))
        .map((url) => http(url, { timeout: 8000, retryCount: 0 })),
      // A rate-limited public RPC (HTTP 429) drops behind the other one.
      { retryCount: 0, rank: { interval: 60_000 } },
    ),
  });
  const config = {
    ...deployment,
    escrow,
    startBlock: BigInt(
      env.AGENTPAY_ESCROW_START_BLOCK ?? deployment.deployBlock!,
    ),
  };
  const chain = createChain(client, config);
  const app = createApp({
    db,
    publicClient: client,
    mainnetFetch: fetch,
    alchemyBaseUrl: env.ALCHEMY_BASE_URL?.trim(),
    clock: () => Math.floor(Date.now() / 1000),
    signer: privateKeyToAccount(env.SCORER_PRIVATE_KEY as Hex),
    config,
    chain,
    blocked: createBlocklist(
      env.ATTACKER_ADDRESS ? [env.ATTACKER_ADDRESS as Address] : [],
    ),
  });
  let running = false;
  async function refresh() {
    if (running) return;
    running = true;
    try {
      if (env.SELLER_AGENT_ID) {
        const id = BigInt(env.SELLER_AGENT_ID).toString();
        const payTo = await chain.wallet(BigInt(id));
        const previous = db.seller(id);
        db.saveSeller({
          agentId: id,
          payTo,
          endpoints: env.SELLER_ENDPOINT
            ? [env.SELLER_ENDPOINT]
            : (previous?.endpoints ?? []),
          mainnetWallets:
            previous?.payTo.toLowerCase() === payTo.toLowerCase()
              ? previous.mainnetWallets
              : [],
          proofVersion: previous?.proofVersion,
          lastProbe: null,
        });
      }
      for (const seller of db.sellers())
        await app.request(`/v1/score/${seller.agentId}`);
    } catch {
      console.error("Scorer refresh failed; will retry");
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void refresh(), 600000);
  void refresh();
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: env.HOST ?? "127.0.0.1",
  });
  console.info(`Scorer listening on port ${port}`);
  const stop = () => {
    clearInterval(timer);
    server.close(() => db.close());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { app, server, stop };
}
