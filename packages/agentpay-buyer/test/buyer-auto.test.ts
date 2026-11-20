import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAIN_ID, HEADERS, Outcome, SessionState, ZERO_HASH, agentPaySessionEscrowAbi, bodyHash,
  decodeHeaderJson, encodeHeader, fromWire, receiptsRoot, signReceipt, signScoreAttestation,
  signSessionVerdict, toWire, verifyDelivery,
  type Delivery, type FacilitatorRequest, type Receipt, type RelayRequest, type RelayResponse, type VerificationSpec, type WireSigned,
} from "@agentpay/core";
import { Hono } from "hono";
import { erc20Abi, parseAbi, type Address } from "viem";
import { expect, it } from "vitest";
import { createApp as createFacilitator } from "../../agentpay-facilitator/src/app.js";
import { AGENT_ID, CAP, PRICE, startChain } from "../../agentpay-keeper/test/helpers/chain.js";
import { createAgentPaySeller } from "../../agentpay-seller/src/index.js";
import { BuyerReceiptError, createAgentPayBuyer, createFileBuyerStore } from "../src/index.js";
import { registerBuyer } from "../src/setup.js";

const url = "https://seller.example/v1/file";
const registryUri = "https://seller.example/registration.json";
const good = Uint8Array.of(0, 255, 128);
const bad = Uint8Array.of(0, 255, 129);
const testAbi = parseAbi([
  "function identityRegistry() view returns (address)",
  "function setTokenURI(uint256 id, string uri)",
  "function feesAccrued() view returns (uint128)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

it("H22: real escrow, facilitator and seller, with 15 PASS, 3 FAIL, automatic close and exact settlement", async () => {
  const chainId = CHAIN_ID.fuji;
  const chain = await startChain({ chainId });
  const { buyer, owner, scorer, seller, verifier } = chain.accounts;
  const { escrow, usdc, publicClient } = chain;
  const wallet = chain.wallet("buyer");
  const directory = await mkdtemp(join(tmpdir(), "agentpay-buyer-"));
  const store = createFileBuyerStore(directory);
  let now = Number(await chain.now());
  const spec: VerificationSpec = { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
    verifier: { address: verifier.address, endpoint: "https://verifier.example/v1" },
    delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
    checks: [{ type: "hash-match", id: "binary", expectedHash: bodyHash(good) }],
  };
  const check = (body: Uint8Array) => bodyHash(body) === bodyHash(good) ? Outcome.PASS : Outcome.FAIL;
  const sdk = createAgentPaySeller({
    account: seller, escrow, chainId, asset: usdc, spec, publicClient, walletClient: chain.wallet("seller"),
    sellerAgentId: AGENT_ID, pricePerRequest: PRICE, clock: () => now, verifierUrl: spec.verifier.endpoint,
    terms: { minCap: 500_000n, maxCap: 20_000_000n, defaultExpirySec: 3600, maxExpirySec: 86400,
      deliveryDeadlineSec: 10, challengeWindowSec: 60 },
  });
  sdk.stop();

  async function mined(hash: Parameters<typeof publicClient.waitForTransactionReceipt>[0]["hash"]) {
    expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
  }

  try {
    const policy = await registerBuyer({ escrow, account: buyer, admin: owner.address, publicClient, walletClient: wallet,
      policy: { maxPerSession: CAP, dailyCap: 10n * CAP, minScore: 50, paused: false, sellerAllowlistOn: false } });
    expect(policy).toMatchObject({ admin: owner.address, maxPerSession: CAP });
    const registry = await publicClient.readContract({ address: escrow, abi: testAbi, functionName: "identityRegistry" });
    await mined(await chain.wallet("owner").writeContract({
      address: registry, abi: testAbi, functionName: "setTokenURI", args: [AGENT_ID, registryUri],
    }));

    const balance = (address: Address) => publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const before = await Promise.all([balance(buyer.address), balance(seller.address), balance(escrow)]);
    const facade = createFacilitator({ escrow, usdc, publicClient, walletClient: chain.wallet("owner") as never, clock: () => now });
    const app = new Hono();
    let served = 0;
    app.use("/v1/*", sdk.middleware());
    app.get("/v1/file", c => c.body(Buffer.from(++served <= 15 ? good : bad), 200, { "content-type": "application/octet-stream" }));

    const receipts: Receipt[] = [];
    let settlements = 0;
    let rejectSettle = true;
    let rejected: FacilitatorRequest | undefined;
    const transport: typeof fetch = async (input, init) => {
      const target = input instanceof Request ? input : new Request(input, init);
      const uri = new URL(target.url);
      if (uri.href === registryUri) return Response.json({ services: [{ name: "file", endpoint: url }] });
      if (uri.origin === "https://seller.example") return app.fetch(target);
      if (uri.origin === "https://scorer.example") {
        expect(uri.pathname).toBe(`/v1/attestation/${AGENT_ID}`);
        expect(uri.searchParams.get("wallet")).toBe(seller.address);
        return Response.json({ scorer: scorer.address, attestation: toWire(await signScoreAttestation(scorer, chainId, escrow, {
          agentId: AGENT_ID, wallet: seller.address, score: 80, flags: 0, validUntil: BigInt(now) + 1800n,
        })) });
      }
      if (uri.origin === "https://facilitator.example") {
        if (rejectSettle) {
          rejected = await target.json() as FacilitatorRequest;
          return Response.json({ success: false });
        }
        settlements++;
        return facade.fetch(target);
      }

      expect(uri.origin).toBe("https://verifier.example");
      const payload = await target.json() as RelayRequest;
      const id = BigInt(payload.voucher.message.sessionId);
      expect(uri.pathname).toBe(`/v1/sessions/${id}/requests`);
      const response = await app.request(payload.request.url, {
        method: payload.request.method, headers: { [HEADERS.PAYMENT_SIGNATURE]: encodeHeader(payload.voucher) },
      });
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const delivery = decodeHeaderJson<WireSigned<Delivery>>(response.headers.get(HEADERS.DELIVERY)!);
      const message = fromWire<Delivery>("Delivery", delivery.message);
      expect(await verifyDelivery(chainId, escrow, { message, signature: delivery.signature }, seller.address)).toBe(true);
      expect(message.bodyHash).toBe(bodyHash(bytes));
      const outcome = check(bytes);
      const receipt: Receipt = { sessionId: id, seq: message.seq, requestHash: message.requestHash, bodyHash: message.bodyHash,
        outcome, reasonCode: outcome === Outcome.PASS ? 0 : 15, amount: outcome === Outcome.PASS ? PRICE : 0n,
        receivedAt: BigInt(now), evidenceHash: ZERO_HASH,
      };
      receipts.push(receipt);
      const closing = receipts.slice(-3).length === 3 && receipts.slice(-3).every(r => r.outcome === Outcome.FAIL);
      if (closing) {
        const verdict = await signSessionVerdict(verifier, chainId, escrow, {
          sessionId: id, specHash: message.specHash, lastSeq: receipt.seq, passCount: 15, failCount: 3, inconclusiveCount: 0,
          passedAmount: PRICE * 15n, receiptsRoot: receiptsRoot(receipts), closedAt: BigInt(now),
        });
        await mined(await chain.wallet("verifier").writeContract({
          address: escrow, abi: agentPaySessionEscrowAbi, functionName: "closeSession",
          args: [id, fromWire("Voucher", payload.voucher.message), payload.voucher.signature, verdict.message, verdict.signature],
        }));
      }
      return Response.json({ sessionId: id.toString(), seq: receipt.seq, delivery, closing, contentType: "application/octet-stream",
        bodyBase64: Buffer.from(bytes).toString("base64"),
        receipt: toWire(await signReceipt(verifier, chainId, escrow, receipt)),
      } satisfies RelayResponse);
    };
    const sdkBuyer = createAgentPayBuyer({
      mode: "auto", chainId, account: buyer, publicClient, walletClient: wallet, trustedEscrows: [escrow],
      facilitatorUrl: "https://facilitator.example", scorerUrl: "https://scorer.example",
      defaultCap: CAP, defaultExpirySec: 3600, softPolicy: { maxPerSession: CAP, maxPricePerRequest: PRICE },
      clock: () => now, fetch: transport, checks: ({ body }) => check(body), store,
    });

    now = Number(await chain.now());
    await expect(sdkBuyer.fetch(url)).rejects.toThrow("authorization was canceled");
    const authorization = rejected!.paymentPayload.payload.authorization;
    expect(BigInt(authorization.validBefore)).toBe(BigInt(now + 120));
    expect(await publicClient.readContract({ address: usdc, abi: testAbi, functionName: "authorizationState",
      args: [buyer.address, authorization.nonce] })).toBe(true);
    const reusedAuthorization = await facade.request("/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rejected),
    });
    expect(await reusedAuthorization.json()).toMatchObject({ isValid: false, invalidReason: "ALREADY_SUBMITTED" });
    rejectSettle = false;
    for (let i = 0; i < 15; i++) expect(new Uint8Array(await (await sdkBuyer.fetch(url)).arrayBuffer())).toEqual(good);
    for (let i = 0; i < 3; i++) await expect(sdkBuyer.fetch(url)).rejects.toBeInstanceOf(BuyerReceiptError);
    expect(settlements).toBe(1);
    expect(receipts.map(r => r.outcome)).toEqual([...Array(15).fill(Outcome.PASS), ...Array(3).fill(Outcome.FAIL)]);
    const session = (await store.list()).find(entry => entry.status === "closing")!;
    expect(session.requests).toHaveLength(18);
    expect(await createFileBuyerStore(directory).get(session.id)).toEqual(session);
    const id = BigInt(session.id);
    expect(await chain.state(id)).toBe(SessionState.CLOSING);
    await chain.advance(62);
    await mined(await chain.wallet("keeper").writeContract({
      address: escrow, abi: agentPaySessionEscrowAbi, functionName: "finalize", args: [id],
    }));
    expect(await chain.state(id)).toBe(SessionState.SETTLED);
    const paid = 15n * PRICE;
    const fee = 40_000n;
    const sellerFee = paid * 50n / 10_000n;
    expect(await balance(buyer.address)).toBe(before[0] - paid - fee);
    expect(await balance(seller.address)).toBe(before[1] + paid - sellerFee);
    expect(await balance(escrow)).toBe(before[2] + fee + sellerFee);
    expect(await publicClient.readContract({ address: escrow, abi: testAbi, functionName: "feesAccrued" })).toBe(fee + sellerFee);
  } finally {
    sdk.stop();
    await chain.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
