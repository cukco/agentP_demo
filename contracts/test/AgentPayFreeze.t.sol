// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {AgentPayHashes as H} from "../src/libraries/AgentPayHashes.sol";
import {AgentPayConstants as C} from "../src/libraries/AgentPayConstants.sol";

/// @dev Exposes the calldata-based library helpers.
contract HashHarness {
    function hashDelivery(I.Delivery calldata d) external pure returns (bytes32) {
        return H.hashDelivery(d);
    }

    function openNonce(I.OpenParams calldata p, bytes32 salt) external pure returns (bytes32) {
        return H.openNonce(p, salt);
    }

    function hashVoucher(I.Voucher calldata v) external pure returns (bytes32) {
        return H.hashVoucher(v);
    }

    function hashVerdict(I.SessionVerdict calldata s) external pure returns (bytes32) {
        return H.hashVerdict(s);
    }

    function hashAttestation(I.ScoreAttestation calldata a) external pure returns (bytes32) {
        return H.hashAttestation(a);
    }

    function hashPolicy(I.PolicyParams calldata p) external pure returns (bytes32) {
        return H.hashPolicy(p);
    }
}

/// @notice Interface freeze check: Solidity must reproduce packages/agentpay-core/vectors/freeze.json exactly.
contract AgentPayFreezeTest is Test {
    string internal json;
    HashHarness internal h;

    uint256 internal constant CHAIN_ID = 43113;
    address internal constant ESCROW = 0x00000000000000000000000000000000000e5c40;
    address internal constant BUYER = 0x318480ac2dd10427E6B866f57656ab4f41412bB7;
    bytes32 internal constant SALT = 0x1111111111111111111111111111111111111111111111111111111111111111;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../packages/agentpay-core/vectors/freeze.json"));
        h = new HashHarness();
    }

    function _th(string memory name) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, string.concat(".typehashes.", name));
    }

    function _const(string memory name) internal view returns (uint256) {
        return vm.parseJsonUint(json, string.concat(".constants.", name));
    }

    function _params() internal pure returns (I.OpenParams memory) {
        return I.OpenParams({
            seller: 0x000df72153A7759980C5b427302aB8ae724E85b1,
            sellerAgentId: 12,
            verifier: 0x7C06cef00c06455a7d0Dd91A10732b46F9Ea1FAA,
            voucherSigner: 0x318480ac2dd10427E6B866f57656ab4f41412bB7,
            specHash: 0x2222222222222222222222222222222222222222222222222222222222222222,
            cap: 5_000_000,
            pricePerRequest: 10_000,
            expiry: 1_800_000_000,
            deliveryDeadlineSec: 10,
            challengeWindowSec: 60
        });
    }

    function _digest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function test_typehashes() public view {
        assertEq(H.VOUCHER_TYPEHASH, _th("Voucher"), "Voucher");
        assertEq(H.DELIVERY_TYPEHASH, _th("Delivery"), "Delivery");
        assertEq(H.RECEIPT_TYPEHASH, _th("Receipt"), "Receipt");
        assertEq(H.SESSION_VERDICT_TYPEHASH, _th("SessionVerdict"), "SessionVerdict");
        assertEq(H.SCORE_ATTESTATION_TYPEHASH, _th("ScoreAttestation"), "ScoreAttestation");
        assertEq(H.CLOSE_REQUEST_TYPEHASH, _th("CloseRequest"), "CloseRequest");
        assertEq(H.TIGHTEN_TYPEHASH, _th("Tighten"), "Tighten");
        assertEq(H.PROPOSE_LOOSEN_TYPEHASH, _th("ProposeLoosen"), "ProposeLoosen");
        assertEq(H.CANCEL_LOOSEN_TYPEHASH, _th("CancelLoosen"), "CancelLoosen");
        assertEq(H.PAUSE_BUYER_TYPEHASH, _th("PauseBuyer"), "PauseBuyer");
        assertEq(H.SET_SELLER_ALLOWED_TYPEHASH, _th("SetSellerAllowed"), "SetSellerAllowed");
        assertEq(H.CANCEL_SELLER_ALLOWED_TYPEHASH, _th("CancelSellerAllowed"), "CancelSellerAllowed");
        assertEq(H.PROPOSE_ADMIN_TYPEHASH, _th("ProposeAdmin"), "ProposeAdmin");
        assertEq(H.CANCEL_ADMIN_TYPEHASH, _th("CancelAdmin"), "CancelAdmin");
    }

    function test_constants() public view {
        assertEq(C.MIN_CAP, _const("MIN_CAP"));
        assertEq(C.MAX_CAP, _const("MAX_CAP"));
        assertEq(C.DEFAULT_MAX_PER_SESSION, _const("DEFAULT_MAX_PER_SESSION"));
        assertEq(C.DEFAULT_MAX_IN_FLIGHT, _const("DEFAULT_MAX_IN_FLIGHT"));
        assertEq(C.MAX_EXPIRY, _const("MAX_EXPIRY"));
        assertEq(C.MIN_DELIVERY_DEADLINE, _const("MIN_DELIVERY_DEADLINE"));
        assertEq(C.MAX_DELIVERY_DEADLINE, _const("MAX_DELIVERY_DEADLINE"));
        assertEq(C.MAX_CHALLENGE_WINDOW, _const("MAX_CHALLENGE_WINDOW"));
        assertEq(C.MAX_AUTH_TTL, _const("MAX_AUTH_TTL"));
        assertEq(C.MAX_ATTEST_TTL, _const("MAX_ATTEST_TTL"));
        assertEq(C.RESOLVE_TIMEOUT, _const("RESOLVE_TIMEOUT"));
        assertEq(C.VERDICT_GRACE, _const("VERDICT_GRACE"));
        assertEq(C.LOOSEN_DELAY, _const("LOOSEN_DELAY"));
        assertEq(C.MAX_SESSION_FEE, _const("MAX_SESSION_FEE"));
        assertEq(C.MAX_FEE_BPS, _const("MAX_FEE_BPS"));
        assertEq(C.MIN_BOND, _const("MIN_BOND"));
        assertEq(C.BOND_BPS, _const("BOND_BPS"));
    }

    function test_openNonce_and_sessionId() public view {
        bytes32 nonce = h.openNonce(_params(), SALT);
        assertEq(nonce, vm.parseJsonBytes32(json, ".openNonce"), "openNonce");
        assertEq(H.sessionId(BUYER, nonce), vm.parseJsonUint(json, ".sessionId"), "sessionId");
    }

    function test_requestHash() public view {
        bytes32 rh = keccak256(abi.encode("GET", "https://seller.example/v1/price/AVAX", keccak256("")));
        assertEq(rh, vm.parseJsonBytes32(json, ".requestHash"));
    }

    function test_sdkDigestsAndThirdReceiptProof() public view {
        uint256 sid = H.sessionId(BUYER, h.openNonce(_params(), SALT));
        bytes32 ds = H.domainSeparator(H.DOMAIN_NAME, CHAIN_ID, ESCROW);
        bytes32 request = vm.parseJsonBytes32(json, ".requestHash");
        I.Delivery memory delivery = I.Delivery(sid, 3, request, SALT, _params().specHash);
        assertEq(_digest(ds, h.hashDelivery(delivery)), vm.parseJsonBytes32(json, ".deliveryDigest"));
        uint256 deadline = _params().expiry;
        assertEq(_digest(ds, keccak256(abi.encode(H.CLOSE_REQUEST_TYPEHASH, sid, deadline))),
            vm.parseJsonBytes32(json, ".closeRequestDigest"));
        assertEq(_digest(ds, keccak256(abi.encode(H.PAUSE_BUYER_TYPEHASH, BUYER, uint256(1), deadline))),
            vm.parseJsonBytes32(json, ".pauseBuyerDigest"));

        bytes32 leaf = keccak256(abi.encode(H.RECEIPT_TYPEHASH, sid, uint32(3), request, SALT,
            uint8(1), uint16(0), uint128(10_000), uint64(1_799_999_000), bytes32(0)));
        assertEq(_digest(ds, leaf), vm.parseJsonBytes32(json, ".receiptDigest"));
        bytes32[] memory proof = vm.parseJsonBytes32Array(json, ".thirdReceiptProof");
        assertEq(proof.length, 3);
        assertTrue(MerkleProof.verify(proof, vm.parseJsonBytes32(json, ".receiptsRoot"), leaf));
    }

    function test_digests() public view {
        bytes32 nonce = h.openNonce(_params(), SALT);
        uint256 sid = H.sessionId(BUYER, nonce);
        bytes32 ds = H.domainSeparator(H.DOMAIN_NAME, CHAIN_ID, ESCROW);

        I.Voucher memory v = I.Voucher({
            sessionId: sid,
            seq: 3,
            cumulativeAmount: 30_000,
            requestHash: vm.parseJsonBytes32(json, ".requestHash")
        });
        assertEq(_digest(ds, h.hashVoucher(v)), vm.parseJsonBytes32(json, ".voucherDigest"), "voucher");

        I.SessionVerdict memory s = I.SessionVerdict({
            sessionId: sid,
            specHash: _params().specHash,
            lastSeq: 3,
            passCount: 2,
            failCount: 1,
            inconclusiveCount: 0,
            passedAmount: 20_000,
            receiptsRoot: 0x3333333333333333333333333333333333333333333333333333333333333333,
            closedAt: 1_799_999_000
        });
        assertEq(h.hashVerdict(s), vm.parseJsonBytes32(json, ".verdictStructHash"), "verdict struct");
        assertEq(_digest(ds, h.hashVerdict(s)), vm.parseJsonBytes32(json, ".verdictDigest"), "verdict");

        I.ScoreAttestation memory a = I.ScoreAttestation({
            agentId: 12,
            wallet: _params().seller,
            score: 72,
            flags: 0,
            validUntil: 1_799_999_999
        });
        bytes32 sds = H.domainSeparator(H.SCORER_DOMAIN_NAME, CHAIN_ID, ESCROW);
        assertEq(_digest(sds, h.hashAttestation(a)), vm.parseJsonBytes32(json, ".attestationDigest"), "attestation");

        I.PolicyParams memory p = I.PolicyParams({
            maxPerSession: 5_000_000,
            dailyCap: 20_000_000,
            minScore: 50,
            paused: false,
            sellerAllowlistOn: true
        });
        assertEq(h.hashPolicy(p), vm.parseJsonBytes32(json, ".policyStructHash"), "policy");
    }
}
