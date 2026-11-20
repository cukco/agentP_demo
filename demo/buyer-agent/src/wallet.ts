/** `pnpm agentpay:wallet`: create (once) the agent wallet for the MCP server and print how to fund and connect it. Never prints the key. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { FAUCETS, PUBLIC_DEFAULTS, ensureWallet, loadEnv, walletFile } from "./public-config.js";

const env = { ...process.env };
const created = await ensureWallet(env);
const file = walletFile(env);
const address = privateKeyToAccount((await readFile(file, "utf8")).trim() as `0x${string}`).address;
const server = fileURLToPath(new URL("./mcp.js", import.meta.url)).replaceAll("\\", "/");
const active = (await loadEnv()).AGENTPAY_AGENT_KEY;

console.log(`${created ? "Đã tạo" : "Đã có"} ví agent: ${address}`);
console.log(`Khóa lưu tại ${file} (chỉ dùng cho testnet, không nạp tiền thật).`);
if (process.env.AGENTPAY_AGENT_KEY && active !== (await readFile(file, "utf8")).trim()) {
  console.log("Lưu ý: AGENTPAY_AGENT_KEY trong môi trường đang được ưu tiên hơn file này.");
}
console.log(`
1) Nạp USDC test (≥ 1 USDC) cho ${address}
   ${FAUCETS.usdc}
   Tùy chọn ~0,05 AVAX (chỉ cần khi đặt luật trên Dashboard): ${FAUCETS.avax}
2) Kiểm tra:  pnpm agentpay:check
3) Nối vào AI (xem docs/MCP.md cho Cursor, VS Code, Gemini CLI, Codex):
   claude mcp add agentpay -- node ${server}
   JSON chung:  { "mcpServers": { "agentpay": { "command": "node", "args": ["${server}"] } } }
4) Hỏi AI:  Dùng agentpay mua giá AVAX từ ${PUBLIC_DEFAULTS.SELLER_URL}
5) Đặt luật chi tiêu (khuyên dùng):  pnpm agentpay:rules -- --admin <ví của bạn> --per-session 5 --daily 10 --min-score 30`);
