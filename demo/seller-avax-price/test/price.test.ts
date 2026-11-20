import { CHAINLINK_AVAX_USD_MAINNET, Outcome, ReasonCode, VERIFIER_LIMITS } from "@agentpay/core";
import type { PublicClient } from "viem";
import { expect, it, vi } from "vitest";
import { checkPrice, createPriceReader, quotePrice } from "../src/price.js";

const now = 1_800_000_000;
const quote = { answer: 2_500_000_000n, decimals: 8, updatedAt: BigInt(now) };

it("reads the Avalanche mainnet Chainlink feed and applies a 20% fault to the returned quote", async () => {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    return functionName === "decimals" ? 8 : [42n, quote.answer, 0n, quote.updatedAt, 42n];
  });
  const read = createPriceReader({ readContract } as unknown as Pick<PublicClient, "readContract">);
  const sample = await read();
  expect(quotePrice(sample, now)).toBe(25);
  expect(quotePrice(sample, now, true)).toBe(30);
  await read();
  expect(readContract.mock.calls).toHaveLength(3);
  for (const [call] of readContract.mock.calls) expect(call).toMatchObject({ address: CHAINLINK_AVAX_USD_MAINNET });
});

it("fails the 20% quote with ORACLE_DEVIATION and distinguishes a stale oracle", async () => {
  const packet = (price: number) => ({
    contentType: "application/json; charset=utf-8", receivedAt: BigInt(now),
    body: Buffer.from(JSON.stringify({ symbol: "AVAX", price, timestamp: now })),
  });
  expect(await checkPrice(packet(25), async () => quote, () => now)).toMatchObject({ outcome: Outcome.PASS, reference: 25 });
  expect(await checkPrice(packet(30), async () => quote, () => now)).toMatchObject({
    outcome: Outcome.FAIL, reasonCode: ReasonCode.CHECK_ORACLE_DEVIATION,
  });
  const stale = { ...quote, updatedAt: BigInt(now - VERIFIER_LIMITS.DEFAULT_MAX_ORACLE_AGE_SEC - 1) };
  expect(() => quotePrice(stale, now)).toThrow("Chainlink quote unavailable");
  expect(await checkPrice(packet(25), async () => stale, () => now)).toMatchObject({
    outcome: Outcome.INCONCLUSIVE, reasonCode: ReasonCode.ORACLE_UNAVAILABLE,
  });
});
