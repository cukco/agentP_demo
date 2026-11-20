import { randomBytes } from "node:crypto";
import {
  FLAGS, LIMITS, ROUTES, SessionState, agentPaySessionEscrowAbi, fromWire, openNonce, sessionId, signCancelAuthorization,
  signReceiveAuthorization, specHash, toWire, verifyScoreAttestation, type AttestationResponse, type FacilitatorRequest,
  type OpenParams, type PaymentRequired, type ScoreAttestation, type SettleResponse,
} from "@agentpay/core";
import { isAddressEqual, parseAbi, parseSignature, toHex, type Address, type Hex } from "viem";
import { requestApproval, BuyerApprovalError } from "./approve/server.js";
import type { BuyerCommonOptions, BuyerModeOptions, BuyerOptions } from "./buyer.js";
import { endpoint, json } from "./http.js";
import { escrowViews } from "./precheck.js";
import type { BuyerSession, BuyerStore } from "./store.js";

const cancellationAbi = parseAbi(["function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"]);
const SESSION_READ_BUDGET_MS = 12_000;
const SESSION_READ_RETRY_MS = 500;
/** Scorer recomputes history before signing; 5 s was too tight once a seller had dozens of sessions on Fuji. */
const ATTESTATION_TIMEOUT_MS = 10_000;

export class BuyerSessionPolicyError extends Error {
  constructor(readonly code: "OverPerSession" | "BadScore") {
    super(code);
    this.name = "BuyerSessionPolicyError";
  }
}

export async function readSession(deps: BuyerCommonOptions, escrow: Address, id: string) {
  return deps.publicClient.readContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [BigInt(id)],
  });
}

function waitForSettledSession(deps: BuyerCommonOptions, escrow: Address, id: string) {
  return new Promise<Awaited<ReturnType<typeof readSession>> | undefined>(resolve => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      clearTimeout(retry);
      resolve(undefined);
    }, SESSION_READ_BUDGET_MS);

    async function poll() {
      const session = await readSession(deps, escrow, id).catch(() => undefined);
      if (expired) return;
      if (session && session.state !== SessionState.NONE) {
        clearTimeout(deadline);
        resolve(session);
        return;
      }
      retry = setTimeout(() => { void poll(); }, SESSION_READ_RETRY_MS);
    }

    void poll();
  });
}

async function cancel(deps: BuyerOptions, asset: Address, nonce: Hex) {
  const message = { authorizer: deps.account.address, nonce };
  const { v, r, s } = await signCancelAuthorization(deps.account, deps.chainId, asset, message);
  const hash = await deps.walletClient.writeContract({
    address: asset, abi: cancellationAbi, functionName: "cancelAuthorization", chain: deps.walletClient.chain,
    account: deps.account, args: [message.authorizer, nonce, v, r, s],
  });
  const receipt = await deps.publicClient.waitForTransactionReceipt({ hash, timeout: 20_000 });
  if (receipt.status !== "success") throw new Error("Cancellation reverted");
}

