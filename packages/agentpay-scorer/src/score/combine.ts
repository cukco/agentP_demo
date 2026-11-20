/**
 * Prior weight of the reference score, in "virtual buyers" (AgentPay_ThietKe A2 allows k = 5–10).
 * k = 5 (2026-11-19, was 8): a seller with no outside history but 3 good buyers reaches the default
 * minScore 30 (D25) instead of needing 4. Sybil cost changes by one wallet (3 vs 4 fake buyers).
 */
export const REFERENCE_PRIOR = 5;

export function combine(reference: number, real: number | null, distinctBuyers: number) {
  const cold = real === null || distinctBuyers === 0;
  return { score: Math.round(cold ? reference : (REFERENCE_PRIOR * reference + distinctBuyers * real) / (REFERENCE_PRIOR + distinctBuyers)),
    flags: cold ? 1 : 0 };
}
