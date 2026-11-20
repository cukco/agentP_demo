// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ERC-8004 v2.0.0 Reputation Registry (selectors verified on Fuji 2026-11-18).
///         Fuji 0x8004B663056A597Dffe9eCcC1965A193B7388713, Avalanche 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63.
interface IERC8004Reputation {
    /// @dev msg.sender is recorded as the client (the Escrow). No feedbackAuth from the agent needed.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function getIdentityRegistry() external view returns (address);
}

/// @notice ERC-8004 v2.0.0 Identity Registry (ERC-721).
///         Fuji 0x8004A818BFB912233c491871b3d84c89A494BD9e, Avalanche 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432.
interface IERC8004Identity {
    function ownerOf(uint256 agentId) external view returns (address);

    /// @dev getMetadata(agentId, "agentWallet") returns the 20-byte payment wallet (verified on Fuji agents 1–3).
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);

    function tokenURI(uint256 agentId) external view returns (string memory);
}