export async function open(deps: BuyerModeOptions, store: BuyerStore, payment: PaymentRequired, fees: Map<string, bigint>,
  voucherSigner: Address): Promise<{ session: BuyerSession; expiry: bigint }> {
  const { session: terms, verificationSpec: spec } = payment.extensions.agentpay;
  const escrow = terms.contract;
  const fee = () => deps.publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "sessionFee" });
  const key = escrow.toLowerCase();
  const observed = await fee();
  const expectedFee = deps.expectedSessionFee ?? fees.get(key) ?? observed;
  fees.set(key, expectedFee);
  if (observed !== expectedFee) throw new Error("Session fee changed");
  const offer = payment.accepts[0]!;
  if (deps.defaultCap < expectedFee + BigInt(terms.pricePerRequest)) throw new Error("Cap cannot cover the fee and one request");

  const [asset, scorer, signed] = await Promise.all([
    deps.publicClient.readContract({ address: escrow, abi: escrowViews, functionName: "usdc" }),
    deps.publicClient.readContract({ address: escrow, abi: escrowViews, functionName: "scorerSigner" }),
    json<AttestationResponse>(deps, endpoint(deps.scorerUrl, ROUTES.scorer.attestation(terms.sellerAgentId)) + "?wallet=" + terms.seller, ATTESTATION_TIMEOUT_MS),
  ]);
  if (!isAddressEqual(asset, offer.asset)) throw new Error("Payment asset differs from escrow USDC");
  const attestation = fromWire<ScoreAttestation>("ScoreAttestation", signed.attestation.message);
  const now = BigInt(deps.clock());
  if (attestation.agentId !== BigInt(terms.sellerAgentId) || !isAddressEqual(attestation.wallet, terms.seller) ||
      attestation.validUntil <= now || attestation.validUntil > now + BigInt(LIMITS.MAX_ATTEST_TTL) ||
      (attestation.flags & FLAGS.FLAGGED) !== 0 ||
      !await verifyScoreAttestation(deps.chainId, escrow, { message: attestation, signature: signed.attestation.signature }, scorer)) {
    throw new Error("Invalid Scorer attestation");
  }

  const salt = toHex(randomBytes(32));
  const buyer = deps.mode === "auto" ? deps.account.address : deps.buyerAddress;
  const params: OpenParams = {
    seller: terms.seller, sellerAgentId: BigInt(terms.sellerAgentId), verifier: spec.verifier.address,
    voucherSigner, specHash: specHash(spec), cap: deps.defaultCap, pricePerRequest: BigInt(terms.pricePerRequest),
    expiry: now + BigInt(deps.defaultExpirySec), deliveryDeadlineSec: terms.deliveryDeadlineSec, challengeWindowSec: terms.challengeWindowSec,
  };
  const nonce = openNonce(params, salt);
  const id = sessionId(buyer, nonce).toString();
  const session: BuyerSession = { id, buyer, payment, status: "opening", requests: [] };

  if (await fee() !== expectedFee) throw new Error("Session fee changed");
  const auth = { from: buyer, to: escrow, value: params.cap, validAfter: 0n, validBefore: BigInt(deps.clock()) + 120n, nonce };
  let parts: { v: number; r: Hex; s: Hex };
  if (deps.mode === "approve") {
    const approval = await requestApproval({ kind: "open", buyer, escrow, chainId: deps.chainId, asset,
      params: toWire(params), spec, salt, nonce, domain: new URL(payment.resource.url).hostname,
      score: attestation.score, fee: expectedFee.toString(),
    }, deps);
    const parsed = parseSignature(approval.signature);
    parts = { v: 27 + parsed.yParity!, r: parsed.r, s: parsed.s };
    auth.validBefore = approval.deadline;
    if (await fee() !== expectedFee) throw new Error("Session fee changed during approval");
    const reviewedAt = BigInt(deps.clock());
    if (params.expiry <= reviewedAt || auth.validBefore <= reviewedAt || attestation.validUntil <= reviewedAt) {
      throw new BuyerApprovalError("APPROVAL_INVALID");
    }
  } else {
    parts = await signReceiveAuthorization(deps.account, deps.chainId, asset, auth);
  }
  session.authorizationExpiresAt = auth.validBefore.toString();
  await store.save(session);
  const payload: FacilitatorRequest = {
    x402Version: 2, paymentRequirements: offer,
    paymentPayload: { x402Version: 2, scheme: offer.scheme, network: offer.network,
      payload: { params: toWire(params), salt, authorization: toWire({ from: buyer, value: auth.value, validAfter: auth.validAfter,
        validBefore: auth.validBefore, nonce, v: parts.v, r: parts.r, s: parts.s }), attestation: signed.attestation } },
  };
  try {
    const result = await json<SettleResponse>(deps, endpoint(deps.facilitatorUrl, ROUTES.facilitator.settle()), 20_000, payload);
    if (!result.success && (result.errorReason === "OverPerSession" || result.errorReason === "BadScore")) {
      throw new BuyerSessionPolicyError(result.errorReason);
    }
    if (!result.success || result.sessionId !== id) throw new Error("Settler did not confirm the expected session");
  } catch (error) {
    const existing = await readSession(deps, escrow, id).catch(() => undefined);
    if (!existing || existing.state === SessionState.NONE) {
      if (deps.mode === "approve") {
        throw new Error(`Settle unconfirmed. Approval expires at ${auth.validBefore}: ${id}`);
      }
      try {
        await cancel(deps, asset, nonce);
      } catch {
        throw new Error("Settle failed and authorization cancellation could not be confirmed");
      }
      await store.save({ ...session, status: "stopped" });
      if (error instanceof BuyerSessionPolicyError) throw error;
      throw new Error("Settle failed and authorization was canceled");
    }
    // A lost settle response can race with mining. Keep the funded session for explicit closing.
    await store.save({ ...session, status: "stopped" });
    throw new Error(`Settle response failed for on-chain session ${id}`);
  }

  // Keep the funding acknowledgment across retries and restarts.
  session.settleConfirmed = true;
  await store.save(session);
  const onchain = await waitForSettledSession(deps, escrow, id);
  if (!onchain) throw new Error(`Session settlement is awaiting RPC confirmation: ${id}`);
  if (onchain.state !== SessionState.OPEN || onchain.sessionFee !== expectedFee ||
      (deps.mode === "approve" && !isAddressEqual(onchain.voucherSigner, voucherSigner))) {
    await store.save({ ...session, status: "stopped" });
    throw new Error(`Session is no longer open or its fee changed during settlement: ${id}`);
  }
  session.status = "open";
  await store.save(session);
  return { session, expiry: params.expiry };
}
