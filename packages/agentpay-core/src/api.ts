/**
 * Frozen HTTP APIs between services (H3). JSON on the wire; every bigint is a decimal string,
 * every bytes value is 0x-hex, raw bodies are base64. Use toWire()/fromWire() from ./wire.ts.
 *
 *   Buyer SDK ──POST /v1/sessions/:id/requests──▶ Verifier ──(forward)──▶ Seller
 *             ◀── body + Delivery + Receipt ─────          ◀── body + Delivery ──
 */
import type { Address, Hex } from "viem";
import type { Wire } from "./wire.js";
import type {
  Authorization,
  Delivery,
  OpenParams,
  Receipt,
  ScoreAttestation,
  SessionVerdict,
  Voucher,
  CloseRequest,
} from "./types.js";

export interface WireSigned<T> {
  message: Wire<T>;
  signature: Hex;
}

// ───────────────────────────── Headers ─────────────────────────────

export const HEADERS = {
  /** x402 v2 payment header. Buyer -> Verifier -> Seller: base64(JSON WireSigned<Voucher>). */
  PAYMENT_SIGNATURE: "PAYMENT-SIGNATURE",
  /** x402 v2 402 body is also mirrored here as base64(JSON PaymentRequired). */
  PAYMENT_REQUIRED: "PAYMENT-REQUIRED",
  /** Verifier -> Seller: decimal sessionId. */
  SESSION_ID: "X-AgentPay-Session",
  /** Seller -> Verifier on the response: base64(JSON WireSigned<Delivery>). */
  DELIVERY: "X-AgentPay-Delivery",
  /** Verifier -> Seller: ISO time the Verifier received the voucher (deliveryDeadline starts here). */
  VOUCHER_RECEIVED_AT: "X-AgentPay-Voucher-Received-At",
} as const;

// ───────────────────────────── Errors ─────────────────────────────

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_OPEN"
  | "SESSION_EXPIRED"
  | "BAD_VOUCHER_SIG"
  | "BAD_SEQ"
  | "BAD_CUMULATIVE"
  | "OVER_USABLE" // cumulativeAmount > cap - sessionFee
  | "BAD_REQUEST_HASH"
  | "BAD_CLOSE_SIG"
  | "CLOSE_REQUEST_EXPIRED"
  | "RATE_LIMITED" // > 10 req/s per session
  | "TOO_MANY_SESSIONS" // > 20 open sessions per buyer
  | "SPEC_REJECTED" // spec too large / external $ref / missing minimum checks
  | "UNSUPPORTED_SCHEME"
  | "NONCE_MISMATCH"
  | "AUTH_EXPIRED"
  | "ALREADY_SUBMITTED"
  | "AUTH_VALUE_MISMATCH" // authorization.value != params.cap
  | "BAD_AUTH_SIG" // EIP-3009 signature does not recover to authorization.from
  | "INSUFFICIENT_BALANCE" // buyer USDC balance < cap
  | "CHAIN_ERROR"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

export interface ApiError {
  error: { code: ApiErrorCode; message: string; details?: Record<string, unknown> };
}

// ───────────────────────────── Verifier ─────────────────────────────

/** POST /v1/sessions/:sessionId/requests */
export interface RelayRequest {
  voucher: WireSigned<Voucher>;
  request: {
    method: string;
    /** Exact absolute URL; part of requestHash. */
    url: string;
    headers?: Record<string, string>;
    /** base64 of the raw request body; omitted = empty body. Part of requestHash. */
    bodyBase64?: string;
  };
}

/** 200 response. A FAIL / INCONCLUSIVE request still returns 200 with the signed Receipt. */
export interface RelayResponse {
  sessionId: string;
  seq: number;
  /** Raw seller body, base64. Absent when outcome is FAIL/LATE (bodyHash = 0). */
  bodyBase64?: string;
  contentType?: string;
  delivery?: WireSigned<Delivery>;
  receipt: WireSigned<Receipt>;
  /** Present every CHECKPOINT_EVERY requests. */
  checkpoint?: WireSigned<SessionVerdict>;
  /** true when this receipt triggered auto-close (3 FAIL in a row, cap exhausted, expiry). */
  closing: boolean;
}

/** POST /v1/sessions/:sessionId/close — buyer asks to stop. */
export interface CloseSessionRequest {
  closeRequest: WireSigned<CloseRequest>;
}
export interface CloseSessionResponse {
  sessionId: string;
  kind: "closeSession" | "closeEmpty";
  txHash: Hex;
}

