/** Opt-in Fuji testnet smoke. Uses existing demo wallets, never alters buyer policy or registry metadata. */
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { createAgentPayBuyer, createMemoryBuyerStore } from "@agentpay/buyer";
import { createAgentPaySeller } from "@agentpay/seller";
import { createCheckRunner } from "@agentpay/verifier/checks";
import {
  DEPLOYMENTS,
  agentPaySessionEscrowAbi,
  bodyHash,
  type VerificationSpec,
} from "@agentpay/core";
import { setTimeout as delay } from "node:timers/promises";
if (process.env.FUJI_WRITE_TEST !== "1")
  throw new Error(
    "Set FUJI_WRITE_TEST=1 to spend Fuji test tokens (cap 1 test USDC)",
  );
const env = {
  ...parseEnv(await readFile(process.argv[2] ?? "../../.env", "utf8")),
  ...process.env,
};
const d = DEPLOYMENTS.fuji,
  transport = fallback(
    [env.FUJI_RPC_URL_1, env.FUJI_RPC_URL_2]
      .filter((url): url is string => Boolean(url))
      .map((url) => http(url, { timeout: 8000, retryCount: 0 })),
    { retryCount: 0 },
  ),
  client = createPublicClient({ chain: avalancheFuji, transport });
if ((await client.getChainId()) !== 43113)
  throw new Error("Only Fuji is supported");
if (env.AGENTPAY_ESCROW?.toLowerCase() !== d.escrow.toLowerCase())
  throw new Error("Expected the reviewed Fuji deployment");
const buyerAccount = privateKeyToAccount(env.BUYER_AUTO_PRIVATE_KEY as Hex),
  sellerAccount = privateKeyToAccount(env.SELLER_PRIVATE_KEY as Hex);
const clock = () => Math.floor(Date.now() / 1000),
  verifierUrl = env.VERIFIER_URL ?? "http://127.0.0.1:8787";
const token = parseAbi(["function balanceOf(address) view returns(uint256)"]);
const balances = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        ["buyer", buyerAccount.address],
        ["seller", sellerAccount.address],
        ["escrow", d.escrow],
      ].map(async ([role, address]) => [
        role,
        await client.readContract({
          address: d.usdc,
          abi: token,
          functionName: "balanceOf",
          args: [address as Hex],
        }),
      ]),
    ),
  ) as Record<string, bigint>;
const before = await balances();
if (before.buyer < 1000000n) throw new Error("Buyer needs one Fuji test USDC");
const good = Buffer.from("AgentPay Fuji backend smoke"),
  spec: VerificationSpec = {
    specVersion: "agentpay-verify/0.2",
    serviceType: "file",
    passRule: "all",
    verifier: { address: d.verifier, endpoint: verifierUrl },
    delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
    checks: [{ id: "hash", type: "hash-match", expectedHash: bodyHash(good) }],
  };
