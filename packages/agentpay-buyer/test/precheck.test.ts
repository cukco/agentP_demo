import {
  CHAIN_ID, NETWORK, Outcome, SessionState, VERIFIER_LIMITS, ZERO_HASH, bodyHash, fromWire, signCloseRequest, signDelivery, signReceipt,
  sessionId as computeSessionId, signReceiveAuthorization, signScoreAttestation, specHash, toWire, verifyCloseRequest,
  type CloseRequest, type CloseSessionRequest, type FacilitatorRequest, type PaymentRequired, type RelayRequest, type Voucher,
} from "@agentpay/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPayBuyer, createMemoryBuyerStore, type BuyerOptions } from "../src/index.js";
import * as approvalServer from "../src/approve/server.js";

const chainId = CHAIN_ID.fuji;
const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const escrow = address("1");
const usdc = address("2");
const account = privateKeyToAccount(generatePrivateKey());
const seller = privateKeyToAccount(generatePrivateKey());
const scorer = privateKeyToAccount(generatePrivateKey());
const verifier = privateKeyToAccount(generatePrivateKey());
const url = "https://seller.example/file";
const payload = Uint8Array.of(0, 255, 128);
const now = 1_800_000_000;

function fixture() {
  const store = createMemoryBuyerStore();
  const signed = vi.fn(account.signTypedData);
  const writeContract = vi.fn(async () => ZERO_HASH);
  const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }));
  const payment: PaymentRequired = { x402Version: 2, resource: { url },
    accepts: [{ scheme: "agentpay-session", network: NETWORK.fuji, asset: usdc, amount: "10000", payTo: escrow,
      maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
    extensions: { agentpay: { version: "0.2",
      session: { contract: escrow, chainId, seller: seller.address, sellerAgentId: "12", pricePerRequest: "10000",
        minCap: "500000", maxCap: "20000000", defaultExpirySec: 3600, maxExpirySec: 86400, deliveryDeadlineSec: 1,
        challengeWindowSec: 60 },
      verificationSpec: { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
        verifier: { address: verifier.address, endpoint: "https://verifier.example" },
        delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
        checks: [{ id: "hash", type: "hash-match", expectedHash: bodyHash(payload) }] },
    } },
  };
  const spec = payment.extensions.agentpay.verificationSpec;
  const config = { active: true, wallet: seller.address, endpoint: url, fee: () => 40_000n, state: SessionState.OPEN,
    timeout: false, badHash: false, wrongReceiptSigner: false, wrongDeliverySigner: false, badScorer: false, paid: true,
    wrongSettleId: false };
  let voucherSigner = account.address;
  const chainSession = () => ({ state: config.state, buyer: account.address, voucherSigner,
    seller: seller.address, sellerAgentId: 12n, verifier: verifier.address, expiry: BigInt(now + 3600),
    cap: 1_000_000n, sessionFee: 40_000n, specHash: specHash(spec), pricePerRequest: 10_000n });
  const getSession = vi.fn(async () => chainSession());
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "verifierInfo": return { active: config.active };
      case "identityRegistry": return address("3");
      case "getMetadata": return config.wallet;
      case "tokenURI": return "https://identity.example";
      case "usdc": return usdc;
      case "scorerSigner": return scorer.address;
      case "sessionFee": return config.fee();
      case "getSession": return getSession();
      default: throw new Error("Unexpected contract call");
    }
  });
  let settleCount = 0;
  let lastId: string | undefined;
  let closeCount = 0;
  const closeResponse = vi.fn(async (id: string) => {
    config.state = SessionState.CLOSING;
    return Response.json({ sessionId: id, txHash: ZERO_HASH, kind: "closeSession" });
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const uri = new URL(request.url);
    if (uri.href === url) return config.paid ? Response.json(payment, { status: 402 }) : new Response("free");
    if (uri.hostname === "identity.example") return Response.json({ services: [{ endpoint: config.endpoint }] });
    if (uri.hostname === "scorer.example") return Response.json({ scorer: scorer.address,
      attestation: toWire(await signScoreAttestation(config.badScorer ? seller : scorer, chainId, escrow, {
        agentId: 12n, wallet: seller.address, score: 80, flags: 0, validUntil: BigInt(now + 60),
      })),
    });
    if (uri.hostname === "facilitator.example") {
      const requestBody = await request.json() as FacilitatorRequest;
      const { from, nonce } = requestBody.paymentPayload.payload.authorization;
      voucherSigner = requestBody.paymentPayload.payload.params.voucherSigner;
      lastId = computeSessionId(from, nonce).toString();
      settleCount++;
      return Response.json({ success: true, sessionId: config.wrongSettleId ? "0" : lastId });
    }
    if (uri.pathname.endsWith("/close")) {
      const body = await request.json() as CloseSessionRequest;
      const message = fromWire<CloseRequest>("CloseRequest", body.closeRequest.message);
      expect(message).toEqual({ sessionId: BigInt(lastId!), deadline: BigInt(options.clock() + VERIFIER_LIMITS.CLOSE_REQUEST_SLA_SEC) });
      expect(await verifyCloseRequest(chainId, escrow, { message, signature: body.closeRequest.signature }, account.address)).toBe(true);
      closeCount++;
      return closeResponse(lastId!);
    }
    if (config.timeout) return new Promise<Response>(() => {});
    const { voucher } = await request.json() as RelayRequest;
    const { seq, sessionId, requestHash } = fromWire<Voucher>("Voucher", voucher.message);
    const delivery = await signDelivery(config.wrongDeliverySigner ? scorer : seller, chainId, escrow, {
      seq, sessionId, requestHash, specHash: specHash(spec), bodyHash: bodyHash(payload),
    });
    const receipt = await signReceipt(config.wrongReceiptSigner ? scorer : verifier, chainId, escrow, {
      seq, sessionId, requestHash, bodyHash: config.badHash ? ZERO_HASH : bodyHash(payload),
      outcome: Outcome.PASS, reasonCode: 0, amount: 10_000n, receivedAt: BigInt(now), evidenceHash: ZERO_HASH,
    });
    return Response.json({ seq, sessionId: String(sessionId), bodyBase64: Buffer.from(payload).toString("base64"),
      delivery: toWire(delivery), receipt: toWire(receipt), closing: false });
  });
  const options: BuyerOptions = { mode: "auto", account: { ...account, signTypedData: signed } as typeof account, chainId,
    walletClient: { writeContract, chain: undefined } as BuyerOptions["walletClient"],
    publicClient: { readContract, waitForTransactionReceipt } as unknown as BuyerOptions["publicClient"],
    trustedEscrows: [escrow], defaultCap: 1_000_000n, defaultExpirySec: 3600,
    softPolicy: { maxPerSession: 1_000_000n, maxPricePerRequest: 10_000n },
    scorerUrl: "https://scorer.example", facilitatorUrl: "https://facilitator.example", clock: () => now,
    checks: () => Outcome.PASS, store, fetch,
  };
  return { options, payment, spec, config, getSession, chainSession, signed, writeContract, readContract, store, closeResponse,
    settlements: () => settleCount, closes: () => closeCount, id: () => lastId! };
}

