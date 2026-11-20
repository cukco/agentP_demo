import { expect, it, vi } from "vitest";
import {
  CHAIN_ID, NETWORK, SCHEME, TYPES, USDC, ZERO_HASH, agentPaySessionEscrowAbi,
  openNonce, sessionId, toWire, usdcDomain, type OpenParams,
} from "@agentpay/core";
import { encodeEventTopics, parseSignature, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.js";

const escrow = "0x00000000000000000000000000000000000e5c40";
const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const now = 1_800_000_000;

it("checks signed terms and submits only once for concurrent and repeated settle calls", async () => {
  const params: OpenParams = {
    seller: account.address, sellerAgentId: 1n, verifier: account.address, voucherSigner: account.address,
    specHash: ZERO_HASH, cap: 1_000_000n, pricePerRequest: 10_000n, expiry: BigInt(now + 600),
    deliveryDeadlineSec: 10, challengeWindowSec: 60,
  };
  const nonce = openNonce(params, ZERO_HASH);
  const message = {
    from: account.address, to: escrow, value: params.cap, validAfter: 0n, validBefore: BigInt(now + 120), nonce,
  };
  const typedData = {
    domain: usdcDomain(CHAIN_ID.fuji, USDC.fuji), types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization", message,
  } as const;
  const signature = parseSignature(await account.signTypedData(typedData));
  const auth = { ...message, r: signature.r, s: signature.s, v: Number(signature.v) };
  const terms = { scheme: SCHEME, network: NETWORK.fuji };
  const payment = toWire({
    x402Version: 2,
    paymentPayload: {
      x402Version: 2, ...terms, payload: {
        params, salt: ZERO_HASH, authorization: auth, attestation: {
          message: { agentId: 1n, wallet: account.address, score: 60, flags: 0, validUntil: BigInt(now + 600) },
          signature: `0x${"11".repeat(65)}`,
        },
      },
    },
    paymentRequirements: { ...terms, asset: USDC.fuji, payTo: escrow, amount: "10000", maxTimeoutSeconds: 120, extra: {} },
  });
  const id = sessionId(account.address, nonce);
  const topics = encodeEventTopics({ abi: agentPaySessionEscrowAbi, eventName: "SessionOpened", args: { sessionId: id } });
  const simulateContract = vi.fn(async () => ({ request: {} }));
  const writeContract = vi.fn(async () => ZERO_HASH);
  const app = createApp({
    escrow, usdc: USDC.fuji, clock: () => now,
    publicClient: {
      readContract: vi.fn(async ({ functionName }) => functionName === "balanceOf" ? params.cap : false),
      simulateContract,
      waitForTransactionReceipt: async () => ({ status: "success", logs: [{ address: escrow, topics }] }),
    } as unknown as PublicClient,
    walletClient: { account, writeContract } as unknown as WalletClient,
  });
  const post = async (path: string, data = payment) => (await app.request(path, {
    method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json" },
  })).json();
  const altered = structuredClone(payment);
  altered.paymentPayload.payload.params.expiry = (params.expiry + 1n).toString();
  expect(await post("/settle", altered)).toEqual({ success: false, errorReason: "NONCE_MISMATCH" });
  expect(writeContract).not.toHaveBeenCalled();
  expect(await post("/verify")).toMatchObject({ isValid: true, sessionId: id.toString() });
  const expected = { success: true, sessionId: id.toString(), transaction: ZERO_HASH };
  const [first, concurrent] = await Promise.all([post("/settle"), post("/settle")]);
  expect(first).toMatchObject(expected);
  expect(concurrent).toEqual(first);
  expect(await post("/settle")).toEqual(first);
  expect(writeContract).toHaveBeenCalledTimes(1);
});