const seller = createAgentPaySeller({
  account: sellerAccount,
  chainId: 43113,
  escrow: d.escrow,
  asset: d.usdc,
  publicClient: client,
  walletClient: createWalletClient({
    chain: avalancheFuji,
    transport,
    account: sellerAccount,
  }),
  sellerAgentId: BigInt(env.SELLER_AGENT_ID!),
  pricePerRequest: 10000n,
  spec,
  verifierUrl,
  clock,
  terms: {
    minCap: 500000n,
    maxCap: 20000000n,
    defaultExpirySec: 600,
    maxExpirySec: 3600,
    deliveryDeadlineSec: 10,
    challengeWindowSec: 30,
  },
});
const app = new Hono();
let delivered = 0;
app.use("/v1/file", seller.middleware());
app.get(
  "/v1/file",
  () =>
    new Response(++delivered <= 15 ? good : Buffer.from("wrong result"), {
      headers: { "content-type": "application/octet-stream" },
    }),
);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4021 });
let id: bigint | undefined;
let buyer: ReturnType<typeof createAgentPayBuyer> | undefined;
let finished = false;
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const checks = createCheckRunner(),
    store = createMemoryBuyerStore();
  buyer = createAgentPayBuyer({
    mode: "auto",
    account: buyerAccount,
    walletClient: createWalletClient({
      chain: avalancheFuji,
      transport,
      account: buyerAccount,
    }),
    chainId: 43113,
    publicClient: client,
    trustedEscrows: [d.escrow],
    facilitatorUrl: env.FACILITATOR_URL ?? "http://127.0.0.1:8786",
    scorerUrl: env.SCORER_URL ?? "http://127.0.0.1:8788",
    clock,
    store,
    defaultCap: 1000000n,
    defaultExpirySec: 600,
    softPolicy: { maxPerSession: 1000000n, maxPricePerRequest: 10000n },
    checks: async (input) => (await checks(input)).outcome,
  });
  const fromBlock = await client.getBlockNumber(),
    url = "http://localhost:4021/v1/file";
  id = BigInt(await buyer.openSession(url, { cap: 1000000n, expirySec: 600 }));
  console.log(JSON.stringify({ event: "fuji_open", sessionId: id.toString() }));
  for (let n = 1; n <= 18; n++) {
    try {
      const response = await buyer.fetch(url);
      if (n > 15 || (await response.text()) !== good.toString())
        throw new Error("Unexpected passing result");
    } catch (error) {
      if (
        n <= 15 ||
        !(error instanceof Error) ||
        !error.message.includes("did not PASS")
      )
        throw error;
    }
  }
  const deadline = clock() + 120;
  let state = 1;
  while (clock() < deadline) {
    const s = await client.readContract({
      address: d.escrow,
      abi: agentPaySessionEscrowAbi,
      functionName: "getSession",
      args: [id],
    });
    state = s.state;
    if (state === 4) break;
    if (![1, 2].includes(state)) throw new Error("Unexpected terminal state");
    await delay(1000);
  }
  if (state !== 4) throw new Error("Settlement timeout");
  const snapshot = await client.readContract({
    address: d.escrow,
    abi: agentPaySessionEscrowAbi,
    functionName: "getSession",
    args: [id],
  });
  const expectedCost = 150000n + snapshot.sessionFee,
    expectedSeller = 150000n - (150000n * BigInt(snapshot.feeBps)) / 10000n;
  const after = await balances(),
    status = await (await fetch(`${verifierUrl}/v1/sessions/${id}`)).json();
  if (
    status.passCount !== 15 ||
    status.failCount !== 3 ||
    before.buyer - after.buyer !== expectedCost ||
    after.seller - before.seller !== expectedSeller
  )
    throw new Error("Unexpected counts or settlement amounts");
  const events = await client.getContractEvents({
    address: d.escrow,
    abi: agentPaySessionEscrowAbi,
    fromBlock,
    toBlock: "latest",
  });
  const relevant = events.filter(
    (e) => "sessionId" in e.args && e.args.sessionId === id,
  );
  const report = {
    network: "fuji",
    chainId: 43113,
    escrow: d.escrow,
    sessionId: id.toString(),
    mode: "auto",
    seller: "SDK file fixture (not AVAX price feed)",
    status,
    snapshot,
    before,
    after,
    events: relevant.map((e) => ({
      name: e.eventName,
      transactionHash: e.transactionHash,
      args: e.args,
    })),
  };
  const text =
    JSON.stringify(
      report,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n";
  if (process.env.FUJI_REPORT) await writeFile(process.env.FUJI_REPORT, text);
  finished = true;
  console.log(
    JSON.stringify({
      event: "fuji_smoke_pass",
      sessionId: id.toString(),
      pass: 15,
      fail: 3,
      buyerCost: expectedCost.toString(),
      sellerPaid: expectedSeller.toString(),
      transactions: [...new Set(relevant.map((e) => e.transactionHash))],
    }),
  );
} finally {
  if (id && !finished && buyer)
    await buyer
      .close(id)
      .catch(() => console.error("Fuji session needs closer recovery"));
  seller.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
  if (id)
    console.log(
      JSON.stringify({
        event: "fuji_session_reference",
        sessionId: id.toString(),
      }),
    );
}
