// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentPaySessionEscrow} from "../src/AgentPaySessionEscrow.sol";
import {IAgentPaySessionEscrow as I} from "../src/interfaces/IAgentPaySessionEscrow.sol";
import {IFiatTokenV2} from "../src/interfaces/IFiatTokenV2.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004.sol";
import {AgentPayHashes as H} from "../src/libraries/AgentPayHashes.sol";

/// @notice Fork Fuji: real Circle USDC (EIP-3009, domain "USD Coin"/"2") and real ERC-8004 registries (Q1, Q4).
///         Needs FUJI_RPC_URL_1; uses BUYER_AUTO_PRIVATE_KEY (holds test USDC on Fuji). Skipped otherwise.
contract AgentPayForkTest is Test {
    address internal constant USDC = 0x5425890298aed601595a70AB815c96711a31Bc65;
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    uint256 internal constant AGENT_ID = 1; // existing Fuji agent; agentWallet = its owner

    AgentPaySessionEscrow internal escrow;
    uint256 internal buyerPk;
    address internal buyer;
    address internal seller;
    uint256 internal scorerPk = 0x5C0;
    uint256 internal verifierPk = 0xF1E;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("FUJI_RPC_URL_1", string(""));
        buyerPk = vm.envOr("BUYER_AUTO_PRIVATE_KEY", uint256(0));
        if (bytes(rpc).length == 0 || buyerPk == 0) return;
        vm.createSelectFork(rpc);
        buyer = vm.addr(buyerPk);
        if (IFiatTokenV2(USDC).balanceOf(buyer) < 1e6) return;
        bytes memory w = IERC8004Identity(IDENTITY).getMetadata(AGENT_ID, "agentWallet");
        seller = address(bytes20(w));
        escrow = new AgentPaySessionEscrow(
            USDC, IDENTITY, REPUTATION, address(this), vm.addr(scorerPk), address(0xA4B), address(0x6A4), 40_000, 50
        );
        escrow.addVerifier(vm.addr(verifierPk), 1_000e6);
        enabled = true;
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _params() internal view returns (I.OpenParams memory) {
        return I.OpenParams({
            seller: seller,
            sellerAgentId: AGENT_ID,
            verifier: vm.addr(verifierPk),
            voucherSigner: buyer,
            specHash: keccak256("fork-spec"),
            cap: 1_000_000,
            pricePerRequest: 10_000,
            expiry: uint64(block.timestamp + 1 hours),
            deliveryDeadlineSec: 10,
            challengeWindowSec: 0
        });
    }

    function _auth(bytes32 nonce, uint256 value) internal view returns (I.Authorization memory a) {
        uint256 vb = block.timestamp + 2 minutes;
        bytes32 sh = keccak256(abi.encode(RWA_TYPEHASH, buyer, address(escrow), value, 0, vb, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", IFiatTokenV2(USDC).DOMAIN_SEPARATOR(), sh)));
        a = I.Authorization({from: buyer, value: value, validAfter: 0, validBefore: vb, nonce: nonce, v: v, r: r, s: s});
    }

    function _att() internal view returns (I.ScoreAttestation memory a, bytes memory sig) {
        a = I.ScoreAttestation({agentId: AGENT_ID, wallet: seller, score: 80, flags: 0, validUntil: uint64(block.timestamp + 30 minutes)});
        bytes32 sh = keccak256(abi.encode(H.SCORE_ATTESTATION_TYPEHASH, a.agentId, a.wallet, a.score, a.flags, a.validUntil));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(scorerPk, keccak256(abi.encodePacked("\x19\x01", escrow.scorerDomainSeparator(), sh)));
        sig = abi.encodePacked(r, s, v);
    }

    function test_fork_usdcDomainIsUsdCoinV2() public onlyFork {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                block.chainid,
                USDC
            )
        );
        assertEq(IFiatTokenV2(USDC).DOMAIN_SEPARATOR(), expected);
    }

    function test_fork_openWithRealUsdc() public onlyFork {
        I.OpenParams memory p = _params();
        bytes32 salt = keccak256("fork-salt-1");
        bytes32 nonce = escrow.computeNonce(p, salt);
        (I.ScoreAttestation memory a, bytes memory as_) = _att();
        uint256 bal = IFiatTokenV2(USDC).balanceOf(buyer);
        uint256 sid = escrow.openWithAuthorization(p, salt, _auth(nonce, p.cap), a, as_);
        assertEq(IFiatTokenV2(USDC).balanceOf(buyer), bal - p.cap);
        assertEq(IFiatTokenV2(USDC).balanceOf(address(escrow)), p.cap);
        assertTrue(IFiatTokenV2(USDC).authorizationState(buyer, nonce));
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.OPEN));
    }

    function test_fork_cancelAuthorizationKillsSignature() public onlyFork {
        I.OpenParams memory p = _params();
        bytes32 salt = keccak256("fork-salt-2");
        bytes32 nonce = escrow.computeNonce(p, salt);
        I.Authorization memory auth = _auth(nonce, p.cap);
        bytes32 sh = keccak256(abi.encode(CANCEL_TYPEHASH, buyer, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", IFiatTokenV2(USDC).DOMAIN_SEPARATOR(), sh)));
        IFiatTokenV2(USDC).cancelAuthorization(buyer, nonce, v, r, s);
        (I.ScoreAttestation memory a, bytes memory as_) = _att();
        vm.expectRevert(); // FiatToken: "authorization is used or canceled"
        escrow.openWithAuthorization(p, salt, auth, a, as_);
    }

    function test_fork_identityBindingUsesRealRegistry() public onlyFork {
        I.OpenParams memory p = _params();
        p.seller = address(0xBEEF); // not agent 1's wallet
        bytes32 salt = keccak256("fork-salt-3");
        (I.ScoreAttestation memory a,) = _att();
        a.wallet = p.seller;
        bytes32 ah = keccak256(abi.encode(H.SCORE_ATTESTATION_TYPEHASH, a.agentId, a.wallet, a.score, a.flags, a.validUntil));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(scorerPk, keccak256(abi.encodePacked("\x19\x01", escrow.scorerDomainSeparator(), ah)));
        I.Authorization memory auth = _auth(escrow.computeNonce(p, salt), p.cap);
        vm.expectRevert(I.IdentityWalletMismatch.selector);
        escrow.openWithAuthorization(p, salt, auth, a, abi.encodePacked(r, s, v));
    }

    function test_fork_closeAndSettleWithRealReputation() public onlyFork {
        I.OpenParams memory p = _params();
        bytes32 salt = keccak256("fork-salt-4");
        (I.ScoreAttestation memory a, bytes memory as_) = _att();
        uint256 sid = escrow.openWithAuthorization(p, salt, _auth(escrow.computeNonce(p, salt), p.cap), a, as_);

        I.Voucher memory vo = I.Voucher({sessionId: sid, seq: 5, cumulativeAmount: 50_000, requestHash: keccak256("r5")});
        bytes32 vh = keccak256(abi.encode(H.VOUCHER_TYPEHASH, vo.sessionId, vo.seq, vo.cumulativeAmount, vo.requestHash));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), vh)));
        I.SessionVerdict memory vd = I.SessionVerdict({
            sessionId: sid,
            specHash: p.specHash,
            lastSeq: 5,
            passCount: 4,
            failCount: 1,
            inconclusiveCount: 0,
            passedAmount: 40_000,
            receiptsRoot: keccak256("root"),
            closedAt: uint64(block.timestamp)
        });
        bytes32 dh = keccak256(
            abi.encode(
                H.SESSION_VERDICT_TYPEHASH, vd.sessionId, vd.specHash, vd.lastSeq, vd.passCount, vd.failCount,
                vd.inconclusiveCount, vd.passedAmount, vd.receiptsRoot, vd.closedAt
            )
        );
        (uint8 v2, bytes32 r2, bytes32 s2) =
            vm.sign(verifierPk, keccak256(abi.encodePacked("\x19\x01", escrow.domainSeparator(), dh)));
        uint256 sellerBal = IFiatTokenV2(USDC).balanceOf(seller);
        vm.recordLogs();
        vm.prank(vm.addr(verifierPk));
        escrow.closeSession(sid, vo, abi.encodePacked(r1, s1, v1), vd, abi.encodePacked(r2, s2, v2));
        assertEq(uint8(escrow.getSession(sid).state), uint8(I.State.SETTLED));
        assertEq(IFiatTokenV2(USDC).balanceOf(seller), sellerBal + 40_000 - 200);
        // The real ERC-8004 registry accepted the feedback (FeedbackGiven ok = true)
        bool sawOk;
        bytes32 topic = keccak256("FeedbackGiven(uint256,uint256,int128,string,bool)");
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(escrow) && logs[i].topics[0] == topic) {
                (,, bool ok) = abi.decode(logs[i].data, (int128, string, bool));
                sawOk = ok;
            }
        }
        assertTrue(sawOk, "ERC-8004 rejected feedback");
    }
}

import {VmSafe} from "forge-std/Vm.sol";
