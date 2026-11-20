import { BuyerReceiptError, BuyerSessionPolicyError, type AgentPayBuyer } from "@agentpay/buyer";
import { Outcome, type Receipt, type Wire } from "@agentpay/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatUnits } from "viem";
import { z } from "zod";

const url = z.string().url().refine(value => {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
}, "Expected an HTTP(S) URL without credentials");
const id = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => /^\d+$/.test(value) && BigInt(value) < 2n ** 256n);
const methods: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
// The MCP SDK serializes Zod issues verbatim. A failed z.enum would echo the input.
const method = z.string().refine(value => methods.includes(value), "Invalid HTTP method")
  .describe("GET, HEAD, POST, PUT, PATCH or DELETE");
const usd = z.union([z.string(), z.number().finite()]).transform(String)
  .refine(value => /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value) && Number(value) > 0,
    "Expected a positive USDC amount with at most six decimal places");

export function parseUsd(value: string): bigint {
  const [whole, decimal = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
}

export interface BuyerStatus {
  balanceUsdc: string;
  policy: { admin: string; maxPerSessionUsdc: string; dailyCapUsdc: string; minScore: number; paused: boolean; sellerAllowlistOn: boolean };
  sessions: { sessionId: string; state: string; capUsdc: string; usedUsdc: string; expiry: string }[];
}

export interface AgentPayMcpOptions {
  buyer: AgentPayBuyer;
  status: (sessionId?: string) => Promise<BuyerStatus>;
  /** Configured secrets and keystore paths used only to scrub outgoing tool text. */
  redact?: readonly string[];
}

function receiptSummary(message: Wire<Receipt>) {
  const { sessionId, seq, outcome, reasonCode, amount } = message;
  return { sessionId: BigInt(sessionId).toString(), seq, outcome: Outcome[outcome] ?? "UNKNOWN", reasonCode, amountUsdc: formatUnits(BigInt(amount), 6) };
}

function scrub(text: string, sensitive: readonly string[]) {
  for (const value of sensitive) {
    if (value) text = text.replaceAll(value, "[redacted]");
  }
  // Ethereum signatures may be echoed by a remote response as hex or base64.
  return text.replace(/(?:0x)?[a-f0-9]{130,}/gi, "[redacted]")
    .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{87}=?(?![A-Za-z0-9+/_=-])/g, "[redacted]");
}

async function bodyText(response: Response): Promise<string | null> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
  if (response.body === null) return "";
  if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json")) {
    return response.text();
  }
  await response.body.cancel();
  return null;
}

export function createAgentPayMcp({ buyer, status, redact = [] }: AgentPayMcpOptions): McpServer {
  const server = new McpServer({ name: "agentpay", version: "0.2.0" });
  const escapedSecrets = redact.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]).sort((a, b) => b.length - a.length);
  const send = (data: object, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, (_key, value) =>
      typeof value === "string" ? scrub(value, escapedSecrets) : value) }],
    ...(isError && { isError: true }),
  });
  async function run(operation: () => Promise<object>, error: string, includeReceipt = false) {
    try {
      return send(await operation());
    } catch (cause) {
      // Never expose arbitrary SDK, RPC, wallet, filesystem or HTTP errors. On-chain buyer-rule rejections are a
      // fixed enum the agent must see, so it can tell the user which rule stopped the payment.
      if (cause instanceof BuyerSessionPolicyError) {
        return send({ error: "Blocked by on-chain buyer rules", rule: cause.code === "BadScore" ? "BadScore" : "OverPerSession" }, true);
      }
      return includeReceipt && cause instanceof BuyerReceiptError
        ? send({ error: "Seller response did not pass verification", receipt: receiptSummary(cause.receipt.message) }, true)
        : send({ error }, true);
    }
  }

  server.registerTool("agentpay_fetch", {
    description: "Fetch a URL with AgentPay and return the text and verified receipt summary.",
    inputSchema: { url, method: method.optional(),
      body: z.string().max(1_048_576).optional(), maxCapUsd: usd.optional() },
  }, ({ url, method = "GET", body, maxCapUsd }) => run(async () => {
    const { response, receipt } = await buyer.fetchWithReceipt(url, { method, body }, maxCapUsd === undefined ? undefined : parseUsd(maxCapUsd));
    const text = await bodyText(response);
    return { status: response.status, body: text,
      ...(receipt && { receipt: receiptSummary(receipt) }) };
  }, "AgentPay fetch failed", true));

  server.registerTool("agentpay_open_session", {
    description: "Open a new AgentPay session with the specified USDC cap and expiry.",
    inputSchema: { url, capUsd: usd, expiryMinutes: z.number().int().min(1).max(1440) },
  }, ({ url, capUsd, expiryMinutes }) => run(async () => ({
    sessionId: await buyer.openSession(url, { cap: parseUsd(capUsd), expirySec: expiryMinutes * 60 }),
  }), "Could not open an AgentPay session"));

  server.registerTool("agentpay_close_session", {
    description: "Request settlement of a buyer-owned AgentPay session.",
    inputSchema: { sessionId: id },
  }, ({ sessionId }) => run(async () => {
    await buyer.close(sessionId);
    return { sessionId, closeRequested: true };
  }, "Could not close the AgentPay session"));

  server.registerTool("agentpay_status", {
    description: "Show AgentPay sessions, USDC balance and on-chain buyer policy.",
    inputSchema: { sessionId: id.optional() },
  }, ({ sessionId }) => run(async () => {
    const { balanceUsdc, policy, sessions } = await status(sessionId);
    const { admin, maxPerSessionUsdc, dailyCapUsdc, minScore, paused, sellerAllowlistOn } = policy;
    return { balanceUsdc, policy: { admin, maxPerSessionUsdc, dailyCapUsdc, minScore, paused, sellerAllowlistOn },
      sessions: sessions.map(({ sessionId, state, capUsdc, usedUsdc, expiry }) => ({ sessionId, state, capUsdc, usedUsdc, expiry })) };
  }, "Could not read AgentPay status"));

  return server;
}
