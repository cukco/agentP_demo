// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentPaySessionEscrow} from "../../src/AgentPaySessionEscrow.sol";
import {IAgentPaySessionEscrow as I} from "../../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayHashes as H} from "../../src/libraries/AgentPayHashes.sol";
import {AgentPayConstants as C} from "../../src/libraries/AgentPayConstants.sol";
import {MockUSDC3009} from "../mocks/MockUSDC3009.sol";
import {MockReputation8004, MockIdentity8004} from "../mocks/Mock8004.sol";

/// @notice Shared fixture: escrow + mocks, fixed keys, signing helpers, one-call open/close.
abstract contract AgentPayTestBase is Test {
    AgentPaySessionEscrow internal escrow;
    MockUSDC3009 internal usdc;
    MockReputation8004 internal rep;
    MockIdentity8004 internal idr;

    uint256 internal buyerPk = 0xB0B;
    uint256 internal tempPk = 0x7E3;
    uint256 internal sellerPk = 0x5E11;
    uint256 internal verifierPk = 0xF1E;
    uint256 internal scorerPk = 0x5C0;
    uint256 internal adminPk = 0xAD1;
    uint256 internal arbiterPk = 0xA4B;
    uint256 internal guardianPk = 0x6A4;
    uint256 internal ownerPk = 0x0E4;
    uint256 internal attackerPk = 0xBAD;

    address internal buyer;
    address internal temp;
    address internal seller;
    address internal verifier;
    address internal scorer;
    address internal admin;
    address internal arbiter;
    address internal guardian;
    address internal owner;
    address internal attacker;

    uint256 internal constant AGENT_ID = 12;
    uint128 internal constant FEE = 40_000; // $0.04
    uint16 internal constant FEE_BPS = 50; // 0.5%
    uint128 internal constant PRICE = 10_000; // $0.01
    uint128 internal constant CAP = 5_000_000; // $5
    bytes32 internal constant SPEC = keccak256("spec");
    uint256 internal saltCounter;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        buyer = vm.addr(buyerPk);
        temp = vm.addr(tempPk);
        seller = vm.addr(sellerPk);
        verifier = vm.addr(verifierPk);
        scorer = vm.addr(scorerPk);
        admin = vm.addr(adminPk);
        arbiter = vm.addr(arbiterPk);
        guardian = vm.addr(guardianPk);
        owner = vm.addr(ownerPk);
        attacker = vm.addr(attackerPk);

        usdc = _deployUsdc();
        rep = new MockReputation8004();
        idr = new MockIdentity8004();
        escrow = new AgentPaySessionEscrow(
            address(usdc), address(idr), address(rep), owner, scorer, arbiter, guardian, FEE, FEE_BPS
        );
        vm.prank(owner);
        escrow.addVerifier(verifier, C.DEFAULT_MAX_IN_FLIGHT);
        idr.setAgentWallet(AGENT_ID, seller);
        usdc.mint(buyer, 100e6);
        usdc.mint(seller, 10e6);
    }

    function _deployUsdc() internal virtual returns (MockUSDC3009) {
        return new MockUSDC3009();
    }

    // ───────────────────────────── Builders ─────────────────────────────

    function _params() internal view returns (I.OpenParams memory p) {
        p = I.OpenParams({
            seller: seller,
            sellerAgentId: AGENT_ID,
            verifier: verifier,
            voucherSigner: buyer,
            specHash: SPEC,
            cap: CAP,
            pricePerRequest: PRICE,
            expiry: uint64(block.timestamp + 1 hours),
            deliveryDeadlineSec: 10,
            challengeWindowSec: 60
        });
    }

    function _salt() internal returns (bytes32) {
        return keccak256(abi.encode("salt", ++saltCounter));
    }

    function _nonce(I.OpenParams memory p, bytes32 salt) internal view returns (bytes32) {
        return escrow.computeNonce(p, salt);
    }

    function _auth(uint256 pk, uint256 value, bytes32 nonce, uint256 validBefore)
        internal
        view
        returns (I.Authorization memory a)
    {
        address from = vm.addr(pk);
        bytes32 sh = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, address(escrow), value, 0, validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _typed(usdc.DOMAIN_SEPARATOR(), sh));
        a = I.Authorization({
            from: from, value: value, validAfter: 0, validBefore: validBefore, nonce: nonce, v: v, r: r, s: s
        });
    }

    function _authFor(I.OpenParams memory p, bytes32 salt) internal view returns (I.Authorization memory) {
        return _auth(buyerPk, p.cap, _nonce(p, salt), block.timestamp + 2 minutes);
    }

    function _att(uint256 agentId, address wallet, uint16 score, uint16 flags, uint64 validUntil)
        internal
        view
        returns (I.ScoreAttestation memory a, bytes memory sig)
    {
        a = I.ScoreAttestation({agentId: agentId, wallet: wallet, score: score, flags: flags, validUntil: validUntil});
        bytes32 sh = keccak256(
            abi.encode(H.SCORE_ATTESTATION_TYPEHASH, a.agentId, a.wallet, a.score, a.flags, a.validUntil)
        );
        sig = _sign(scorerPk, _typed(escrow.scorerDomainSeparator(), sh));
    }

    function _goodAtt() internal view returns (I.ScoreAttestation memory, bytes memory) {
        return _att(AGENT_ID, seller, 80, 0, uint64(block.timestamp + 50 minutes));
    }

    function _voucher(uint256 pk, uint256 sid, uint32 seq, uint128 cumulative)
        internal
        view
        returns (I.Voucher memory v, bytes memory sig)
    {
        v = I.Voucher({sessionId: sid, seq: seq, cumulativeAmount: cumulative, requestHash: keccak256(abi.encode(seq))});
        bytes32 sh = keccak256(abi.encode(H.VOUCHER_TYPEHASH, v.sessionId, v.seq, v.cumulativeAmount, v.requestHash));
        sig = _sign(pk, _typed(escrow.domainSeparator(), sh));
    }

    function _verdict(uint256 sid, uint32 lastSeq, uint32 pass, uint32 fail, uint32 inc)
        internal
        view
        returns (I.SessionVerdict memory v)
    {
        v = I.SessionVerdict({
            sessionId: sid,
            specHash: SPEC,
            lastSeq: lastSeq,
            passCount: pass,
            failCount: fail,
            inconclusiveCount: inc,
            passedAmount: uint128(pass) * PRICE,
            receiptsRoot: keccak256(abi.encode("root", sid, lastSeq)),
            closedAt: uint64(block.timestamp)
        });
    }

    function _signVerdict(uint256 pk, I.SessionVerdict memory v) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                H.SESSION_VERDICT_TYPEHASH,
                v.sessionId,
                v.specHash,
                v.lastSeq,
                v.passCount,
                v.failCount,
                v.inconclusiveCount,
                v.passedAmount,
                v.receiptsRoot,
                v.closedAt
            )
        );
        return _sign(pk, _typed(escrow.domainSeparator(), sh));
    }

    function _delivery(uint256 pk, uint256 sid, uint32 seq, bytes32 bodyHash)
        internal
        view
        returns (I.Delivery memory d, bytes memory sig)
    {
        d = I.Delivery({sessionId: sid, seq: seq, requestHash: keccak256(abi.encode(seq)), bodyHash: bodyHash, specHash: SPEC});
        bytes32 sh = keccak256(abi.encode(H.DELIVERY_TYPEHASH, d.sessionId, d.seq, d.requestHash, d.bodyHash, d.specHash));
        sig = _sign(pk, _typed(escrow.domainSeparator(), sh));
    }

    function _typed(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ───────────────────────────── Actions ─────────────────────────────

    function _openWith(I.OpenParams memory p) internal returns (uint256 sid) {
        bytes32 salt = _salt();
        (I.ScoreAttestation memory a, bytes memory as_) = _goodAtt();
        sid = escrow.openWithAuthorization(p, salt, _authFor(p, salt), a, as_);
    }

    function _open() internal returns (uint256) {
        return _openWith(_params());
    }

    /// @dev Verifier closes after `lastSeq` requests with the given counts.
    function _close(uint256 sid, uint32 lastSeq, uint32 pass, uint32 fail, uint32 inc) internal {
        I.Session memory s = escrow.getSession(sid);
        uint256 vpk = s.voucherSigner == temp ? tempPk : buyerPk;
        (I.Voucher memory v, bytes memory vs) = _voucher(vpk, sid, lastSeq, uint128(lastSeq) * PRICE);
        I.SessionVerdict memory vd = _verdict(sid, lastSeq, pass, fail, inc);
        bytes memory ds = _signVerdict(verifierPk, vd); // sign before prank (signing makes an external view call)
        vm.prank(verifier);
        escrow.closeSession(sid, v, vs, vd, ds);
    }

    function _warpPastChallenge(uint256 sid) internal {
        vm.warp(escrow.getSession(sid).challengeEnd + 1);
    }

    function _bondAuth(uint256 pk, uint256 value) internal returns (I.Authorization memory) {
        return _auth(pk, value, keccak256(abi.encode("bond", ++saltCounter)), block.timestamp + 2 minutes);
    }

    function _defaultPolicy() internal pure returns (I.PolicyParams memory) {
        return I.PolicyParams({
            maxPerSession: 5_000_000, dailyCap: 20_000_000, minScore: 50, paused: false, sellerAllowlistOn: false
        });
    }

    function _register(I.PolicyParams memory p) internal {
        vm.prank(buyer);
        escrow.registerBuyer(admin, p);
    }
}
