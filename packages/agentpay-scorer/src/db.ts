import { DatabaseSync } from "node:sqlite";
import type { Address } from "viem";

export interface Seller {
  agentId: string;
  payTo: Address;
  endpoints: string[];
  mainnetWallets: Address[];
  /** v1 requires authorization from the current registered payment wallet. */
  proofVersion?: 1;
  lastProbe: { at: number; ok: boolean } | null;
}

export function openDatabase(path = ":memory:") {
  const sql = new DatabaseSync(path);
  sql.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sellers (agent_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS score_inputs (agent_id TEXT, source TEXT, value TEXT NOT NULL,
      observed_at INTEGER NOT NULL, PRIMARY KEY(agent_id, source));
    CREATE TABLE IF NOT EXISTS attestations (id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL,
      score INTEGER NOT NULL, flags INTEGER NOT NULL, valid_until INTEGER NOT NULL, sig TEXT NOT NULL);
  `);
  return {
    close: () => sql.close(),
    seller(agentId: string): Seller | undefined {
      const row = sql.prepare("SELECT value FROM sellers WHERE agent_id=?").get(agentId);
      return row ? JSON.parse(row.value as string) : undefined;
    },
    sellers(): Seller[] {
      return sql.prepare("SELECT value FROM sellers").all().map(row => JSON.parse(row.value as string));
    },
    saveSeller(seller: Seller) {
      sql.prepare("INSERT INTO sellers VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET value=excluded.value")
        .run(seller.agentId, JSON.stringify(seller));
    },
    input(agentId: string, source: string, value: unknown, at: number) {
      sql.prepare(`INSERT INTO score_inputs VALUES (?, ?, ?, ?) ON CONFLICT(agent_id,source)
        DO UPDATE SET value=excluded.value, observed_at=excluded.observed_at`)
        .run(agentId, source, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v), at);
    },
    attestation(id: string, score: number, flags: number, until: number, signature: string) {
      sql.prepare("INSERT INTO attestations (agent_id,score,flags,valid_until,sig) VALUES (?,?,?,?,?)")
        .run(id, score, flags, until, signature);
      sql.prepare("DELETE FROM attestations WHERE valid_until < ?").run(until - 3000 - 86400);
    },
  };
}
export type ScorerDatabase = ReturnType<typeof openDatabase>;
