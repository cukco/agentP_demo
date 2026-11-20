import {
  AGENT_WALLET_KEY, SPEC_VERSION, agentPaySessionEscrowAbi, validateSpec,
  type PaymentRequired, type VerificationSpec,
} from "@agentpay/core";
import { isAddress, isAddressEqual, parseAbi } from "viem";
import type { BuyerCommonOptions } from "./buyer.js";

export const escrowViews = parseAbi([
  "function usdc() view returns (address)",
  "function identityRegistry() view returns (address)",
  "function scorerSigner() view returns (address)",
]);

const identityAbi = parseAbi([
  "function getMetadata(uint256 agentId, string key) view returns (bytes)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);

const supported = new Set(["json-schema", "equals", "range", "freshness", "oracle-deviation", "hash-match"]);
export function checkSupported(spec: VerificationSpec): void {
  if (spec.specVersion !== SPEC_VERSION || !spec.checks.every(check => supported.has(check.type))) {
    throw new Error("Unsupported verification version or check");
  }
}

export async function checkVerifier(deps: BuyerCommonOptions, payment: PaymentRequired): Promise<void> {
  const { session, verificationSpec } = payment.extensions.agentpay;
  const details = await deps.publicClient.readContract({
    address: session.contract, abi: agentPaySessionEscrowAbi, functionName: "verifierInfo", args: [verificationSpec.verifier.address],
  });
  if (!details.active) throw new Error("Verifier is not active");
}

export function checkEscrow(deps: BuyerCommonOptions, payment: PaymentRequired): void {
  const { session } = payment.extensions.agentpay;
  if (session.chainId !== deps.chainId || !deps.trustedEscrows.some(address => isAddressEqual(address, session.contract))) {
    throw new Error("Untrusted escrow or chain");
  }
}

function hostname(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.hostname;
  } catch {
    // A registry can advertise service endpoints that are not web URLs.
  }
}

export async function checkSeller(deps: BuyerCommonOptions, payment: PaymentRequired, url: URL): Promise<void> {
  const { session } = payment.extensions.agentpay;
  const address = await deps.publicClient.readContract({ address: session.contract, abi: escrowViews, functionName: "identityRegistry" });
  const agentId = BigInt(session.sellerAgentId);
  const wallet = await deps.publicClient.readContract({
    address, abi: identityAbi, functionName: "getMetadata", args: [agentId, AGENT_WALLET_KEY],
  });
  if (!isAddress(wallet, { strict: false }) || !isAddressEqual(wallet, session.seller)) throw new Error("Seller wallet mismatch");
  const uri = await deps.publicClient.readContract({ address, abi: identityAbi, functionName: "tokenURI", args: [agentId] });
  if (!hostname(uri) && !uri.startsWith("data:application/json")) throw new Error("Unsupported ERC-8004 registration URI");
  const response = await (deps.fetch ?? fetch)(uri, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("ERC-8004 registration unavailable");
  const metadata: { services?: { endpoint?: unknown }[]; endpoints?: { endpoint?: unknown }[] } = await response.json();
  const endpoints = metadata.services ?? metadata.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.some(service => hostname(service?.endpoint) === url.hostname)) {
    throw new Error("Seller domain is absent from the ERC-8004 registration");
  }
}

export function checkLimits(deps: BuyerCommonOptions, payment: PaymentRequired, url: URL): void {
  const { session } = payment.extensions.agentpay;
  const { defaultCap: cap, defaultExpirySec: expiry, softPolicy } = deps;
  if (cap < BigInt(session.minCap) || cap > BigInt(session.maxCap) || cap > softPolicy.maxPerSession ||
      BigInt(session.pricePerRequest) > softPolicy.maxPricePerRequest ||
      !Number.isSafeInteger(expiry) || expiry < 1 || expiry > session.maxExpirySec ||
      (softPolicy.allowedDomains && !softPolicy.allowedDomains.includes(url.hostname))) {
    throw new Error("Payment exceeds buyer policy or seller terms");
  }
}

export function checkMinimumSpec(spec: VerificationSpec): void {
  const result = validateSpec(spec);
  if (!result.ok) throw new Error(result.reason);
}

export async function precheck(deps: BuyerCommonOptions, payment: PaymentRequired, url: URL): Promise<void> {
  const { verificationSpec } = payment.extensions.agentpay;
  checkSupported(verificationSpec);
  checkEscrow(deps, payment);
  checkLimits(deps, payment, url);
  checkMinimumSpec(verificationSpec);
  await checkVerifier(deps, payment);
  await checkSeller(deps, payment, url);
}
