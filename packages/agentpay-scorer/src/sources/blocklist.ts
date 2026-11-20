import { readFileSync } from "node:fs";
import { isAddress, type Address } from "viem";

const snapshot = JSON.parse(readFileSync(new URL("../../data/blocklist.json", import.meta.url), "utf8")) as
  { addresses: { address: string }[] };

export function createBlocklist(extra: Address[] = []) {
  const addresses = new Set([...snapshot.addresses.map(item => item.address), ...extra].map(a => {
    if (!isAddress(a, { strict: false })) throw new Error("Invalid blocklist address");
    return a.toLowerCase();
  }));
  return (wallet: Address) => addresses.has(wallet.toLowerCase());
}
