import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { avalanche, avalancheFuji } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { serve } from "@hono/node-server";
import { createRuntime } from "./runtime.js";
import { createWriter } from "./writer.js";
import { createCheckRunner, createOracleReader } from "./checks/index.js";
import { createSellerFetch } from "./network.js";
import { createApp } from "./app.js";
import { createChain } from "./chain.js";
import { loadConfig } from "./config.js";
import { createBodyCipher } from "./crypto.js";
import { openDatabase } from "./db.js";
import { purgeBodies } from "./purge.js";
import { createSigner } from "./signer.js";
import { syncSessions } from "./sync.js";

export function startVerifier(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env);
  const signer = createSigner(
    privateKeyToAccount(config.privateKey),
    avalancheFuji.id,
    config.escrow,
  );
  const fuji = createPublicClient({
    chain: avalancheFuji,
    // A rate-limited public RPC (HTTP 429) drops behind the other one.
    transport: fallback(config.fuji.map((url) => http(url)), { rank: { interval: 60_000 } }),
  });
  const mainnet = config.mainnet.map((url) =>
    createPublicClient({ chain: avalanche, transport: http(url) }),
  );
  const chain = createChain(
    fuji,
    [mainnet[0], mainnet[1]],
    config.escrow,
    signer.address,
  );
  const db = openDatabase(
    config.databasePath,
    createBodyCipher(config.bodyKey),
  );
  const clock = () => Math.floor(Date.now() / 1000);
  const seller = createSellerFetch(config.allowPrivate);
  const wallet = createWalletClient({
    account: privateKeyToAccount(config.privateKey),
    chain: avalancheFuji,
    transport: fallback(
      config.fuji.map((url) => http(url, { timeout: 8000, retryCount: 0 })),
      { retryCount: 0 },
    ),
  });
  const oracleClient = createPublicClient({
    chain: avalanche,
    transport: fallback(
      config.mainnet.map((url) => http(url, { timeout: config.oracleTimeoutMs, retryCount: 0 })),
      { retryCount: 0 },
    ),
  });
  const runtime = createRuntime({
    db,
    chain,
    signer,
    clock,
    escrow: config.escrow,
    allowPrivate: config.allowPrivate,
    writer: createWriter(fuji, wallet, config.escrow),
    fetch: seller.fetch,
    checks: createCheckRunner({ oracle: createOracleReader(oracleClient) }),
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  const app = createApp({ db, signer, chain, clock, config, runtime });

  let syncInProgress = false;
  async function sync() {
    if (syncInProgress) return;
    syncInProgress = true;
    try {
      await syncSessions(db, chain, clock, config.startBlock);
    } catch {
      console.warn("Verifier session sync failed; retry scheduled");
    } finally {
      syncInProgress = false;
    }
  }
  function purge() {
    try {
      purgeBodies(db, clock);
    } catch {
      console.warn("Verifier body purge failed; retry scheduled");
    }
  }

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  void sync();
  purge();
  const syncTimer = setInterval(() => void sync(), 30_000);
  const closeTimer = setInterval(
    () =>
      void runtime
        .tick()
        .catch(() => console.warn("Verifier close sweep failed")),
    30_000,
  );
  const purgeTimer = setInterval(purge, 86_400_000);
  for (const timer of [syncTimer, closeTimer, purgeTimer]) timer.unref();
  server.once("close", () => {
    for (const timer of [syncTimer, closeTimer, purgeTimer])
      clearInterval(timer);
    void seller.close();
  });
  return server;
}
