import { createFileBuyerStore, createAgentPayBuyer, type BuyerCommonOptions } from "@agentpay/buyer";
import {
  CHAIN_ID, HEADERS, Outcome, ReasonCode, SessionState, TYPES, ZERO_HASH, agentPaySessionEscrowAbi, bodyHash,
  decodeHeaderJson, encodeHeader, fromWire, receiptsRoot, signReceipt, signScoreAttestation, signSessionVerdict, toWire,
  usdcDomain, verifyDelivery, type Delivery, type OpenParams, type Receipt, type RelayRequest, type RelayResponse, type Voucher, type WireSigned,
} from "@agentpay/core";
import { checkPrice, createApp, createPriceChecks, PRICE_PATH, type PriceResponse } from "@agentpay-demo/seller-avax-price";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { erc20Abi, parseAbi } from "viem";
import { expect, it } from "vitest";
import { createApp as createFacilitator } from "../../../packages/agentpay-facilitator/src/app.js";
import { AGENT_ID, PRICE, startChain } from "../../../packages/agentpay-keeper/test/helpers/chain.js";
import { faultSwitch, runInjection, runPaidDemo, verifyOnlyTransport } from "../src/run.js";

it("rehearses +20% fault, 18 receipts, auto-close, exact payout and both policy rejections on Anvil", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentpay-avax-"));
  const chain = await startChain({ chainId: CHAIN_ID.fuji });
  const { buyer, seller, verifier, scorer, owner } = chain.accounts;
  const { publicClient, escrow, usdc } = chain;
  const sellerUrl = "https://avax-seller.example" + PRICE_PATH;
  const lowScoreSellerUrl = "https://low-seller.example" + PRICE_PATH;
  const facilitatorUrl = "https://facilitator.example";
  const verifierInfo = { address: verifier.address, endpoint: "https://verifier.example/v1" };
  const agentIds = [AGENT_ID, AGENT_ID + 1n];
  const token = "fixture-only-fault-token";
  let now = Number(await chain.now());
  const clock = () => now;
  const readQuote = async () => ({ answer: 2_500_000_000n, decimals: 8, updatedAt: BigInt(now) });
  const apps = agentIds.map(sellerAgentId => createApp({ account: seller, chainId: CHAIN_ID.fuji, escrow, asset: usdc,
    publicClient, walletClient: chain.wallet("seller"), sellerAgentId, verifier: verifierInfo, verifierUrl: verifierInfo.endpoint,
    readQuote, clock, faultToken: token,
  }));
  apps.forEach(app => app.stop());
  const receipts: Receipt[] = [];
  const seenPrices: number[] = [];
  const opened: string[] = [];
  const simulationReasons: string[] = [];
  const store = createFileBuyerStore(directory);
  const abi = parseAbi([
    "function identityRegistry() view returns (address)", "function setTokenURI(uint256 id,string uri)",
    "function setAgentWallet(uint256 id,address wallet)",
  ]);
  async function mined(hash: Parameters<typeof publicClient.waitForTransactionReceipt>[0]["hash"]) {
    expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
  }

  try {
    const registry = await publicClient.readContract({ address: escrow, abi, functionName: "identityRegistry" });
    const urls = [sellerUrl, lowScoreSellerUrl];
    for (const [i, agentId] of agentIds.entries()) {
      await mined(await chain.wallet("owner").writeContract({ address: registry, abi, functionName: "setAgentWallet", args: [agentId, seller.address] }));
      const uri = new URL("/registration.json", urls[i]).href;
      await mined(await chain.wallet("owner").writeContract({ address: registry, abi, functionName: "setTokenURI", args: [agentId, uri] }));
    }
    await mined(await chain.wallet("buyer").writeContract({
      address: escrow, abi: agentPaySessionEscrowAbi, functionName: "registerBuyer",
      args: [owner.address, { maxPerSession: 5_000_000n, dailyCap: 10_000_000n, minScore: 50, paused: false, sellerAllowlistOn: false }],
    }));
    now = Number(await chain.now());
    const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    const facilitator = createFacilitator({ escrow, usdc, publicClient, walletClient: chain.wallet("owner") as never, clock });
    const transport: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const uri = new URL(request.url);
      const sellerIndex = urls.findIndex(url => new URL(url).origin === uri.origin);
      if (sellerIndex !== -1) {
        if (uri.pathname === "/registration.json") return Response.json({ services: [{ endpoint: urls[sellerIndex] }] });
        return apps[sellerIndex]!.fetch(request);
      }
      if (uri.origin === "https://scorer.example") {
        const agentId = BigInt(uri.pathname.split("/").at(-1)!);
        const attestation = await signScoreAttestation(scorer, CHAIN_ID.fuji, escrow, {
          agentId, wallet: seller.address, score: agentId === AGENT_ID ? 80 : 20, flags: 0, validUntil: BigInt(now + 1800),
        });
        return Response.json({ scorer: scorer.address, attestation: toWire(attestation) });
      }
      if (uri.origin === facilitatorUrl) {
        const response = await facilitator.fetch(request);
        const result = await response.clone().json() as { sessionId?: string; invalidReason?: string };
        if (uri.pathname === "/settle" && result.sessionId) opened.push(result.sessionId);
        if (uri.pathname === "/verify" && result.invalidReason) simulationReasons.push(result.invalidReason);
        return response;
      }
      expect(uri.origin).toBe("https://verifier.example");
      const { voucher, request: target } = await request.json() as RelayRequest;
      const response = await apps[0]!.request(target.url, {
        method: target.method, headers: { [HEADERS.PAYMENT_SIGNATURE]: encodeHeader(voucher) },
      });
      expect(response.status).toBe(200);
      const delivery = decodeHeaderJson<WireSigned<Delivery>>(response.headers.get(HEADERS.DELIVERY)!);
      const message = fromWire<Delivery>("Delivery", delivery.message);
      expect(await verifyDelivery(CHAIN_ID.fuji, escrow, { message, signature: delivery.signature }, seller.address)).toBe(true);
      const body = Buffer.from(await response.arrayBuffer());
      expect(message.bodyHash).toBe(bodyHash(body));
      const contentType = response.headers.get("content-type")!;
      const checked = await checkPrice({ body, contentType, receivedAt: BigInt(now) }, readQuote, clock);
      seenPrices.push((JSON.parse(body.toString("utf8")) as PriceResponse).price);
      const receipt: Receipt = { sessionId: message.sessionId, seq: message.seq, requestHash: message.requestHash,
        bodyHash: message.bodyHash, outcome: checked.outcome, reasonCode: checked.reasonCode, receivedAt: BigInt(now),
        amount: checked.outcome === Outcome.PASS ? PRICE : 0n, evidenceHash: ZERO_HASH };
      receipts.push(receipt);
      const closing = receipts.slice(-3).length === 3 && receipts.slice(-3).every(item => item.outcome === Outcome.FAIL);
      if (closing) {
        const passCount = receipts.filter(item => item.outcome === Outcome.PASS).length;
        const verdict = await signSessionVerdict(verifier, CHAIN_ID.fuji, escrow, {
          sessionId: message.sessionId, specHash: message.specHash, lastSeq: message.seq, passCount,
          failCount: receipts.length - passCount, inconclusiveCount: 0, passedAmount: BigInt(passCount) * PRICE,
          receiptsRoot: receiptsRoot(receipts), closedAt: BigInt(now),
        });
        await mined(await chain.wallet("verifier").writeContract({
          address: escrow, abi: agentPaySessionEscrowAbi, functionName: "closeSession",
          args: [message.sessionId, fromWire<Voucher>("Voucher", voucher.message), voucher.signature, verdict.message, verdict.signature],
        }));
      }
      return Response.json({ sessionId: message.sessionId.toString(), seq: message.seq, closing, delivery, contentType,
        bodyBase64: body.toString("base64"), receipt: toWire(await signReceipt(verifier, CHAIN_ID.fuji, escrow, receipt)),
      } satisfies RelayResponse);
    };

    const options: BuyerCommonOptions = { chainId: CHAIN_ID.fuji, publicClient, trustedEscrows: [escrow],
      facilitatorUrl, scorerUrl: "https://scorer.example", defaultCap: 1_000_000n, defaultExpirySec: 3600,
      clock, store, fetch: transport, softPolicy: { maxPerSession: 1_000_000n, maxPricePerRequest: PRICE },
      ...createPriceChecks(verifierInfo, readQuote, clock),
    };
    const sdk = createAgentPayBuyer({ ...options, mode: "approve", buyerAddress: buyer.address, async onApprovalUrl(url) {
      const { origin, hash } = new URL(url);
      const headers = { authorization: "Bearer " + hash.slice(1) };
      const review = await (await fetch(origin + "/params", { headers })).json() as {
        nonce: `0x${string}`; params: { cap: string }; validBefore: string;
      };
      const signature = await buyer.signTypedData({ domain: usdcDomain(CHAIN_ID.fuji, usdc), types: TYPES.ReceiveWithAuthorization,
        primaryType: "ReceiveWithAuthorization", message: {
          from: buyer.address, to: escrow, value: BigInt(review.params.cap), nonce: review.nonce,
          validAfter: 0n, validBefore: BigInt(review.validBefore),
        } });
      const result = await fetch(origin + "/signature", { method: "POST",
        headers: { ...headers, origin, "content-type": "application/json" }, body: JSON.stringify({ signature, validBefore: review.validBefore }),
      });
      expect(result.ok).toBe(true);
    } });
    const balance = (address: typeof buyer.address) => publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const starting = await Promise.all([balance(buyer.address), balance(seller.address), balance(escrow)]);
    const logs: string[] = [];
    const denied = await apps[0]!.request("/admin/fault", { method: "POST", body: '{"on":true}' });
    expect(denied.status).toBe(403);
    const id = await runPaidDemo({ buyer: sdk, sellerUrl, calls: 18, setFault: faultSwitch(sellerUrl, token, transport),
      log: text => logs.push(text), async waitForSettlement(id) {
        expect(await chain.state(BigInt(id))).toBe(SessionState.CLOSING);
        await chain.advance(32);
        now = Number(await chain.now());
        await mined(await chain.wallet("keeper").writeContract({
          address: escrow, abi: agentPaySessionEscrowAbi, functionName: "finalize", args: [BigInt(id)],
        }));
      } });
    expect(seenPrices).toEqual([...Array(15).fill(25), ...Array(3).fill(30)]);
    expect(receipts.map(receipt => receipt.reasonCode)).toEqual([...Array(15).fill(ReasonCode.PASS), ...Array(3).fill(ReasonCode.CHECK_ORACLE_DEVIATION)]);
    expect(opened).toEqual([id]);
    expect(logs.filter(line => line.includes(" PASS"))).toHaveLength(15);
    expect(logs.filter(line => line.includes(" FAIL"))).toHaveLength(3);
    expect(await chain.state(BigInt(id))).toBe(SessionState.SETTLED);
    const feedback = agentPaySessionEscrowAbi.find(item => item.type === "event" && item.name === "FeedbackGiven")!;
    const entries = await publicClient.getLogs({ address: escrow, event: feedback, args: { sessionId: BigInt(id) }, fromBlock, strict: true });
    expect(entries.some(row => row.args.ok && row.args.agentId === AGENT_ID)).toBe(true);
    const after = await Promise.all([balance(buyer.address), balance(seller.address), balance(escrow)]);
    expect(after).toEqual([starting[0]! - 190_000n, starting[1]! + 149_250n, starting[2]! + 40_750n]);

    const injectionBuyer = createAgentPayBuyer({ ...options, mode: "auto", account: buyer, walletClient: chain.wallet("buyer"),
      fetch: verifyOnlyTransport(facilitatorUrl, transport), softPolicy: { maxPerSession: 20_000_000n, maxPricePerRequest: PRICE },
    });
    await runInjection({ buyer: injectionBuyer, sellerUrl, lowScoreSellerUrl, log: line => logs.push(line) });
    expect(simulationReasons).toEqual(["OverPerSession", "BadScore"]);
    expect(opened).toEqual([id]);
    expect(await Promise.all([balance(buyer.address), balance(seller.address), balance(escrow)])).toEqual(after);
  } finally {
    await chain.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
