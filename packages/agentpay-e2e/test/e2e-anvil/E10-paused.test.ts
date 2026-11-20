import { expect, it } from "vitest";
import { fixture, policy } from "../helpers.js";
const get = fixture();
it("E10 contract boundary: admin pause prevents Facilitator opening a session", async () => {
  const s = get();
  await s.write("registerBuyer", [s.chain.accounts.owner.address, policy], "buyer");
  await s.write("pauseBuyer", [s.chain.accounts.buyer.address]);
  const before = await s.balances(); await expect(s.open()).rejects.toThrow(/BuyerIsPaused/);
  expect(await s.balances()).toEqual(before);
});
