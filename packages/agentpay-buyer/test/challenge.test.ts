import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAIN_ID, ChallengeReason, NETWORK, Outcome, SessionState, USDC_DOMAIN, ZERO_HASH, agentPaySessionEscrowAbi,
  bodyHash, fromWire, receiptsRoot, requestHash, signDelivery, signReceipt, signSessionVerdict, signVoucher, specHash, toWire,
  type PaymentRequired, type Receipt, type VerificationSpec,
} from "@agentpay/core";
import { erc20Abi } from "viem";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AGENT_ID, startChain, type TestChain } from "../../agentpay-keeper/test/helpers/chain.js";
import { createBuyerChallengeWatcher, createMemoryBuyerStore, type BuyerRequestRecord, type BuyerSession } from "../src/index.js";

const event = agentPaySessionEscrowAbi.find(item => item.type === "event" && item.name === "Challenged")!;
const chainId = CHAIN_ID.fuji;
const price = 1_500_000n;
const cap = 5_000_000n;
const url = "https://seller.example/v1/file";
const body = Uint8Array.of(0, 255, 13, 10);

let chain: TestChain;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentpay-evidence-"));
  chain = await startChain({ chainId });
}, 120_000);
afterAll(async () => {
  await chain?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(options: { outcome: Outcome; verdictPass: 0 | 1; rootMismatch?: boolean; recheckMismatch?: boolean; receiptMissing?: boolean }) {
  const { escrow, publicClient, usdc } = chain;
  const { buyer, seller, verifier } = chain.accounts;
  const store = createMemoryBuyerStore();
  const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
  const spec: VerificationSpec = { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
    verifier: { address: verifier.address, endpoint: "https://verifier.example" },
    delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
    checks: [{ type: "hash-match", id: "file", expectedHash: options.recheckMismatch ? ZERO_HASH : bodyHash(body) }] };
  const payment: PaymentRequired = { x402Version: 2, resource: { url },
    accepts: [{ scheme: "agentpay-session", network: NETWORK.fuji, asset: usdc, amount: price.toString(),
      payTo: escrow, maxTimeoutSeconds: 120, extra: USDC_DOMAIN }],
    extensions: { agentpay: { version: "0.2", verificationSpec: spec,
      session: { contract: escrow, chainId, seller: seller.address, sellerAgentId: AGENT_ID.toString(),
        pricePerRequest: price.toString(), minCap: cap.toString(), maxCap: cap.toString(),
        defaultExpirySec: 3600, maxExpirySec: 86400, deliveryDeadlineSec: 10, challengeWindowSec: 60 },
    } },
  };
  const digest = specHash(spec);
  const id = await chain.open({ cap, pricePerRequest: price, specHash: digest });
  let clock = Number(await chain.now());

  async function record(seq: number, outcome: Outcome): Promise<BuyerRequestRecord> {
    const base = { sessionId: id, seq, requestHash: requestHash("GET", url) };
    const voucher = await signVoucher(buyer, chainId, escrow, { ...base, cumulativeAmount: BigInt(seq) * price });
    const delivery = await signDelivery(seller, chainId, escrow, { ...base, specHash: digest, bodyHash: bodyHash(body) });
    const receipt = await signReceipt(verifier, chainId, escrow, { ...base, bodyHash: bodyHash(body),
      outcome, reasonCode: outcome === Outcome.PASS ? 0 : 15, amount: outcome === Outcome.PASS ? price : 0n,
      receivedAt: BigInt(clock), evidenceHash: ZERO_HASH });
    return { voucher: toWire(voucher), delivery: toWire(delivery),
      receipt: toWire(receipt), bodyBase64: Buffer.from(body).toString("base64"),
      localOutcome: options.recheckMismatch && seq === 1 ? Outcome.FAIL : outcome };
  }

  const first = await record(1, options.outcome);
  const later = await record(2, Outcome.PASS);
  const session: BuyerSession = { id: id.toString(), payment, buyer: buyer.address, status: "closing",
    requests: [options.receiptMissing ? { voucher: first.voucher } : first, later],
    ...(options.recheckMismatch && { challenge: "RECHECK_MISMATCH" }),
  };
  await store.save(session);

  const lastSeq = 1;
  const passCount = options.verdictPass;
  const verdict = await signSessionVerdict(verifier, chainId, escrow, {
    sessionId: id, specHash: digest, lastSeq, passCount, failCount: 1 - passCount, inconclusiveCount: 0,
    passedAmount: BigInt(passCount) * price,
    receiptsRoot: options.rootMismatch ? ZERO_HASH : receiptsRoot([fromWire<Receipt>("Receipt", first.receipt!.message)]),
    closedAt: BigInt(clock),
  });
  const tx = await chain.wallet("verifier").writeContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "closeSession",
    args: [id, fromWire("Voucher", first.voucher.message), first.voucher.signature, verdict.message, verdict.signature],
  });
  expect((await publicClient.waitForTransactionReceipt({ hash: tx })).status).toBe("success");
  const watcher = createBuyerChallengeWatcher({ chainId, escrow, account: buyer, publicClient,
    walletClient: chain.wallet("buyer"), store, clock: () => clock, fromBlock, evidenceDirectory: directory });
  const onchain = await publicClient.readContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [id],
  });
  return { id, fromBlock, watcher, session, first, store, onchain, path: join(directory, `${id}.json`),
    setClock: (value: bigint) => { clock = Number(value); } };
}

