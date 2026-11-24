import type { Address, Hash } from "viem";
import type { ChainEvent } from "./client.js";

export type SessionState = "OPEN" | "CLOSING" | "CHALLENGED" | "SETTLED" | "REFUNDED";
export interface SessionRow {
  id: string; buyer: Address; seller: Address; agentId: string; cap: bigint; price: bigint;
  openedAt: number; openHash: Hash; updatedAt: number; state: SessionState;
  pass: number; fail: number; inconclusive: number; toSeller: bigint; toBuyer: bigint; fee: bigint;
}
export interface Totals {
  sessions: number; open: number; buyers: number; requests: number; pass: number; fail: number; inconclusive: number;
  toSeller: bigint; toBuyer: bigint; transactions: number;
}

const big = (v: unknown) => BigInt(String(v ?? 0));

/** Rebuild every session from Escrow events (oldest first in, newest first out). */
export function sessionsFrom(events: ChainEvent[]): SessionRow[] {
  const rows = new Map<string, SessionRow>();
  const ordered = events.slice().sort((a, b) => a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1);
  for (const e of ordered) {
    const id = e.args.sessionId === undefined ? undefined : String(e.args.sessionId);
    if (!id) continue;
    if (e.name === "SessionOpened") {
      rows.set(id, { id, buyer: e.args.buyer as Address, seller: e.args.seller as Address, agentId: String(e.args.sellerAgentId),
        cap: big(e.args.cap), price: big(e.args.pricePerRequest), openedAt: e.time, openHash: e.hash, updatedAt: e.time,
        state: "OPEN", pass: 0, fail: 0, inconclusive: 0, toSeller: 0n, toBuyer: 0n, fee: 0n });
      continue;
    }
    const row = rows.get(id);
    if (!row) continue;
    row.updatedAt = e.time;
    if (e.name === "SessionClosed" || e.name === "Resolved") {
      row.pass = Number(e.args.passCount); row.fail = Number(e.args.failCount);
      if (e.args.inconclusiveCount !== undefined) row.inconclusive = Number(e.args.inconclusiveCount);
      if (row.state === "OPEN" || row.state === "CHALLENGED") row.state = "CLOSING";
    } else if (e.name === "Challenged") row.state = "CHALLENGED";
    else if (e.name === "Settled") { row.state = "SETTLED"; row.toSeller = big(e.args.toSeller); row.toBuyer = big(e.args.toBuyer); row.fee = big(e.args.fee); }
    else if (e.name === "Refunded") { row.state = "REFUNDED"; row.toBuyer = big(e.args.amount); }
  }
  return [...rows.values()].sort((a, b) => b.openedAt - a.openedAt);
}

export function totalsFrom(rows: SessionRow[], events: ChainEvent[]): Totals {
  const t: Totals = { sessions: rows.length, open: 0, buyers: new Set(rows.map(r => r.buyer.toLowerCase())).size, requests: 0,
    pass: 0, fail: 0, inconclusive: 0, toSeller: 0n, toBuyer: 0n, transactions: new Set(events.map(e => e.hash)).size };
  for (const r of rows) {
    if (r.state === "OPEN") t.open++;
    t.pass += r.pass; t.fail += r.fail; t.inconclusive += r.inconclusive; t.toSeller += r.toSeller; t.toBuyer += r.toBuyer;
  }
  t.requests = t.pass + t.fail + t.inconclusive;
  return t;
}

/** PASS / FAIL request counts per local day for the last `days` days (oldest first). */
export function daily(rows: SessionRow[], now: number, days = 14) {
  const start = new Date(now * 1000); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
  const out = Array.from({ length: days }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    return { day: d, pass: 0, fail: 0 };
  });
  for (const r of rows) {
    const i = Math.floor((r.openedAt * 1000 - start.getTime()) / 86400000);
    if (i >= 0 && i < days) { out[i]!.pass += r.pass; out[i]!.fail += r.fail + r.inconclusive; }
  }
  return out;
}

export const EVENT_LABEL: Record<string, string> = {
  SessionOpened: "Mở phiên", SessionClosed: "Đóng phiên", Settled: "Chốt tiền", Refunded: "Hoàn tiền",
  FeedbackGiven: "Ghi uy tín", BuyerSpend: "Trừ hạn mức", BuyerRegistered: "Đặt luật", PolicyTightened: "Siết luật",
  LoosenProposed: "Đề xuất nới", LoosenApplied: "Nới luật", LoosenCancelled: "Hủy nới", BuyerPaused: "Dừng người mua",
  Challenged: "Khiếu nại", Resolved: "Phân xử", ChallengeExpired: "Hết hạn khiếu nại", EquivocationProven: "Bắt gian lận",
  AdminProposed: "Đề xuất admin", AdminChanged: "Đổi admin", AdminCancelled: "Hủy đổi admin",
  SellerAllowedProposed: "Đề xuất bên bán", SellerAllowedSet: "Danh sách bên bán", SellerAllowedCancelled: "Hủy bên bán",
};
export const STATE_LABEL: Record<SessionState, string> = {
  OPEN: "Đang mở", CLOSING: "Chờ chốt", CHALLENGED: "Khiếu nại", SETTLED: "Đã chốt", REFUNDED: "Hoàn tiền",
};

export function ago(time: number, now: number) {
  const s = Math.max(0, Math.floor(now - time));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}
