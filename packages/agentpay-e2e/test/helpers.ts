import { beforeAll, afterAll } from "vitest";
import { parseAbi } from "viem";
import { startStack, type Stack } from "../src/harness.js";
export function fixture() {
  let stack: Stack;
  beforeAll(async () => { stack = await startStack(); });
  afterAll(async () => { await stack?.stop(); });
  return () => stack;
}
export const policy = { maxPerSession: 1000000n, dailyCap: 10000000n, minScore: 0, paused: false, sellerAllowlistOn: false };
export const feedbackCount = (s: Stack) => s.chain.publicClient.readContract({ address: s.reputation,
  abi: parseAbi(["function count() view returns (uint256)"]), functionName: "count" });
