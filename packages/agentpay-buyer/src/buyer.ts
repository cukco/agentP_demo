import {
  CHAIN_ID, HEADERS, ROUTES, SessionState, VERIFIER_LIMITS, decodeHeaderJson, parsePaymentRequired, signCloseRequest, specHash, toWire,
  type CloseSessionResponse, type PaymentRequired, type Receipt, type VerificationSpec, type Wire,
} from "@agentpay/core";
import { isAddress, isAddressEqual, type Address, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { requestApproval } from "./approve/server.js";
import { endpoint, HttpTimeoutError, json } from "./http.js";
import { open, readSession } from "./open.js";
import { precheck } from "./precheck.js";
import { BuyerReceiptError, relay } from "./request.js";
import { createFileBuyerStore, type BuyerSession, type BuyerStore } from "./store.js";

export interface BuyerCommonOptions {
  chainId: number;
  publicClient: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  trustedEscrows: readonly Address[];
  facilitatorUrl: string;
  scorerUrl: string;
  softPolicy: { maxPerSession: bigint; maxPricePerRequest: bigint; allowedDomains?: readonly string[] };
  defaultCap: bigint;
  defaultExpirySec: number;
  /** Optional fee previously shown to the user, in USDC base units. */
  expectedSessionFee?: bigint;
  clock: () => number;
  store?: BuyerStore;
  fetch?: typeof fetch;
  /** Adapter for the Verifier's pure check runner. A numeric result uses the core Outcome enum. */
  checks: (input: { spec: VerificationSpec; body: Uint8Array; contentType: string; receivedAt: bigint }) => number | Promise<number>;
  supportsSpec?: (spec: VerificationSpec) => boolean;
}

export interface BuyerOptions extends BuyerCommonOptions {
  mode: "auto";
  account: LocalAccount;
  walletClient: Pick<WalletClient, "writeContract" | "chain">;
}

export interface ApproveBuyerOptions extends BuyerCommonOptions {
  mode: "approve";
  buyerAddress: Address;
  onApprovalUrl: (url: string) => void | Promise<void>;
  account?: never;
  walletClient?: never;
}

export type BuyerModeOptions = BuyerOptions | ApproveBuyerOptions;

export interface BuyerFetchResult {
  response: Response;
  receipt?: Wire<Receipt>;
}

export interface AgentPayBuyer {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  fetchWithReceipt(input: RequestInfo | URL, init?: RequestInit, maxCap?: bigint): Promise<BuyerFetchResult>;
  openSession(input: string | URL, options: { cap: bigint; expirySec: number }): Promise<string>;
  close(sessionId: bigint | string): Promise<void>;
}

function confirmedCloseStatus(state: SessionState | undefined): "closing" | "stopped" | undefined {
  if (state === SessionState.CLOSING || state === SessionState.CHALLENGED) return "closing";
  if (state === SessionState.SETTLED || state === SessionState.REFUNDED) return "stopped";
}

/** Use one Buyer instance per account and store. */
export function createAgentPayBuyer(deps: BuyerModeOptions): AgentPayBuyer {
  if (typeof deps.checks !== "function") throw new Error("Buyer requires a verification checks adapter");
  if (deps.mode === "approve" && (deps.account !== undefined || deps.walletClient !== undefined || deps.chainId !== CHAIN_ID.fuji ||
      !isAddress(deps.buyerAddress) || typeof deps.onApprovalUrl !== "function")) {
    throw new Error("Approval mode requires a public Fuji buyer address and MetaMask");
  }
  const buyer = deps.mode === "auto" ? deps.account.address : deps.buyerAddress;
  const store = deps.store ?? createFileBuyerStore();
  const fees = new Map<string, bigint>();
  const fetchHttp = deps.fetch ?? fetch;
  let queued: Promise<unknown> = Promise.resolve();
  const temporary = new Map<string, { account: LocalAccount; expiry: bigint; timer: ReturnType<typeof setTimeout> }>();

  function release(id: string) {
    const entry = temporary.get(id);
    if (entry) clearTimeout(entry.timer);
    temporary.delete(id);
  }

  function signer(id: string): LocalAccount | undefined {
    if (deps.mode === "auto") return deps.account;
    const entry = temporary.get(id);
    if (!entry) return undefined;
    if (entry.expiry <= BigInt(deps.clock())) {
      release(id);
      return undefined;
    }
    return entry.account;
  }

  async function newSession(funding: BuyerModeOptions, payment: PaymentRequired) {
    const account = deps.mode === "auto" ? deps.account : privateKeyToAccount(generatePrivateKey());
    const { session, expiry } = await open(funding, store, payment, fees, account.address);
    if (deps.mode === "approve") {
      const id = session.id;
      const timer = setTimeout(() => release(id), Math.max(0, Number(expiry - BigInt(deps.clock())) * 1000));
      timer.unref();
      temporary.set(id, { account, expiry, timer });
    }
    return session;
  }
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const current = queued.then(run, run);
    queued = current;
    return current;
  }

  function owned(session: BuyerSession) {
    const { contract, chainId } = session.payment.extensions.agentpay.session;
    return chainId === deps.chainId && isAddressEqual(session.buyer, buyer) &&
      deps.trustedEscrows.some(address => isAddressEqual(address, contract));
  }

  async function close(session: BuyerSession, interactive = false): Promise<void> {
    const { session: terms, verificationSpec: spec } = session.payment.extensions.agentpay;
    let onchain;
    const awaitingConfirmedSession = session.status === "opening" && session.settleConfirmed === true;
    if (session.status === "opening") {
      onchain = await readSession(deps, terms.contract, session.id);
      if (onchain.state === SessionState.NONE &&
          (awaitingConfirmedSession || BigInt(deps.clock()) < BigInt(session.authorizationExpiresAt ?? 0))) {
        throw new Error(`Previous session settlement is unresolved: ${session.id}`);
      }
    }
    const stop = async () => {
      release(session.id);
      session.status = "stopped";
      await store.save(session);
    };
    const manualApprove = deps.mode === "approve" && interactive;
    if (!manualApprove) {
      if (!awaitingConfirmedSession) await stop();
      if (deps.mode === "approve") return;
    }
    onchain ??= await readSession(deps, terms.contract, session.id);
    if (onchain.state === SessionState.OPEN && !isAddressEqual(onchain.buyer, buyer)) throw new Error("Session belongs to another buyer");
    let signed;
    if (deps.mode === "approve" && interactive && onchain.state === SessionState.OPEN) {
      const approval = await requestApproval({ kind: "close", chainId: deps.chainId, escrow: terms.contract, buyer, sessionId: session.id }, deps);
      signed = { message: { sessionId: BigInt(session.id), deadline: approval.deadline }, signature: approval.signature };
    }
    if ((manualApprove && !awaitingConfirmedSession) ||
        (awaitingConfirmedSession && onchain.state !== SessionState.OPEN)) await stop();
    if (onchain.state !== SessionState.OPEN) {
      const status = confirmedCloseStatus(onchain.state);
      if (status && session.status !== status) {
        session.status = status;
        await store.save(session);
      }
      return;
    }
    if (deps.mode === "auto") {
      const message = { sessionId: BigInt(session.id), deadline: BigInt(deps.clock() + VERIFIER_LIMITS.CLOSE_REQUEST_SLA_SEC) };
      signed = await signCloseRequest(deps.account, deps.chainId, terms.contract, message);
    }
    let status: "closing" | "stopped" = "closing";
    try {
      const result = await json<CloseSessionResponse>(deps, endpoint(spec.verifier.endpoint, ROUTES.verifier.close(session.id)),
        VERIFIER_LIMITS.CLOSE_REQUEST_SLA_SEC * 1000, { closeRequest: toWire(signed!) });
      if (result?.sessionId !== session.id || typeof result.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result.txHash)) {
        throw new Error("Invalid close response");
      }
    } catch (error) {
      if (!(error instanceof HttpTimeoutError)) throw error;
      const reconciled = await readSession(deps, terms.contract, session.id).catch(() => undefined);
      const confirmed = confirmedCloseStatus(reconciled?.state);
      if (!confirmed) throw new Error(`Session close is unconfirmed: ${session.id}`, { cause: error });
      status = confirmed;
    }
    session.status = status;
    await store.save(session);
  }

  async function reusable(payment: PaymentRequired, maxCap?: bigint, allowReuse = true): Promise<BuyerSession | undefined> {
    const { session: terms, verificationSpec } = payment.extensions.agentpay;
    const digest = specHash(verificationSpec);
    const price = BigInt(terms.pricePerRequest);
    for (const saved of await store.list()) {
      if (!owned(saved)) continue;
      const old = saved.payment.extensions.agentpay.session;
      if (!isAddressEqual(old.contract, terms.contract) || !isAddressEqual(old.seller, terms.seller) ||
          old.sellerAgentId !== terms.sellerAgentId) continue;
      if (saved.status === "opening") {
        const state = await readSession(deps, old.contract, saved.id);
        const resolved = saved.settleConfirmed
          ? state.state === SessionState.SETTLED || state.state === SessionState.REFUNDED
          : state.state === SessionState.NONE && BigInt(deps.clock()) >= BigInt(saved.authorizationExpiresAt ?? 0);
        if (resolved) {
          await store.save({ ...saved, status: "stopped" });
          continue;
        }
        throw new Error(`Previous session settlement is unresolved: ${saved.id}`);
      }
      if (saved.status !== "open") continue;
      const account = signer(saved.id);
      if (!account) continue;
      if (saved.requests.at(-1) && !saved.requests.at(-1)!.receipt) {
        await close(saved).catch(() => {});
        throw new Error(`Previous Receipt is unresolved: ${saved.id}`);
      }
      if (!allowReuse) continue;
      const session = await readSession(deps, terms.contract, saved.id);
      if (session.state !== SessionState.OPEN || session.expiry <= BigInt(deps.clock())) {
        release(saved.id);
        continue;
      }
      const spent = BigInt(saved.requests.at(-1)?.voucher.message.cumulativeAmount ?? 0);
      if (isAddressEqual(session.buyer, buyer) && isAddressEqual(session.voucherSigner, account.address) &&
          isAddressEqual(session.seller, terms.seller) && session.sellerAgentId === BigInt(terms.sellerAgentId) &&
          isAddressEqual(session.verifier, verificationSpec.verifier.address) && session.specHash.toLowerCase() === digest &&
          session.pricePerRequest === price && session.cap <= deps.softPolicy.maxPerSession &&
          (maxCap === undefined || session.cap <= maxCap) &&
          spent + price <= session.cap - session.sessionFee) return saved;
    }
  }

  async function offer(request: Request, response: Response) {
    if (response.url && new URL(response.url).href !== request.url) throw new Error("Payment requested after a redirect");
    const header = response.headers.get(HEADERS.PAYMENT_REQUIRED);
    const payment = parsePaymentRequired(header ? decodeHeaderJson(header) : await response.json());
    if (new URL(payment.resource.url).href !== request.url) throw new Error("Payment resource does not match the request");
    const spec = payment.extensions.agentpay.verificationSpec;
    if (deps.supportsSpec && !deps.supportsSpec(spec)) throw new Error("Buyer checks do not support this verification spec");
    return payment;
  }

  async function fetchWithReceipt(input: RequestInfo | URL, init?: RequestInit, maxCap?: bigint): Promise<BuyerFetchResult> {
    const request = new Request(input, init);
    request.headers.delete(HEADERS.PAYMENT_SIGNATURE);
    const response = await fetchHttp(request.clone());
    if (response.status !== 402) return { response };
    const payment = await offer(request, response);
    const funding = maxCap !== undefined && maxCap < deps.defaultCap ? { ...deps, defaultCap: maxCap } : deps;
    return serialize(async () => {
      request.signal.throwIfAborted();
      await precheck(funding, payment, new URL(request.url));
      request.signal.throwIfAborted();
      const session = (await reusable(payment, maxCap)) ?? await newSession(funding, payment);
      try {
        const result = await relay(deps, store, session, request, () => signer(session.id));
        return { response: result, receipt: session.requests.at(-1)?.receipt?.message };
      } catch (error) {
        if (error instanceof BuyerReceiptError) throw error;
        release(session.id);
        await close(session).catch(() => {});
        if (error instanceof Error && error.name === "TimeoutError") throw new Error(`Receipt deadline exceeded: ${session.id}`);
        throw error;
      } finally {
        if (session.status !== "open") release(session.id);
      }
    });
  }

  return {
    async fetch(input, init) { return (await fetchWithReceipt(input, init)).response; },
    fetchWithReceipt,
    async openSession(input, { cap, expirySec }) {
      const request = new Request(input);
      const response = await fetchHttp(request);
      if (response.status !== 402) throw new Error("Seller did not request payment");
      const payment = await offer(request, response);
      const funding = { ...deps, defaultCap: cap, defaultExpirySec: expirySec };
      return serialize(async () => {
        await precheck(funding, payment, new URL(request.url));
        await reusable(payment, undefined, false);
        return (await newSession(funding, payment)).id;
      });
    },
    close(id) {
      return serialize(async () => {
        const session = await store.get(String(id));
        if (!session || !owned(session)) throw new Error("Unknown buyer session");
        await close(session, true);
      });
    },
  };
}
