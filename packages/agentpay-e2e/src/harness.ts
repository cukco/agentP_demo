import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import {
  createApp as scorerApp,
  openDatabase as scorerDatabase,
} from "@agentpay/scorer";
import { createApp as facilitatorApp } from "@agentpay/facilitator";
import { createApp as verifierApp } from "@agentpay/verifier";
import { openDatabase as verifierDatabase } from "@agentpay/verifier/dist/db.js";
import { createBodyCipher } from "@agentpay/verifier/dist/crypto.js";
import { createChain as verifierChain } from "@agentpay/verifier/dist/chain.js";
import { createRuntime } from "@agentpay/verifier/dist/runtime.js";
import { createWriter } from "@agentpay/verifier/dist/writer.js";
import { createSigner } from "@agentpay/verifier/dist/signer.js";
import { createSellerFetch } from "@agentpay/verifier/dist/network.js";
import { createCheckRunner } from "@agentpay/verifier/checks";
import { createKeeper, memoryStore } from "@agentpay/keeper";
import {
  NETWORK,
  SCHEME,
  agentPaySessionEscrowAbi,
  openNonce,
  signReceiveAuthorization,
  toWire,
  type OpenParams,
} from "@agentpay/core";
import {
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hash,
} from "viem";
import { startChain, SPEC, type ChainOptions } from "./chain.js";

