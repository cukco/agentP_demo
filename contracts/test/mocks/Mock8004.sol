// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ERC-8004 Reputation mock: records every feedback; can be forced to revert.
contract MockReputation8004 {
    struct Feedback {
        uint256 agentId;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bytes32 feedbackHash;
        address client;
    }

    Feedback[] public feedbacks;
    bool public shouldRevert;

    function setRevert(bool on) external {
        shouldRevert = on;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        require(!shouldRevert, "reputation down");
        feedbacks.push(Feedback(agentId, value, valueDecimals, tag1, tag2, feedbackHash, msg.sender));
    }

    function count() external view returns (uint256) {
        return feedbacks.length;
    }

    function get(uint256 i) external view returns (Feedback memory) {
        return feedbacks[i];
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        view
        returns (uint64, int128, uint8)
    {
        return (uint64(feedbacks.length), 0, 0);
    }

    function getIdentityRegistry() external pure returns (address) {
        return address(0);
    }
}

/// @notice ERC-8004 Identity mock: getMetadata(agentId, "agentWallet") returns the 20-byte wallet.
contract MockIdentity8004 {
    mapping(uint256 => address) public wallets;
    mapping(uint256 => string) public tokenURI;

    function setTokenURI(uint256 agentId, string calldata uri) external {
        tokenURI[agentId] = uri;
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        wallets[agentId] = wallet;
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        if (keccak256(bytes(key)) != keccak256("agentWallet") || wallets[agentId] == address(0)) return "";
        return abi.encodePacked(wallets[agentId]);
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return wallets[agentId];
    }
}
