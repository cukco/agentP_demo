// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentPaySessionEscrow} from "../src/AgentPaySessionEscrow.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";

/// @notice Deploys AgentPaySessionEscrow (+ linked BuyerRules library) and wires roles.
///         Fuji:  forge script script/DeployAgentPay.s.sol --rpc-url fuji --broadcast
///         Local: same with --rpc-url http://127.0.0.1:8545 (anvil fork of Fuji, see scripts/anvil-up.sh)
///         Env (from repo .env): DEPLOYER_PRIVATE_KEY, USDC_FUJI, SCORER_ADDRESS, ARBITER_ADDRESS, GUARDIAN_ADDRESS,
///         VERIFIER_ADDRESS; optional SESSION_FEE (default 50000 = $0.05), FEE_BPS (default 50), DEPLOYMENT_NAME.
contract DeployAgentPay is Script {
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    function run() external returns (AgentPaySessionEscrow escrow) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("USDC_FUJI");
        address scorer = vm.envAddress("SCORER_ADDRESS");
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        address verifier = vm.envAddress("VERIFIER_ADDRESS");
        uint128 fee = uint128(vm.envOr("SESSION_FEE", uint256(50_000)));
        uint16 bps = uint16(vm.envOr("FEE_BPS", uint256(50)));
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("fuji"));

        vm.startBroadcast(pk);
        escrow = new AgentPaySessionEscrow(usdc, IDENTITY, REPUTATION, deployer, scorer, arbiter, guardian, fee, bps);
        escrow.addVerifier(verifier, C.DEFAULT_MAX_IN_FLIGHT);
        vm.stopBroadcast();

        console2.log("AgentPaySessionEscrow", address(escrow));
        console2.log("sessionFee", fee, "feeBps", bps);

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "escrow", address(escrow));
        vm.serializeAddress(key, "usdc", usdc);
        vm.serializeAddress(key, "identity", IDENTITY);
        vm.serializeAddress(key, "reputation", REPUTATION);
        vm.serializeAddress(key, "verifier", verifier);
        vm.serializeAddress(key, "scorer", scorer);
        vm.serializeUint(key, "sessionFee", fee);
        vm.serializeUint(key, "feeBps", bps);
        string memory json = vm.serializeUint(key, "deployBlock", block.number);
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../deployments/", name, ".json"));
    }
}
