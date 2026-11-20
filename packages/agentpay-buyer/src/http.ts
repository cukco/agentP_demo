import type { BuyerCommonOptions } from "./buyer.js";

export class HttpTimeoutError extends Error {
  constructor(reason: DOMException) {
    super(reason.message, { cause: reason });
    this.name = "TimeoutError";
  }
}

export function endpoint(base: string, path: string): string {
  const url = new URL(base);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid service endpoint");
  }
  const root = url.pathname.replace(/\/+$/, "");
  url.pathname = (path.startsWith("/v1/") ? root.replace(/\/v1$/, "") : root) + path;
  return url.toString();
}

export async function json<T>(deps: BuyerCommonOptions, url: string, timeoutMs: number, body?: unknown): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const request = (async () => {
    const response = await (deps.fetch ?? fetch)(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal, redirect: "error",
    });
    if (!response.ok) throw new Error(`Service returned HTTP ${response.status}`);
    return await response.json() as T;
  })();
  // Also enforce the deadline for injected transports that do not observe AbortSignal.
  let abort!: () => void;
  const timeout = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (signal.aborted && error === signal.reason) throw new HttpTimeoutError(signal.reason);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
