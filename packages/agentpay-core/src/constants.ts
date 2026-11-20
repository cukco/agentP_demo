/**
 * Frozen constants (H3). Mirrors contracts/src/libraries/AgentPayConstants.sol.
 * Cross-checked by contracts/test/AgentPayFreeze.t.sol through vectors/freeze.json.
 * USDC amounts are bigint base units (6 decimals): 1_000_000n = $1.
 */

export const AGENTPAY_VERSION = "0.2" as const;
export const SCHEME = "agentpay-session" as const;
export const SPEC_VERSION = "agentpay-verify/0.2" as const;

export const CHAIN_ID = {
  fuji: 43113,
  avalanche: 43114,
} as const;
export const NETWORK = {
  fuji: "eip155:43113",
  avalanche: "eip155:43114",
} as const;

export const USDC = {
  /** Circle FiatTokenV2_2, verified on-chain 2026-11-18 (symbol USDC, 6 decimals). */
  fuji: "0x5425890298aed601595a70AB815c96711a31Bc65",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
} as const;
/** EIP-712 domain of USDC. NOT "USDC" (that is symbol()). */
export const USDC_DOMAIN = { name: "USD Coin", version: "2" } as const;

export const ERC8004 = {
  fuji: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
  avalanche: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
} as const;
/** Identity Registry metadata key that stores the agent payment wallet (verified on Fuji). */
export const AGENT_WALLET_KEY = "agentWallet";

/** Chainlink AVAX/USD on Avalanche mainnet, 8 decimals (D22). */
export const CHAINLINK_AVAX_USD_MAINNET = "0x0A77230d17318075983913bC2145DB16C7366156";
/** Fuji feed, only for local trials. */
export const CHAINLINK_AVAX_USD_FUJI = "0x5498BB86BC934c8D34FDA08E81D444153d0D06aD";

// ───────────── Contract limits (must equal AgentPayConstants.sol) ─────────────
export const LIMITS = {
  MIN_CAP: 500_000n,
  MAX_CAP: 20_000_000n,
  DEFAULT_MAX_PER_SESSION: 20_000_000n,
  DEFAULT_MAX_IN_FLIGHT: 1_000_000_000n,
  MAX_EXPIRY: 86_400,
  MIN_DELIVERY_DEADLINE: 1,
  MAX_DELIVERY_DEADLINE: 300,
  MAX_CHALLENGE_WINDOW: 86_400,
  MAX_AUTH_TTL: 600,
  MAX_ATTEST_TTL: 3_600,
  RESOLVE_TIMEOUT: 86_400,
  VERDICT_GRACE: 600,
  LOOSEN_DELAY: 86_400,
  MAX_SESSION_FEE: 100_000n,
  MAX_FEE_BPS: 100,
  MIN_BOND: 100_000n,
  BOND_BPS: 1_000,
} as const;

/** Defaults used by SDKs / deploy script (not enforced on-chain). */
export const DEFAULTS = {
  EXPIRY_SEC: 3_600,
  /** Buyer SDK signs EIP-3009 with validBefore = now + 2 min (SystemDesign §5.1.2). */
  AUTH_VALID_SEC: 120,
  /** D13 range $0.03–0.05; final value fixed after gas measurement (H24). */
  SESSION_FEE: 40_000n,
  FEE_BPS: 50,
  /** D25 (2026-11-19): 30 < REFERENCE_SCORE_CAP, so a seller with strong history elsewhere can start (cold start). */
  MIN_SCORE: 30,
  /** D9: 30–60 s for the testnet demo. */
  CHALLENGE_WINDOW_DEMO_SEC: 60,
  REFERENCE_SCORE_CAP: 40,
} as const;

/** Off-chain Verifier limits (D35, SystemDesign §5.3). */
export const VERIFIER_LIMITS = {
  MAX_BODY_BYTES: 1_048_576,
  MAX_SCHEMA_BYTES: 8_192,
  MAX_SCHEMA_DEPTH: 32,
  CHECK_TIMEOUT_MS: 500,
  REQUEST_CHECKS_TIMEOUT_MS: 2_000,
  MAX_REQ_PER_SEC_PER_SESSION: 10,
  MAX_OPEN_SESSIONS_PER_BUYER: 20,
  CHECKPOINT_EVERY: 20,
  FAIL_STREAK_CLOSE: 3,
  BODY_RETENTION_DAYS: 7,
  DEFAULT_MAX_ORACLE_AGE_SEC: 3_600,
  FUTURE_TOLERANCE_SEC: 5,
  /** Buyer stops signing new vouchers if no Receipt after deliveryDeadlineSec + this. */
  RECEIPT_GRACE_SEC: 5,
  /** Buyer close request must be executed on-chain within this. */
  CLOSE_REQUEST_SLA_SEC: 60,
  APPROVAL_TIMEOUT_SEC: 300,
} as const;

export const FLAGS = {
  REFERENCE_ONLY: 1 << 0,
  FLAGGED: 1 << 1,
} as const;

export enum Outcome {
  PASS = 1,
  FAIL = 2,
  INCONCLUSIVE = 3,
}

/** Receipt reasonCode (Spec §8). */
export enum ReasonCode {
  PASS = 0,
  BAD_SELLER_SIG = 1,
  HASH_MISMATCH = 2,
  LATE = 3,
  TOO_LARGE = 4,
  BAD_CONTENT = 5,
  CHECK_JSON_SCHEMA = 10,
  CHECK_EQUALS = 11,
  CHECK_RANGE = 12,
  CHECK_FRESHNESS = 13,
  CHECK_ORACLE_DEVIATION = 14,
  CHECK_HASH_MATCH = 15,
  ORACLE_UNAVAILABLE = 20,
  VERIFIER_ERROR = 21,
}

/** challenge() reasonCode (SystemDesign §6.8). */
export enum ChallengeReason {
  RECEIPT_FAIL_COUNTED_PASS = 1,
  MISSING_PASS_RECEIPT = 2,
  BUYER_RECHECK_MISMATCH = 3,
  OTHER = 9,
}

/** Mirrors IAgentPaySessionEscrow.State. */
export enum SessionState {
  NONE = 0,
  OPEN = 1,
  CLOSING = 2,
  CHALLENGED = 3,
  SETTLED = 4,
  REFUNDED = 5,
}

export enum RefundReason {
  EXPIRED = 0,
  EMPTY = 1,
  EQUIVOCATION = 2,
  CHALLENGE_EXPIRED = 3,
}

export const FEEDBACK = {
  TAG1: "agentpay",
  TAG2_SESSION: "session",
  TAG2_FAIL_HEAVY: "fail-heavy",
  TAG2_EQUIVOCATION: "equivocation",
  FAIL_HEAVY_VALUE: -50,
  EQUIVOCATION_VALUE: -100,
} as const;
