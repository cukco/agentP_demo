# AgentPay contracts

Session escrow for x402 agent payments on Avalanche (SystemDesign §4–§5.1, `INTERFACE_FREEZE.md`). Based on PayCrow (MIT); the original PayCrow contracts are kept unchanged in `src/PayCrow*.sol`.

| Contract | Role |
|---|---|
| `src/AgentPaySessionEscrow.sol` | Sessions: open (EIP-3009), close with SessionVerdict, challenge, equivocation, finalize, refund; VerifierRegistry; fees; ERC-8004 feedback |
| `src/libraries/BuyerRules.sol` | Buyer spending rules (register, tighten, 24h loosen timelock, BySig). Linked library called via DELEGATECALL, split out to stay under EIP-170 |
| `src/interfaces/IAgentPaySessionEscrow.sol` | Frozen interface (structs, events, errors). ABI is generated into `packages/agentpay-core/src/abi.ts` |
| `src/libraries/AgentPayHashes.sol`, `AgentPayConstants.sol` | EIP-712 typehashes and constants, cross-checked with TypeScript by `test/AgentPayFreeze.t.sol` |

## Fuji deployment (2026-11-18)

| | Address |
|---|---|
| AgentPaySessionEscrow | `0xEbBE6E2cCE97a6C2Cb93563936b5846481C942ac` |
| BuyerRules (library) | `0x080E1b378d4e2DdCa9F3ED6aC94657b1A2dEaBE1` |
| USDC (Circle) | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| ERC-8004 Identity / Reputation | `0x8004A818…BD9e` / `0x8004B663…8713` |
| Demo seller agentId | `306` |

`sessionFee` = $0.05, `feeBps` = 50 (admin can change with `setFees`, capped at $0.10 / 1%; pinned per session).

## Tests

```bash
forge test                         # unit + fuzz + invariant (fork tests skip without RPC)
set -a; . ../.env; set +a; forge test --match-contract AgentPayForkTest   # real Fuji USDC + ERC-8004
FOUNDRY_PROFILE=ci forge test      # 10,000 fuzz runs
forge coverage --ir-minimum --report summary
```

| Suite | Tests | Covers |
|---|---|---|
| `AgentPayOpen.t.sol` | 50 | 9 open checks, nonce binding of every parameter, seller binding (attestation + ERC-8004 agentWallet), system pause |
| `AgentPayBuyerRules.t.sol` | 51 | Hard limits, token bucket, tighter/looser per field, 24h timelocks, BySig replay/expiry/signer, admin roles |
| `AgentPayClose.t.sol` | 46 | closeSession checks, seller checkpoint close, grace window, refund, fees, feedback, blacklist → withdrawable, closeEmpty |
| `AgentPayChallenge.t.sol` | 28 | Bond, challenge/resolve/expire, equivocation |
| `AgentPayFuzz.t.sol` | 5 | Split always sums to cap; bucket bound; reentrancy on finalize/refund/withdraw |
| `invariant/AgentPayInvariant.t.sol` | 3 invariants | Escrow balance = live caps + bonds + withdrawable + fees; no money created; inFlight consistent |
| `AgentPayFork.t.sol` | 5 | Real USDC domain "USD Coin"/"2", open, cancelAuthorization, real Identity binding, real Reputation feedback |
| `AgentPayFreeze.t.sol` | 5 | TS ↔ Solidity typehashes, nonce, sessionId, digests |

Coverage: `AgentPaySessionEscrow.sol` 99.4% lines, `BuyerRules.sol` 100% lines (CI gate ≥ 95%).

## Gas (real Fuji transactions, steady state)

| Call | Gas |
|---|---|
| `openWithAuthorization` | 302k |
| `closeSession` | 111k |
| `finalize` | 204k |
| Whole session | ≈ 617k ≈ 0.0046 AVAX at 7.5 gwei |

Session storage is packed (6 slots written at open); `cumulativeAmount` / `passedAmount` are derived from `lastSeq` / `passCount` × price. Breakdown and history: SystemDesign §9.3.

## Deploy

```bash
scripts/anvil-up.sh                                                     # anvil fork of Fuji + deploy → deployments/local.json
set -a; . ../.env; set +a
forge script script/DeployAgentPay.s.sol --rpc-url fuji --broadcast     # → deployments/fuji.json
```

Build note: `optimizer_runs = 1` keeps the escrow at 23.9 KB (limit 24 KB).

---

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
