/**
 * D7 · E2E on real Fuji against the public services (Seller, Verifier + Keeper, Facilitator, Scorer).
 * Opt-in: `pnpm --filter @agentpay/e2e test:fuji` (spends a little test USDC and AVAX from buyer-auto).
 * Needs buyer-auto registered (5 USDC/session, minScore 30) and a low-score seller (LOW_SCORE_SELLER_URL).
 * Approve mode needs a human MetaMask signature, so it is covered by E1 on Anvil; Fuji runs auto mode.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, fallback, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche, avalancheFuji } from "viem/chains";
import { createAgentPayBuyer, createFileBuyerStore } from "@agentpay/buyer";
import { CHAIN_ID, DEPLOYMENTS, LIMITS, SessionState, agentPaySessionEscrowAbi } from "@agentpay/core";
import { createPriceChecks, createPriceReader, PRICE_PER_REQUEST } from "@agentpay-demo/seller-avax-price";
import { faultSwitch, runInjection, runPaidDemo, verifyOnlyTransport } from "@agentpay-demo/buyer-agent";

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(new URL("../../../../.env", import.meta.url), "utf8"));
  } catch {
    return {};
  }
})();
const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
const enabled = env.E2E_TARGET === "fuji";
const need = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Configure ${name}`);
  return value;
};

const ONE_USDC = 1_000_000n;
const escrow = DEPLOYMENTS.fuji.escrow;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const settledEvent = agentPaySessionEscrowAbi.find(e => e.type === "event" && e.name === "Settled")!;
const refundedEvent = agentPaySessionEscrowAbi.find(e => e.type === "event" && e.name === "Refunded")!;
const feedbackEvent = agentPaySessionEscrowAbi.find(e => e.type === "event" && e.name === "FeedbackGiven")!;
const clock = () => Math.floor(Date.now() / 1000);
const snowtrace = (hash: string) => `https://testnet.snowtrace.io/tx/${hash}`;

describe.skipIf(!enabled)("Fuji E2E against the public services", () => {
  let ctx: ReturnType<typeof setup>;

  function setup() {
    if (need("AGENTPAY_ESCROW").toLowerCase() !== escrow.toLowerCase()) throw new Error("Expected the reviewed Fuji Escrow");
    const rpcs = [env.FUJI_RPC_URL_2, env.FUJI_RPC_URL_1].filter((url): url is string => Boolean(url));
    const transport = fallback(rpcs.map(url => http(url, { timeout: 10_000 })));
    const publicClient = createPublicClient({ chain: avalancheFuji, transport });
    const oracle = createPublicClient({ chain: avalanche, transport: fallback(
      [env.AVAX_MAINNET_RPC_URL_1, env.AVAX_MAINNET_RPC_URL_2].filter((url): url is string => Boolean(url)).map(url => http(url))) });
    const account = privateKeyToAccount(need("BUYER_AUTO_PRIVATE_KEY") as Hex);
    const walletClient = createWalletClient({ chain: avalancheFuji, transport, account });
    const verifierUrl = need("VERIFIER_URL");
    let reference: number | undefined;
    const buyer = (options: { fetch?: typeof fetch; maxPerSession?: bigint } = {}) => createAgentPayBuyer({
      mode: "auto", account, walletClient, chainId: CHAIN_ID.fuji, publicClient, trustedEscrows: [escrow],
      facilitatorUrl: need("FACILITATOR_URL"), scorerUrl: need("SCORER_URL"), defaultCap: ONE_USDC, defaultExpirySec: 3600, clock,
      store: createFileBuyerStore(mkdtempSync(join(tmpdir(), "agentpay-fuji-"))),
      softPolicy: { maxPerSession: options.maxPerSession ?? ONE_USDC, maxPricePerRequest: PRICE_PER_REQUEST },
      ...createPriceChecks({ address: DEPLOYMENTS.fuji.verifier, endpoint: verifierUrl }, createPriceReader(oracle), clock,
        value => { reference = value; }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const session = (id: bigint) => publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi,
      functionName: "getSession", args: [id] });
    const usdc = () => publicClient.readContract({ address: DEPLOYMENTS.fuji.usdc, abi: erc20, functionName: "balanceOf",
      args: [account.address] });
    async function waitFor(id: bigint, wanted: SessionState, timeoutSec: number) {
      const deadline = clock() + timeoutSec;
      for (;;) {
        const { state } = await session(id);
        if (state === wanted) return;
        if (state === SessionState.SETTLED || state === SessionState.REFUNDED) {
          throw new Error(`Session ${id} ended as ${SessionState[state]}, expected ${SessionState[wanted]}`);
        }
        if (clock() > deadline) throw new Error(`Session ${id} still ${SessionState[state]} after ${timeoutSec}s`);
        await delay(5000);
      }
    }
    const logs = async (id: bigint, fromBlock: bigint) => {
      const filter = { address: escrow, args: { sessionId: id }, fromBlock, strict: true as const };
      const [settled, refunded, feedback] = await Promise.all([
        publicClient.getLogs({ ...filter, event: settledEvent }),
        publicClient.getLogs({ ...filter, event: refundedEvent }),
        publicClient.getLogs({ ...filter, event: feedbackEvent }),
      ]);
      return { settled, refunded, feedback };
    };
    return { publicClient, account, buyer, session, usdc, waitFor, logs, reference: () => reference,
      block: () => publicClient.getBlockNumber({ cacheTime: 0 }) };
  }

  beforeAll(async () => {
    ctx = setup();
    expect(await ctx.publicClient.getChainId()).toBe(CHAIN_ID.fuji);
    const policy = await ctx.publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi,
      functionName: "buyerPolicy", args: [ctx.account.address] });
    if (policy.admin === "0x0000000000000000000000000000000000000000" || policy.maxPerSession >= 20_000_000n) {
      throw new Error("Register buyer-auto first (maxPerSession below 20 USDC, minScore > 0) so E2 can be rejected");
    }
    if (await ctx.usdc() < 3n * ONE_USDC) throw new Error("buyer-auto needs at least 3 Fuji test USDC");
  });

  it("E1: AVAX seller · 15 PASS → fault +20% → 3 FAIL → Verifier auto-close → Keeper finalize + feedback", async () => {
    const sellerUrl = need("SELLER_URL");
    const before = await ctx.usdc(), fromBlock = await ctx.block();
    const id = BigInt(await runPaidDemo({
      buyer: ctx.buyer(), sellerUrl, calls: 18, setFault: faultSwitch(sellerUrl, need("DEMO_FAULT_TOKEN")),
      referencePrice: ctx.reference, log: line => console.log(`[E1] ${line}`),
      waitForSettlement: async sessionId => ctx.waitFor(BigInt(sessionId), SessionState.SETTLED, 300),
    }));
    const s = await ctx.session(id);
    expect([s.passCount, s.failCount, s.inconclusiveCount]).toEqual([15, 3, 0]);
    const { settled, feedback } = await ctx.logs(id, fromBlock);
    expect(settled).toHaveLength(1);
    const passed = 15n * PRICE_PER_REQUEST;
    const { toSeller, toBuyer, fee } = settled[0]!.args;
    expect(toSeller).toBe(passed - (passed * BigInt(s.feeBps)) / 10_000n);
    expect(toSeller + toBuyer + fee).toBe(ONE_USDC);
    expect(before - (await ctx.usdc())).toBe(toSeller + fee);
    expect(feedback.some(entry => entry.args.ok && entry.args.tag2 === "session")).toBe(true);
    console.log(`[E1] session ${id} · seller +${toSeller} · refund ${toBuyer} · fee ${fee} · ${snowtrace(settled[0]!.transactionHash)}`);
  }, 15 * 60_000);

  it("E2: prompt injection · 20 USDC → OverPerSession; low-score seller → BadScore; nothing opened", async () => {
    const before = await ctx.usdc(), lines: string[] = [];
    await runInjection({
      buyer: ctx.buyer({ fetch: verifyOnlyTransport(need("FACILITATOR_URL")), maxPerSession: 20_000_000n }),
      sellerUrl: need("SELLER_URL"), lowScoreSellerUrl: need("LOW_SCORE_SELLER_URL"),
      log: line => { lines.push(line); console.log(`[E2] ${line}`); },
    });
    expect(lines.join("\n")).toMatch(/OverPerSession[\s\S]*BadScore/);
    expect(await ctx.usdc()).toBe(before);
  }, 5 * 60_000);

  it("E9: open then leave before the first request → closeEmpty refunds 100%, no fee, no feedback", async () => {
    const before = await ctx.usdc(), fromBlock = await ctx.block(), buyer = ctx.buyer();
    const id = BigInt(await buyer.openSession(need("SELLER_URL"), { cap: LIMITS.MIN_CAP, expirySec: 3600 }));
    // close() waits up to the Verifier SLA (60 s) and reconciles with the chain on timeout.
    await buyer.close(id.toString());
    await ctx.waitFor(id, SessionState.REFUNDED, 180);
    const { refunded, feedback } = await ctx.logs(id, fromBlock);
    expect(refunded.map(entry => [entry.args.reason, entry.args.amount])).toEqual([[1, LIMITS.MIN_CAP]]);
    expect(feedback).toHaveLength(0);
    expect(await ctx.usdc()).toBe(before);
    console.log(`[E9] session ${id} refunded · ${snowtrace(refunded[0]!.transactionHash)}`);
  }, 10 * 60_000);

  it("E4: buyer abandons an open session → cap comes back without anyone acting (Verifier sweep or Keeper refund)", async () => {
    const before = await ctx.usdc(), fromBlock = await ctx.block(), expirySec = 300;
    const id = BigInt(await ctx.buyer().openSession(need("SELLER_URL"), { cap: LIMITS.MIN_CAP, expirySec }));
    // Verifier closes empty sessions ~2 min before expiry; if it is down, Keeper refunds after expiry + 10 min grace.
    await ctx.waitFor(id, SessionState.REFUNDED, expirySec + 10 * 60 + 180);
    const { refunded, feedback } = await ctx.logs(id, fromBlock);
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.args.amount).toBe(LIMITS.MIN_CAP);
    expect(feedback).toHaveLength(0);
    expect(await ctx.usdc()).toBe(before);
    const path = refunded[0]!.args.reason === 0 ? "Keeper refund after expiry" : "Verifier expiry sweep (closeEmpty)";
    console.log(`[E4] session ${id} refunded by ${path} · ${snowtrace(refunded[0]!.transactionHash)}`);
  }, 25 * 60_000);
});
