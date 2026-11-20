# E2E — D6/D7

Includes D's Scorer, QA fixes, and C's Buyer/Seller SDK + AVAX demo from
`c/avax-demo` (`f0588de`). These dependencies are integrated on this branch; merging
this PR also brings those commits into `build`. Review the C dependency before merging.

`startStack()` deploys Escrow/BuyerRules to Anvil (43113). Scorer, Facilitator and
available Verifier routes use real HTTP ports allocated by the OS. Keeper shares the
clock synchronized by `advance(seconds)`. `open()`, `write()`, `balances()`, `stop()`
are exposed. `chain.deployBlock` bounds service log scans, including on a Fuji fork.

```sh
pnpm install --frozen-lockfile
forge build --root contracts
pnpm --filter @agentpay/e2e... build
pnpm --filter @agentpay/e2e test:anvil
pnpm --filter @agentpay/e2e test:fork
```

Set `ANVIL_BIN` if Anvil is not in PATH. Only public Anvil development signing keys
are used in these tests. No transactions are sent to the upstream Fuji RPC.

## Local scenarios

| Scenario | Coverage |
|---|---|
| E1 | TODO: production Verifier, approve SDK, 15 PASS + 3 FAIL, settlement |
| E2 | HTTP Scorer/Facilitator → real contract rejection for cap/score; zero opens |
| E3 | Buyer + Seller SDK, 20 receipts, file checkpoint, stop Verifier HTTP server, restart Seller SDK, expiry close, Keeper settlement, exact balances |
| E4 | Keeper expiry refund, exact balances and no feedback |
| E5 | Buyer SDK rechecks a malicious signed PASS, closes, watcher challenges with bond/evidence, Arbiter upholds, exact payout and bond refund |
| E6 | Keeper expires stalled arbitration, returns cap + bond |
| E7 | Seller-signed equivocation, full refund and -100 feedback |
| E8 | Revoke blocks new sessions; old session refunds after expiry + grace |
| E9 | Empty close returns all cap with no fee/feedback |
| E10 | Pause blocks Facilitator opens; browser coverage is in `d/dashboard` |

E3/E5 use a **controlled test Verifier** (`test/sdk-fixture.ts`) to create a valid
checkpoint or deliberately lie about the result. Real Buyer/Seller SDKs, Scorer,
Facilitator, Keeper and Escrow are exercised. The test adversary is not an implementation
of B's missing production relay/checks/checkpoint routes. Nine passing scenarios do not
mean the full M4 integration gate is complete. E1 remains explicitly TODO.

C's separate demo rehearsal tests cover 15 PASS/3 FAIL with fixtures. They are useful
integration references, not evidence that E1 runs against the production Verifier.

## Fuji fork

`test:fork` loads only the public `FUJI_RPC_URL_1` and `BUYER_AUTO_ADDRESS` values from
root `.env`, unless already set in the process. `FORK_FUNDING_ADDRESS` overrides the
public funding address. The snapshot address needs at least 10 USDC. No wallet signing
key from `.env` is loaded by the runner.

The harness verifies upstream chain 43113, starts a local fork, uses actual Fuji USDC
and ERC-8004 contracts, impersonates the funding address **on that fork only**, transfers
10 test USDC to an Anvil account, registers a new seller with the real identity registry,
and deploys a fresh Escrow. It opens via HTTP Scorer/Facilitator and settles via Keeper.
Assertions cover exact balances, `FeedbackGiven.ok=true` and reputation summary count=1.
The fixture session fee is 0.04 USDC; the deployed team Fuji escrow uses 0.05 USDC.

This regression found that Keeper's default gas estimate could settle while silently
losing the registry feedback. The QA fix reserves a 1,000,000 gas limit for finalize.
The test fails without it. Unused gas is not charged.

The fork job can be requested with workflow_dispatch `fork=true` after the workflow
is available on the default branch. Default offline tests skip the fork; `test:fork`
fails on missing config/RPC rather than reporting a false pass.

## Real Fuji deployment

```sh
FUJI_RPC_URL_1=... VERIFIER_URL=... FACILITATOR_URL=... SCORER_URL=... \
  pnpm --filter @agentpay/e2e preflight:fuji
```

This only checks chain/contracts/service health.

### E1, E2, E4, E9 on real Fuji (D7)

`test/e2e-fuji/` runs against the public services on Fly.io (Seller agent 306, low-score
Seller agent 337, Verifier + Keeper, Facilitator, Scorer). It is skipped by `pnpm test`
and CI; run it on purpose because it spends test USDC (about 0,20 USDC per run) and AVAX gas:

```sh
set -a; . ./.env; set +a      # SELLER_URL, LOW_SCORE_SELLER_URL, VERIFIER_URL, FACILITATOR_URL, SCORER_URL,
                              # DEMO_FAULT_TOKEN, BUYER_AUTO_PRIVATE_KEY, FUJI/AVAX RPC URLs
pnpm --filter @agentpay/e2e... build
pnpm --filter @agentpay/e2e test:fuji
```

| Case | What is checked on chain |
|---|---|
| E1 | AVAX price seller: 15 PASS, fault switch +20% → 3 FAIL `ORACLE_DEVIATION`, Verifier closes, Keeper finalizes; `Settled` split and ERC-8004 feedback |
| E2 | 20 USDC session → `OverPerSession`; seller with score 0 → `BadScore` (Facilitator `/verify` only, no USDC moves) |
| E9 | Open 0,50 USDC then close before any request → `closeEmpty`, 100% refund, no fee or feedback |
| E4 | Open 0,50 USDC (expiry 5 min) and walk away → refunded with nobody acting (Verifier expiry sweep; Keeper refund if the Verifier is down) |

Preconditions: `buyer-auto` registered with `maxPerSession` below 20 USDC and `minScore` 30
(done on 2026-11-19, admin `buyer-main`), at least 3 test USDC. Approve mode needs a person
signing in MetaMask, so it stays covered by E1 on Anvil. Each case prints Snowtrace links.
