import {
  CHAIN_ID, HEADERS, Outcome, SessionState, bodyHash, decodeHeaderJson, encodeHeader, fromWire,
  receiptsRoot, requestHash, signReceipt, signSessionVerdict, signVoucher, specHash, toWire,
  verifyDelivery, verifyReceipt, ZERO_HASH, type CheckpointResponse, type Delivery, type Receipt, type RelayRequest, type RelayResponse,
  type Signed, type VerificationSpec, type WireSigned,
} from "@agentpay/core";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { AGENT_ID, PRICE, startChain } from "../../agentpay-keeper/test/helpers/chain.js";
import { createAgentPaySeller, createMemorySellerStore } from "../src/index.js";

it("serves 3 PASS through a test relay and submits a checkpoint to the real escrow after expiry", async () => {
  const chainId = CHAIN_ID.fuji;
  const chain = await startChain({ chainId });
  const { seller, buyer, verifier } = chain.accounts;
  const { escrow } = chain;
  const app = new Hono();
  const relay = new Hono();
  const store = createMemorySellerStore();
  const payload = Uint8Array.of(0, 255, 128, 13, 10);
  const hash = bodyHash(payload);
  const url = "https://seller.example/v1/file";
  const spec: VerificationSpec = {
    specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
    verifier: { address: verifier.address, endpoint: "https://verifier.example" },
    delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
    checks: [{ id: "file", type: "hash-match", expectedHash: hash }],
  };
  const specDigest = specHash(spec);
  let now = 0n;
  const sdk = createAgentPaySeller({
    account: seller, chainId, escrow, asset: chain.usdc, publicClient: chain.publicClient, walletClient: chain.wallet("seller"),
    sellerAgentId: AGENT_ID, pricePerRequest: PRICE, clock: () => Number(now), spec, store, verifierUrl: spec.verifier.endpoint,
    terms: { minCap: 500_000n, maxCap: 20_000_000n, defaultExpirySec: 3600, maxExpirySec: 86400,
      deliveryDeadlineSec: 10, challengeWindowSec: 60 },
    fetch: (input, init) => Promise.resolve(relay.request(String(input), init)),
  });
  sdk.stop();
  try {
    const expiry = await chain.now() + 60n;
    const id = await chain.open({ specHash: specDigest, expiry });
    now = await chain.now();
    expect(await chain.state(id)).toBe(SessionState.OPEN);
    app.use("/v1/*", sdk.middleware());
    app.get("/v1/file", () => new Response(payload, { headers: { "content-type": "application/octet-stream" } }));

    const receipts: Signed<Receipt>[] = [];
    relay.post("/v1/sessions/:id/requests", async context => {
      const { voucher, request } = await context.req.json<RelayRequest>();
      const response = await app.request(request.url, {
        method: request.method, headers: { [HEADERS.PAYMENT_SIGNATURE]: encodeHeader(voucher) },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(response.status).toBe(200);
      const header = decodeHeaderJson<WireSigned<Delivery>>(response.headers.get(HEADERS.DELIVERY)!);
      const delivery = fromWire<Delivery>("Delivery", header.message);
      expect(delivery).toMatchObject({ sessionId: id, seq: voucher.message.seq,
        requestHash: voucher.message.requestHash, bodyHash: bodyHash(bytes), specHash: specDigest });
      expect(await verifyDelivery(chainId, escrow, { message: delivery, signature: header.signature }, seller.address)).toBe(true);
      expect(delivery.bodyHash).toBe(hash); // Fixture check: hash-match is the file's only check.
      const receipt = await signReceipt(verifier, chainId, escrow, {
        sessionId: id, seq: delivery.seq, requestHash: delivery.requestHash, bodyHash: delivery.bodyHash,
        outcome: Outcome.PASS, reasonCode: 0, amount: PRICE, receivedAt: now, evidenceHash: ZERO_HASH,
      });
      receipts.push(receipt);
      return context.json<RelayResponse>({ sessionId: id.toString(), seq: delivery.seq, delivery: header,
        receipt: toWire(receipt), bodyBase64: Buffer.from(bytes).toString("base64"),
        contentType: response.headers.get("content-type")!, closing: false });
    });
    relay.get("/v1/sessions/:id/receipts", c => c.json({ sessionId: id.toString(), receipts: toWire(receipts) }));
    let checkpoint: CheckpointResponse | undefined;
    relay.get("/v1/sessions/:id/checkpoint", c => checkpoint ? c.json(checkpoint) : c.notFound());

    let latest;
    for (let seq = 1; seq <= 3; seq++) {
      latest = await signVoucher(buyer, chainId, escrow, {
        sessionId: id, seq, cumulativeAmount: BigInt(seq) * PRICE, requestHash: requestHash("GET", url),
      });
      const request: RelayRequest = { voucher: toWire(latest), request: { method: "GET", url } };
      const result = await relay.request(`/v1/sessions/${id}/requests`, {
        method: "POST", body: JSON.stringify(request), headers: { "content-type": "application/json" },
      });
      expect(result.status).toBe(200);
      const json = await result.json() as { receipt: WireSigned<Receipt>; bodyBase64: string };
      const receipt = fromWire<Receipt>("Receipt", json.receipt.message);
      expect(receipt).toMatchObject({ seq, outcome: Outcome.PASS });
      expect(receipt.bodyHash).toBe(bodyHash(Buffer.from(json.bodyBase64, "base64")));
      expect(await verifyReceipt(chainId, escrow, { message: receipt, signature: json.receipt.signature }, verifier.address)).toBe(true);
    }
    const leaves = receipts.map(receipt => receipt.message);
    const verdict = await signSessionVerdict(verifier, chainId, escrow, {
      sessionId: id, lastSeq: 3, specHash: specDigest, passCount: 3, failCount: 0, inconclusiveCount: 0,
      passedAmount: 3n * PRICE, receiptsRoot: receiptsRoot(leaves), closedAt: now,
    });
    checkpoint = {
      sessionId: id.toString(), voucher: toWire(latest!), verdict: toWire(verdict),
    };

    await sdk.sync();
    expect((await store.get(id))?.receipts).toHaveLength(3);
    expect(await chain.state(id)).toBe(SessionState.OPEN);
    await chain.advance(61);
    now = await chain.now();
    await sdk.sync();
    expect(await chain.state(id)).toBe(SessionState.CLOSING);
  } finally {
    sdk.stop();
    await chain.stop();
  }
}, 60_000);
