// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentPayTestBase} from "./utils/AgentPayTestBase.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";
import {AgentPayHashes as H} from "../src/libraries/AgentPayHashes.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Group 1b — buyer rules + protocol admin (SystemDesign §5.1.2, §5.1.3; V16, V18, V-ADM, V-PROMPT, V26).
contract AgentPayBuyerRulesTest is AgentPayTestBase {
    function setUp() public override {
        super.setUp();
        _register(_defaultPolicy());
    }

    function _openExpect(I.OpenParams memory p, uint16 score, bytes4 err) internal {
        bytes32 salt = _salt();
        (I.ScoreAttestation memory a, bytes memory as_) =
            _att(AGENT_ID, seller, score, 0, uint64(block.timestamp + 10 minutes));
        I.Authorization memory auth = _authFor(p, salt);
        if (err != bytes4(0)) vm.expectRevert(err);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function _pol(uint128 maxPer, uint128 daily, uint16 minScore, bool paused_, bool allow)
        internal
        pure
        returns (I.PolicyParams memory)
    {
        return I.PolicyParams({
            maxPerSession: maxPer, dailyCap: daily, minScore: minScore, paused: paused_, sellerAllowlistOn: allow
        });
    }

    // ─────────────────────────── Register ───────────────────────────

    function test_register_setsPolicyAndFullBucket() public view {
        I.BuyerPolicy memory p = escrow.buyerPolicy(buyer);
        assertEq(p.admin, admin);
        assertEq(p.maxPerSession, 5_000_000);
        assertEq(escrow.bucket(buyer).available, 20_000_000);
        assertEq(escrow.availableDaily(buyer), 20_000_000);
    }

    function test_RevertWhen_registerTwice() public {
        vm.prank(buyer);
        vm.expectRevert(I.BuyerAlreadyRegistered.selector);
        escrow.registerBuyer(admin, _defaultPolicy());
    }

    function test_RevertWhen_registerZeroAdmin() public {
        vm.prank(attacker);
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.registerBuyer(address(0), _defaultPolicy());
    }

    function test_RevertWhen_registerBadPolicy() public {
        vm.startPrank(attacker);
        vm.expectRevert(I.BadPolicy.selector);
        escrow.registerBuyer(admin, _pol(0, 1, 0, false, false));
        vm.expectRevert(I.BadPolicy.selector);
        escrow.registerBuyer(admin, _pol(C.MAX_CAP + 1, 1, 0, false, false));
        vm.expectRevert(I.BadPolicy.selector);
        escrow.registerBuyer(admin, _pol(1, 0, 0, false, false));
        vm.expectRevert(I.BadPolicy.selector);
        escrow.registerBuyer(admin, _pol(1, 1, 101, false, false));
        vm.stopPrank();
    }

    function test_availableDaily_unregisteredIsDefault() public view {
        assertEq(escrow.availableDaily(attacker), C.DEFAULT_MAX_PER_SESSION);
    }

    // ───────────────────── Hard checks at open (V16, V-PROMPT) ─────────────────────

    function test_RevertWhen_overPerSession() public {
        I.OpenParams memory p = _params();
        p.cap = 5_000_001;
        _openExpect(p, 80, I.OverPerSession.selector);
    }

    function test_RevertWhen_overDailyCap() public {
        _open();
        _open();
        _open();
        _open(); // 4 x $5 = $20
        _openExpect(_params(), 80, I.OverDailyCap.selector);
    }

    function test_RevertWhen_badScore() public {
        _openExpect(_params(), 49, I.BadScore.selector);
    }

    function test_open_minScoreZeroSkipsScore() public {
        vm.prank(admin);
        escrow.proposeLoosen(buyer, _pol(5_000_000, 20_000_000, 0, false, false));
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        escrow.applyLoosen(buyer);
        _openExpect(_params(), 0, bytes4(0));
    }

    function test_RevertWhen_sellerNotAllowed() public {
        vm.prank(admin);
        escrow.tighten(buyer, _pol(5_000_000, 20_000_000, 50, false, true));
        _openExpect(_params(), 80, I.SellerNotAllowed.selector);
    }

    function test_open_allowedSellerAfterDelay() public {
        vm.startPrank(admin);
        escrow.tighten(buyer, _pol(5_000_000, 20_000_000, 50, false, true));
        escrow.setSellerAllowed(buyer, AGENT_ID, true);
        vm.stopPrank();
        vm.expectRevert(I.PendingNotReady.selector);
        escrow.applySellerAllowed(buyer, AGENT_ID);
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        escrow.applySellerAllowed(buyer, AGENT_ID);
        assertTrue(escrow.sellerAllowed(buyer, AGENT_ID));
        _openExpect(_params(), 80, bytes4(0));
    }

    function test_RevertWhen_buyerPaused() public {
        vm.prank(admin);
        escrow.pauseBuyer(buyer);
        _openExpect(_params(), 80, I.BuyerIsPaused.selector);
    }

    function test_pauseBuyer_byBuyerItself() public {
        vm.prank(buyer);
        escrow.pauseBuyer(buyer);
        assertTrue(escrow.buyerPolicy(buyer).paused);
    }

    function test_RevertWhen_pauseBuyerByStranger() public {
        vm.prank(attacker);
        vm.expectRevert(I.NotBuyerAdmin.selector);
        escrow.pauseBuyer(buyer);
    }

    function test_RevertWhen_actionOnUnregistered() public {
        vm.prank(admin);
        vm.expectRevert(I.BuyerNotRegistered.selector);
        escrow.tighten(attacker, _defaultPolicy());
    }

    // ───────────────────────── Token bucket (V18, D16) ─────────────────────────

    function test_bucket_noDayBoundaryReset() public {
        // Day boundary is irrelevant: spend all at 23:59, still blocked at 00:01.
        vm.warp((block.timestamp / 1 days + 1) * 1 days - 60);
        _open();
        _open();
        _open();
        _open();
        vm.warp(block.timestamp + 120);
        _openExpect(_params(), 80, I.OverDailyCap.selector);
    }

    function test_bucket_refillsHalfAfter12h() public {
        _open();
        _open();
        _open();
        _open();
        vm.warp(block.timestamp + 12 hours);
        assertEq(escrow.availableDaily(buyer), 10_000_000);
    }

    function test_bucket_neverExceedsDailyCap() public {
        vm.warp(block.timestamp + 30 days);
        assertEq(escrow.availableDaily(buyer), 20_000_000);
    }

    function test_bucket_refundNotCredited() public {
        uint256 sid = _open();
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE + 1);
        uint128 before = escrow.availableDaily(buyer);
        escrow.refund(sid);
        assertEq(escrow.availableDaily(buyer), before);
    }

    // ─────────────────────── Tighter vs looser per field (V-ADM) ───────────────────────

    function _tightenOk(I.PolicyParams memory np) internal {
        vm.prank(admin);
        escrow.tighten(buyer, np);
    }

    function _tightenFails(I.PolicyParams memory np) internal {
        vm.prank(admin);
        vm.expectRevert(I.NotTighter.selector);
        escrow.tighten(buyer, np);
    }

    function test_tighter_maxPerSession() public {
        _tightenFails(_pol(5_000_001, 20_000_000, 50, false, false));
        _tightenOk(_pol(4_000_000, 20_000_000, 50, false, false));
    }

    function test_tighter_dailyCap() public {
        _tightenFails(_pol(5_000_000, 20_000_001, 50, false, false));
        _tightenOk(_pol(5_000_000, 10_000_000, 50, false, false));
    }

    function test_tighter_minScore() public {
        _tightenFails(_pol(5_000_000, 20_000_000, 49, false, false));
        _tightenOk(_pol(5_000_000, 20_000_000, 60, false, false));
    }

    function test_tighter_paused() public {
        _tightenOk(_pol(5_000_000, 20_000_000, 50, true, false));
        _tightenFails(_pol(5_000_000, 20_000_000, 50, false, false));
    }

    function test_tighter_allowlist() public {
        _tightenOk(_pol(5_000_000, 20_000_000, 50, false, true));
        _tightenFails(_pol(5_000_000, 20_000_000, 50, false, false));
    }

    function test_tighten_clampsAvailable() public {
        _tightenOk(_pol(5_000_000, 3_000_000, 50, false, false));
        assertEq(escrow.bucket(buyer).available, 3_000_000);
    }

    function test_RevertWhen_tightenByStranger() public {
        vm.prank(attacker);
        vm.expectRevert(I.NotBuyerAdmin.selector);
        escrow.tighten(buyer, _pol(1_000_000, 1_000_000, 90, true, true));
    }

    function test_RevertWhen_buyerKeyTightensItself() public {
        // The agent key must not manage its own rules (only admin).
        vm.prank(buyer);
        vm.expectRevert(I.NotBuyerAdmin.selector);
        escrow.tighten(buyer, _pol(1_000_000, 1_000_000, 90, false, false));
    }

    // ──────────────────────── Loosen timelock (V-ADM) ────────────────────────

    function test_loosen_revertsBefore24h_appliesAfter() public {
        vm.prank(admin);
        escrow.proposeLoosen(buyer, _pol(20_000_000, 100_000_000, 0, false, false));
        vm.warp(block.timestamp + C.LOOSEN_DELAY - 1);
        vm.expectRevert(I.PendingNotReady.selector);
        escrow.applyLoosen(buyer);
        vm.warp(block.timestamp + 1);
        escrow.applyLoosen(buyer);
        assertEq(escrow.buyerPolicy(buyer).maxPerSession, 20_000_000);
        assertEq(escrow.pendingLoosen(buyer).effectiveAt, 0);
    }

    function test_cancelLoosen() public {
        vm.startPrank(admin);
        escrow.proposeLoosen(buyer, _pol(20_000_000, 100_000_000, 0, false, false));
        escrow.cancelLoosen(buyer);
        vm.stopPrank();
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        vm.expectRevert(I.NothingPending.selector);
        escrow.applyLoosen(buyer);
    }

    function test_RevertWhen_cancelLoosenNothing() public {
        vm.prank(admin);
        vm.expectRevert(I.NothingPending.selector);
        escrow.cancelLoosen(buyer);
    }

    function test_unpause_isLoosen() public {
        vm.startPrank(admin);
        escrow.pauseBuyer(buyer);
        vm.expectRevert(I.NotTighter.selector);
        escrow.tighten(buyer, _pol(5_000_000, 20_000_000, 50, false, false));
        escrow.proposeLoosen(buyer, _pol(5_000_000, 20_000_000, 50, false, false));
        vm.stopPrank();
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        escrow.applyLoosen(buyer);
        assertFalse(escrow.buyerPolicy(buyer).paused);
    }

    function test_removeSeller_immediate() public {
        vm.startPrank(admin);
        escrow.setSellerAllowed(buyer, AGENT_ID, true);
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        escrow.applySellerAllowed(buyer, AGENT_ID);
        escrow.setSellerAllowed(buyer, AGENT_ID, false);
        vm.stopPrank();
        assertFalse(escrow.sellerAllowed(buyer, AGENT_ID));
    }

    function test_cancelSellerAllowed() public {
        vm.startPrank(admin);
        escrow.setSellerAllowed(buyer, AGENT_ID, true);
        escrow.cancelSellerAllowed(buyer, AGENT_ID);
        vm.stopPrank();
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        vm.expectRevert(I.NothingPending.selector);
        escrow.applySellerAllowed(buyer, AGENT_ID);
    }

    function test_admin_waits24h() public {
        vm.prank(admin);
        escrow.proposeAdmin(buyer, attacker);
        vm.expectRevert(I.PendingNotReady.selector);
        escrow.applyAdmin(buyer);
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        escrow.applyAdmin(buyer);
        assertEq(escrow.buyerPolicy(buyer).admin, attacker);
    }

    function test_cancelAdmin() public {
        vm.startPrank(admin);
        escrow.proposeAdmin(buyer, attacker);
        escrow.cancelAdmin(buyer);
        vm.stopPrank();
        assertEq(escrow.pendingAdmin(buyer).effectiveAt, 0);
        vm.expectRevert(I.NothingPending.selector);
        escrow.applyAdmin(buyer);
    }

    function test_RevertWhen_proposeZeroAdmin() public {
        vm.prank(admin);
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.proposeAdmin(buyer, address(0));
    }

    // ─────────────────────────────── BySig (V-ADM) ───────────────────────────────

    function _adminSig(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        return _sign(pk, _typed(escrow.domainSeparator(), structHash));
    }

    function _policyHash(I.PolicyParams memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(H.POLICY_TYPEHASH, p.maxPerSession, p.dailyCap, p.minScore, p.paused, p.sellerAllowlistOn));
    }

    function _tightenSig(uint256 pk, I.PolicyParams memory p, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _adminSig(pk, keccak256(abi.encode(H.TIGHTEN_TYPEHASH, buyer, _policyHash(p), nonce, deadline)));
    }

    function test_tightenBySig() public {
        I.PolicyParams memory p = _pol(1_000_000, 5_000_000, 70, false, false);
        uint256 dl = block.timestamp + 1 hours;
        vm.prank(attacker); // relayer
        escrow.tightenBySig(buyer, p, dl, _tightenSig(adminPk, p, 0, dl));
        assertEq(escrow.buyerPolicy(buyer).maxPerSession, 1_000_000);
        assertEq(escrow.adminNonces(buyer), 1);
    }

    function test_RevertWhen_bySigReplayed() public {
        I.PolicyParams memory p = _pol(1_000_000, 5_000_000, 70, false, false);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _tightenSig(adminPk, p, 0, dl);
        escrow.tightenBySig(buyer, p, dl, sig);
        vm.expectRevert(I.BadAdminSig.selector);
        escrow.tightenBySig(buyer, p, dl, sig);
    }

    function test_RevertWhen_bySigExpired() public {
        I.PolicyParams memory p = _pol(1_000_000, 5_000_000, 70, false, false);
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _tightenSig(adminPk, p, 0, dl);
        vm.expectRevert(I.SigExpired.selector);
        escrow.tightenBySig(buyer, p, dl, sig);
    }

    function test_RevertWhen_bySigWrongSigner() public {
        I.PolicyParams memory p = _pol(1_000_000, 5_000_000, 70, false, false);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _tightenSig(buyerPk, p, 0, dl);
        vm.expectRevert(I.BadAdminSig.selector);
        escrow.tightenBySig(buyer, p, dl, sig);
    }

    function test_RevertWhen_bySigOldAdminAfterChange() public {
        vm.prank(admin);
        escrow.proposeAdmin(buyer, guardian);
        vm.warp(block.timestamp + C.LOOSEN_DELAY);
        escrow.applyAdmin(buyer);
        I.PolicyParams memory p = _pol(1_000_000, 5_000_000, 70, false, false);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _tightenSig(adminPk, p, 0, dl);
        vm.expectRevert(I.BadAdminSig.selector);
        escrow.tightenBySig(buyer, p, dl, sig);
    }

    function test_proposeLoosenBySig_and_cancelLoosenBySig() public {
        I.PolicyParams memory p = _pol(20_000_000, 50_000_000, 0, false, false);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(H.PROPOSE_LOOSEN_TYPEHASH, buyer, _policyHash(p), uint256(0), dl));
        escrow.proposeLoosenBySig(buyer, p, dl, _adminSig(adminPk, sh));
        assertGt(escrow.pendingLoosen(buyer).effectiveAt, 0);
        sh = keccak256(abi.encode(H.CANCEL_LOOSEN_TYPEHASH, buyer, uint256(1), dl));
        escrow.cancelLoosenBySig(buyer, dl, _adminSig(adminPk, sh));
        assertEq(escrow.pendingLoosen(buyer).effectiveAt, 0);
    }

    function test_pauseBuyerBySig() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(H.PAUSE_BUYER_TYPEHASH, buyer, uint256(0), dl));
        escrow.pauseBuyerBySig(buyer, dl, _adminSig(adminPk, sh));
        assertTrue(escrow.buyerPolicy(buyer).paused);
    }

    function test_setSellerAllowedBySig_and_cancel() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(H.SET_SELLER_ALLOWED_TYPEHASH, buyer, AGENT_ID, true, uint256(0), dl));
        escrow.setSellerAllowedBySig(buyer, AGENT_ID, true, dl, _adminSig(adminPk, sh));
        assertGt(escrow.pendingSellerAllowed(buyer, AGENT_ID), 0);
        sh = keccak256(abi.encode(H.CANCEL_SELLER_ALLOWED_TYPEHASH, buyer, AGENT_ID, uint256(1), dl));
        escrow.cancelSellerAllowedBySig(buyer, AGENT_ID, dl, _adminSig(adminPk, sh));
        assertEq(escrow.pendingSellerAllowed(buyer, AGENT_ID), 0);
    }

    function test_proposeAdminBySig_and_cancel() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(H.PROPOSE_ADMIN_TYPEHASH, buyer, guardian, uint256(0), dl));
        escrow.proposeAdminBySig(buyer, guardian, dl, _adminSig(adminPk, sh));
        assertEq(escrow.pendingAdmin(buyer).newAdmin, guardian);
        sh = keccak256(abi.encode(H.CANCEL_ADMIN_TYPEHASH, buyer, uint256(1), dl));
        escrow.cancelAdminBySig(buyer, dl, _adminSig(adminPk, sh));
        assertEq(escrow.pendingAdmin(buyer).effectiveAt, 0);
    }

    // ─────────────────────────── Protocol admin (V1, V26) ───────────────────────────

    function test_RevertWhen_setFeesTooHigh() public {
        vm.startPrank(owner);
        vm.expectRevert(I.FeeTooHigh.selector);
        escrow.setFees(C.MAX_SESSION_FEE + 1, FEE_BPS);
        vm.expectRevert(I.FeeTooHigh.selector);
        escrow.setFees(FEE, C.MAX_FEE_BPS + 1);
        vm.stopPrank();
    }

    function test_RevertWhen_ownerFunctionsByStranger() public {
        vm.startPrank(attacker);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker);
        vm.expectRevert(err);
        escrow.addVerifier(attacker, 1);
        vm.expectRevert(err);
        escrow.setFees(1, 1);
        vm.expectRevert(err);
        escrow.setScorerSigner(attacker);
        vm.expectRevert(err);
        escrow.setArbiter(attacker);
        vm.expectRevert(err);
        escrow.setGuardian(attacker);
        vm.expectRevert(err);
        escrow.unpauseSystem();
        vm.expectRevert(err);
        escrow.withdrawFees(attacker);
        vm.expectRevert(I.NotOwnerOrGuardian.selector);
        escrow.revokeVerifier(verifier);
        vm.expectRevert(I.NotOwnerOrGuardian.selector);
        escrow.pauseSystem();
        vm.stopPrank();
    }

    function test_RevertWhen_guardianUnpauses() public {
        vm.startPrank(guardian);
        escrow.pauseSystem();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        escrow.unpauseSystem();
        vm.stopPrank();
    }

    function test_roles_setAndZeroChecks() public {
        vm.startPrank(owner);
        escrow.setScorerSigner(attacker);
        escrow.setArbiter(attacker);
        escrow.setGuardian(attacker);
        assertEq(escrow.scorerSigner(), attacker);
        assertEq(escrow.arbiter(), attacker);
        assertEq(escrow.guardian(), attacker);
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.setScorerSigner(address(0));
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.setArbiter(address(0));
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.setGuardian(address(0));
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.addVerifier(address(0), 1);
        vm.stopPrank();
    }

    function test_views() public view {
        assertEq(escrow.usdc(), address(usdc));
        assertEq(escrow.identityRegistry(), address(idr));
        assertEq(escrow.reputationRegistry(), address(rep));
        assertTrue(escrow.verifierInfo(verifier).active);
        assertEq(escrow.sessionFee(), FEE);
        assertEq(escrow.feeBps(), FEE_BPS);
        assertFalse(escrow.paused());
    }

    function test_domainSeparator_followsChainId() public {
        bytes32 before = escrow.domainSeparator();
        bytes32 sBefore = escrow.scorerDomainSeparator();
        vm.chainId(999);
        assertTrue(escrow.domainSeparator() != before);
        assertTrue(escrow.scorerDomainSeparator() != sBefore);
    }
}
