import { expect, it } from "vitest";
import { createBuyerChallengeWatcher } from "@agentpay/buyer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../helpers.js";
import { sdkFixture } from "../sdk-fixture.js";
const get = fixture();
it("E5: Buyer SDK rejects a signed false PASS; Arbiter upholds, corrects payment and returns bond", async () => {
  const s = get(),
    before = await s.balances(),
    sdk = await sdkFixture(s, true);
  const watcher = createBuyerChallengeWatcher({
    chainId: 43113,
    escrow: s.chain.escrow,
    account: s.chain.accounts.buyer,
    publicClient: s.chain.publicClient,
    walletClient: s.chain.wallet("buyer"),
    store: sdk.buyerStore,
    clock: s.clock,
    fromBlock: s.chain.deployBlock,
    evidenceDirectory: sdk.directory,
  });
  try {
    await expect(sdk.buyer.fetch(sdk.url)).rejects.toThrow(
      "Buyer checks could not confirm",
    );
    const [session] = await sdk.buyerStore.list(),
      id = BigInt(session.id);
    expect(session.challenge).toBe("RECHECK_MISMATCH");
    expect(await s.chain.state(id)).toBe(2);
    const actions = await watcher.poll();
    expect(actions).toMatchObject([{ status: "challenged", reasonCode: 3 }]);
    expect(await s.chain.state(id)).toBe(3);
    const evidence = JSON.parse(
      await readFile(join(sdk.directory, `${id}.json`), "utf8"),
    );
    expect(evidence.reasonCode).toBe(3);
    const challenged = await s.balances();
    expect(before.buyer - challenged.buyer).toBe(
      1_000_000n + BigInt(evidence.bond),
    );
    await s.write("resolveChallenge", [id, 0, 1, true]);
    expect(await s.chain.state(id)).toBe(4);
    const after = await s.balances();
    expect(before.buyer - after.buyer).toBe(40_000n); // Only session fee; cap and bond are returned.
    expect(after.seller).toBe(before.seller);
    expect(after.escrow - before.escrow).toBe(40_000n);
  } finally {
    watcher.stop();
    await sdk.stop();
  }
}, 120_000);
