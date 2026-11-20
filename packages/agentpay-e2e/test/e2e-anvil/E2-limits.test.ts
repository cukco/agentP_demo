import { expect, it } from "vitest";
import { fixture, policy } from "../helpers.js";
import { agentPaySessionEscrowAbi } from "@agentpay/core";
const get = fixture();
it("E2: over-cap and low-score attempts are rejected without opening a session", async () => {
  const s = get(), buyer = s.chain.accounts.buyer.address;
  await s.write("registerBuyer", [s.chain.accounts.owner.address, { ...policy, minScore: 50 }], "buyer");
  const before = await s.balances();
  await expect(s.open({ cap: 20000000n })).rejects.toThrow(/OverPerSession/);
  await expect(s.open()).rejects.toThrow(/BadScore/);
  expect(await s.balances()).toEqual(before);
  expect(await s.chain.publicClient.getContractEvents({ address: s.chain.escrow, abi: agentPaySessionEscrowAbi,
    eventName: "SessionOpened", args: { buyer }, fromBlock: 0n })).toHaveLength(0);
});
