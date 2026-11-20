import type { Address } from "viem";

export interface SettledSession {
  id: string;
  buyer: Address;
  seller: Address;
  passedAmount: bigint;
  value: number;
}

export function realScore(sessions: SettledSession[], wallets: Address[]) {
  const excluded = new Set(wallets.map(w => w.toLowerCase()));
  const buyers = new Map<string, { weighted: number; weight: number }>();
  const seen = new Set<string>();
  let count = 0;
  for (const s of sessions) {
    if (seen.has(s.id) || s.passedAmount < 100000n || excluded.has(s.buyer.toLowerCase()) ||
      s.buyer.toLowerCase() === s.seller.toLowerCase() || !Number.isFinite(s.value)) continue;
    seen.add(s.id);
    const weight = Math.min(10, Math.log1p(Number(s.passedAmount) / 100000));
    const buyer = buyers.get(s.buyer.toLowerCase()) ?? { weight: 0, weighted: 0 };
    buyer.weight += weight;
    buyer.weighted += Math.min(100, Math.max(0, s.value)) * weight;
    buyers.set(s.buyer.toLowerCase(), buyer); count++;
  }
  const distinctBuyers = buyers.size;
  return { sessions: count, distinctBuyers, score: distinctBuyers ?
    [...buyers.values()].reduce((sum, b) => sum + b.weighted / b.weight, 0) / distinctBuyers : null };
}
