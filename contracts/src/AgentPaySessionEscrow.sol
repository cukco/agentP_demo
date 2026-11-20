// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IAgentPaySessionEscrow} from "./interfaces/IAgentPaySessionEscrow.sol";
import {IFiatTokenV2} from "./interfaces/IFiatTokenV2.sol";
import {IERC8004Reputation, IERC8004Identity} from "./interfaces/IERC8004.sol";
import {AgentPayConstants as C} from "./libraries/AgentPayConstants.sol";
import {AgentPayHashes as H} from "./libraries/AgentPayHashes.sol";
import {BuyerRules} from "./libraries/BuyerRules.sol";

/// @title AgentPaySessionEscrow
/// @notice Session escrow for x402 agent payments with verifier-signed verdicts, buyer spending rules
///         and ERC-8004 reputation. Spec: AgentPay_SystemDesign.md §4, §5.1, §7; INTERFACE_FREEZE.md (D38).
/// @dev Based on the PayCrow escrow design (MIT).
contract AgentPaySessionEscrow is IAgentPaySessionEscrow, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ───────────────────────────── Immutables ─────────────────────────────

    address public immutable usdc;
    address public immutable identityRegistry;
    address public immutable reputationRegistry;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomain;
    bytes32 private immutable _cachedScorerDomain;

    // ─────────────────────────────── Storage ───────────────────────────────

    /// @dev Packed storage layout (9 slots, 6 written at open). getSession() expands it to the interface struct;
    ///      cumulativeAmount = lastSeq * price and passedAmount = passCount * price are derived (F2), not stored.
    struct Packed {
        address buyer; // slot 0
        uint64 openedAt;
        uint32 deliveryDeadlineSec;
        address voucherSigner; // slot 1
        uint64 expiry;
        uint32 challengeWindowSec;
        address seller; // slot 2
        uint96 sellerAgentId; // ERC-8004 ids are sequential; > uint96 is rejected at open
        address verifier; // slot 3
        uint64 sessionFee; // <= MAX_SESSION_FEE
        uint16 feeBps;
        State state;
        bytes32 specHash; // slot 4
        uint128 cap; // slot 5
        uint128 pricePerRequest;
        uint32 lastSeq; // slot 6 (written at close)
        uint32 passCount;
        uint32 failCount;
        uint32 inconclusiveCount;
        uint64 challengeEnd;
        uint64 resolveDeadline;
        bytes32 receiptsRoot; // slot 7
        address challenger; // slot 8
        uint96 challengeBond;
    }

    mapping(uint256 => Packed) private _sessions;

    mapping(address => VerifierInfo) private _verifiers;
    mapping(address => uint256) public inFlightByVerifier;
    mapping(address => uint256) public withdrawable;
    uint256 public feesAccrued;

    address public scorerSigner;
    address public arbiter;
    address public guardian;
    uint128 public sessionFee;
    uint16 public feeBps;
    bool public paused;

    BuyerRules.Store private _rules;

    bytes32 private constant ROLE_SCORER = "SCORER";
    bytes32 private constant ROLE_ARBITER = "ARBITER";
    bytes32 private constant ROLE_GUARDIAN = "GUARDIAN";

    // ───────────────────────────── Constructor ─────────────────────────────

    constructor(
        address usdc_,
        address identity_,
        address reputation_,
        address owner_,
        address scorerSigner_,
        address arbiter_,
        address guardian_,
        uint128 sessionFee_,
        uint16 feeBps_
    ) Ownable(owner_) {
        if (
            usdc_ == address(0) || identity_ == address(0) || reputation_ == address(0) || scorerSigner_ == address(0)
                || arbiter_ == address(0) || guardian_ == address(0)
        ) revert ZeroAddress();
        if (sessionFee_ > C.MAX_SESSION_FEE || feeBps_ > C.MAX_FEE_BPS) revert FeeTooHigh();

        usdc = usdc_;
        identityRegistry = identity_;
        reputationRegistry = reputation_;
        scorerSigner = scorerSigner_;
        arbiter = arbiter_;
        guardian = guardian_;
        sessionFee = sessionFee_;
        feeBps = feeBps_;

        _cachedChainId = block.chainid;
        _cachedDomain = H.domainSeparator(H.DOMAIN_NAME, block.chainid, address(this));
        _cachedScorerDomain = H.domainSeparator(H.SCORER_DOMAIN_NAME, block.chainid, address(this));
        emit FeeChanged(sessionFee_, feeBps_);
    }

    // ───────────────────────────── Modifiers ─────────────────────────────

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian();
        _;
    }

    // ═════════════════════════ Session lifecycle ═════════════════════════

    /// @inheritdoc IAgentPaySessionEscrow
    function openWithAuthorization(
        OpenParams calldata p,
        bytes32 salt,
        Authorization calldata auth,
        ScoreAttestation calldata att,
        bytes calldata attSig
    ) external nonReentrant returns (uint256 sessionId) {
        // (1) system pause
        if (paused) revert SystemIsPaused();
        // (2) nonce binds every parameter
        bytes32 nonce = H.openNonce(p, salt);
        if (auth.nonce != nonce) revert NonceMismatch();
        if (auth.value != p.cap) revert AuthValueMismatch();
        // (3) short-lived authorization
        if (auth.validBefore > block.timestamp + C.MAX_AUTH_TTL) revert AuthTtlTooLong();
        // (4) verifier registry + in-flight cap
        _checkVerifier(p);
        // (5) parameter bounds
        _checkParams(p, sessionFee);
        // (6) seller binding (always)
        _bindSeller(p, att, attSig);
        // (7) buyer rules
        sessionId = H.sessionId(auth.from, nonce);
        BuyerRules.consume(_rules, auth.from, p.cap, p.sellerAgentId, att.score, sessionId);
        // (8)+(9) record, then pull funds
        _record(sessionId, auth.from, p, sessionFee);
        _pull(auth);
        _emitOpened(sessionId);
    }

    function _checkVerifier(OpenParams calldata p) private view {
        VerifierInfo storage vi = _verifiers[p.verifier];
        if (!vi.active) revert UnknownVerifier();
        if (inFlightByVerifier[p.verifier] + p.cap > vi.maxInFlight) revert VerifierInFlightExceeded();
    }

    /// @dev EIP-3009 pull; USDC enforces msg.sender == to, so the authorization cannot be front-run.
    function _pull(Authorization calldata a) private {
        IFiatTokenV2(usdc).receiveWithAuthorization(
            a.from, address(this), a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s
        );
    }

    function _checkParams(OpenParams calldata p, uint128 fee) private view {
        if (p.cap < C.MIN_CAP || p.cap > C.MAX_CAP) revert CapOutOfRange();
        if (p.cap <= fee) revert CapNotAboveFee();
        if (p.pricePerRequest == 0 || p.pricePerRequest > p.cap - fee) revert BadPrice();
        if (p.expiry <= block.timestamp || p.expiry > block.timestamp + C.MAX_EXPIRY) revert BadExpiry();
        if (p.deliveryDeadlineSec < C.MIN_DELIVERY_DEADLINE || p.deliveryDeadlineSec > C.MAX_DELIVERY_DEADLINE) {
            revert BadDeliveryDeadline();
        }
        if (p.challengeWindowSec > C.MAX_CHALLENGE_WINDOW) revert BadChallengeWindow();
        if (p.voucherSigner == address(0)) revert ZeroVoucherSigner();
    }

    function _bindSeller(OpenParams calldata p, ScoreAttestation calldata att, bytes calldata attSig) private view {
        bytes32 digest = MessageHashUtils.toTypedDataHash(scorerDomainSeparator(), H.hashAttestation(att));
        if (_recover(digest, attSig) != scorerSigner) revert BadAttestationSig();
        if (att.validUntil < block.timestamp) revert AttestationExpired();
        if (att.validUntil > block.timestamp + C.MAX_ATTEST_TTL) revert AttestationTtlTooLong();
        if (att.agentId != p.sellerAgentId) revert AttestationAgentMismatch();
        if (att.wallet != p.seller) revert AttestationWalletMismatch();
        if (att.flags & C.FLAG_FLAGGED != 0) revert SellerFlagged();
        // ids above uint96 cannot exist in the sequential ERC-8004 registry; reject before packing into storage
        if (p.sellerAgentId > type(uint96).max || _identityWallet(p.sellerAgentId) != p.seller) {
            revert IdentityWalletMismatch();
        }
    }

    function _identityWallet(uint256 agentId) private view returns (address w) {
        try IERC8004Identity(identityRegistry).getMetadata(agentId, C.AGENT_WALLET_KEY) returns (bytes memory b) {
            if (b.length == 20) {
                w = address(bytes20(b));
            } else if (b.length == 32) {
                w = abi.decode(b, (address));
            }
        } catch {}
    }

    function _record(uint256 sessionId, address buyer, OpenParams calldata p, uint128 fee) private {
        Packed storage s = _sessions[sessionId];
        if (s.state != State.NONE) revert SessionExists();
        s.buyer = buyer;
        s.voucherSigner = p.voucherSigner;
        s.seller = p.seller;
        s.sellerAgentId = uint96(p.sellerAgentId); // bound checked in _bindSeller
        s.verifier = p.verifier;
        s.specHash = p.specHash;
        s.cap = p.cap;
        s.pricePerRequest = p.pricePerRequest;
        s.openedAt = uint64(block.timestamp);
        s.expiry = p.expiry;
        s.deliveryDeadlineSec = p.deliveryDeadlineSec;
        s.challengeWindowSec = p.challengeWindowSec;
        s.sessionFee = uint64(fee);
        s.feeBps = feeBps;
        s.state = State.OPEN;
        inFlightByVerifier[p.verifier] += p.cap;
    }

    function _emitOpened(uint256 sessionId) private {
        Packed storage s = _sessions[sessionId];
        emit SessionOpened(
            sessionId,
            s.buyer,
            s.seller,
            s.sellerAgentId,
            s.verifier,
            s.voucherSigner,
            s.specHash,
            s.cap,
            s.pricePerRequest,
            s.expiry,
            s.deliveryDeadlineSec,
            s.challengeWindowSec,
            uint128(s.sessionFee),
            s.feeBps
        );
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function closeSession(
        uint256 sessionId,
        Voucher calldata voucher,
        bytes calldata voucherSig,
        SessionVerdict calldata verdict,
        bytes calldata verifierSig
    ) external nonReentrant {
        Packed storage s = _open(sessionId);
        if (msg.sender != s.verifier) {
            if (msg.sender != s.seller) revert NotParty();
            if (block.timestamp < s.expiry) revert TooEarly();
        }
        if (block.timestamp > uint256(s.expiry) + C.VERDICT_GRACE) revert VerdictTooLate();
        if (!_verifiers[s.verifier].active) revert VerifierRevokedForSession();
        if (voucher.sessionId != sessionId || verdict.sessionId != sessionId) revert SessionMismatch();

        bytes32 vd = MessageHashUtils.toTypedDataHash(domainSeparator(), H.hashVoucher(voucher));
        if (_recover(vd, voucherSig) != s.voucherSigner) revert BadVoucherSig();
        bytes32 sd = MessageHashUtils.toTypedDataHash(domainSeparator(), H.hashVerdict(verdict));
        if (_recover(sd, verifierSig) != s.verifier) revert BadVerifierSig();

        _checkVerdict(s, voucher, verdict);

        s.lastSeq = verdict.lastSeq;
        s.passCount = verdict.passCount;
        s.failCount = verdict.failCount;
        s.inconclusiveCount = verdict.inconclusiveCount;
        s.receiptsRoot = verdict.receiptsRoot;
        s.challengeEnd = uint64(block.timestamp) + s.challengeWindowSec;

        emit SessionClosed(
            sessionId,
            msg.sender,
            verdict.lastSeq,
            voucher.cumulativeAmount,
            verdict.passedAmount,
            verdict.passCount,
            verdict.failCount,
            verdict.inconclusiveCount,
            verdict.receiptsRoot,
            s.challengeEnd
        );

        if (s.challengeWindowSec == 0) {
            _settle(sessionId, s);
        } else {
            s.state = State.CLOSING;
        }
    }

    function _checkVerdict(Packed storage s, Voucher calldata voucher, SessionVerdict calldata verdict) private view {
        if (verdict.specHash != s.specHash) revert SpecHashMismatch();
        if (verdict.lastSeq == 0 || verdict.lastSeq != voucher.seq) revert SeqMismatch();
        uint128 price = s.pricePerRequest;
        if (voucher.cumulativeAmount != uint256(voucher.seq) * price) revert BadCumulativeAmount();
        if (voucher.cumulativeAmount > s.cap - s.sessionFee) revert OverUsable();
        if (verdict.passedAmount != uint256(verdict.passCount) * price) revert BadPassedAmount();
        if (verdict.passedAmount > voucher.cumulativeAmount) revert BadPassedAmount();
        if (uint256(verdict.passCount) + verdict.failCount + verdict.inconclusiveCount > verdict.lastSeq) {
            revert BadCounts();
        }
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function closeEmpty(uint256 sessionId, SessionVerdict calldata verdict, bytes calldata verifierSig)
        external
        nonReentrant
    {
        Packed storage s = _open(sessionId);
        if (verdict.sessionId != sessionId) revert SessionMismatch();
        if (verdict.lastSeq != 0) revert NotEmptyVerdict();
        if (verdict.specHash != s.specHash) revert SpecHashMismatch();
        if (!_verifiers[s.verifier].active) revert VerifierRevokedForSession();
        bytes32 sd = MessageHashUtils.toTypedDataHash(domainSeparator(), H.hashVerdict(verdict));
        if (_recover(sd, verifierSig) != s.verifier) revert BadVerifierSig();
        _refundAll(sessionId, s, RefundReason.EMPTY);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function challenge(uint256 sessionId, uint8 reasonCode, Authorization calldata bondAuth) external nonReentrant {
        Packed storage s = _sessions[sessionId];
        _requireState(s, State.CLOSING);
        if (block.timestamp > s.challengeEnd) revert ChallengeWindowOver();
        if (msg.sender != s.buyer && msg.sender != s.seller) revert NotParty();
        uint128 bond = requiredBond(sessionId, msg.sender);
        if (bondAuth.from != msg.sender || bondAuth.value < bond || bondAuth.value > type(uint96).max) {
            revert BadBond();
        }

        s.state = State.CHALLENGED;
        s.challenger = msg.sender;
        s.challengeBond = uint96(bondAuth.value);
        s.resolveDeadline = uint64(block.timestamp + C.RESOLVE_TIMEOUT);

        _pull(bondAuth);
        emit Challenged(sessionId, msg.sender, reasonCode, uint128(bondAuth.value), s.resolveDeadline);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function resolveChallenge(uint256 sessionId, uint32 passCount, uint32 failCount, bool upheld)
        external
        nonReentrant
    {
        if (msg.sender != arbiter) revert NotArbiter();
        Packed storage s = _sessions[sessionId];
        _requireState(s, State.CHALLENGED);
        if (block.timestamp > s.resolveDeadline) revert ResolveDeadlinePassed();
        uint256 newPassed = uint256(passCount) * s.pricePerRequest;
        if (passCount > s.lastSeq) revert BadPassedAmount();
        if (uint256(passCount) + failCount + s.inconclusiveCount > s.lastSeq) revert BadCounts();

        s.passCount = passCount;
        s.failCount = failCount;

        address bondTo = upheld ? s.challenger : (s.challenger == s.buyer ? s.seller : s.buyer);
        uint96 bond = s.challengeBond;
        s.challengeBond = 0;
        emit Resolved(sessionId, upheld, uint128(newPassed), passCount, failCount);

        _settle(sessionId, s);
        _push(bondTo, bond);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function expireChallenge(uint256 sessionId) external nonReentrant {
        Packed storage s = _sessions[sessionId];
        _requireState(s, State.CHALLENGED);
        if (block.timestamp <= s.resolveDeadline) revert ResolveDeadlineNotPassed();
        address challenger = s.challenger;
        uint96 bond = s.challengeBond;
        s.challengeBond = 0;
        emit ChallengeExpired(sessionId);
        _refundAll(sessionId, s, RefundReason.CHALLENGE_EXPIRED);
        _push(challenger, bond);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function proveEquivocation(
        uint256 sessionId,
        Delivery calldata a,
        bytes calldata sigA,
        Delivery calldata b,
        bytes calldata sigB
    ) external nonReentrant {
        Packed storage s = _sessions[sessionId];
        if (s.state != State.OPEN && s.state != State.CLOSING) revert WrongState(State.OPEN, s.state);
        if (a.sessionId != sessionId || b.sessionId != sessionId) revert SessionMismatch();
        if (a.seq != b.seq || a.bodyHash == b.bodyHash) revert NotEquivocation();
        bytes32 da = MessageHashUtils.toTypedDataHash(domainSeparator(), H.hashDelivery(a));
        bytes32 db = MessageHashUtils.toTypedDataHash(domainSeparator(), H.hashDelivery(b));
        if (_recover(da, sigA) != s.seller || _recover(db, sigB) != s.seller) revert BadSellerSig();

        emit EquivocationProven(sessionId, a.seq, a.bodyHash, b.bodyHash);
        _giveFeedback(sessionId, s.sellerAgentId, C.EQUIVOCATION_VALUE, C.TAG2_EQUIVOCATION, keccak256(abi.encode(sessionId, a.bodyHash, b.bodyHash)));
        _refundAll(sessionId, s, RefundReason.EQUIVOCATION);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function finalize(uint256 sessionId) external nonReentrant {
        Packed storage s = _sessions[sessionId];
        _requireState(s, State.CLOSING);
        if (block.timestamp <= s.challengeEnd) revert ChallengeWindowNotOver();
        _settle(sessionId, s);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function refund(uint256 sessionId) external nonReentrant {
        Packed storage s = _open(sessionId);
        if (block.timestamp <= uint256(s.expiry) + C.VERDICT_GRACE) revert NotExpired();
        _refundAll(sessionId, s, RefundReason.EXPIRED);
    }

    /// @inheritdoc IAgentPaySessionEscrow
    function withdraw(address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        IERC20(usdc).safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    // ─────────────────────────── Settlement core ───────────────────────────

    function _settle(uint256 sessionId, Packed storage s) private {
        uint128 cap = s.cap;
        uint128 passed = uint128(uint256(s.passCount) * s.pricePerRequest);
        uint128 sellerFee = uint128((uint256(passed) * s.feeBps) / 10_000);
        uint128 toSeller = passed - sellerFee;
        uint128 toBuyer = cap - passed - s.sessionFee;
        uint128 fee = uint128(s.sessionFee) + sellerFee;

        s.state = State.SETTLED;
        inFlightByVerifier[s.verifier] -= cap;
        feesAccrued += fee;

        _push(s.seller, toSeller);
        _push(s.buyer, toBuyer);
        _sessionFeedback(sessionId, s);
        emit Settled(sessionId, toSeller, toBuyer, fee);
    }

    function _refundAll(uint256 sessionId, Packed storage s, RefundReason reason) private {
        uint128 cap = s.cap;
        s.state = State.REFUNDED;
        inFlightByVerifier[s.verifier] -= cap;
        _push(s.buyer, cap);
        emit Refunded(sessionId, reason, cap);
    }

    /// @dev Push transfer; a reverting / false-returning transfer (e.g. Circle blacklist) is credited instead (V19).
    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = usdc.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            withdrawable[to] += amount;
            emit Withdrawable(to, amount);
        }
    }

    function _sessionFeedback(uint256 sessionId, Packed storage s) private {
        uint256 n = uint256(s.passCount) + s.failCount;
        if (n == 0) return;
        bytes32 fh = keccak256(abi.encode(sessionId, s.receiptsRoot));
        int128 value = int128(int256((uint256(s.passCount) * 100) / n));
        _giveFeedback(sessionId, s.sellerAgentId, value, C.TAG2_SESSION, fh);
        if (uint256(s.failCount) * 2 >= n) {
            _giveFeedback(sessionId, s.sellerAgentId, C.FAIL_HEAVY_VALUE, C.TAG2_FAIL_HEAVY, fh);
        }
    }

    function _giveFeedback(uint256 sessionId, uint256 agentId, int128 value, string memory tag2, bytes32 fh) private {
        bool ok;
        try IERC8004Reputation(reputationRegistry).giveFeedback(agentId, value, 0, C.TAG1, tag2, "", "", fh) {
            ok = true;
        } catch {}
        emit FeedbackGiven(sessionId, agentId, value, tag2, ok);
    }

    // ═════════════════════════════ Buyer rules ═════════════════════════════
    // Hard check runs inline at open; management lives in the linked BuyerRules library (delegatecall).

    function registerBuyer(address admin, PolicyParams calldata np) external {
        BuyerRules.register(_rules, admin, np);
    }

    function tighten(address buyer, PolicyParams calldata np) external {
        BuyerRules.tighten(_rules, buyer, np);
    }

    function proposeLoosen(address buyer, PolicyParams calldata np) external {
        BuyerRules.proposeLoosen(_rules, buyer, np);
    }

    function applyLoosen(address buyer) external {
        BuyerRules.applyLoosen(_rules, buyer);
    }

    function cancelLoosen(address buyer) external {
        BuyerRules.cancelLoosen(_rules, buyer);
    }

    function pauseBuyer(address buyer) external {
        BuyerRules.pauseBuyer(_rules, buyer);
    }

    function setSellerAllowed(address buyer, uint256 agentId, bool allowed) external {
        BuyerRules.setSellerAllowed(_rules, buyer, agentId, allowed);
    }

    function applySellerAllowed(address buyer, uint256 agentId) external {
        BuyerRules.applySellerAllowed(_rules, buyer, agentId);
    }

    function cancelSellerAllowed(address buyer, uint256 agentId) external {
        BuyerRules.cancelSellerAllowed(_rules, buyer, agentId);
    }

    function proposeAdmin(address buyer, address newAdmin) external {
        BuyerRules.proposeAdmin(_rules, buyer, newAdmin);
    }

    function applyAdmin(address buyer) external {
        BuyerRules.applyAdmin(_rules, buyer);
    }

    function cancelAdmin(address buyer) external {
        BuyerRules.cancelAdmin(_rules, buyer);
    }

    function tightenBySig(address buyer, PolicyParams calldata np, uint256 deadline, bytes calldata sig) external {
        BuyerRules.tightenBySig(_rules, buyer, np, deadline, sig, domainSeparator());
    }

    function proposeLoosenBySig(address buyer, PolicyParams calldata np, uint256 deadline, bytes calldata sig)
        external
    {
        BuyerRules.proposeLoosenBySig(_rules, buyer, np, deadline, sig, domainSeparator());
    }

    function cancelLoosenBySig(address buyer, uint256 deadline, bytes calldata sig) external {
        BuyerRules.cancelLoosenBySig(_rules, buyer, deadline, sig, domainSeparator());
    }

    function pauseBuyerBySig(address buyer, uint256 deadline, bytes calldata sig) external {
        BuyerRules.pauseBuyerBySig(_rules, buyer, deadline, sig, domainSeparator());
    }

    function setSellerAllowedBySig(address buyer, uint256 agentId, bool allowed, uint256 deadline, bytes calldata sig)
        external
    {
        BuyerRules.setSellerAllowedBySig(_rules, buyer, agentId, allowed, deadline, sig, domainSeparator());
    }

    function cancelSellerAllowedBySig(address buyer, uint256 agentId, uint256 deadline, bytes calldata sig)
        external
    {
        BuyerRules.cancelSellerAllowedBySig(_rules, buyer, agentId, deadline, sig, domainSeparator());
    }

    function proposeAdminBySig(address buyer, address newAdmin, uint256 deadline, bytes calldata sig) external {
        BuyerRules.proposeAdminBySig(_rules, buyer, newAdmin, deadline, sig, domainSeparator());
    }

    function cancelAdminBySig(address buyer, uint256 deadline, bytes calldata sig) external {
        BuyerRules.cancelAdminBySig(_rules, buyer, deadline, sig, domainSeparator());
    }

    // ═══════════════════════════ Protocol admin ═══════════════════════════

    function addVerifier(address verifier, uint128 maxInFlight) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        _verifiers[verifier] = VerifierInfo({active: true, maxInFlight: maxInFlight});
        emit VerifierAdded(verifier, maxInFlight);
    }

    function revokeVerifier(address verifier) external onlyOwnerOrGuardian {
        _verifiers[verifier].active = false;
        emit VerifierRevoked(verifier, msg.sender);
    }

    function pauseSystem() external onlyOwnerOrGuardian {
        paused = true;
        emit SystemPaused(msg.sender);
    }

    function unpauseSystem() external onlyOwner {
        paused = false;
        emit SystemUnpaused(msg.sender);
    }

    function setFees(uint128 newSessionFee, uint16 newFeeBps) external onlyOwner {
        if (newSessionFee > C.MAX_SESSION_FEE || newFeeBps > C.MAX_FEE_BPS) revert FeeTooHigh();
        sessionFee = newSessionFee;
        feeBps = newFeeBps;
        emit FeeChanged(newSessionFee, newFeeBps);
    }

    function setScorerSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        scorerSigner = signer;
        emit RoleChanged(ROLE_SCORER, signer);
    }

    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter_ == address(0)) revert ZeroAddress();
        arbiter = arbiter_;
        emit RoleChanged(ROLE_ARBITER, arbiter_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit RoleChanged(ROLE_GUARDIAN, guardian_);
    }

    function withdrawFees(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = feesAccrued;
        if (amount == 0) revert NothingToWithdraw();
        feesAccrued = 0;
        IERC20(usdc).safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    // ═══════════════════════════════ Views ═══════════════════════════════

    function getSession(uint256 sessionId) external view returns (Session memory r) {
        Packed storage s = _sessions[sessionId];
        r.buyer = s.buyer;
        r.voucherSigner = s.voucherSigner;
        r.seller = s.seller;
        r.sellerAgentId = s.sellerAgentId;
        r.verifier = s.verifier;
        r.specHash = s.specHash;
        r.cap = s.cap;
        r.pricePerRequest = s.pricePerRequest;
        r.openedAt = s.openedAt;
        r.expiry = s.expiry;
        r.deliveryDeadlineSec = s.deliveryDeadlineSec;
        r.challengeWindowSec = s.challengeWindowSec;
        r.challengeEnd = s.challengeEnd;
        r.sessionFee = s.sessionFee;
        r.feeBps = s.feeBps;
        r.cumulativeAmount = uint128(uint256(s.lastSeq) * s.pricePerRequest);
        r.passedAmount = uint128(uint256(s.passCount) * s.pricePerRequest);
        r.lastSeq = s.lastSeq;
        r.passCount = s.passCount;
        r.failCount = s.failCount;
        r.inconclusiveCount = s.inconclusiveCount;
        r.receiptsRoot = s.receiptsRoot;
        r.state = s.state;
        r.challenger = s.challenger;
        r.challengeBond = s.challengeBond;
        r.resolveDeadline = s.resolveDeadline;
    }

    function computeNonce(OpenParams calldata p, bytes32 salt) external pure returns (bytes32) {
        return H.openNonce(p, salt);
    }

    function computeSessionId(address buyer, bytes32 nonce) external pure returns (uint256) {
        return H.sessionId(buyer, nonce);
    }

    function requiredBond(uint256 sessionId, address challenger) public view returns (uint128) {
        Packed storage s = _sessions[sessionId];
        uint256 passed = uint256(s.passCount) * s.pricePerRequest;
        uint256 disputed = challenger == s.buyer ? passed : uint256(s.lastSeq) * s.pricePerRequest - passed;
        uint256 bond = (disputed * C.BOND_BPS) / 10_000;
        return bond < C.MIN_BOND ? C.MIN_BOND : uint128(bond);
    }

    function availableDaily(address buyer) external view returns (uint128) {
        if (_rules.policy[buyer].admin == address(0)) return C.DEFAULT_MAX_PER_SESSION;
        return BuyerRules.available(_rules, buyer);
    }

    function buyerPolicy(address buyer) external view returns (BuyerPolicy memory) {
        return _rules.policy[buyer];
    }

    function bucket(address buyer) external view returns (Bucket memory) {
        return _rules.bucket[buyer];
    }

    function pendingLoosen(address buyer) external view returns (PendingLoosen memory) {
        return _rules.pendingLoosen[buyer];
    }

    function pendingAdmin(address buyer) external view returns (PendingAdmin memory) {
        return _rules.pendingAdmin[buyer];
    }

    function pendingSellerAllowed(address buyer, uint256 agentId) external view returns (uint64) {
        return _rules.pendingSellerAllowed[buyer][agentId];
    }

    function sellerAllowed(address buyer, uint256 agentId) external view returns (bool) {
        return _rules.sellerAllowed[buyer][agentId];
    }

    function adminNonces(address buyer) external view returns (uint256) {
        return _rules.adminNonces[buyer];
    }

    function verifierInfo(address verifier) external view returns (VerifierInfo memory) {
        return _verifiers[verifier];
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId
            ? _cachedDomain
            : H.domainSeparator(H.DOMAIN_NAME, block.chainid, address(this));
    }

    function scorerDomainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId
            ? _cachedScorerDomain
            : H.domainSeparator(H.SCORER_DOMAIN_NAME, block.chainid, address(this));
    }

    // ───────────────────────────── Internals ─────────────────────────────

    function _open(uint256 sessionId) private view returns (Packed storage s) {
        s = _sessions[sessionId];
        _requireState(s, State.OPEN);
    }

    function _requireState(Packed storage s, State expected) private view {
        if (s.state == State.NONE) revert SessionNotFound();
        if (s.state != expected) revert WrongState(expected, s.state);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError ? signer : address(0);
    }
}
