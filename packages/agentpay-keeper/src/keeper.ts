import type { Address, Hash, PublicClient, WalletClient, Account, Chain, Transport } from "viem";
import { agentPaySessionEscrowAbi, LIMITS, SessionState } from "@agentpay/core";

/**
 * Keeper (SystemDesign §5.7): calls finalize / refund / expireChallenge when they become due.
 * Anyone may call these functions, so the Keeper is a liveness helper, not a trusted party (V25).
 *
 * - Discovers sessions from SessionOpened logs (chunked backfill + incremental sync).
 * - Uses on-chain getSession() as source of truth before every action (idempotent).
 * - Decides with chain time (latest block timestamp) unless a clock is injected.
 * - Never sends the same action twice concurrently; retries transient errors with backoff.
 */

/** finalize uses ~204k with ERC-8004 feedback; the limit leaves room for feedback (try/catch in Escrow)
 * without paying for 1M: Fuji billed half of a 1M limit (500k) per finalize. */
export const FINALIZE_GAS = 400_000n;

export type KeeperAction = "finalize" | "refund" | "expireChallenge";

export interface KeeperStoreData {
  lastBlock: string; // bigint as decimal string
  sessions: string[]; // live sessionIds (decimal)
}

export interface KeeperStore {
  load(): Promise<KeeperStoreData | undefined>;
  save(data: KeeperStoreData): Promise<void>;
}

export interface KeeperLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface KeeperDeps {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain | undefined, Account>;
  escrow: Address;
  store: KeeperStore;
  /** First block to scan when the store is empty (deployment block). */
  fromBlock: bigint;
  /** unix seconds; default = timestamp of the latest block. */
  clock?: () => Promise<number> | number;
  logger?: KeeperLogger;
  chunkSize?: bigint;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Gas budget for finalize, including ERC-8004 feedback caught by the escrow. Default 1,000,000. */
  finalizeGas?: bigint;
}

export interface ActionResult {
  action: KeeperAction;
  sessionId: bigint;
  txHash?: Hash;
  error?: string;
}

const sessionOpenedEvent = agentPaySessionEscrowAbi.find(
  (e) => e.type === "event" && e.name === "SessionOpened",
)!;

const silent: KeeperLogger = { info: () => {}, warn: () => {} };

export function memoryStore(initial?: KeeperStoreData): KeeperStore & { data?: KeeperStoreData } {
  const s: KeeperStore & { data?: KeeperStoreData } = {
    data: initial,
    async load() {
      return s.data ? structuredClone(s.data) : undefined;
    },
    async save(d) {
      s.data = structuredClone(d);
    },
  };
  return s;
}

/** Decides which action (if any) is due for a session at time `now`. Pure, unit-testable. */
export function dueAction(
  s: { state: number; expiry: bigint; challengeEnd: bigint; resolveDeadline: bigint },
  now: number,
): KeeperAction | undefined {
  const t = BigInt(now);
  if (s.state === SessionState.OPEN && t > s.expiry + BigInt(LIMITS.VERDICT_GRACE)) return "refund";
  if (s.state === SessionState.CLOSING && t > s.challengeEnd) return "finalize";
  if (s.state === SessionState.CHALLENGED && t > s.resolveDeadline) return "expireChallenge";
  return undefined;
}

export function isFinal(state: number): boolean {
  return state === SessionState.SETTLED || state === SessionState.REFUNDED;
}

