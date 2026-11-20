/**
 * Fuji smoke test (A8 "done when"): open a real $1 session with buyer-auto, close it as the Verifier
 * (3 PASS), wait for the challenge window, and let the Keeper finalize it.
 * Run from repo root:  set -a; . ./.env; set +a; pnpm --filter @agentpay/keeper exec tsx scripts/fuji-smoke.ts
 */
import { createPublicClient, createWalletClient, http, keccak256, parseSignature, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import {
  DEPLOYMENTS,
  TYPES,
  agentPayDomain,
  agentPaySessionEscrowAbi,
  openNonce,
  scorerDomain,
  sessionId as computeSessionId,
  usdcDomain,
  type OpenParams,
} from "@agentpay/core";
import { createKeeper, memoryStore } from "../src/keeper.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const rpc = http(env("FUJI_RPC_URL_1"));
const d = DEPLOYMENTS.fuji;
const pub = createPublicClient({ chain: avalancheFuji, transport: rpc });
const buyer = privateKeyToAccount(env("BUYER_AUTO_PRIVATE_KEY") as Hex);
const verifier = privateKeyToAccount(env("VERIFIER_PRIVATE_KEY") as Hex);
const scorer = privateKeyToAccount(env("SCORER_PRIVATE_KEY") as Hex);
const facilitator = privateKeyToAccount(env("FACILITATOR_PRIVATE_KEY") as Hex);
const keeperAcct = privateKeyToAccount(env("KEEPER_PRIVATE_KEY") as Hex);
const seller = env("SELLER_ADDRESS") as Address;
const agentId = BigInt(env("SELLER_AGENT_ID"));
const wallet = (a: typeof buyer) => createWalletClient({ chain: avalancheFuji, transport: rpc, account: a });
const tx = (h: Hex) => `https://testnet.snowtrace.io/tx/${h}`;

async function main() {
  const now = (await pub.getBlock()).timestamp;
  const price = 10_000n;
  const p: OpenParams = {
    seller,
    sellerAgentId: agentId,
    verifier: verifier.address,
    voucherSigner: buyer.address,
    specHash: keccak256(toHex("fuji-smoke-spec")),
    cap: 1_000_000n,
    pricePerRequest: price,
    expiry: now + 3_600n,
    deliveryDeadlineSec: 10,
    challengeWindowSec: 30,
  };
  const salt = keccak256(toHex(`fuji-smoke-${now}`));
  const nonce = openNonce(p, salt);
  const att = { agentId, wallet: seller, score: 80, flags: 0, validUntil: now + 3_000n };
  const attSig = await scorer.signTypedData({ domain: scorerDomain(43113, d.escrow), types: TYPES.ScoreAttestation, primaryType: "ScoreAttestation", message: att });
  const authSig = await buyer.signTypedData({
    domain: usdcDomain(43113, d.usdc),
    types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: d.escrow, value: p.cap, validAfter: 0n, validBefore: now + 120n, nonce },
  });
  const { v, r, s } = parseSignature(authSig);
  const auth = { from: buyer.address, value: p.cap, validAfter: 0n, validBefore: now + 120n, nonce, v: Number(v), r, s };

  const openHash = await wallet(facilitator).writeContract({ address: d.escrow, abi: agentPaySessionEscrowAbi, functionName: "openWithAuthorization", args: [p, salt, auth, att, attSig] });
  await pub.waitForTransactionReceipt({ hash: openHash });
  const sid = computeSessionId(buyer.address, nonce);
  console.log("open    ", tx(openHash));

  const domain = agentPayDomain(43113, d.escrow);
  const voucher = { sessionId: sid, seq: 3, cumulativeAmount: 3n * price, requestHash: keccak256(toHex("req-3")) };
  const vs = await buyer.signTypedData({ domain, types: TYPES.Voucher, primaryType: "Voucher", message: voucher });
  const verdict = { sessionId: sid, specHash: p.specHash, lastSeq: 3, passCount: 3, failCount: 0, inconclusiveCount: 0, passedAmount: 3n * price, receiptsRoot: keccak256(toHex("root")), closedAt: (await pub.getBlock()).timestamp };
  const ds = await verifier.signTypedData({ domain, types: TYPES.SessionVerdict, primaryType: "SessionVerdict", message: verdict });
  const closeHash = await wallet(verifier).writeContract({ address: d.escrow, abi: agentPaySessionEscrowAbi, functionName: "closeSession", args: [sid, voucher, vs, verdict, ds] });
  await pub.waitForTransactionReceipt({ hash: closeHash });
  console.log("close   ", tx(closeHash));

  const keeper = createKeeper({ publicClient: pub, walletClient: wallet(keeperAcct), escrow: d.escrow, store: memoryStore(), fromBlock: (await pub.getBlockNumber()) - 50n });
  for (let i = 0; i < 20; i++) {
    const res = await keeper.runOnce();
    const mine = res.find((x) => x.sessionId === sid);
    if (mine?.txHash) {
      console.log("finalize", tx(mine.txHash), "(by keeper)");
      const st = await pub.readContract({ address: d.escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [sid] });
      console.log("state   ", st.state === 4 ? "SETTLED" : st.state, "passed", st.passedAmount.toString());
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("keeper did not finalize within 100 s");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
