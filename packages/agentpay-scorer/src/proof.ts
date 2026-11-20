import { walletProofMessage, type WalletProofRequest } from "@agentpay/core";
import { isAddress, isAddressEqual, verifyMessage, type Address, type Hex } from "viem";

export async function verifyWalletProof(agentId: string, input: unknown, now: number): Promise<WalletProofRequest | null> {
  if (!input || typeof input !== "object") return null;
  const p = input as WalletProofRequest;
  if (typeof p.mainnetWallet !== "string" || !isAddress(p.mainnetWallet, { strict: false }) ||
    typeof p.signature !== "string" || !/^0x[\da-f]{130}$/i.test(p.signature) ||
    typeof p.issuedAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(p.issuedAt)) return null;
  const issued = Date.parse(p.issuedAt) / 1000;
  if (!Number.isFinite(issued) || issued > now || now - issued > 600) return null;
  try {
    return await verifyMessage({ address: p.mainnetWallet, signature: p.signature,
      message: walletProofMessage(agentId, p.mainnetWallet, p.issuedAt) }) ? p : null;
  } catch { return null; }
}

/** Additional HTTP authorization; the frozen WalletProofRequest body is unchanged. */
export function walletLinkAuthorizationMessage(agentId: string, proof: Pick<WalletProofRequest, "mainnetWallet" | "issuedAt">,
  chainId: number, escrow: Address, agentWallet: Address): string {
  return `AgentPay wallet link authorization\nchainId: ${chainId}\nescrow: ${escrow.toLowerCase()}\nagentWallet: ${agentWallet.toLowerCase()}\n${walletProofMessage(agentId, proof.mainnetWallet, proof.issuedAt)}`;
}
export async function verifyWalletLinkAuthorization(agentId: string, proof: WalletProofRequest, agentWallet: Address,
  chainId: number, escrow: Address, signature?: string): Promise<boolean> {
  // The mainnet proof itself already proves control of the current payment wallet.
  if (isAddressEqual(proof.mainnetWallet, agentWallet)) return true;
  if (!signature || !/^0x[\da-f]{130}$/i.test(signature)) return false;
  try {
    return await verifyMessage({ address: agentWallet, signature: signature as Hex,
      message: walletLinkAuthorizationMessage(agentId, proof, chainId, escrow, agentWallet) });
  } catch { return false; }
}
