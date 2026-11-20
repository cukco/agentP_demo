/** `pnpm agentpay:check`: is this machine ready for the AgentPay MCP server? Read-only. */
import { CHAIN_ID, DEPLOYMENTS, agentPaySessionEscrowAbi } from "@agentpay/core";
import { createPublicClient, erc20Abi, formatEther, formatUnits, http, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { FAUCETS, loadEnv } from "./public-config.js";

const env = await loadEnv();
const rows: [boolean, string, string][] = [];
async function check(item: string, run: () => Promise<[boolean, string]>) {
  try { const [ok, detail] = await run(); rows.push([ok, item, detail]); }
  catch (error) { rows.push([false, item, (error as Error).message.split("\n")[0]!.slice(0, 100)]); }
}
const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(15_000) });
const client = createPublicClient({ chain: avalancheFuji, transport: http(env.FUJI_RPC_URL_1, { timeout: 10_000 }) });
const escrow = (env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow) as `0x${string}`;

await check("Fuji RPC", async () => { const id = await client.getChainId(); return [id === CHAIN_ID.fuji, `chain ${id}`]; });
await check("Verifier", async () => { const r = await get(`${env.VERIFIER_URL}/health`); return [r.ok, `HTTP ${r.status}`]; });
await check("Facilitator", async () => { const r = await get(`${env.FACILITATOR_URL}/supported`); return [r.ok, `HTTP ${r.status}`]; });
await check("Scorer (seller 306)", async () => {
  const r = await get(`${env.SCORER_URL}/v1/score/306`); const body = await r.json() as { score?: number };
  return [r.ok, `score ${body.score}`];
});
await check("Seller AVAX trả 402", async () => { const r = await get(env.SELLER_URL!); return [r.status === 402, `HTTP ${r.status}`]; });

const key = env.AGENTPAY_AGENT_KEY as `0x${string}` | undefined;
if (!key) rows.push([false, "Ví agent", "chưa có → chạy pnpm agentpay:wallet"]);
else {
  const address = privateKeyToAccount(key).address;
  await check(`Ví agent ${address}`, async () => {
    const [usdc, avax] = await Promise.all([
      client.readContract({ address: DEPLOYMENTS.fuji.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      client.getBalance({ address }),
    ]);
    return [usdc >= 500_000n, `${formatUnits(usdc, 6)} USDC · ${formatEther(avax).slice(0, 6)} AVAX${usdc < 500_000n ? ` → nạp USDC: ${FAUCETS.usdc}` : ""}`];
  });
  await check("Luật chi tiêu trên chain", async () => {
    const policy = await client.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "buyerPolicy", args: [address] });
    if (policy.admin === zeroAddress) return [true, "chưa đăng ký → luật mặc định: tối đa 20 USDC/phiên"];
    const left = await client.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "availableDaily", args: [address] });
    return [!policy.paused && left >= 500_000n, `${formatUnits(policy.maxPerSession, 6)}/phiên · còn ${formatUnits(left, 6)} USDC hôm nay · điểm ≥ ${policy.minScore}${policy.paused ? " · ĐANG DỪNG" : ""}`];
  });
}

const width = Math.max(...rows.map(([, item]) => item.length));
for (const [ok, item, detail] of rows) console.log(`${ok ? "✅" : "❌"} ${item.padEnd(width)}  ${detail}`);
const failed = rows.filter(([ok]) => !ok).length;
console.log(failed ? `\n${failed} mục chưa sẵn sàng.` : "\nSẵn sàng: nối MCP vào AI theo docs/MCP.md.");
process.exitCode = failed ? 1 : 0;
