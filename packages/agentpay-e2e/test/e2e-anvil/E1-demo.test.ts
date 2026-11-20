import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import { createAgentPayBuyer, createMemoryBuyerStore } from "@agentpay/buyer";
import { createAgentPaySeller } from "@agentpay/seller";
import { createCheckRunner } from "@agentpay/verifier/checks";
import {
  agentPaySessionEscrowAbi,
  bodyHash,
  type VerificationSpec,
} from "@agentpay/core";
import { fixture, feedbackCount } from "../helpers.js";
const get = fixture();
it("E1: browser approval → production relay → 15 PASS + 3 FAIL → auto-close → Keeper settlement", async () => {
  const s = get(),
    before = await s.balances(),
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    });
  const recording = process.env.B_RECORD_DIR
    ? resolve(process.env.B_RECORD_DIR)
    : undefined;
  if (recording) await mkdir(recording, { recursive: true });
  const logPage = recording
    ? await browser.newPage({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: recording, size: { width: 1280, height: 720 } },
      })
    : undefined;
  const video = logPage?.video();
  if (logPage)
    await logPage.setContent(
      '<html><body style="background:#101621;color:#d7e3ed;font:18px monospace;padding:30px"><h1>AgentPay · Verifier log</h1><p>Local Anvil · real SDKs and Verifier · simulated browser wallet</p><pre id="logs" style="font-size:15px;line-height:1.5">Waiting for approval and requests…</pre></body></html>',
    );
  async function renderLogs() {
    if (logPage)
      await logPage.locator("#logs").evaluate(
        (el, entries) => {
          el.textContent = entries
            .map(
              (e) =>
                `seq=${e.seq}  outcome=${e.outcome}  reason=${e.reasonCode}  verifier=${Math.round(Number(e.verifierMs))}ms`,
            )
            .join("\n");
        },
        s.metrics.filter((v) => v.event === "relay"),
      );
  }
  const bytes = Buffer.from("agreed result");
  let requests = 0;
  const spec: VerificationSpec = {
    specVersion: "agentpay-verify/0.2",
    serviceType: "file",
    passRule: "all",
    verifier: {
      address: s.chain.accounts.verifier.address,
      endpoint: s.urls.verifier,
    },
    delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
    checks: [{ id: "hash", type: "hash-match", expectedHash: bodyHash(bytes) }],
  };
  const seller = createAgentPaySeller({
    account: s.chain.accounts.seller,
    chainId: 43113,
    escrow: s.chain.escrow,
    asset: s.chain.usdc,
    publicClient: s.chain.publicClient,
    walletClient: s.chain.wallet("seller"),
    sellerAgentId: s.chain.agentId,
    pricePerRequest: 10000n,
    spec,
    verifierUrl: s.urls.verifier,
    clock: s.clock,
    terms: {
      minCap: 500000n,
      maxCap: 20000000n,
      defaultExpirySec: 180,
      maxExpirySec: 3600,
      deliveryDeadlineSec: 10,
      challengeWindowSec: 30,
    },
  });
  seller.stop();
  const app = new Hono();
  app.use("/file", seller.middleware());
  app.get(
    "/file",
    () =>
      new Response(++requests <= 15 ? bytes : Buffer.from("wrong result"), {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/file`,
      page = await browser.newPage();
    page.setDefaultTimeout(10000);
    let signatures = 0;
    await page.exposeFunction("testWalletSign", async (typed: string) => {
      signatures++;
      const data = JSON.parse(typed);
      expect(data.primaryType).toBe("ReceiveWithAuthorization");
      return s.chain.accounts.buyer.signTypedData(data);
    });
    await page.addInitScript((address) => {
      const host = window as unknown as {
        ethereum: unknown;
        testWalletSign: (data: string) => Promise<string>;
      };
      let chainId = "0x1";
      host.ethereum = {
        async request({
          method,
          params,
        }: {
          method: string;
          params: unknown[];
        }) {
          if (method === "eth_requestAccounts") return [address];
          if (method === "eth_chainId") return chainId;
          if (method === "wallet_switchEthereumChain") {
            chainId = (params[0] as { chainId: string }).chainId;
            return null;
          }
          if (method === "eth_signTypedData_v4")
            return host.testWalletSign(params[1] as string);
          throw new Error("Unexpected wallet method " + method);
        },
      };
    }, s.chain.accounts.buyer.address);
    const store = createMemoryBuyerStore(),
      checks = createCheckRunner();
    const buyer = createAgentPayBuyer({
      mode: "approve",
      buyerAddress: s.chain.accounts.buyer.address,
      chainId: 43113,
      publicClient: s.chain.publicClient,
      trustedEscrows: [s.chain.escrow],
      facilitatorUrl: s.urls.facilitator,
      scorerUrl: s.urls.scorer,
      clock: s.clock,
      store,
      defaultCap: 1000000n,
      defaultExpirySec: 180,
      softPolicy: { maxPerSession: 1000000n, maxPricePerRequest: 10000n },
      checks: async (input) => (await checks(input)).outcome,
      async onApprovalUrl(approvalUrl) {
        await page.goto(approvalUrl);
        await page.getByRole("button", { name: "Approve in MetaMask" }).click();
        await page.getByText("Signature sent", { exact: false }).waitFor();
      },
    });
    const id = BigInt(
      await buyer.openSession(url, { cap: 1000000n, expirySec: 180 }),
    );
    const opened = await s.chain.publicClient.readContract({
      address: s.chain.escrow,
      abi: agentPaySessionEscrowAbi,
      functionName: "getSession",
      args: [id],
    });
    expect(opened.voucherSigner.toLowerCase()).not.toBe(
      s.chain.accounts.buyer.address.toLowerCase(),
    );
    expect(signatures).toBe(1);
    for (let i = 0; i < 15; i++) {
      expect(await (await buyer.fetch(url)).text()).toBe("agreed result");
      await s.advance(1);
      await renderLogs();
    }
    for (let i = 0; i < 3; i++) {
      await expect(buyer.fetch(url)).rejects.toThrow("did not PASS");
      await s.advance(1);
      await renderLogs();
    }
    await s.runtime.tick();
    expect(await s.chain.state(id)).toBe(2);
    const status = await (
      await fetch(`${s.urls.verifier}/v1/sessions/${id}`)
    ).json();
    expect(status).toMatchObject({
      passCount: 15,
      failCount: 3,
      lastSeq: 18,
      passedAmount: "150000",
      failStreak: 3,
    });
    expect(status.closeTxHash).toMatch(/^0x/);
    await s.advance(31);
    expect((await s.keeper.runOnce()).map((v) => v.action)).toContain(
      "finalize",
    );
    expect(await s.chain.state(id)).toBe(4);
    expect(await feedbackCount(s)).toBe(1n);
    const after = await s.balances();
    expect(before.buyer - after.buyer).toBe(190000n);
    expect(after.seller - before.seller).toBe(149250n);
    expect(after.escrow - before.escrow).toBe(40750n);
    const timings = s.metrics
      .filter((v) => v.event === "relay")
      .map((v) => Number(v.verifierMs))
      .sort((a, b) => a - b);
    expect(timings).toHaveLength(18);
    const benchmark = {
      event: "verifier_benchmark",
      environment: "local-anvil",
      samples: timings.length,
      p50: timings[Math.ceil(timings.length * 0.5) - 1],
      p95: timings[Math.ceil(timings.length * 0.95) - 1],
      sellerExcluded: true,
    };
    console.log(JSON.stringify(benchmark));
    if (recording) {
      await writeFile(
        join(recording, "anvil-relay-metrics.json"),
        JSON.stringify({ benchmark, metrics: s.metrics }, null, 2) + "\n",
      );
      await logPage!.screenshot({ path: join(recording, "verifier-log.png") });
    }
  } finally {
    seller.stop();
    await browser.close();
    if (recording && video)
      await rename(await video.path(), join(recording, "verifier-log.webm"));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}, 120000);
