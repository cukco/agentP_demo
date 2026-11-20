// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAgentPaySessionEscrow
/// @notice Interface freeze (H3) for the AgentPay session escrow. Source of truth for structs, events,
///         errors and function signatures. Behaviour is specified in AgentPay_SystemDesign.md §4, §5.1, §7.
///         Any change after the freeze needs a PR reviewed by A + C (ABI and typehashes are shared with TS).
interface IAgentPaySessionEscrow {
    // ───────────────────────────── Enums ─────────────────────────────

    enum State {
        NONE,
        OPEN,
        CLOSING,
        CHALLENGED,
        SETTLED,
        REFUNDED
    }

    /// @dev Why a session ended in REFUNDED (100% of cap back to buyer, no fee).
    enum RefundReason {
        EXPIRED, // refund(): not closed before expiry + VERDICT_GRACE
        EMPTY, // closeEmpty(): verdict with lastSeq = 0
        EQUIVOCATION, // proveEquivocation()
        CHALLENGE_EXPIRED // expireChallenge(): arbiter missed RESOLVE_TIMEOUT
    }

    // ──────────────────────────── Structs ────────────────────────────

    /// @notice Session parameters signed by the buyer through the EIP-3009 nonce (SystemDesign §4.2).
    /// @dev nonce = keccak256(abi.encode(seller, sellerAgentId, verifier, voucherSigner, specHash, cap,
    ///              pricePerRequest, expiry, deliveryDeadlineSec, challengeWindowSec, salt))
    struct OpenParams {
        address seller;
        uint256 sellerAgentId;
        address verifier;
        address voucherSigner; // auto mode: buyer wallet; approve mode: per-session temp key. Must be != 0
        bytes32 specHash;
        uint128 cap; // USDC base units (6 decimals); usable amount = cap - sessionFee
        uint128 pricePerRequest; // fixed price in MVP; cumulativeAmount = seq * pricePerRequest
        uint64 expiry; // absolute unix seconds, now < expiry <= now + MAX_EXPIRY
        uint32 deliveryDeadlineSec; // [MIN_DELIVERY_DEADLINE, MAX_DELIVERY_DEADLINE]
        uint32 challengeWindowSec; // [0, MAX_CHALLENGE_WINDOW]; 0 = settle immediately on close
    }

    /// @notice EIP-3009 ReceiveWithAuthorization signed by `from` on USDC (domain {"USD Coin","2"}).
    struct Authorization {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Signed off-chain by session.voucherSigner for every request (EIP-712, domain "AgentPay"/"0.2").
    struct Voucher {
        uint256 sessionId;
        uint32 seq; // starts at 1, +1 per request
        uint128 cumulativeAmount; // == seq * pricePerRequest, <= cap - sessionFee
        bytes32 requestHash;
    }

    /// @notice Signed off-chain by session.seller when delivering a body.
    struct Delivery {
        uint256 sessionId;
        uint32 seq;
        bytes32 requestHash;
        bytes32 bodyHash;
        bytes32 specHash;
    }

    /// @notice Signed by the session verifier at close (and as checkpoint every CHECKPOINT_EVERY requests).
    struct SessionVerdict {
        uint256 sessionId;
        bytes32 specHash;
        uint32 lastSeq; // must equal voucher.seq passed with it; 0 only for closeEmpty
        uint32 passCount;
        uint32 failCount;
        uint32 inconclusiveCount;
        uint128 passedAmount; // must equal passCount * pricePerRequest
        bytes32 receiptsRoot;
        uint64 closedAt;
    }

    /// @notice Signed by scorerSigner under domain {"AgentPay Scorer","0.2",chainId,escrow}. Always required (D31).
    struct ScoreAttestation {
        uint256 agentId;
        address wallet;
        uint16 score; // 0-100
        uint16 flags; // bit0 = reference-only score; bit1 = flagged (OFAC / scam) -> open reverts
        uint64 validUntil; // now <= validUntil <= now + MAX_ATTEST_TTL
    }

    /// @notice Editable part of a buyer policy (admin is changed separately with a 24h delay).
    struct PolicyParams {
        uint128 maxPerSession;
        uint128 dailyCap; // token bucket refilling dailyCap per 24h
        uint16 minScore; // 0 = no score check (seller binding is still enforced)
        bool paused;
        bool sellerAllowlistOn;
    }

    struct BuyerPolicy {
        address admin; // address(0) = buyer not registered -> default rules (cap <= DEFAULT_MAX_PER_SESSION)
        uint128 maxPerSession;
        uint128 dailyCap;
        uint16 minScore;
        bool paused;
        bool sellerAllowlistOn;
    }

    struct Bucket {
        uint128 available;
        uint64 lastUpdate;
    }

