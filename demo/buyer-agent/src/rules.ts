/**
 * `pnpm agentpay:rules`: register on-chain spending rules for the agent wallet (registerBuyer), without MetaMask.
 * The agent wallet signs once (needs ~0.01 AVAX for gas); afterwards only the admin (the owner's own wallet) can
 * tighten, pause or propose loosening the rules — on the Dashboard. Never prints the key.
 *   pnpm agentpay:rules -- --admin 0xOWNER [--per-session 5] [--daily 10] [--min-score 30]
 *   pnpm agentpay:rules              (show current rules)
 */
import { parseArgs } from "node:util";
import { DEPLOYMENTS, agentPaySessionEscrowAbi } from "@agentpay/core";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, isAddress, parseUnits, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { FAUCETS, loadEnv } from "./public-config.js";

for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => { console.error(error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error)); process.exit(1); });
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const { values } = parseArgs({ args, options: {
  admin: { type: "string" }, "per-session": { type: "string", default: "5" }, daily: { type: "string", default: "10" },
  "min-score": { type: "string", default: "30" },
} });
const env = await loadEnv();
if (!env.AGENTPAY_AGENT_KEY) throw new Error("Chưa có ví agent → chạy pnpm agentpay:wallet trước.");
const account = privateKeyToAccount(env.AGENTPAY_AGENT_KEY as `0x${string}`);
const escrow = (env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow) as `0x${string}`;
const transport = http(env.FUJI_RPC_URL_1);
const client = createPublicClient({ chain: avalancheFuji, transport });
const usd = (v: bigint) => formatUnits(v, 6);
const show = async () => {
  const p = await client.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "buyerPolicy", args: [account.address] });
  if (p.admin === zeroAddress) return false;
  console.log(`Ví agent ${account.address}\n  admin ${p.admin}\n  ${usd(p.maxPerSession)} USDC/phiên · ${usd(p.dailyCap)} USDC/ngày · điểm uy tín ≥ ${p.minScore}${p.paused ? " · ĐANG DỪNG" : ""}`);
  return true;
};

if (await show()) {
  if (values.admin) console.log("\nĐã có luật. Muốn đổi: kết nối ví admin trên Dashboard (pnpm agentpay:dashboard) → siết ngay, nới sau 24 giờ.");
  process.exit(0);
}
if (!values.admin) {
  console.log(`Ví agent ${account.address} chưa có luật (Escrow dùng luật mặc định: tối đa 20 USDC/phiên).\n` +
    "Đặt luật: pnpm agentpay:rules -- --admin <ví của bạn> [--per-session 5] [--daily 10] [--min-score 30]");
  process.exit(0);
}
if (!isAddress(values.admin) || values.admin.toLowerCase() === account.address.toLowerCase()) {
  throw new Error("--admin phải là ví của bạn (khác ví agent), để agent không tự nới luật.");
}
const minScore = Number(values["min-score"]);
const policy = { maxPerSession: parseUnits(values["per-session"]!, 6), dailyCap: parseUnits(values.daily!, 6), minScore,
  paused: false, sellerAllowlistOn: false };
if (policy.maxPerSession <= 0n || policy.maxPerSession > 20_000_000n || policy.dailyCap < policy.maxPerSession ||
    !Number.isInteger(minScore) || minScore < 0 || minScore > 100) {
  throw new Error("Hạn mỗi phiên trong (0, 20] USDC, hạn ngày ≥ hạn phiên, điểm 0–100.");
}
const gas = await client.getBalance({ address: account.address });
if (gas < 10n ** 16n) throw new Error(`Ví agent cần ~0,01 AVAX để gửi giao dịch đăng ký (đang có ${formatEther(gas)}). Faucet: ${FAUCETS.avax}`);
const wallet = createWalletClient({ account, chain: avalancheFuji, transport });
const hash = await wallet.writeContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "registerBuyer", args: [values.admin, policy] });
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Giao dịch đăng ký bị revert");
console.log(`Đã đăng ký luật: https://testnet.snowtrace.io/tx/${hash}\n`);
await show();
