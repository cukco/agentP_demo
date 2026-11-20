import { expect, it } from "vitest";
import { fixture, feedbackCount } from "../helpers.js";
const get = fixture();
it("E6: stalled arbitration refunds cap and bond through Keeper", async () => {
  const s = get(), before = await s.balances();
  const { id } = await s.open();
  await s.chain.close(id, 15, 15, 0);
  await s.chain.challengeByBuyer(id);
  await s.advance(86401);
  expect((await s.keeper.runOnce()).map(a => a.action)).toContain("expireChallenge");
  expect(await s.chain.state(id)).toBe(5); expect(await s.balances()).toEqual(before);
  expect(await feedbackCount(s)).toBe(0n);
});
