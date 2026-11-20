import { expect, it } from "vitest";
import { recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as sdk from "../src/index.js";

const signer = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const chain = sdk.CHAIN_ID.fuji;
const escrow = other.address;
const base = { sessionId: 1n, seq: 1, requestHash: sdk.ZERO_HASH };
const delivery = { ...base, bodyHash: sdk.ZERO_HASH, specHash: sdk.ZERO_HASH };
function roundTrip<T>(name: string, message: T, changed: Partial<T>,
  sign: (a: LocalAccount, c: number, e: Address, m: T) => Promise<sdk.Signed<T>>,
  verify: (c: number, e: Address, s: sdk.Signed<T>, a: Address) => Promise<boolean>) {
  it(name, async () => {
    const signed = await sign(signer, chain, escrow, message);
    expect(await verify(chain, escrow, signed, signer.address)).toBe(true);
    expect(await verify(chain, escrow, { ...signed, message: { ...message, ...changed } }, signer.address)).toBe(false);
    expect(await verify(chain, escrow, await sign(other, chain, escrow, message), signer.address)).toBe(false);
    expect(await verify(chain + 1, escrow, signed, signer.address)).toBe(false);
    expect(await verify(chain, escrow, { ...signed, signature: "0x12" }, signer.address)).toBe(false);
  });
}
roundTrip("Voucher", { ...base, cumulativeAmount: 100n }, { seq: 2 }, sdk.signVoucher, sdk.verifyVoucher);
roundTrip("Delivery", delivery, { seq: 2 }, sdk.signDelivery, sdk.verifyDelivery);
roundTrip("Receipt", { ...base, bodyHash: sdk.ZERO_HASH, outcome: 1, reasonCode: 0, amount: 100n, receivedAt: 10n, evidenceHash: sdk.ZERO_HASH },
  { outcome: 2 }, sdk.signReceipt, sdk.verifyReceipt);
roundTrip("SessionVerdict", { sessionId: 1n, specHash: sdk.ZERO_HASH, lastSeq: 1, passCount: 1, failCount: 0,
  inconclusiveCount: 0, passedAmount: 100n, receiptsRoot: sdk.ZERO_HASH, closedAt: 11n }, { passCount: 0 },
  sdk.signSessionVerdict, sdk.verifySessionVerdict);
roundTrip("ScoreAttestation", { agentId: 1n, wallet: escrow, score: 70, flags: 0, validUntil: 100n },
  { score: 71 }, sdk.signScoreAttestation, sdk.verifyScoreAttestation);
roundTrip("CloseRequest", { sessionId: 1n, deadline: 100n }, { deadline: 101n }, sdk.signCloseRequest, sdk.verifyCloseRequest);

const admin = { buyer: other.address, deadline: 100n, nonce: 1n };
it("binds the attestation to the Scorer domain", async () => {
  const message = { agentId: 1n, wallet: escrow, score: 70, flags: 0, validUntil: 100n };
  const { signature } = await sdk.signScoreAttestation(signer, chain, escrow, message);
  const data = { types: sdk.TYPES.ScoreAttestation, primaryType: "ScoreAttestation" as const, message, signature };
  expect(await recoverTypedDataAddress({ ...data, domain: sdk.scorerDomain(chain, escrow) })).toBe(signer.address);
  expect(await recoverTypedDataAddress({ ...data, domain: sdk.agentPayDomain(chain, escrow) })).not.toBe(signer.address);
});
const policy = { maxPerSession: 5n, dailyCap: 50n, minScore: 60, paused: false, sellerAllowlistOn: true };
const actions = {
  Tighten: { ...admin, policy }, ProposeLoosen: { ...admin, policy }, CancelLoosen: admin, PauseBuyer: admin,
  SetSellerAllowed: { ...admin, agentId: 2n, allowed: true }, CancelSellerAllowed: { ...admin, agentId: 2n },
  ProposeAdmin: { ...admin, newAdmin: escrow }, CancelAdmin: admin,
};
for (const action of Object.keys(actions) as (keyof typeof actions)[]) {
  it(action + " BySig", async () => {
    const message = actions[action];
    const signature = await sdk.signAdminAction(signer, chain, escrow, action, message);
    const data = { types: sdk.TYPES[action], primaryType: action, domain: sdk.agentPayDomain(chain, escrow), message, signature };
    expect(await recoverTypedDataAddress(data)).toBe(signer.address);
    expect(await recoverTypedDataAddress({ ...data, message: { ...message, nonce: 2n } })).not.toBe(signer.address);
    expect(await recoverTypedDataAddress({ ...data, signature: await sdk.signAdminAction(other, chain, escrow, action, message) })).not.toBe(signer.address);
  });
}

it.each(["ReceiveWithAuthorization", "CancelAuthorization"] as const)("%s USDC domain and contract signature parts", async primaryType => {
  const receive = { from: signer.address, to: escrow, value: 10n, validAfter: 0n, validBefore: 120n, nonce: sdk.ZERO_HASH };
  const cancel = { authorizer: signer.address, nonce: sdk.ZERO_HASH };
  const usdc = sdk.USDC.fuji;
  const sign = (account: LocalAccount) => primaryType === "ReceiveWithAuthorization"
    ? sdk.signReceiveAuthorization(account, chain, usdc, receive) : sdk.signCancelAuthorization(account, chain, usdc, cancel);
  const { signature, r, s, v } = await sign(signer);
  expect([27, 28]).toContain(v);
  expect(r + s.slice(2) + v.toString(16)).toBe(signature);
  const domain = { name: "USD Coin", version: "2", chainId: chain, verifyingContract: usdc };
  const data = { domain, primaryType, types: sdk.TYPES[primaryType], message: primaryType === "ReceiveWithAuthorization" ? receive : cancel, signature };
  expect(await recoverTypedDataAddress(data)).toBe(signer.address);
  expect(await recoverTypedDataAddress({ ...data, domain: { ...domain, name: "USDC" } })).not.toBe(signer.address);
  expect(await recoverTypedDataAddress({ ...data, message: { ...data.message, nonce: ("0x" + "11".repeat(32)) as Hex } })).not.toBe(signer.address);
  expect(await recoverTypedDataAddress({ ...data, signature: (await sign(other)).signature })).not.toBe(signer.address);
});
