/** Production Verifier for E3; controlled malicious Verifier only for E5. */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPaySeller, createFileSellerStore } from "@agentpay/seller";
import { createAgentPayBuyer, createMemoryBuyerStore } from "@agentpay/buyer";
import {
  HEADERS,
  Outcome,
  ZERO_HASH,
  bodyHash,
  encodeHeader,
  decodeHeaderJson,
  fromWire,
  receiptsRoot,
  signReceipt,
  signSessionVerdict,
  specHash,
  toWire,
  type Receipt,
  type RelayRequest,
  type Voucher,
  type WireSigned,
  type Delivery,
  type VerificationSpec,
  type CheckpointResponse,
} from "@agentpay/core";
import type { Stack } from "../src/harness.js";

export async function sdkFixture(s: Stack, malicious = false) {
  const directory = await mkdtemp(join(tmpdir(), "agentpay-sdk-e2e-"));
  const shutdown: (() => Promise<void> | void)[] = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  async function listen(app: Hono) {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      });
    };
    shutdown.push(stop);
    return {
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      stop,
    };
  }
  try {
    const relay = new Hono(),
      sellerApp = new Hono();
    const verifier = malicious
      ? await listen(relay)
      : { url: s.urls.verifier, stop: s.stopVerifier };
    const goodBody = Buffer.from("agreed result"),
      actualBody = malicious ? Buffer.from("wrong result") : goodBody;
    const spec: VerificationSpec = {
      specVersion: "agentpay-verify/0.2",
      serviceType: "file",
      passRule: "all",
      verifier: {
        address: s.chain.accounts.verifier.address,
        endpoint: verifier.url,
      },
      delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
      checks: [
        { id: "hash", type: "hash-match", expectedHash: bodyHash(goodBody) },
      ],
    };
    const sellerStore = createFileSellerStore(join(directory, "seller"));
    const options = {
      account: s.chain.accounts.seller,
      chainId: 43113,
      escrow: s.chain.escrow,
      asset: s.chain.usdc,
      publicClient: s.chain.publicClient,
      walletClient: s.chain.wallet("seller"),
      sellerAgentId: s.chain.agentId,
      pricePerRequest: 10_000n,
      spec,
      verifierUrl: verifier.url,
      store: sellerStore,
      clock: s.clock,
      terms: {
        minCap: 500_000n,
        maxCap: 20_000_000n,
        defaultExpirySec: 180,
        maxExpirySec: 3600,
        deliveryDeadlineSec: 10,
        challengeWindowSec: 30,
      },
    };
    let seller = createAgentPaySeller(options);
    seller.stop();
    shutdown.push(() => seller.stop());
    sellerApp.use("/file", seller.middleware());
    sellerApp.get(
      "/file",
      () =>
        new Response(actualBody, {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const sellerServer = await listen(sellerApp);
    const url = sellerServer.url + "/file";
    const records = new Map<
      string,
      { voucher: WireSigned<Voucher>; receipts: WireSigned<Receipt>[] }
    >();
    async function checkpoint(id: string): Promise<CheckpointResponse> {
      const record = records.get(id)!;
      const leaves = record.receipts.map((r) =>
        fromWire<Receipt>("Receipt", r.message),
      );
      const verdict = await signSessionVerdict(
        s.chain.accounts.verifier,
        43113,
        s.chain.escrow,
        {
          sessionId: BigInt(id),
          lastSeq: record.voucher.message.seq,
          specHash: specHash(spec),
          passCount: leaves.length,
          failCount: 0,
          inconclusiveCount: 0,
          passedAmount: BigInt(leaves.length) * 10_000n,
          receiptsRoot: receiptsRoot(leaves),
          closedAt: BigInt(s.clock()),
        },
      );
      return {
        sessionId: id,
        voucher: record.voucher,
        verdict: toWire(verdict),
      };
    }
    relay.post("/v1/sessions/:id/requests", async (c) => {
      const { voucher, request } = await c.req.json<RelayRequest>();
      const response = await fetch(request.url, {
        headers: { [HEADERS.PAYMENT_SIGNATURE]: encodeHeader(voucher) },
      });
      if (response.status !== 200)
        throw new Error("Seller rejected test voucher");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const delivery = decodeHeaderJson<WireSigned<Delivery>>(
        response.headers.get(HEADERS.DELIVERY)!,
      );
      const message = fromWire<Delivery>("Delivery", delivery.message);
      const receipt = toWire(
        await signReceipt(s.chain.accounts.verifier, 43113, s.chain.escrow, {
          sessionId: message.sessionId,
          seq: message.seq,
          requestHash: message.requestHash,
          bodyHash: bodyHash(bytes),
          outcome: Outcome.PASS,
          reasonCode: 0,
          amount: 10_000n,
          receivedAt: BigInt(s.clock()),
          evidenceHash: ZERO_HASH,
        }),
      );
      const id = c.req.param("id"),
        previous = records.get(id);
      records.set(id, {
        voucher,
        receipts: [...(previous?.receipts ?? []), receipt],
      });
      return c.json({
        sessionId: id,
        seq: message.seq,
        delivery,
        receipt,
        bodyBase64: Buffer.from(bytes).toString("base64"),
        contentType: "application/octet-stream",
        closing: false,
      });
    });
    relay.get("/v1/sessions/:id/receipts", (c) =>
      c.json({
        sessionId: c.req.param("id"),
        receipts: records.get(c.req.param("id"))?.receipts ?? [],
      }),
    );
    relay.get("/v1/sessions/:id/checkpoint", async (c) =>
      c.json(await checkpoint(c.req.param("id"))),
    );
    relay.post("/v1/sessions/:id/close", async (c) => {
      const cp = await checkpoint(c.req.param("id"));
      const voucher = fromWire<Voucher>("Voucher", cp.voucher.message);
      const verdict = fromWire<import("@agentpay/core").SessionVerdict>(
        "SessionVerdict",
        cp.verdict.message,
      );
      const txHash = await s.write(
        "closeSession",
        [
          BigInt(cp.sessionId),
          voucher,
          cp.voucher.signature,
          verdict,
          cp.verdict.signature,
        ],
        "verifier",
      );
      return c.json({ sessionId: cp.sessionId, txHash });
    });
    const buyerStore = createMemoryBuyerStore();
    const buyer = createAgentPayBuyer({
      mode: "auto",
      account: s.chain.accounts.buyer,
      walletClient: s.chain.wallet("buyer"),
      chainId: 43113,
      publicClient: s.chain.publicClient,
      trustedEscrows: [s.chain.escrow],
      facilitatorUrl: s.urls.facilitator,
      scorerUrl: s.urls.scorer,
      softPolicy: { maxPerSession: 1_000_000n, maxPricePerRequest: 10_000n },
      defaultCap: 1_000_000n,
      defaultExpirySec: 180,
      clock: s.clock,
      store: buyerStore,
      checks: ({ body }) =>
        bodyHash(body) === bodyHash(goodBody) ? Outcome.PASS : Outcome.FAIL,
    });
    return {
      buyer,
      buyerStore,
      sellerStore,
      url,
      directory,
      sellerSync: () => seller.sync(),
      stopVerifier: verifier.stop,
      restartSeller() {
        seller.stop();
        seller = createAgentPaySeller({
          ...options,
          store: createFileSellerStore(join(directory, "seller")),
        });
        seller.stop();
      },
      async stop() {
        for (const stop of shutdown.reverse()) await stop();
      },
    };
  } catch (error) {
    for (const stop of shutdown.reverse())
      await Promise.resolve(stop()).catch(() => {});
    throw error;
  }
}
