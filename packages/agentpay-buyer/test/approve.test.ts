import { CHAIN_ID, VERIFIER_LIMITS, ZERO_HASH, openNonce, specHash, toWire, type OpenParams, type VerificationSpec } from "@agentpay/core";
import { expect, it, vi } from "vitest";
import { checkParams, type OpenReview } from "../src/approve/params.js";
import { requestApproval } from "../src/approve/server.js";

const address = "0x0000000000000000000000000000000000000001";
function review(): OpenReview {
  const spec: VerificationSpec = { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
    verifier: { address, endpoint: "https://verifier.example" }, delivery: { contentType: "application/octet-stream", maxBytes: 100 },
    checks: [{ id: "hash", type: "hash-match", expectedHash: ZERO_HASH }],
  };
  const params: OpenParams = { seller: address, sellerAgentId: 1n, verifier: address, voucherSigner: address,
    specHash: specHash(spec), cap: 1_000_000n, pricePerRequest: 10_000n, expiry: 1_900_000_000n,
    deliveryDeadlineSec: 10, challengeWindowSec: 60 };
  return { kind: "open", buyer: address, escrow: address, chainId: CHAIN_ID.fuji, asset: address,
    params: toWire(params), spec, salt: ZERO_HASH, nonce: openNonce(params, ZERO_HASH), domain: "seller.example", score: 80, fee: "40000" };
}

async function fixture() {
  let ready!: (value: string) => void;
  const url = new Promise<string>(resolve => { ready = resolve; });
  const approval = requestApproval(review(), { clock: () => 1_800_000_000, onApprovalUrl: ready });
  const rejection = approval.catch(error => error);
  const parsed = new URL(await url);
  return { origin: parsed.origin, authorization: "Bearer " + parsed.hash.slice(1), rejection };
}

it("rejects changes to any nonce-bound field and changes to the visible Spec", () => {
  const original = review();
  expect(checkParams(original, original.nonce)).toBe(true);
  const other = "0x0000000000000000000000000000000000000002";
  const changes = { seller: other, sellerAgentId: "2", verifier: other, voucherSigner: other, specHash: ZERO_HASH,
    cap: "2000000", pricePerRequest: "12000", expiry: "1900001000", deliveryDeadlineSec: 11, challengeWindowSec: 61 };
  for (const [key, value] of Object.entries(changes)) {
    expect(checkParams({ ...original, params: { ...original.params, [key]: value } }, original.nonce), key).toBe(false);
  }
  expect(checkParams({ ...original, spec: { ...original.spec, delivery: { ...original.spec.delivery, maxBytes: 200 } } }, original.nonce)).toBe(false);
});

it("limits review to the loopback token, rejects a cross-origin post and consumes the token on decline", async () => {
  const { origin, authorization, rejection } = await fixture();
  expect(new URL(origin).hostname).toBe("127.0.0.1");
  expect((await fetch(origin + "/params")).status).toBe(403);
  expect((await fetch(origin + "/params", { headers: { authorization } })).status).toBe(200);
  const submit = (requestOrigin: string) => fetch(origin + "/signature", { method: "POST",
    headers: { authorization, origin: requestOrigin, "content-type": "application/json" }, body: '{"rejected":true}' });
  expect((await submit("https://unrelated.example")).status).toBe(403);
  expect((await submit(origin)).status).toBe(200);
  expect(await rejection).toMatchObject({ code: "APPROVAL_REJECTED" });
  const repeated = await submit(origin).catch(() => undefined);
  expect(repeated?.status ?? 410).toBe(410);
});

it("times out at 5 minutes and closes the localhost listener", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { origin, rejection } = await fixture();
    const done = vi.fn();
    void rejection.then(done);
    await vi.advanceTimersByTimeAsync(VERIFIER_LIMITS.APPROVAL_TIMEOUT_SEC * 1000 - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await rejection).toMatchObject({ code: "APPROVAL_TIMEOUT" });
    await expect(fetch(origin)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});
