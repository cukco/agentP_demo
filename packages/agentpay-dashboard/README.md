# Dashboard — D4/D5

```bash
pnpm install
pnpm --filter @agentpay/core build
pnpm --filter @agentpay/dashboard dev
```

Open http://127.0.0.1:5173. Reads Fuji deployment from `DEPLOYMENTS`; all writes require
an EIP-1193 wallet on chain 43113. The current account is checked again before each write.
Private keys are never read by the dashboard. Read-only inspection does not require a wallet.

For local Anvil, use chain ID 43113 and `deployments/local.json` with `escrow`, `usdc`,
and `deployBlock`, then start with `VITE_LOCAL=true`. `VITE_RPC_URL` overrides the RPC.
The local deployment is served only by Vite's dev middleware and is not bundled for production.

Development proxies `/api/verifier` to port 8787 and `/api/scorer` to port 8788. For a static
production build, configure `VITE_VERIFIER_URL` and `VITE_SCORER_URL` to HTTPS services that
allow the dashboard origin, or supply equivalent reverse proxies.

Rules: register, tighten immediately, propose/apply/cancel loosening, pause, propose/apply/cancel
admin, propose/apply/cancel seller allowlist. Pending changes show red alerts with cancellation.
History is fetched in 2000-block chunks with a 12-block reorg overlap. A rolling hour of
`BuyerSpend` above half the daily cap produces an alert.

Live: polls Verifier status and receipts every second, balances and on-chain timeline, and
Scorer every 10 seconds. Shows PASS/FAIL/INCONCLUSIVE using core enum values, distinct buyers,
reference versus real score, first-time seller warning and Fuji explorer links. Service errors
are shown with the last successful update time; no synthetic successful response is substituted.

```bash
pnpm --filter @agentpay/dashboard test
pnpm --filter @agentpay/dashboard build
# Requires forge-built contracts/out, Anvil, Chromium:
pnpm --filter @agentpay/dashboard exec playwright install chromium
pnpm --filter @agentpay/dashboard test:browser
```

Browser test deploys the real escrow on local Anvil with test token/registries and injects an
EIP-1193 provider backed by its unlocked test buyer. It registers, tightens, proposes, cancels,
pauses and checks the contract rejects further purchases. It does not exercise the MetaMask
extension itself. Live end-to-end verification awaits backend relay/receipts endpoints on `build`.
