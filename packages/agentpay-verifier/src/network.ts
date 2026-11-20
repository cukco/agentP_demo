import { lookup } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function validateTarget(raw: string, allowPrivate = false): URL {
  const url = new URL(raw),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (!allowPrivate &&
      (host.toLowerCase() === "localhost" ||
        host.toLowerCase().endsWith(".localhost") ||
        (isIP(host) && !publicAddress(host))))
  ) {
    throw new Error("Seller URL is not allowed");
  }
  return url;
}
/** Validation and connection use the same DNS result, preventing DNS rebinding. No redirects. */
export function createSellerFetch(allowPrivate = false) {
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
          if (error) {
            callback(error, [], undefined);
            return;
          }
          if (
            !addresses.length ||
            (!allowPrivate &&
              addresses.some((item) => !publicAddress(item.address)))
          ) {
            callback(
              new Error("Seller DNS resolves to a non-public address"),
              [],
              undefined,
            );
            return;
          }
          const selected = options.family
            ? addresses.filter((item) => item.family === options.family)
            : addresses;
          if (!selected.length) {
            callback(new Error("No compatible seller address"), [], undefined);
            return;
          }
          if (options.all) callback(null, selected, undefined);
          else callback(null, selected[0].address, selected[0].family);
        });
      },
    },
  });
  return {
    async fetch(raw: string, init: RequestInit): Promise<Response> {
      validateTarget(raw, allowPrivate);
      return (await undiciFetch(raw, {
        ...init,
        dispatcher,
        redirect: "error",
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    },
    close: () => dispatcher.close(),
  };
}
export class BodyTooLarge extends Error {}
export async function readBounded(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new BodyTooLarge("Response exceeds byte limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