    struct PendingLoosen {
        PolicyParams policy;
        uint64 effectiveAt; // 0 = nothing pending
    }

    struct PendingAdmin {
        address newAdmin;
        uint64 effectiveAt; // 0 = nothing pending
    }

    struct VerifierInfo {
        bool active;
        uint128 maxInFlight;
    }

    struct Session {
        address buyer; // EIP-3009 `from`
        address voucherSigner;
        address seller;
        uint256 sellerAgentId;
        address verifier;
        bytes32 specHash;
        uint128 cap;
        uint128 pricePerRequest;
        uint64 openedAt;
        uint64 expiry;
        uint32 deliveryDeadlineSec;
        uint32 challengeWindowSec;
        uint64 challengeEnd;
        uint128 sessionFee; // pinned at open
        uint16 feeBps; // pinned at open
        uint128 cumulativeAmount; // from voucher at close
        uint128 passedAmount; // from verdict (or arbiter)
        uint32 lastSeq;
        uint32 passCount;
        uint32 failCount;
        uint32 inconclusiveCount;
        bytes32 receiptsRoot;
        State state;
        address challenger;
        uint128 challengeBond;
        uint64 resolveDeadline;
    }

    // ──────────────────────────── Events ─────────────────────────────

    event SessionOpened(
        uint256 indexed sessionId,
        address indexed buyer,
        address indexed seller,
        uint256 sellerAgentId,
        address verifier,
        address voucherSigner,
        bytes32 specHash,
        uint128 cap,
        uint128 pricePerRequest,
        uint64 expiry,
        uint32 deliveryDeadlineSec,
        uint32 challengeWindowSec,
        uint128 sessionFee,
        uint16 feeBps
    );
    event SessionClosed(
        uint256 indexed sessionId,
        address indexed closedBy,
        uint32 lastSeq,
        uint128 cumulativeAmount,
        uint128 passedAmount,
        uint32 passCount,
        uint32 failCount,
        uint32 inconclusiveCount,
        bytes32 receiptsRoot,
        uint64 challengeEnd
    );
    event Challenged(
        uint256 indexed sessionId, address indexed challenger, uint8 reasonCode, uint128 bond, uint64 resolveDeadline
    );
    event Resolved(uint256 indexed sessionId, bool upheld, uint128 passedAmount, uint32 passCount, uint32 failCount);
    event ChallengeExpired(uint256 indexed sessionId);
    event EquivocationProven(uint256 indexed sessionId, uint32 seq, bytes32 bodyHashA, bytes32 bodyHashB);
    event Settled(uint256 indexed sessionId, uint128 toSeller, uint128 toBuyer, uint128 fee);
    event Refunded(uint256 indexed sessionId, RefundReason reason, uint128 amount);
    event FeedbackGiven(uint256 indexed sessionId, uint256 indexed agentId, int128 value, string tag2, bool ok);
    event Withdrawable(address indexed account, uint256 amount); // push transfer failed -> credited
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    event VerifierAdded(address indexed verifier, uint128 maxInFlight);
    event VerifierRevoked(address indexed verifier, address indexed by);
    event SystemPaused(address indexed by);
    event SystemUnpaused(address indexed by);
    event FeeChanged(uint128 sessionFee, uint16 feeBps);
    event RoleChanged(bytes32 indexed role, address indexed account); // "SCORER" | "ARBITER" | "GUARDIAN"
    event FeesWithdrawn(address indexed to, uint256 amount);

    event BuyerRegistered(address indexed buyer, address indexed admin, PolicyParams policy);
    event BuyerSpend(address indexed buyer, uint256 indexed sessionId, uint128 amount, uint128 availableAfter);
    event PolicyTightened(address indexed buyer, PolicyParams policy);
    event LoosenProposed(address indexed buyer, PolicyParams policy, uint64 effectiveAt);
    event LoosenApplied(address indexed buyer, PolicyParams policy);
    event LoosenCancelled(address indexed buyer);
    event BuyerPaused(address indexed buyer, address indexed by);
    event SellerAllowedProposed(address indexed buyer, uint256 indexed agentId, uint64 effectiveAt);
    event SellerAllowedSet(address indexed buyer, uint256 indexed agentId, bool allowed);
    event SellerAllowedCancelled(address indexed buyer, uint256 indexed agentId);
    event AdminProposed(address indexed buyer, address indexed newAdmin, uint64 effectiveAt);
    event AdminChanged(address indexed buyer, address indexed newAdmin);
    event AdminCancelled(address indexed buyer);

    // ──────────────────────────── Errors ─────────────────────────────

