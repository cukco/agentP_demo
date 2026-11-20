// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentPayTestBase} from "./utils/AgentPayTestBase.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/// @notice Fuzz: settlement split always sums to cap, never negative (§5.1.5, V-RE).
contract AgentPayFuzzTest is AgentPayTestBase {
    function testFuzz_settleSplit(uint128 cap, uint128 price, uint32 seq, uint32 pass, uint128 fee, uint16 bps)
        public
    {
        fee = uint128(bound(fee, 0, C.MAX_SESSION_FEE));
        bps = uint16(bound(bps, 0, C.MAX_FEE_BPS));
        vm.prank(owner);
        escrow.setFees(fee, bps);

        cap = uint128(bound(cap, C.MIN_CAP, C.MAX_CAP));
        price = uint128(bound(price, 1, cap - fee));
        uint256 maxSeq = (cap - fee) / price;
        if (maxSeq > 5_000) maxSeq = 5_000;
        seq = uint32(bound(seq, 1, maxSeq));
        pass = uint32(bound(pass, 0, seq));

        usdc.mint(buyer, cap);
        I.OpenParams memory p = _params();
        p.cap = cap;
        p.pricePerRequest = price;
        uint256 sid = _openWith(p);

        uint256 b0 = usdc.balanceOf(buyer);
        uint256 s0 = usdc.balanceOf(seller);
        _closeAndFinalize(sid, seq, pass, price);

        uint256 toBuyer = usdc.balanceOf(buyer) - b0;
        uint256 toSeller = usdc.balanceOf(seller) - s0;
        assertEq(toBuyer + toSeller + escrow.feesAccrued(), cap, "split != cap");
        assertEq(usdc.balanceOf(address(escrow)), escrow.feesAccrued(), "dust left");
        assertLe(toSeller, uint256(pass) * price);
        assertEq(escrow.inFlightByVerifier(verifier), 0);
    }

    function _closeAndFinalize(uint256 sid, uint32 seq, uint32 pass, uint128 price) internal {
        (I.Voucher memory v, bytes memory vs) = _voucher(buyerPk, sid, seq, uint128(seq) * price);
        I.SessionVerdict memory vd = _verdict(sid, seq, pass, seq - pass, 0);
        vd.passedAmount = uint128(pass) * price;
        bytes memory ds = _signVerdict(verifierPk, vd);
        vm.prank(verifier);
        escrow.closeSession(sid, v, vs, vd, ds);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
    }

    function testFuzz_bucketNeverAboveCap(uint128 daily, uint32 elapsed) public {
        daily = uint128(bound(daily, 1, type(uint64).max));
        vm.prank(buyer);
        escrow.registerBuyer(
            admin,
            I.PolicyParams({maxPerSession: C.MAX_CAP, dailyCap: daily, minScore: 0, paused: false, sellerAllowlistOn: false})
        );
        vm.warp(block.timestamp + elapsed);
        assertLe(escrow.availableDaily(buyer), daily);
    }
}

/// @notice Reentrancy: a token that calls back into the escrow on transfer is blocked (V-RE).
contract AgentPayReentrancyTest is AgentPayTestBase {
    function _deployUsdc() internal override returns (MockUSDC3009) {
        return new ReentrantToken();
    }

    function test_RevertWhen_reentrantFinalize() public {
        uint256 sid = _open();
        _close(sid, 10, 10, 0, 0);
        _warpPastChallenge(sid);
        ReentrantToken(address(usdc)).arm(address(escrow), abi.encodeCall(escrow.finalize, (sid)));
        escrow.finalize(sid);
        assertTrue(ReentrantToken(address(usdc)).reentered());
        assertFalse(ReentrantToken(address(usdc)).reentrySucceeded());
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.SETTLED));
    }

    function test_RevertWhen_reentrantRefund() public {
        uint256 sid = _open();
        uint256 sid2 = _open();
        vm.warp(escrow.getSession(sid).expiry + C.VERDICT_GRACE + 1);
        ReentrantToken(address(usdc)).arm(address(escrow), abi.encodeCall(escrow.refund, (sid2)));
        escrow.refund(sid);
        assertTrue(ReentrantToken(address(usdc)).reentered());
        assertFalse(ReentrantToken(address(usdc)).reentrySucceeded());
        assertEq(uint8(escrow.getSession(sid2).state), uint8(I.State.OPEN));
    }

    function test_RevertWhen_reentrantWithdraw() public {
        uint256 sid = _open();
        usdc.blacklist(seller, true);
        _close(sid, 10, 10, 0, 0);
        _warpPastChallenge(sid);
        escrow.finalize(sid);
        usdc.blacklist(seller, false);
        uint256 credited = escrow.withdrawable(seller);
        assertGt(credited, 0);
        ReentrantToken(address(usdc)).arm(address(escrow), abi.encodeCall(escrow.withdraw, (attacker)));
        vm.prank(seller);
        escrow.withdraw(seller);
        assertFalse(ReentrantToken(address(usdc)).reentrySucceeded());
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(escrow.withdrawable(seller), 0);
    }
}
