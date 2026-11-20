import { BuyerReceiptError, BuyerSessionPolicyError, type AgentPayBuyer } from "@agentpay/buyer";
import { Outcome, ZERO_HASH, type Receipt, type Wire } from "@agentpay/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentPayMcp, type BuyerStatus } from "../src/index.js";

const key = "0x" + "a3".repeat(32);
const path = "C:\\AgentPay\\private\\buyer.json";
const signature = "0x" + "b4".repeat(64) + "1b";
const signatureBase64 = Buffer.from(signature.slice(2), "hex").toString("base64");
const sensitive = [key, path, signature, signatureBase64];
const secretText = sensitive.join(" ");
const url = "https://seller.example/file";
const receipt: Wire<Receipt> = { sessionId: "42", seq: 1, outcome: Outcome.PASS, reasonCode: 0, amount: "10000",
  bodyHash: ZERO_HASH, requestHash: ZERO_HASH, evidenceHash: ZERO_HASH, receivedAt: "1730000000" };
const summary: BuyerStatus = { balanceUsdc: "2.5", policy: {
  admin: "0x" + "ab".repeat(20), maxPerSessionUsdc: "2", dailyCapUsdc: "10", minScore: 50,
  paused: false, sellerAllowlistOn: false,
}, sessions: [{ sessionId: "42", state: "OPEN", capUsdc: "1", usedUsdc: "0.01", expiry: "1730000300" }] };

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function fixture() {
  const fetchWithReceipt = vi.fn<AgentPayBuyer["fetchWithReceipt"]>(async () => ({
    response: new Response("seller result " + secretText), receipt,
  }));
  const openSession = vi.fn<AgentPayBuyer["openSession"]>(async () => "42");
  const close = vi.fn<AgentPayBuyer["close"]>(async () => {});
  const status = vi.fn(async () => ({ ...summary, evidence: { signature, path, key } }));
  const buyer: AgentPayBuyer = { fetch: vi.fn(), fetchWithReceipt, openSession, close };
  const server = createAgentPayMcp({ buyer, status, redact: [key, path] });
  const client = new Client({ name: "c6-memory", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  async function call(name: string, args: Record<string, unknown>, isError = false) {
    const result = await client.callTool({ name, arguments: args });
    expect(Boolean(result.isError)).toBe(isError);
    const content = result.content as { type: string; text: string }[];
    const serialized = JSON.stringify(result);
    for (const item of sensitive) {
      expect(serialized.includes(item)).toBe(false);
      expect(serialized.includes(JSON.stringify(item).slice(1, -1))).toBe(false);
    }
    expect(serialized).not.toContain("Error: stack");
    return JSON.parse(content[0]!.text);
  }
  return { client, call, fetchWithReceipt, openSession, close, status };
}

it("lists exactly four tools and returns safe success data from each", async () => {
  const f = await fixture();
  expect((await f.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
    "agentpay_close_session", "agentpay_fetch", "agentpay_open_session", "agentpay_status",
  ]);
  expect(await f.call("agentpay_fetch", { url, method: "POST", body: "test", maxCapUsd: "0.75" })).toEqual({
    status: 200, body: "seller result [redacted] [redacted] [redacted] [redacted]",
    receipt: { sessionId: "42", seq: 1, outcome: "PASS", reasonCode: 0, amountUsdc: "0.01" },
  });
  expect(f.fetchWithReceipt).toHaveBeenCalledWith(url, { method: "POST", body: "test" }, 750_000n);
  expect(await f.call("agentpay_open_session", { url, capUsd: 0.5, expiryMinutes: 30 })).toEqual({ sessionId: "42" });
  expect(f.openSession).toHaveBeenCalledWith(url, { cap: 500_000n, expirySec: 1800 });
  expect(await f.call("agentpay_close_session", { sessionId: "42" })).toEqual({ sessionId: "42", closeRequested: true });
  expect(f.close).toHaveBeenCalledWith("42");
  expect(await f.call("agentpay_status", { sessionId: "42" })).toEqual(summary);
  expect(f.status).toHaveBeenCalledWith("42");
});

it("keeps dependency errors private for all tools and summarizes a verified FAIL without its signature", async () => {
  const f = await fixture();
  const error = new Error("Error: stack " + secretText);
  for (const mock of [f.fetchWithReceipt, f.openSession, f.close, f.status]) mock.mockRejectedValueOnce(error);
  expect(await f.call("agentpay_fetch", { url }, true)).toEqual({ error: "AgentPay fetch failed" });
  expect(await f.call("agentpay_open_session", { url, capUsd: 1, expiryMinutes: 5 }, true)).toEqual({ error: "Could not open an AgentPay session" });
  expect(await f.call("agentpay_close_session", { sessionId: "42" }, true)).toEqual({ error: "Could not close the AgentPay session" });
  expect(await f.call("agentpay_status", {}, true)).toEqual({ error: "Could not read AgentPay status" });

  f.fetchWithReceipt.mockRejectedValueOnce(new BuyerReceiptError({
    message: { ...receipt, amount: "0", outcome: Outcome.FAIL, reasonCode: 15 }, signature: signature as "0x"
  }));
  expect(await f.call("agentpay_fetch", { url }, true)).toMatchObject({ receipt: { outcome: "FAIL", reasonCode: 15, amountUsdc: "0" } });

  f.fetchWithReceipt.mockRejectedValueOnce(new BuyerSessionPolicyError("BadScore"));
  expect(await f.call("agentpay_fetch", { url }, true)).toEqual({ error: "Blocked by on-chain buyer rules", rule: "BadScore" });
  f.openSession.mockRejectedValueOnce(new BuyerSessionPolicyError("OverPerSession"));
  expect(await f.call("agentpay_open_session", { url, capUsd: 1, expiryMinutes: 5 }, true))
    .toEqual({ error: "Blocked by on-chain buyer rules", rule: "OverPerSession" });
});

it("rejects invalid caps and ids before dispatch and omits uninterpreted binary bytes", async () => {
  const f = await fixture();
  for (const [name, args] of [
    ["agentpay_open_session", { url, capUsd: "0.0000001", expiryMinutes: 5 }],
    ["agentpay_close_session", { sessionId: "../" }],
    ["agentpay_fetch", { url: "file:///private/key.json" }],
  ] as const) {
    const result = await f.client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
  }
  expect(f.openSession).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
  expect(f.fetchWithReceipt).not.toHaveBeenCalled();
  const invalid = await f.client.callTool({ name: "agentpay_fetch", arguments: { url, method: secretText } });
  expect(invalid.isError).toBe(true);
  for (const item of sensitive) expect(JSON.stringify(invalid)).not.toContain(JSON.stringify(item).slice(1, -1));
  f.fetchWithReceipt.mockResolvedValueOnce({
    response: new Response(Buffer.from(signature.slice(2), "hex"), { headers: { "content-type": "application/octet-stream" } }),
  });
  expect(await f.call("agentpay_fetch", { url })).toEqual({ status: 200, body: null });
});
