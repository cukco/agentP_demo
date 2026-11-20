import {
  Outcome,
  ReasonCode,
  ZERO_HASH,
  type Check,
  type VerificationSpec,
} from "@agentpay/core";
import type { Address, Hex } from "viem";
export interface OracleSnapshot {
  checkId?: string;
  chainId: number;
  feed: Address;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  decimals: number;
  answeredInRound: bigint;
}
export interface CheckResult {
  outcome: Outcome;
  reasonCode: ReasonCode;
  evidenceHash: Hex;
  oracle?: OracleSnapshot[];
}
export interface CheckInput {
  spec: VerificationSpec;
  body: Uint8Array;
  contentType: string;
  receivedAt: bigint;
}
export type OracleCheck = Extract<Check, { type: "oracle-deviation" }>;
export type OracleReader = (check: OracleCheck) => Promise<OracleSnapshot>;
export const result = (ok: boolean, reason: ReasonCode): CheckResult => ({
  outcome: ok ? Outcome.PASS : Outcome.FAIL,
  reasonCode: ok ? ReasonCode.PASS : reason,
  evidenceHash: ZERO_HASH,
});
export const unavailable = (
  reasonCode = ReasonCode.VERIFIER_ERROR,
): CheckResult => ({
  outcome: Outcome.INCONCLUSIVE,
  reasonCode,
  evidenceHash: ZERO_HASH,
});