it("challenges a FAIL counted as PASS using the actual required bond and persists Arbiter evidence", async () => {
  const { id, watcher, path, first, fromBlock } = await fixture({ outcome: Outcome.FAIL, verdictPass: 1 });
  const { publicClient, escrow, usdc } = chain;
  const buyer = chain.accounts.buyer.address;
  const bond = await publicClient.readContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "requiredBond", args: [id, buyer],
  });
  expect(bond).toBe(150_000n); // Above MIN_BOND so a constant bond would fail this test.
  const balance = () => publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [buyer] });
  const before = await balance();
  const [result] = await Promise.all([watcher.poll(), watcher.poll()]);
  expect(result).toEqual([{ sessionId: id.toString(), status: "challenged",
    reasonCode: ChallengeReason.RECEIPT_FAIL_COUNTED_PASS, txHash: expect.any(String) }]);
  expect(await chain.state(id)).toBe(SessionState.CHALLENGED);
  expect(await balance()).toBe(before - bond);

  const logs = await publicClient.getLogs({ address: escrow, event, args: { sessionId: id }, fromBlock, strict: true });
  expect(logs).toHaveLength(1);
  expect(logs[0]!.args).toMatchObject({ challenger: buyer, reasonCode: 1, bond });
  const evidence = JSON.parse(await readFile(path, "utf8"));
  expect(evidence).toMatchObject({ reasonCode: 1, bond: bond.toString(), challengeTxHash: result[0]!.txHash,
    verdict: { lastSeq: 1, passCount: 1, passedAmount: price.toString() },
    tally: { passCount: 0, failCount: 1, passedAmount: "0" }, requests: [first] });
  expect(evidence.requests).toHaveLength(1);
  expect(await watcher.poll()).toEqual([]);
});

it("leaves a matching verdict unchanged, even with Receipt evidence after lastSeq", async () => {
  const { id, watcher, path } = await fixture({ outcome: Outcome.PASS, verdictPass: 1 });
  expect(await watcher.poll()).toEqual([{ sessionId: id.toString(), status: "matched" }]);
  expect(await chain.state(id)).toBe(SessionState.CLOSING);
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("submits reason 3 for a stored local FAIL against a signed PASS", async () => {
  const { id, watcher, path } = await fixture({ outcome: Outcome.PASS, verdictPass: 1, recheckMismatch: true });
  expect(await watcher.poll()).toMatchObject([{ sessionId: id.toString(), status: "challenged", reasonCode: 3 }]);
  expect(JSON.parse(await readFile(path, "utf8")).requests[0]).toMatchObject({ localOutcome: Outcome.FAIL });
});

it("compares the Merkle root even when the amounts and tallies match", async () => {
  const { id, watcher } = await fixture({ outcome: Outcome.PASS, verdictPass: 1, rootMismatch: true });
  expect(await watcher.poll()).toMatchObject([{ sessionId: id.toString(), status: "challenged", reasonCode: ChallengeReason.OTHER }]);
});

it("uses the missing PASS reason when a signed PASS is excluded from the tally", async () => {
  const { id, watcher } = await fixture({ outcome: Outcome.PASS, verdictPass: 0 });
  expect(await watcher.poll()).toMatchObject([{ sessionId: id.toString(), status: "challenged",
    reasonCode: ChallengeReason.MISSING_PASS_RECEIPT }]);
});

it("retries when a Receipt is still missing and challenges when the signed contradiction arrives", async () => {
  const { id, watcher, store, session, first } = await fixture({ outcome: Outcome.FAIL, verdictPass: 1, receiptMissing: true });
  expect(await watcher.poll()).toEqual([{ sessionId: id.toString(), status: "incomplete" }]);
  expect(await chain.state(id)).toBe(SessionState.CLOSING);
  session.requests[0] = first;
  await store.save(session);
  expect(await watcher.poll()).toMatchObject([{ status: "challenged", reasonCode: 1 }]);
});

it("does not challenge from a partial Merkle tree while receipts are still missing", async () => {
  const { id, watcher } = await fixture({ outcome: Outcome.PASS, verdictPass: 1, rootMismatch: true, receiptMissing: true });
  expect(await watcher.poll()).toEqual([{ sessionId: id.toString(), status: "incomplete" }]);
  expect(await chain.state(id)).toBe(SessionState.CLOSING);
});

it.each([0n, 1n])("never submits at challengeEnd + %s, and still preserves the evidence", async offset => {
  const { id, watcher, path, onchain, setClock, fromBlock } = await fixture({ outcome: Outcome.FAIL, verdictPass: 1 });
  setClock(onchain.challengeEnd + offset);
  expect(await watcher.poll()).toEqual([{ sessionId: id.toString(), status: "expired", reasonCode: 1 }]);
  expect(await chain.state(id)).toBe(SessionState.CLOSING);
  expect(JSON.parse(await readFile(path, "utf8")).reasonCode).toBe(1);
  expect(await chain.publicClient.getLogs({ address: chain.escrow, event, args: { sessionId: id }, fromBlock })).toEqual([]);
});
