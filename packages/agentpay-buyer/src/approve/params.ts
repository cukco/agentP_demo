import { fromWire, openNonce, specHash, type OpenParams, type VerificationSpec, type Wire } from "@agentpay/core";
import type { Address, Hex } from "viem";

export interface OpenReview {
  kind: "open";
  buyer: Address;
  escrow: Address;
  chainId: number;
  asset: Address;
  params: Wire<OpenParams>;
  spec: VerificationSpec;
  salt: Hex;
  nonce: Hex;
  domain: string;
  score: number;
  fee: string;
}

export interface CloseReview {
  kind: "close";
  buyer: Address;
  escrow: Address;
  chainId: number;
  sessionId: string;
}

export type ApprovalReview = OpenReview | CloseReview;
export type ApprovalParams = ApprovalReview & { validBefore: string };

export function checkParams(displayed: Pick<OpenReview, "params" | "spec" | "salt">, nonce: Hex): boolean {
  try {
    const params = fromWire<OpenParams>("OpenParams", displayed.params);
    return params.specHash === specHash(displayed.spec) && openNonce(params, displayed.salt) === nonce;
  } catch {
    return false;
  }
}
