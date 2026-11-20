import {
  CHAIN_ID, LIMITS, NETWORK, SCHEME, TYPES, agentPaySessionEscrowAbi, fromWire,
  openNonce, sessionId, usdcDomain,
  type ApiErrorCode,
  type Authorization, type OpenParams, type ScoreAttestation, type SettleResponse,
} from "@agentpay/core";
import { Hono } from "hono";
import {
  encodeEventTopics, erc20Abi, isAddressEqual, parseAbi,
  recoverTypedDataAddress, serializeSignature, type Address, type Hex,
  type PublicClient, type WalletClient,
} from "viem";
import { z } from "zod";
import { contractRevertReason } from "./errors.js";

const address = z.custom<Address>(value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value));
const bytes = (length: number) => z.custom<Hex>(value =>
  typeof value === "string" && new RegExp(`^0x[0-9a-f]{${2 * length}}$`, "i").test(value));
const uint = (bits: number) => z.string().refine(value => /^\d{1,78}$/.test(value) && BigInt(value) < 2n ** BigInt(bits));
const uint32 = z.number().int().min(0).max(2 ** 32 - 1);
const payloadSchema = z.object({
  x402Version: z.literal(2),
  paymentPayload: z.object({
    x402Version: z.literal(2), scheme: z.string(), network: z.string(),
    payload: z.object({
      salt: bytes(32),
      params: z.object({
        seller: address, sellerAgentId: uint(256), verifier: address, voucherSigner: address,
        specHash: bytes(32), cap: uint(128), pricePerRequest: uint(128), expiry: uint(64),
        deliveryDeadlineSec: uint32, challengeWindowSec: uint32,
      }),
      authorization: z.object({
        from: address, value: uint(256), validAfter: uint(256), validBefore: uint(256),
        nonce: bytes(32), v: z.union([z.literal(27), z.literal(28)]), r: bytes(32), s: bytes(32),
      }),
      attestation: z.object({
        message: z.object({
          agentId: uint(256), wallet: address, score: z.number().int().min(0).max(65535),
          flags: z.number().int().min(0).max(65535), validUntil: uint(64),
        }),
        signature: bytes(65),
      }),
    }),
  }),
  paymentRequirements: z.object({
    scheme: z.string(), network: z.string(), asset: address, payTo: address, amount: uint(128),
    maxTimeoutSeconds: uint32, extra: z.record(z.unknown()),
  }),
});
const authorizationAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const [openedTopic] = encodeEventTopics({ abi: agentPaySessionEscrowAbi, eventName: "SessionOpened" });

interface Dependencies {
  publicClient: PublicClient;
  walletClient: WalletClient;
  escrow: Address;
  usdc: Address;
  clock: () => number;
}

/** Facilitator-side rejection; message is an ApiErrorCode. Contract reverts are reported by their error name. */
class PaymentError extends Error {
  constructor(code: ApiErrorCode) {
    super(code);
  }
}

