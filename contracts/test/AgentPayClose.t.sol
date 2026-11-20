// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentPayTestBase} from "./utils/AgentPayTestBase.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";
import {MockReputation8004} from "./mocks/Mock8004.sol";

/// @notice Group 2 — close / finalize / refund / fees / feedback (§5.1.1, §5.1.5, §7; V1, V9, V19, V26, S2, S4, S10, S11).
contract AgentPayCloseTest is AgentPayTestBase {
    uint256 internal sid;

    function setUp() public override {
        super.setUp();
        sid = _open();
    }

    function _closeExpect(
        uint256 caller,
        uint256 voucherPk,
        I.Voucher memory v,
        I.SessionVerdict memory vd,
        uint256 verdictPk,
        bytes4 err
    ) internal {
        bytes memory vs = _signVoucherStruct(voucherPk, v);
        bytes memory ds = _signVerdict(verdictPk, vd);
        vm.prank(vm.addr(caller));
        if (err != bytes4(0)) vm.expectRevert(err);
        escrow.closeSession(sid, v, vs, vd, ds);
    }

    function _signVoucherStruct(uint256 pk, I.Voucher memory v) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Voucher(uint256 sessionId,uint32 seq,uint128 cumulativeAmount,bytes32 requestHash)"),
                v.sessionId,
                v.seq,
                v.cumulativeAmount,
                v.requestHash
            )
        );
        return _sign(pk, _typed(escrow.domainSeparator(), sh));
    }

    function _v(uint32 seq, uint128 cum) internal view returns (I.Voucher memory) {
        return I.Voucher({sessionId: sid, seq: seq, cumulativeAmount: cum, requestHash: keccak256(abi.encode(seq))});
    }

    // ─────────────────────────────── closeSession ───────────────────────────────

    function test_close_toClosing() public {
        _close(sid, 18, 15, 3, 0);
        I.Session memory s = escrow.getSession(sid);
        assertEq(uint8(s.state), uint8(I.State.CLOSING));
        assertEq(s.passedAmount, 15 * PRICE);
        assertEq(s.cumulativeAmount, 18 * PRICE);
        assertEq(s.challengeEnd, block.timestamp + 60);
    }

    function test_close_emits() public {
        I.SessionVerdict memory vd = _verdict(sid, 18, 15, 3, 0);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit I.SessionClosed(sid, verifier, 18, 18 * PRICE, 15 * PRICE, 15, 3, 0, vd.receiptsRoot, uint64(block.timestamp + 60));
        _close(sid, 18, 15, 3, 0);
    }

    function test_close_windowZero_settlesImmediately() public {
        I.OpenParams memory p = _params();
        p.challengeWindowSec = 0;
        uint256 s2 = _openWith(p);
        _close(s2, 10, 10, 0, 0);
        assertEq(uint8(escrow.getSession(s2).state), uint8(I.State.SETTLED));
    }

    function test_RevertWhen_voucherNotFromVoucherSigner() public {
        _closeExpect(verifierPk, attackerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.BadVoucherSig.selector);
    }

    function test_RevertWhen_voucherSignedByBuyerWhileTempKey() public {
        I.OpenParams memory p = _params();
        p.voucherSigner = temp;
        sid = _openWith(p);
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.BadVoucherSig.selector);
        // the temp key works
        _closeExpect(verifierPk, tempPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, bytes4(0));
    }

    function test_RevertWhen_badVerifierSig() public {
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), attackerPk, I.BadVerifierSig.selector);
    }

    function test_RevertWhen_sessionMismatch() public {
        I.Voucher memory v = _v(3, 3 * PRICE);
        v.sessionId = sid + 1;
        _closeExpect(verifierPk, buyerPk, v, _verdict(sid, 3, 3, 0, 0), verifierPk, I.SessionMismatch.selector);
    }

    function test_RevertWhen_specHashMismatch() public {
        I.SessionVerdict memory vd = _verdict(sid, 3, 3, 0, 0);
        vd.specHash = keccak256("other");
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), vd, verifierPk, I.SpecHashMismatch.selector);
    }

    function test_RevertWhen_seqMismatch() public {
        _closeExpect(verifierPk, buyerPk, _v(4, 4 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.SeqMismatch.selector);
    }

    function test_RevertWhen_seqZero() public {
        _closeExpect(verifierPk, buyerPk, _v(0, 0), _verdict(sid, 0, 0, 0, 0), verifierPk, I.SeqMismatch.selector);
    }

    function test_RevertWhen_cumulativeNotSeqTimesPrice() public {
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE + 1), _verdict(sid, 3, 3, 0, 0), verifierPk, I.BadCumulativeAmount.selector);
    }

    function test_RevertWhen_overUsable() public {
        uint32 seq = uint32((CAP - FEE) / PRICE) + 1; // one request beyond cap - sessionFee (S11)
        _closeExpect(verifierPk, buyerPk, _v(seq, uint128(seq) * PRICE), _verdict(sid, seq, 0, 0, 0), verifierPk, I.OverUsable.selector);
    }

    function test_close_atExactlyUsable() public {
        uint32 seq = uint32((CAP - FEE) / PRICE);
        _closeExpect(verifierPk, buyerPk, _v(seq, uint128(seq) * PRICE), _verdict(sid, seq, seq, 0, 0), verifierPk, bytes4(0));
        _warpPastChallenge(sid);
        escrow.finalize(sid);
    }

    function test_RevertWhen_passedNotPassCountTimesPrice() public {
        I.SessionVerdict memory vd = _verdict(sid, 3, 2, 1, 0);
        vd.passedAmount = 3 * PRICE;
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), vd, verifierPk, I.BadPassedAmount.selector);
    }

    function test_RevertWhen_passedAboveCumulative() public {
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 4, 0, 0), verifierPk, I.BadPassedAmount.selector);
    }

    function test_RevertWhen_badCounts() public {
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 2, 1, 1), verifierPk, I.BadCounts.selector);
    }

    function test_RevertWhen_strangerCloses() public {
        _closeExpect(attackerPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.NotParty.selector);
    }

    function test_RevertWhen_sellerClosesBeforeExpiry() public {
        _closeExpect(sellerPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.TooEarly.selector);
    }

    function test_sellerClosesAfterExpiry_withCheckpoint() public {
        I.SessionVerdict memory checkpoint = _verdict(sid, 20, 20, 0, 0);
        vm.warp(escrow.getSession(sid).expiry);
        _closeExpect(sellerPk, buyerPk, _v(20, 20 * PRICE), checkpoint, verifierPk, bytes4(0));
        assertEq(escrow.getSession(sid).passedAmount, 20 * PRICE);
    }

    function test_RevertWhen_closeAfterGrace() public {
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE + 1);
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.VerdictTooLate.selector);
    }

    function test_close_atGraceBoundary() public {
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE);
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, bytes4(0));
    }

    function test_RevertWhen_closeAfterVerifierRevoked() public {
        vm.prank(guardian);
        escrow.revokeVerifier(verifier);
        _closeExpect(verifierPk, buyerPk, _v(3, 3 * PRICE), _verdict(sid, 3, 3, 0, 0), verifierPk, I.VerifierRevokedForSession.selector);
    }

    function test_RevertWhen_closeTwice() public {
        _close(sid, 3, 3, 0, 0);
        I.Voucher memory v = _v(3, 3 * PRICE);
        I.SessionVerdict memory vd = _verdict(sid, 3, 3, 0, 0);
        bytes memory vs = _signVoucherStruct(buyerPk, v);
        bytes memory ds = _signVerdict(verifierPk, vd);
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(I.WrongState.selector, I.State.OPEN, I.State.CLOSING));
        escrow.closeSession(sid, v, vs, vd, ds);
    }

    function test_RevertWhen_closeUnknownSession() public {
        sid = 123;
        I.Voucher memory v = _v(1, PRICE);
        I.SessionVerdict memory vd = _verdict(123, 1, 1, 0, 0);
        bytes memory vs = _signVoucherStruct(buyerPk, v);
        bytes memory ds = _signVerdict(verifierPk, vd);
        vm.prank(verifier);
        vm.expectRevert(I.SessionNotFound.selector);
        escrow.closeSession(123, v, vs, vd, ds);
    }

    // ─────────────────────────────── refund (§7) ───────────────────────────────

    function test_refund_afterGrace_full_noFeedback() public {
        uint256 bal = usdc.balanceOf(buyer);
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE + 1);
        escrow.refund(sid);
        assertEq(usdc.balanceOf(buyer), bal + CAP);
        assertEq(rep.count(), 0);
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.REFUNDED));
        assertEq(escrow.feesAccrued(), 0);
    }

    function test_RevertWhen_refundBeforeGrace() public {
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE);
        vm.expectRevert(I.NotExpired.selector);
        escrow.refund(sid);
    }

    function test_refund_afterVerifierRevoked() public {
        vm.prank(guardian);
        escrow.revokeVerifier(verifier);
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE + 1);
        escrow.refund(sid);
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.REFUNDED));
    }

    // ─────────────────────────── finalize + fees (D23, D24) ───────────────────────────

    function test_finalize_amounts() public {
        uint256 b0 = usdc.balanceOf(buyer);
        uint256 s0 = usdc.balanceOf(seller);
        _close(sid, 18, 15, 3, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        uint128 passed = 15 * PRICE; // 150_000
        uint128 sellerFee = passed * FEE_BPS / 10_000; // 750
        assertEq(usdc.balanceOf(seller), s0 + passed - sellerFee);
        assertEq(usdc.balanceOf(buyer), b0 + CAP - passed - FEE);
        assertEq(escrow.feesAccrued(), FEE + sellerFee);
        assertEq(usdc.balanceOf(address(escrow)), FEE + sellerFee);
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.SETTLED));
    }

    function test_RevertWhen_finalizeInWindow() public {
        _close(sid, 3, 3, 0, 0);
        vm.warp(escrow.getSession(sid).challengeEnd);
        vm.expectRevert(I.ChallengeWindowNotOver.selector);
        escrow.finalize(sid);
    }

    function test_finalize_oneFeedback_fields() public {
        _close(sid, 18, 15, 3, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        assertEq(rep.count(), 1);
        MockReputation8004.Feedback memory f = rep.get(0);
        assertEq(f.agentId, AGENT_ID);
        assertEq(f.value, int128(83)); // 15 * 100 / 18
        assertEq(f.valueDecimals, 0);
        assertEq(f.tag1, "agentpay");
        assertEq(f.tag2, "session");
        assertEq(f.client, address(escrow));
        assertEq(f.feedbackHash, keccak256(abi.encode(sid, escrow.getSession(sid).receiptsRoot)));
    }

    function test_finalize_failHeavy_twoFeedbacks() public {
        _close(sid, 6, 3, 3, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        assertEq(rep.count(), 2);
        assertEq(rep.get(0).value, int128(50));
        assertEq(rep.get(1).value, int128(-50));
        assertEq(rep.get(1).tag2, "fail-heavy");
    }

    function test_finalize_inconclusiveExcludedFromRate() public {
        _close(sid, 10, 4, 1, 5);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        assertEq(rep.count(), 1);
        assertEq(rep.get(0).value, int128(80)); // 4 / (4 + 1)
    }

    function test_finalize_allInconclusive_noFeedback() public {
        _close(sid, 5, 0, 0, 5);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        assertEq(rep.count(), 0);
    }

    function test_finalize_reputationReverts_stillPays() public {
        rep.setRevert(true);
        uint256 s0 = usdc.balanceOf(seller);
        _close(sid, 10, 10, 0, 0);
        _warpPastChallenge(sid);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit I.FeedbackGiven(sid, AGENT_ID, 100, "session", false);
        escrow.finalize(sid);
        assertGt(usdc.balanceOf(seller), s0);
    }

    function test_finalize_sellerBlacklisted_toWithdrawable() public {
        usdc.blacklist(seller, true);
        _close(sid, 10, 10, 0, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        uint128 expected = 10 * PRICE - (10 * PRICE * FEE_BPS / 10_000);
        assertEq(escrow.withdrawable(seller), expected);
        vm.prank(seller);
        escrow.withdraw(attacker); // seller recovers to another of its wallets
        assertEq(usdc.balanceOf(attacker), expected);
        assertEq(escrow.withdrawable(seller), 0);
    }

    function test_RevertWhen_withdrawNothing() public {
        vm.prank(seller);
        vm.expectRevert(I.NothingToWithdraw.selector);
        escrow.withdraw(seller);
    }

    function test_RevertWhen_withdrawToZero() public {
        vm.prank(seller);
        vm.expectRevert(I.ZeroAddress.selector);
        escrow.withdraw(address(0));
    }

    function test_feeChange_doesNotAffectOpenSession() public {
        vm.prank(owner);
        escrow.setFees(C.MAX_SESSION_FEE, C.MAX_FEE_BPS);
        _close(sid, 10, 10, 0, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        assertEq(escrow.feesAccrued(), FEE + (10 * PRICE * FEE_BPS / 10_000));
    }

    function test_withdrawFees() public {
        _close(sid, 10, 10, 0, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        uint256 fees = escrow.feesAccrued();
        vm.prank(owner);
        escrow.withdrawFees(owner);
        assertEq(usdc.balanceOf(owner), fees);
        assertEq(escrow.feesAccrued(), 0);
        vm.prank(owner);
        vm.expectRevert(I.NothingToWithdraw.selector);
        escrow.withdrawFees(owner);
    }

    // ─────────────────────────────── closeEmpty (V9) ───────────────────────────────

    function test_closeEmpty_fullRefund() public {
        uint256 bal = usdc.balanceOf(buyer);
        I.SessionVerdict memory vd = _verdict(sid, 0, 0, 0, 0);
        vm.prank(attacker); // anyone can submit
        escrow.closeEmpty(sid, vd, _signVerdict(verifierPk, vd));
        assertEq(usdc.balanceOf(buyer), bal + CAP);
        assertEq(escrow.feesAccrued(), 0);
        assertEq(rep.count(), 0);
    }

    function test_RevertWhen_closeEmptyWithRequests() public {
        I.SessionVerdict memory vd = _verdict(sid, 1, 1, 0, 0);
        bytes memory sig = _signVerdict(verifierPk, vd);
        vm.expectRevert(I.NotEmptyVerdict.selector);
        escrow.closeEmpty(sid, vd, sig);
    }

    function test_RevertWhen_closeEmptyBadSig() public {
        I.SessionVerdict memory vd = _verdict(sid, 0, 0, 0, 0);
        bytes memory sig = _signVerdict(attackerPk, vd);
        vm.expectRevert(I.BadVerifierSig.selector);
        escrow.closeEmpty(sid, vd, sig);
    }

    function test_RevertWhen_closeEmptyWrongSpec() public {
        I.SessionVerdict memory vd = _verdict(sid, 0, 0, 0, 0);
        vd.specHash = bytes32(0);
        bytes memory sig = _signVerdict(verifierPk, vd);
        vm.expectRevert(I.SpecHashMismatch.selector);
        escrow.closeEmpty(sid, vd, sig);
    }

    function test_RevertWhen_closeEmptyWrongSession() public {
        I.SessionVerdict memory vd = _verdict(sid + 1, 0, 0, 0, 0);
        bytes memory sig = _signVerdict(verifierPk, vd);
        vm.expectRevert(I.SessionMismatch.selector);
        escrow.closeEmpty(sid, vd, sig);
    }

    function test_RevertWhen_closeEmptyRevokedVerifier() public {
        I.SessionVerdict memory vd = _verdict(sid, 0, 0, 0, 0);
        bytes memory sig = _signVerdict(verifierPk, vd);
        vm.prank(guardian);
        escrow.revokeVerifier(verifier);
        vm.expectRevert(I.VerifierRevokedForSession.selector);
        escrow.closeEmpty(sid, vd, sig);
    }

    // ─────────────────────────────── inFlight accounting ───────────────────────────────

    function test_inFlight_decrementsOnEveryExit() public {
        uint256 s2 = _open();
        uint256 s3 = _open();
        assertEq(escrow.inFlightByVerifier(verifier), 3 * CAP);
        _close(sid, 5, 5, 0, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid); // SETTLED
        I.SessionVerdict memory vd = _verdict(s2, 0, 0, 0, 0);
        escrow.closeEmpty(s2, vd, _signVerdict(verifierPk, vd)); // REFUNDED (EMPTY)
        vm.warp(escrow.getSession(s3).expiry + C.VERDICT_GRACE + 1);
        escrow.refund(s3); // REFUNDED (EXPIRED)
        assertEq(escrow.inFlightByVerifier(verifier), 0);
    }
}
