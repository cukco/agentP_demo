// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Handler} from "./Handler.sol";
import {AgentPaySessionEscrow} from "../../src/AgentPaySessionEscrow.sol";
import {MockUSDC3009} from "../mocks/MockUSDC3009.sol";

/// @notice Money invariants over random lifecycles (SystemDesign §4.3, §11.0 V-RE).
contract AgentPayInvariantTest is Test {
    Handler internal h;
    AgentPaySessionEscrow internal escrow;
    MockUSDC3009 internal usdc;

    function setUp() public {
        h = new Handler();
        h.init();
        escrow = AgentPaySessionEscrow(h.escrowAddr());
        usdc = MockUSDC3009(h.usdcAddr());

        bytes4[] memory sel = new bytes4[](13);
        sel[0] = Handler.open.selector;
        sel[1] = Handler.close.selector;
        sel[2] = Handler.closeEmpty.selector;
        sel[3] = Handler.finalize.selector;
        sel[4] = Handler.refund.selector;
        sel[5] = Handler.challenge.selector;
        sel[6] = Handler.resolve.selector;
        sel[7] = Handler.expire.selector;
        sel[8] = Handler.equivocate.selector;
        sel[9] = Handler.warp.selector;
        sel[10] = Handler.toggleBlacklistSeller.selector;
        sel[11] = Handler.withdrawSeller.selector;
        sel[12] = Handler.open.selector; // weight opens x2
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    /// Prints how many actions really reached the escrow (sanity check that the handler is not a no-op).
    function afterInvariant() external view {
        string[12] memory k =
            ["open", "close", "closeEmpty", "finalize", "refund", "challenge", "resolve", "expire", "equivocate", "warp", "blacklist", "withdraw"];
        for (uint256 i; i < k.length; i++) {
            console2.log(k[i], h.calls(keccak256(bytes(k[i]))));
        }
    }

    /// Escrow holds exactly: live caps + bonds held + withdrawable credits + fees.
    function invariant_balanceMatches() public view {
        (uint256 liveCaps, uint256 bonds) = h.liveTotals();
        assertEq(
            usdc.balanceOf(address(escrow)), liveCaps + bonds + h.withdrawableTotal() + escrow.feesAccrued(), "escrow balance"
        );
    }

    /// Closed system: no USDC is created or destroyed by the escrow.
    function invariant_moneyConserved() public view {
        assertEq(h.participantsBalance(), h.initialSupply(), "money created or lost");
        assertEq(usdc.totalSupply(), h.initialSupply());
    }

    /// inFlight per verifier equals Σ cap of its live sessions and returns to 0 when all end.
    function invariant_inFlightConsistent() public view {
        (uint256 liveCaps,) = h.liveTotals();
        assertEq(escrow.inFlightByVerifier(h.verifierAddr()), liveCaps, "inFlight");
    }
}
