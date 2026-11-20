import {
  CHAIN_ID,
  HEADERS,
  Outcome,
  ReasonCode,
  SessionState,
  VERIFIER_LIMITS,
  ZERO_HASH,
  bodyHash,
  decodeHeaderJson,
  encodeHeader,
  fromWire,
  parsePaymentRequired,
  receiptsRoot,
  requestHash,
  specHash,
  toWire,
  verifyCloseRequest,
  verifyDelivery,
  verifyVoucher,
  type CloseRequest,
  type CloseSessionResponse,
  type Delivery,
  type RelayRequest,
  type RelayResponse,
  type SessionVerdict,
  type Signed,
  type VerificationSpec,
  type Voucher,
} from "@agentpay/core";
import type { Address, Hex } from "viem";
import type { ChainAdapter, ChainSession } from "./chain.js";
import type { VerifierDatabase } from "./db.js";
import type { createSigner } from "./signer.js";
import type { createCheckRunner } from "./checks/runner.js";
import type { CheckResult } from "./checks/types.js";
import type { ChainWriter } from "./writer.js";
import { HttpError } from "./errors.js";
import { BodyTooLarge, readBounded, validateTarget } from "./network.js";
import { deliverySchema } from "./validation.js";
export interface RuntimeOptions {
  db: VerifierDatabase;
  chain: ChainAdapter;
  writer: ChainWriter;
  signer: ReturnType<typeof createSigner>;
  checks: ReturnType<typeof createCheckRunner>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  clock: () => number;
  escrow: Address;
  chainId?: number;
  allowPrivate?: boolean;
  log?: (entry: Record<string, unknown>) => void;
}
export function createRuntime(o: RuntimeOptions) {
  const { db, chain, writer, signer, clock } = o,
    chainId = o.chainId ?? CHAIN_ID.fuji;
  const inflight = new Map<bigint, AbortController>();
  const locks = new Map<string, Promise<unknown>>(),
    rates = new Map<string, { second: number; count: number }>();
  function serial<T>(id: bigint, fn: () => Promise<T>): Promise<T> {
    const key = id.toString(),
      prior = locks.get(key) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    locks.set(key, next);
    void next
      .finally(() => {
        if (locks.get(key) === next) locks.delete(key);
      })
      .catch(() => {});
    return next;
  }
  function limit(id: bigint) {
    const second = clock(),
      key = id.toString();
    for (const [key, entry] of rates)
      if (entry.second < second) rates.delete(key);
    const entry = rates.get(key) ?? { second, count: 0 };
    entry.count++;
    rates.set(key, entry);
    if (entry.count > VERIFIER_LIMITS.MAX_REQ_PER_SEC_PER_SESSION)
      throw new HttpError(
        "RATE_LIMITED",
        "Session request limit exceeded",
        429,
      );
  }
  async function session(id: bigint): Promise<ChainSession> {
    const value = await chain.getSession(id);
    if (!value)
      throw new HttpError("SESSION_NOT_FOUND", "Unknown session", 404);
    db.saveSession(id, value, clock());
    return value;
  }
  async function verdict(
    id: bigint,
    s: ChainSession,
    kind: "checkpoint" | "final",
  ): Promise<Signed<SessionVerdict>> {
    const row = db.session(id)!,
      old = db.verdict(id, kind);
    if (old?.message.lastSeq === Number(row.last_seq)) return old;
    const signed = await signer.signVerdict({
      sessionId: id,
      specHash: s.specHash,
      lastSeq: Number(row.last_seq),
      passCount: Number(row.pass),
      failCount: Number(row.fail),
      inconclusiveCount: Number(row.inconclusive),
      passedAmount: BigInt(row.passed_amount as string),
      receiptsRoot: receiptsRoot(db.receipts(id).map((r) => r.message)),
      closedAt: BigInt(clock()),
    });
    db.saveVerdict(signed, kind, clock());
    return signed;
  }
  async function checkpoint(id: bigint, s: ChainSession) {
    const n = Number(db.session(id)!.last_seq);
    return n > 0 && n % VERIFIER_LIMITS.CHECKPOINT_EVERY === 0
      ? verdict(id, s, "checkpoint")
      : undefined;
  }
  // A request may have reached the seller before the process died. Never send it again
  // or pretend that an uncommitted check passed; retain its voucher and mark uncertainty.
  async function recover(id: bigint, s: ChainSession) {
    const seq = Number(db.session(id)!.last_seq) + 1,
      row = db.request(id, seq),
      voucher = db.voucher(id, seq);
    if (row && voucher)
      db.complete(
        await signer.signReceipt({
          sessionId: id,
          seq,
          requestHash: voucher.message.requestHash,
          bodyHash: ZERO_HASH,
          outcome: Outcome.INCONCLUSIVE,
          reasonCode: ReasonCode.VERIFIER_ERROR,
          amount: 0n,
          receivedAt: BigInt(row.voucher_received_at as number),
          evidenceHash: ZERO_HASH,
        }),
      );
    await checkpoint(id, s);
  }
  async function close(
    id: bigint,
    s: ChainSession,
  ): Promise<CloseSessionResponse> {
    db.markClosing(id);
    const row = db.session(id)!,
      kind = Number(row.last_seq) ? "closeSession" : "closeEmpty";
    if (row.close_tx)
      return { sessionId: id.toString(), kind, txHash: row.close_tx as Hex };
    const pendingHash = db.runtime(id)?.pending_tx as Hex | undefined;
    if (
      s.state !== SessionState.OPEN &&
      pendingHash &&
      (await writer.confirm(pendingHash))
    ) {
      db.closeTx(id, pendingHash);
      db.pendingTx(id, null);
      return { sessionId: id.toString(), kind, txHash: pendingHash };
    }
    if (s.state !== SessionState.OPEN)
      throw new HttpError("SESSION_NOT_OPEN", "Session already closed", 409);
    const signed = await verdict(id, s, "final"),
      voucher = db.voucher(id, signed.message.lastSeq);
    for (let attempt = 0; attempt < 3; attempt++) {
      let hash = db.runtime(id)?.pending_tx as Hex | undefined;
      try {
        if (!hash) {
          hash = await writer.close(id, signed, voucher);
          db.pendingTx(id, hash);
        }
        if (!(await writer.confirm(hash))) {
          db.pendingTx(id, null);
          continue;
        }
        db.closeTx(id, hash);
        db.pendingTx(id, null);
        await session(id);
        return { sessionId: id.toString(), kind, txHash: hash };
      } catch {
        if (hash) break;
      }
    }
    throw new HttpError("CHAIN_ERROR", "Close is queued for retry", 503);
  }
  async function prove(id: bigint, seq: number) {
    const deliveries = db.deliveries(id, seq);
    if (deliveries.length < 2) return;
    let hash = db.runtime(id)?.equivocation_tx as Hex | undefined;
    if (!hash) {
      hash = await writer.prove(id, deliveries[0], deliveries[1]);
      db.equivocationTx(id, hash);
    }
    if (!(await writer.confirm(hash))) {
      db.equivocationTx(id, null);
      throw new Error("Equivocation transaction reverted");
    }
    await session(id);
  }
  async function discover(
    id: bigint,
    s: ChainSession,
    url: string,
    observe: (ms: number) => void,
  ): Promise<VerificationSpec> {
    const saved = db.spec(id) as VerificationSpec | undefined;
    if (saved) return saved;
    try {
      const discoveryStarted = performance.now();
      const response = await o.fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      const bytes = await readBounded(response, 32768);
      observe(performance.now() - discoveryStarted);
      if (response.status !== 402) throw new Error("No payment terms");
      const payment = parsePaymentRequired(
        JSON.parse(Buffer.from(bytes).toString("utf8")),
      );
      const { verificationSpec: spec, session: terms } =
        payment.extensions.agentpay;
      if (
        specHash(spec) !== s.specHash ||
        spec.verifier.address.toLowerCase() !== signer.address.toLowerCase() ||
        terms.contract.toLowerCase() !== o.escrow.toLowerCase() ||
        terms.chainId !== chainId ||
        terms.seller.toLowerCase() !== s.seller.toLowerCase() ||
        BigInt(terms.sellerAgentId) !== s.sellerAgentId ||
        BigInt(terms.pricePerRequest) !== s.pricePerRequest ||
        terms.deliveryDeadlineSec !== s.deliveryDeadlineSec ||
        terms.challengeWindowSec !== s.challengeWindowSec
      )
        throw new Error("Payment terms mismatch");
      db.saveSpec(id, spec);
      return spec;
    } catch {
      throw new HttpError(
        "SPEC_REJECTED",
        "Seller spec is invalid or does not match session",
      );
    }
  }
  function autoClose(id: bigint, s: ChainSession): boolean {
    const row = db.session(id)!;
    return (
      Number(row.fail_streak) >= 3 ||
      BigInt(Number(row.last_seq) + 1) * s.pricePerRequest >
        s.cap - s.sessionFee ||
      clock() >= Number(s.expiry)
    );
  }
  async function relay(
    id: bigint,
    input: RelayRequest,
  ): Promise<RelayResponse> {
    limit(id);
    let controller: AbortController | undefined;
    return serial(id, async () => {
      const start = performance.now();
      let sellerMs = 0,
        discoveryMs = 0;
      const s = await session(id);
      if (s.state !== SessionState.OPEN || db.runtime(id)?.closing)
        throw new HttpError(
          "SESSION_NOT_OPEN",
          "Session is closing or closed",
          409,
        );
      if (BigInt(clock()) >= s.expiry)
        throw new HttpError("SESSION_EXPIRED", "Session expired", 409);
      if (db.openCount(s.buyer) > 20)
        throw new HttpError(
          "TOO_MANY_SESSIONS",
          "Buyer has more than 20 open sessions",
          429,
        );
      await recover(id, s);
      const voucher = {
        message: fromWire<Voucher>("Voucher", input.voucher.message),
        signature: input.voucher.signature,
      };
      if (
        voucher.message.sessionId !== id ||
        !(await verifyVoucher(chainId, o.escrow, voucher, s.voucherSigner))
      )
        throw new HttpError("BAD_VOUCHER_SIG", "Invalid voucher signer", 401);
      const { seq, cumulativeAmount } = voucher.message;
      if (seq !== Number(db.session(id)!.last_seq) + 1)
        throw new HttpError("BAD_SEQ", "Expected next sequence");
      if (cumulativeAmount !== BigInt(seq) * s.pricePerRequest)
        throw new HttpError(
          "BAD_CUMULATIVE",
          "Cumulative amount must equal sequence times price",
        );
      if (cumulativeAmount > s.cap - s.sessionFee)
        throw new HttpError("OVER_USABLE", "Voucher exceeds usable cap");
      const body = Buffer.from(input.request.bodyBase64 ?? "", "base64");
      if (
        body.length > VERIFIER_LIMITS.MAX_BODY_BYTES ||
        (["GET", "HEAD"].includes(input.request.method) && body.length)
      )
        throw new HttpError("BAD_REQUEST", "Invalid request body");
      if (
        requestHash(input.request.method, input.request.url, body) !==
        voucher.message.requestHash.toLowerCase()
      )
        throw new HttpError(
          "BAD_REQUEST_HASH",
          "Request differs from signed voucher",
        );
      try {
        validateTarget(input.request.url, o.allowPrivate);
      } catch {
        throw new HttpError("BAD_REQUEST", "Seller URL is not allowed");
      }
      const spec = await discover(id, s, input.request.url, (ms) => {
        discoveryMs = ms;
        sellerMs += ms;
      });
      // All buyer-controlled header syntax is checked before consuming the sequence.
      let headers: Headers;
      try {
        headers = new Headers(input.request.headers);
      } catch {
        throw new HttpError("BAD_REQUEST", "Invalid request headers");
      }
      const connectionHeaders = (headers.get("connection") ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      for (const key of [
        ...connectionHeaders,
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "keep-alive",
        "upgrade",
        "trailer",
        "te",
        "proxy-authorization",
        "proxy-authenticate",
        "expect",
      ])
        headers.delete(key);
      if (BigInt(clock()) >= s.expiry)
        throw new HttpError(
          "SESSION_EXPIRED",
          "Session expired during discovery",
          409,
        );
      const voucherAt = clock();
      db.saveVoucher(voucher, voucherAt);
      controller = new AbortController();
      inflight.set(id, controller);
      headers.set(HEADERS.PAYMENT_SIGNATURE, encodeHeader(voucher));
      headers.set(HEADERS.SESSION_ID, id.toString());
      headers.set(
        HEADERS.VOUCHER_RECEIVED_AT,
        new Date(voucherAt * 1000).toISOString(),
      );
      const deadline = performance.now() + s.deliveryDeadlineSec * 1000;
      let bytes: Uint8Array | undefined,
        delivery: Signed<Delivery> | undefined,
        contentType: string | undefined,
        receivedAt = BigInt(voucherAt);
      let checked: CheckResult = {
        outcome: Outcome.FAIL,
        reasonCode: ReasonCode.LATE,
        evidenceHash: ZERO_HASH,
      };
      const sellerStart = performance.now();
      for (
        let attempt = 0;
        attempt < 2 &&
        performance.now() < deadline &&
        !controller.signal.aborted;
        attempt++
      ) {
        let response: Response | undefined;
        const timeout = AbortSignal.timeout(
          Math.max(1, Math.ceil(deadline - performance.now())),
        );
        try {
          response = await o.fetch(input.request.url, {
            method: input.request.method,
            headers,
            body: body.length ? body : undefined,
            signal: AbortSignal.any([controller.signal, timeout]),
          });
          const raw = response.headers.get(HEADERS.DELIVERY);
          let signed: Signed<Delivery> | undefined;
          if (raw && raw.length < 4096) {
            const parsed = deliverySchema.parse(decodeHeaderJson(raw));
            signed = {
              message: fromWire<Delivery>("Delivery", parsed.message),
              signature: parsed.signature as Hex,
            };
          }
          if (
            signed &&
            signed.message.sessionId === id &&
            signed.message.seq === seq &&
            signed.message.requestHash.toLowerCase() ===
              voucher.message.requestHash.toLowerCase() &&
            signed.message.specHash.toLowerCase() ===
              s.specHash.toLowerCase() &&
            (await verifyDelivery(chainId, o.escrow, signed, s.seller))
          )
            db.saveDelivery(signed, clock());
          else {
            await response.body?.cancel();
            continue;
          }
          const rawBody = await readBounded(
            response,
            Math.min(spec.delivery.maxBytes, VERIFIER_LIMITS.MAX_BODY_BYTES),
          );
          if (
            performance.now() > deadline ||
            bodyHash(rawBody) !== signed.message.bodyHash.toLowerCase()
          )
            continue;
          bytes = rawBody;
          delivery = signed;
          contentType = response.headers.get("content-type") ?? "";
          receivedAt = BigInt(clock());
          break;
        } catch (error) {
          // The delivery deadline passed. Timers can fire a millisecond before performance.now() reaches the
          // deadline, so never treat that as a second attempt.
          if (timeout.aborted) break;
          if (error instanceof BodyTooLarge) {
            checked = {
              outcome: Outcome.FAIL,
              reasonCode: ReasonCode.TOO_LARGE,
              evidenceHash: ZERO_HASH,
            };
            break;
          }
        } finally {
          await response?.body?.cancel().catch(() => {});
        }
      }
      sellerMs += performance.now() - sellerStart;
      if (controller.signal.aborted)
        checked = {
          outcome: Outcome.INCONCLUSIVE,
          reasonCode: ReasonCode.VERIFIER_ERROR,
          evidenceHash: ZERO_HASH,
        };
      if (bytes && delivery) {
        db.saveBody(
          id,
          seq,
          bytes,
          bodyHash(bytes),
          contentType!,
          Number(receivedAt),
        );
        try {
          checked = await o.checks({
            spec,
            body: bytes,
            contentType: contentType!,
            receivedAt,
          });
        } catch {
          checked = {
            outcome: Outcome.INCONCLUSIVE,
            reasonCode: ReasonCode.VERIFIER_ERROR,
            evidenceHash: ZERO_HASH,
          };
        }
      }
      const receipt = await signer.signReceipt({
        sessionId: id,
        seq,
        requestHash: voucher.message.requestHash,
        bodyHash: bytes ? bodyHash(bytes) : ZERO_HASH,
        outcome: checked.outcome,
        reasonCode: checked.reasonCode,
        amount: checked.outcome === Outcome.PASS ? s.pricePerRequest : 0n,
        receivedAt,
        evidenceHash: checked.evidenceHash,
      });
      db.complete(receipt, checked.oracle);
      const point = await checkpoint(id, s);
      let closing = autoClose(id, s);
      if (db.deliveries(id, seq).length > 1) {
        closing = true;
        db.markClosing(id);
        try {
          await prove(id, seq);
        } catch {
          o.log?.({ event: "equivocation_retry", sessionId: id.toString() });
        }
      } else if (closing) {
        db.markClosing(id);
        void serial(id, () => close(id, s)).catch(() =>
          o.log?.({ event: "close_retry", sessionId: id.toString() }),
        );
      }
      o.log?.({
        event: "relay",
        sessionId: id.toString(),
        seq,
        outcome: checked.outcome,
        reasonCode: checked.reasonCode,
        sellerMs,
        discoveryMs,
        verifierMs: performance.now() - start - sellerMs,
        totalMs: performance.now() - start,
      });
      return {
        sessionId: id.toString(),
        seq,
        receipt: toWire(receipt),
        closing,
        ...(bytes && delivery
          ? {
              bodyBase64: Buffer.from(bytes).toString("base64"),
              contentType,
              delivery: toWire(delivery),
            }
          : {}),
        ...(point ? { checkpoint: toWire(point) } : {}),
      };
    }).finally(() => {
      if (controller && inflight.get(id) === controller) inflight.delete(id);
    });
  }
  async function requestClose(id: bigint, signed: Signed<CloseRequest>) {
    const s = await session(id);
    if (
      signed.message.sessionId !== id ||
      !(
        (await verifyCloseRequest(chainId, o.escrow, signed, s.buyer)) ||
        (await verifyCloseRequest(chainId, o.escrow, signed, s.voucherSigner))
      )
    )
      throw new HttpError("BAD_CLOSE_SIG", "Invalid close signer", 401);
    if (signed.message.deadline < BigInt(clock()))
      throw new HttpError("CLOSE_REQUEST_EXPIRED", "Close request expired");
    inflight.get(id)?.abort();
    db.markClosing(id);
    const work = serial(id, async () => {
      const current = await session(id);
      await recover(id, current);
      return close(id, current);
    });
    return new Promise<CloseSessionResponse>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new HttpError("CHAIN_ERROR", "Close remains queued for retry", 503),
          ),
        55_000,
      );
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  let ticking: Promise<void> | undefined;
  function tick(): Promise<void> {
    return (ticking ??= (async () => {
      await Promise.allSettled(
        db.activeSessions().map((id) =>
          serial(id, async () => {
            const s = await session(id);
            if (s.state !== SessionState.OPEN && db.runtime(id)?.pending_tx) {
              await close(id, s);
              return;
            }
            if (
              s.state !== SessionState.OPEN &&
              s.state !== SessionState.CLOSING
            )
              return;
            if (s.state === SessionState.OPEN) {
              if (BigInt(clock()) > s.expiry)
                o.log?.({
                  event: "expiry_close_overdue",
                  level: "WARN",
                  sessionId: id.toString(),
                });
              await recover(id, s);
            }
            // Reattempt durable evidence after restart/network failure before considering settlement.
            for (const r of db.receipts(id))
              if (db.deliveries(id, r.message.seq).length > 1) {
                await prove(id, r.message.seq);
                return;
              }
            if (
              s.state === SessionState.OPEN &&
              (db.runtime(id)?.closing ||
                autoClose(id, s) ||
                Number(s.expiry) - clock() <= 120)
            )
              await close(id, s);
          }),
        ),
      );
    })().finally(() => {
      ticking = undefined;
    }));
  }
  return { relay, requestClose, tick };
}
export type VerifierRuntime = ReturnType<typeof createRuntime>;
