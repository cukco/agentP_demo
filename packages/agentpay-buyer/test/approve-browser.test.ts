import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAIN_ID, HEADERS, NETWORK, Outcome, SessionState, USDC_DOMAIN, ZERO_HASH, agentPaySessionEscrowAbi,
  bodyHash, fromWire, receiptsRoot, signDelivery, signReceipt, signScoreAttestation, signSessionVerdict, specHash, toWire,
  verifyCloseRequest, verifyVoucher, type CloseRequest, type CloseSessionRequest, type PaymentRequired, type Receipt,
  type RelayRequest, type RelayResponse, type VerificationSpec, type Voucher,
} from "@agentpay/core";
import { chromium } from "playwright";
import { parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it, vi } from "vitest";
import { createApp } from "../../agentpay-facilitator/src/app.js";
import { AGENT_ID, PRICE, startChain } from "../../agentpay-keeper/test/helpers/chain.js";
import { createAgentPayBuyer, createFileBuyerStore } from "../src/index.js";

const keys = vi.hoisted(() => Array.from({ length: 4 }, (_, index) => `0x${String(index + 1).repeat(64)}` as Hex));
vi.mock("viem/accounts", async importOriginal => ({
  ...await importOriginal<typeof import("viem/accounts")>(),
  generatePrivateKey: vi.fn(() => keys.shift()!),
}));

