import { describe, expect, it } from "vitest";
import { DEPLOYMENTS, agentPaySessionEscrowAbi } from "@agentpay/core";
import { isAddress, parseAbi } from "viem";
import { startStack } from "../../src/harness.js";

describe.skipIf(process.env.E2E_FORK !== "1")(
  "Fuji fork: real USDC and ERC-8004",
  () => {
    it("registers seller, opens through Scorer/Facilitator, settles via Keeper and reads real feedback", async () => {
      const url = process.env.FUJI_RPC_URL_1;
      const fundingAddress =
        process.env.FORK_FUNDING_ADDRESS ?? process.env.BUYER_AUTO_ADDRESS;
      if (!url || !fundingAddress || !isAddress(fundingAddress))
        throw new Error(
          "FUJI_RPC_URL_1 and FORK_FUNDING_ADDRESS (or BUYER_AUTO_ADDRESS) are required",
        );
      const s = await startStack({ fork: { url, fundingAddress } });
      try {
        expect(s.chain.mode).toBe("fork");
        expect(s.chain.usdc).toBe(DEPLOYMENTS.fuji.usdc);
        expect(s.chain.identity).toBe(DEPLOYMENTS.fuji.identity);
        const before = await s.balances();
        const { id } = await s.open();
        expect(await s.chain.state(id)).toBe(1);
        await s.chain.close(id, 15, 15, 0);
        await s.advance(31);
        expect((await s.keeper.runOnce()).map((a) => a.action)).toContain(
          "finalize",
        );
        expect(await s.chain.state(id)).toBe(4);
        const after = await s.balances();
        expect(before.buyer - after.buyer).toBe(190_000n);
        expect(after.seller - before.seller).toBe(149_250n);
        expect(after.escrow).toBe(40_750n);
        const score = await fetch(
          `${s.urls.scorer}/v1/score/${s.chain.agentId}`,
        );
        expect(score.status).toBe(200);
        const summary = await s.chain.publicClient.readContract({
          address: s.reputation,
          abi: parseAbi([
            "function getSummary(uint256,address[],string,string) view returns(uint64,int128,uint8)",
          ]),
          functionName: "getSummary",
          args: [s.chain.agentId, [s.chain.escrow], "agentpay", ""],
        });
        const event = agentPaySessionEscrowAbi.find(
          (e) => e.type === "event" && e.name === "FeedbackGiven",
        )!;
        const feedback = await s.chain.publicClient.getLogs({
          address: s.chain.escrow,
          event,
          fromBlock: s.chain.deployBlock,
          toBlock: "latest",
          strict: true,
        });
        expect(feedback).toHaveLength(1);
        expect(feedback[0].args).toMatchObject({ ok: true, value: 100n });
        expect(summary[0]).toBe(1n);
        const state = await s.chain.publicClient.readContract({
          address: s.chain.escrow,
          abi: agentPaySessionEscrowAbi,
          functionName: "getSession",
          args: [id],
        });
        expect(state.passedAmount).toBe(150_000n);
      } finally {
        await s.stop();
      }
    }, 120_000);
  },
);
