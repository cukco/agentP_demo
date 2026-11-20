// From the repo root after pnpm install:
// pnpm --filter @agentpay/core build
// node packages/agentpay-buyer/examples/core-h6.mjs
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_ID, NETWORK, USDC, parsePaymentRequired, requestHash, signVoucher, verifyVoucher, ZERO_HASH,
} from "@agentpay/core";

const buyer = privateKeyToAccount(generatePrivateKey());
const escrow = "0x0000000000000000000000000000000000000001";
const chainId = CHAIN_ID.fuji;
const url = "https://seller.example/file";
const payment = parsePaymentRequired({
  x402Version: 2, resource: { url },
  accepts: [{ scheme: "agentpay-session", network: NETWORK.fuji, asset: USDC.fuji, amount: "10000",
    payTo: escrow, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
  extensions: { agentpay: { version: "0.2",
    session: { contract: escrow, chainId, seller: escrow, sellerAgentId: "12", pricePerRequest: "10000",
      minCap: "500000", maxCap: "20000000", defaultExpirySec: 3600, maxExpirySec: 86400,
      deliveryDeadlineSec: 10, challengeWindowSec: 60 },
    verificationSpec: { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
      verifier: { address: escrow, endpoint: "https://verifier.example" },
      delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
      checks: [{ id: "file", type: "hash-match", expectedHash: ZERO_HASH }] },
  } },
});
const signed = await signVoucher(buyer, chainId, escrow, {
  sessionId: 1n, seq: 1, cumulativeAmount: BigInt(payment.accepts[0].amount), requestHash: requestHash("GET", url),
});
assert.equal(await verifyVoucher(chainId, escrow, signed, buyer.address), true);
console.log("H6 OK: parsed 402 and verified Voucher via @agentpay/core");
