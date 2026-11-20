import { describe, expect, it, vi } from "vitest";
import { createRoutescan, MAINNET_USDC } from "../src/sources/routescan.js";
import { BASE_USDC, createAlchemyBase } from "../src/sources/alchemy.js";
import { summarizeHistory } from "../src/sources/history.js";
import { probe } from "../src/sources/probe.js";
import { DEPLOYMENTS } from "@agentpay/core";

const wallet = "0x0000000000000000000000000000000000000001";
const sender = "0x0000000000000000000000000000000000000002";
const sharedSender = "0xabcdef0000000000000000000000000000000002";
const tx = { contractAddress: MAINNET_USDC, to: wallet, from: sender, tokenDecimal: "6", value: "1000000", timeStamp: "100", hash: `0x${"1".repeat(64)}` };
const endpoint = "https://base-rpc.example/v2/test-key";
const baseTransfer = {
  uniqueId: `${tx.hash}:log:0`, category: "erc20", from: sharedSender, to: wallet,
  rawContract: { address: BASE_USDC, value: "0x3d0900", decimal: "0x6" },
  metadata: { blockTimestamp: new Date(50_000).toISOString() },
};
const spec = { specVersion: "agentpay-verify/0.2", serviceType: "json-data", passRule: "all", verifier: { address: sender, endpoint: "https://verifier.example" },
  delivery: { contentType: "application/json", maxBytes: 1000 }, checks: [{ id: "schema", type: "json-schema", schema: { type: "object", required: ["price"] } }] };
function payment(seller = wallet) {
  return { x402Version: 2, resource: { url: "https://seller.example/price" },
    accepts: [{ scheme: "agentpay-session", network: "eip155:43113", asset: DEPLOYMENTS.fuji.usdc, amount: "10000", payTo: DEPLOYMENTS.fuji.escrow,
      maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
    extensions: { agentpay: { version: "0.2", verificationSpec: spec, session: { contract: DEPLOYMENTS.fuji.escrow, chainId: 43113, seller, sellerAgentId: "12",
      pricePerRequest: "10000", minCap: "1000000", maxCap: "20000000", defaultExpirySec: 3600, maxExpirySec: 3600, deliveryDeadlineSec: 10, challengeWindowSec: 60 } } } };
}
describe("reference sources", () => {
  it("counts only incoming USDC, ignores self transfers, deduplicates and caches", async () => {
    let now = 1000;
    const fetcher = vi.fn(async () => Response.json({ status: "1", result: [tx, tx, { ...tx, to: sender }, { ...tx, from: wallet }] }));
    const read = createRoutescan(fetcher, () => now);
    expect(summarizeHistory(now, await read(wallet))).toMatchObject({ transactions: 1, totalUsd: 1, senders: 1 });
    await read(wallet); expect(fetcher).toHaveBeenCalledTimes(1);
    now += 3600; await read(wallet); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("treats rate-limit/API failure as unavailable, not an empty history", async () => {
    expect(await createRoutescan(async () => Response.json({ status: "0", result: "rate limited" }), () => 1000)(wallet)).toBeNull();
  });
  it("merges 3 Avalanche USDC and 4 Base USDC, taking the union of senders and earliest receipt", async () => {
    const clock = () => 1000;
    const avalanche = await createRoutescan(async () => Response.json({ status: "1", result: [
      tx, { ...tx, from: `0x${sharedSender.slice(2).toUpperCase()}`, value: "2000000", logIndex: "1" },
    ] }), clock)(wallet);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: { transfers: [baseTransfer], pageKey: "next" } }))
      .mockResolvedValueOnce(Response.json({ result: { pageKey: "", transfers: [
        baseTransfer,
        { ...baseTransfer, uniqueId: "wrong token", rawContract: { ...baseTransfer.rawContract, address: MAINNET_USDC } },
        { ...baseTransfer, uniqueId: "zero", rawContract: { ...baseTransfer.rawContract, value: "0x0" } },
        { ...baseTransfer, uniqueId: "self", from: wallet },
        { ...baseTransfer, uniqueId: "outgoing", to: sender },
      ] } }));
    const base = await createAlchemyBase(endpoint, fetcher, clock)(wallet);
    expect(summarizeHistory(clock(), avalanche, base)).toEqual({
      transactions: 3, totalUsd: 7, senders: 2, ageMonths: (clock() - 50) / 2592000,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [i, [url, init]] of fetcher.mock.calls.entries()) {
      expect(url).toBe(endpoint);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ method: "alchemy_getAssetTransfers", params: [{
        toAddress: wallet, category: ["erc20"], contractAddresses: [BASE_USDC], withMetadata: true,
        ...(i ? { pageKey: "next" } : {}),
      }] });
    }
  });
  it("discards the Base history when a later page fails", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: { transfers: [baseTransfer], pageKey: "next" } }))
      .mockResolvedValueOnce(Response.json({ error: { code: -32000 } }));
    const read = createAlchemyBase(endpoint, fetcher, () => 1000);
    expect(await read(wallet)).toBeNull();
    expect(await read(wallet)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("accepts valid 402 and rejects wrong wallet, bad spec, non-402 and oversized body", async () => {
    expect(await probe("https://seller.example", wallet, "12", async () => Response.json(payment(), { status: 402 }))).toBe(true);
    expect(await probe("https://seller.example", wallet, "12", async () => Response.json(payment(sender), { status: 402 }))).toBe(false);
    expect(await probe("https://seller.example", wallet, "12", async () => Response.json({}, { status: 402 }))).toBe(false);
    expect(await probe("https://seller.example", wallet, "12", async () => Response.json(payment()))).toBe(false);
    expect(await probe("https://seller.example", wallet, "12", async () => new Response("x".repeat(32769), { status: 402 }))).toBe(false);
  });
});
