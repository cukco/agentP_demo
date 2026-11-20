// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Subset of Circle FiatTokenV2_2 used by AgentPay (Fuji USDC 0x5425890298aed601595a70AB815c96711a31Bc65).
///         EIP-712 domain: {name: "USD Coin", version: "2"}.
interface IFiatTokenV2 is IERC20 {
    /// @dev Caller must be `to` (prevents front-running of the authorization).
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function isBlacklisted(address account) external view returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
