import { DatabaseSync } from "node:sqlite";
import {
  Outcome,
  SessionState,
  fromWire,
  toWire,
  type Delivery,
  type Receipt,
  type SessionVerdict,
  type Signed,
  type Voucher,
} from "@agentpay/core";
import type { Hex } from "viem";
import type { ChainSession } from "./chain.js";
import type { createBodyCipher } from "./crypto.js";

function messageJson<T>(value: T): string {
  return JSON.stringify(toWire(value));
}

export function openDatabase(
  path: string,
  cipher: ReturnType<typeof createBodyCipher>,
) {
  const connection = new DatabaseSync(path);
  connection.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, buyer TEXT NOT NULL, voucher_signer TEXT NOT NULL,
      seller TEXT NOT NULL, seller_agent_id TEXT NOT NULL, verifier TEXT NOT NULL,
      spec_hash TEXT NOT NULL, spec_json TEXT, cap TEXT NOT NULL, price TEXT NOT NULL,
      session_fee TEXT NOT NULL, expiry TEXT NOT NULL, delivery_deadline INTEGER NOT NULL,
      challenge_window INTEGER NOT NULL, state INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
      pass INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0, inconclusive INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0, passed_amount TEXT NOT NULL DEFAULT '0',
      cumulative TEXT NOT NULL DEFAULT '0', close_tx TEXT, created_at INTEGER NOT NULL, terminal_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS requests (
      session_id TEXT NOT NULL REFERENCES sessions, seq INTEGER NOT NULL, request_hash TEXT NOT NULL,
      voucher_json TEXT NOT NULL, voucher_sig TEXT NOT NULL, voucher_received_at INTEGER NOT NULL,
      body_enc BLOB, body_hash TEXT, content_type TEXT, received_at INTEGER, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      session_id TEXT NOT NULL REFERENCES sessions, seq INTEGER NOT NULL, body_hash TEXT NOT NULL,
      delivery_json TEXT NOT NULL, sig TEXT NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq, body_hash)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      session_id TEXT NOT NULL REFERENCES sessions, seq INTEGER NOT NULL, outcome INTEGER NOT NULL,
      reason_code INTEGER NOT NULL, amount TEXT NOT NULL, received_at INTEGER NOT NULL,
      evidence_hash TEXT NOT NULL, oracle_json TEXT, receipt_json TEXT NOT NULL, sig TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS session_verdicts (
      session_id TEXT NOT NULL REFERENCES sessions, kind TEXT NOT NULL CHECK (kind IN ('checkpoint','final')),
      last_seq INTEGER NOT NULL, verdict_json TEXT NOT NULL, sig TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, kind, last_seq)
    );
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      session_id TEXT PRIMARY KEY REFERENCES sessions, closing INTEGER NOT NULL DEFAULT 0,
      pending_tx TEXT, equivocation_tx TEXT
    );
    CREATE TABLE IF NOT EXISTS chain_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), block TEXT NOT NULL);
  `);
  const db = {
    close: () => connection.close(),
    saveSession(id: bigint, session: ChainSession, now: number) {
      connection
        .prepare(
          `
        INSERT INTO sessions (session_id, buyer, voucher_signer, seller, seller_agent_id, verifier,
          spec_hash, cap, price, session_fee, expiry, delivery_deadline, challenge_window, state, created_at, terminal_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET state = excluded.state,
          terminal_at = CASE WHEN excluded.terminal_at IS NOT NULL
            THEN COALESCE(sessions.terminal_at, excluded.terminal_at) ELSE NULL END
      `,
        )
        .run(
          id.toString(),
          session.buyer,
          session.voucherSigner,
          session.seller,
          session.sellerAgentId.toString(),
          session.verifier,
          session.specHash,
          session.cap.toString(),
          session.pricePerRequest.toString(),
          session.sessionFee.toString(),
          session.expiry.toString(),
          session.deliveryDeadlineSec,
          session.challengeWindowSec,
          session.state,
          now,
          [SessionState.SETTLED, SessionState.REFUNDED].includes(session.state)
            ? now
            : null,
        );
    },
    session(id: bigint) {
      return connection
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(id.toString());
    },
    activeSessions(): bigint[] {
      return connection
        .prepare(
          "SELECT session_id FROM sessions WHERE state IN (1, 2, 3) OR session_id IN (SELECT session_id FROM runtime_sessions WHERE pending_tx IS NOT NULL)",
        )
        .all()
        .map((row) => BigInt(row.session_id as string));
    },
    saveVoucher(voucher: Signed<Voucher>, now: number) {
      const { sessionId, seq, requestHash } = voucher.message;
      connection
        .prepare(
          `INSERT INTO requests
        (session_id, seq, request_hash, voucher_json, voucher_sig, voucher_received_at) VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          sessionId.toString(),
          seq,
          requestHash,
          messageJson(voucher.message),
          voucher.signature,
          now,
        );
    },
    saveBody(
      id: bigint,
      seq: number,
      body: Uint8Array,
      hash: Hex,
      contentType: string,
      now: number,
    ) {
      connection
        .prepare(
          `UPDATE requests SET body_enc = ?, body_hash = ?, content_type = ?, received_at = ?
        WHERE session_id = ? AND seq = ?`,
        )
        .run(
          cipher.encryptBody(body),
          hash,
          contentType,
          now,
          id.toString(),
          seq,
        );
    },
    saveDelivery(delivery: Signed<Delivery>, now: number) {
      const { sessionId, seq, bodyHash } = delivery.message;
      connection
        .prepare("INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          sessionId.toString(),
          seq,
          bodyHash,
          messageJson(delivery.message),
          delivery.signature,
          now,
        );
    },
    saveReceipt(receipt: Signed<Receipt>, oracle?: unknown) {
      const {
        sessionId,
        seq,
        outcome,
        reasonCode,
        amount,
        receivedAt,
        evidenceHash,
      } = receipt.message;
      connection
        .prepare("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          sessionId.toString(),
          seq,
          outcome,
          reasonCode,
          amount.toString(),
          Number(receivedAt),
          evidenceHash,
          oracle === undefined ? null : messageJson(oracle),
          messageJson(receipt.message),
          receipt.signature,
        );
    },
    saveVerdict(
      verdict: Signed<SessionVerdict>,
      kind: "checkpoint" | "final",
      now: number,
      hash?: Hex,
    ) {
      const { sessionId, lastSeq } = verdict.message;
      connection
        .prepare("INSERT INTO session_verdicts VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          sessionId.toString(),
          kind,
          lastSeq,
          messageJson(verdict.message),
          verdict.signature,
          hash ?? null,
          now,
        );
    },
    request(id: bigint, seq: number) {
      return connection
        .prepare("SELECT * FROM requests WHERE session_id = ? AND seq = ?")
        .get(id.toString(), seq);
    },
    spec(id: bigint) {
      const row = db.session(id);
      return row?.spec_json ? JSON.parse(row.spec_json as string) : undefined;
    },
    saveSpec(id: bigint, spec: unknown) {
      connection
        .prepare("UPDATE sessions SET spec_json = ? WHERE session_id = ?")
        .run(messageJson(spec), id.toString());
    },
    receipts(id: bigint, from = 1): Signed<Receipt>[] {
      return connection
        .prepare(
          "SELECT receipt_json, sig FROM receipts WHERE session_id = ? AND seq >= ? ORDER BY seq",
        )
        .all(id.toString(), from)
        .map((row) => ({
          message: fromWire<Receipt>(
            "Receipt",
            JSON.parse(row.receipt_json as string),
          ),
          signature: row.sig as Hex,
        }));
    },
    voucher(id: bigint, seq: number): Signed<Voucher> | undefined {
      const row = db.request(id, seq);
      return row
        ? {
            message: fromWire<Voucher>(
              "Voucher",
              JSON.parse(row.voucher_json as string),
            ),
            signature: row.voucher_sig as Hex,
          }
        : undefined;
    },
    deliveries(id: bigint, seq: number): Signed<Delivery>[] {
      return connection
        .prepare(
          "SELECT delivery_json, sig FROM deliveries WHERE session_id = ? AND seq = ? ORDER BY seen_at",
        )
        .all(id.toString(), seq)
        .map((row) => ({
          message: fromWire<Delivery>(
            "Delivery",
            JSON.parse(row.delivery_json as string),
          ),
          signature: row.sig as Hex,
        }));
    },
    verdict(
      id: bigint,
      kind: "checkpoint" | "final",
    ): Signed<SessionVerdict> | undefined {
      const row = connection
        .prepare(
          "SELECT verdict_json, sig FROM session_verdicts WHERE session_id = ? AND kind = ? ORDER BY last_seq DESC LIMIT 1",
        )
        .get(id.toString(), kind);
      return row
        ? {
            message: fromWire<SessionVerdict>(
              "SessionVerdict",
              JSON.parse(row.verdict_json as string),
            ),
            signature: row.sig as Hex,
          }
        : undefined;
    },
    runtime(id: bigint) {
      return connection
        .prepare("SELECT * FROM runtime_sessions WHERE session_id = ?")
        .get(id.toString());
    },
    markClosing(id: bigint) {
      connection
        .prepare(
          "INSERT INTO runtime_sessions (session_id,closing) VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET closing = 1",
        )
        .run(id.toString());
    },
    pendingTx(id: bigint, hash: Hex | null) {
      connection
        .prepare(
          "INSERT INTO runtime_sessions (session_id,pending_tx) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET pending_tx = excluded.pending_tx",
        )
        .run(id.toString(), hash);
    },
    closeTx(id: bigint, hash: Hex) {
      connection
        .prepare("UPDATE sessions SET close_tx = ? WHERE session_id = ?")
        .run(hash, id.toString());
    },
    equivocationTx(id: bigint, hash: Hex | null) {
      connection
        .prepare(
          "INSERT INTO runtime_sessions (session_id,equivocation_tx) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET equivocation_tx = excluded.equivocation_tx",
        )
        .run(id.toString(), hash);
    },
    openCount(buyer: string): number {
      return Number(
        connection
          .prepare(
            "SELECT count(*) AS n FROM sessions WHERE lower(buyer) = lower(?) AND state = 1",
          )
          .get(buyer)?.n ?? 0,
      );
    },
    // Receipt and aggregates commit together. A crash cannot count a receipt twice.
    complete(receipt: Signed<Receipt>, oracle?: unknown) {
      connection.exec("BEGIN IMMEDIATE");
      try {
        const r = receipt.message,
          row = db.session(r.sessionId);
        if (!row || Number(row.last_seq) + 1 !== r.seq)
          throw new Error("Non-contiguous receipt");
        const voucher = db.voucher(r.sessionId, r.seq);
        if (!voucher) throw new Error("Missing voucher");
        db.saveReceipt(receipt, oracle);
        connection
          .prepare(
            `UPDATE sessions SET last_seq=?, pass=?, fail=?, inconclusive=?, fail_streak=?, passed_amount=?, cumulative=? WHERE session_id=?`,
          )
          .run(
            r.seq,
            Number(row.pass) + (r.outcome === Outcome.PASS ? 1 : 0),
            Number(row.fail) + (r.outcome === Outcome.FAIL ? 1 : 0),
            Number(row.inconclusive) +
              (r.outcome === Outcome.INCONCLUSIVE ? 1 : 0),
            r.outcome === Outcome.PASS
              ? 0
              : Number(row.fail_streak) + (r.outcome === Outcome.FAIL ? 1 : 0),
            (BigInt(row.passed_amount as string) + r.amount).toString(),
            voucher.message.cumulativeAmount.toString(),
            r.sessionId.toString(),
          );
        connection.exec("COMMIT");
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    },
    cursor(): bigint | undefined {
      const row = connection
        .prepare("SELECT block FROM chain_cursor WHERE id = 1")
        .get();
      return row ? BigInt(row.block as string) : undefined;
    },
    saveCursor(block: bigint) {
      connection
        .prepare(
          "INSERT INTO chain_cursor VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET block = excluded.block",
        )
        .run(block.toString());
    },
    purgeBodies(cutoff: number): number {
      return Number(
        connection
          .prepare(
            `UPDATE requests SET body_enc = NULL WHERE body_enc IS NOT NULL
        AND session_id IN (SELECT session_id FROM sessions WHERE state IN (4, 5) AND terminal_at < ?)`,
          )
          .run(cutoff).changes,
      );
    },
  };
  return db;
}

export type VerifierDatabase = ReturnType<typeof openDatabase>;
