import type { Address } from "viem";
import { CHAIN_ID, ERC8004, USDC } from "./constants.js";

export interface Deployment {
  chainId: number;
  escrow: Address;
  usdc: Address;
  identity: Address;
  reputation: Address;
  verifier: Address;
  scorer: Address;
  /** Linked library holding buyer-rule management (delegatecalled by the escrow). */
  buyerRules?: Address;
  /** ERC-8004 agentId of the demo seller (agentWallet = SELLER_ADDRESS). */
  demoSellerAgentId?: bigint;
  deployBlock?: bigint;
  deployedAt?: string;
  txHash?: string;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Fuji deployment (contracts/script/DeployAgentPay.s.sol, 2026-11-18). Local anvil: deployments/local.json. */
export const DEPLOYMENTS: Record<"fuji", Deployment> = {
  fuji: {
    chainId: CHAIN_ID.fuji,
    escrow: "0xEbBE6E2cCE97a6C2Cb93563936b5846481C942ac",
    buyerRules: "0x080E1b378d4e2DdCa9F3ED6aC94657b1A2dEaBE1",
    demoSellerAgentId: 306n,
    deployBlock: 61271878n,
    deployedAt: "2026-11-18",
    txHash: "0x0a4a83ae141f48b4634d9b98318aaf48017f1cbc3081d64c087611faf02fc113",
    usdc: USDC.fuji,
    identity: ERC8004.fuji.identity,
    reputation: ERC8004.fuji.reputation,
    verifier: "0x7C06cef00c06455a7d0Dd91A10732b46F9Ea1FAA",
    scorer: "0x693a93c510c858194CF3A3424f877Ec0C5cFD044",
  },
};
