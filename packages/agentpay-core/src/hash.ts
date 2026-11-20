import canonicalize from "canonicalize";
import {
  concat,
  encodeAbiParameters,
  hashStruct,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { TYPES } from "./eip712.js";
import type { OpenParams, Receipt, VerificationSpec } from "./types.js";

/** Spec §6.1: keccak256(UTF-8(JCS(verificationSpec))), JCS = RFC 8785. */
export function specHash(spec: VerificationSpec | Record<string, unknown>): Hex {
  const canonical = canonicalize(spec);
  if (canonical === undefined) throw new Error("specHash: spec is not JSON-serialisable");
  return keccak256(toBytes(canonical));
}

/** Spec §6.1: keccak256 of the raw body bytes. Never re-serialise JSON first. */
export function bodyHash(body: Uint8Array): Hex {
  return keccak256(body);
}

/**
 * Spec §6.1: keccak256(abi.encode(string method, string url, bytes32 keccak256(requestBody))).
 * method is upper-case; url is the exact absolute URL string the buyer requested.
 */
export function requestHash(method: string, url: string, body: Uint8Array = new Uint8Array()): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "bytes32" }],
      [method.toUpperCase(), url, keccak256(body)],
    ),
  );
}

/** SystemDesign §4.2: EIP-3009 nonce binding every session parameter. */
export function openNonce(p: OpenParams, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "uint64" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "bytes32" },
      ],
      [
        p.seller,
        p.sellerAgentId,
        p.verifier,
        p.voucherSigner,
        p.specHash,
        p.cap,
        p.pricePerRequest,
        p.expiry,
        p.deliveryDeadlineSec,
        p.challengeWindowSec,
        salt,
      ],
    ),
  );
}

/** sessionId = uint256(keccak256(abi.encode(buyer, nonce))). Known before the open tx is mined. */
export function sessionId(buyer: Address, nonce: Hex): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [buyer, nonce])));
}

/** Oracle evidence: keccak256(abi.encode(address feed, uint80 roundId, int256 answer, uint256 updatedAt)). */
export function evidenceHash(feed: Address, roundId: bigint, answer: bigint, updatedAt: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint80" }, { type: "int256" }, { type: "uint256" }],
      [feed, roundId, answer, updatedAt],
    ),
  );
}

export const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Merkle leaf of a Receipt = its EIP-712 struct hash (keccak256(abi.encode(RECEIPT_TYPEHASH, ...fields))). */
export function receiptLeaf(r: Receipt): Hex {
  return hashStruct({ data: r, primaryType: "Receipt", types: TYPES.Receipt });
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * receiptsRoot: sorted-pair keccak Merkle tree over receiptLeaf() in seq order.
 * Odd node at a level is carried up unchanged. Empty list -> ZERO_HASH.
 * Proofs verify with OpenZeppelin MerkleProof.verify.
 */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return ZERO_HASH;
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error("merkleProof: index out of range");
  const proof: Hex[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) {
      next.push(j + 1 < level.length ? hashPair(level[j]!, level[j + 1]!) : level[j]!);
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  return proof.reduce((acc, p) => hashPair(acc, p), leaf).toLowerCase() === root.toLowerCase();
}

export function receiptsRoot(receipts: Receipt[]): Hex {
  const sorted = [...receipts].sort((a, b) => a.seq - b.seq);
  return merkleRoot(sorted.map(receiptLeaf));
}
