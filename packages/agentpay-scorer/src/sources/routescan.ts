import { cacheHistory, type UsdcHistory } from "./history.js";

export const MAINNET_USDC = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e";

/** Pages are all-or-nothing: never inflate a score using an incomplete or malformed response. */
export function createRoutescan(fetcher: typeof fetch, clock: () => number) {
  return cacheHistory(async (wallet): Promise<UsdcHistory | null> => {
    try {
      let totalUnits = 0n, transactions = 0;
      let firstReceivedAt: number | undefined;
      const senders = new Set<string>(), seen = new Set<string>();
      for (let page = 1; page <= 10; page++) {
        const url = new URL("https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api");
        for (const [key, value] of Object.entries({ module: "account", action: "tokentx", contractaddress: MAINNET_USDC,
          address: wallet, sort: "asc", page: String(page), offset: "1000" })) url.searchParams.set(key, value);
        const response = await fetcher(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return null;
        const data = await response.json() as { status: string; message?: string; result?: Record<string, string>[] };
        if (data.status === "0" && data.message === "No transactions found" && Array.isArray(data.result) && !data.result.length) {
          return { transactions, totalUnits, senders, firstReceivedAt };
        }
        if (data.status !== "1" || !Array.isArray(data.result)) return null;
        for (const tx of data.result) {
          if (tx.contractAddress?.toLowerCase() !== MAINNET_USDC || tx.to?.toLowerCase() !== wallet ||
            tx.from?.toLowerCase() === wallet || tx.tokenDecimal !== "6" || tx.isError === "1") continue;
          if (!/^0x[\da-f]{40}$/i.test(tx.from) || !/^\d+$/.test(tx.value) || !/^\d+$/.test(tx.timeStamp) ||
            !/^0x[\da-f]{64}$/i.test(tx.hash)) return null;
          const sender = tx.from.toLowerCase();
          const hash = tx.hash.toLowerCase();
          const key = tx.logIndex
            ? `${hash}:log:${tx.logIndex}`
            : `${hash}:tx:${tx.transactionIndex ?? ""}:${sender}:${tx.value}`;
          const value = BigInt(tx.value), time = Number(tx.timeStamp);
          if (seen.has(key) || value === 0n || !Number.isSafeInteger(time) || time > clock()) continue;
          seen.add(key);
          transactions++;
          totalUnits += value;
          firstReceivedAt = Math.min(firstReceivedAt ?? time, time);
          senders.add(sender);
        }
        if (data.result.length < 1000) return { transactions, totalUnits, senders, firstReceivedAt };
      }
      return null; // Pagination limit: report unavailable instead of a misleading partial history.
    } catch { return null; }
  }, clock);
}