it.runIf(process.env.APPROVE_PLAYWRIGHT === "1")("reviews, switches network and opens on Anvil with a RAM-only Voucher signer", async () => {
  const testKeys = [...keys];
  const directory = await mkdtemp(join(tmpdir(), "agentpay-approve-"));
  const chain = await startChain({ chainId: CHAIN_ID.fuji });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const { buyer, seller, verifier, scorer } = chain.accounts;
    const { escrow, publicClient, usdc } = chain;
    let now = Number(await chain.now());
    const clock = () => now;
    const walletMethods: string[] = [];
    const browserLogs: string[] = [];
    page.on("console", message => browserLogs.push(message.text()));
    let refused = false;
    await page.exposeFunction("mockWallet", async ({ method, params }: { method: string; params?: unknown[] }) => {
      walletMethods.push(method);
      if (method === "eth_signTypedData_v4") {
        if (refused) return null;
        const typed = JSON.parse(params?.[1] as string);
        if (typed.primaryType === "CloseRequest") return buyer.signTypedData(typed);
        expect(typed.domain).toMatchObject({ name: "USD Coin", version: "2", chainId: CHAIN_ID.fuji });
        expect(typed.domain.verifyingContract.toLowerCase()).toBe(usdc.toLowerCase());
        expect(typed.primaryType).toBe("ReceiveWithAuthorization");
        return buyer.signTypedData(typed);
      }
      return null;
    });
    await page.addInitScript(address => {
      let chainId = "0x1";
      const host = window as Window & {
        ethereum?: { request: (input: { method: string; params?: { chainId: string }[] }) => Promise<unknown> };
        mockWallet: (input: object) => Promise<unknown>;
      };
      host.ethereum = { async request(input) {
        const signed = await host.mockWallet(input);
        switch (input.method) {
          case "eth_requestAccounts": return [address];
          case "eth_chainId": return chainId;
          case "wallet_switchEthereumChain": chainId = input.params![0]!.chainId; return null;
          case "eth_signTypedData_v4":
            if (!signed) throw Object.assign(new Error("Rejected"), { code: 4001 });
            return signed;
        }
      } };
    }, buyer.address);

    const identityAbi = parseAbi(["function identityRegistry() view returns (address)", "function setTokenURI(uint256 id,string uri)"]);
    const identity = await publicClient.readContract({ address: escrow, abi: identityAbi, functionName: "identityRegistry" });
    const registryUrl = "https://seller.example/registration.json";
    const setUri = await chain.wallet("owner").writeContract({
      address: identity, abi: identityAbi, functionName: "setTokenURI", args: [AGENT_ID, registryUrl],
    });
    await publicClient.waitForTransactionReceipt({ hash: setUri });
    const url = "https://seller.example/v1/file";
    const bytes = Buffer.from("verified");
    const hash = bodyHash(bytes);
    const spec: VerificationSpec = { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
      verifier: { address: verifier.address, endpoint: "https://verifier.example" },
      delivery: { contentType: "application/octet-stream", maxBytes: 100 },
      checks: [{ type: "hash-match", id: "file", expectedHash: hash }],
    };
    const payment: PaymentRequired = { x402Version: 2, resource: { url },
      accepts: [{ scheme: "agentpay-session", network: NETWORK.fuji, asset: usdc, amount: PRICE.toString(), payTo: escrow,
        maxTimeoutSeconds: 120, extra: USDC_DOMAIN }],
      extensions: { agentpay: { version: "0.2", verificationSpec: spec,
        session: { contract: escrow, chainId: CHAIN_ID.fuji, seller: seller.address, sellerAgentId: AGENT_ID.toString(),
          pricePerRequest: PRICE.toString(), minCap: "500000", maxCap: "20000000", defaultExpirySec: 60,
          maxExpirySec: 86400, deliveryDeadlineSec: 10, challengeWindowSec: 60 },
      } },
    };
    const facilitator = createApp({ publicClient, walletClient: chain.wallet("owner") as never, escrow, usdc, clock });
    const relays: bigint[] = [];
    const store = createFileBuyerStore(directory);
    const transport: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === url) return Response.json(payment, { status: 402 });
      if (request.url === registryUrl) return Response.json({ services: [{ endpoint: url }] });
      if (request.url.startsWith("https://scorer.example/")) {
        const attestation = await signScoreAttestation(scorer, CHAIN_ID.fuji, escrow, {
          agentId: AGENT_ID, wallet: seller.address, score: 80, flags: 0, validUntil: BigInt(now + 600),
        });
        return Response.json({ scorer: scorer.address, attestation: toWire(attestation) });
      }
      if (request.url.startsWith("https://facilitator.example/")) return facilitator.fetch(request);
      if (request.url.endsWith("/close")) {
        const { closeRequest } = await request.json() as CloseSessionRequest;
        const message = fromWire<CloseRequest>("CloseRequest", closeRequest.message);
        expect(await verifyCloseRequest(CHAIN_ID.fuji, escrow, { message, signature: closeRequest.signature }, buyer.address)).toBe(true);
        const record = (await store.get(message.sessionId.toString()))!.requests.at(-1)!;
        const verdict = await signSessionVerdict(verifier, CHAIN_ID.fuji, escrow, {
          sessionId: message.sessionId, specHash: specHash(spec), lastSeq: 1, passCount: 1, failCount: 0, inconclusiveCount: 0,
          passedAmount: PRICE, receiptsRoot: receiptsRoot([fromWire<Receipt>("Receipt", record.receipt!.message)]), closedAt: BigInt(now),
        });
        const txHash = await chain.wallet("verifier").writeContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "closeSession",
          args: [message.sessionId, fromWire<Voucher>("Voucher", record.voucher.message), record.voucher.signature, verdict.message, verdict.signature] });
        expect((await publicClient.waitForTransactionReceipt({ hash: txHash })).status).toBe("success");
        return Response.json({ sessionId: message.sessionId.toString(), txHash, kind: "closeSession" });
      }
      const { voucher } = await request.json() as RelayRequest;
      const message = fromWire<Voucher>("Voucher", voucher.message);
      const session = await publicClient.readContract({
        address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [message.sessionId],
      });
      expect(await verifyVoucher(CHAIN_ID.fuji, escrow, { message, signature: voucher.signature }, session.voucherSigner)).toBe(true);
      relays.push(message.sessionId);
      const common = { sessionId: message.sessionId, seq: message.seq, requestHash: message.requestHash, bodyHash: hash };
      const delivery = await signDelivery(seller, CHAIN_ID.fuji, escrow, { ...common, specHash: specHash(spec) });
      const receipt = await signReceipt(verifier, CHAIN_ID.fuji, escrow, { ...common, outcome: Outcome.PASS,
        reasonCode: 0, amount: PRICE, receivedAt: BigInt(now), evidenceHash: ZERO_HASH });
      return Response.json({ sessionId: message.sessionId.toString(), seq: message.seq, closing: false,
        bodyBase64: bytes.toString("base64"), contentType: spec.delivery.contentType,
        delivery: toWire(delivery), receipt: toWire(receipt),
      } satisfies RelayResponse);
    };

    let behavior: "approve" | "tamper" | "refuse" | "close" = "tamper";
    const openedUrls: string[] = [];
    const browserRequests: string[] = [];
    let browserError: unknown;
    page.on("request", request => browserRequests.push(request.url()));
    const sdk = createAgentPayBuyer({ mode: "approve", chainId: CHAIN_ID.fuji, buyerAddress: buyer.address, publicClient,
      trustedEscrows: [escrow], facilitatorUrl: "https://facilitator.example", scorerUrl: "https://scorer.example",
      softPolicy: { maxPerSession: 1_000_000n, maxPricePerRequest: PRICE }, defaultCap: 1_000_000n,
      defaultExpirySec: 60, clock, store, fetch: transport, checks: () => Outcome.PASS, async onApprovalUrl(approvalUrl) {
        try {
          openedUrls.push(approvalUrl);
          await page.goto(approvalUrl);
          const button = page.getByRole("button", { name: behavior === "close" ? "Confirm close in MetaMask" : "Approve in MetaMask" });
          if (behavior === "tamper") {
            await page.locator('[data-field="Cap (USDC)"]').evaluate(el => { el.textContent = "20"; });
            await button.click();
            await page.getByText("AgentPay blocked signing.", { exact: false }).waitFor();
            await page.getByRole("button", { name: "Decline" }).click();
          } else {
            refused = behavior === "refuse";
            await button.click();
            await page.waitForFunction(() => Boolean(document.querySelector("[role=status]")?.textContent));
            expect(await page.getByRole("status").textContent()).toMatch(refused ? /declined/ : /Signature sent/);
          }
        } catch (error) {
          browserError = error;
          throw error;
        }
      },
    });
    await expect(sdk.openSession(url, { cap: 1_000_000n, expirySec: 60 })).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
    expect(walletMethods).toEqual([]);
    expect(await store.list()).toEqual([]);

    behavior = "approve";
    const id = await sdk.openSession(url, { cap: 1_000_000n, expirySec: 60 }).catch(error => { throw browserError ?? error; });
    expect(walletMethods).toContain("wallet_switchEthereumChain");
    expect(walletMethods.filter(method => method === "eth_signTypedData_v4")).toHaveLength(1);
    const session = await publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [BigInt(id)] });
    expect(session).toMatchObject({ state: SessionState.OPEN, buyer: buyer.address, cap: 1_000_000n });
    expect(session.voucherSigner.toLowerCase()).toBe(privateKeyToAccount(testKeys[1]!).address.toLowerCase());
    expect(session.voucherSigner.toLowerCase()).not.toBe(buyer.address.toLowerCase());
    const result = await sdk.fetchWithReceipt(url);
    expect(await result.response.text()).toBe("verified");
    expect(result.receipt).toMatchObject({ sessionId: id, outcome: Outcome.PASS });
    expect(relays).toEqual([BigInt(id)]);

    const files = await readdir(directory);
    expect(files).toEqual([`${id}.json`]);
    const stored = await readFile(join(directory, files[0]!), "utf8");
    for (const key of testKeys) {
      expect(stored).not.toContain(key);
      expect(JSON.stringify(result.receipt)).not.toContain(key);
      expect(openedUrls.join()).not.toContain(key);
      expect(browserLogs.join()).not.toContain(key);
    }
    expect(browserRequests.every(request => new URL(request).hostname === "127.0.0.1")).toBe(true);

    await chain.advance(61);
    now = Number(await chain.now());
    behavior = "refuse";
    await expect(sdk.fetch(url)).rejects.toMatchObject({ code: "APPROVAL_REJECTED" });
    expect(relays).toEqual([BigInt(id)]);
    expect((await store.get(id))?.requests).toHaveLength(1);
    expect(openedUrls).toHaveLength(3);
    expect(new Set(openedUrls).size).toBe(3);

    behavior = "close";
    await sdk.close(id).catch(error => { throw browserError ?? error; });
    expect(await chain.state(BigInt(id))).toBe(SessionState.CLOSING);
    expect((await store.get(id))?.status).toBe("closing");
  } finally {
    await browser.close();
    await chain.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
