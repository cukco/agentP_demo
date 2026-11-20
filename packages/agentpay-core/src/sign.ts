import { parseSignature, verifyTypedData, type Address, type Hex, type LocalAccount, type TypedData, type TypedDataDomain } from "viem";
import { agentPayDomain, scorerDomain, TYPES, usdcDomain, type PrimaryType } from "./eip712.js";
import type {
  Authorization, CloseRequest, Delivery, PolicyParams, Receipt, ScoreAttestation,
  SessionVerdict, Signed, Voucher,
} from "./types.js";

type Domain = (chainId: number, contract: Address) => TypedDataDomain;
type Sign<T> = (account: LocalAccount, chainId: number, contract: Address, message: T) => Promise<Signed<T>>;
type Verify<T> = (chainId: number, contract: Address, signed: Signed<T>, expectedSigner: Address) => Promise<boolean>;

// The public bindings below pair each message type with its frozen field definitions.
function binding<T extends object>(primaryType: PrimaryType, makeDomain: Domain): { sign: Sign<T>; verify: Verify<T> } {
  function data(chainId: number, contract: Address, message: T) {
    return { domain: makeDomain(chainId, contract), primaryType, types: TYPES[primaryType] as TypedData,
      message: { ...message } as Record<string, unknown> };
  }
  async function sign(account: LocalAccount, chainId: number, contract: Address, message: T): Promise<Signed<T>> {
    const signature = await account.signTypedData(data(chainId, contract, message));
    return { message, signature };
  }
  async function verify(chainId: number, contract: Address, signed: Signed<T>, expectedSigner: Address): Promise<boolean> {
    try {
      return await verifyTypedData({ ...data(chainId, contract, signed.message), address: expectedSigner, signature: signed.signature });
    } catch {
      return false;
    }
  }
  return { sign, verify };
}

export const { sign: signVoucher, verify: verifyVoucher } = binding<Voucher>("Voucher", agentPayDomain);
export const { sign: signDelivery, verify: verifyDelivery } = binding<Delivery>("Delivery", agentPayDomain);
export const { sign: signReceipt, verify: verifyReceipt } = binding<Receipt>("Receipt", agentPayDomain);
export const { sign: signSessionVerdict, verify: verifySessionVerdict } = binding<SessionVerdict>("SessionVerdict", agentPayDomain);
export const { sign: signCloseRequest, verify: verifyCloseRequest } = binding<CloseRequest>("CloseRequest", agentPayDomain);
export const { sign: signScoreAttestation, verify: verifyScoreAttestation } = binding<ScoreAttestation>("ScoreAttestation", scorerDomain);

type Receive = Omit<Authorization, "v" | "r" | "s"> & { to: Address };
type Cancel = { authorizer: Address; nonce: Hex };
type SignatureParts = Pick<Authorization, "v" | "r" | "s"> & { signature: Hex };

function parts(signature: Hex): SignatureParts {
  const { r, s, yParity } = parseSignature(signature);
  return { signature, r, s, v: 27 + yParity! };
}

export async function signReceiveAuthorization(account: LocalAccount, chainId: number, usdc: Address, message: Receive): Promise<SignatureParts> {
  return parts(await account.signTypedData({ domain: usdcDomain(chainId, usdc), primaryType: "ReceiveWithAuthorization",
    types: TYPES.ReceiveWithAuthorization, message }));
}

export async function signCancelAuthorization(account: LocalAccount, chainId: number, usdc: Address, message: Cancel): Promise<SignatureParts> {
  return parts(await account.signTypedData({ domain: usdcDomain(chainId, usdc), primaryType: "CancelAuthorization",
    types: TYPES.CancelAuthorization, message }));
}

type AdminBase = { buyer: Address; nonce: bigint; deadline: bigint };
type AdminMessages = {
  Tighten: AdminBase & { policy: PolicyParams };
  ProposeLoosen: AdminBase & { policy: PolicyParams };
  CancelLoosen: AdminBase;
  PauseBuyer: AdminBase;
  SetSellerAllowed: AdminBase & { agentId: bigint; allowed: boolean };
  CancelSellerAllowed: AdminBase & { agentId: bigint };
  ProposeAdmin: AdminBase & { newAdmin: Address };
  CancelAdmin: AdminBase;
};

export function signAdminAction<K extends keyof AdminMessages>(account: LocalAccount, chainId: number, escrow: Address,
  primaryType: K, message: AdminMessages[NoInfer<K>]): Promise<Hex> {
  return account.signTypedData({ domain: agentPayDomain(chainId, escrow), primaryType: primaryType as string,
    types: TYPES[primaryType] as TypedData, message });
}
