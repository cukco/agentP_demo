import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, parseSignature, toHex, type Abi, type Hex } from "viem";
import { NETWORK, SCHEME, TYPES, agentPaySessionEscrowAbi, openNonce, scorerDomain, toWire, usdcDomain, type OpenParams } from "@agentpay/core";
import { createApp } from "../src/app.js";
import { startChain, AGENT_ID, PRICE, SPEC, type TestChain } from "../../agentpay-keeper/test/helpers/chain.js";

// Facilitator against the real AgentPaySessionEscrow on anvil (chain id 43113 so the Fuji USDC domain applies).
// Needs `forge build` in contracts/ and anvil (Foundry).
let chain: TestChain;
beforeAll(async () => { chain = await startChain({ chainId: 43113 }); }, 120_000);
afterAll(async () => { await chain?.stop(); });

async function payload(over: Partial<OpenParams> = {}, opts: { usdcName?: string; tamperCap?: boolean } = {}) {
  const a = chain.accounts;
  const t = await chain.now();
  const p: OpenParams = { seller: a.seller.address, sellerAgentId: AGENT_ID, verifier: a.verifier.address, voucherSigner: a.buyer.address,
    specHash: SPEC, cap: 1_000_000n, pricePerRequest: PRICE, expiry: t + 3600n, deliveryDeadlineSec: 10, challengeWindowSec: 60, ...over };
  const salt = keccak256(toHex(`fac-${Math.random()}`));
  const nonce = openNonce(p, salt);
  const domain = { ...usdcDomain(43113, chain.usdc), ...(opts.usdcName ? { name: opts.usdcName } : {}) };
  const sig = await a.buyer.signTypedData({ domain, types: TYPES.ReceiveWithAuthorization, primaryType: "ReceiveWithAuthorization",
    message: { from: a.buyer.address, to: chain.escrow, value: p.cap, validAfter: 0n, validBefore: t + 120n, nonce } });
  const { v, r, s } = parseSignature(sig);
  const att = { agentId: AGENT_ID, wallet: a.seller.address, score: 80, flags: 0, validUntil: t + 3000n };
  const attSig = await a.scorer.signTypedData({ domain: scorerDomain(43113, chain.escrow), types: TYPES.ScoreAttestation, primaryType: "ScoreAttestation", message: att });
  const params = opts.tamperCap ? { ...p, cap: p.cap + 1n } : p;
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, scheme: SCHEME, network: NETWORK.fuji, payload: {
      params: toWire(params), salt,
      authorization: toWire({ from: a.buyer.address, value: p.cap, validAfter: 0n, validBefore: t + 120n, nonce, v: Number(v), r, s }),
      attestation: { message: toWire(att), signature: attSig } } },
    paymentRequirements: { scheme: SCHEME, network: NETWORK.fuji, asset: chain.usdc, payTo: chain.escrow, amount: PRICE.toString(), maxTimeoutSeconds: 120, extra: {} },
  };
}

function app() {
  const clockRef = { now: 0 };
  return { app: createApp({ publicClient: chain.publicClient, walletClient: chain.wallet("owner") as never, escrow: chain.escrow, usdc: chain.usdc,
    clock: () => clockRef.now }), clockRef };
}
const post = async (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  (await a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

describe("B facilitator x real escrow (anvil)", () => {
  it("verify + settle opens a real session; repeat settle returns same tx", async () => {
    const { app: a, clockRef } = app(); clockRef.now = Number(await chain.now());
    const body = await payload();
    const v = await post(a, "/verify", body);
    expect(v).toMatchObject({ isValid: true });
    const s1 = await post(a, "/settle", body);
    expect(s1.success).toBe(true);
    expect(s1.sessionId).toBe(v.sessionId);
    expect(await chain.state(BigInt(s1.sessionId))).toBe(1);
    const s2 = await post(a, "/settle", body);
    expect(s2.transaction).toBe(s1.transaction);
  }, 60_000);
  it("tampered cap -> NONCE_MISMATCH", async () => {
    const { app: a, clockRef } = app(); clockRef.now = Number(await chain.now());
    expect(await post(a, "/verify", await payload({}, { tamperCap: true }))).toMatchObject({ isValid: false, invalidReason: "NONCE_MISMATCH" });
  }, 60_000);
  it("authorization.value != cap -> AUTH_VALUE_MISMATCH", async () => {
    const { app: a, clockRef } = app(); clockRef.now = Number(await chain.now());
    const body = await payload();
    body.paymentPayload.payload.authorization.value = (1_000_001n).toString();
    expect(await post(a, "/verify", body)).toMatchObject({ isValid: false, invalidReason: "AUTH_VALUE_MISMATCH" });
  }, 60_000);
  it("USDC domain name 'USDC' (wrong) -> BAD_AUTH_SIG", async () => {
    const { app: a, clockRef } = app(); clockRef.now = Number(await chain.now());
    expect(await post(a, "/verify", await payload({}, { usdcName: "USDC" }))).toMatchObject({ isValid: false, invalidReason: "BAD_AUTH_SIG" });
  }, 60_000);
  it("contract revert surfaces by name (cap above buyer rule -> OverPerSession)", async () => {
    const buyer = chain.wallet("buyer");
    const h = await buyer.writeContract({ address: chain.escrow, abi: agentPaySessionEscrowAbi as Abi, functionName: "registerBuyer",
      args: [chain.accounts.owner.address, { maxPerSession: 500_000n, dailyCap: 10_000_000n, minScore: 0, paused: false, sellerAllowlistOn: false }] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h as Hex });
    const { app: a, clockRef } = app(); clockRef.now = Number(await chain.now());
    expect(await post(a, "/verify", await payload())).toMatchObject({ isValid: false, invalidReason: "OverPerSession" });
  }, 60_000);
});