function mockApproval(clock: () => number) {
  return vi.spyOn(approvalServer, "requestApproval").mockImplementation(async review => {
    if (review.kind === "close") {
      const deadline = BigInt(clock() + VERIFIER_LIMITS.CLOSE_REQUEST_SLA_SEC);
      const { signature } = await signCloseRequest(account, chainId, escrow, { sessionId: BigInt(review.sessionId), deadline });
      return { signature, deadline };
    }
    const deadline = BigInt(clock() + 120);
    const { signature } = await signReceiveAuthorization(account, chainId, usdc, {
      from: account.address, to: escrow, nonce: review.nonce, value: BigInt(review.params.cap),
      validAfter: 0n, validBefore: deadline,
    });
    return { signature, deadline };
  });
}

function approveBuyer(options: BuyerOptions) {
  const { account: _account, walletClient: _walletClient, ...common } = options;
  return createAgentPayBuyer({ ...common, mode: "approve", buyerAddress: account.address, onApprovalUrl: () => {} });
}

describe("settled session visibility", () => {
  const funding = { cap: 1_000_000n, expirySec: 3600 };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function expectSingleSettlement(f: ReturnType<typeof fixture>) {
    expect(f.settlements()).toBe(1);
    expect(f.writeContract).not.toHaveBeenCalled();
  }

  it.each(["OPEN immediately", "NONE then OPEN", "RPC error then OPEN"])("opens with %s", async visibility => {
    vi.useFakeTimers();
    const f = fixture();
    if (visibility === "NONE then OPEN") {
      f.getSession.mockResolvedValueOnce({ ...f.chainSession(), state: SessionState.NONE });
    } else if (visibility === "RPC error then OPEN") {
      f.getSession.mockRejectedValueOnce(new Error("RPC unavailable"));
    }
    const buyer = createAgentPayBuyer(f.options);
    const opening = buyer.openSession(url, funding).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getSession).toHaveBeenCalledTimes(1);
    if (visibility !== "OPEN immediately") {
      expect(await f.store.get(f.id())).toMatchObject({ id: f.id(), status: "opening", settleConfirmed: true });
      await vi.advanceTimersByTimeAsync(499);
      expect(f.getSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.getSession).toHaveBeenCalledTimes(2);
    }
    expect(await opening).toBe(f.id());
    expect(await f.store.list()).toMatchObject([{ id: f.id(), status: "open", requests: [] }]);
    const response = await buyer.fetch(url);
    expect(response.ok).toBe(true);
    expect((await f.store.get(f.id()))?.requests).toHaveLength(1);
    expectSingleSettlement(f);
  });

  it.each(["NONE", "RPC hangs"])("preserves the funded ID at the overall deadline when %s", async visibility => {
    vi.useFakeTimers();
    const f = fixture();
    f.config.state = SessionState.NONE;
    let finishRead: ((session: ReturnType<typeof f.chainSession>) => void) | undefined;
    if (visibility === "RPC hangs") {
      f.getSession.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    }
    const opening = createAgentPayBuyer(f.options).openSession(url, funding);
    const settled = vi.fn();
    const result = opening.catch(error => { settled(); return error; });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(settled).not.toHaveBeenCalled();
    expect(f.getSession).toHaveBeenCalledTimes(visibility === "NONE" ? 24 : 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ message: `Session settlement is awaiting RPC confirmation: ${f.id()}` });
    finishRead?.({ ...f.chainSession(), state: SessionState.OPEN });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.getSession).toHaveBeenCalledTimes(visibility === "NONE" ? 24 : 1);
    expect(await f.store.list()).toMatchObject([{ id: f.id(), status: "opening", settleConfirmed: true,
      authorizationExpiresAt: String(now + 120), requests: [] }]);

    // A new SDK instance must still guard the confirmed ID after authorization expiry.
    f.options.clock = () => now + 121;
    const buyer = createAgentPayBuyer(f.options);
    const unresolved = `Previous session settlement is unresolved: ${f.id()}`;
    await expect(buyer.fetch(url)).rejects.toThrow(unresolved);
    await expect(buyer.openSession(url, funding)).rejects.toThrow(unresolved);
    await expect(buyer.close(f.id())).rejects.toThrow(unresolved);
    expect((await f.store.get(f.id()))?.status).toBe("opening");
    f.config.state = SessionState.OPEN;
    await expect(buyer.fetch(url)).rejects.toThrow(unresolved);
    await buyer.close(f.id());
    expect(f.closes()).toBe(1);
    expect((await f.store.get(f.id()))?.status).toBe("closing");
    expectSingleSettlement(f);
  });

  it("stops on an OPEN session with an unexpected fee", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.getSession.mockResolvedValueOnce({ ...f.chainSession(), sessionFee: 40_001n });
    await expect(createAgentPayBuyer(f.options).openSession(url, funding)).rejects.toThrow("fee changed");
    expect(f.getSession).toHaveBeenCalledTimes(1);
    expect((await f.store.get(f.id()))?.status).toBe("stopped");
    expectSingleSettlement(f);
  });

  it("stops when an approved session has the wrong voucher signer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const approve = mockApproval(f.options.clock);
    f.getSession.mockResolvedValueOnce(f.chainSession());
    const buyer = approveBuyer(f.options);
    await expect(buyer.openSession(url, funding)).rejects.toThrow("during settlement");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(f.getSession).toHaveBeenCalledTimes(1);
    expect((await f.store.get(f.id()))?.status).toBe("stopped");
    expectSingleSettlement(f);
  });

  it("keeps cancellation on the existing path when the settle response has the wrong ID", async () => {
    const f = fixture();
    f.config.wrongSettleId = true;
    f.config.state = SessionState.NONE;
    await expect(createAgentPayBuyer(f.options).openSession(url, funding)).rejects.toThrow("authorization was canceled");
    expect(f.settlements()).toBe(1);
    expect(f.writeContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ functionName: "cancelAuthorization" }));
    const stored = await f.store.get(f.id());
    expect(stored?.status).toBe("stopped");
    expect(stored?.settleConfirmed).toBeUndefined();
  });
});

