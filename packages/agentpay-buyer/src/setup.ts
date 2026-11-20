import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CHAIN_ID, DEPLOYMENTS, agentPaySessionEscrowAbi, toWire, type PolicyParams } from "@agentpay/core";
import {
  createPublicClient, createWalletClient, http, isAddress, type Address, type LocalAccount, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";

export async function registerBuyer(options: {
  escrow: Address;
  admin: Address;
  policy: PolicyParams;
  account: LocalAccount;
  publicClient: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  walletClient: Pick<WalletClient, "chain" | "writeContract">;
}) {
  const { escrow, admin, policy, account, publicClient, walletClient } = options;
  const hash = await walletClient.writeContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "registerBuyer", args: [admin, policy],
    account, chain: walletClient.chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Buyer registration reverted");
  return publicClient.readContract({
    address: escrow, abi: agentPaySessionEscrowAbi, functionName: "buyerPolicy", args: [account.address],
  });
}

async function main() {
  const [admin, policyPath] = process.argv.slice(2);
  const key = process.env.BUYER_AUTO_PRIVATE_KEY;
  const rpc = process.env.FUJI_RPC_URL_1;
  const escrow = process.env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow;
  if (!admin || !isAddress(admin) || !isAddress(escrow) || !policyPath || !rpc || !key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Usage: pnpm --filter @agentpay/buyer run setup <admin-address> <policy.json>");
  }
  const input = JSON.parse(await readFile(policyPath, "utf8"));
  if (typeof input.maxPerSession !== "string" || !/^\d+$/.test(input.maxPerSession) ||
      typeof input.dailyCap !== "string" || !/^\d+$/.test(input.dailyCap) ||
      !Number.isInteger(input.minScore) || input.minScore < 0 || input.minScore > 100 ||
      typeof input.paused !== "boolean" || typeof input.sellerAllowlistOn !== "boolean") throw new Error("Invalid buyer policy");
  const policy: PolicyParams = { maxPerSession: BigInt(input.maxPerSession), dailyCap: BigInt(input.dailyCap),
    minScore: input.minScore, paused: input.paused, sellerAllowlistOn: input.sellerAllowlistOn };
  const account = privateKeyToAccount(key as `0x${string}`);
  const transport = http(rpc);
  const publicClient = createPublicClient({ chain: avalancheFuji, transport });
  if (await publicClient.getChainId() !== CHAIN_ID.fuji) throw new Error("Registration RPC is not Fuji");
  const walletClient = createWalletClient({ chain: avalancheFuji, transport, account });
  const registered = await registerBuyer({ escrow, admin, policy, account, publicClient, walletClient });
  console.log(JSON.stringify(toWire(registered), null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch(() => {
    console.error("Buyer registration failed. Check the admin and policy file, buyer key, Fuji RPC and escrow configuration.");
    process.exitCode = 1;
  });
}
