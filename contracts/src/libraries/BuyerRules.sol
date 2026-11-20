// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAgentPaySessionEscrow as I} from "../interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "./AgentPayConstants.sol";
import {AgentPayHashes as H} from "./AgentPayHashes.sol";

/// @title BuyerRules
/// @notice Buyer spending-rule management (SystemDesign §5.1.2, F6). Linked library: its external functions run
///         via DELEGATECALL in the Escrow, so storage, msg.sender and emitted events are the Escrow's.
///         Split out only to keep the Escrow under the EIP-170 size limit.
library BuyerRules {
    struct Store {
        mapping(address => I.BuyerPolicy) policy;
        mapping(address => I.Bucket) bucket;
        mapping(address => I.PendingLoosen) pendingLoosen;
        mapping(address => I.PendingAdmin) pendingAdmin;
        mapping(address => mapping(uint256 => uint64)) pendingSellerAllowed;
        mapping(address => mapping(uint256 => bool)) sellerAllowed;
        mapping(address => uint256) adminNonces;
    }

    // ───────────────────────── Internal helpers (inlined) ─────────────────────────

    function available(Store storage rs, address buyer) internal view returns (uint128) {
        I.BuyerPolicy storage p = rs.policy[buyer];
        I.Bucket storage b = rs.bucket[buyer];
        uint256 refill = (uint256(p.dailyCap) * (block.timestamp - b.lastUpdate)) / 1 days;
        uint256 avail = uint256(b.available) + refill;
        return avail > p.dailyCap ? p.dailyCap : uint128(avail);
    }

    function _registered(Store storage rs, address buyer) private view returns (I.BuyerPolicy storage p) {
        p = rs.policy[buyer];
        if (p.admin == address(0)) revert I.BuyerNotRegistered();
    }

    function _onlyAdmin(Store storage rs, address buyer, address actor) private view {
        if (_registered(rs, buyer).admin != actor) revert I.NotBuyerAdmin();
    }

    function _validate(I.PolicyParams calldata np) private pure {
        if (np.maxPerSession == 0 || np.maxPerSession > C.MAX_CAP || np.dailyCap == 0 || np.minScore > 100) {
            revert I.BadPolicy();
        }
    }

    function _isTighter(I.BuyerPolicy storage o, I.PolicyParams calldata np) private view returns (bool) {
        return np.maxPerSession <= o.maxPerSession && np.dailyCap <= o.dailyCap && np.minScore >= o.minScore
            && (np.paused || !o.paused) && (np.sellerAllowlistOn || !o.sellerAllowlistOn);
    }

    function _write(Store storage rs, address buyer, I.PolicyParams memory np) private {
        uint128 avail = available(rs, buyer);
        I.BuyerPolicy storage p = rs.policy[buyer];
        p.maxPerSession = np.maxPerSession;
        p.dailyCap = np.dailyCap;
        p.minScore = np.minScore;
        p.paused = np.paused;
        p.sellerAllowlistOn = np.sellerAllowlistOn;
        rs.bucket[buyer] = I.Bucket({
            available: avail > np.dailyCap ? np.dailyCap : avail,
            lastUpdate: uint64(block.timestamp)
        });
    }

    /// @dev Verifies an admin EIP-712 signature and consumes the buyer's admin nonce.
    function _useSig(Store storage rs, address buyer, bytes32 structHash, uint256 deadline, bytes calldata sig, bytes32 domain)
        private
    {
        if (block.timestamp > deadline) revert I.SigExpired();
        address admin = _registered(rs, buyer).admin;
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toTypedDataHash(domain, structHash), sig);
        if (err != ECDSA.RecoverError.NoError || signer != admin) revert I.BadAdminSig();
        rs.adminNonces[buyer]++;
    }

    // ───────────────────────────── Actions ─────────────────────────────

    function _tighten(Store storage rs, address buyer, I.PolicyParams calldata np) private {
        _validate(np);
        if (!_isTighter(rs.policy[buyer], np)) revert I.NotTighter();
        _write(rs, buyer, np);
        emit I.PolicyTightened(buyer, np);
        if (np.paused) emit I.BuyerPaused(buyer, msg.sender);
    }

    function _proposeLoosen(Store storage rs, address buyer, I.PolicyParams calldata np) private {
        _validate(np);
        uint64 at = uint64(block.timestamp + C.LOOSEN_DELAY);
        rs.pendingLoosen[buyer] = I.PendingLoosen({policy: np, effectiveAt: at});
        emit I.LoosenProposed(buyer, np, at);
    }

    function _cancelLoosen(Store storage rs, address buyer) private {
        if (rs.pendingLoosen[buyer].effectiveAt == 0) revert I.NothingPending();
        delete rs.pendingLoosen[buyer];
        emit I.LoosenCancelled(buyer);
    }

    function _pause(Store storage rs, address buyer) private {
        rs.policy[buyer].paused = true;
        emit I.BuyerPaused(buyer, msg.sender);
    }

    function _setSellerAllowed(Store storage rs, address buyer, uint256 agentId, bool allowed) private {
        if (allowed) {
            uint64 at = uint64(block.timestamp + C.LOOSEN_DELAY);
            rs.pendingSellerAllowed[buyer][agentId] = at;
            emit I.SellerAllowedProposed(buyer, agentId, at);
        } else {
            rs.sellerAllowed[buyer][agentId] = false;
            delete rs.pendingSellerAllowed[buyer][agentId];
            emit I.SellerAllowedSet(buyer, agentId, false);
        }
    }

    function _cancelSellerAllowed(Store storage rs, address buyer, uint256 agentId) private {
        if (rs.pendingSellerAllowed[buyer][agentId] == 0) revert I.NothingPending();
        delete rs.pendingSellerAllowed[buyer][agentId];
        emit I.SellerAllowedCancelled(buyer, agentId);
    }

    function _proposeAdmin(Store storage rs, address buyer, address newAdmin) private {
        if (newAdmin == address(0)) revert I.ZeroAddress();
        uint64 at = uint64(block.timestamp + C.LOOSEN_DELAY);
        rs.pendingAdmin[buyer] = I.PendingAdmin({newAdmin: newAdmin, effectiveAt: at});
        emit I.AdminProposed(buyer, newAdmin, at);
    }

    function _cancelAdmin(Store storage rs, address buyer) private {
        if (rs.pendingAdmin[buyer].effectiveAt == 0) revert I.NothingPending();
        delete rs.pendingAdmin[buyer];
        emit I.AdminCancelled(buyer);
    }

    // ───────────────────── External (delegatecalled) entry points ─────────────────────

    /// @notice Hard check at open (SystemDesign §5.1.2 `_checkAndConsume`). Unregistered buyer -> default rule.
    function consume(Store storage rs, address buyer, uint128 amount, uint256 sellerAgentId, uint16 score, uint256 sessionId)
        external
    {
        I.BuyerPolicy storage p = rs.policy[buyer];
        if (p.admin == address(0)) {
            if (amount > C.DEFAULT_MAX_PER_SESSION) revert I.OverPerSession();
            return;
        }
        if (p.paused) revert I.BuyerIsPaused();
        if (amount > p.maxPerSession) revert I.OverPerSession();
        if (p.sellerAllowlistOn && !rs.sellerAllowed[buyer][sellerAgentId]) revert I.SellerNotAllowed();
        if (p.minScore > 0 && score < p.minScore) revert I.BadScore();

        uint128 avail = available(rs, buyer);
        if (amount > avail) revert I.OverDailyCap();
        I.Bucket storage b = rs.bucket[buyer];
        b.available = avail - amount;
        b.lastUpdate = uint64(block.timestamp);
        emit I.BuyerSpend(buyer, sessionId, amount, b.available);
    }

    function register(Store storage rs, address admin, I.PolicyParams calldata np) external {
        if (admin == address(0)) revert I.ZeroAddress();
        I.BuyerPolicy storage p = rs.policy[msg.sender];
        if (p.admin != address(0)) revert I.BuyerAlreadyRegistered();
        _validate(np);
        p.admin = admin;
        p.maxPerSession = np.maxPerSession;
        p.dailyCap = np.dailyCap;
        p.minScore = np.minScore;
        p.paused = np.paused;
        p.sellerAllowlistOn = np.sellerAllowlistOn;
        rs.bucket[msg.sender] = I.Bucket({available: np.dailyCap, lastUpdate: uint64(block.timestamp)});
        emit I.BuyerRegistered(msg.sender, admin, np);
    }

    function tighten(Store storage rs, address buyer, I.PolicyParams calldata np) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _tighten(rs, buyer, np);
    }

    function proposeLoosen(Store storage rs, address buyer, I.PolicyParams calldata np) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _proposeLoosen(rs, buyer, np);
    }

    function applyLoosen(Store storage rs, address buyer) external {
        _registered(rs, buyer);
        I.PendingLoosen storage pl = rs.pendingLoosen[buyer];
        if (pl.effectiveAt == 0) revert I.NothingPending();
        if (block.timestamp < pl.effectiveAt) revert I.PendingNotReady();
        I.PolicyParams memory np = pl.policy;
        _write(rs, buyer, np);
        delete rs.pendingLoosen[buyer];
        emit I.LoosenApplied(buyer, np);
    }

    function cancelLoosen(Store storage rs, address buyer) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _cancelLoosen(rs, buyer);
    }

    function pauseBuyer(Store storage rs, address buyer) external {
        I.BuyerPolicy storage p = _registered(rs, buyer);
        if (msg.sender != p.admin && msg.sender != buyer) revert I.NotBuyerAdmin();
        _pause(rs, buyer);
    }

    function setSellerAllowed(Store storage rs, address buyer, uint256 agentId, bool allowed) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _setSellerAllowed(rs, buyer, agentId, allowed);
    }

    function applySellerAllowed(Store storage rs, address buyer, uint256 agentId) external {
        uint64 at = rs.pendingSellerAllowed[buyer][agentId];
        if (at == 0) revert I.NothingPending();
        if (block.timestamp < at) revert I.PendingNotReady();
        delete rs.pendingSellerAllowed[buyer][agentId];
        rs.sellerAllowed[buyer][agentId] = true;
        emit I.SellerAllowedSet(buyer, agentId, true);
    }

    function cancelSellerAllowed(Store storage rs, address buyer, uint256 agentId) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _cancelSellerAllowed(rs, buyer, agentId);
    }

    function proposeAdmin(Store storage rs, address buyer, address newAdmin) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _proposeAdmin(rs, buyer, newAdmin);
    }

    function applyAdmin(Store storage rs, address buyer) external {
        I.BuyerPolicy storage p = _registered(rs, buyer);
        I.PendingAdmin memory pa = rs.pendingAdmin[buyer];
        if (pa.effectiveAt == 0) revert I.NothingPending();
        if (block.timestamp < pa.effectiveAt) revert I.PendingNotReady();
        p.admin = pa.newAdmin;
        delete rs.pendingAdmin[buyer];
        emit I.AdminChanged(buyer, pa.newAdmin);
    }

    function cancelAdmin(Store storage rs, address buyer) external {
        _onlyAdmin(rs, buyer, msg.sender);
        _cancelAdmin(rs, buyer);
    }

    // BySig

    function tightenBySig(
        Store storage rs,
        address buyer,
        I.PolicyParams calldata np,
        uint256 deadline,
        bytes calldata sig,
        bytes32 domain
    ) external {
        bytes32 sh = keccak256(abi.encode(H.TIGHTEN_TYPEHASH, buyer, H.hashPolicy(np), rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _tighten(rs, buyer, np);
    }

    function proposeLoosenBySig(
        Store storage rs,
        address buyer,
        I.PolicyParams calldata np,
        uint256 deadline,
        bytes calldata sig,
        bytes32 domain
    ) external {
        bytes32 sh =
            keccak256(abi.encode(H.PROPOSE_LOOSEN_TYPEHASH, buyer, H.hashPolicy(np), rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _proposeLoosen(rs, buyer, np);
    }

    function cancelLoosenBySig(Store storage rs, address buyer, uint256 deadline, bytes calldata sig, bytes32 domain)
        external
    {
        bytes32 sh = keccak256(abi.encode(H.CANCEL_LOOSEN_TYPEHASH, buyer, rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _cancelLoosen(rs, buyer);
    }

    function pauseBuyerBySig(Store storage rs, address buyer, uint256 deadline, bytes calldata sig, bytes32 domain)
        external
    {
        bytes32 sh = keccak256(abi.encode(H.PAUSE_BUYER_TYPEHASH, buyer, rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _pause(rs, buyer);
    }

    function setSellerAllowedBySig(
        Store storage rs,
        address buyer,
        uint256 agentId,
        bool allowed,
        uint256 deadline,
        bytes calldata sig,
        bytes32 domain
    ) external {
        bytes32 sh = keccak256(
            abi.encode(H.SET_SELLER_ALLOWED_TYPEHASH, buyer, agentId, allowed, rs.adminNonces[buyer], deadline)
        );
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _setSellerAllowed(rs, buyer, agentId, allowed);
    }

    function cancelSellerAllowedBySig(
        Store storage rs,
        address buyer,
        uint256 agentId,
        uint256 deadline,
        bytes calldata sig,
        bytes32 domain
    ) external {
        bytes32 sh =
            keccak256(abi.encode(H.CANCEL_SELLER_ALLOWED_TYPEHASH, buyer, agentId, rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _cancelSellerAllowed(rs, buyer, agentId);
    }

    function proposeAdminBySig(
        Store storage rs,
        address buyer,
        address newAdmin,
        uint256 deadline,
        bytes calldata sig,
        bytes32 domain
    ) external {
        bytes32 sh = keccak256(abi.encode(H.PROPOSE_ADMIN_TYPEHASH, buyer, newAdmin, rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _proposeAdmin(rs, buyer, newAdmin);
    }

    function cancelAdminBySig(Store storage rs, address buyer, uint256 deadline, bytes calldata sig, bytes32 domain)
        external
    {
        bytes32 sh = keccak256(abi.encode(H.CANCEL_ADMIN_TYPEHASH, buyer, rs.adminNonces[buyer], deadline));
        _useSig(rs, buyer, sh, deadline, sig, domain);
        _cancelAdmin(rs, buyer);
    }
}