describe.each(["auto", "approve"] as const)("Buyer close in %s mode", mode => {
  const timeoutMs = VERIFIER_LIMITS.CLOSE_REQUEST_SLA_SEC * 1000;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function openedSession() {
    vi.useFakeTimers();
    const f = fixture();
    const approve = mode === "approve" ? mockApproval(f.options.clock) : undefined;
    const buyer = mode === "approve" ? approveBuyer(f.options) : createAgentPayBuyer(f.options);
    const id = await buyer.openSession(url, { cap: 1_000_000n, expirySec: 3600 });
    expect(vi.getTimerCount()).toBe(mode === "approve" ? 1 : 0);
    f.getSession.mockClear();
    f.readContract.mockClear();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("HTTP deadline expired", "TimeoutError")), ms);
      return controller.signal;
    });
    return { ...f, buyer, id, approve, timeout };
  }

  it("accepts a valid response after the old 5-second deadline", async () => {
    const f = await openedSession();
    f.closeResponse.mockImplementation(async id => {
      await new Promise(resolve => setTimeout(resolve, 6000));
      return Response.json({ sessionId: id, txHash: ZERO_HASH });
    });
    const finished = vi.fn();
    const closing = f.buyer.close(f.id).then(finished, error => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).not.toHaveBeenCalled();
    expect(f.closes()).toBe(1);
    expect(f.timeout).toHaveBeenCalledExactlyOnceWith(timeoutMs);
    expect(vi.getTimerCount()).toBe(2); // HTTP deadline and response delay. Approval's signer expiry was cleared.
    expect((await f.store.get(f.id))?.status).toBe("stopped");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await closing).toBeUndefined();
    expect(finished).toHaveBeenCalledOnce();
    expect(f.getSession).toHaveBeenCalledTimes(1);
    expect((await f.store.get(f.id))?.status).toBe("closing");
    expect(f.approve?.mock.calls.map(([review]) => review.kind) ?? []).toEqual(mode === "approve" ? ["open", "close"] : []);
  });

  it.each([
    { name: "CLOSING", state: SessionState.CLOSING, status: "closing" },
    { name: "SETTLED", state: SessionState.SETTLED, status: "stopped" },
    { name: "OPEN", state: SessionState.OPEN, status: "stopped", unconfirmed: true },
    { name: "NONE", state: SessionState.NONE, status: "stopped", unconfirmed: true },
    { name: "an RPC error", state: SessionState.OPEN, status: "stopped", unconfirmed: true },
  ])("reconciles timeout followed by $name", async ({ name, state, status, unconfirmed }) => {
    const f = await openedSession();
    f.closeResponse.mockImplementation(() => {
      f.config.state = state;
      if (name === "an RPC error") f.getSession.mockRejectedValueOnce(new Error("RPC unavailable"));
      return new Promise<Response>(() => {});
    });
    const closing = f.buyer.close(f.id).catch(error => error);
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(f.getSession).toHaveBeenCalledTimes(1);
    expect(f.closes()).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // Only the HTTP deadline remains.
    await vi.advanceTimersByTimeAsync(1);
    if (unconfirmed) {
      expect(await closing).toMatchObject({ message: `Session close is unconfirmed: ${f.id}` });
    } else {
      expect(await closing).toBeUndefined();
    }
    const read = expect.objectContaining({ functionName: "getSession", address: escrow, args: [BigInt(f.id)] });
    expect(f.readContract.mock.calls).toEqual([[read], [read]]);
    expect(f.closes()).toBe(1);
    expect((await f.store.get(f.id))?.status).toBe(status);
    if (!unconfirmed) {
      await f.buyer.close(f.id);
      expect(f.closes()).toBe(1);
      expect((await f.store.get(f.id))?.status).toBe(status);
    }
  });

  it.each(["ID", "hash"])("rejects a successful HTTP response with a wrong %s", async field => {
    const f = await openedSession();
    f.closeResponse.mockResolvedValueOnce(Response.json({
      sessionId: field === "ID" ? "0" : f.id, txHash: field === "hash" ? "0x12" : ZERO_HASH,
    }));
    await expect(f.buyer.close(f.id)).rejects.toThrow("Invalid close response");
    expect(f.closes()).toBe(1);
    expect(f.getSession).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect((await f.store.get(f.id))?.status).toBe("stopped");
  });
});

