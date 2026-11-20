import { expect, it, vi } from "vitest";
import { createChain } from "../src/chain.js";
it("indexes once, replaces the reorg tail and never commits a failed scan", async () => {
  const address = "0x0000000000000000000000000000000000000001";
  let head = 5000n,
    fail = false;
  const getLogs = vi.fn(async () => {
    if (fail) throw new Error("RPC offline");
    return [];
  });
  const client = {
    getBlockNumber: async () => head,
    getLogs,
    readContract: async () => [0n, 0n, 0],
  };
  const chain = createChain(client as never, {
    escrow: address,
    identity: address,
    reputation: address,
    startBlock: 0n,
    chainId: 43113,
  });
  await chain.history(1n);
  expect(getLogs).toHaveBeenCalledTimes(6);
  getLogs.mockClear();
  head = 5010n;
  await chain.history(1n);
  expect(getLogs).toHaveBeenCalledTimes(2);
  expect(getLogs.mock.calls[0][0]).toMatchObject({
    fromBlock: 4936n,
    toBlock: 5010n,
  });
  fail = true;
  head = 9000n;
  await expect(chain.history(1n)).rejects.toThrow("RPC offline");
  fail = false;
  getLogs.mockClear();
  await chain.history(1n);
  expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 4946n });
  head = 4000n;
  getLogs.mockClear();
  await chain.history(1n);
  expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 0n });
});

it("reads finished sessions once and keeps re-reading sessions that are still open", async () => {
  const address = "0x0000000000000000000000000000000000000001";
  const buyer = "0x0000000000000000000000000000000000000002";
  const ids = [11n, 12n, 13n];
  const state = new Map<bigint, number>([[11n, 4], [12n, 5], [13n, 1]]);
  const opened = ids.map((sessionId, i) => ({ blockNumber: BigInt(i + 1), args: { sessionId, sellerAgentId: 7n } }));
  const feedback = ids.map((sessionId, i) => ({ blockNumber: BigInt(i + 10), args: { sessionId, agentId: 7n, value: 90n, ok: true } }));
  const getSession = vi.fn();
  const client = {
    getBlockNumber: async () => 100n,
    getLogs: async ({ event, fromBlock, toBlock }: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) =>
      (event.name === "SessionOpened" ? opened : feedback).filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    readContract: async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
      if (functionName === "getSummary") return [3n, 270n, 0];
      getSession(args[0]);
      return { state: state.get(args[0]), buyer, seller: address, passedAmount: 150000n };
    },
  };
  const chain = createChain(client as never, { escrow: address, identity: address, reputation: address, startBlock: 0n, chainId: 43113 });
  expect((await chain.history(7n)).sessions.map(s => s.id)).toEqual(["11", "12"]);
  expect(getSession).toHaveBeenCalledTimes(3);
  getSession.mockClear();
  state.set(13n, 4);
  expect((await chain.history(7n)).sessions.map(s => s.id)).toEqual(["11", "12", "13"]);
  expect(getSession.mock.calls).toEqual([[13n]]);
});
