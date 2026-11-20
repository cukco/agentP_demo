import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAIN_ID, HEADERS, SessionState, bodyHash, decodeHeaderJson, encodeHeader, parsePaymentRequired, requestHash,
  fromWire, signReceipt, signSessionVerdict, signVoucher, specHash, toWire, verifyDelivery, ZERO_HASH,
  type Delivery, type Signed, type VerificationSpec, type Voucher, type WireSigned,
} from "@agentpay/core";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { createAgentPaySeller, createFileSellerStore, createMemorySellerStore, type SellerOptions } from "../src/index.js";

const buyer = privateKeyToAccount(generatePrivateKey());
const sellerAccount = privateKeyToAccount(generatePrivateKey());
const verifier = privateKeyToAccount(generatePrivateKey());
const escrow = "0x0000000000000000000000000000000000000001";
const url = "https://seller.example/v1/file?case=%2F";
const chainId = CHAIN_ID.fuji;
const price = 10_000n;
const binary = Uint8Array.of(0, 0xff, 0x80, 0x0d, 0x0a);
const spec: VerificationSpec = {
  specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
  verifier: { address: verifier.address, endpoint: "https://verifier.example/v1" },
  delivery: { contentType: "application/octet-stream", maxBytes: 100 },
  checks: [{ id: "file", type: "hash-match", expectedHash: bodyHash(binary) }],
};

function fixture(store = createMemorySellerStore(), poll = false, extra: Partial<SellerOptions> = {}) {
  let time = 1000;
  const session = { state: SessionState.OPEN, seller: sellerAccount.address, sellerAgentId: 12n, verifier: verifier.address,
    voucherSigner: buyer.address, specHash: specHash(spec), expiry: 1100n, lastSeq: 0, cap: 500_000n,
    sessionFee: 40_000n, pricePerRequest: price };
  const readContract = vi.fn(async () => ({ ...session }));
  const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }));
  const writeContract = vi.fn(async () => ZERO_HASH);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 404 }));
  const options: SellerOptions = {
    account: sellerAccount, escrow, chainId, sellerAgentId: 12n, pricePerRequest: price, spec, store,
    terms: { minCap: 500_000n, maxCap: 20_000_000n, defaultExpirySec: 3600, maxExpirySec: 86400,
      deliveryDeadlineSec: 10, challengeWindowSec: 60 },
    verifierUrl: spec.verifier.endpoint, clock: () => time, fetch,
    publicClient: { readContract, waitForTransactionReceipt } as unknown as SellerOptions["publicClient"],
    walletClient: { writeContract, chain: undefined } as unknown as SellerOptions["walletClient"],
    ...extra,
  };
  const sdk = createAgentPaySeller(options);
  if (!poll) sdk.stop();
  const app = new Hono();
  const handler = vi.fn(async (request: Request) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return new Response(bytes.length ? bytes : binary, { headers: { "content-type": "application/octet-stream" } });
  });
  app.use("/v1/*", sdk.middleware());
  app.all("/v1/file", c => handler(c.req.raw));
  return { sdk, app, handler, session, readContract, writeContract, fetch, store, setTime: (value: number) => { time = value; } };
}

function voucher(patch: Partial<Voucher> = {}, signer = buyer) {
  return signVoucher(signer, chainId, escrow, {
    sessionId: 1n, seq: 1, cumulativeAmount: price, requestHash: requestHash("GET", url), ...patch,
  });
}
const header = (signed: Signed<Voucher>) => ({ [HEADERS.PAYMENT_SIGNATURE]: encodeHeader(signed) });

it("advertises the same valid PaymentRequired in the body and header", async () => {
  const f = fixture();
  const response = await f.app.request(url);
  expect(response.status).toBe(402);
  const json = await response.json();
  expect(decodeHeaderJson(response.headers.get(HEADERS.PAYMENT_REQUIRED)!)).toEqual(json);
  expect(specHash(parsePaymentRequired(json).extensions.agentpay.verificationSpec)).toBe(specHash(spec));
  expect(f.handler).not.toHaveBeenCalled();
  expect(f.readContract).not.toHaveBeenCalled();
});

it("binds Delivery to the exact binary response without consuming the binary request", async () => {
  const f = fixture();
  const payload = Uint8Array.of(0xff, 0xfa, 0, 1);
  const signed = await voucher({ requestHash: requestHash("POST", url, payload) });
  const response = await f.app.request(url, { method: "POST", headers: header(signed), body: payload });
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(bytes).toEqual(payload);
  const wire = decodeHeaderJson<WireSigned<Delivery>>(response.headers.get(HEADERS.DELIVERY)!);
  const delivery = { message: fromWire<Delivery>("Delivery", wire.message), signature: wire.signature };
  expect(delivery.message).toEqual({ seq: 1, sessionId: 1n, bodyHash: bodyHash(bytes), specHash: specHash(spec), requestHash: signed.message.requestHash });
  expect(await verifyDelivery(chainId, escrow, delivery, sellerAccount.address)).toBe(true);
});

it("behind a TLS proxy takes the scheme from X-Forwarded-Proto only with trustProxy", async () => {
  const internal = url.replace("https:", "http:");
  const forwarded = { "x-forwarded-proto": "https" };
  const proxied = fixture(undefined, false, { trustProxy: true });
  expect((await (await proxied.app.request(internal, { headers: forwarded })).json()).resource.url).toBe(url);
  // The buyer signed requestHash over the public https URL.
  expect((await proxied.app.request(internal, { headers: { ...forwarded, ...header(await voucher()) } })).status).toBe(200);
  const direct = fixture();
  expect((await (await direct.app.request(internal, { headers: forwarded })).json()).resource.url).toBe(internal);
});

