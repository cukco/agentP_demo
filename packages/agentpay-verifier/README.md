# Verifier

Requires Node >=22.13 (SQLite). Build before running tests so the isolated check
worker is available: `pnpm --filter @agentpay/core build && pnpm --filter @agentpay/verifier build`.

## Shared checks (`@agentpay/verifier/checks`)

`createCheckRunner({ oracle })` accepts `{spec, body, contentType, receivedAt}` and
returns `{outcome, reasonCode, evidenceHash, oracle}`. All six frozen check types
are supported. Use the receipt's saved `receivedAt` and saved oracle snapshots as
the runner's second argument when replaying evidence; replay never reads live
oracle values. `createOracleReader(client)` accepts a viem client with fallback
transports; configure transport timeouts/retries within the 500 ms check budget
(`VERIFIER_ORACLE_RPC_TIMEOUT_MS`, default 180; use ~400 when mainnet RPC round trips are ~200 ms, e.g. Fly `sin`).

Each request gets a worker with a 64 MiB heap, a 500 ms check deadline and a 2 s
whole-request deadline (including worker startup), with at most four workers.
Timeout/crash/overload yields INCONCLUSIVE/21. Oracle errors yield
INCONCLUSIVE/20. Raw bytes are hashed before any JSON conversion. Prices use
bigint fixed-point arithmetic at eight decimals. Schemas are AJV 2020 strict;
patterns use RE2/WASM instead of native JavaScript regex. This preserves linear
regex execution without native compilation. Unsupported RE2 expressions fail
closed as INCONCLUSIVE rather than running an unsafe fallback.

References: [AJV options](https://ajv.js.org/options),
[RE2/WASM syntax restrictions](https://github.com/google/re2-wasm).

## Relay and closer

The executable wires `createRuntime` into the frozen `/v1/sessions/:id` APIs.
Vouchers are authenticated before discovery or delivery. The spec is cached only
after matching on-chain terms. Seller fetches pin validated public DNS addresses,
disable redirects, bound streamed bodies and have a delivery deadline. For a
local demo only, `VERIFIER_ALLOW_PRIVATE_SELLERS=true` permits loopback/private
sellers; leave it false on public servers.

Receipts and aggregate counters commit in one SQLite transaction. Per-session
serialization prevents duplicate sequence consumption. After a crash, a saved
voucher without a committed receipt becomes INCONCLUSIVE/21 and is never replayed
to the seller. Checkpoints, final verdicts, pending transaction hashes and all
valid conflicting deliveries survive restarts. Closing retries use the pending
hash before submitting another transaction. Run one Verifier process per SQLite
volume; process-local locks are not a distributed coordination mechanism.

FAIL and INCONCLUSIVE receipts have amount zero; only PASS has the request price,
as required by the frozen Buyer SDK. Every 20 requests emits a signed checkpoint.
Three consecutive FAILs, exhausted cap, a signed close request or the expiry sweep
close the session. Equivocation evidence is submitted before ordinary settlement.
Logs contain identifiers, outcomes and timing only, never raw bodies, keys or
request headers. Oracle outages fail closed as INCONCLUSIVE.

The build bundles the worker's JavaScript imports into `worker.cjs` while keeping
RE2's WASM package external. This reduces cold worker startup without reusing
workers or weakening request isolation/deadlines. Run the full build, not `tsc`
alone, before starting the service. Container CI executes a real AJV/RE2 check.
