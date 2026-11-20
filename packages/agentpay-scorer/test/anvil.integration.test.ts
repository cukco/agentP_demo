import { afterAll, beforeAll, expect, it } from "vitest";
import { fromWire, agentPaySessionEscrowAbi, openNonce, signReceiveAuthorization, type OpenParams, type ScoreAttestation } from "@agentpay/core";
import { keccak256, parseAbi, toHex, type Address } from "viem";
import { startChain, AGENT_ID, SPEC, type TestChain } from "../../agentpay-keeper/test/helpers/chain.js";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";

let chain: TestChain;
const db = openDatabase();
let app: ReturnType<typeof createApp>;
let clock = 0;
beforeAll(async () => {
  chain = await startChain({ chainId: 43113 }); clock = Number(await chain.now());
  const read = (name: string) => chain.publicClient.readContract({ address: chain.escrow,
    abi: parseAbi([`function ${name}() view returns (address)`]), functionName: name }) as Promise<Address>;
  app = createApp({ db, publicClient: chain.publicClient, mainnetFetch: async () => { throw new Error("No mainnet in tests"); },
    clock: () => clock, signer: chain.accounts.scorer, config: { escrow: chain.escrow, chainId: 43113,
      identity: await read("identityRegistry"), reputation: await read("reputationRegistry"), startBlock: 0n } });
}, 120000);
afterAll(async () => { db.close(); await chain?.stop(); });

it("real escrow accepts Scorer's attestation, rejects it after expiry; finalized history feeds the score", async () => {
  const a = chain.accounts;
  const response = await app.request(`/v1/attestation/${AGENT_ID}?wallet=${a.seller.address}`);
  expect(response.status).toBe(200);
  const signed = (await response.json()).attestation;
  const att = fromWire<ScoreAttestation>("ScoreAttestation", signed.message);
  async function open(saltText: string) {
    const now = await chain.now();
    const params: OpenParams = { seller: a.seller.address, sellerAgentId: AGENT_ID, verifier: a.verifier.address,
      voucherSigner: a.buyer.address, specHash: SPEC, cap: 1000000n, pricePerRequest: 10000n,
      expiry: now + 3600n, deliveryDeadlineSec: 10, challengeWindowSec: 60 };
    const salt = keccak256(toHex(saltText));
    const auth = { from: a.buyer.address, value: params.cap, validAfter: 0n, validBefore: now + 120n, nonce: openNonce(params, salt) };
    const sig = await signReceiveAuthorization(a.buyer, 43113, chain.usdc, { ...auth, to: chain.escrow });
    return chain.publicClient.simulateContract({ address: chain.escrow, abi: agentPaySessionEscrowAbi,
      account: a.owner, functionName: "openWithAuthorization", args: [params, salt, { ...auth, ...sig }, att, signed.signature] });
  }
  const simulation = await open("valid");
  const tx = await chain.wallet("owner").writeContract(simulation.request);
  expect((await chain.publicClient.waitForTransactionReceipt({ hash: tx })).status).toBe("success");
  const id = await chain.open();
  await chain.close(id, 15, 15, 0);
  await chain.advance(61);
  const hash = await chain.wallet("owner").writeContract({ address: chain.escrow, abi: agentPaySessionEscrowAbi,
    functionName: "finalize", args: [id] });
  await chain.publicClient.waitForTransactionReceipt({ hash });
  clock = Number(await chain.now());
  expect(await (await app.request(`/v1/score/${AGENT_ID}`)).json()).toMatchObject({ realScore: 100, distinctBuyers: 1, sessions: 1, score: 17, flags: 0 });
  await chain.advance(3601); clock = Number(await chain.now());
  await expect(open("expired")).rejects.toThrow(/AttestationExpired/);
}, 120000);
