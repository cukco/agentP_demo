import { keccak256, toHex, type Address, type TypedDataDomain } from "viem";
import { AGENTPAY_VERSION, USDC_DOMAIN } from "./constants.js";

/**
 * Frozen EIP-712 definitions. Field order and types must match
 * contracts/src/libraries/AgentPayHashes.sol exactly (checked by the freeze vectors).
 */

export const DOMAIN_NAME = "AgentPay" as const;
export const SCORER_DOMAIN_NAME = "AgentPay Scorer" as const;

export function agentPayDomain(chainId: number, escrow: Address): TypedDataDomain {
  return { name: DOMAIN_NAME, version: AGENTPAY_VERSION, chainId, verifyingContract: escrow };
}

export function scorerDomain(chainId: number, escrow: Address): TypedDataDomain {
  return { name: SCORER_DOMAIN_NAME, version: AGENTPAY_VERSION, chainId, verifyingContract: escrow };
}

export function usdcDomain(chainId: number, usdc: Address): TypedDataDomain {
  return { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version, chainId, verifyingContract: usdc };
}

const Policy = [
  { name: "maxPerSession", type: "uint128" },
  { name: "dailyCap", type: "uint128" },
  { name: "minScore", type: "uint16" },
  { name: "paused", type: "bool" },
  { name: "sellerAllowlistOn", type: "bool" },
] as const;

export const TYPES = {
  Voucher: {
    Voucher: [
      { name: "sessionId", type: "uint256" },
      { name: "seq", type: "uint32" },
      { name: "cumulativeAmount", type: "uint128" },
      { name: "requestHash", type: "bytes32" },
    ],
  },
  Delivery: {
    Delivery: [
      { name: "sessionId", type: "uint256" },
      { name: "seq", type: "uint32" },
      { name: "requestHash", type: "bytes32" },
      { name: "bodyHash", type: "bytes32" },
      { name: "specHash", type: "bytes32" },
    ],
  },
  Receipt: {
    Receipt: [
      { name: "sessionId", type: "uint256" },
      { name: "seq", type: "uint32" },
      { name: "requestHash", type: "bytes32" },
      { name: "bodyHash", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "reasonCode", type: "uint16" },
      { name: "amount", type: "uint128" },
      { name: "receivedAt", type: "uint64" },
      { name: "evidenceHash", type: "bytes32" },
    ],
  },
  SessionVerdict: {
    SessionVerdict: [
      { name: "sessionId", type: "uint256" },
      { name: "specHash", type: "bytes32" },
      { name: "lastSeq", type: "uint32" },
      { name: "passCount", type: "uint32" },
      { name: "failCount", type: "uint32" },
      { name: "inconclusiveCount", type: "uint32" },
      { name: "passedAmount", type: "uint128" },
      { name: "receiptsRoot", type: "bytes32" },
      { name: "closedAt", type: "uint64" },
    ],
  },
  ScoreAttestation: {
    ScoreAttestation: [
      { name: "agentId", type: "uint256" },
      { name: "wallet", type: "address" },
      { name: "score", type: "uint16" },
      { name: "flags", type: "uint16" },
      { name: "validUntil", type: "uint64" },
    ],
  },
  CloseRequest: {
    CloseRequest: [
      { name: "sessionId", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  Tighten: {
    Tighten: [
      { name: "buyer", type: "address" },
      { name: "policy", type: "Policy" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    Policy,
  },
  ProposeLoosen: {
    ProposeLoosen: [
      { name: "buyer", type: "address" },
      { name: "policy", type: "Policy" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    Policy,
  },
  CancelLoosen: {
    CancelLoosen: [
      { name: "buyer", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  PauseBuyer: {
    PauseBuyer: [
      { name: "buyer", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  SetSellerAllowed: {
    SetSellerAllowed: [
      { name: "buyer", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "allowed", type: "bool" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  CancelSellerAllowed: {
    CancelSellerAllowed: [
      { name: "buyer", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  ProposeAdmin: {
    ProposeAdmin: [
      { name: "buyer", type: "address" },
      { name: "newAdmin", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  CancelAdmin: {
    CancelAdmin: [
      { name: "buyer", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  /** EIP-3009 on USDC (signed with usdcDomain). */
  ReceiveWithAuthorization: {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  CancelAuthorization: {
    CancelAuthorization: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
  },
} as const;

export type PrimaryType = keyof typeof TYPES;

type Field = { readonly name: string; readonly type: string };
type TypeSet = Record<string, readonly Field[]>;

/** EIP-712 encodeType: primary type first, then referenced struct types sorted by name. */
export function encodeType(primaryType: string, types: TypeSet): string {
  const deps = new Set<string>();
  const visit = (t: string) => {
    for (const f of types[t] ?? []) {
      const base = f.type.replace(/\[.*\]$/, "");
      if (types[base] && base !== primaryType && !deps.has(base)) {
        deps.add(base);
        visit(base);
      }
    }
  };
  visit(primaryType);
  const fmt = (t: string) => `${t}(${(types[t] ?? []).map((f) => `${f.type} ${f.name}`).join(",")})`;
  return [primaryType, ...[...deps].sort()].map(fmt).join("");
}

export function typeHash(primaryType: PrimaryType): `0x${string}` {
  return keccak256(toHex(encodeType(primaryType, TYPES[primaryType] as unknown as TypeSet)));
}
