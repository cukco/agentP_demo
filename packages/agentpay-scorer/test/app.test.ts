import { afterEach, describe, expect, it, vi } from "vitest";
import { walletProofMessage, verifyScoreAttestation } from "@agentpay/core";
import { privateKeyToAccount } from "viem/accounts";
import type { PublicClient } from "viem";
import { walletLinkAuthorizationMessage } from "../src/proof.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { MAINNET_USDC } from "../src/sources/routescan.js";
import { BASE_USDC } from "../src/sources/alchemy.js";
import { referenceScore } from "../src/score/reference.js";

const seller = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const scorer = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"3".padStart(64, "0")}`);
const now = 1800000000;
const baseUrl = "https://base-rpc.example/v2/test-key";
const baseTransfer = {
  uniqueId: "base-log-1", category: "erc20", from: other.address, to: seller.address,
  rawContract: { address: BASE_USDC, value: "0x3d0900", decimal: "0x6" },
  metadata: { blockTimestamp: new Date((now - 86400 * 800) * 1000).toISOString() },
};
const config = { chainId: 43113, escrow: other.address, identity: other.address, reputation: other.address, startBlock: 0n };
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(d => d.close()); });
function setup(blocked = false, alchemyBaseUrl?: string) {
  const db = openDatabase(); databases.push(db);
  const chain = { wallet: vi.fn(async () => seller.address), history: vi.fn(async () => ({ sessions: [], summary: { count: "0", value: "0", decimals: 0 }, block: "1" })) };
  const baseFetch = vi.fn(async () => Response.json({ result: { transfers: [baseTransfer] } }));
  const mainnetFetch = vi.fn<typeof fetch>(async input => {
    if (String(input) === baseUrl) return baseFetch();
    return Response.json({ status: "1", result: [{ contractAddress: MAINNET_USDC, to: seller.address,
      from: other.address, tokenDecimal: "6", value: "1000000000", timeStamp: String(now - 86400 * 400), hash: `0x${"1".repeat(64)}` }] });
  });
  const app = createApp({ db, publicClient: {} as PublicClient, mainnetFetch, clock: () => now, signer: scorer, config, chain,
    blocked: () => blocked, alchemyBaseUrl });
  return { app, db, chain, mainnetFetch, baseFetch };
}
async function proof(id = "12", age = 0, signer = seller) {
  const issuedAt = new Date((now - age) * 1000).toISOString();
  return { mainnetWallet: seller.address, issuedAt, signature: await signer.signMessage({ message: walletProofMessage(id, seller.address, issuedAt) }) };
}
async function post(app: ReturnType<typeof createApp>, body: unknown, id = "12", authorization?: string) {
  return app.request(`/v1/sellers/${id}/wallet-proof`, { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { "X-AgentPay-Wallet-Authorization": authorization } : {}) }, body: JSON.stringify(body) });
}

describe("Scorer API", () => {
  it.each([undefined, baseUrl])("only queries enabled sources after wallet proof (Base URL %s)", async alchemyBaseUrl => {
    const { app, mainnetFetch, baseFetch } = setup(false, alchemyBaseUrl);
    expect(await (await app.request("/v1/score/12")).json()).toMatchObject({ score: 0, flags: 1, distinctBuyers: 0 });
    expect(mainnetFetch).not.toHaveBeenCalled();
    expect((await post(app, await proof())).status).toBe(200);
    const expected = alchemyBaseUrl ? { transactions: 2, totalUsd: 1004, senders: 1, ageMonths: 800 / 30 }
      : { transactions: 1, totalUsd: 1000, senders: 1, ageMonths: 400 / 30 };
    expect(await (await app.request("/v1/score/12")).json()).toMatchObject({ referenceScore: referenceScore(expected, false), flags: 1 });
    await app.request("/v1/score/12");
    expect(mainnetFetch).toHaveBeenCalledTimes(alchemyBaseUrl ? 2 : 1);
    expect(baseFetch).toHaveBeenCalledTimes(alchemyBaseUrl ? 1 : 0);
  });
  it("uses Avalanche alone and does not persist or return a failed Base URL", async () => {
    const { app, db, baseFetch } = setup(false, baseUrl);
    const input = vi.spyOn(db, "input");
    baseFetch.mockResolvedValueOnce(Response.json({ result: { transfers: [baseTransfer], pageKey: "next" } }))
      .mockRejectedValueOnce(new Error(`Could not reach ${baseUrl}`));
    expect((await post(app, await proof())).status).toBe(200);
    const body = await (await app.request("/v1/score/12")).text();
    expect(JSON.parse(body)).toMatchObject({ score: 23, flags: 1 });
    expect(body).not.toContain(baseUrl);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(input).toHaveBeenCalledWith("12", `alchemy-base:${seller.address.toLowerCase()}`, null, now);
    expect(JSON.stringify(input.mock.calls)).not.toContain(baseUrl);
  });
  it("caps a proven wallet's combined score with the probe bonus", async () => {
    const { app, db, baseFetch } = setup(false, baseUrl);
    expect((await post(app, await proof())).status).toBe(200);
    const linked = db.seller("12")!;
    db.saveSeller({ ...linked, lastProbe: { at: now, ok: true } });
    baseFetch.mockResolvedValueOnce(Response.json({ result: { transfers: [{
      ...baseTransfer, rawContract: { ...baseTransfer.rawContract, value: "0x9502f9000" },
    }] } }));
    expect(await (await app.request("/v1/score/12")).json()).toMatchObject({ referenceScore: 40, score: 40 });
  });
  it("takes the strongest proven wallet's score independently of the other wallet", async () => {
    const { app, baseFetch } = setup(false, baseUrl);
    expect((await post(app, await proof())).status).toBe(200);
    const issuedAt = new Date(now * 1000).toISOString();
    const p = { mainnetWallet: other.address, issuedAt, signature: await other.signMessage({
      message: walletProofMessage("12", other.address, issuedAt),
    }) };
    const authorization = await seller.signMessage({
      message: walletLinkAuthorizationMessage("12", p, config.chainId, config.escrow, seller.address),
    });
    expect((await post(app, p, "12", authorization)).status).toBe(200);
    baseFetch.mockResolvedValueOnce(Response.json({ result: { transfers: [baseTransfer] } }))
      .mockResolvedValueOnce(Response.json({ result: { transfers: [{
        ...baseTransfer, to: other.address, from: seller.address,
        rawContract: { ...baseTransfer.rawContract, value: `0x${(3_000_000_000n).toString(16)}` },
      }] } }));
    expect(await (await app.request("/v1/score/12")).json()).toMatchObject({
      referenceScore: referenceScore({ transactions: 1, totalUsd: 3000, senders: 1, ageMonths: 800 / 30 }, false),
    });
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
  it.each([601, -1])("rejects expired/future proof (%s seconds)", async age => {
    expect((await post(setup().app, await proof("12", age))).status).toBe(400);
  });
  it("rejects wrong signer and cross-agent replay", async () => {
    const { app } = setup();
    expect((await post(app, await proof("12", 0, other))).status).toBe(400);
    expect((await post(app, await proof("13"))).status).toBe(400);
  });
  it("rejects a valid unrelated wallet proof without the registered payment wallet's consent", async () => {
    const { app, db } = setup();
    const issuedAt = new Date(now * 1000).toISOString();
    const p = { mainnetWallet: other.address, issuedAt, signature: await other.signMessage({ message: walletProofMessage("12", other.address, issuedAt) }) };
    expect((await post(app, p)).status).toBe(403);
    const forged = await other.signMessage({ message: walletLinkAuthorizationMessage("12", p, 43113, config.escrow, seller.address) });
    expect((await post(app, p, "12", forged)).status).toBe(403);
    expect(db.seller("12")?.mainnetWallets).toEqual([]);
  });
  it("accepts dual proof and binds consent to agent, target wallet, chain, escrow and timestamp", async () => {
    const { app, db } = setup();
    const issuedAt = new Date(now * 1000).toISOString();
    const p = { mainnetWallet: other.address, issuedAt, signature: await other.signMessage({ message: walletProofMessage("12", other.address, issuedAt) }) };
    const sign = (id: string, input = p, chain = 43113, escrow = config.escrow) => seller.signMessage({ message: walletLinkAuthorizationMessage(id, input, chain, escrow, seller.address) });
    for (const signature of [await sign("13"), await sign("12", p, 1), await sign("12", p, 43113, seller.address),
      await sign("12", { ...p, mainnetWallet: scorer.address }), await sign("12", { ...p, issuedAt: new Date((now - 1) * 1000).toISOString() })]) {
      expect((await post(app, p, "12", signature)).status).toBe(403);
    }
    expect((await post(app, p, "12", await sign("12"))).status).toBe(200);
    expect(db.seller("12")?.mainnetWallets).toEqual([other.address]);
  });
  it("invalidates legacy links before using their history", async () => {
    const { app, db, mainnetFetch } = setup();
    db.saveSeller({ agentId: "12", payTo: seller.address, endpoints: [], mainnetWallets: [other.address], lastProbe: null });
    expect((await app.request("/v1/score/12")).status).toBe(200);
    expect(mainnetFetch).not.toHaveBeenCalled();
    expect(db.seller("12")?.mainnetWallets).toEqual([]);
  });
  it("refuses a link when payment wallet rotates before persistence", async () => {
    const { app, chain, db } = setup();
    chain.wallet.mockResolvedValueOnce(seller.address).mockResolvedValue(other.address);
    expect((await post(app, await proof())).status).toBe(409);
    expect(db.seller("12")?.mainnetWallets).toEqual([]);
  });
  it("gracefully drops Routescan when unavailable", async () => {
    const { app, mainnetFetch } = setup(); await post(app, await proof());
    mainnetFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await (await app.request("/v1/score/12")).json()).toMatchObject({ score: 0, flags: 1 });
  });
  it("rejects wallet mismatch before calculating or signing (V15)", async () => {
    const { app, chain } = setup();
    expect((await app.request(`/v1/attestation/12?wallet=${other.address}`)).status).toBe(409);
    expect(chain.history).not.toHaveBeenCalled();
  });
  it("signs the frozen EIP-712 schema with a 3000 second TTL and blocklist flags", async () => {
    const { app } = setup(true);
    const response = await app.request(`/v1/attestation/12?wallet=${seller.address}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attestation.message).toMatchObject({ flags: 3, validUntil: String(now + 3000) });
    const signed = { signature: body.attestation.signature, message: { ...body.attestation.message,
      agentId: BigInt(body.attestation.message.agentId), validUntil: BigInt(body.attestation.message.validUntil) } };
    expect(await verifyScoreAttestation(config.chainId, config.escrow, signed, scorer.address)).toBe(true);
  });
  it("refuses to sign when wallet rotates during calculation", async () => {
    const { app, chain } = setup();
    chain.wallet.mockResolvedValueOnce(seller.address).mockResolvedValueOnce(seller.address).mockResolvedValue(other.address);
    expect((await app.request(`/v1/attestation/12?wallet=${seller.address}`)).status).toBe(409);
  });
  it("fails closed on chain failure; malformed inputs return 400", async () => {
    const { app, chain } = setup();
    chain.history.mockRejectedValueOnce(new Error("RPC down"));
    expect((await app.request(`/v1/attestation/12?wallet=${seller.address}`)).status).toBe(503);
    for (const id of ["-1", "abc", "0x1", "01", (2n ** 256n).toString()]) {
      expect((await app.request(`/v1/score/${id}`)).status).toBe(400);
    }
    expect((await post(app, {}, "abc")).status).toBe(400);
  });
});
