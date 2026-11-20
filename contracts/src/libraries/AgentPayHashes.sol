// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAgentPaySessionEscrow as I} from "../interfaces/IAgentPaySessionEscrow.sol";

/// @title AgentPayHashes
/// @notice Frozen EIP-712 typehashes and struct hashing. Every string here must match
///         packages/agentpay-core/src/eip712.ts byte for byte (checked by test/AgentPayFreeze.t.sol).
library AgentPayHashes {
    // Domains
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string internal constant DOMAIN_NAME = "AgentPay";
    string internal constant SCORER_DOMAIN_NAME = "AgentPay Scorer";
    string internal constant DOMAIN_VERSION = "0.2";

    // Session messages
    bytes32 internal constant VOUCHER_TYPEHASH =
        keccak256("Voucher(uint256 sessionId,uint32 seq,uint128 cumulativeAmount,bytes32 requestHash)");
    bytes32 internal constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(uint256 sessionId,uint32 seq,bytes32 requestHash,bytes32 bodyHash,bytes32 specHash)"
    );
    bytes32 internal constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(uint256 sessionId,uint32 seq,bytes32 requestHash,bytes32 bodyHash,uint8 outcome,uint16 reasonCode,uint128 amount,uint64 receivedAt,bytes32 evidenceHash)"
    );
    bytes32 internal constant SESSION_VERDICT_TYPEHASH = keccak256(
        "SessionVerdict(uint256 sessionId,bytes32 specHash,uint32 lastSeq,uint32 passCount,uint32 failCount,uint32 inconclusiveCount,uint128 passedAmount,bytes32 receiptsRoot,uint64 closedAt)"
    );
    bytes32 internal constant SCORE_ATTESTATION_TYPEHASH =
        keccak256("ScoreAttestation(uint256 agentId,address wallet,uint16 score,uint16 flags,uint64 validUntil)");
    /// @dev Off-chain only (buyer -> Verifier POST /close), kept here so both sides share one definition.
    bytes32 internal constant CLOSE_REQUEST_TYPEHASH = keccak256("CloseRequest(uint256 sessionId,uint256 deadline)");

    // Buyer-admin BySig messages
    string internal constant POLICY_TYPE =
        "Policy(uint128 maxPerSession,uint128 dailyCap,uint16 minScore,bool paused,bool sellerAllowlistOn)";
    bytes32 internal constant POLICY_TYPEHASH = keccak256(bytes(POLICY_TYPE));
    bytes32 internal constant TIGHTEN_TYPEHASH = keccak256(
        "Tighten(address buyer,Policy policy,uint256 nonce,uint256 deadline)Policy(uint128 maxPerSession,uint128 dailyCap,uint16 minScore,bool paused,bool sellerAllowlistOn)"
    );
    bytes32 internal constant PROPOSE_LOOSEN_TYPEHASH = keccak256(
        "ProposeLoosen(address buyer,Policy policy,uint256 nonce,uint256 deadline)Policy(uint128 maxPerSession,uint128 dailyCap,uint16 minScore,bool paused,bool sellerAllowlistOn)"
    );
    bytes32 internal constant CANCEL_LOOSEN_TYPEHASH =
        keccak256("CancelLoosen(address buyer,uint256 nonce,uint256 deadline)");
    bytes32 internal constant PAUSE_BUYER_TYPEHASH = keccak256("PauseBuyer(address buyer,uint256 nonce,uint256 deadline)");
    bytes32 internal constant SET_SELLER_ALLOWED_TYPEHASH = keccak256(
        "SetSellerAllowed(address buyer,uint256 agentId,bool allowed,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant CANCEL_SELLER_ALLOWED_TYPEHASH =
        keccak256("CancelSellerAllowed(address buyer,uint256 agentId,uint256 nonce,uint256 deadline)");
    bytes32 internal constant PROPOSE_ADMIN_TYPEHASH =
        keccak256("ProposeAdmin(address buyer,address newAdmin,uint256 nonce,uint256 deadline)");
    bytes32 internal constant CANCEL_ADMIN_TYPEHASH =
        keccak256("CancelAdmin(address buyer,uint256 nonce,uint256 deadline)");

    // ───────────────────────────── Helpers ─────────────────────────────

    function domainSeparator(string memory name, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(DOMAIN_VERSION)), chainId, verifyingContract
            )
        );
    }

    function openNonce(I.OpenParams calldata p, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                p.seller,
                p.sellerAgentId,
                p.verifier,
                p.voucherSigner,
                p.specHash,
                p.cap,
                p.pricePerRequest,
                p.expiry,
                p.deliveryDeadlineSec,
                p.challengeWindowSec,
                salt
            )
        );
    }

    function sessionId(address buyer, bytes32 nonce) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(buyer, nonce)));
    }

    function hashVoucher(I.Voucher calldata v) internal pure returns (bytes32) {
        return keccak256(abi.encode(VOUCHER_TYPEHASH, v.sessionId, v.seq, v.cumulativeAmount, v.requestHash));
    }

    function hashDelivery(I.Delivery calldata d) internal pure returns (bytes32) {
        return keccak256(abi.encode(DELIVERY_TYPEHASH, d.sessionId, d.seq, d.requestHash, d.bodyHash, d.specHash));
    }

    function hashVerdict(I.SessionVerdict calldata s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SESSION_VERDICT_TYPEHASH,
                s.sessionId,
                s.specHash,
                s.lastSeq,
                s.passCount,
                s.failCount,
                s.inconclusiveCount,
                s.passedAmount,
                s.receiptsRoot,
                s.closedAt
            )
        );
    }

    function hashAttestation(I.ScoreAttestation calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(SCORE_ATTESTATION_TYPEHASH, a.agentId, a.wallet, a.score, a.flags, a.validUntil));
    }

    function hashPolicy(I.PolicyParams calldata p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(POLICY_TYPEHASH, p.maxPerSession, p.dailyCap, p.minScore, p.paused, p.sellerAllowlistOn)
        );
    }
}