it.each([
  ["unsupported check", (f: ReturnType<typeof fixture>) => { Object.assign(f.spec.checks[0]!, { type: "other" }); }],
  ["inactive verifier", f => { f.config.active = false; }],
  ["untrusted contract", f => { f.options.trustedEscrows = []; }],
  ["wallet mismatch", f => { f.config.wallet = address("4"); }],
  ["unregistered domain", f => { f.config.endpoint = "https://elsewhere.example/file"; }],
  ["price exceeds policy", f => { f.options.softPolicy.maxPricePerRequest = 9_999n; }],
  ["spec minimum", f => { f.spec.checks = [{ id: "eq", type: "equals", field: "/price", value: 1 }]; }],
] as const)("precheck: %s rejects before signing", async (_name, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(createAgentPayBuyer(f.options).fetch(url)).rejects.toThrow();
  expect(f.signed).not.toHaveBeenCalled();
  expect(f.settlements()).toBe(0);
  expect(f.writeContract).not.toHaveBeenCalled();
});

it("passes free responses through and reuses the paid session for sequential and concurrent calls", async () => {
  const f = fixture();
  const buyer = createAgentPayBuyer(f.options);
  f.config.paid = false;
  expect(await (await buyer.fetch(url)).text()).toBe("free");
  expect(f.signed).not.toHaveBeenCalled();
  f.config.paid = true;
  const responses = await Promise.all([buyer.fetch(url), buyer.fetch(url)]);
  for (const response of responses) expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  expect(f.settlements()).toBe(1);
  expect((await f.store.get(f.id()))?.requests.map(r => r.voucher.message.seq)).toEqual([1, 2]);
  await buyer.close(f.id());
  expect(f.closes()).toBe(1);
});