    // open
    error SystemIsPaused();
    error NonceMismatch();
    error AuthValueMismatch();
    error AuthTtlTooLong();
    error UnknownVerifier();
    error VerifierInFlightExceeded();
    error CapOutOfRange();
    error CapNotAboveFee();
    error BadPrice();
    error BadExpiry();
    error BadDeliveryDeadline();
    error BadChallengeWindow();
    error ZeroVoucherSigner();
    error SessionExists();
    // seller binding
    error BadAttestationSig();
    error AttestationExpired();
    error AttestationTtlTooLong();
    error AttestationAgentMismatch();
    error AttestationWalletMismatch();
    error SellerFlagged();
    error IdentityWalletMismatch();
    // buyer rules
    error BuyerAlreadyRegistered();
    error BuyerNotRegistered();
    error NotBuyerAdmin();
    error BuyerIsPaused();
    error OverPerSession();
    error OverDailyCap();
    error BadScore();
    error SellerNotAllowed();
    error NotTighter();
    error NothingPending();
    error PendingNotReady();
    error BadPolicy();
    error SigExpired();
    error BadAdminSig();
    // close / settle
    error WrongState(State expected, State actual);
    error SessionNotFound();
    error BadVoucherSig();
    error BadVerifierSig();
    error VerifierRevokedForSession();
    error SessionMismatch();
    error SpecHashMismatch();
    error SeqMismatch();
    error BadCumulativeAmount();
    error BadPassedAmount();
    error BadCounts();
    error OverUsable();
    error TooEarly();
    error VerdictTooLate();
    error NotEmptyVerdict();
    error ChallengeWindowOver();
    error ChallengeWindowNotOver();
    error NotParty();
    error BadBond();
    error NotArbiter();
    error ResolveDeadlinePassed();
    error ResolveDeadlineNotPassed();
    error NotExpired();
    error NotEquivocation();
    error BadSellerSig();
    // admin
    error NotOwnerOrGuardian();
    error FeeTooHigh();
    error ZeroAddress();
    error NothingToWithdraw();

    // ───────────────────────── Session lifecycle ─────────────────────────

    /// @notice Facilitator submits the buyer's EIP-3009 authorization. 9 checks in SystemDesign §5.1.1.
    /// @return sessionId = uint256(keccak256(abi.encode(auth.from, nonce)))
    function openWithAuthorization(
        OpenParams calldata params,
        bytes32 salt,
        Authorization calldata auth,
        ScoreAttestation calldata att,
        bytes calldata attSig
    ) external returns (uint256 sessionId);

    /// @notice Session verifier at any time; seller only when now >= expiry (S10). Reverts after expiry + VERDICT_GRACE.
    function closeSession(
        uint256 sessionId,
        Voucher calldata voucher,
        bytes calldata voucherSig,
        SessionVerdict calldata verdict,
        bytes calldata verifierSig
    ) external;

    /// @notice Anyone, with a verifier-signed verdict having lastSeq == 0. Full refund, no fee, no feedback.
    function closeEmpty(uint256 sessionId, SessionVerdict calldata verdict, bytes calldata verifierSig) external;

    /// @notice Buyer or seller of the session, during the challenge window. Bond paid via EIP-3009 (bondAuth.from == msg.sender).
    function challenge(uint256 sessionId, uint8 reasonCode, Authorization calldata bondAuth) external;

    /// @notice Arbiter only, before resolveDeadline. passedAmount = passCount * pricePerRequest.
    /// @param upheld true -> bond back to challenger; false -> bond to the counterparty.
    function resolveChallenge(uint256 sessionId, uint32 passCount, uint32 failCount, bool upheld) external;

    /// @notice Anyone, after resolveDeadline: full refund to buyer, bond back to challenger, no fee, no feedback.
    function expireChallenge(uint256 sessionId) external;

    /// @notice Anyone. Two valid seller Deliveries for the same (sessionId, seq) with different bodyHash.
    function proveEquivocation(
        uint256 sessionId,
        Delivery calldata a,
        bytes calldata sigA,
        Delivery calldata b,
        bytes calldata sigB
    ) external;

    /// @notice Anyone (Keeper), after challengeEnd. Push transfers with fallback to withdrawable; one ERC-8004 feedback.
    function finalize(uint256 sessionId) external;

    /// @notice Anyone, after expiry + VERDICT_GRACE while still OPEN. Full refund, no fee, no feedback.
    function refund(uint256 sessionId) external;

    /// @notice Withdraw msg.sender's withdrawable balance to any `to` (blacklisted wallets can recover funds, V19).
    function withdraw(address to) external;

    // ─────────────────────────── Buyer rules ───────────────────────────

    /// @notice Called once by the buyer EOA itself (setup script, not the agent).
    function registerBuyer(address admin, PolicyParams calldata policy) external;

