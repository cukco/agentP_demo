/** AGENTPAY_CHECKS_MODULE adapter: lets the AgentPay MCP server verify the AVAX price Spec (Chainlink deviation). */
import { createPriceChecks, createPriceReader } from "@agentpay-demo/seller-avax-price";
import { createPublicClient, http, isAddress } from "viem";
import { avalanche } from "viem/chains";
import { PUBLIC_DEFAULTS } from "./public-config.js";

const verifier = process.env.VERIFIER_ADDRESS ?? PUBLIC_DEFAULTS.VERIFIER_ADDRESS;
const endpoint = process.env.VERIFIER_URL ?? PUBLIC_DEFAULTS.VERIFIER_URL;
const rpc = process.env.AVAX_MAINNET_RPC_URL_2 ?? process.env.AVAX_MAINNET_RPC_URL_1 ?? PUBLIC_DEFAULTS.AVAX_MAINNET_RPC_URL_1;
if (!isAddress(verifier)) throw new Error("Invalid VERIFIER_ADDRESS");
const oracle = createPublicClient({ chain: avalanche, transport: http(rpc) });
const price = createPriceChecks({ address: verifier, endpoint }, createPriceReader(oracle), () => Math.floor(Date.now() / 1000));

export const checks = price.checks;
export const supportsSpec = price.supportsSpec;