export function createApp({ publicClient, walletClient, escrow, usdc, clock }: Dependencies) {
  const app = new Hono();
  const submitted = new Map<string, Hex>();
  const pending = new Map<string, Promise<SettleResponse>>();

  async function parse(request: Request) {
    const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new PaymentError("BAD_REQUEST");
    const { paymentPayload, paymentRequirements: terms } = parsed.data;
    if (paymentPayload.scheme !== SCHEME || terms.scheme !== SCHEME ||
        paymentPayload.network !== NETWORK.fuji || terms.network !== NETWORK.fuji) {
      throw new PaymentError("UNSUPPORTED_SCHEME");
    }
    const { params, salt, authorization, attestation } = paymentPayload.payload;
    const open = fromWire<OpenParams>("OpenParams", params);
    const auth = fromWire<Authorization>("Authorization", authorization);
    if (!isAddressEqual(terms.payTo, escrow) || !isAddressEqual(terms.asset, usdc) ||
        BigInt(terms.amount) !== open.pricePerRequest) throw new PaymentError("BAD_REQUEST");
    if (openNonce(open, salt) !== auth.nonce.toLowerCase()) throw new PaymentError("NONCE_MISMATCH");
    if (auth.value !== open.cap) throw new PaymentError("AUTH_VALUE_MISMATCH");
    const recovered = await recoverTypedDataAddress({
      domain: usdcDomain(CHAIN_ID.fuji, usdc), types: TYPES.ReceiveWithAuthorization,
      primaryType: "ReceiveWithAuthorization", message: { ...auth, to: escrow },
      signature: serializeSignature({ r: auth.r, s: auth.s, v: BigInt(auth.v) }),
    }).catch(() => null);
    if (!recovered || !isAddressEqual(recovered, auth.from)) throw new PaymentError("BAD_AUTH_SIG");
    const att = fromWire<ScoreAttestation>("ScoreAttestation", attestation.message);
    return { auth, args: [open, salt, auth, att, attestation.signature] as const };
  }

  async function verify(payment: Awaited<ReturnType<typeof parse>>) {
    const { auth, args } = payment;
    const now = BigInt(clock());
    if (auth.validAfter >= now || auth.validBefore <= now + 10n ||
        auth.validBefore > now + BigInt(LIMITS.MAX_AUTH_TTL)) throw new PaymentError("AUTH_EXPIRED");
    const [used, balance] = await Promise.all([
      publicClient.readContract({ address: usdc, abi: authorizationAbi, functionName: "authorizationState", args: [auth.from, auth.nonce] }),
      publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [auth.from] }),
    ]);
    if (used) throw new PaymentError("ALREADY_SUBMITTED");
    if (balance < auth.value) throw new PaymentError("INSUFFICIENT_BALANCE");
    return publicClient.simulateContract({
      address: escrow, abi: agentPaySessionEscrowAbi, functionName: "openWithAuthorization",
      args, account: walletClient.account,
    });
  }

  function reason(error: unknown): string {
    if (error instanceof PaymentError) return error.message;
    return contractRevertReason(error) ?? "CHAIN_ERROR";
  }

  app.get("/supported", context => context.json({ kinds: [{ x402Version: 2, scheme: SCHEME, network: NETWORK.fuji }] }));
  app.post("/verify", async context => {
    try {
      const payment = await parse(context.req.raw);
      await verify(payment);
      const { from, nonce } = payment.auth;
      return context.json({ isValid: true, payer: from, sessionId: sessionId(from, nonce).toString() });
    } catch (error) {
      return context.json({ isValid: false, invalidReason: reason(error) });
    }
  });
  app.post("/settle", async context => {
    try {
      const payment = await parse(context.req.raw);
      const { from, nonce } = payment.auth;
      const key = `${from.toLowerCase()}:${nonce.toLowerCase()}`;
      let operation = pending.get(key);
      if (!operation) {
        operation = (async () => {
          let hash = submitted.get(key);
          if (!hash) {
            const { request } = await verify(payment);
            hash = await walletClient.writeContract({ ...request, account: walletClient.account ?? null, chain: walletClient.chain });
            submitted.set(key, hash);
          }
          const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 45_000 });
          if (receipt.status !== "success") {
            submitted.delete(key);
            throw new PaymentError("CHAIN_ERROR");
          }
          const id = sessionId(from, nonce);
          const log = receipt.logs.find(entry => isAddressEqual(entry.address, escrow) &&
            entry.topics[0] === openedTopic && BigInt(entry.topics[1] ?? "0x0") === id);
          if (!log) throw new PaymentError("CHAIN_ERROR");
          return { success: true, payer: from, transaction: hash, network: NETWORK.fuji, sessionId: id.toString() };
        })().finally(() => pending.delete(key));
        pending.set(key, operation);
      }
      return context.json(await operation);
    } catch (error) {
      return context.json({ success: false, errorReason: reason(error) });
    }
  });
  return app;
}
