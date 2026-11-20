import type { History } from "../sources/history.js";

export function referenceScore(history: History | null, probe: boolean): number {
  const safe = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;
  return Math.min(40, (history ? 10 * Math.log10(1 + safe(history.transactions)) +
    10 * Math.log10(1 + safe(history.totalUsd) / 100) + Math.min(10, safe(history.ageMonths)) : 0) + (probe ? 5 : 0));
}
