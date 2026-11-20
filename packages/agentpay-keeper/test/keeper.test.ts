import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { custom, http, type EIP1193RequestFn } from "viem";
import { LIMITS, SessionState } from "@agentpay/core";
import { createKeeper, dueAction, memoryStore, type KeeperStore } from "../src/keeper.js";
import { startChain, type TestChain } from "./helpers/chain.js";

let chain: TestChain;

beforeAll(async () => {
  chain = await startChain();
}, 120_000);

afterAll(async () => {
  await chain?.stop();
});

/** Wallet transport that counts eth_sendRawTransaction and can fail the first N of them. */
function countingTransport(rpc: string, failFirst = 0) {
  const base = http(rpc)({ chain: undefined, retryCount: 0 });
  const counter = { sent: 0, failed: 0 };
  const request: EIP1193RequestFn = async (args) => {
    if (args.method === "eth_sendRawTransaction") {
      if (counter.failed < failFirst) {
        counter.failed++;
        throw new Error("simulated RPC outage");
      }
      counter.sent++;
    }
    return base.request(args as never);
  };
  return { transport: custom({ request }), counter };
}

function keeperWith(store: KeeperStore, failFirst = 0) {
  const { transport, counter } = countingTransport(chain.rpc, failFirst);
  const keeper = createKeeper({
    publicClient: chain.publicClient,
    walletClient: chain.wallet("keeper", transport),
    escrow: chain.escrow,
    store,
    fromBlock: 0n,
    retryBaseMs: 10,
  });
  return { keeper, counter };
}

describe("dueAction (pure)", () => {
  const base = { expiry: 1_000n, challengeEnd: 2_000n, resolveDeadline: 3_000n };
  it("refund strictly after expiry + grace", () => {
    expect(dueAction({ ...base, state: SessionState.OPEN }, 1_000 + LIMITS.VERDICT_GRACE)).toBeUndefined();
    expect(dueAction({ ...base, state: SessionState.OPEN }, 1_001 + LIMITS.VERDICT_GRACE)).toBe("refund");
  });
  it("finalize strictly after challengeEnd", () => {
    expect(dueAction({ ...base, state: SessionState.CLOSING }, 2_000)).toBeUndefined();
    expect(dueAction({ ...base, state: SessionState.CLOSING }, 2_001)).toBe("finalize");
  });
  it("expireChallenge strictly after resolveDeadline", () => {
    expect(dueAction({ ...base, state: SessionState.CHALLENGED }, 3_000)).toBeUndefined();
    expect(dueAction({ ...base, state: SessionState.CHALLENGED }, 3_001)).toBe("expireChallenge");
  });
  it("never acts on final states", () => {
    expect(dueAction({ ...base, state: SessionState.SETTLED }, 1e9)).toBeUndefined();
    expect(dueAction({ ...base, state: SessionState.REFUNDED }, 1e9)).toBeUndefined();
  });
});

describe("keeper on anvil", () => {
  it("finalizes right after challengeEnd, not before", async () => {
    const { keeper } = keeperWith(memoryStore());
    const sid = await chain.open();
    await chain.close(sid, 10, 9, 1);
    expect(await keeper.runOnce()).toEqual([]);
    expect(await chain.state(sid)).toBe(SessionState.CLOSING);
    await chain.advance(61);
    const res = await keeper.runOnce();
    expect(res.map((r) => [r.action, r.sessionId])).toContainEqual(["finalize", sid]);
    expect(await chain.state(sid)).toBe(SessionState.SETTLED);
  }, 60_000);

  it("refunds right after expiry + grace", async () => {
    const { keeper } = keeperWith(memoryStore());
    const sid = await chain.open();
    await chain.advance(3_600 + LIMITS.VERDICT_GRACE - 5);
    await keeper.runOnce();
    expect(await chain.state(sid)).toBe(SessionState.OPEN);
    await chain.advance(10);
    await keeper.runOnce();
    expect(await chain.state(sid)).toBe(SessionState.REFUNDED);
  }, 60_000);

  it("expires a challenge after 24h", async () => {
    const { keeper } = keeperWith(memoryStore());
    const sid = await chain.open();
    await chain.close(sid, 10, 9, 1);
    await chain.challengeByBuyer(sid);
    await chain.advance(LIMITS.RESOLVE_TIMEOUT - 10);
    await keeper.runOnce();
    expect(await chain.state(sid)).toBe(SessionState.CHALLENGED);
    await chain.advance(20);
    await keeper.runOnce();
    expect(await chain.state(sid)).toBe(SessionState.REFUNDED);
  }, 60_000);

  it("sends one transaction when two ticks race on the same due session", async () => {
    const { keeper, counter } = keeperWith(memoryStore());
    const sid = await chain.open();
    await chain.close(sid, 5, 5, 0);
    await keeper.sync();
    await chain.advance(61);
    await Promise.all([keeper.tick(), keeper.tick()]);
    expect(await chain.state(sid)).toBe(SessionState.SETTLED);
    expect(counter.sent).toBe(1);
  }, 60_000);

  it("after a restart it catches sessions that became due (and opened) while it was down", async () => {
    const store = memoryStore();
    const first = keeperWith(store).keeper;
    const a = await chain.open();
    await chain.close(a, 3, 3, 0);
    await first.sync(); // knows `a`, then "crashes"
    const b = await chain.open(); // opened while keeper is down
    await chain.close(b, 4, 4, 0);
    await chain.advance(61);
    const second = keeperWith(store).keeper; // same persisted store
    await second.runOnce();
    expect(await chain.state(a)).toBe(SessionState.SETTLED);
    expect(await chain.state(b)).toBe(SessionState.SETTLED);
    expect(BigInt(store.data!.lastBlock)).toBeGreaterThan(0n);
  }, 60_000);

  it("retries a transient RPC failure and then succeeds", async () => {
    const { keeper, counter } = keeperWith(memoryStore(), 2);
    const sid = await chain.open();
    await chain.close(sid, 2, 2, 0);
    await chain.advance(61);
    const res = await keeper.runOnce();
    expect(counter.failed).toBe(2);
    expect(res.find((r) => r.sessionId === sid)?.txHash).toBeDefined();
    expect(await chain.state(sid)).toBe(SessionState.SETTLED);
  }, 60_000);

  it("does nothing when someone else already finalized", async () => {
    const { keeper, counter } = keeperWith(memoryStore());
    const sid = await chain.open();
    await chain.close(sid, 2, 2, 0);
    await keeper.sync();
    await chain.advance(61);
    // seller finalizes first
    const seller = chain.wallet("seller");
    const { agentPaySessionEscrowAbi } = await import("@agentpay/core");
    const h = await seller.writeContract({ address: chain.escrow, abi: agentPaySessionEscrowAbi, functionName: "finalize", args: [sid] });
    await chain.publicClient.waitForTransactionReceipt({ hash: h });
    const before = counter.sent;
    await keeper.tick();
    expect(counter.sent).toBe(before);
    expect(keeper.liveSessions()).not.toContain(sid);
  }, 60_000);
});
