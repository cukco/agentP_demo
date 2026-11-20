import { parsePaymentRequired, validateSpec } from "@agentpay/core";
import type { Address } from "viem";

/** Endpoints are operator-configured, never taken from an unauthenticated HTTP request. */
export async function probe(endpoint: string, wallet: Address, agentId: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(endpoint, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (response.status !== 402) return false;
    if (Number(response.headers.get("content-length") ?? 0) > 32768) return false;
    const reader = response.body?.getReader();
    if (!reader) return false;
    let bytes = 0, text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 32768) { await reader.cancel(); return false; }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    const required = parsePaymentRequired(text + decoder.decode());
    const ext = required.extensions.agentpay;
    return ext.session.seller.toLowerCase() === wallet.toLowerCase() &&
      BigInt(ext.session.sellerAgentId).toString() === agentId && validateSpec(ext.verificationSpec).ok;
  } catch { return false; }
}
