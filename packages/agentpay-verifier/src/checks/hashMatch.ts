import { bodyHash } from "@agentpay/core";
import type { Hex } from "viem";
export function hashMatch(body: Uint8Array, expected: Hex): boolean {
  return bodyHash(body).toLowerCase() === expected.toLowerCase();
}
