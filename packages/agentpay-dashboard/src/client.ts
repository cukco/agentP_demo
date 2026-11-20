import { agentPaySessionEscrowAbi, DEPLOYMENTS, type PolicyParams } from "@agentpay/core";
import { createPublicClient, createWalletClient, custom, http, parseAbi, type Abi, type Address, type EIP1193Provider, type Hash } from "viem";
import { avalancheFuji } from "viem/chains";

declare global { interface Window { ethereum?: EIP1193Provider } }
export interface Config { escrow: Address; usdc: Address; startBlock: bigint; rpc: string; verifier: string; scorer: string; local: boolean }
export interface BuyerState {
  policy: PolicyParams & { admin: Address };
  bucket: { available: bigint; lastUpdate: bigint };
  available: bigint;
  loosen: { policy: PolicyParams; effectiveAt: bigint };
  admin: { newAdmin: Address; effectiveAt: bigint };
  balance: bigint;
}
export interface ChainEvent { name: string; args: Record<string, unknown>; hash: Hash; block: bigint; time: number; index: number }
const abi = agentPaySessionEscrowAbi;
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export function createClient(config: Config) {
  const client = createPublicClient({ chain: avalancheFuji, transport: http(config.rpc), pollingInterval: 500 });
  let cursor = config.startBlock, logs: ChainEvent[] = [], scan: Promise<ChainEvent[]> | undefined;
  async function history() {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    if (head < cursor - 1n) { cursor = config.startBlock; logs = []; }
    // Re-read a short overlap to handle shallow reorgs.
    const start = cursor > config.startBlock + 12n ? cursor - 12n : config.startBlock;
    const fresh: ChainEvent[] = [];
    const times = new Map<bigint, number>();
    for (let from = start; from <= head; from += 2000n) {
      const batch = await client.getLogs({ address: config.escrow, events: abi.filter(e => e.type === "event"),
        fromBlock: from, toBlock: from + 1999n < head ? from + 1999n : head, strict: true });
      for (const log of batch) {
        if (!times.has(log.blockNumber)) times.set(log.blockNumber, Number((await client.getBlock({ blockNumber: log.blockNumber })).timestamp));
        fresh.push({ name: log.eventName!, args: log.args as Record<string, unknown>, hash: log.transactionHash,
          block: log.blockNumber, time: times.get(log.blockNumber)!, index: log.logIndex });
      }
    }
    logs = [...logs.filter(l => l.block < start), ...fresh]; cursor = head + 1n;
    return logs;
  }
  return {
    config, publicClient: client,
    async buyer(address: Address): Promise<BuyerState> {
      const read = (functionName: "buyerPolicy" | "bucket" | "availableDaily" | "pendingLoosen" | "pendingAdmin") =>
        client.readContract({ address: config.escrow, abi, functionName, args: [address] });
      const [policy, bucket, available, loosen, admin, balance] = await Promise.all([
        read("buyerPolicy"), read("bucket"), read("availableDaily"), read("pendingLoosen"), read("pendingAdmin"),
        client.readContract({ address: config.usdc, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
      ]);
      return { policy, bucket, available, loosen, admin, balance } as BuyerState;
    },
    events() { return scan ??= history().finally(() => { scan = undefined; }); },
    async balance(address: Address) { return client.readContract({ address: config.usdc, abi: tokenAbi, functionName: "balanceOf", args: [address] }); },
    async send(account: Address, functionName: string, args: unknown[]) {
      if (!window.ethereum) throw new Error("Cần ví MetaMask để gửi giao dịch.");
      const wallet = createWalletClient({ chain: avalancheFuji, account, transport: custom(window.ethereum) });
      if (await wallet.getChainId() !== 43113) throw new Error("Hãy chuyển ví sang Avalanche Fuji (43113).");
      const [active] = await wallet.getAddresses();
      if (active?.toLowerCase() !== account.toLowerCase()) throw new Error("Tài khoản ví đã thay đổi. Hãy thử lại.");
      const request = { address: config.escrow, abi: abi as Abi, functionName, args, account };
      await client.simulateContract(request);
      // Bucket refill can change storage-write costs between estimation and the next block.
      const estimated = await client.estimateContractGas(request);
      const hash = await wallet.writeContract({ ...request, gas: estimated * 120n / 100n + 10000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Giao dịch không thành công.");
      return hash;
    },
  };
}
export type DashboardClient = ReturnType<typeof createClient>;
export async function loadConfig(): Promise<Config> {
  const env = import.meta.env;
  const local = env.VITE_LOCAL === "true";
  let deployment = DEPLOYMENTS.fuji;
  if (local) {
    const response = await fetch("/deployments/local.json");
    if (!response.ok) throw new Error("Chưa có deployments/local.json. Hãy chạy anvil-up trước.");
    deployment = await response.json();
  }
  return { escrow: deployment.escrow, usdc: deployment.usdc, startBlock: BigInt(deployment.deployBlock ?? 0),
    rpc: env.VITE_RPC_URL ?? (local ? "http://127.0.0.1:8545" : "https://api.avax-test.network/ext/bc/C/rpc"),
    verifier: env.VITE_VERIFIER_URL ?? "/api/verifier", scorer: env.VITE_SCORER_URL ?? "/api/scorer", local };
}
