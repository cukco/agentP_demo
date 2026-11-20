import { expect, it } from "vitest";
import { fixture, feedbackCount } from "../helpers.js";
import { sdkFixture } from "../sdk-fixture.js";
const get = fixture();
it("E3: Seller SDK recovers persisted checkpoint after Verifier outage and pays exactly through Keeper", async () => {
  const s = get(),
    before = await s.balances(),
    sdk = await sdkFixture(s);
  try {
    for (let i = 0; i < 20; i++) {
      expect((await sdk.buyer.fetch(sdk.url)).status).toBe(200);
      await s.advance(1);
    }
    const [session] = await sdk.buyerStore.list(),
      id = BigInt(session.id);
    await sdk.sellerSync();
    expect(
      (await sdk.sellerStore.get(id))?.checkpoint?.verdict.message.lastSeq,
    ).toBe(20);
    await sdk.stopVerifier();
    sdk.restartSeller();
    await s.advance(181);
    await sdk.sellerSync();
    expect(await s.chain.state(id)).toBe(2);
    await s.advance(31);
    expect((await s.keeper.runOnce()).map((a) => a.action)).toContain(
      "finalize",
    );
    const after = await s.balances();
    expect(await s.chain.state(id)).toBe(4);
    expect(before.buyer - after.buyer).toBe(240_000n);
    expect(after.seller - before.seller).toBe(199_000n);
    expect(after.escrow - before.escrow).toBe(41_000n);
    expect(await feedbackCount(s)).toBe(1n);
  } finally {
    await sdk.stop();
  }
}, 120_000);
