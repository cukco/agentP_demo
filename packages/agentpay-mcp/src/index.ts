import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentPayMcpFromEnv } from "./runtime.js";

export const COMPONENT = "@agentpay/mcp" as const;
export { createAgentPayMcp, type AgentPayMcpOptions, type BuyerStatus } from "./server.js";

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const server = await createAgentPayMcpFromEnv(process.env, () => Math.floor(Date.now() / 1000));
    await server.connect(new StdioServerTransport());
  } catch {
    console.error("AgentPay MCP could not start. Check credentials, RPC and service configuration.");
    process.exitCode = 1;
  }
}
