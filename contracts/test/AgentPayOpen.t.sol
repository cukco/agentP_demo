// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentPayTestBase} from "./utils/AgentPayTestBase.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";

/// @notice Group 1a — openWithAuthorization (SystemDesign §5.1.1, V1, V9, V15, V21, V-SC, V-TEMP, D6, D7).
contract AgentPayOpenTest is AgentPayTestBase {
    function _expectOpenRevert(I.OpenParams memory p, bytes4 err) internal {
        bytes32 salt = _salt();
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        I.Authorization memory auth = _authFor(p, salt);
        vm.expectRevert(err);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function _expectAttRevert(I.ScoreAttestation memory a, bytes memory as_, bytes4 err) internal {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _authFor(p, salt);
        vm.expectRevert(err);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    // ───────────────────────────── Success ─────────────────────────────

    function test_open_defaultRules() public {
        uint256 bal = usdc.balanceOf(buyer);
        uint256 sid = _open();
        I.Session memory s = escrow.getSession(sid);
        assertEq(uint8(s.state), uint8(I.State.OPEN));
        assertEq(s.buyer, buyer);
        assertEq(s.cap, CAP);
        assertEq(usdc.balanceOf(buyer), bal - CAP);
        assertEq(usdc.balanceOf(address(escrow)), CAP);
        assertEq(escrow.inFlightByVerifier(verifier), CAP);
    }

    function test_open_registeredRules() public {
        _register(_defaultPolicy());
        uint256 sid = _open();
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.OPEN));
        assertEq(escrow.bucket(buyer).available, 20_000_000 - CAP);
    }

    function test_open_sessionIdIsDeterministic() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        uint256 expected = escrow.computeSessionId(buyer, escrow.computeNonce(p, salt));
        uint256 sid = escrow.openWithAuthorization(p, salt, _authFor(p, salt), a, as_);
        assertEq(sid, expected);
    }

    function test_open_emitsEvents() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        uint256 sid = escrow.computeSessionId(buyer, escrow.computeNonce(p, salt));
        vm.expectEmit(true, true, true, true, address(escrow));
        emit I.SessionOpened(
            sid, buyer, seller, AGENT_ID, verifier, buyer, SPEC, CAP, PRICE, p.expiry, 10, 60, FEE, FEE_BPS
        );
        escrow.openWithAuthorization(p, salt, _authFor(p, salt), a, as_);
    }

    function test_open_pinsFeeAndVoucherSigner() public {
        I.OpenParams memory p = _params();
        p.voucherSigner = temp;
        uint256 sid = _openWith(p);
        vm.prank(owner);
        escrow.setFees(90_000, 100);
        I.Session memory s = escrow.getSession(sid);
        assertEq(s.voucherSigner, temp);
        assertEq(s.sessionFee, FEE);
        assertEq(s.feeBps, FEE_BPS);
    }

    // ─────────────────── Nonce binds every parameter (V21, V-TEMP) ───────────────────

    function _tamperedRevert(uint256 field) internal {
        I.OpenParams memory signed = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _authFor(signed, salt);
        I.OpenParams memory sent = _params();
        if (field == 0) sent.seller = attacker;
        if (field == 1) sent.sellerAgentId = 13;
        if (field == 2) sent.verifier = attacker;
        if (field == 3) sent.voucherSigner = attacker;
        if (field == 4) sent.specHash = keccak256("other");
        if (field == 5) sent.cap = CAP - 1;
        if (field == 6) sent.pricePerRequest = PRICE + 1;
        if (field == 7) sent.expiry = signed.expiry + 1;
        if (field == 8) sent.deliveryDeadlineSec = 11;
        if (field == 9) sent.challengeWindowSec = 61;
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        vm.expectRevert(I.NonceMismatch.selector);
        escrow.openWithAuthorization(sent, salt, auth, a, as_);
    }

    function test_RevertWhen_nonceMismatch_seller() public {
        _tamperedRevert(0);
    }

    function test_RevertWhen_nonceMismatch_sellerAgentId() public {
        _tamperedRevert(1);
    }

    function test_RevertWhen_nonceMismatch_verifier() public {
        _tamperedRevert(2);
    }

    function test_RevertWhen_nonceMismatch_voucherSigner() public {
        _tamperedRevert(3);
    }

    function test_RevertWhen_nonceMismatch_specHash() public {
        _tamperedRevert(4);
    }

    function test_RevertWhen_nonceMismatch_cap() public {
        _tamperedRevert(5);
    }

    function test_RevertWhen_nonceMismatch_price() public {
        _tamperedRevert(6);
    }

    function test_RevertWhen_nonceMismatch_expiry() public {
        _tamperedRevert(7);
    }

    function test_RevertWhen_nonceMismatch_deliveryDeadline() public {
        _tamperedRevert(8);
    }

    function test_RevertWhen_nonceMismatch_challengeWindow() public {
        _tamperedRevert(9);
    }

    function test_RevertWhen_nonceMismatch_salt() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _authFor(p, salt);
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        vm.expectRevert(I.NonceMismatch.selector);
        escrow.openWithAuthorization(p, _salt(), auth, a, as_);
    }

    function test_RevertWhen_authValueMismatch() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _auth(buyerPk, CAP + 1, _nonce(p, salt), block.timestamp + 2 minutes);
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        vm.expectRevert(I.AuthValueMismatch.selector);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function test_RevertWhen_validBeforeTooFar() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _auth(buyerPk, CAP, _nonce(p, salt), block.timestamp + C.MAX_AUTH_TTL + 1);
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        vm.expectRevert(I.AuthTtlTooLong.selector);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function test_RevertWhen_authReplayed() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _authFor(p, salt);
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        escrow.openWithAuthorization(p, salt, auth, a, as_);
        vm.expectRevert(I.SessionExists.selector);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function test_RevertWhen_authSignedByOther() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        I.Authorization memory auth = _auth(attackerPk, CAP, _nonce(p, salt), block.timestamp + 2 minutes);
        auth.from = buyer; // attacker signs, claims buyer's funds
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        vm.expectRevert(MockUSDC3009.InvalidSignature.selector);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function test_RevertWhen_cancelledAuthorization() public {
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        bytes32 nonce = _nonce(p, salt);
        I.Authorization memory auth = _authFor(p, salt);
        bytes32 sh = keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), buyer, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, _typed(usdc.DOMAIN_SEPARATOR(), sh));
        usdc.cancelAuthorization(buyer, nonce, v, r, s);
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        vm.expectRevert(MockUSDC3009.AuthorizationUsed.selector);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    // ───────────────────────── Verifier registry (V1) ─────────────────────────

    function test_RevertWhen_unknownVerifier() public {
        I.OpenParams memory p = _params();
        p.verifier = attacker;
        _expectOpenRevert(p, I.UnknownVerifier.selector);
    }

    function test_RevertWhen_revokedVerifier() public {
        vm.prank(guardian);
        escrow.revokeVerifier(verifier);
        _expectOpenRevert(_params(), I.UnknownVerifier.selector);
    }

    function test_RevertWhen_inFlightExceeded() public {
        vm.prank(owner);
        escrow.addVerifier(verifier, CAP + 1);
        _open();
        _expectOpenRevert(_params(), I.VerifierInFlightExceeded.selector);
    }

    // ───────────────────────── Parameter bounds (D6, D7) ─────────────────────────

    function test_RevertWhen_capBelowMin() public {
        I.OpenParams memory p = _params();
        p.cap = C.MIN_CAP - 1;
        _expectOpenRevert(p, I.CapOutOfRange.selector);
    }

    function test_RevertWhen_capAboveMax() public {
        I.OpenParams memory p = _params();
        p.cap = C.MAX_CAP + 1;
        _expectOpenRevert(p, I.CapOutOfRange.selector);
    }

    /// @dev CapNotAboveFee is defence in depth: MIN_CAP ($0.50) > MAX_SESSION_FEE ($0.10) makes it unreachable today.
    function test_capNotAboveFee_unreachableByConstants() public {
        assertGt(C.MIN_CAP, C.MAX_SESSION_FEE);
        vm.prank(owner);
        escrow.setFees(C.MAX_SESSION_FEE, FEE_BPS);
        I.OpenParams memory p = _params();
        p.cap = C.MIN_CAP;
        p.pricePerRequest = C.MIN_CAP - C.MAX_SESSION_FEE;
        assertGt(_openWith(p), 0);
    }

    function test_RevertWhen_priceZero() public {
        I.OpenParams memory p = _params();
        p.pricePerRequest = 0;
        _expectOpenRevert(p, I.BadPrice.selector);
    }

    function test_RevertWhen_priceAboveUsable() public {
        I.OpenParams memory p = _params();
        p.pricePerRequest = CAP - FEE + 1;
        _expectOpenRevert(p, I.BadPrice.selector);
    }

    function test_RevertWhen_expiryTooFar() public {
        I.OpenParams memory p = _params();
        p.expiry = uint64(block.timestamp + C.MAX_EXPIRY + 1);
        _expectOpenRevert(p, I.BadExpiry.selector);
    }

    function test_RevertWhen_expiryPast() public {
        I.OpenParams memory p = _params();
        p.expiry = uint64(block.timestamp);
        _expectOpenRevert(p, I.BadExpiry.selector);
    }

    function test_RevertWhen_deadlineZero() public {
        I.OpenParams memory p = _params();
        p.deliveryDeadlineSec = 0;
        _expectOpenRevert(p, I.BadDeliveryDeadline.selector);
    }

    function test_RevertWhen_deadlineTooLong() public {
        I.OpenParams memory p = _params();
        p.deliveryDeadlineSec = C.MAX_DELIVERY_DEADLINE + 1;
        _expectOpenRevert(p, I.BadDeliveryDeadline.selector);
    }

    function test_RevertWhen_windowTooLong() public {
        I.OpenParams memory p = _params();
        p.challengeWindowSec = C.MAX_CHALLENGE_WINDOW + 1;
        _expectOpenRevert(p, I.BadChallengeWindow.selector);
    }

    function test_RevertWhen_zeroVoucherSigner() public {
        I.OpenParams memory p = _params();
        p.voucherSigner = address(0);
        _expectOpenRevert(p, I.ZeroVoucherSigner.selector);
    }

    // ───────────────────────── Seller binding (V15, V-SC) ─────────────────────────

    function test_RevertWhen_attestationBadSig() public {
        (I.ScoreAttestation memory a,) = _goodAtt();
        bytes memory bad = _sign(attackerPk, keccak256("x"));
        _expectAttRevert(a, bad, I.BadAttestationSig.selector);
    }

    function test_RevertWhen_attestationTampered() public {
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        a.score = 100; // signed 80
        _expectAttRevert(a, as_, I.BadAttestationSig.selector);
    }

    function test_RevertWhen_attestationExpired() public {
        (I.ScoreAttestation memory a, bytes memory as_) = _att(AGENT_ID, seller, 80, 0, uint64(block.timestamp - 1));
        _expectAttRevert(a, as_, I.AttestationExpired.selector);
    }

    function test_RevertWhen_attestationTtlTooLong() public {
        (I.ScoreAttestation memory a, bytes memory as_) =
            _att(AGENT_ID, seller, 80, 0, uint64(block.timestamp + C.MAX_ATTEST_TTL + 1));
        _expectAttRevert(a, as_, I.AttestationTtlTooLong.selector);
    }

    function test_RevertWhen_attestationAgentMismatch() public {
        (I.ScoreAttestation memory a, bytes memory as_) =
            _att(AGENT_ID + 1, seller, 80, 0, uint64(block.timestamp + 10 minutes));
        _expectAttRevert(a, as_, I.AttestationAgentMismatch.selector);
    }

    function test_RevertWhen_attestationWalletMismatch() public {
        (I.ScoreAttestation memory a, bytes memory as_) =
            _att(AGENT_ID, attacker, 80, 0, uint64(block.timestamp + 10 minutes));
        _expectAttRevert(a, as_, I.AttestationWalletMismatch.selector);
    }

    function test_RevertWhen_sellerFlagged() public {
        (I.ScoreAttestation memory a, bytes memory as_) =
            _att(AGENT_ID, seller, 80, C.FLAG_FLAGGED, uint64(block.timestamp + 10 minutes));
        _expectAttRevert(a, as_, I.SellerFlagged.selector);
    }

    function test_open_referenceOnlyFlagAllowed() public {
        (I.ScoreAttestation memory a, bytes memory as_) =
            _att(AGENT_ID, seller, 30, C.FLAG_REFERENCE_ONLY, uint64(block.timestamp + 10 minutes));
        I.OpenParams memory p = _params();
        bytes32 salt = _salt();
        assertGt(escrow.openWithAuthorization(p, salt, _authFor(p, salt), a, as_), 0);
    }

    function test_RevertWhen_identityWalletMismatch() public {
        idr.setAgentWallet(AGENT_ID, attacker); // registry says another wallet owns agent 12
        _expectOpenRevert(_params(), I.IdentityWalletMismatch.selector);
    }

    /// @dev Storage packs sellerAgentId into 96 bits; a larger id must revert, never be truncated.
    function test_RevertWhen_agentIdAboveUint96() public {
        uint256 huge = uint256(type(uint96).max) + 1 + AGENT_ID; // truncates to AGENT_ID if packed blindly
        idr.setAgentWallet(huge, seller);
        I.OpenParams memory p = _params();
        p.sellerAgentId = huge;
        bytes32 salt = _salt();
        I.Authorization memory auth = _authFor(p, salt);
        (I.ScoreAttestation memory a, bytes memory as_) = _att(huge, seller, 80, 0, uint64(block.timestamp + 10 minutes));
        vm.expectRevert(I.IdentityWalletMismatch.selector);
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function test_open_maxUint96AgentIdStoredExactly() public {
        uint256 id = type(uint96).max;
        idr.setAgentWallet(id, seller);
        I.OpenParams memory p = _params();
        p.sellerAgentId = id;
        bytes32 salt = _salt();
        I.Authorization memory auth = _authFor(p, salt);
        (I.ScoreAttestation memory a, bytes memory as_) = _att(id, seller, 80, 0, uint64(block.timestamp + 10 minutes));
        uint256 sid = escrow.openWithAuthorization(p, salt, auth, a, as_);
        assertEq(escrow.getSession(sid).sellerAgentId, id);
    }

    function test_RevertWhen_identityHasNoWallet() public {
        idr.setAgentWallet(AGENT_ID, address(0));
        _expectOpenRevert(_params(), I.IdentityWalletMismatch.selector);
    }

    // ───────────────────────── System pause (V1) ─────────────────────────

    function test_RevertWhen_systemPaused() public {
        vm.prank(guardian);
        escrow.pauseSystem();
        _expectOpenRevert(_params(), I.SystemIsPaused.selector);
    }

    function test_refund_worksWhileSystemPaused() public {
        uint256 sid = _open();
        vm.prank(owner);
        escrow.pauseSystem();
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE + 1);
        uint256 bal = usdc.balanceOf(buyer);
        escrow.refund(sid);
        assertEq(usdc.balanceOf(buyer), bal + CAP);
    }

    function test_unpauseSystem_reopens() public {
        vm.prank(guardian);
        escrow.pauseSystem();
        vm.prank(owner);
        escrow.unpauseSystem();
        assertGt(_open(), 0);
    }
}