describe("rejects before calling the seller handler", () => {
  it.each([
    ["not found", "SESSION_NOT_FOUND", { state: SessionState.NONE }, {}],
    ["different seller", "SESSION_NOT_FOUND", { seller: buyer.address }, {}],
    ["closed", "SESSION_NOT_OPEN", { state: SessionState.CLOSING }, {}],
    ["expired", "SESSION_EXPIRED", { expiry: 1000n }, {}],
    ["wrong spec", "SPEC_REJECTED", { specHash: ZERO_HASH }, {}],
    ["wrong verifier", "SPEC_REJECTED", { verifier: buyer.address }, {}],
    ["jumped seq", "BAD_SEQ", {}, { seq: 2 }],
    ["bad cumulative", "BAD_CUMULATIVE", {}, { cumulativeAmount: price + 1n }],
    ["over cap net of fee", "OVER_USABLE", { sessionFee: 495_000n }, {}],
    ["wrong request hash", "BAD_REQUEST_HASH", {}, { requestHash: ZERO_HASH }],
  ] as const)("%s", async (_name, code, session, patch) => {
    const f = fixture();
    Object.assign(f.session, session);
    const response = await f.app.request(url, { headers: header(await voucher(patch)) });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("rejects malformed bytes, tampered data and signatures from another account", async () => {
    const f = fixture();
    const malformed = await f.app.request(url, { headers: { [HEADERS.PAYMENT_SIGNATURE]: "not-a-voucher" } });
    expect(await malformed.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    const signed = await voucher();
    for (const invalid of [{ ...signed, message: { ...signed.message, seq: 2 } }, await voucher({}, sellerAccount)]) {
      const response = await f.app.request(url, { headers: header(invalid) });
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({ error: { code: "BAD_VOUCHER_SIG" } });
    }
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("serializes concurrent replays and caches the session for the next Voucher", async () => {
    const f = fixture();
    const headers = header(await voucher());
    const responses = await Promise.all([f.app.request(url, { headers }), f.app.request(url, { headers })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 402]);
    expect(await responses.find(r => r.status === 402)!.json()).toMatchObject({ error: { code: "BAD_SEQ" } });
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect((await f.app.request(url, { headers: header(await voucher({ seq: 2, cumulativeAmount: 2n * price })) })).status).toBe(200);
    expect(f.readContract).toHaveBeenCalledTimes(1);
  });
});

it("polls every 10 seconds and stops when the SDK is shut down", async () => {
  vi.useFakeTimers();
  const f = fixture(createMemorySellerStore(), true);
  try {
    await f.app.request(url, { headers: header(await voucher()) });
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.sdk.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  } finally {
    f.sdk.stop();
    vi.useRealTimers();
  }
});

async function checkpointData() {
  const latest = await voucher();
  const receipt = await signReceipt(verifier, chainId, escrow, {
    sessionId: 1n, seq: 1, requestHash: latest.message.requestHash, bodyHash: bodyHash(binary),
    outcome: 1, reasonCode: 0, amount: price, receivedAt: 1001n, evidenceHash: ZERO_HASH,
  });
  const verdict = await signSessionVerdict(verifier, chainId, escrow, {
    sessionId: 1n, specHash: specHash(spec), lastSeq: 1, passCount: 1, failCount: 0,
    inconclusiveCount: 0, passedAmount: price, receiptsRoot: ZERO_HASH, closedAt: 1002n,
  });
  return { latest, receipt, verdict };
}

it("persists Receipt and checkpoint and uses them during Verifier downtime after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentpay-seller-"));
  try {
    const f = fixture(createFileSellerStore(directory));
    const { latest, receipt, verdict } = await checkpointData();
    const checkpoint = { sessionId: "1", voucher: toWire(latest), verdict: toWire(verdict) };
    expect((await f.app.request(url, { headers: header(latest) })).status).toBe(200);
    f.fetch.mockImplementation(async resource => {
      return String(resource).endsWith("/checkpoint") ? Response.json(checkpoint)
        : Response.json({ sessionId: "1", receipts: [toWire(receipt)] });
    });
    f.setTime(1099);
    await f.sdk.sync();
    expect(f.fetch.mock.calls.map(([endpoint]) => endpoint).sort()).toEqual([
      "https://verifier.example/v1/sessions/1/checkpoint", "https://verifier.example/v1/sessions/1/receipts",
    ]);
    expect(f.writeContract).not.toHaveBeenCalled();

    const restart = fixture(createFileSellerStore(directory));
    expect(await restart.store.get(1n)).toEqual({ voucher: toWire(latest), receipts: [toWire(receipt)], checkpoint });
    expect((await restart.app.request(url, { headers: header(latest) })).status).toBe(402);
    restart.fetch.mockRejectedValue(new Error("offline"));
    restart.setTime(1100);
    await restart.sdk.sync();
    await restart.sdk.sync();
    expect(restart.writeContract).toHaveBeenCalledTimes(1);
    expect(restart.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "closeSession", args: [1n, latest.message, latest.signature, verdict.message, verdict.signature],
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([1701, 1100])("avoids sending an expired or already closed checkpoint at %i", async now => {
  const f = fixture();
  const { latest, verdict } = await checkpointData();
  await f.app.request(url, { headers: header(latest) });
  f.fetch.mockResolvedValue(Response.json({ sessionId: "1", voucher: toWire(latest), verdict: toWire(verdict) }));
  if (now === 1100) f.session.state = SessionState.CLOSING;
  f.setTime(now);
  await f.sdk.sync();
  expect(f.writeContract).not.toHaveBeenCalled();
});
