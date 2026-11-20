// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AgentPayConstants
/// @notice Frozen constants (SystemDesign §5.1.4, D6–D12, D30–D35). Mirrored in packages/agentpay-core/src/constants.ts
///         and cross-checked by test/AgentPayFreeze.t.sol against packages/agentpay-core/vectors/freeze.json.
library AgentPayConstants {
    // USDC has 6 decimals: 1_000_000 = $1
    uint128 internal constant MIN_CAP = 500_000; // $0.50 (D6)
    uint128 internal constant MAX_CAP = 20_000_000; // $20 (D6)
    uint128 internal constant DEFAULT_MAX_PER_SESSION = 20_000_000; // unregistered buyer rule
    uint128 internal constant DEFAULT_MAX_IN_FLIGHT = 1_000_000_000; // $1,000 per verifier (D12)

    uint64 internal constant MAX_EXPIRY = 24 hours; // D7
    uint32 internal constant MIN_DELIVERY_DEADLINE = 1; // Spec §4.1
    uint32 internal constant MAX_DELIVERY_DEADLINE = 300;
    uint32 internal constant MAX_CHALLENGE_WINDOW = 24 hours; // D9 upper bound

    uint64 internal constant MAX_AUTH_TTL = 10 minutes; // V9
    uint64 internal constant MAX_ATTEST_TTL = 1 hours; // V-SC
    uint64 internal constant RESOLVE_TIMEOUT = 24 hours; // Q12, D34
    uint64 internal constant VERDICT_GRACE = 10 minutes; // D10
    uint64 internal constant LOOSEN_DELAY = 24 hours; // V-ADM

    uint128 internal constant MAX_SESSION_FEE = 100_000; // $0.10 (V26)
    uint16 internal constant MAX_FEE_BPS = 100; // 1% (V26)
    uint128 internal constant MIN_BOND = 100_000; // $0.10 (D34)
    uint16 internal constant BOND_BPS = 1_000; // 10% of disputed amount (D34)

    uint16 internal constant FLAG_REFERENCE_ONLY = 1 << 0;
    uint16 internal constant FLAG_FLAGGED = 1 << 1;

    uint8 internal constant OUTCOME_PASS = 1;
    uint8 internal constant OUTCOME_FAIL = 2;
    uint8 internal constant OUTCOME_INCONCLUSIVE = 3;

    // ERC-8004 feedback (D23, D24)
    string internal constant TAG1 = "agentpay";
    string internal constant TAG2_SESSION = "session";
    string internal constant TAG2_FAIL_HEAVY = "fail-heavy";
    string internal constant TAG2_EQUIVOCATION = "equivocation";
    int128 internal constant FAIL_HEAVY_VALUE = -50; // proposal, see INTERFACE_FREEZE.md F5
    int128 internal constant EQUIVOCATION_VALUE = -100;

    // ERC-8004 Identity Registry metadata key holding the agent's payment wallet (verified on Fuji 2026-11-18)
    string internal constant AGENT_WALLET_KEY = "agentWallet";
}