export function createKeeper(deps: KeeperDeps) {
  const log = deps.logger ?? silent;
  const chunk = deps.chunkSize ?? 2_000n;
  const maxRetries = deps.maxRetries ?? 3;
  const retryBaseMs = deps.retryBaseMs ?? 200;
  const inFlight = new Set<string>();
  let lastBlock = deps.fromBlock - 1n;
  const live = new Set<string>();
  let loaded = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function ensureLoaded() {
    if (loaded) return;
    const d = await deps.store.load();
    if (d) {
      lastBlock = BigInt(d.lastBlock);
      d.sessions.forEach((id) => live.add(id));
    }
    loaded = true;
  }

  async function persist() {
    await deps.store.save({ lastBlock: lastBlock.toString(), sessions: [...live] });
  }

  async function now(): Promise<number> {
    if (deps.clock) return deps.clock();
    const b = await deps.publicClient.getBlock({ blockTag: "latest" });
    return Number(b.timestamp);
  }

  /** Scans SessionOpened logs from lastBlock+1 to latest in chunks. */
  async function sync(): Promise<void> {
    await ensureLoaded();
    const head = await deps.publicClient.getBlockNumber({ cacheTime: 0 }); // viem caches 4s by default
    for (let from = lastBlock + 1n; from <= head; from += chunk) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n;
      const logs = await deps.publicClient.getLogs({
        address: deps.escrow,
        event: sessionOpenedEvent,
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        const sid = (l as unknown as { args: { sessionId: bigint } }).args.sessionId;
        live.add(sid.toString());
      }
      lastBlock = to;
      await persist();
    }
  }

  async function send(action: KeeperAction, sessionId: bigint): Promise<Hash> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const hash = await deps.walletClient.writeContract({
          address: deps.escrow,
          abi: agentPaySessionEscrowAbi,
          functionName: action,
          // eth_estimateGas can accept the cheaper path where giveFeedback runs out of gas
          // and Escrow catches the failure. Reserve gas for successful registry writes.
          gas: action === "finalize" ? (deps.finalizeGas ?? FINALIZE_GAS) : undefined,
          args: [sessionId],
          chain: deps.walletClient.chain,
          account: deps.walletClient.account,
        });
        const rcpt = await deps.publicClient.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success") throw new Error(`tx reverted: ${hash}`);
        return hash;
      } catch (e) {
        lastErr = e;
        // re-check: someone else may have done it already
        const s = await deps.publicClient.readContract({
          address: deps.escrow,
          abi: agentPaySessionEscrowAbi,
          functionName: "getSession",
          args: [sessionId],
        });
        if (isFinal(s.state) || dueAction(s, await now()) !== action) throw new Error("ALREADY_HANDLED");
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Executes every due action once. Safe to call concurrently. */
  async function tick(): Promise<ActionResult[]> {
    await ensureLoaded();
    const t = await now();
    const results: ActionResult[] = [];
    await Promise.all(
      [...live].map(async (id) => {
        const sessionId = BigInt(id);
        const s = await deps.publicClient.readContract({
          address: deps.escrow,
          abi: agentPaySessionEscrowAbi,
          functionName: "getSession",
          args: [sessionId],
        });
        if (isFinal(s.state)) {
          live.delete(id);
          return;
        }
        const action = dueAction(s, t);
        if (!action) return;
        const key = `${action}:${id}`;
        if (inFlight.has(key)) return;
        inFlight.add(key);
        try {
          const txHash = await send(action, sessionId);
          log.info("keeper action", { action, sessionId: id, txHash });
          results.push({ action, sessionId, txHash });
          live.delete(id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "ALREADY_HANDLED") {
            live.delete(id);
          } else {
            log.warn("keeper action failed", { action, sessionId: id, error: msg.slice(0, 200) });
            results.push({ action, sessionId, error: msg });
          }
        } finally {
          inFlight.delete(key);
        }
      }),
    );
    await persist();
    return results;
  }

  async function runOnce(): Promise<ActionResult[]> {
    await sync();
    return tick();
  }

  return {
    sync,
    tick,
    runOnce,
    liveSessions: () => [...live].map(BigInt),
    start(intervalMs = 15_000) {
      if (timer) return;
      const loop = () =>
        runOnce().catch((e) => log.warn("keeper loop error", { error: String(e).slice(0, 200) }));
      void loop();
      timer = setInterval(loop, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type Keeper = ReturnType<typeof createKeeper>;