/** GET /v1/sessions/:sessionId */
export interface SessionStatusResponse {
  sessionId: string;
  state: "OPEN" | "CLOSING" | "CHALLENGED" | "SETTLED" | "REFUNDED";
  buyer: Address;
  seller: Address;
  voucherSigner: Address;
  lastSeq: number;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  passedAmount: string;
  cumulativeAmount: string;
  failStreak: number;
  expiry: string;
  closeTxHash?: Hex;
}

/** GET /v1/sessions/:sessionId/receipts?fromSeq=1 */
export interface ReceiptsResponse {
  sessionId: string;
  receipts: WireSigned<Receipt>[];
}

/** GET /v1/sessions/:sessionId/checkpoint — latest checkpoint plus the voucher with the same seq. */
export interface CheckpointResponse {
  sessionId: string;
  verdict: WireSigned<SessionVerdict>;
  voucher: WireSigned<Voucher>;
}

/** GET /v1/health */
export interface HealthResponse {
  ok: boolean;
  verifier: Address;
  chainId: number;
  escrow: Address;
  rpc: { fuji: boolean; mainnet: [boolean, boolean] };
}

// ─────────────────────── Facilitator (x402 v2) ───────────────────────

/** paymentPayload.payload for scheme "agentpay-session". */
export interface AgentPaySessionPayload {
  params: Wire<OpenParams>;
  salt: Hex;
  authorization: Wire<Authorization>;
  attestation: WireSigned<ScoreAttestation>;
}

export interface PaymentRequirementsWire {
  scheme: "agentpay-session";
  network: string;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface FacilitatorRequest {
  x402Version: 2;
  paymentPayload: {
    x402Version: 2;
    scheme: "agentpay-session";
    network: string;
    payload: AgentPaySessionPayload;
  };
  paymentRequirements: PaymentRequirementsWire;
}

/** GET /supported */
export interface SupportedResponse {
  kinds: Array<{ x402Version: 2; scheme: "agentpay-session"; network: string }>;
}

/** POST /verify */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: ApiErrorCode | string;
  payer?: Address;
  /** Computed off-chain so the buyer can sign vouchers before the tx is mined. */
  sessionId?: string;
}

/** POST /settle — submits openWithAuthorization. Idempotent per (from, nonce). */
export interface SettleResponse {
  success: boolean;
  errorReason?: ApiErrorCode | string;
  payer?: Address;
  transaction?: Hex;
  network?: string;
  sessionId?: string;
}

// ───────────────────────────── Scorer ─────────────────────────────

/** GET /v1/attestation/:agentId?wallet=0x... */
export interface AttestationResponse {
  attestation: WireSigned<ScoreAttestation>;
  scorer: Address;
}

/** GET /v1/score/:agentId */
export interface ScoreResponse {
  agentId: string;
  wallet: Address;
  score: number;
  referenceScore: number;
  realScore: number | null;
  sessions: number;
  distinctBuyers: number;
  flags: number;
  updatedAt: string;
}

/** POST /v1/sellers/:agentId/wallet-proof — proves ownership of a mainnet wallet (reference score). */
export interface WalletProofRequest {
  mainnetWallet: Address;
  /** personal_sign of walletProofMessage(agentId, mainnetWallet, issuedAt) */
  signature: Hex;
  issuedAt: string;
}

export function walletProofMessage(agentId: bigint | string, wallet: Address, issuedAt: string): string {
  return `AgentPay wallet proof\nagentId: ${agentId}\nwallet: ${wallet.toLowerCase()}\nissuedAt: ${issuedAt}`;
}

// ───────────────────── Route table (for clients and tests) ─────────────────────

export const ROUTES = {
  verifier: {
    relay: (id: bigint | string) => `/v1/sessions/${id}/requests`,
    close: (id: bigint | string) => `/v1/sessions/${id}/close`,
    status: (id: bigint | string) => `/v1/sessions/${id}`,
    receipts: (id: bigint | string) => `/v1/sessions/${id}/receipts`,
    checkpoint: (id: bigint | string) => `/v1/sessions/${id}/checkpoint`,
    health: () => `/v1/health`,
  },
  facilitator: {
    supported: () => `/supported`,
    verify: () => `/verify`,
    settle: () => `/settle`,
  },
  scorer: {
    attestation: (agentId: bigint | string) => `/v1/attestation/${agentId}`,
    score: (agentId: bigint | string) => `/v1/score/${agentId}`,
    walletProof: (agentId: bigint | string) => `/v1/sellers/${agentId}/wallet-proof`,
  },
} as const;
