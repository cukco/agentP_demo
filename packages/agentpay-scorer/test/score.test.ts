import { describe, expect, it } from "vitest";
import { referenceScore } from "../src/score/reference.js";
import { realScore, type SettledSession } from "../src/score/real.js";
import { combine } from "../src/score/combine.js";
import { privateKeyToAccount } from "viem/accounts";

const address = (n: number) => privateKeyToAccount(`0x${String(n).padStart(64, "0")}`).address;
const session = (id: number, buyer: number, value = 100, amount = 100000n): SettledSession =>
  ({ id: String(id), buyer: address(buyer), seller: address(9), value, passedAmount: amount });

describe("reference and real scores", () => {
  it("caps reference at 40 even for a very large wallet (V14)", () => {
    expect(referenceScore({ transactions: 1e12, totalUsd: 1e20, senders: 1e6, ageMonths: 1000 }, true)).toBe(40);
    expect(referenceScore(null, false)).toBe(0);
    expect(referenceScore(null, true)).toBe(5);
  });
  it("counts 50 sessions from one buyer as one vote (V13)", () => {
    const many = Array.from({ length: 50 }, (_, i) => session(i, 1));
    const result = realScore([...many, session(99, 2, 0)], []);
    expect(result).toMatchObject({ sessions: 51, distinctBuyers: 2 });
    expect(result.score).toBeCloseTo(50);
    expect(combine(40, result.score, result.distinctBuyers)).toEqual({ score: 43, flags: 0 });
  });
  it("excludes dust, seller, proven wallets and duplicate events", () => {
    const valid = session(1, 1);
    expect(realScore([valid, valid, session(2, 9), session(3, 3), session(4, 4, 100, 99999n)], [address(3)]))
      .toEqual({ score: 100, sessions: 1, distinctBuyers: 1 });
  });
  it("weights within a buyer while keeping equal weight across buyers", () => {
    const result = realScore([session(1, 1, 0), session(2, 1, 100, 10000000n), session(3, 2, 0)], []);
    expect(result.score).toBeGreaterThan(25);
    expect(result.score).toBeLessThan(50);
    expect(combine(5, null, 0)).toEqual({ score: 5, flags: 1 });
  });
});
