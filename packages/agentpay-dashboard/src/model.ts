import type { PolicyParams } from "@agentpay/core";

export function isTighter(old: PolicyParams, next: PolicyParams) {
  return next.maxPerSession <= old.maxPerSession && next.dailyCap <= old.dailyCap && next.minScore >= old.minScore &&
    (next.paused || !old.paused) && (next.sellerAllowlistOn || !old.sellerAllowlistOn);
}
export function money(amount: bigint | string) {
  const value = BigInt(amount), sign = value < 0n ? "−" : "", abs = value < 0n ? -value : value;
  const cents = (abs + 5000n) / 10000n;
  return `${sign}$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
}
export function parseMoney(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error("Nhập số USDC không âm, tối đa 6 chữ số thập phân.");
  const [whole, decimal = ""] = value.split(".");
  const amount = BigInt(whole) * 1000000n + BigInt(decimal.padEnd(6, "0"));
  if (amount >= 2n ** 128n) throw new Error("Số tiền quá lớn.");
  return amount;
}
export function countdown(at: bigint, now: number) {
  const seconds = Math.max(0, Number(at) - Math.floor(now));
  if (!seconds) return "Có thể áp dụng";
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}
export const short = (value: string) => value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
