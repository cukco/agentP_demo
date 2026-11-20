import { DEPLOYMENTS, type ScoreResponse } from "@agentpay/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { isAddress, type Address, type LocalAccount, type PublicClient } from "viem";
import { createChain, type ChainConfig, type ScorerChain } from "./chain.js";
import type { ScorerDatabase } from "./db.js";
import { verifyWalletProof, verifyWalletLinkAuthorization } from "./proof.js";
import { createRoutescan } from "./sources/routescan.js";
import { createAlchemyBase } from "./sources/alchemy.js";
import { summarizeHistory } from "./sources/history.js";
import { probe } from "./sources/probe.js";
import { createBlocklist } from "./sources/blocklist.js";
import { referenceScore } from "./score/reference.js";
import { realScore } from "./score/real.js";
import { combine } from "./score/combine.js";
import { attest } from "./attest.js";

export interface Dependencies {
  db: ScorerDatabase;
  publicClient: PublicClient;
  mainnetFetch: typeof fetch;
  alchemyBaseUrl?: string;
  clock: () => number;
  signer: LocalAccount;
  config?: ChainConfig;
  chain?: ScorerChain;
  probeFetch?: typeof fetch;
  blocked?: (wallet: Address) => boolean;
}
export function createApp(deps: Dependencies) {
  const { db, clock } = deps;
  const d = DEPLOYMENTS.fuji;
  const config = deps.config ?? { ...d, startBlock: d.deployBlock! };
  const chain = deps.chain ?? createChain(deps.publicClient, config);
  const routescan = createRoutescan(deps.mainnetFetch, clock);
  const base = deps.alchemyBaseUrl ? createAlchemyBase(deps.alchemyBaseUrl, deps.mainnetFetch, clock) : undefined;
  const blocked = deps.blocked ?? createBlocklist();
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "X-AgentPay-Wallet-Authorization"] }));
  app.use("*", bodyLimit({ maxSize: 4096 }));
  app.onError((_err, c) => c.json({ error: { code: "UPSTREAM_ERROR", message: "Scorer could not verify chain data" } }, 503));
  app.use("/v1/*/:agentId", async (c, next) => {
    const id = c.req.param("agentId");
    if (!/^(0|[1-9]\d{0,77})$/.test(id) || BigInt(id) >= 2n ** 256n)
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid agent ID" } }, 400);
    await next();
  });
  async function seller(id: string) {
    const wallet = await chain.wallet(BigInt(id));
    let s = db.seller(id);
    if (!s || s.payTo.toLowerCase() !== wallet.toLowerCase()) {
      // Ownership rotation invalidates the old wallet's proofs and probe result.
      s = { agentId: id, payTo: wallet, endpoints: [], mainnetWallets: [], proofVersion: 1, lastProbe: null };
      db.saveSeller(s);
    }
    if (s.proofVersion !== 1) {
      // Legacy links were not authorized by agentWallet; require fresh proofs.
      s = { ...s, mainnetWallets: [], proofVersion: 1 }; db.saveSeller(s);
    }
    return s;
  }
  const pending = new Map<string, Promise<ScoreResponse>>();
  async function calculate(id: string): Promise<ScoreResponse> {
    const s = await seller(id);
    if (s.endpoints.length && (!s.lastProbe || clock() - s.lastProbe.at >= 600 || s.lastProbe.at > clock())) {
      let ok = false;
      for (const endpoint of s.endpoints) {
        if (await probe(endpoint, s.payTo, id, deps.probeFetch ?? deps.mainnetFetch)) { ok = true; break; }
      }
      s.lastProbe = { at: clock(), ok }; db.saveSeller(s);
    }
    // Combine chains per proven wallet, then use the strongest wallet.
    let reference = referenceScore(null, s.lastProbe?.ok ?? false);
    for (const wallet of s.mainnetWallets) {
      const [avalanche, baseHistory] = await Promise.all([routescan(wallet), base?.(wallet) ?? null]);
      const at = clock();
      db.input(id, `routescan:${wallet.toLowerCase()}`, summarizeHistory(at, avalanche), at);
      if (base) db.input(id, `alchemy-base:${wallet.toLowerCase()}`, summarizeHistory(at, baseHistory), at);
      reference = Math.max(reference, referenceScore(summarizeHistory(at, avalanche, baseHistory), s.lastProbe?.ok ?? false));
    }
    const history = await chain.history(BigInt(id));
    const real = realScore(history.sessions, [s.payTo, ...s.mainnetWallets]);
    const combined = combine(reference, real.score, real.distinctBuyers);
    if ([s.payTo, ...s.mainnetWallets].some(blocked)) combined.flags |= 2;
    const result: ScoreResponse = { agentId: id, wallet: s.payTo, ...combined, referenceScore: reference,
      realScore: real.score, sessions: real.sessions, distinctBuyers: real.distinctBuyers,
      updatedAt: new Date(clock() * 1000).toISOString() };
    db.input(id, "escrow", history, clock()); db.input(id, "score", result, clock());
    return result;
  }
  function score(id: string) {
    if (!pending.has(id)) pending.set(id, calculate(id).finally(() => pending.delete(id)));
    return pending.get(id)!;
  }
  app.get("/v1/health", c => c.json({ ok: true, chainId: config.chainId, escrow: config.escrow, scorer: deps.signer.address }));
  app.get("/v1/score/:agentId", async c => c.json(await score(c.req.param("agentId"))));
  app.get("/v1/attestation/:agentId", async c => {
    const wallet = c.req.query("wallet");
    if (!wallet || !isAddress(wallet, { strict: false })) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid wallet" } }, 400);
    const id = c.req.param("agentId");
    const current = await chain.wallet(BigInt(id));
    if (current.toLowerCase() !== wallet.toLowerCase()) return c.json({ error: { code: "BAD_REQUEST", message: "Wallet does not match agentWallet" } }, 409);
    const result = await score(id);
    // Check again immediately before signing; the wallet may rotate during history/probe requests.
    const latest = await chain.wallet(BigInt(id));
    if (latest.toLowerCase() !== wallet.toLowerCase() || result.wallet.toLowerCase() !== wallet.toLowerCase())
      return c.json({ error: { code: "BAD_REQUEST", message: "Agent wallet changed" } }, 409);
    const signed = await attest(result, deps.signer, config, clock());
    db.attestation(id, result.score, result.flags, Number(signed.attestation.message.validUntil), signed.attestation.signature);
    return c.json(signed);
  });
  app.post("/v1/sellers/:agentId/wallet-proof", async c => {
    const id = c.req.param("agentId");
    if (!/^(0|[1-9]\d{0,77})$/.test(id) || BigInt(id) >= 2n ** 256n)
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid agent ID" } }, 400);
    let input: unknown;
    try { input = await c.req.json(); } catch { return c.json({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }, 400); }
    const proof = await verifyWalletProof(id, input, clock());
    if (!proof) return c.json({ error: { code: "BAD_REQUEST", message: "Invalid or expired wallet proof" } }, 400);
    const s = await seller(id);
    const authorized = await verifyWalletLinkAuthorization(id, proof, s.payTo, config.chainId, config.escrow,
      c.req.header("X-AgentPay-Wallet-Authorization"));
    if (!authorized) return c.json({ error: { code: "BAD_REQUEST", message: "Registered agentWallet must authorize linking another wallet" } }, 403);
    const latest = await chain.wallet(BigInt(id));
    if (latest.toLowerCase() !== s.payTo.toLowerCase())
      return c.json({ error: { code: "BAD_REQUEST", message: "Agent wallet changed; obtain a new authorization" } }, 409);
    if (!s.mainnetWallets.some(w => w.toLowerCase() === proof.mainnetWallet.toLowerCase())) {
      if (s.mainnetWallets.length >= 5) return c.json({ error: { code: "BAD_REQUEST", message: "At most five proven wallets per agent" } }, 400);
      s.mainnetWallets.push(proof.mainnetWallet); db.saveSeller(s);
    }
    return c.json({ ok: true, agentId: id, mainnetWallet: proof.mainnetWallet });
  });
  return app;
}
