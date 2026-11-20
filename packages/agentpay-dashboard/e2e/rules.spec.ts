import { test, expect } from "@playwright/test";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { startChain, type TestChain } from "../../agentpay-keeper/test/helpers/chain.js";
let chain: TestChain;
test.beforeAll(async () => {
  chain = await startChain({ chainId: 43113 });
  await mkdir(new URL("../../../deployments/", import.meta.url), { recursive: true });
  await writeFile(new URL("../../../deployments/local.json", import.meta.url), JSON.stringify({ chainId: 43113, escrow: chain.escrow, usdc: chain.usdc, deployBlock: "0", rpc: chain.rpc }));
});
test.afterAll(async () => { await chain?.stop(); await unlink(new URL("../../../deployments/local.json", import.meta.url)).catch(() => {}); });
test("register, tighten, propose, cancel and pause using real escrow", async ({ page }) => {
  await page.route("**/deployments/local.json", async route => route.fulfill({ json: { chainId: 43113, escrow: chain.escrow, usdc: chain.usdc, deployBlock: "0", rpc: chain.rpc } }));
  await page.route("http://127.0.0.1:8545/**", route => route.continue({ url: chain.rpc }));
  await page.addInitScript(({ rpc, account }) => {
    let connected = false;
    const provider = {
      on() {}, removeListener() {},
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_accounts") return connected ? [account] : [];
        if (method === "eth_requestAccounts") { connected = true; return [account]; }
        if (method === "eth_chainId") return "0xa869";
        if (method === "wallet_switchEthereumChain") return null;
        const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
        const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
      },
    };
    Object.defineProperty(window, "ethereum", { value: provider });
  }, { rpc: chain.rpc, account: chain.accounts.buyer.address });
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví" }).click();
  await page.getByRole("button", { name: "Đăng ký luật", exact: true }).click();
  await expect(page.getByText("Đang hoạt động", { exact: true })).toBeVisible();
  await page.getByLabel("Hạn mỗi phiên (USDC)").fill("0.5");
  await page.getByRole("button", { name: "Siết luật ngay" }).click();
  await expect(page.getByText(/Hạn phiên \$0.50/)).toBeVisible();
  await page.getByLabel("Hạn mỗi phiên (USDC)").fill("0.75");
  await page.getByRole("button", { name: "Đề xuất nới luật (24 giờ)" }).click();
  await expect(page.getByText("Đang chờ nới luật", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/agentpay-dashboard-rules.png", fullPage: true });
  await page.getByRole("button", { name: "Hủy nới luật" }).click();
  await expect(page.getByText("Đang chờ nới luật", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Dừng người mua" }).click();
  await expect(page.getByText("Đang dừng", { exact: true })).toBeVisible();
  await expect(chain.open({ cap: 500000n })).rejects.toThrow(/BuyerIsPaused/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/agentpay-dashboard-mobile.png", fullPage: true });
});
