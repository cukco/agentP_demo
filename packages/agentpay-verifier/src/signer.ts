import { TYPES, agentPayDomain, type Receipt, type SessionVerdict, type Signed } from "@agentpay/core";
import type { Address, LocalAccount } from "viem";

export function createSigner(account: LocalAccount, chainId: number, escrow: Address) {
  const domain = agentPayDomain(chainId, escrow);
  return {
    address: account.address,
    async signReceipt(message: Receipt): Promise<Signed<Receipt>> {
      const signature = await account.signTypedData({ domain, types: TYPES.Receipt, primaryType: "Receipt", message });
      return { message, signature };
    },
    async signVerdict(message: SessionVerdict): Promise<Signed<SessionVerdict>> {
      const signature = await account.signTypedData({
        domain, types: TYPES.SessionVerdict, primaryType: "SessionVerdict", message,
      });
      return { message, signature };
    },
  };
}
