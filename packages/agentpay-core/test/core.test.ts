import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  TYPES,
  agentPayDomain,
  encodeType,
  fromWire,
  merkleProof,
  merkleRoot,
  openNonce,
  receiptsRoot,
  requestHash,
  sessionId,
  specHash,
  toWire,
  typeHash,
  verifyMerkleProof,
  agentPaySessionEscrowAbi,
  type Receipt,
  type Voucher,
} from "../src/index.js";
import { buildFreezeVectors, VECTOR_INPUT } from "../src/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("freeze vectors", () => {
  it("vectors/freeze.json is up to date (run pnpm gen:vectors)", () => {
    const onDisk = JSON.parse(readFileSync(resolve(here, "../vectors/freeze.json"), "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildFreezeVectors())));
  });

  it("type strings match the Solidity library", () => {
    expect(encodeType("Voucher", TYPES.Voucher)).toBe(
      "Voucher(uint256 sessionId,uint32 seq,uint128 cumulativeAmount,bytes32 requestHash)",
    );
    expect(encodeType("Tighten", TYPES.Tighten)).toBe(
      "Tighten(address buyer,Policy policy,uint256 nonce,uint256 deadline)Policy(uint128 maxPerSession,uint128 dailyCap,uint16 minScore,bool paused,bool sellerAllowlistOn)",
    );
    expect(typeHash("CloseRequest")).toBe(keccak256(toHex("CloseRequest(uint256 sessionId,uint256 deadline)")));
  });
});

describe("hashes", () => {
  it("openNonce changes when any parameter changes (incl. voucherSigner)", () => {
    const base = openNonce(VECTOR_INPUT.params, VECTOR_INPUT.salt);
    const keys = Object.keys(VECTOR_INPUT.params) as (keyof typeof VECTOR_INPUT.params)[];
    for (const k of keys) {
      const p = { ...VECTOR_INPUT.params } as Record<string, unknown>;
      const v = p[k];
      p[k] =
        typeof v === "bigint"
          ? v + 1n
          : typeof v === "number"
            ? v + 1
            : k === "specHash"
              ? "0x" + "ab".repeat(32)
              : "0x000000000000000000000000000000000000bEEF";
      expect(openNonce(p as never, VECTOR_INPUT.salt), k).not.toBe(base);
    }
  });

  it("sessionId depends on buyer", () => {
    const n = openNonce(VECTOR_INPUT.params, VECTOR_INPUT.salt);
    expect(sessionId(VECTOR_INPUT.buyer, n)).not.toBe(sessionId(VECTOR_INPUT.params.seller, n));
  });

  it("specHash is JCS: key order and whitespace do not matter", () => {
    const a = specHash({ b: 1, a: { y: 2, x: [1, 2] } });
    const b = specHash(JSON.parse('{ "a": {"x":[1,2], "y":2},  "b":1 }'));
    expect(a).toBe(b);
    expect(specHash({ a: 1 })).not.toBe(specHash({ a: 2 }));
  });

  it("requestHash normalises method case and binds url + body", () => {
    expect(requestHash("get", "https://x/a")).toBe(requestHash("GET", "https://x/a"));
    expect(requestHash("GET", "https://x/a")).not.toBe(requestHash("GET", "https://x/b"));
    expect(requestHash("POST", "https://x/a", new Uint8Array([1]))).not.toBe(requestHash("POST", "https://x/a"));
  });
});

describe("merkle", () => {
  const leaves = Array.from({ length: 7 }, (_, i) => keccak256(toHex(`leaf${i}`)));
  it("every proof verifies (odd sizes included)", () => {
    for (let n = 1; n <= leaves.length; n++) {
      const set = leaves.slice(0, n);
      const root = merkleRoot(set);
      set.forEach((leaf, i) => expect(verifyMerkleProof(leaf, merkleProof(set, i), root)).toBe(true));
    }
  });
  it("receiptsRoot sorts by seq", () => {
    const r = (seq: number): Receipt => ({
      sessionId: 1n,
      seq,
      requestHash: keccak256(toHex(seq)),
      bodyHash: keccak256(toHex(seq + 100)),
      outcome: 1,
      reasonCode: 0,
      amount: 10_000n,
      receivedAt: 1000n + BigInt(seq),
      evidenceHash: `0x${"00".repeat(32)}`,
    });
    expect(receiptsRoot([r(2), r(1), r(3)])).toBe(receiptsRoot([r(1), r(2), r(3)]));
  });
});

describe("wire", () => {
  it("round-trips a Voucher", () => {
    const v: Voucher = { sessionId: 2n ** 255n, seq: 4, cumulativeAmount: 40_000n, requestHash: `0x${"11".repeat(32)}` };
    const w = JSON.parse(JSON.stringify(toWire(v)));
    expect(fromWire<Voucher>("Voucher", w)).toEqual(v);
  });
  it("rejects malformed bigint fields", () => {
    expect(() => fromWire("Voucher", { sessionId: "1e3", seq: 1, cumulativeAmount: "1", requestHash: "0x" } as never)).toThrow();
  });
});

describe("signatures", () => {
  it("a voucher signed with viem recovers to the voucherSigner", async () => {
    const acct = privateKeyToAccount(`0x${"42".repeat(32)}`);
    const domain = agentPayDomain(43113, VECTOR_INPUT.escrow);
    const message: Voucher = { sessionId: 1n, seq: 1, cumulativeAmount: 10_000n, requestHash: `0x${"aa".repeat(32)}` };
    const sig = await acct.signTypedData({ domain, types: TYPES.Voucher, primaryType: "Voucher", message });
    const { recoverTypedDataAddress } = await import("viem");
    const who = await recoverTypedDataAddress({ domain, types: TYPES.Voucher, primaryType: "Voucher", message, signature: sig });
    expect(who).toBe(acct.address);
  });
});

describe("abi", () => {
  it("exposes the frozen entry points", () => {
    const names = new Set(agentPaySessionEscrowAbi.filter((e) => e.type === "function").map((e) => e.name));
    for (const fn of [
      "openWithAuthorization",
      "closeSession",
      "closeEmpty",
      "challenge",
      "resolveChallenge",
      "expireChallenge",
      "proveEquivocation",
      "finalize",
      "refund",
      "withdraw",
      "registerBuyer",
      "tighten",
      "proposeLoosen",
      "applyLoosen",
      "cancelLoosen",
      "pauseBuyer",
      "setSellerAllowed",
      "proposeAdmin",
      "sessionFee",
    ]) {
      expect(names.has(fn), fn).toBe(true);
    }
  });
});
