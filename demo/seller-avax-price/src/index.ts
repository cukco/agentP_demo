import { pathToFileURL } from "node:url";
import { DEPLOYMENTS, CHAIN_ID } from "@agentpay/core";
import { serve } from "@hono/node-server";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche, avalancheFuji } from "viem/chains";
import { createApp } from "./app.js";
import { createPriceReader } from "./price.js";

export const COMPONENT = "@agentpay-demo/seller-avax-price" as const;
export { createApp } from "./app.js";
export * from "./price.js";

async function main() {
  const env = process.env;
  const escrow = env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow;
  const asset = env.USDC_FUJI ?? DEPLOYMENTS.fuji.usdc;
  const verifier = env.VERIFIER_ADDRESS ?? DEPLOYMENTS.fuji.verifier;
  const key = env.SELLER_PRIVATE_KEY;
  const endpoint = env.VERIFIER_URL;
  const faultToken = env.DEMO_FAULT_TOKEN;
  if (!isAddress(escrow) || !isAddress(asset) || !isAddress(verifier) || !key || !/^0x[0-9a-fA-F]{64}$/.test(key) ||
      !endpoint || !faultToken || !env.SELLER_AGENT_ID || !/^\d+$/.test(env.SELLER_AGENT_ID) ||
      !env.FUJI_RPC_URL_1 || !env.AVAX_MAINNET_RPC_URL_1) throw new Error("Missing seller environment");
  const account = privateKeyToAccount(key as `0x${string}`);
  const transport = http(env.FUJI_RPC_URL_1);
  const publicClient = createPublicClient({ chain: avalancheFuji, transport });
  const oracle = createPublicClient({ chain: avalanche, transport: http(env.AVAX_MAINNET_RPC_URL_1) });
  const [paymentChain, oracleChain] = await Promise.all([publicClient.getChainId(), oracle.getChainId()]);
  if (paymentChain !== CHAIN_ID.fuji || oracleChain !== CHAIN_ID.avalanche) throw new Error("Wrong RPC network");
  const app = createApp({ chainId: CHAIN_ID.fuji, account, escrow, asset, publicClient,
    walletClient: createWalletClient({ chain: avalancheFuji, transport, account }), sellerAgentId: BigInt(env.SELLER_AGENT_ID),
    verifier: { address: verifier, endpoint }, verifierUrl: endpoint, faultToken, trustProxy: env.TRUST_PROXY === "true",
    clock: () => Math.floor(Date.now() / 1000), readQuote: createPriceReader(oracle),
  });
  const server = serve({ fetch: app.fetch, port: 4021, hostname: env.HOST ?? "127.0.0.1" },
    ({ port }) => console.log(`AVAX Seller ready on port ${port}`));
  server.once("close", () => app.stop());
  server.once("error", () => { app.stop(); console.error("Could not start Seller on port 4021"); process.exitCode = 1; });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => {
    console.error("Seller setup failed. Check Fuji RPC, Avalanche mainnet RPC and Seller configuration.");
    process.exitCode = 1;
  });
}
