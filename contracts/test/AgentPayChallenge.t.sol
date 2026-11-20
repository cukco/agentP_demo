// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentPayTestBase} from "./utils/AgentPayTestBase.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";

/// @notice Group 3 — challenge / resolve / expire / equivocation (§6.8, §6.9, §9.5; D34, S12, V3).
contract AgentPayChallengeTest is AgentPayTestBase {
    uint256 internal sid;

    function setUp() public override {
        super.setUp();
        sid = _open();
        _close(sid, 18, 15, 3, 0); // passed $0.15, cumulative $0.18
    }

    function _challenge(uint256 pk, uint256 bond, uint8 reason) internal {
        I.Authorization memory a = _bondAuth(pk, bond);
        vm.prank(vm.addr(pk));
        escrow.challenge(sid, reason, a);
    }

    // ─────────────────────────────── bond (§9.5) ───────────────────────────────

    function test_requiredBond_minAndPercent() public {
        // buyer disputes passed $0.15 -> 10% = $0.015 < min $0.10
        assertEq(escrow.requiredBond(sid, buyer), C.MIN_BOND);
        // large session: buyer disputes $4.50 -> 10% = $0.45
        uint256 s2 = _open();
        _close(s2, 450, 450, 0, 0);
        assertEq(escrow.requiredBond(s2, buyer), 450_000);
        // seller disputes cumulative - passed = $0
        assertEq(escrow.requiredBond(s2, seller), C.MIN_BOND);
    }

    // ─────────────────────────────── challenge ───────────────────────────────

    function test_challenge_byBuyer() public {
        uint256 bal = usdc.balanceOf(buyer);
        _challenge(buyerPk, C.MIN_BOND, 1);
        I.Session memory s = escrow.getSession(sid);
        assertEq(uint8(s.state), uint8(I.State.CHALLENGED));
        assertEq(s.challenger, buyer);
        assertEq(s.challengeBond, C.MIN_BOND);
        assertEq(s.resolveDeadline, block.timestamp + C.RESOLVE_TIMEOUT);
        assertEq(usdc.balanceOf(buyer), bal - C.MIN_BOND);
    }

    function test_challenge_bySeller() public {
        _challenge(sellerPk, C.MIN_BOND, 2);
        assertEq(escrow.getSession(sid).challenger, seller);
    }

    function test_RevertWhen_challengeByStranger() public {
        usdc.mint(attacker, 1e6);
        I.Authorization memory a = _bondAuth(attackerPk, C.MIN_BOND);
        vm.prank(attacker);
        vm.expectRevert(I.NotParty.selector);
        escrow.challenge(sid, 9, a);
    }

    function test_RevertWhen_challengeAfterWindow() public {
        I.Authorization memory a = _bondAuth(buyerPk, C.MIN_BOND);
        vm.warp(escrow.getSession(sid).challengeEnd + 1);
        vm.prank(buyer);
        vm.expectRevert(I.ChallengeWindowOver.selector);
        escrow.challenge(sid, 1, a);
    }

    function test_RevertWhen_bondTooSmall() public {
        I.Authorization memory a = _bondAuth(buyerPk, C.MIN_BOND - 1);
        vm.prank(buyer);
        vm.expectRevert(I.BadBond.selector);
        escrow.challenge(sid, 1, a);
    }

    function test_RevertWhen_bondFromOther() public {
        I.Authorization memory a = _bondAuth(sellerPk, C.MIN_BOND);
        vm.prank(buyer);
        vm.expectRevert(I.BadBond.selector);
        escrow.challenge(sid, 1, a);
    }

    function test_RevertWhen_challengeOpenSession() public {
        uint256 s2 = _open();
        I.Authorization memory a = _bondAuth(buyerPk, C.MIN_BOND);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(I.WrongState.selector, I.State.CLOSING, I.State.OPEN));
        escrow.challenge(s2, 1, a);
    }

    function test_RevertWhen_finalizeWhileChallenged() public {
        _challenge(buyerPk, C.MIN_BOND, 1);
        _warpPastChallenge(sid);
        vm.expectRevert(abi.encodeWithSelector(I.WrongState.selector, I.State.CLOSING, I.State.CHALLENGED));
        escrow.finalize(sid);
    }

    // ─────────────────────────────── resolve (D34) ───────────────────────────────

    function test_resolve_upheld_buyer() public {
        uint256 b0 = usdc.balanceOf(buyer);
        uint256 s0 = usdc.balanceOf(seller);
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.prank(arbiter);
        escrow.resolveChallenge(sid, 10, 8, true); // 5 of the PASS were wrong
        uint128 passed = 10 * PRICE;
        uint128 sellerFee = passed * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(seller), s0 + passed - sellerFee);
        assertEq(usdc.balanceOf(buyer), b0 + CAP - passed - FEE); // bond returned
        I.Session memory s = escrow.getSession(sid);
        assertEq(uint8(s.state), uint8(I.State.SETTLED));
        assertEq(s.passCount, 10);
        assertEq(rep.get(0).value, int128(55)); // 10 * 100 / 18
    }

    function test_resolve_rejected_buyer() public {
        uint256 s0 = usdc.balanceOf(seller);
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.prank(arbiter);
        escrow.resolveChallenge(sid, 15, 3, false);
        uint128 passed = 15 * PRICE;
        uint128 sellerFee = passed * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(seller), s0 + passed - sellerFee + C.MIN_BOND); // bond to seller
    }

    function test_resolve_upheld_seller() public {
        uint256 s0 = usdc.balanceOf(seller);
        _challenge(sellerPk, C.MIN_BOND, 2);
        vm.prank(arbiter);
        escrow.resolveChallenge(sid, 18, 0, true);
        uint128 passed = 18 * PRICE;
        uint128 sellerFee = passed * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(seller), s0 - C.MIN_BOND + passed - sellerFee + C.MIN_BOND);
    }

    function test_resolve_rejected_seller_bondToBuyer() public {
        uint256 b0 = usdc.balanceOf(buyer);
        _challenge(sellerPk, C.MIN_BOND, 2);
        vm.prank(arbiter);
        escrow.resolveChallenge(sid, 15, 3, false);
        assertEq(usdc.balanceOf(buyer), b0 + CAP - 15 * PRICE - FEE + C.MIN_BOND);
    }

    function test_RevertWhen_resolveNotArbiter() public {
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.prank(attacker);
        vm.expectRevert(I.NotArbiter.selector);
        escrow.resolveChallenge(sid, 10, 8, true);
    }

    function test_RevertWhen_resolveAfterDeadline() public {
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.warp(block.timestamp + C.RESOLVE_TIMEOUT + 1);
        vm.prank(arbiter);
        vm.expectRevert(I.ResolveDeadlinePassed.selector);
        escrow.resolveChallenge(sid, 10, 8, true);
    }

    function test_RevertWhen_resolvePassAboveCumulative() public {
        _challenge(sellerPk, C.MIN_BOND, 2);
        vm.prank(arbiter);
        vm.expectRevert(I.BadPassedAmount.selector);
        escrow.resolveChallenge(sid, 19, 0, true);
    }

    function test_RevertWhen_resolveBadCounts() public {
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.prank(arbiter);
        vm.expectRevert(I.BadCounts.selector);
        escrow.resolveChallenge(sid, 10, 9, true);
    }

    function test_RevertWhen_resolveNotChallenged() public {
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(I.WrongState.selector, I.State.CHALLENGED, I.State.CLOSING));
        escrow.resolveChallenge(sid, 10, 8, true);
    }

    // ─────────────────────────────── expire (S12) ───────────────────────────────

    function test_expireChallenge_after24h() public {
        uint256 b0 = usdc.balanceOf(buyer);
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.warp(block.timestamp + C.RESOLVE_TIMEOUT + 1);
        escrow.expireChallenge(sid);
        assertEq(usdc.balanceOf(buyer), b0 + CAP); // full cap + bond back
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.REFUNDED));
        assertEq(rep.count(), 0);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(escrow.inFlightByVerifier(verifier), 0);
    }

    function test_expireChallenge_sellerChallenger_bondBack() public {
        uint256 s0 = usdc.balanceOf(seller);
        _challenge(sellerPk, C.MIN_BOND, 2);
        vm.warp(block.timestamp + C.RESOLVE_TIMEOUT + 1);
        escrow.expireChallenge(sid);
        assertEq(usdc.balanceOf(seller), s0);
    }

    function test_RevertWhen_expireChallengeEarly() public {
        _challenge(buyerPk, C.MIN_BOND, 1);
        vm.warp(block.timestamp + C.RESOLVE_TIMEOUT);
        vm.expectRevert(I.ResolveDeadlineNotPassed.selector);
        escrow.expireChallenge(sid);
    }

    // ─────────────────────────────── equivocation (V3) ───────────────────────────────

    function _equivocate(uint256 target, uint256 pkA, uint256 pkB, uint32 seqA, uint32 seqB, bytes32 hA, bytes32 hB, bytes4 err)
        internal
    {
        (I.Delivery memory a, bytes memory sa) = _delivery(pkA, target, seqA, hA);
        (I.Delivery memory b, bytes memory sb) = _delivery(pkB, target, seqB, hB);
        if (err != bytes4(0)) vm.expectRevert(err);
        escrow.proveEquivocation(target, a, sa, b, sb);
    }

    function test_equivocation_refundsAndMinus100() public {
        uint256 s2 = _open();
        uint256 b0 = usdc.balanceOf(buyer);
        _equivocate(s2, sellerPk, sellerPk, 4, 4, keccak256("good"), keccak256("junk"), bytes4(0));
        assertEq(usdc.balanceOf(buyer), b0 + CAP);
        assertEq(uint8(escrow.getSession(s2).state), uint8(I.State.REFUNDED));
        assertEq(rep.count(), 1);
        assertEq(rep.get(0).value, int128(-100));
        assertEq(rep.get(0).tag2, "equivocation");
    }

    function test_equivocation_inClosing() public {
        _equivocate(sid, sellerPk, sellerPk, 2, 2, keccak256("a"), keccak256("b"), bytes4(0));
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.REFUNDED));
    }

    function test_RevertWhen_sameBodyHash() public {
        _equivocate(sid, sellerPk, sellerPk, 2, 2, keccak256("a"), keccak256("a"), I.NotEquivocation.selector);
    }

    function test_RevertWhen_differentSeq() public {
        _equivocate(sid, sellerPk, sellerPk, 2, 3, keccak256("a"), keccak256("b"), I.NotEquivocation.selector);
    }

    function test_RevertWhen_notSellerSig() public {
        _equivocate(sid, sellerPk, attackerPk, 2, 2, keccak256("a"), keccak256("b"), I.BadSellerSig.selector);
    }

    function test_RevertWhen_equivocationOtherSession() public {
        (I.Delivery memory a, bytes memory sa) = _delivery(sellerPk, sid, 2, keccak256("a"));
        (I.Delivery memory b, bytes memory sb) = _delivery(sellerPk, sid + 1, 2, keccak256("b"));
        vm.expectRevert(I.SessionMismatch.selector);
        escrow.proveEquivocation(sid, a, sa, b, sb);
    }

    function test_RevertWhen_equivocationAfterSettled() public {
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        (I.Delivery memory a, bytes memory sa) = _delivery(sellerPk, sid, 2, keccak256("a"));
        (I.Delivery memory b, bytes memory sb) = _delivery(sellerPk, sid, 2, keccak256("b"));
        vm.expectRevert(abi.encodeWithSelector(I.WrongState.selector, I.State.OPEN, I.State.SETTLED));
        escrow.proveEquivocation(sid, a, sa, b, sb);
    }
}
