import {
  agentPaySessionEscrowAbi,
  type Delivery,
  type SessionVerdict,
  type Signed,
  type Voucher,
} from "@agentpay/core";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
export interface ChainWriter {
  close(
    id: bigint,
    verdict: Signed<SessionVerdict>,
    voucher?: Signed<Voucher>,
  ): Promise<Hex>;
  prove(id: bigint, a: Signed<Delivery>, b: Signed<Delivery>): Promise<Hex>;
  confirm(hash: Hex): Promise<boolean>;
}
export const CLOSE_GAS = 300_000n;
export const EQUIVOCATION_GAS = 500_000n;

export function createWriter(
  publicClient: PublicClient,
  wallet: WalletClient,
  escrow: Address,
): ChainWriter {
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = pending.then(fn, fn);
    pending = next.catch(() => {});
    return next;
  }
  // Fixed limits (estimateGas misses the ERC-8004 feedback, which runs in try/catch), but not 1M:
  // Fuji billed exactly half of a 1M limit (500k) for a ~111k closeSession. Used: close ~111k,
  // proveEquivocation ~200k with feedback.
  const base = {
    address: escrow,
    abi: agentPaySessionEscrowAbi,
    account: wallet.account!,
    chain: wallet.chain,
    gas: CLOSE_GAS,
  };
  return {
    close: (id, verdict, voucher) =>
      serial(() =>
        voucher
          ? wallet.writeContract({
              ...base,
              functionName: "closeSession",
              args: [
                id,
                voucher.message,
                voucher.signature,
                verdict.message,
                verdict.signature,
              ],
            })
          : wallet.writeContract({
              ...base,
              functionName: "closeEmpty",
              args: [id, verdict.message, verdict.signature],
            }),
      ),
    prove: (id, a, b) =>
      serial(() =>
        wallet.writeContract({
          ...base,
          functionName: "proveEquivocation",
          gas: EQUIVOCATION_GAS,
          args: [id, a.message, a.signature, b.message, b.signature],
        }),
      ),
    confirm: async (hash) =>
      (await publicClient.waitForTransactionReceipt({ hash, timeout: 12_000 }))
        .status === "success",
  };
}
