import {
  AGENTPAY_VERSION, CHAIN_ID, DEFAULTS, HEADERS, LIMITS, SCHEME, SessionState, USDC, USDC_DOMAIN,
  agentPaySessionEscrowAbi, bodyHash, decodeHeaderJson, encodeHeader, fromWire, requestHash, signDelivery,
  specHash, validateSpec, validateTerms, verifyReceipt, verifySessionVerdict, verifyVoucher,
  type ApiError, type ApiErrorCode, type CheckpointResponse, type PaymentRequired, type Receipt,
  type ReceiptsResponse, type SessionTerms, type SessionVerdict, type VerificationSpec, type Voucher, type WireSigned,
} from "@agentpay/core";
import type { MiddlewareHandler } from "hono";
import { isAddressEqual, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { createMemorySellerStore, type SellerSessionRecord, type SellerStore } from "./store.js";

export interface SellerOptions {
  account: LocalAccount;
  chainId: number;
  escrow: Address;
  /** Needed for local or custom deployments of USDC. */
  asset?: Address;
  publicClient: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  walletClient: Pick<WalletClient, "chain" | "writeContract">;
  sellerAgentId: bigint;
  pricePerRequest: bigint;
  terms: Omit<SessionTerms, "contract" | "chainId" | "seller" | "sellerAgentId" | "pricePerRequest" | "minCap" | "maxCap"> & {
    minCap: bigint;
    maxCap: bigint;
  };
  spec: VerificationSpec;
  verifierUrl: string;
  clock: () => number;
  store?: SellerStore;
  fetch?: typeof fetch;
  /**
   * Behind a TLS-terminating proxy (Fly.io, Caddy) the app sees http://. When true, the scheme of the
   * advertised resource and of requestHash comes from X-Forwarded-Proto. Enable only when the proxy is the
   * sole way to reach the seller, otherwise a client could choose the scheme.
   */
  trustProxy?: boolean;
}

export interface AgentPaySeller {
  middleware(): MiddlewareHandler;
  sync(): Promise<void>;
  stop(): void;
}

function readVoucher(value: WireSigned<Voucher>) {
  const message = fromWire<Voucher>("Voucher", value.message);
  if (!Number.isInteger(message.seq) || message.seq < 1 || message.seq > 0xffff_ffff ||
      message.sessionId >= 2n ** 256n || message.cumulativeAmount >= 2n ** 128n ||
      !/^0x[0-9a-fA-F]{64}$/.test(message.requestHash) ||
      !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) throw new Error("Malformed Voucher");
  return { message, signature: value.signature };
}

/** Public URL of the request: the internal URL with the scheme the client used, when the proxy is trusted. */
export function publicRequestUrl(internal: string, forwardedProto: string | undefined, trustProxy: boolean): string {
  const proto = forwardedProto?.split(",", 1)[0]?.trim().toLowerCase();
  if (!trustProxy || (proto !== "https" && proto !== "http")) return internal;
  const url = new URL(internal);
  url.protocol = proto + ":";
  return url.href;
}

export function createAgentPaySeller(deps: SellerOptions): AgentPaySeller {
  const { account, chainId, escrow, publicClient, walletClient, clock, pricePerRequest,
    store = createMemorySellerStore(), fetch: fetchVerifier = fetch } = deps;
  const spec = structuredClone(deps.spec);
  const specValidation = validateSpec(spec);
  if (!specValidation.ok) throw new Error(specValidation.reason);
  const hash = specHash(spec);
  const asset = deps.asset ?? (chainId === CHAIN_ID.fuji ? USDC.fuji : chainId === CHAIN_ID.avalanche ? USDC.avalanche : undefined);
  if (!asset) throw new Error("An asset address is required for this chain");
  const offer: PaymentRequired["accepts"][number] = {
    scheme: SCHEME, network: `eip155:${chainId}`, asset, amount: pricePerRequest.toString(),
    payTo: escrow, maxTimeoutSeconds: DEFAULTS.AUTH_VALID_SEC, extra: USDC_DOMAIN,
  };
  const terms: SessionTerms = { ...deps.terms, contract: escrow, seller: account.address, chainId,
    pricePerRequest: offer.amount, sellerAgentId: deps.sellerAgentId.toString(),
    minCap: deps.terms.minCap.toString(), maxCap: deps.terms.maxCap.toString() };
  const termsValidation = validateTerms(terms, offer);
  if (!termsValidation.ok) throw new Error(termsValidation.reason);

  const verifierBase = deps.verifierUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const readSession = (id: bigint) => publicClient.readContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [id],
  });
  type Session = Awaited<ReturnType<typeof readSession>>;
  const sessions = new Map<bigint, Session>();
  const finished = new Set<bigint>();
  const pendingClose = new Map<bigint, Hex>();
  const locks = new Map<bigint, Promise<unknown>>();

  async function serialize<T>(id: bigint, run: () => Promise<T>): Promise<T> {
    const current = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    locks.set(id, current);
    try {
      return await current;
    } finally {
      if (locks.get(id) === current) locks.delete(id);
    }
  }

  const middleware: MiddlewareHandler = async (context, next) => {
    const url = publicRequestUrl(context.req.url, context.req.header("x-forwarded-proto"), deps.trustProxy === true);
    const payment: PaymentRequired = { x402Version: 2, resource: { url }, accepts: [offer],
      extensions: { agentpay: { version: AGENTPAY_VERSION, session: terms, verificationSpec: spec } } };
    const header = context.req.header(HEADERS.PAYMENT_SIGNATURE);
    const required = (code?: ApiErrorCode) => {
      context.header(HEADERS.PAYMENT_REQUIRED, encodeHeader(payment));
      const error: ApiError["error"] | undefined = code && { code, message: "Voucher rejected" };
      return context.json({ ...payment, ...(error && { error }) }, 402);
    };
    if (!header) return required();
    let voucher: ReturnType<typeof readVoucher>;
    let wire: WireSigned<Voucher>;
    try {
      wire = decodeHeaderJson<WireSigned<Voucher>>(header);
      voucher = readVoucher(wire);
    } catch {
      return required("BAD_REQUEST");
    }

    const { sessionId: id, seq, cumulativeAmount } = voucher.message;
    const error = await serialize(id, async (): Promise<ApiErrorCode | undefined> => {
      if (finished.has(id)) return "SESSION_NOT_OPEN";
      const session = sessions.get(id) ?? await readSession(id);
      if (session.state === SessionState.NONE || !isAddressEqual(session.seller, account.address)) return "SESSION_NOT_FOUND";
      if (session.state !== SessionState.OPEN) return "SESSION_NOT_OPEN";
      if (BigInt(clock()) >= session.expiry) return "SESSION_EXPIRED";
      if (session.specHash.toLowerCase() !== hash.toLowerCase() ||
          !isAddressEqual(session.verifier, spec.verifier.address) ||
          session.sellerAgentId !== deps.sellerAgentId || session.pricePerRequest !== pricePerRequest) return "SPEC_REJECTED";
      if (!await verifyVoucher(chainId, escrow, voucher, session.voucherSigner)) return "BAD_VOUCHER_SIG";
      const record = await store.get(id);
      if (seq !== (record?.voucher.message.seq ?? session.lastSeq) + 1) return "BAD_SEQ";
      if (cumulativeAmount !== BigInt(seq) * session.pricePerRequest) return "BAD_CUMULATIVE";
      if (cumulativeAmount > session.cap - session.sessionFee) return "OVER_USABLE";
      const body = new Uint8Array(await context.req.raw.clone().arrayBuffer());
      if (requestHash(context.req.method, url, body) !== voucher.message.requestHash.toLowerCase()) return "BAD_REQUEST_HASH";
      // Persist before invoking user code so parallel requests or a restart cannot replay it.
      if (BigInt(clock()) >= session.expiry) return "SESSION_EXPIRED";
      await store.save(id, { ...record, voucher: wire, receipts: record?.receipts ?? [] });
      sessions.set(id, session);
    });
    if (error) return required(error);

    await next();
    const bytes = new Uint8Array(await context.res.clone().arrayBuffer());
    const delivery = await signDelivery(account, chainId, escrow, {
      sessionId: id, seq, requestHash: voucher.message.requestHash, bodyHash: bodyHash(bytes), specHash: hash,
    });
    context.header(HEADERS.DELIVERY, encodeHeader(delivery));
  };

  async function get<T>(id: bigint, resource: string): Promise<T | undefined> {
    try {
      const response = await fetchVerifier(`${verifierBase}/v1/sessions/${id}/${resource}`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return await response.json() as T;
    } catch {
      // The last local checkpoint can still close the session while the Verifier is down.
    }
  }

  async function refresh(id: bigint, session: Session, record: SellerSessionRecord): Promise<SellerSessionRecord> {
    const [checkpoint, receipts] = await Promise.all([
      get<CheckpointResponse>(id, "checkpoint"),
      get<ReceiptsResponse>(id, "receipts"),
    ]);
    const latest = record.voucher.message.seq;
    if (receipts?.sessionId === id.toString() && Array.isArray(receipts.receipts)) {
      const known = new Map(record.receipts.map(receipt => [receipt.message.seq, receipt]));
      for (const signed of receipts.receipts) {
        try {
          const message = fromWire<Receipt>("Receipt", signed.message);
          if (message.sessionId === id && Number.isInteger(message.seq) && message.seq > 0 && message.seq <= latest &&
              !known.has(message.seq) && await verifyReceipt(chainId, escrow, { message, signature: signed.signature }, session.verifier)) {
            known.set(message.seq, signed);
          }
        } catch {
          // Skip malformed receipts without dropping previously verified ones.
        }
      }
      if (known.size > record.receipts.length) {
        record = { ...record, receipts: [...known.values()].sort((a, b) => a.message.seq - b.message.seq) };
      }
    }
    if (checkpoint?.sessionId === id.toString()) {
      try {
        const voucher = readVoucher(checkpoint.voucher);
        const verdict = fromWire<SessionVerdict>("SessionVerdict", checkpoint.verdict.message);
        if (voucher.message.sessionId === id && verdict.sessionId === id && verdict.specHash.toLowerCase() === session.specHash.toLowerCase() &&
            verdict.lastSeq === voucher.message.seq && verdict.lastSeq <= latest &&
            verdict.lastSeq > (record.checkpoint?.verdict.message.lastSeq ?? 0) &&
            await verifyVoucher(chainId, escrow, voucher, session.voucherSigner) &&
            await verifySessionVerdict(chainId, escrow, { message: verdict, signature: checkpoint.verdict.signature }, session.verifier)) {
          record = { ...record, checkpoint };
        }
      } catch {
        // Keep the last verified checkpoint.
      }
    }
    return record;
  }

  async function close(id: bigint, session: Session, record: SellerSessionRecord) {
    const now = BigInt(clock());
    const checkpoint = record.checkpoint;
    if (!checkpoint || now < session.expiry || now > session.expiry + BigInt(LIMITS.VERDICT_GRACE)) return;
    let tx = pendingClose.get(id);
    if (!tx) {
      const voucher = readVoucher(checkpoint.voucher);
      const verdict = fromWire<SessionVerdict>("SessionVerdict", checkpoint.verdict.message);
      tx = await walletClient.writeContract({
        address: escrow, abi: agentPaySessionEscrowAbi, functionName: "closeSession", chain: walletClient.chain, account,
        args: [id, voucher.message, voucher.signature, verdict, checkpoint.verdict.signature],
      });
      pendingClose.set(id, tx);
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 8000 });
    pendingClose.delete(id);
    if (receipt.status === "success") {
      sessions.delete(id);
      finished.add(id);
    }
  }

  async function syncSession(id: bigint) {
    if (finished.has(id)) return;
    const session = await readSession(id);
    if (session.state !== SessionState.OPEN || !isAddressEqual(session.seller, account.address)) {
      sessions.delete(id);
      pendingClose.delete(id);
      finished.add(id);
      return;
    }
    sessions.set(id, session);
    const record = await store.get(id);
    if (!record) return;
    const updated = await refresh(id, session, record);
    if (updated !== record) await store.save(id, updated);
    await close(id, session, updated);
  }

  let polling: Promise<void> | undefined;
  function sync() {
    polling ??= (async () => {
      const results = await Promise.allSettled((await store.sessionIds()).map(id => serialize(id, () => syncSession(id))));
      if (results.some(result => result.status === "rejected")) throw new Error("Could not sync one or more seller sessions");
    })().finally(() => { polling = undefined; });
    return polling;
  }

  const timer = setInterval(() => { void sync().catch(() => {}); }, 10_000);
  timer.unref();
  return { middleware: () => middleware, sync, stop: () => clearInterval(timer) };
}
