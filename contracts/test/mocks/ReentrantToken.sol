// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockUSDC3009} from "./MockUSDC3009.sol";

/// @notice USDC mock that re-enters the escrow on every transfer out of it (V-RE).
contract ReentrantToken is MockUSDC3009 {
    address public target;
    bytes public payload;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        reentered = false;
        reentrySucceeded = false;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (target != address(0) && msg.sender == target && !reentered) {
            reentered = true;
            (bool ok,) = target.call(payload);
            reentrySucceeded = ok;
        }
        return super.transfer(to, value);
    }
}
