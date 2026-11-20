import { createPublicClient, http, isAddress } from "viem";
import { avalancheFuji } from "viem/chains";
import { DEPLOYMENTS } from "@agentpay/core";

const required = ["FUJI_RPC_URL_1", "VERIFIER_URL", "FACILITATOR_URL", "SCORER_URL"];
const missing = required.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
const client = createPublicClient({ chain: avalancheFuji, transport: http(process.env.FUJI_RPC_URL_1) });
if (await client.getChainId() !== 43113) throw new Error("Expected Fuji chain 43113");
const escrow = process.env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow;
if (!isAddress(escrow)) throw new Error("Invalid AGENTPAY_ESCROW");
if (!await client.getCode({ address: escrow })) throw new Error("Escrow has no bytecode");
for (const [key, path] of [["VERIFIER_URL", "/v1/health"], ["FACILITATOR_URL", "/supported"], ["SCORER_URL", "/v1/health"]]) {
  const response = await fetch(`${process.env[key]}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const body = await response.json();
  if (path.endsWith("health") && body.ok !== true) throw new Error(`${key}: unhealthy`);
  console.info(`${key}: reachable`);
}
console.info(`Fuji escrow: https://testnet.snowtrace.io/address/${escrow}`);
console.info("Preflight only. No transactions sent; E1/E2/E4/E9 Fuji results have not been established.");
