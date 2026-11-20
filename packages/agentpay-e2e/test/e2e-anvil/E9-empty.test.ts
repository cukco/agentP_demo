import { expect, it } from "vitest";
import { signSessionVerdict } from "@agentpay/core";
import { zeroHash } from "viem";
import { SPEC } from "../../src/chain.js";
import { fixture, feedbackCount } from "../helpers.js";
const get = fixture();
it("E9: closeEmpty returns cap without fees or feedback", async () => {
  const s = get(), before = await s.balances(); const { id } = await s.open();
  const verdict = { sessionId: id, specHash: SPEC, lastSeq: 0, passCount: 0, failCount: 0, inconclusiveCount: 0,
    passedAmount: 0n, receiptsRoot: zeroHash, closedAt: await s.chain.now() };
  const signed = await signSessionVerdict(s.chain.accounts.verifier, 43113, s.chain.escrow, verdict);
  await s.write("closeEmpty", [id, verdict, signed.signature], "verifier");
  expect(await s.chain.state(id)).toBe(5); expect(await s.balances()).toEqual(before);
  expect(await feedbackCount(s)).toBe(0n);
});
