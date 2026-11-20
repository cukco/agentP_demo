// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentPayTestBase} from "../utils/AgentPayTestBase.sol";
import {IAgentPaySessionEscrow as I} from "../../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../../src/libraries/AgentPayConstants.sol";

/// @notice Drives the escrow through random valid lifecycles. Reuses the test base (own escrow + mocks).
contract Handler is AgentPayTestBase {
    uint256[] public sids;
    address public vault = address(0x7A017);
    uint256 public initialSupply;
    mapping(bytes32 => uint256) public calls;

    function init() external {
        setUp();
        usdc.mint(buyer, 10_000e6);
        usdc.mint(seller, 1_000e6);
        initialSupply = usdc.totalSupply();
    }

    function sessionCount() external view returns (uint256) {
        return sids.length;
    }

    function _pick(uint256 seed) internal view returns (uint256 sid, I.Session memory s, bool ok) {
        if (sids.length == 0) return (0, s, false);
        sid = sids[seed % sids.length];
        s = escrow.getSession(sid);
        ok = true;
    }

    // ───────────────────────────── actions ─────────────────────────────

    function open(uint128 capSeed, uint128 priceSeed, uint32 windowSeed) external {
        if (sids.length >= 40) return;
        I.OpenParams memory p = _params();
        p.cap = uint128(bound(capSeed, C.MIN_CAP, C.MAX_CAP));
        p.pricePerRequest = uint128(bound(priceSeed, 1_000, p.cap - FEE));
        p.challengeWindowSec = uint32(bound(windowSeed, 0, 2 hours));
        if (usdc.balanceOf(buyer) < p.cap) return;
        if (escrow.inFlightByVerifier(verifier) + p.cap > C.DEFAULT_MAX_IN_FLIGHT) return;
        sids.push(_openWith(p));
        calls[keccak256("open")]++;
    }

    function close(uint256 seed, uint32 seqSeed, uint32 passSeed, uint32 failSeed) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.OPEN || block.timestamp > s.expiry + C.VERDICT_GRACE) return;
        uint256 maxSeq = (s.cap - s.sessionFee) / s.pricePerRequest;
        if (maxSeq > 500) maxSeq = 500;
        uint32 seq = uint32(bound(seqSeed, 1, maxSeq));
        uint32 pass = uint32(bound(passSeed, 0, seq));
        uint32 fail = uint32(bound(failSeed, 0, seq - pass));
        (I.Voucher memory v, bytes memory vs) = _voucher(buyerPk, sid, seq, uint128(seq) * s.pricePerRequest);
        I.SessionVerdict memory vd = _verdict(sid, seq, pass, fail, 0);
        vd.passedAmount = uint128(pass) * s.pricePerRequest;
        bytes memory ds = _signVerdict(verifierPk, vd);
        vm.prank(verifier);
        escrow.closeSession(sid, v, vs, vd, ds);
        calls[keccak256("close")]++;
    }

    function closeEmpty(uint256 seed) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.OPEN) return;
        I.SessionVerdict memory vd = _verdict(sid, 0, 0, 0, 0);
        escrow.closeEmpty(sid, vd, _signVerdict(verifierPk, vd));
        calls[keccak256("closeEmpty")]++;
    }

    function finalize(uint256 seed) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.CLOSING || block.timestamp <= s.challengeEnd) return;
        escrow.finalize(sid);
        calls[keccak256("finalize")]++;
    }

    function refund(uint256 seed) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.OPEN || block.timestamp <= s.expiry + C.VERDICT_GRACE) return;
        escrow.refund(sid);
        calls[keccak256("refund")]++;
    }

    function challenge(uint256 seed, bool bySeller) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.CLOSING || block.timestamp > s.challengeEnd) return;
        uint256 pk = bySeller ? sellerPk : buyerPk;
        address who = vm.addr(pk);
        uint128 bond = escrow.requiredBond(sid, who);
        if (usdc.balanceOf(who) < bond || usdc.isBlacklisted(who)) return;
        I.Authorization memory a = _bondAuth(pk, bond);
        vm.prank(who);
        escrow.challenge(sid, bySeller ? 2 : 1, a);
        calls[keccak256("challenge")]++;
    }

    function resolve(uint256 seed, uint32 passSeed, bool upheld) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.CHALLENGED || block.timestamp > s.resolveDeadline) return;
        uint32 pass = uint32(bound(passSeed, 0, s.lastSeq - s.inconclusiveCount));
        vm.prank(arbiter);
        escrow.resolveChallenge(sid, pass, 0, upheld);
        calls[keccak256("resolve")]++;
    }

    function expire(uint256 seed) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || s.state != I.State.CHALLENGED || block.timestamp <= s.resolveDeadline) return;
        escrow.expireChallenge(sid);
        calls[keccak256("expire")]++;
    }

    function equivocate(uint256 seed) external {
        (uint256 sid, I.Session memory s, bool ok) = _pick(seed);
        if (!ok || (s.state != I.State.OPEN && s.state != I.State.CLOSING)) return;
        (I.Delivery memory a, bytes memory sa) = _delivery(sellerPk, sid, 1, keccak256("a"));
        (I.Delivery memory b, bytes memory sb) = _delivery(sellerPk, sid, 1, keccak256("b"));
        escrow.proveEquivocation(sid, a, sa, b, sb);
        calls[keccak256("equivocate")]++;
    }

    function warp(uint32 secs) external {
        // mostly short hops so sessions live long enough to close/challenge; 1 in 8 is a long jump (24h deadlines)
        uint256 dt = secs % 8 == 0 ? bound(secs, 1 hours, 2 days) : bound(secs, 1, 30 minutes);
        vm.warp(block.timestamp + dt);
        calls[keccak256("warp")]++;
    }

    function toggleBlacklistSeller(bool on) external {
        usdc.blacklist(seller, on);
        calls[keccak256("blacklist")]++;
    }

    function withdrawSeller() external {
        if (escrow.withdrawable(seller) == 0) return;
        vm.prank(seller);
        escrow.withdraw(vault);
        calls[keccak256("withdraw")]++;
    }

    // ───────────────────────────── ghost views ─────────────────────────────

    /// @dev Σ cap of live sessions (+ bonds held) and Σ cap per live session for the verifier.
    function liveTotals() external view returns (uint256 liveCaps, uint256 bonds) {
        for (uint256 i; i < sids.length; i++) {
            I.Session memory s = escrow.getSession(sids[i]);
            if (s.state == I.State.OPEN || s.state == I.State.CLOSING || s.state == I.State.CHALLENGED) {
                liveCaps += s.cap;
                bonds += s.challengeBond;
            }
        }
    }

    function participantsBalance() external view returns (uint256) {
        return usdc.balanceOf(buyer) + usdc.balanceOf(seller) + usdc.balanceOf(address(escrow)) + usdc.balanceOf(vault);
    }

    function withdrawableTotal() external view returns (uint256) {
        return escrow.withdrawable(buyer) + escrow.withdrawable(seller);
    }

    function escrowAddr() external view returns (address) {
        return address(escrow);
    }

    function usdcAddr() external view returns (address) {
        return address(usdc);
    }

    function verifierAddr() external view returns (address) {
        return verifier;
    }
}
