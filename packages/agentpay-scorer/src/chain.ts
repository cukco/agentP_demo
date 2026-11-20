import { agentPaySessionEscrowAbi } from "@agentpay/core";
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";
import type { SettledSession } from "./score/real.js";

export const identityAbi = parseAbi([
  "function getMetadata(uint256 agentId, string key) view returns (bytes)",
]);
export const reputationAbi = parseAbi([
  "function getSummary(uint256 agentId,address[] clients,string tag1,string tag2) view returns (uint64 count,int128 value,uint8 decimals)",
]);
export interface ChainConfig {
  escrow: Address;
  identity: Address;
  reputation: Address;
  startBlock: bigint;
  chainId: number;
}

/** Parallel getSession reads per round trip; keeps public RPC rate limits in mind. */
const SESSION_READ_BATCH = 8;

export function createChain(client: PublicClient, config: ChainConfig) {
  const opened = agentPaySessionEscrowAbi.find(
    (e) => e.type === "event" && e.name === "SessionOpened",
  )!;
  const feedback = agentPaySessionEscrowAbi.find(
    (e) => e.type === "event" && e.name === "FeedbackGiven",
  )!;
  type Entry = {
    block: bigint;
    kind: "open" | "feedback";
    args: Record<string, unknown>;
  };
  let indexed: bigint | undefined,
    entries: Entry[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  // SETTLED/REFUNDED sessions never change, so read them once. Without this every score
  // re-read every past session one by one, and attestations got slower with each session.
  type Session = Awaited<ReturnType<typeof readSession>>;
  const finals = new Map<bigint, Session>();
  function readSession(id: bigint, blockNumber: bigint) {
    return client.readContract({
      address: config.escrow,
      abi: agentPaySessionEscrowAbi,
      functionName: "getSession",
      args: [id],
      blockNumber,
    });
  }
  async function readSessions(ids: bigint[], head: bigint) {
    const out = new Map<bigint, Session>();
    const todo = ids.filter((id) => {
      const cached = finals.get(id);
      if (cached) out.set(id, cached);
      return !cached;
    });
    for (let i = 0; i < todo.length; i += SESSION_READ_BATCH) {
      const batch = todo.slice(i, i + SESSION_READ_BATCH);
      const read = await Promise.all(batch.map((id) => readSession(id, head)));
      read.forEach((s, j) => {
        out.set(batch[j]!, s);
        if (s.state === 4 || s.state === 5) finals.set(batch[j]!, s);
      });
    }
    return out;
  }
  function snapshot() {
    const work = pending.then(async () => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      if (indexed !== undefined && head < indexed) finals.clear();
      // Rescan the recent tail; a chain rewind invalidates the complete cached prefix.
      const from =
        indexed === undefined || head < indexed
          ? config.startBlock
          : indexed - 64n > config.startBlock
            ? indexed - 64n
            : config.startBlock;
      const next = entries.filter((e) => e.block < from);
      for (let start = from; start <= head; start += 2000n) {
        const end = start + 1999n < head ? start + 1999n : head;
        const [opens, feedbacks] = await Promise.all([
          client.getLogs({
            address: config.escrow,
            event: opened,
            fromBlock: start,
            toBlock: end,
            strict: true,
          }),
          client.getLogs({
            address: config.escrow,
            event: feedback,
            fromBlock: start,
            toBlock: end,
            strict: true,
          }),
        ]);
        for (const log of opens)
          next.push({ block: log.blockNumber!, kind: "open", args: log.args });
        for (const log of feedbacks)
          next.push({
            block: log.blockNumber!,
            kind: "feedback",
            args: log.args,
          });
      }
      // Publish only after every page succeeded; incomplete RPC history cannot become a score.
      indexed = head;
      entries = next;
      return { head, entries: next };
    });
    pending = work.catch(() => {});
    return work;
  }
  return {
    async wallet(agentId: bigint): Promise<Address> {
      const raw = await client.readContract({
        address: config.identity,
        abi: identityAbi,
        functionName: "getMetadata",
        args: [agentId, "agentWallet"],
      });
      if (!/^0x[\da-f]{40}$/i.test(raw) || /^0x0{40}$/.test(raw))
        throw new Error("Unregistered agent wallet");
      return getAddress(raw);
    },
    async history(agentId: bigint) {
      const { head, entries } = await snapshot();
      const sessions = new Set<bigint>(),
        values = new Map<bigint, number>();
      let feedbackCount = 0n;
      for (const entry of entries) {
        const a = entry.args;
        if (entry.kind === "open") {
          if (a.sellerAgentId === agentId) sessions.add(a.sessionId as bigint);
        } else if (a.agentId === agentId) {
          if (a.ok) feedbackCount++;
          values.set(
            a.sessionId as bigint,
            (values.get(a.sessionId as bigint) ?? 0) + Number(a.value),
          );
        }
      }
      const summary = await client.readContract({
        address: config.reputation,
        abi: reputationAbi,
        functionName: "getSummary",
        args: [agentId, [config.escrow], "agentpay", ""],
        blockNumber: head,
      });
      if (summary[0] !== feedbackCount)
        throw new Error("Incomplete escrow history: reputation count mismatch");
      const result: SettledSession[] = [];
      const read = await readSessions([...sessions], head);
      for (const id of sessions) {
        const s = read.get(id)!;
        if ((s.state !== 4 && s.state !== 5) || !values.has(id)) continue;
        result.push({
          id: id.toString(),
          buyer: s.buyer,
          seller: s.seller,
          passedAmount: s.passedAmount,
          value: values.get(id)!,
        });
      }
      return {
        sessions: result,
        summary: {
          count: summary[0].toString(),
          value: summary[1].toString(),
          decimals: summary[2],
        },
        block: head.toString(),
      };
    },
  };
}
export type ScorerChain = ReturnType<typeof createChain>;
