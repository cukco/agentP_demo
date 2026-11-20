import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEADERS,
  Outcome,
  ReasonCode,
  ZERO_HASH,
  bodyHash,
  decodeHeaderJson,
  encodeHeader,
  fromWire,
  receiptsRoot,
  requestHash,
  signCloseRequest,
  signDelivery,
  signVoucher,
  specHash,
  toWire,
  verifyReceipt,
  verifySessionVerdict,
  type PaymentRequired,
  type Receipt,
  type SessionVerdict,
  type VerificationSpec,
  type Voucher,
} from "@agentpay/core";
import { openDatabase } from "../src/db.js";
import { createBodyCipher } from "../src/crypto.js";
import { createSigner } from "../src/signer.js";
import { createRuntime } from "../src/runtime.js";
import { createApp } from "../src/app.js";
import { createCheckRunner } from "../src/checks/runner.js";
import {
  createSellerFetch,
  publicAddress,
  validateTarget,
} from "../src/network.js";
import type { ChainSession } from "../src/chain.js";
const buyer = privateKeyToAccount(`0x${"01".repeat(32)}`),
  seller = privateKeyToAccount(`0x${"02".repeat(32)}`),
  verifier = privateKeyToAccount(`0x${"03".repeat(32)}`);
const escrow = "0x00000000000000000000000000000000000e5c40",
  url = "https://seller.example/data",
  tx = `0x${"ab".repeat(32)}` as const;
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture(path = ":memory:") {
  let time = 1800000000;
  const spec: VerificationSpec = {
    specVersion: "agentpay-verify/0.2",
    serviceType: "json-data",
    verifier: {
      address: verifier.address,
      endpoint: "https://verifier.example",
    },
    delivery: { contentType: "application/json", maxBytes: 1024 },
    checks: [
      {
        id: "shape",
        type: "json-schema",
        schema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
      { id: "eq", type: "equals", field: "/ok", value: true },
    ],
    passRule: "all",
  };
  const session: ChainSession = {
    buyer: buyer.address,
    voucherSigner: buyer.address,
    seller: seller.address,
    sellerAgentId: 1n,
    verifier: verifier.address,
    specHash: specHash(spec),
    cap: 1000000n,
    pricePerRequest: 10000n,
    sessionFee: 40000n,
    expiry: BigInt(time + 600),
    deliveryDeadlineSec: 1,
    challengeWindowSec: 30,
    state: 1,
  };
  const payment: PaymentRequired = {
    x402Version: 2,
    resource: { url },
    accepts: [
      {
        scheme: "agentpay-session",
        network: "eip155:43113",
        asset: buyer.address,
        amount: "10000",
        payTo: escrow,
        maxTimeoutSeconds: 120,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    extensions: {
      agentpay: {
        version: "0.2",
        verificationSpec: spec,
        session: {
          contract: escrow,
          chainId: 43113,
          seller: seller.address,
          sellerAgentId: "1",
          pricePerRequest: "10000",
          minCap: "500000",
          maxCap: "20000000",
          defaultExpirySec: 600,
          maxExpirySec: 86400,
          deliveryDeadlineSec: 1,
          challengeWindowSec: 30,
        },
      },
    },
  };
  const db = openDatabase(path, createBodyCipher(Buffer.alloc(32, 9)));
  let closed = false;
  cleanup.push(() => {
    if (!closed) db.close();
  });
  const chain = {
    getSession: async (id: bigint) => (id === 1n ? session : null),
    getBlockNumber: async () => 1n,
    scanSessionOpened: async () => [1n],
    health: async () => ({
      fuji: true,
      mainnet: [true, true] as [boolean, boolean],
    }),
  };
  const writer = {
    close: vi.fn(async () => tx),
    prove: vi.fn(async () => tx),
    confirm: vi.fn(async () => {
      session.state = writer.prove.mock.calls.length ? 5 : 2;
      return true;
    }),
  };
  let mode = "good";
  let forwarded = 0;
  const fetchSeller = vi.fn(async (_url: string, init: RequestInit) => {
    if (!new Headers(init.headers).has(HEADERS.PAYMENT_SIGNATURE))
      return Response.json(payment, { status: 402 });
    forwarded++;
    const wire = decodeHeaderJson<{
      message: import("@agentpay/core").Wire<Voucher>;
      signature: `0x${string}`;
    }>(new Headers(init.headers).get(HEADERS.PAYMENT_SIGNATURE)!);
    const voucher = fromWire<Voucher>("Voucher", wire.message);
    if (mode === "late") throw new Error("timeout");
    if (mode === "slow")
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("deadline")),
          { once: true },
        ),
      );
    const bytes = Buffer.from(JSON.stringify({ ok: mode !== "fail" }));
    const signed = await signDelivery(seller, 43113, escrow, {
      sessionId: 1n,
      seq: voucher.seq,
      requestHash: voucher.requestHash,
      specHash: session.specHash,
      bodyHash:
        (mode === "equivocation" && forwarded === 1) || mode === "wrong-hash"
          ? bodyHash(Buffer.from("first"))
          : bodyHash(bytes),
    });
    if (mode === "bad-signature") signed.signature = `0x${"00".repeat(65)}`;
    return new Response(mode === "large" ? Buffer.alloc(2048) : bytes, {
      headers: {
        [HEADERS.DELIVERY]: encodeHeader(signed),
        "content-type": mode === "content" ? "text/plain" : "application/json",
      },
    });
  });
  const signer = createSigner(verifier, 43113, escrow);
  const checks = vi.fn(async () => ({
    outcome: mode === "fail" ? 2 : mode === "inconclusive" ? 3 : 1,
    reasonCode: mode === "fail" ? 11 : mode === "inconclusive" ? 20 : 0,
    evidenceHash: ZERO_HASH,
  }));
  const runtime = createRuntime({
    db,
    chain,
    writer,
    signer,
    clock: () => time,
    escrow,
    fetch: fetchSeller,
    checks,
  });
  const app = createApp({
    db,
    chain,
    signer,
    clock: () => time,
    config: { escrow },
    runtime,
  });
  async function payload(
    seq = Number(db.session(1n)?.last_seq ?? 0) + 1,
    overrides: Partial<Voucher> = {},
  ) {
    return {
      voucher: toWire(
        await signVoucher(buyer, 43113, escrow, {
          sessionId: 1n,
          seq,
          cumulativeAmount: BigInt(seq) * 10000n,
          requestHash: requestHash("GET", url),
          ...overrides,
        }),
      ),
      request: { method: "GET", url },
    };
  }
  const post = async (path: string, data: unknown) =>
    app.request(`/v1/sessions/1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  return {
    db,
    session,
    payment,
    chain,
    writer,
    signer,
    runtime,
    app,
    checks,
    fetchSeller,
    payload,
    post,
    spec,
    now: () => time,
    advance: (seconds = 1) => {
      time += seconds;
    },
    mode: (value: string) => {
      mode = value;
    },
    forwarded: () => forwarded,
    closeDb: () => {
      db.close();
      closed = true;
    },
  };
}
describe("relay and durable session accounting", () => {
  it("validates signature, seq, amount and request hash before contacting seller", async () => {
    const f = fixture();
    for (const [change, code] of [
      [{ seq: 2 }, "BAD_SEQ"],
      [{ cumulativeAmount: 2n }, "BAD_CUMULATIVE"],
      [{ requestHash: ZERO_HASH }, "BAD_REQUEST_HASH"],
    ] as const) {
      const response = await f.post("requests", await f.payload(1, change));
      expect((await response.json()).error.code).toBe(code);
    }
    const bad = await f.payload();
    bad.voucher.signature = `0x${"00".repeat(65)}`;
    expect((await (await f.post("requests", bad)).json()).error.code).toBe(
      "BAD_VOUCHER_SIG",
    );
    expect(f.fetchSeller).not.toHaveBeenCalled();
    expect(f.db.request(1n, 1)).toBeUndefined();
  });
  it("rejects mismatched discovery spec and malformed input without consuming voucher", async () => {
    const f = fixture();
    f.payment.extensions.agentpay.verificationSpec.delivery.maxBytes = 128;
    expect(
      (await (await f.post("requests", await f.payload())).json()).error.code,
    ).toBe("SPEC_REJECTED");
    expect(f.db.request(1n, 1)).toBeUndefined();
    expect(f.forwarded()).toBe(0);
    expect((await f.post("requests", { voucher: {} })).status).toBe(400);
    expect((await f.app.request("/v1/sessions/-1/receipts")).status).toBe(400);
  });
  it("returns a verified receipt with encrypted body and atomically counts it once", async () => {
    const f = fixture();
    const input = await f.payload();
    const response = await f.post("requests", input);
    expect(response.status).toBe(200);
    const out = await response.json(),
      receipt = {
        message: fromWire<Receipt>("Receipt", out.receipt.message),
        signature: out.receipt.signature,
      };
    expect(await verifyReceipt(43113, escrow, receipt, verifier.address)).toBe(
      true,
    );
    expect(receipt.message).toMatchObject({
      outcome: 1,
      amount: 10000n,
      seq: 1,
    });
    expect(f.db.session(1n)).toMatchObject({
      last_seq: 1,
      pass: 1,
      passed_amount: "10000",
      cumulative: "10000",
    });
    expect(
      Buffer.from(f.db.request(1n, 1)!.body_enc as Uint8Array).includes(
        Buffer.from('{"ok":true}'),
      ),
    ).toBe(false);
    expect((await (await f.post("requests", input)).json()).error.code).toBe(
      "BAD_SEQ",
    );
    expect(f.forwarded()).toBe(1);
    expect(
      (await (await f.app.request("/v1/sessions/1/receipts?fromSeq=1")).json())
        .receipts,
    ).toHaveLength(1);
  });
  it("serializes concurrent duplicate vouchers", async () => {
    const f = fixture(),
      input = await f.payload();
    const responses = await Promise.all([
      f.post("requests", input),
      f.post("requests", input),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(f.forwarded()).toBe(1);
  });
  it("FAIL increments streak, INCONCLUSIVE keeps it, PASS resets; third FAIL closes", async () => {
    const f = fixture();
    for (const [mode, streak] of [
      ["fail", 1],
      ["inconclusive", 1],
      ["good", 0],
      ["fail", 1],
      ["fail", 2],
      ["fail", 3],
    ] as const) {
      f.advance();
      f.mode(mode);
      const out = await (await f.post("requests", await f.payload())).json();
      expect(f.db.session(1n)?.fail_streak).toBe(streak);
      expect(out.receipt.message.amount).toBe(mode === "good" ? "10000" : "0");
    }
    await f.runtime.tick();
    expect(f.writer.close).toHaveBeenCalledTimes(1);
    expect(f.db.session(1n)?.close_tx).toBe(tx);
    expect(f.db.session(1n)).toMatchObject({
      pass: 1,
      fail: 4,
      inconclusive: 1,
      passed_amount: "10000",
    });
  });
  it.each([
    ["bad-signature", 3],
    ["wrong-hash", 3],
    ["slow", 3],
    ["late", 3],
    ["large", 4],
  ])("signs zero-body failure for %s", async (mode, reason) => {
    const f = fixture();
    f.mode(mode as string);
    const out = await (await f.post("requests", await f.payload())).json();
    expect(out.receipt.message).toMatchObject({
      outcome: 2,
      reasonCode: reason,
      bodyHash: ZERO_HASH,
      amount: "0",
    });
    expect(out.bodyBase64).toBeUndefined();
    expect(f.forwarded()).toBe(mode === "large" || mode === "slow" ? 1 : 2);
  });
  it("uses real worker checks for signed seller data", async () => {
    const f = fixture();
    f.checks.mockImplementation(createCheckRunner());
    f.mode("fail");
    const out = await (await f.post("requests", await f.payload())).json();
    expect(out.receipt.message).toMatchObject({ outcome: 2, reasonCode: 11 });
  });
  it("saves checkpoints 20 and 40 with Merkle roots, survives restart and serves same voucher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b-verifier-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "db.sqlite"),
      f = fixture(path);
    for (let i = 1; i <= 40; i++) {
      f.advance();
      const out = await (await f.post("requests", await f.payload())).json();
      expect(out.seq).toBe(i);
      if (i % 20 === 0) expect(out.checkpoint.message.lastSeq).toBe(i);
    }
    const point = f.db.verdict(1n, "checkpoint")!;
    expect(point.message.receiptsRoot).toBe(
      receiptsRoot(f.db.receipts(1n).map((r) => r.message)),
    );
    expect(
      await verifySessionVerdict(43113, escrow, point, verifier.address),
    ).toBe(true);
    f.closeDb();
    const restarted = fixture(path),
      wire = await (
        await restarted.app.request("/v1/sessions/1/checkpoint")
      ).json();
    expect(wire.voucher.message.seq).toBe(40);
    expect(wire.verdict).toEqual(toWire(point));
    expect(restarted.db.session(1n)?.pass).toBe(40);
  });
  it("recovers an interrupted voucher as INCONCLUSIVE without forwarding again", async () => {
    const f = fixture();
    f.db.saveSession(1n, f.session, f.now());
    const input = await f.payload();
    f.db.saveVoucher(
      {
        message: fromWire<Voucher>("Voucher", input.voucher.message),
        signature: input.voucher.signature,
      },
      f.now(),
    );
    await f.runtime.tick();
    expect(f.db.receipts(1n)[0].message).toMatchObject({
      outcome: 3,
      reasonCode: 21,
      amount: 0n,
    });
    expect(f.forwarded()).toBe(0);
    expect((await f.post("requests", await f.payload())).status).toBe(200);
    expect(f.db.session(1n)?.last_seq).toBe(2);
  });
  it("submits both conflicting signed deliveries once and recovers proof", async () => {
    const f = fixture();
    f.mode("equivocation");
    const response = await f.post("requests", await f.payload());
    expect(response.status).toBe(200);
    expect(f.db.deliveries(1n, 1)).toHaveLength(2);
    expect(f.writer.prove).toHaveBeenCalledTimes(1);
    expect(f.session.state).toBe(5);
    await f.runtime.tick();
    expect(f.writer.prove).toHaveBeenCalledTimes(1);
    expect(f.writer.close).not.toHaveBeenCalled();
  });
  it("limits request rate and open sessions per buyer", async () => {
    const f = fixture();
    const bad = await f.payload();
    bad.voucher.signature = `0x${"00".repeat(65)}`;
    for (let i = 0; i < 10; i++) await f.post("requests", bad);
    expect((await f.post("requests", bad)).status).toBe(429);
    f.advance();
    for (let id = 1n; id <= 21n; id++) f.db.saveSession(id, f.session, f.now());
    expect(
      (await (await f.post("requests", await f.payload())).json()).error.code,
    ).toBe("TOO_MANY_SESSIONS");
  });
});
describe("closer", () => {
  it("closes when another request would exceed usable cap", async () => {
    const f = fixture();
    f.session.cap = 60000n;
    expect((await f.post("requests", await f.payload())).status).toBe(200);
    f.advance();
    const result = await (await f.post("requests", await f.payload())).json();
    expect(result.closing).toBe(true);
    await f.runtime.tick();
    expect(f.writer.close).toHaveBeenCalledTimes(1);
    expect(f.db.session(1n)?.passed_amount).toBe("20000");
  });
  it("interrupts a slow in-flight delivery when the buyer signs close", async () => {
    const f = fixture();
    f.session.deliveryDeadlineSec = 300;
    f.payment.extensions.agentpay.session.deliveryDeadlineSec = 300;
    const original = f.fetchSeller.getMockImplementation()!;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    f.fetchSeller.mockImplementation(async (url, init) => {
      if (!new Headers(init.headers).has(HEADERS.PAYMENT_SIGNATURE))
        return original(url, init);
      dispatched();
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    });
    const relay = f.post("requests", await f.payload());
    await started;
    const close = f.post("close", {
      closeRequest: toWire(
        await signCloseRequest(buyer, 43113, escrow, {
          sessionId: 1n,
          deadline: BigInt(f.now() + 60),
        }),
      ),
    });
    const result = await (await relay).json();
    expect(result.receipt.message.outcome).toBe(3);
    expect((await close).status).toBe(200);
    expect(f.writer.close).toHaveBeenCalledTimes(1);
  });
  it("requires buyer signature and unexpired deadline, refunds empty, is idempotent", async () => {
    const f = fixture(),
      message = { sessionId: 1n, deadline: BigInt(f.now() + 60) };
    const send = async (key: typeof buyer, m = message) =>
      f.post("close", {
        closeRequest: toWire(await signCloseRequest(key, 43113, escrow, m)),
      });
    expect((await send(seller)).status).toBe(401);
    expect(
      (await send(buyer, { ...message, deadline: BigInt(f.now() - 1) })).status,
    ).toBe(400);
    expect(await (await send(buyer)).json()).toMatchObject({
      kind: "closeEmpty",
      txHash: tx,
    });
    await send(buyer);
    expect(f.writer.close).toHaveBeenCalledTimes(1);
  });
  it("persists pending hash across receipt timeout and avoids duplicate submission", async () => {
    const f = fixture();
    await f.post("requests", await f.payload());
    f.writer.confirm.mockRejectedValueOnce(new Error("RPC timeout"));
    const input = {
      closeRequest: toWire(
        await signCloseRequest(buyer, 43113, escrow, {
          sessionId: 1n,
          deadline: BigInt(f.now() + 60),
        }),
      ),
    };
    expect((await f.post("close", input)).status).toBe(503);
    expect(f.db.runtime(1n)?.pending_tx).toBe(tx);
    await f.runtime.tick();
    expect(f.writer.close).toHaveBeenCalledTimes(1);
    expect(f.db.session(1n)?.close_tx).toBe(tx);
  });
  it("reconciles a mined close hash after chain sync changes session state", async () => {
    const f = fixture();
    f.db.saveSession(1n, f.session, f.now());
    f.db.markClosing(1n);
    f.db.pendingTx(1n, tx);
    f.session.state = 5;
    await f.runtime.tick();
    expect(f.db.session(1n)?.close_tx).toBe(tx);
    expect(f.db.runtime(1n)?.pending_tx).toBeNull();
    expect(f.writer.close).not.toHaveBeenCalled();
  });
  it("closes before expiry and retries a reverted transaction at most three times", async () => {
    const f = fixture();
    f.db.saveSession(1n, f.session, f.now());
    f.advance(480);
    f.writer.confirm.mockResolvedValue(false);
    await f.runtime.tick();
    expect(f.writer.close).toHaveBeenCalledTimes(3);
    expect(f.db.session(1n)?.close_tx).toBeNull();
  });
});
describe("seller network boundary", () => {
  it("rejects private, loopback, mapped and link-local targets and redirects/credentials", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "224.0.0.1",
    ])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
    for (const target of [
      "http://127.1/",
      "http://0x7f000001/",
      "http://[::1]/",
      "http://localhost/",
      "file:///etc/passwd",
      "https://a:b@example.com/",
      "https://example.com/#x",
    ])
      expect(() => validateTarget(target)).toThrow();
    const client = createSellerFetch();
    try {
      await expect(client.fetch("http://localhost/", {})).rejects.toThrow();
    } finally {
      await client.close();
    }
    expect(() => validateTarget("http://127.0.0.1:1234/", true)).not.toThrow();
  });
});
