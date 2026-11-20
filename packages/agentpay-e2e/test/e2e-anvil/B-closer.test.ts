import { expect, it } from "vitest";
import { signCloseRequest, toWire } from "@agentpay/core";
import { fixture } from "../helpers.js";
const get = fixture();
it("B6: signed concurrent empty closes refund once through the production API", async () => {
  const s = get(),
    before = await s.balances(),
    { id } = await s.open();
  const payload = toWire(
    await signCloseRequest(s.chain.accounts.buyer, 43113, s.chain.escrow, {
      sessionId: id,
      deadline: BigInt(s.clock() + 60),
    }),
  );
  const close = () =>
    fetch(`${s.urls.verifier}/v1/sessions/${id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ closeRequest: payload }),
    });
  const [a, b] = await Promise.all([close(), close()]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const first = await a.json(),
    second = await b.json();
  expect(first.kind).toBe("closeEmpty");
  expect(second.txHash).toBe(first.txHash);
  expect(await s.chain.state(id)).toBe(5);
  expect(await s.balances()).toEqual(before);
});
it("B6: expiry sweep closes a real empty session before the deadline", async () => {
  const s = get(),
    { id } = await s.open({ expiry: BigInt(s.clock() + 125) });
  expect((await fetch(`${s.urls.verifier}/v1/sessions/${id}`)).status).toBe(
    200,
  );
  await s.advance(6);
  await s.runtime.tick();
  expect(await s.chain.state(id)).toBe(5);
  expect(s.vdb.session(id)?.close_tx).toMatch(/^0x/);
});
