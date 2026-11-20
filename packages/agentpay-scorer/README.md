# AgentPay Scorer

Node >= 22.13, pnpm 10.30.3. `createApp(deps)` returns Hono without opening a port.
All timestamps use an injected Unix-seconds clock; chain and HTTP clients are injected.

```bash
pnpm --filter @agentpay/core build
SCORER_PRIVATE_KEY=... FUJI_RPC_URL_1=... pnpm --filter @agentpay/scorer dev
```

Environment: `PORT` (8788), `HOST` (127.0.0.1), `SCORER_DB` (`./scorer.db`),
`AGENTPAY_ESCROW`, `AGENTPAY_ESCROW_START_BLOCK` (required for custom escrow),
`SELLER_AGENT_ID` + `SELLER_ENDPOINT` (operator-configured probe), `ATTACKER_ADDRESS`
(optional demo-only addition to the blocklist). Never put keys in browser configuration.

- `GET /v1/score/:agentId`: frozen `ScoreResponse`.
- `GET /v1/attestation/:agentId?wallet=0x...`: frozen attestation; mismatch → 409,
  chain verification failure → 503, invalid input → 400. EIP-712 TTL is 3000 seconds.
- `POST /v1/sellers/:agentId/wallet-proof`: frozen `WalletProofRequest`; `issuedAt`
  is an ISO-8601 timestamp. Sign the exact core `walletProofMessage` with the mainnet wallet.
  When that wallet differs from the registered `agentWallet`, also send
  `X-AgentPay-Wallet-Authorization`, signed by the **current registered payment wallet**.
  Missing/wrong authorization returns 403; identity rotation during the request returns 409.
- `GET /v1/health`: process/config health; scoring requests independently verify the chain.

Reference score:

```
min(40, 10*log10(1 + incomingUSDCTransactions)
        + 10*log10(1 + totalUSD/100)
        + min(10, ageInMonths) + (valid402Probe ? 5 : 0))
```

Scorer queries wallets that completed wallet proof. Routescan covers Avalanche mainnet
(43114). Set the optional `ALCHEMY_BASE_URL` to the credential-bearing Alchemy Base
mainnet (8453) endpoint, such as `https://base-mainnet.g.alchemy.com/v2/<api-key>`.
Store this URL as a service secret.

Scorer adds incoming USDC amounts and transfer counts across chains for each wallet,
counts distinct senders across both chains, and measures age from the earliest qualifying
receipt. It uses the strongest proven wallet's score and caps the reference score at 40,
including any probe bonus. Outgoing, self, failed, zero-value and duplicate transfers
are excluded. A missing Base URL or an incomplete Base history leaves the Avalanche
history available for scoring. Each source reads at most ten pages per wallet. Complete
histories are cached for one hour and unavailable histories for 60 seconds.
See the [Alchemy Transfers API](https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers).

Real score reads escrow events and terminal session state at a fixed block, cross-checks
successful feedback count against ERC-8004 `getSummary(agentId,[escrow],"agentpay","")`,
and refuses to sign incomplete history. Sessions below 100000 USDC base units are excluded,
as are seller/proven-wallet buyers. Session feedback includes fail-heavy penalties and is
clamped to 0–100. Each buyer's sessions are weighted by `min(10, log1p(passedAmount/100000))`,
then all buyers receive equal weight. Final score is
`round((5*reference + distinctBuyers*real)/(5+distinctBuyers))` (prior k = 5, `REFERENCE_PRIOR`).

Flags: bit 0 = reference only, bit 1 = blocklisted payment or proven wallet. Blocklisted
attestations are signed so escrow can reject them with `SellerFlagged`.

The checked-in snapshot comes from [OFAC SDN XML](https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml).
It records retrieval time and source SHA-256. Refresh using
`python3 packages/agentpay-scorer/scripts/update-blocklist.py`. The demo attacker is configured
separately and is never presented as an OFAC-listed address.

```bash
cd contracts && forge build
cd ..
pnpm --filter @agentpay/scorer build
pnpm --filter @agentpay/scorer test
```

Integration test requires Anvil (`ANVIL_BIN` may override its location). It deploys the real
escrow with test registries/token, opens using the HTTP attestation, checks finalized score,
and verifies expiry on chain. This is local Anvil coverage, not evidence of a Fuji run.

## Authorization for linking another wallet (QA-03)

The JSON body and core EIP-712 schemas remain unchanged. Linking a different mainnet
wallet now requires a second `personal_sign` in the HTTP header above. The exported
`walletLinkAuthorizationMessage(agentId, proof, chainId, escrow, agentWallet)` builds
its exact text. It binds the consent to the agent ID, target wallet, timestamp, current
payment wallet, chain and escrow. Both signatures must refer to the same fresh proof.
A plain mainnet signature is insufficient to modify another agent's reference history.

```ts
import { walletLinkAuthorizationMessage } from "@agentpay/scorer";
const authorization = await registeredPaymentWallet.signMessage({
  message: walletLinkAuthorizationMessage(agentId, proof, chainId, escrow, agentWallet),
});
await fetch(`${scorerUrl}/v1/sellers/${agentId}/wallet-proof`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AgentPay-Wallet-Authorization": authorization },
  body: JSON.stringify(proof),
});
```

A proof for `mainnetWallet === agentWallet` already proves control of the payment wallet
and does not need the header. Consent is bound to the registered **payment wallet**,
not an independently authenticated NFT-owner HTTP session. Identity rotation invalidates
links. Legacy database links without `proofVersion: 1` are cleared before scoring and
must be proved again. CORS allows the additional header.

This intentionally tightens authorization for cross-wallet linking: existing clients
that only supply a mainnet proof must add the header. A/C should review that integration
requirement before public rollout. No frozen core request fields or contract ABI changed.
The service currently rescans chunked history per request; an incremental index is needed
for large deployments.
