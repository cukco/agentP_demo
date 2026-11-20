import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Delivery, PaymentRequired, Receipt, Voucher, WireSigned } from "@agentpay/core";
import type { Address } from "viem";
import { writePrivateJson } from "./files.js";

export interface BuyerRequestRecord {
  voucher: WireSigned<Voucher>;
  receipt?: WireSigned<Receipt>;
  delivery?: WireSigned<Delivery>;
  bodyBase64?: string;
  localOutcome?: number;
}

export interface BuyerSession {
  id: string;
  buyer: Address;
  payment: PaymentRequired;
  status: "open" | "opening" | "closing" | "stopped";
  authorizationExpiresAt?: string;
  /** Facilitator confirmed this ID, even if the RPC has yet to see the session. */
  settleConfirmed?: true;
  requests: BuyerRequestRecord[];
  challenge?: "RECHECK_MISMATCH";
}

export interface BuyerStore {
  get(id: string): Promise<BuyerSession | undefined>;
  list(): Promise<BuyerSession[]>;
  save(session: BuyerSession): Promise<void>;
}

export function createMemoryBuyerStore(): BuyerStore {
  const sessions = new Map<string, BuyerSession>();
  return {
    async get(id) { return structuredClone(sessions.get(id)); },
    async list() { return structuredClone([...sessions.values()]); },
    async save(session) { sessions.set(session.id, structuredClone(session)); },
  };
}

export function createFileBuyerStore(directory = join(homedir(), ".agentpay", "sessions")): BuyerStore {
  function path(id: string) {
    if (!/^\d{1,78}$/.test(id)) throw new Error("Invalid session ID");
    return join(directory, `${id}.json`);
  }
  async function get(id: string): Promise<BuyerSession | undefined> {
    try {
      return JSON.parse(await readFile(path(id), "utf8")) as BuyerSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    get,
    async list() {
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const sessions = await Promise.all(files.filter(name => /^\d{1,78}\.json$/.test(name)).map(name => get(name.slice(0, -5))));
      return sessions.filter(session => session !== undefined);
    },
    async save(session) {
      await writePrivateJson(path(session.id), session);
    },
  };
}
