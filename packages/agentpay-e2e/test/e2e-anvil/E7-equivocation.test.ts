import { expect, it } from "vitest";
import { keccak256, toHex, parseAbi } from "viem";
import { signDelivery } from "@agentpay/core";
import { SPEC } from "../../src/chain.js";
import { fixture, feedbackCount } from "../helpers.js";
const get = fixture();
it("E7: conflicting signed deliveries refund all cap and emit negative feedback", async () => {
  const s = get(), before = await s.balances();
  const { id } = await s.open();
  const a = { sessionId: id, seq: 1, requestHash: SPEC, specHash: SPEC, bodyHash: keccak256(toHex("one")) };
  const b = { ...a, bodyHash: keccak256(toHex("two")) };
  const sa = await signDelivery(s.chain.accounts.seller, 43113, s.chain.escrow, a);
  const sb = await signDelivery(s.chain.accounts.seller, 43113, s.chain.escrow, b);
  await s.write("proveEquivocation", [id, a, sa.signature, b, sb.signature], "buyer");
  expect(await s.balances()).toEqual(before); expect(await s.chain.state(id)).toBe(5);
  expect(await feedbackCount(s)).toBe(1n);
  const row = await s.chain.publicClient.readContract({ address: s.reputation,
    abi: parseAbi(["function get(uint256) view returns ((uint256 agentId,int128 value,uint8 valueDecimals,string tag1,string tag2,bytes32 feedbackHash,address client))"]), functionName: "get", args: [0n] });
  expect(row.value).toBe(-100n); expect(row.tag2).toBe("equivocation");
});
