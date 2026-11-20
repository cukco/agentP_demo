import { isAddress } from "viem";
import { cacheHistory, type UsdcHistory } from "./history.js";

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

interface AssetTransfer {
  uniqueId: string;
  category: string;
  from: string;
  to: string | null;
  rawContract: { address: string | null; value: string | null; decimal: string | null };
  metadata: { blockTimestamp: string };
}

export function createAlchemyBase(url: string, fetcher: typeof fetch, clock: () => number) {
  return cacheHistory(async (wallet): Promise<UsdcHistory | null> => {
    try {
      const signal = AbortSignal.timeout(10_000);
      const senders = new Set<string>(), seen = new Set<string>(), cursors = new Set<string>();
      let totalUnits = 0n;
      let firstReceivedAt: number | undefined;
      let pageKey: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = await fetcher(url, {
          method: "POST", redirect: "error", signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{
            fromBlock: "0x0", toAddress: wallet, category: ["erc20"], contractAddresses: [BASE_USDC],
            withMetadata: true, excludeZeroValue: true, pageKey,
          }] }),
        });
        if (!response.ok) return null;
        const { result, error } = await response.json() as {
          result?: { transfers: AssetTransfer[]; pageKey?: string }; error?: unknown;
        };
        if (error || !Array.isArray(result?.transfers)) return null;
        for (const tx of result.transfers) {
          if (tx.category !== "erc20" || tx.rawContract?.address?.toLowerCase() !== BASE_USDC.toLowerCase() ||
              tx.to?.toLowerCase() !== wallet) continue;
          if (typeof tx.from !== "string" || !isAddress(tx.from, { strict: false })) return null;
          const sender = tx.from.toLowerCase();
          if (sender === wallet) continue;
          const { value, decimal } = tx.rawContract;
          if (!value || !/^0x[\da-f]+$/i.test(value) ||
              (decimal != null && (!/^0x[\da-f]+$/i.test(decimal) || BigInt(decimal) !== 6n))) return null;
          const units = BigInt(value);
          if (!units) continue;
          if (typeof tx.uniqueId !== "string" || !tx.uniqueId) return null;
          const event = tx.uniqueId.toLowerCase();
          if (seen.has(event)) continue;
          const time = Date.parse(tx.metadata?.blockTimestamp) / 1000;
          if (!Number.isFinite(time)) return null;
          if (time < 0 || time > clock()) continue;
          seen.add(event);
          senders.add(sender);
          totalUnits += units;
          firstReceivedAt = Math.min(firstReceivedAt ?? time, time);
        }
        pageKey = result.pageKey;
        if (pageKey === undefined || pageKey === "") {
          return { transactions: seen.size, totalUnits, senders, firstReceivedAt };
        }
        if (typeof pageKey !== "string" || cursors.has(pageKey)) return null;
        cursors.add(pageKey);
      }
      return null;
    } catch {
      // Fetch and JSON errors may include the credential-bearing URL.
      return null;
    }
  }, clock);
}
