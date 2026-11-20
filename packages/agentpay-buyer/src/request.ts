import {
  HEADERS, Outcome, ROUTES, VERIFIER_LIMITS, ZERO_HASH, bodyHash, fromWire, requestHash, signVoucher,
  specHash, toWire, verifyDelivery, verifyReceipt,
  type Delivery, type Receipt, type RelayRequest, type RelayResponse, type WireSigned,
} from "@agentpay/core";
import type { LocalAccount } from "viem";
import type { BuyerCommonOptions } from "./buyer.js";
import { endpoint, json } from "./http.js";
import type { BuyerSession, BuyerStore } from "./store.js";

export class BuyerReceiptError extends Error {
  constructor(readonly receipt: WireSigned<Receipt>) {
    super(`Request did not PASS (reason ${receipt.message.reasonCode})`);
    this.name = "BuyerReceiptError";
  }
}

export async function relay(deps: BuyerCommonOptions, store: BuyerStore, session: BuyerSession, request: Request,
  voucherSigner: () => LocalAccount | undefined): Promise<Response> {
  const { session: terms, verificationSpec: spec } = session.payment.extensions.agentpay;
  const id = BigInt(session.id);
  const bytes = new Uint8Array(await request.arrayBuffer());
  const seq = (session.requests.at(-1)?.voucher.message.seq ?? 0) + 1;
  const price = BigInt(terms.pricePerRequest);
  const digest = requestHash(request.method, request.url, bytes);
  const account = voucherSigner();
  if (!account) throw new Error("Voucher signer is no longer available");
  const signed = await signVoucher(account, deps.chainId, terms.contract, {
    sessionId: id, seq, cumulativeAmount: BigInt(seq) * price, requestHash: digest,
  });
  const record = { voucher: toWire(signed) };
  session.requests.push(record);
  // A crash after dispatch must not sign another Voucher with the same seq.
  await store.save(session);
  const headers = new Headers(request.headers);
  headers.delete(HEADERS.PAYMENT_SIGNATURE);
  const payload: RelayRequest = { voucher: record.voucher, request: {
    method: request.method, url: request.url, headers: Object.fromEntries(headers),
    ...(bytes.length && { bodyBase64: Buffer.from(bytes).toString("base64") }),
  } };
  const result = await json<RelayResponse>(deps, endpoint(spec.verifier.endpoint, ROUTES.verifier.relay(id)),
    (terms.deliveryDeadlineSec + VERIFIER_LIMITS.RECEIPT_GRACE_SEC) * 1000, payload);
  const receipt = fromWire<Receipt>("Receipt", result.receipt.message);
  if (result.sessionId !== session.id || result.seq !== seq || receipt.sessionId !== id || receipt.seq !== seq ||
      receipt.requestHash.toLowerCase() !== digest || ![Outcome.PASS, Outcome.FAIL, Outcome.INCONCLUSIVE].includes(receipt.outcome) ||
      receipt.amount !== (receipt.outcome === Outcome.PASS ? price : 0n) ||
      !await verifyReceipt(deps.chainId, terms.contract, { message: receipt, signature: result.receipt.signature }, spec.verifier.address)) {
    throw new Error("Invalid Receipt");
  }
  const index = session.requests.length - 1;
  const evidence = { ...record, receipt: result.receipt };
  session.requests[index] = evidence;
  if (result.bodyBase64 === undefined && !result.delivery && receipt.outcome !== Outcome.PASS && receipt.bodyHash === ZERO_HASH) {
    if (result.closing) session.status = "closing";
    await store.save(session);
    throw new BuyerReceiptError(result.receipt);
  }

  if (typeof result.bodyBase64 !== "string" || !result.delivery ||
      result.bodyBase64.length > 4 * Math.ceil(spec.delivery.maxBytes / 3)) throw new Error("Missing or oversized Delivery body");
  const body = Buffer.from(result.bodyBase64, "base64");
  const delivery = fromWire<Delivery>("Delivery", result.delivery.message);
  if (delivery.sessionId !== id || delivery.seq !== seq || delivery.requestHash.toLowerCase() !== digest ||
      delivery.specHash.toLowerCase() !== specHash(spec) ||
      !await verifyDelivery(deps.chainId, terms.contract, { message: delivery, signature: result.delivery.signature }, terms.seller)) {
    throw new Error("Invalid Delivery");
  }
  session.requests[index] = { ...evidence, delivery: result.delivery, bodyBase64: result.bodyBase64 };
  const hash = bodyHash(body);
  if (body.length > spec.delivery.maxBytes || delivery.bodyHash.toLowerCase() !== hash || receipt.bodyHash.toLowerCase() !== hash) {
    throw new Error("Response body hash mismatch");
  }
  const contentType = result.contentType ?? spec.delivery.contentType;
  const localOutcome = await deps.checks({ spec, body, contentType, receivedAt: receipt.receivedAt });
  session.requests[index]!.localOutcome = localOutcome;
  if (receipt.outcome === Outcome.PASS && localOutcome !== Outcome.PASS) {
    if (localOutcome === Outcome.FAIL) session.challenge = "RECHECK_MISMATCH";
    throw new Error("Buyer checks could not confirm the passing Receipt");
  }
  if (result.closing) session.status = "closing";
  await store.save(session);
  if (receipt.outcome !== Outcome.PASS) throw new BuyerReceiptError(result.receipt);
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}
