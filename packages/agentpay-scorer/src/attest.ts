import { signScoreAttestation, toWire, type AttestationResponse, type ScoreResponse } from "@agentpay/core";
import type { LocalAccount } from "viem";
import type { ChainConfig } from "./chain.js";

export async function attest(score: ScoreResponse, signer: LocalAccount, config: ChainConfig, now: number): Promise<AttestationResponse> {
  const signed = await signScoreAttestation(signer, config.chainId, config.escrow, {
    agentId: BigInt(score.agentId), wallet: score.wallet, score: score.score, flags: score.flags,
    validUntil: BigInt(Math.floor(now)) + 3000n,
  });
  return { attestation: toWire(signed), scorer: signer.address };
}
