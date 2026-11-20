/**
 * AgentPay MCP server for the hosted Fuji demo: any MCP client (Claude, Cursor, VS Code Copilot, Gemini CLI, Codex…)
 * pays the AVAX price Seller from the agent wallet, inside the on-chain buyer rules. Speaks MCP over stdio, so
 * nothing but protocol messages goes to stdout. Setup: `pnpm agentpay:wallet`, then see docs/MCP.md.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentPayMcpFromEnv } from "@agentpay/mcp/dist/runtime.js";
import { loadEnv } from "./public-config.js";

const env = await loadEnv();
env.AGENTPAY_CHECKS_MODULE ??= fileURLToPath(new URL("./mcp-checks.js", import.meta.url));
env.AGENTPAY_SESSION_DIR ??= join(homedir(), ".agentpay", "mcp");
// The demo Seller's minCap is 0.5 USDC; each open locks its cap from the buyer's daily allowance.
env.AGENTPAY_DEFAULT_CAP_USD ??= "0.5";
Object.assign(process.env, env);

try {
  const server = await createAgentPayMcpFromEnv(env, () => Math.floor(Date.now() / 1000));
  await server.connect(new StdioServerTransport());
} catch {
  console.error(env.AGENTPAY_AGENT_KEY || env.AGENTPAY_KEYSTORE_PATH
    ? "AgentPay MCP could not start. Run `pnpm agentpay:check` to see which service or setting fails."
    : "AgentPay MCP has no agent wallet. Run `pnpm agentpay:wallet` first.");
  process.exitCode = 1;
}
