import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckpointResponse, Receipt, Voucher, WireSigned } from "@agentpay/core";

export interface SellerSessionRecord {
  voucher: WireSigned<Voucher>;
  receipts: WireSigned<Receipt>[];
  checkpoint?: CheckpointResponse;
}

/** A store belongs to one seller on one chain and escrow. Share one SDK instance per store. */
export interface SellerStore {
  get(sessionId: bigint): Promise<SellerSessionRecord | undefined>;
  save(sessionId: bigint, record: SellerSessionRecord): Promise<void>;
  sessionIds(): Promise<bigint[]>;
}

export function createMemorySellerStore(): SellerStore {
  const sessions = new Map<bigint, SellerSessionRecord>();
  return {
    async get(id) {
      return structuredClone(sessions.get(id));
    },
    async save(id, record) {
      sessions.set(id, structuredClone(record));
    },
    async sessionIds() {
      return [...sessions.keys()];
    },
  };
}

export function createFileSellerStore(directory: string): SellerStore {
  const path = (id: bigint) => join(directory, `${id}.json`);
  async function ifPresent<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  return {
    async get(id) {
      return ifPresent(async () => JSON.parse(await readFile(path(id), "utf8")) as SellerSessionRecord);
    },
    async save(id, record) {
      await mkdir(directory, { recursive: true });
      const target = path(id);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async sessionIds() {
      const files = await ifPresent(() => readdir(directory));
      return (files ?? []).filter(name => /^\d+\.json$/.test(name)).map(name => BigInt(name.slice(0, -5)));
    },
  };
}
