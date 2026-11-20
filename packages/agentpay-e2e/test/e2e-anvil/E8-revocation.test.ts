import { expect, it } from "vitest";
import { fixture, feedbackCount } from "../helpers.js";
const get = fixture();
it("E8: revoking verifier blocks new sessions and refunds the old one", async () => {
  const s = get(), before = await s.balances(); const { id } = await s.open();
  await s.write("revokeVerifier", [s.chain.accounts.verifier.address]);
  await expect(s.open()).rejects.toThrow(/UnknownVerifier/);
  await s.advance(781);
  await s.write("refund", [id]);
  expect(await s.chain.state(id)).toBe(5); expect(await s.balances()).toEqual(before);
  expect(await feedbackCount(s)).toBe(0n);
});
