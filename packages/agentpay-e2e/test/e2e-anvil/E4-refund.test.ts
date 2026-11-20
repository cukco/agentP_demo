import { expect, it } from "vitest";
import { fixture, feedbackCount } from "../helpers.js";
const get = fixture();
it("E4: Keeper refunds all cap after expiry + grace, with no feedback", async () => {
  const s = get(), before = await s.balances();
  const { id } = await s.open();
  expect(await (await fetch(`${s.urls.verifier}/v1/sessions/${id}`)).json()).toMatchObject({ state: "OPEN" });
  await s.advance(781);
  expect((await s.keeper.runOnce()).map(a => a.action)).toContain("refund");
  expect(await s.chain.state(id)).toBe(5);
  expect(await s.balances()).toEqual(before);
  expect(await feedbackCount(s)).toBe(0n);
});