it("fails before signing when sessionFee changes or Scorer signature is invalid", async () => {
  const fee = fixture();
  let reads = 0;
  fee.config.fee = () => 40_000n + BigInt(reads++);
  await expect(createAgentPayBuyer(fee.options).fetch(url)).rejects.toThrow("Session fee changed");
  expect(fee.signed).not.toHaveBeenCalled();

  const scorer = fixture();
  scorer.config.badScorer = true;
  await expect(createAgentPayBuyer(scorer.options).fetch(url)).rejects.toThrow("Invalid Scorer attestation");
  expect(scorer.signed).not.toHaveBeenCalled();
});

it.each([
  ["body hash mismatch", (f: ReturnType<typeof fixture>) => { f.config.badHash = true; }, "Response body hash mismatch"],
  ["wrong Receipt signer", f => { f.config.wrongReceiptSigner = true; }, "Invalid Receipt"],
  ["wrong Delivery signer", f => { f.config.wrongDeliverySigner = true; }, "Invalid Delivery"],
  ["dishonest PASS", f => { f.options.checks = () => Outcome.FAIL; }, "could not confirm the passing Receipt"],
] as const)("%s stops the session", async (name, mutate, error) => {
  const f = fixture();
  mutate(f);
  await expect(createAgentPayBuyer(f.options).fetch(url)).rejects.toThrow(error);
  expect(f.closes()).toBe(1);
  const session = await f.store.get(f.id());
  expect(session?.status).toBe("closing");
  if (name === "dishonest PASS") {
    expect(session?.challenge).toBe("RECHECK_MISMATCH");
    expect(session?.requests[0]).toMatchObject({ bodyBase64: Buffer.from(payload).toString("base64"), localOutcome: Outcome.FAIL });
  }
});

it("applies deadline + 5 s to a missing Receipt, stops the session and requests close", async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const limit = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => original(ms === 6000 ? 20 : ms));
  try {
    const f = fixture();
    f.config.timeout = true;
    await expect(createAgentPayBuyer(f.options).fetch(url)).rejects.toThrow("Receipt deadline exceeded");
    expect(limit).toHaveBeenCalledWith(6000);
    expect(f.closes()).toBe(1);
    expect((await f.store.get(f.id()))?.requests).toHaveLength(1);
    expect(f.signed.mock.calls.filter(([data]) => data.primaryType === "Voucher")).toHaveLength(1);
  } finally {
    limit.mockRestore();
  }
});
