import { expect, it } from "vitest";
import { isTighter, money, parseMoney, countdown } from "../src/model.js";
const policy = { maxPerSession: 1000000n, dailyCap: 5000000n, minScore: 50, paused: false, sellerAllowlistOn: false };
it.each([
  ["equal", {}, true], ["lower cap", { maxPerSession: 500000n }, true], ["raise cap", { maxPerSession: 2000000n }, false],
  ["lower daily", { dailyCap: 4000000n }, true], ["raise daily", { dailyCap: 6000000n }, false],
  ["higher score", { minScore: 60 }, true], ["lower score", { minScore: 40 }, false],
  ["pause", { paused: true }, true], ["allowlist", { sellerAllowlistOn: true }, true],
  ["mixed", { maxPerSession: 500000n, dailyCap: 6000000n }, false],
])("matches contract _isTighter: %s", (_name, change, expected) => {
  expect(isTighter(policy, { ...policy, ...change as object })).toBe(expected);
});
it("unpause or disable allowlist requires delay", () => {
  expect(isTighter({ ...policy, paused: true }, policy)).toBe(false);
  expect(isTighter({ ...policy, sellerAllowlistOn: true }, policy)).toBe(false);
});
it("formats money without floating-point loss and rejects excess decimals", () => {
  expect(money(1230000n)).toBe("$1.23"); expect(money(999999n)).toBe("$1.00");
  expect(parseMoney("0.000001")).toBe(1n);
  expect(() => parseMoney("0.0000001")).toThrow(); expect(() => parseMoney("1e3")).toThrow();
});
it("counts down and stops at zero", () => {
  expect(countdown(3661n, 0)).toBe("1h 1m 1s"); expect(countdown(10n, 11)).toBe("Có thể áp dụng");
});
