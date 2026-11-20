import { describe, expect, it, vi } from "vitest";
import {
  Outcome, ReasonCode, SessionState, TYPES, ZERO_HASH, agentPayDomain,
  type Receipt, type SessionVerdict,
} from "@agentpay/core";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.js";
import type { ChainAdapter, ChainSession } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { createBodyCipher } from "../src/crypto.js";
import { openDatabase } from "../src/db.js";
import { purgeBodies } from "../src/purge.js";
import { createSigner } from "../src/signer.js";
import { syncSessions } from "../src/sync.js";

const escrow = "0x00000000000000000000000000000000000e5c40";
const testKey = `0x${"01".repeat(32)}` as const;
const account = privateKeyToAccount(testKey);
const now = 1_800_000_000;
const day = 86_400;
const session: ChainSession = {
  buyer: account.address, voucherSigner: account.address, seller: account.address, sellerAgentId: 1n,
  verifier: account.address, specHash: ZERO_HASH, cap: 1_000_000n, pricePerRequest: 10_000n,
  sessionFee: 40_000n, expiry: BigInt(now + 600), deliveryDeadlineSec: 10, challengeWindowSec: 60,
  state: SessionState.OPEN,
};

describe("Verifier foundation", () => {
  it("reports the missing key by name and accepts valid configuration", () => {
    const env = {
      VERIFIER_PRIVATE_KEY: testKey,
      FUJI_RPC_URL_1: "https://fuji.example",
      FUJI_RPC_URL_2: "https://fuji-backup.example",
      AVAX_MAINNET_RPC_URL_1: "https://mainnet.example",
      AVAX_MAINNET_RPC_URL_2: "https://mainnet-backup.example",
      AGENTPAY_ESCROW: escrow,
    };
    expect(() => loadConfig(env)).toThrow("VERIFIER_BODY_KEY");
    expect(loadConfig({ ...env, VERIFIER_BODY_KEY: "ff".repeat(32) })).toMatchObject({
      databasePath: "./verifier.db", port: 8787, bodyKey: Buffer.alloc(32, 255),
    });
  });

  it("encrypts raw bytes with fresh IVs and rejects modified ciphertext", () => {
    const cipher = createBodyCipher(Buffer.alloc(32, 9));
    const body = Buffer.from([0, 1, 255]);
    const encrypted = cipher.encryptBody(body);
    expect(cipher.decryptBody(encrypted)).toEqual(body);
    expect(cipher.encryptBody(body)).not.toEqual(encrypted);
    encrypted[encrypted.length - 1] ^= 1;
    expect(() => cipher.decryptBody(encrypted)).toThrow();
  });

  it("signs Receipt and SessionVerdict with the escrow domain", async () => {
    const signer = createSigner(account, 43113, escrow);
    const domain = agentPayDomain(43113, escrow);
    const receipt: Receipt = {
      sessionId: 1n, seq: 1, requestHash: ZERO_HASH, bodyHash: ZERO_HASH,
      outcome: Outcome.PASS, reasonCode: ReasonCode.PASS, amount: 10_000n,
      receivedAt: BigInt(now), evidenceHash: ZERO_HASH,
    };
    const verdict: SessionVerdict = {
      sessionId: 1n, specHash: ZERO_HASH, lastSeq: 1, passCount: 1, failCount: 0, inconclusiveCount: 0,
      passedAmount: 10_000n, receiptsRoot: ZERO_HASH, closedAt: BigInt(now),
    };
    const signedReceipt = await signer.signReceipt(receipt);
    const signedVerdict = await signer.signVerdict(verdict);
    expect(await recoverTypedDataAddress({
      domain, types: TYPES.Receipt, primaryType: "Receipt", ...signedReceipt,
    })).toBe(account.address);
    expect(await recoverTypedDataAddress({
      domain, types: TYPES.SessionVerdict, primaryType: "SessionVerdict", ...signedVerdict,
    })).toBe(account.address);
  });

  it("stores ciphertext and purges bodies only for old terminal sessions", () => {
    const cipher = createBodyCipher(Buffer.alloc(32, 9));
    const db = openDatabase(":memory:", cipher);
    try {
      const body = Buffer.from("private response body");
      for (const [id, state, daysAgo] of [
        [1n, SessionState.SETTLED, 8], [2n, SessionState.REFUNDED, 6], [3n, SessionState.OPEN, 8],
      ] as const) {
        db.saveSession(id, { ...session, state }, now - daysAgo * day);
        db.saveVoucher({ message: { sessionId: id, seq: 1, requestHash: ZERO_HASH, cumulativeAmount: 10_000n },
          signature: "0x" }, now - daysAgo * day);
        db.saveBody(id, 1, body, ZERO_HASH, "application/json", now);
      }
      db.saveSession(1n, { ...session, state: SessionState.SETTLED }, now);
      const stored = Buffer.from(db.request(1n, 1)?.body_enc as Uint8Array);
      expect(stored.includes(body)).toBe(false);
      expect(cipher.decryptBody(stored)).toEqual(body);
      expect(purgeBodies(db, () => now)).toBe(1);
      expect(db.request(1n, 1)?.body_enc).toBeNull();
      expect(db.request(2n, 1)?.body_enc).toBeTruthy();
      expect(db.request(3n, 1)?.body_enc).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("resumes chain indexing from the stored cursor and serves HTTP without listening", async () => {
    const db = openDatabase(":memory:", createBodyCipher(Buffer.alloc(32, 9)));
    try {
      const chain: ChainAdapter = {
        getSession: async id => id === 1n ? session : null,
        scanSessionOpened: vi.fn(async () => [1n]),
        getBlockNumber: async () => 12n,
        health: async () => ({ fuji: true, mainnet: [true, false] }),
      };
      await syncSessions(db, chain, () => now, 8n);
      await syncSessions(db, chain, () => now, 8n);
      expect(chain.scanSessionOpened).toHaveBeenCalledExactlyOnceWith(8n, 10n);
      expect(db.cursor()).toBe(10n);
      const app = createApp({ db, chain, signer: account, clock: () => now, config: { escrow } });
      expect(await (await app.request("/v1/health")).json()).toMatchObject({ ok: true, chainId: 43113 });
      expect(await (await app.request("/v1/sessions/1")).json()).toMatchObject({ sessionId: "1", state: "OPEN" });
      expect((await app.request("/v1/sessions/2")).status).toBe(404);
      expect((await app.request("/v1/sessions/-1")).status).toBe(400);
    } finally {
      db.close();
    }
  });
});