    /// @notice Admin. Every field must be tighter or equal; effective immediately; clamps bucket.available.
    function tighten(address buyer, PolicyParams calldata policy) external;

    /// @notice Admin. Any loosening (incl. paused true->false) waits LOOSEN_DELAY. Overwrites a previous proposal.
    function proposeLoosen(address buyer, PolicyParams calldata policy) external;

    /// @notice Anyone, after effectiveAt.
    function applyLoosen(address buyer) external;

    /// @notice Admin.
    function cancelLoosen(address buyer) external;

    /// @notice Admin or the buyer EOA itself. Immediate.
    function pauseBuyer(address buyer) external;

    /// @notice Admin. allowed=false is immediate; allowed=true waits LOOSEN_DELAY (then applySellerAllowed).
    function setSellerAllowed(address buyer, uint256 agentId, bool allowed) external;

    function applySellerAllowed(address buyer, uint256 agentId) external;

    function cancelSellerAllowed(address buyer, uint256 agentId) external;

    /// @notice Admin. Waits LOOSEN_DELAY.
    function proposeAdmin(address buyer, address newAdmin) external;

    function applyAdmin(address buyer) external;

    function cancelAdmin(address buyer) external;

    // BySig variants: signed by the buyer's current admin (EIP-712 domain "AgentPay"/"0.2"),
    // nonce must equal adminNonces(buyer) and is incremented; block.timestamp <= deadline.
    function tightenBySig(address buyer, PolicyParams calldata policy, uint256 deadline, bytes calldata sig)
        external;
    function proposeLoosenBySig(address buyer, PolicyParams calldata policy, uint256 deadline, bytes calldata sig)
        external;
    function cancelLoosenBySig(address buyer, uint256 deadline, bytes calldata sig) external;
    function pauseBuyerBySig(address buyer, uint256 deadline, bytes calldata sig) external;
    function setSellerAllowedBySig(
        address buyer,
        uint256 agentId,
        bool allowed,
        uint256 deadline,
        bytes calldata sig
    ) external;
    function cancelSellerAllowedBySig(address buyer, uint256 agentId, uint256 deadline, bytes calldata sig)
        external;
    function proposeAdminBySig(address buyer, address newAdmin, uint256 deadline, bytes calldata sig) external;
    function cancelAdminBySig(address buyer, uint256 deadline, bytes calldata sig) external;

    // ───────────────────────── Protocol admin ─────────────────────────

    function addVerifier(address verifier, uint128 maxInFlight) external; // owner
    function revokeVerifier(address verifier) external; // owner or guardian, immediate
    function pauseSystem() external; // owner or guardian
    function unpauseSystem() external; // owner
    function setFees(uint128 sessionFee, uint16 feeBps) external; // owner, <= MAX_SESSION_FEE / MAX_FEE_BPS
    function setScorerSigner(address signer) external; // owner
    function setArbiter(address arbiter) external; // owner
    function setGuardian(address guardian) external; // owner
    function withdrawFees(address to) external; // owner

    // ────────────────────────────── Views ──────────────────────────────

    function getSession(uint256 sessionId) external view returns (Session memory);
    function computeNonce(OpenParams calldata params, bytes32 salt) external pure returns (bytes32);
    function computeSessionId(address buyer, bytes32 nonce) external pure returns (uint256);
    function requiredBond(uint256 sessionId, address challenger) external view returns (uint128);
    function availableDaily(address buyer) external view returns (uint128);

    function buyerPolicy(address buyer) external view returns (BuyerPolicy memory);
    function bucket(address buyer) external view returns (Bucket memory);
    function pendingLoosen(address buyer) external view returns (PendingLoosen memory);
    function pendingAdmin(address buyer) external view returns (PendingAdmin memory);
    function pendingSellerAllowed(address buyer, uint256 agentId) external view returns (uint64 effectiveAt);
    function sellerAllowed(address buyer, uint256 agentId) external view returns (bool);
    function adminNonces(address buyer) external view returns (uint256);

    function verifierInfo(address verifier) external view returns (VerifierInfo memory);
    function inFlightByVerifier(address verifier) external view returns (uint256);
    function withdrawable(address account) external view returns (uint256);
    function feesAccrued() external view returns (uint256);

    function sessionFee() external view returns (uint128);
    function feeBps() external view returns (uint16);
    function paused() external view returns (bool);
    function scorerSigner() external view returns (address);
    function arbiter() external view returns (address);
    function guardian() external view returns (address);
    function usdc() external view returns (address);
    function reputationRegistry() external view returns (address);
    function identityRegistry() external view returns (address);
    function domainSeparator() external view returns (bytes32);
    function scorerDomainSeparator() external view returns (bytes32);
}
