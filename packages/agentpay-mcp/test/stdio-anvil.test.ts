import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptKeystore } from "@ethersproject/json-wallets";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CHAIN_ID, HEADERS, Outcome, SessionState, ZERO_HASH, agentPaySessionEscrowAbi, bodyHash,
  decodeHeaderJson, encodeHeader, fromWire, signReceipt, signScoreAttestation, toWire,
  type Delivery, type RelayRequest, type RelayResponse, type VerificationSpec, type WireSigned,
} from "@agentpay/core";
import { parseAbi } from "viem";
import { expect, it } from "vitest";
import { createApp } from "../../agentpay-facilitator/src/app.js";
import { AGENT_ID, KEYS, PRICE, startChain } from "../../agentpay-keeper/test/helpers/chain.js";
import { createAgentPaySeller } from "../../agentpay-seller/src/index.js";

it("lists tools and fetches a PASS over stdio with an encrypted keystore and a live Anvil escrow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentpay-mcp-"));
  const chain = await startChain({ chainId: CHAIN_ID.fuji });
  const { accounts: { buyer, owner, seller, scorer, verifier }, escrow, usdc, publicClient } = chain;
  const clock = () => Math.floor(Date.now() / 1000);
  const app = createApp({ publicClient, walletClient: chain.wallet("owner") as never, escrow, usdc, clock });
  const http = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await app.fetch(new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method, headers: Object.entries(request.headers).flatMap(([key, value]) =>
          value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => [key, item])),
        ...(chunks.length && { body: Buffer.concat(chunks) }),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500).end();
    }
  });
  const client = new Client({ name: "agentpay-c6-stdio", version: "1" });
  let sdk: ReturnType<typeof createAgentPaySeller> | undefined;
  try {
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const url = base + "/seller";
    const abi = parseAbi(["function identityRegistry() view returns (address)", "function setTokenURI(uint256 id,string uri)"]);
    const identity = await publicClient.readContract({ address: escrow, abi, functionName: "identityRegistry" });
    const registered = await chain.wallet("owner").writeContract({
      address: identity, abi, functionName: "setTokenURI", args: [AGENT_ID, base + "/registration.json"],
    });
    expect((await publicClient.waitForTransactionReceipt({ hash: registered })).status).toBe("success");

    const payload = JSON.stringify({ status: "ok", sample: "verified" });
    const spec: VerificationSpec = { specVersion: "agentpay-verify/0.2", serviceType: "file", passRule: "all",
      verifier: { address: verifier.address, endpoint: base + "/v1" },
      delivery: { contentType: "application/json", maxBytes: 1024 },
      checks: [{ type: "hash-match", id: "response", expectedHash: bodyHash(Buffer.from(payload)) }],
    };
    sdk = createAgentPaySeller({ account: seller, escrow, chainId: CHAIN_ID.fuji, asset: usdc, publicClient,
      walletClient: chain.wallet("seller"), sellerAgentId: AGENT_ID, pricePerRequest: PRICE, spec, clock, verifierUrl: base,
      terms: { minCap: 500_000n, maxCap: 20_000_000n, defaultExpirySec: 3600, maxExpirySec: 86400,
        deliveryDeadlineSec: 10, challengeWindowSec: 60 },
    });
    sdk.stop();
    app.use("/seller", sdk.middleware());
    app.get("/seller", c => c.body(payload, 200, { "content-type": "application/json" }));
    app.get("/registration.json", c => c.json({ services: [{ endpoint: url }] }));
    app.get("/v1/attestation/:agentId", async c => c.json({ scorer: scorer.address,
      attestation: toWire(await signScoreAttestation(scorer, CHAIN_ID.fuji, escrow, {
        agentId: AGENT_ID, wallet: seller.address, score: 80, flags: 0, validUntil: BigInt(clock() + 1800),
      })),
    }));
    app.post("/v1/sessions/:id/requests", async c => {
      const { voucher, request } = await c.req.json<RelayRequest>();
      const response = await app.request(request.url, {
        method: request.method, headers: { [HEADERS.PAYMENT_SIGNATURE]: encodeHeader(voucher) },
      });
      expect(response.status).toBe(200);
      const delivery = decodeHeaderJson<WireSigned<Delivery>>(response.headers.get(HEADERS.DELIVERY)!);
      const message = fromWire<Delivery>("Delivery", delivery.message);
      const content = Buffer.from(await response.arrayBuffer());
      expect(message.bodyHash).toBe(bodyHash(content));
      const receipt = await signReceipt(verifier, CHAIN_ID.fuji, escrow, {
        sessionId: message.sessionId, seq: message.seq, requestHash: message.requestHash, bodyHash: message.bodyHash,
        outcome: Outcome.PASS, reasonCode: 0, amount: PRICE, receivedAt: BigInt(clock()), evidenceHash: ZERO_HASH,
      });
      return c.json<RelayResponse>({ sessionId: message.sessionId.toString(), seq: message.seq, contentType: "application/json",
        delivery, receipt: toWire(receipt), bodyBase64: content.toString("base64"), closing: false });
    });

    const path = join(directory, "buyer.json");
    const password = "test-only-keystore-password";
    await writeFile(path, await encryptKeystore({ address: buyer.address, privateKey: KEYS.buyer }, password, {
      scrypt: { N: 1024, r: 8, p: 1 },
    }), { mode: 0o600 });

    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      stderr: "pipe",
      env: { AGENTPAY_KEYSTORE_PATH: path, AGENTPAY_KEYSTORE_PASSWORD: password, AGENTPAY_ESCROW: escrow,
        FUJI_RPC_URL_1: chain.rpc, FACILITATOR_URL: base, SCORER_URL: base, AGENTPAY_SESSION_DIR: join(directory, "sessions") },
    }));
    expect((await client.listTools()).tools).toHaveLength(4);

    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeUndefined();
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).not.toContain(KEYS.buyer);
      expect(text).not.toContain(JSON.stringify(path).slice(1, -1));
      expect(text).not.toContain(password);
      expect(text).not.toMatch(/0x[0-9a-f]{130}/i);
      return JSON.parse(text);
    }
    const opened = await call("agentpay_open_session", { url, capUsd: "1", expiryMinutes: 10 });
    const fetched = await call("agentpay_fetch", { url, maxCapUsd: "0.5" });
    expect(fetched).toMatchObject({ status: 200, body: payload, receipt: { outcome: "PASS", seq: 1, amountUsdc: "0.01" } });
    const id = BigInt(fetched.receipt.sessionId);
    expect(opened.sessionId).not.toBe(id.toString());
    const session = await publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [id] });
    expect(session).toMatchObject({ state: SessionState.OPEN, buyer: buyer.address, cap: 500_000n });
    const status = await call("agentpay_status", { sessionId: id.toString() });
    expect(status.sessions).toMatchObject([{ sessionId: id.toString(), capUsdc: "0.5", usedUsdc: "0.01", state: "OPEN" }]);
    expect(Number(status.balanceUsdc)).toBeGreaterThan(0);
    expect(owner.address).not.toBe(buyer.address);
  } finally {
    await client.close();
    sdk?.stop();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await chain.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
