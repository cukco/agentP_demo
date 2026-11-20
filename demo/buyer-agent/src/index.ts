import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAgentPayBuyer, createFileBuyerStore, type BuyerCommonOptions } from "@agentpay/buyer";
import { CHAIN_ID, DEPLOYMENTS, SessionState, agentPaySessionEscrowAbi } from "@agentpay/core";
import { createPriceChecks, createPriceReader, PRICE_PER_REQUEST } from "@agentpay-demo/seller-avax-price";
import { createPublicClient, createWalletClient, formatUnits, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche, avalancheFuji } from "viem/chains";
import { faultSwitch, runInjection, runPaidDemo, verifyOnlyTransport } from "./run.js";

export const COMPONENT = "@agentpay-demo/buyer-agent" as const;
export * from "./run.js";

const opened = agentPaySessionEscrowAbi.find(item => item.type === "event" && item.name === "SessionOpened")!;
const closed = agentPaySessionEscrowAbi.find(item => item.type === "event" && item.name === "SessionClosed")!;
const settled = agentPaySessionEscrowAbi.find(item => item.type === "event" && item.name === "Settled")!;
const feedback = agentPaySessionEscrowAbi.find(item => item.type === "event" && item.name === "FeedbackGiven")!;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Configure ${name}`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values: { mode, calls, scenario } } = parseArgs({ args, options: {
    mode: { type: "string", default: "approve" }, calls: { type: "string", default: "18" },
    scenario: { type: "string", default: "paid" },
  } });
  if ((mode !== "auto" && mode !== "approve") || !["paid", "injection", "all"].includes(scenario!) ||
      (scenario === "all" && calls !== "18")) throw new Error("Invalid demo mode, calls or scenario");
  const sellerUrl = required("SELLER_URL");
  const facilitatorUrl = required("FACILITATOR_URL");
  const escrow = process.env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow;
  const verifier = process.env.VERIFIER_ADDRESS ?? DEPLOYMENTS.fuji.verifier;
  if (!isAddress(escrow) || !isAddress(verifier)) throw new Error("Invalid demo contracts");
  const endpoint = required("VERIFIER_URL");
  const transport = http(required("FUJI_RPC_URL_1"));
  const publicClient = createPublicClient({ chain: avalancheFuji, transport });
  const oracle = createPublicClient({ chain: avalanche, transport: http(required("AVAX_MAINNET_RPC_URL_1")) });
  const [paymentChain, oracleChain] = await Promise.all([publicClient.getChainId(), oracle.getChainId()]);
  if (paymentChain !== CHAIN_ID.fuji || oracleChain !== CHAIN_ID.avalanche) throw new Error("Wrong RPC network");
  const clock = () => Math.floor(Date.now() / 1000);
  let reference: number | undefined;
  const options: BuyerCommonOptions = { chainId: CHAIN_ID.fuji, publicClient, trustedEscrows: [escrow],
    facilitatorUrl, scorerUrl: required("SCORER_URL"), defaultCap: 1_000_000n, defaultExpirySec: 3600, clock,
    store: createFileBuyerStore(join(homedir(), ".agentpay", "demo", randomUUID())),
    softPolicy: { maxPerSession: 1_000_000n, maxPricePerRequest: PRICE_PER_REQUEST },
    ...createPriceChecks({ address: verifier, endpoint }, createPriceReader(oracle), clock, value => { reference = value; }),
  };
  function auto() {
    const key = required("BUYER_AUTO_PRIVATE_KEY");
    if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("Invalid BUYER_AUTO_PRIVATE_KEY");
    const account = privateKeyToAccount(key as `0x${string}`);
    return { mode: "auto" as const, account, walletClient: createWalletClient({ chain: avalancheFuji, transport, account }) };
  }

  const injection = scenario === "paid" ? undefined : { credentials: auto(), lowScoreSellerUrl: required("LOW_SCORE_SELLER_URL") };
  let gas: bigint | undefined;
  if (scenario !== "injection") {
    const sellerFaultToken = required("DEMO_FAULT_TOKEN");
    const buyerAddress = process.env.BUYER_MAIN_ADDRESS;
    const credentials = mode === "auto" ? auto() : {
      mode: "approve" as const, buyerAddress: buyerAddress as `0x${string}`,
      onApprovalUrl: (url: string) => console.log(`Open this one-time link in the MetaMask browser: ${url}`),
    };
    const address = "account" in credentials ? credentials.account.address : credentials.buyerAddress;
    if (!isAddress(address)) throw new Error("Configure BUYER_MAIN_ADDRESS");
    const policy = await publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "buyerPolicy", args: [address] });
    console.log(`EOA policy · cap ${formatUnits(policy.maxPerSession, 6)} USDC · daily ${formatUnits(policy.dailyCap, 6)} USDC · minimum score ${policy.minScore}`);
    const buyer = createAgentPayBuyer({ ...options, ...credentials });
    const fromBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    await runPaidDemo({ buyer, sellerUrl, calls: Number(calls), setFault: faultSwitch(sellerUrl, sellerFaultToken),
      log: console.log, referencePrice: () => reference,
      // Verifier /health reads mainnet, so the first oracle check reuses a warm connection (cold TLS > 400 ms budget).
      async warmUp() { await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.body?.cancel()); },
      async waitForSettlement(id) {
        const sessionId = BigInt(id);
        const deadline = clock() + 120;
        let state: number = SessionState.OPEN;
        let reportedClose = false;
        while (clock() < deadline) {
          ({ state } = await publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [sessionId] }));
          if (state === SessionState.CLOSING && !reportedClose) {
            console.log("Verifier closed the session. Waiting for Keeper to finalize.");
            reportedClose = true;
          }
          if (state === SessionState.SETTLED) break;
          if (state !== SessionState.OPEN && state !== SessionState.CLOSING) throw new Error("Session ended outside the demo settlement flow");
          await delay(1000);
        }
        if (state !== SessionState.SETTLED) throw new Error("Timed out waiting for Verifier/Keeper settlement");
        const filter = { address: escrow, args: { sessionId }, fromBlock, strict: true as const };
        const [[open], [close], [payout], entries] = await Promise.all([
          publicClient.getLogs({ ...filter, event: opened }), publicClient.getLogs({ ...filter, event: closed }),
          publicClient.getLogs({ ...filter, event: settled }), publicClient.getLogs({ ...filter, event: feedback }),
        ]);
        if (!open || !close || !payout || close.args.passCount !== 15 || close.args.failCount !== 3) {
          throw new Error("Unexpected settlement events");
        }
        console.log(`Open tx ${open.transactionHash} · close tx ${close.transactionHash} · finalize tx ${payout.transactionHash}`);
        console.log(`Seller +${formatUnits(payout.args.toSeller, 6)} USDC · buyer refund ${formatUnits(payout.args.toBuyer, 6)} USDC · fee ${formatUnits(payout.args.fee, 6)} USDC`);
        const scored = entries.find(entry => entry.args.ok && entry.args.tag2 === "session");
        if (!scored) throw new Error("ERC-8004 feedback was not recorded");
        console.log(`ERC-8004 feedback ${scored.args.value} for agent ${scored.args.agentId}`);
        gas = (await Promise.all([...new Set([open.transactionHash, close.transactionHash, payout.transactionHash])].map(hash =>
          publicClient.getTransactionReceipt({ hash })))).reduce((total, receipt) => total + receipt.gasUsed, 0n);
      },
    });
  }
  if (injection) {
    const buyer = createAgentPayBuyer({ ...options, ...injection.credentials, fetch: verifyOnlyTransport(facilitatorUrl),
      softPolicy: { maxPerSession: 20_000_000n, maxPricePerRequest: PRICE_PER_REQUEST },
    });
    await runInjection({ buyer, sellerUrl, lowScoreSellerUrl: injection.lowScoreSellerUrl, log: console.log });
  }
  if (gas !== undefined) console.log(`18 requests · ${gas} gas measured for open, close and finalize · baseline estimate 18 × 503,000 gas`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    // One short line (no stack, no env) so a failed take shows why, e.g. OverDailyCap or a timeout.
    const reason = error instanceof Error ? `${error.name}: ${error.message.split(/\r?\n/, 1)[0]!.slice(0, 160)}` : "unknown error";
    console.error(`Buyer demo stopped (${reason}). Check Seller/Verifier/Scorer/Facilitator, wallet policy and Keeper.`);
    process.exitCode = 1;
  });
}
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
