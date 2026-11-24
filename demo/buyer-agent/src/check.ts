/**
 * `pnpm agentpay:check`: is this machine ready for the AgentPay MCP server? Read-only.
 * `pnpm agentpay:check -- --demo`: also the things a live demo depends on (Chainlink latency, low-score seller,
 * website, AVAX for the hosted Verifier / Keeper / Facilitator wallets when their addresses are in .env).
 */
import { CHAIN_ID, CHAINLINK_AVAX_USD_MAINNET, DEPLOYMENTS, agentPaySessionEscrowAbi } from "@agentpay/core";
import { createPublicClient, erc20Abi, formatEther, formatUnits, http, parseAbi, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche, avalancheFuji } from "viem/chains";
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

if (process.argv.includes("--demo")) {
  const ms = (t: number) => `${Math.round(performance.now() - t)} ms`;
  await check("Verifier → RPC Fuji + mainnet", async () => {
    const body = await (await get(`${env.VERIFIER_URL}/health`)).json() as { rpc?: { fuji?: boolean; mainnet?: boolean[] } };
    const main = body.rpc?.mainnet ?? [];
    return [!!body.rpc?.fuji && main.some(Boolean), `Fuji ${body.rpc?.fuji ? "ok" : "lỗi"} · mainnet ${main.filter(Boolean).length}/${main.length}`];
  });
  for (const rpc of new Set(["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc", env.AVAX_MAINNET_RPC_URL_1 ?? ""].filter(Boolean))) {
    await check(`Chainlink AVAX/USD (${new URL(rpc).hostname})`, async () => {
      const main = createPublicClient({ chain: avalanche, transport: http(rpc, { timeout: 5_000 }) });
      const t = performance.now();
      const [, answer, , updatedAt] = await main.readContract({ address: CHAINLINK_AVAX_USD_MAINNET as Address,
        abi: parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]), functionName: "latestRoundData" });
      const took = performance.now() - t;
      // The Verifier gives the oracle ~400 ms; slower answers become INCONCLUSIVE (reason 20) on stage.
      return [took < 400, `$${(Number(answer) / 1e8).toFixed(2)} · ${ms(t)} · cập nhật ${Math.round(Date.now() / 1000 - Number(updatedAt))} giây trước`];
    });
  }
  await check("Seller điểm thấp trả 402", async () => {
    const r = await get(env.LOW_SCORE_SELLER_URL ?? "https://agentpay-low-seller.fly.dev/v1/price/AVAX"); return [r.status === 402, `HTTP ${r.status}`];
  });
  await check("Website + Dashboard", async () => {
    const base = env.DASHBOARD_URL ?? "https://agentpay-dashboard.fly.dev";
    const [site, app, api] = await Promise.all([get(base), get(`${base}/app`), get(`${base}/api/verifier/v1/health`)]);
    return [site.ok && app.ok && api.ok, `${base} · trang ${site.status} · app ${app.status} · proxy ${api.status}`];
  });
  for (const [name, variable] of [["Verifier", "VERIFIER_ADDRESS"], ["Keeper", "KEEPER_ADDRESS"], ["Facilitator", "FACILITATOR_ADDRESS"]] as const) {
    const address = env[variable] as Address | undefined;
    if (!address) continue;
    await check(`AVAX ví ${name}`, async () => {
      const avax = await client.getBalance({ address });
      return [avax >= 10n ** 17n, `${formatEther(avax).slice(0, 6)} AVAX${avax < 10n ** 17n ? " → nạp thêm (cần ≥ 0,1)" : ""}`];
    });
  }
}

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
    if (policy.admin === zeroAddress) {
      // On stage the "20 USDC" and low-score scenes only get blocked when rules are registered.
      return [!process.argv.includes("--demo"), `chưa đăng ký → luật mặc định: tối đa 20 USDC/phiên${process.argv.includes("--demo") ? " → chạy pnpm agentpay:rules -- --admin <ví MetaMask>" : ""}`];
    }
    const left = await client.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "availableDaily", args: [address] });
    return [!policy.paused && left >= 500_000n, `${formatUnits(policy.maxPerSession, 6)}/phiên · còn ${formatUnits(left, 6)} USDC hôm nay · điểm ≥ ${policy.minScore}${policy.paused ? " · ĐANG DỪNG" : ""}`];
  });
}

const width = Math.max(...rows.map(([, item]) => item.length));
for (const [ok, item, detail] of rows) console.log(`${ok ? "✅" : "❌"} ${item.padEnd(width)}  ${detail}`);
const failed = rows.filter(([ok]) => !ok).length;
console.log(failed ? `\n${failed} mục chưa sẵn sàng.` : "\nSẵn sàng: nối MCP vào AI theo docs/MCP.md.");
process.exitCode = failed ? 1 : 0;
