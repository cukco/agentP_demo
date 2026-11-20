import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ChallengeReason, DEFAULTS, Outcome, SessionState, agentPaySessionEscrowAbi, fromWire, receiptsRoot,
  signReceiveAuthorization, toWire, verifyReceipt, type Receipt,
} from "@agentpay/core";
import { isAddressEqual, toHex, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import { writePrivateJson } from "./files.js";
import { escrowViews } from "./precheck.js";
import type { BuyerRequestRecord, BuyerSession, BuyerStore } from "./store.js";

const sessionClosed = agentPaySessionEscrowAbi.find(entry => entry.type === "event" && entry.name === "SessionClosed")!;

interface ClosedVerdict {
  sessionId: bigint;
  lastSeq: number;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  passedAmount: bigint;
  receiptsRoot: Hex;
  challengeEnd: bigint;
  closeTxHash: Hex;
}

export interface BuyerChallengeOptions {
  chainId: number;
  escrow: Address;
  account: LocalAccount;
  publicClient: Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock" | "readContract" | "waitForTransactionReceipt">;
  walletClient: Pick<WalletClient, "chain" | "writeContract">;
  store: BuyerStore;
  clock: () => number;
  /** Start at the escrow deployment block or a known lower bound for relevant closes. */
  fromBlock: bigint;
  evidenceDirectory?: string;
}

export interface BuyerChallengeResult {
  sessionId: string;
  status: "matched" | "incomplete" | "expired" | "ignored" | "challenged" | "retry";
  reasonCode?: ChallengeReason;
  txHash?: Hex;
}

interface EvidenceSummary {
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  passedAmount: bigint;
  receiptsRoot: Hex;
  unseen: number;
}

function reason(verdict: ClosedVerdict, seen: EvidenceSummary, price: bigint, mismatch: boolean): ChallengeReason | undefined {
  if (mismatch) return ChallengeReason.BUYER_RECHECK_MISMATCH;
  if (verdict.passCount > verdict.lastSeq - seen.failCount) return ChallengeReason.RECEIPT_FAIL_COUNTED_PASS;
  if (verdict.passCount < seen.passCount || verdict.passedAmount < seen.passedAmount) return ChallengeReason.MISSING_PASS_RECEIPT;
  const counted = verdict.passCount + verdict.failCount + verdict.inconclusiveCount;
  const known = verdict.lastSeq - seen.unseen;
  if (verdict.passCount > seen.passCount + seen.unseen || verdict.passedAmount > seen.passedAmount + BigInt(seen.unseen) * price ||
      verdict.failCount < seen.failCount || verdict.inconclusiveCount < seen.inconclusiveCount ||
      seen.unseen === 0 && counted === verdict.lastSeq && verdict.receiptsRoot.toLowerCase() !== seen.receiptsRoot) {
    return ChallengeReason.OTHER;
  }
}

/** Watches the BuyerStore used by Buyer auto. Call start() on one watcher per account and escrow. */
export function createBuyerChallengeWatcher(deps: BuyerChallengeOptions) {
  const { escrow, chainId, account, publicClient, walletClient, store } = deps;
  if (deps.fromBlock < 0n) throw new Error("fromBlock must be nonnegative");
  const directory = deps.evidenceDirectory ?? join(homedir(), ".agentpay", "evidence");
  let nextBlock = deps.fromBlock;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<BuyerChallengeResult[]> | undefined;
  const pending = new Map<string, ClosedVerdict>();
  const submissions = new Map<string, Hex>();

  function owns(saved: BuyerSession) {
    const terms = saved.payment.extensions.agentpay.session;
    return terms.chainId === chainId && isAddressEqual(terms.contract, escrow) && isAddressEqual(saved.buyer, account.address);
  }

  async function discover() {
    const ids = (await store.list()).filter(owns).map(saved => BigInt(saved.id));
    if (!ids.length) return;
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    while (nextBlock <= head) {
      const toBlock = nextBlock + 1999n < head ? nextBlock + 1999n : head;
      for (let i = 0; i < ids.length; i += 100) {
        const logs = await publicClient.getLogs({
          address: escrow, event: sessionClosed, args: { sessionId: ids.slice(i, i + 100) },
          fromBlock: nextBlock, toBlock, strict: true,
        });
        for (const event of logs) {
          pending.set(event.args.sessionId.toString(), { ...event.args, closeTxHash: event.transactionHash });
        }
      }
      nextBlock = toBlock + 1n;
    }
  }

  async function now(): Promise<bigint> {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    const clock = BigInt(deps.clock());
    return block.timestamp > clock ? block.timestamp : clock;
  }

  function readSession(id: bigint) {
    return publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [id] });
  }

  async function verifiedRequests(saved: BuyerSession, verdict: ClosedVerdict, verifier: Address) {
    const verified = new Map<number, { request: BuyerRequestRecord; receipt: Receipt }>();
    for (const request of saved.requests) {
      if (!request.receipt || request.voucher.message.seq > verdict.lastSeq) continue;
      const { signature } = request.receipt;
      const receipt = fromWire<Receipt>("Receipt", request.receipt.message);
      if (!Number.isInteger(receipt.seq) || receipt.seq < 1 || receipt.seq !== request.voucher.message.seq ||
          receipt.sessionId !== verdict.sessionId || receipt.requestHash.toLowerCase() !== request.voucher.message.requestHash.toLowerCase() ||
          ![Outcome.PASS, Outcome.FAIL, Outcome.INCONCLUSIVE].includes(receipt.outcome) ||
          !await verifyReceipt(chainId, escrow, { message: receipt, signature }, verifier)) continue;
      if (verified.has(receipt.seq)) throw new Error("Multiple stored receipts for one sequence");
      verified.set(receipt.seq, { request, receipt });
    }
    return [...verified.values()].sort((a, b) => a.receipt.seq - b.receipt.seq);
  }

  async function submit(verdict: ClosedVerdict, path: string, evidence: object, code: ChallengeReason): Promise<BuyerChallengeResult> {
    const { sessionId, challengeEnd } = verdict;
    const id = sessionId.toString();
    let hash = submissions.get(id);
    if (!hash) {
      // Recover a pending transaction after a restart without sending a second bond.
      try {
        const previous: { closeTxHash?: Hex; challengeTxHash?: Hex } = JSON.parse(await readFile(path, "utf8"));
        if (previous.closeTxHash === verdict.closeTxHash && previous.challengeTxHash) hash = previous.challengeTxHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!hash) {
      await writePrivateJson(path, evidence);
      if (await now() >= challengeEnd) return { sessionId: id, status: "expired", reasonCode: code };

      const [bond, asset] = await Promise.all([
        publicClient.readContract({
          address: escrow, abi: agentPaySessionEscrowAbi, functionName: "requiredBond", args: [sessionId, account.address],
        }),
        publicClient.readContract({ address: escrow, abi: escrowViews, functionName: "usdc" }),
      ]);
      const time = await now();
      if (time >= challengeEnd) return { sessionId: id, status: "expired", reasonCode: code };
      const authorizationEnd = time + BigInt(DEFAULTS.AUTH_VALID_SEC);
      const validBefore = authorizationEnd < challengeEnd ? authorizationEnd : challengeEnd;
      const nonce = toHex(randomBytes(32));
      const { v, r, s } = await signReceiveAuthorization(account, chainId, asset, {
        from: account.address, to: escrow, value: bond, validAfter: 0n, validBefore, nonce,
      });
      const live = await readSession(sessionId);
      if (live.state !== SessionState.CLOSING || live.challengeEnd !== challengeEnd || live.receiptsRoot !== verdict.receiptsRoot) {
        return { sessionId: id, status: "ignored" };
      }
      if (await now() >= challengeEnd) return { sessionId: id, status: "expired", reasonCode: code };
      hash = await walletClient.writeContract({
        address: escrow, abi: agentPaySessionEscrowAbi, functionName: "challenge", chain: walletClient.chain, account,
        args: [sessionId, code, { from: account.address, value: bond, validAfter: 0n, validBefore, nonce, v, r, s }],
      });
      submissions.set(id, hash);
      await writePrivateJson(path, { ...evidence, challengeTxHash: hash, bond: bond.toString() });
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 4500 });
    submissions.delete(id);
    if (receipt.status === "success") return { sessionId: id, status: "challenged", reasonCode: code, txHash: hash };
    await writePrivateJson(path, evidence);
    return { sessionId: id, status: "retry", reasonCode: code };
  }

  async function reconcile(verdict: ClosedVerdict): Promise<BuyerChallengeResult> {
    const id = verdict.sessionId.toString();
    const saved = await store.get(id);
    if (!saved || !owns(saved)) return { sessionId: id, status: "ignored" };
    const live = await readSession(verdict.sessionId);
    if (live.state !== SessionState.CLOSING || !isAddressEqual(live.buyer, account.address) ||
        live.challengeEnd !== verdict.challengeEnd || live.lastSeq !== verdict.lastSeq ||
        live.passCount !== verdict.passCount || live.failCount !== verdict.failCount ||
        live.inconclusiveCount !== verdict.inconclusiveCount || live.receiptsRoot !== verdict.receiptsRoot) {
      return { sessionId: id, status: "ignored" };
    }

    const verified = await verifiedRequests(saved, verdict, live.verifier);
    const receipts = verified.map(entry => entry.receipt);
    const passes = receipts.filter(receipt => receipt.outcome === Outcome.PASS);
    const tally: EvidenceSummary = {
      passCount: passes.length,
      failCount: receipts.filter(receipt => receipt.outcome === Outcome.FAIL).length,
      inconclusiveCount: receipts.filter(receipt => receipt.outcome === Outcome.INCONCLUSIVE).length,
      passedAmount: passes.reduce((total, receipt) => total + receipt.amount, 0n),
      receiptsRoot: receiptsRoot(receipts),
      unseen: verdict.lastSeq - receipts.length,
    };
    const localMismatch = saved.challenge === "RECHECK_MISMATCH" && verified.some(({ request, receipt }) =>
      request.localOutcome === Outcome.FAIL && receipt.outcome === Outcome.PASS);
    const code = reason(verdict, tally, live.pricePerRequest, localMismatch);
    if (code === undefined) {
      if (tally.unseen === 0) return { sessionId: id, status: "matched" };
      return { sessionId: id, status: await now() < verdict.challengeEnd ? "incomplete" : "expired" };
    }
    const evidence = toWire({ chainId, escrow, buyer: account.address, verifier: live.verifier, closeTxHash: verdict.closeTxHash,
      verdict, tally, reasonCode: code, requests: verified.map(entry => entry.request) });
    return submit(verdict, join(directory, `${id}.json`), evidence, code);
  }

  async function check(): Promise<BuyerChallengeResult[]> {
    await discover();
    const results: BuyerChallengeResult[] = [];
    for (const [id, verdict] of pending) {
      try {
        const result = await reconcile(verdict);
        results.push(result);
        if (result.status !== "incomplete" && result.status !== "retry") {
          submissions.delete(id);
          pending.delete(id);
        }
      } catch {
        results.push({ sessionId: id, status: "retry" });
      }
    }
    return results;
  }

  function poll(): Promise<BuyerChallengeResult[]> {
    running ??= check().finally(() => { running = undefined; });
    return running;
  }
  function start(): void {
    if (timer) return;
    const tick = () => { void poll().catch(() => {}); };
    timer = setInterval(tick, 5000);
    timer.unref();
    tick();
  }
  function stop(): void {
    clearInterval(timer);
    timer = undefined;
  }
  return { start, stop, poll };
}
