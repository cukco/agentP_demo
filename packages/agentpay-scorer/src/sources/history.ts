import type { Address } from "viem";

export interface UsdcHistory {
  transactions: number;
  totalUnits: bigint;
  senders: ReadonlySet<string>;
  firstReceivedAt?: number;
}

export interface History {
  transactions: number;
  totalUsd: number;
  senders: number;
  ageMonths: number;
}

export function summarizeHistory(now: number, ...sources: (UsdcHistory | null)[]): History | null {
  if (sources.every(source => source === null)) return null;
  let transactions = 0, totalUnits = 0n, firstReceivedAt = now;
  const senders = new Set<string>();
  for (const source of sources) {
    if (source === null) continue;
    transactions += source.transactions;
    totalUnits += source.totalUnits;
    for (const sender of source.senders) senders.add(sender);
    firstReceivedAt = Math.min(firstReceivedAt, source.firstReceivedAt ?? now);
  }
  const totalUsd = Number(totalUnits) / 1e6;
  if (!Number.isFinite(totalUsd)) return null;
  return { transactions, totalUsd, senders: senders.size, ageMonths: (now - firstReceivedAt) / 2592000 };
}

export function cacheHistory(load: (wallet: string) => Promise<UsdcHistory | null>, clock: () => number) {
  const cache = new Map<string, { at: number; value: UsdcHistory | null }>();
  const pending = new Map<string, Promise<UsdcHistory | null>>();
  return async (address: Address) => {
    const wallet = address.toLowerCase();
    const now = clock();
    const hit = cache.get(wallet);
    if (hit && now >= hit.at && now - hit.at < (hit.value ? 3600 : 60)) return hit.value;
    const active = pending.get(wallet);
    if (active) return active;
    const task = load(wallet).then(value => {
      if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
      cache.set(wallet, { at: clock(), value }); return value;
    }).finally(() => pending.delete(wallet));
    pending.set(wallet, task);
    return task;
  };
}
