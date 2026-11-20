import type { Address, Hex } from "viem";

/** All uint fields are bigint for uint>=64 and number for uint<=32, matching viem's ABI decoding. */

export interface OpenParams {
  seller: Address;
  sellerAgentId: bigint;
  verifier: Address;
  voucherSigner: Address;
  specHash: Hex;
  cap: bigint;
  pricePerRequest: bigint;
  /** absolute unix seconds */
  expiry: bigint;
  deliveryDeadlineSec: number;
  challengeWindowSec: number;
}

export interface Authorization {
  from: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

export interface Voucher {
  sessionId: bigint;
  seq: number;
  cumulativeAmount: bigint;
  requestHash: Hex;
}

export interface Delivery {
  sessionId: bigint;
  seq: number;
  requestHash: Hex;
  bodyHash: Hex;
  specHash: Hex;
}

export interface Receipt {
  sessionId: bigint;
  seq: number;
  requestHash: Hex;
  bodyHash: Hex;
  outcome: number;
  reasonCode: number;
  amount: bigint;
  receivedAt: bigint;
  evidenceHash: Hex;
}

export interface SessionVerdict {
  sessionId: bigint;
  specHash: Hex;
  lastSeq: number;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  passedAmount: bigint;
  receiptsRoot: Hex;
  closedAt: bigint;
}

export interface ScoreAttestation {
  agentId: bigint;
  wallet: Address;
  score: number;
  flags: number;
  validUntil: bigint;
}

export interface CloseRequest {
  sessionId: bigint;
  deadline: bigint;
}

export interface PolicyParams {
  maxPerSession: bigint;
  dailyCap: bigint;
  minScore: number;
  paused: boolean;
  sellerAllowlistOn: boolean;
}

/** A struct together with its EIP-712 signature (65-byte hex). */
export interface Signed<T> {
  message: T;
  signature: Hex;
}

// ───────────────────────── verificationSpec (Spec §3–5) ─────────────────────────

export type Check =
  | { id: string; type: "json-schema"; schema: Record<string, unknown> }
  | { id: string; type: "equals"; field: string; value: unknown }
  | { id: string; type: "range"; field: string; min?: number; max?: number }
  | { id: string; type: "freshness"; field: string; unit: "unix-s" | "unix-ms"; maxAgeSec: number }
  | {
      id: string;
      type: "oracle-deviation";
      field: string;
      oracle: { kind: "chainlink"; chainId: number; feed: Address };
      maxDeviationBps: number;
      maxOracleAgeSec?: number;
    }
  | { id: string; type: "hash-match"; expectedHash: Hex };

export type ServiceType = "price-feed" | "json-data" | "file";

export interface VerificationSpec {
  specVersion: "agentpay-verify/0.2";
  serviceType: ServiceType;
  verifier: { address: Address; endpoint: string };
  delivery: { contentType: "application/json" | "application/octet-stream"; maxBytes: number };
  checks: Check[];
  passRule: "all";
}

/** extensions.agentpay.session (Spec §4.1). Uints are decimal strings on the wire. */
export interface SessionTerms {
  contract: Address;
  chainId: number;
  seller: Address;
  sellerAgentId: string;
  pricePerRequest: string;
  minCap: string;
  maxCap: string;
  defaultExpirySec: number;
  maxExpirySec: number;
  deliveryDeadlineSec: number;
  challengeWindowSec: number;
}

export interface AgentPayExtension {
  version: "0.2";
  session: SessionTerms;
  verificationSpec: VerificationSpec;
}

/** x402 v2 PaymentRequired body with the agentpay-session scheme (Spec §2). */
export interface PaymentRequired {
  x402Version: 2;
  resource: { url: string };
  accepts: Array<{
    scheme: "agentpay-session";
    network: string;
    asset: Address;
    amount: string;
    payTo: Address;
    maxTimeoutSeconds: number;
    extra: { name: "USD Coin"; version: "2" };
  }>;
  extensions: { agentpay: AgentPayExtension };
}