/** Real Verifier, Facilitator, Scorer and Keeper; Anvil escrow with optional real Fuji registry fork. */
export async function startStack(options: ChainOptions = {}) {
  const chain = await startChain({ ...options, chainId: 43113 });
  let clock = Number(await chain.now()),
    serial = 0;
  const resources: (() => Promise<void> | void)[] = [() => chain.stop()];
  try {
    const db = scorerDatabase();
    resources.push(() => db.close());
    const vdb = verifierDatabase(":memory:", createBodyCipher(randomBytes(32)));
    resources.push(() => vdb.close());
    const address = (name: string) =>
      chain.publicClient.readContract({
        address: chain.escrow,
        abi: parseAbi([`function ${name}() view returns (address)`]),
        functionName: name,
      }) as Promise<Address>;
    const identity = await address("identityRegistry"),
      reputation = await address("reputationRegistry");
    const scorer = scorerApp({
      db,
      publicClient: chain.publicClient,
      mainnetFetch: async () => {
        throw new Error("Mainnet disabled in deterministic E2E");
      },
      clock: () => clock,
      signer: chain.accounts.scorer,
      config: {
        chainId: 43113,
        escrow: chain.escrow,
        identity,
        reputation,
        startBlock: chain.deployBlock,
      },
    });
    const facilitator = facilitatorApp({
      publicClient: chain.publicClient,
      walletClient: chain.wallet("owner"),
      escrow: chain.escrow,
      usdc: chain.usdc,
      clock: () => clock,
    });
    const vchain = verifierChain(
      chain.publicClient,
      [chain.publicClient, chain.publicClient],
      chain.escrow,
      chain.accounts.verifier.address,
    );
    const signer = createSigner(chain.accounts.verifier, 43113, chain.escrow),
      sellerFetch = createSellerFetch(true);
    resources.push(() => sellerFetch.close());
    const metrics: Record<string, unknown>[] = [];
    const runtime = createRuntime({
      db: vdb,
      chain: vchain,
      signer,
      clock: () => clock,
      escrow: chain.escrow,
      allowPrivate: true,
      writer: createWriter(
        chain.publicClient,
        chain.wallet("verifier"),
        chain.escrow,
      ),
      fetch: sellerFetch.fetch,
      checks: createCheckRunner(),
      log: (entry) => metrics.push(entry),
    });
    const verifier = verifierApp({
      db: vdb,
      signer,
      clock: () => clock,
      config: { escrow: chain.escrow },
      chain: vchain,
      runtime,
    });
    const stops = new Map<string, () => Promise<void>>();
    async function listen(app: typeof scorer) {
      const server = serve({
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
      });
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          if ("closeAllConnections" in server) server.closeAllConnections();
        });
      };
      resources.push(stop);
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      stops.set(url, stop);
      return url;
    }
    const urls = {
      scorer: await listen(scorer),
      facilitator: await listen(facilitator),
      verifier: await listen(verifier),
    };
    const keeper = createKeeper({
      publicClient: chain.publicClient,
      walletClient: chain.wallet("keeper"),
      escrow: chain.escrow,
      store: memoryStore(),
      fromBlock: chain.deployBlock,
      clock: () => clock,
      retryBaseMs: 1,
    });
    async function write(
      name: string,
      args: unknown[],
      who: keyof typeof chain.accounts = "owner",
    ) {
      const wallet = chain.wallet(who);
      const req = {
        address: chain.escrow,
        abi: agentPaySessionEscrowAbi as Abi,
        functionName: name,
        args,
        account: wallet.account,
      };
      await chain.publicClient.simulateContract(req);
      const hash = await wallet.writeContract({
        ...req,
        chain: wallet.chain,
        gas: 1000000n,
      });
      const receipt = await chain.publicClient.waitForTransactionReceipt({
        hash,
      });
      if (receipt.status !== "success") throw new Error(`${name} reverted`);
      clock = Number(await chain.now());
      return hash;
    }
    async function open(overrides: Partial<OpenParams> = {}) {
      clock = Number(await chain.now());
      const a = chain.accounts;
      const params: OpenParams = {
        seller: a.seller.address,
        sellerAgentId: chain.agentId,
        verifier: a.verifier.address,
        voucherSigner: a.buyer.address,
        specHash: SPEC,
        cap: 1000000n,
        pricePerRequest: 10000n,
        expiry: BigInt(clock) + 180n,
        deliveryDeadlineSec: 10,
        challengeWindowSec: 30,
        ...overrides,
      };
      const response = await fetch(
        `${urls.scorer}/v1/attestation/${chain.agentId}?wallet=${a.seller.address}`,
      );
      if (!response.ok) throw new Error(`Scorer: ${response.status}`);
      const { attestation } = await response.json();
      const salt = keccak256(toHex(`e2e-${++serial}`));
      const auth = {
        from: a.buyer.address,
        value: params.cap,
        validAfter: 0n,
        validBefore: BigInt(clock) + 120n,
        nonce: openNonce(params, salt),
      };
      const { v, r, s } = await signReceiveAuthorization(
        a.buyer,
        43113,
        chain.usdc,
        { ...auth, to: chain.escrow },
      );
      const body = {
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          scheme: SCHEME,
          network: NETWORK.fuji,
          payload: {
            params: toWire(params),
            salt,
            authorization: toWire({ ...auth, v, r, s }),
            attestation,
          },
        },
        paymentRequirements: {
          scheme: SCHEME,
          network: NETWORK.fuji,
          asset: chain.usdc,
          amount: "10000",
          payTo: chain.escrow,
          maxTimeoutSeconds: 120,
          extra: {},
        },
      };
      const settled = await fetch(`${urls.facilitator}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await settled.json();
      if (!result.success)
        throw new Error(result.errorReason ?? "Facilitator failed");
      clock = Number(await chain.now());
      return {
        id: BigInt(result.sessionId),
        txHash: result.transaction as Hash,
      };
    }
    const token = parseAbi([
      "function balanceOf(address) view returns (uint256)",
    ]);
    return {
      chain,
      urls,
      keeper,
      write,
      open,
      reputation,
      runtime,
      vdb,
      metrics,
      stopVerifier: () => stops.get(urls.verifier)!(),
      clock: () => clock,
      async advance(seconds: number) {
        await chain.advance(seconds);
        clock = Number(await chain.now());
      },
      async balances() {
        const values = await Promise.all(
          [
            chain.accounts.buyer.address,
            chain.accounts.seller.address,
            chain.escrow,
          ].map((a) =>
            chain.publicClient.readContract({
              address: chain.usdc,
              abi: token,
              functionName: "balanceOf",
              args: [a],
            }),
          ),
        );
        return { buyer: values[0], seller: values[1], escrow: values[2] };
      },
      async stop() {
        for (const close of resources.reverse()) await close();
      },
    };
  } catch (error) {
    for (const close of resources.reverse())
      await Promise.resolve(close()).catch(() => {});
    throw error;
  }
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
