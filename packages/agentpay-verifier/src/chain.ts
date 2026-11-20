import { CHAIN_ID, SessionState, agentPaySessionEscrowAbi } from "@agentpay/core";
import { isAddressEqual, type Address, type PublicClient } from "viem";

export interface ChainSession {
  buyer: Address;
  voucherSigner: Address;
  seller: Address;
  sellerAgentId: bigint;
  verifier: Address;
  specHash: `0x${string}`;
  cap: bigint;
  pricePerRequest: bigint;
  sessionFee: bigint;
  expiry: bigint;
  deliveryDeadlineSec: number;
  challengeWindowSec: number;
  state: number;
}

export interface ChainAdapter {
  getSession(id: bigint): Promise<ChainSession | null>;
  scanSessionOpened(from: bigint, to: bigint): Promise<bigint[]>;
  getBlockNumber(): Promise<bigint>;
  health(): Promise<{ fuji: boolean; mainnet: [boolean, boolean] }>;
}

export function createChain(
  fuji: PublicClient,
  mainnet: readonly [PublicClient, PublicClient],
  escrow: Address,
  verifier: Address,
): ChainAdapter {
  const probe = (client: PublicClient, chainId: number) =>
    client.getChainId().then(actual => actual === chainId, () => false);
  return {
    async getSession(id) {
      const session = await fuji.readContract({
        address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [id],
      });
      if (session.state === SessionState.NONE || !isAddressEqual(session.verifier, verifier)) return null;
      return session;
    },
    async scanSessionOpened(fromBlock, toBlock) {
      const logs = await fuji.getContractEvents({
        address: escrow, abi: agentPaySessionEscrowAbi, eventName: "SessionOpened",
        fromBlock, toBlock, strict: true,
      });
      return logs.map(log => log.args.sessionId);
    },
    getBlockNumber: () => fuji.getBlockNumber(),
    async health() {
      const [fujiOk, first, second] = await Promise.all([
        probe(fuji, CHAIN_ID.fuji), probe(mainnet[0], CHAIN_ID.avalanche), probe(mainnet[1], CHAIN_ID.avalanche),
      ]);
      return { fuji: fujiOk, mainnet: [first, second] };
    },
  };
}
