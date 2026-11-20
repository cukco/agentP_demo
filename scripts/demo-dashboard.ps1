# Demo video: Dashboard against the hosted Fly services. Open http://127.0.0.1:5173 afterwards.
# Usage (repo root):  powershell -ExecutionPolicy Bypass -File scripts/demo-dashboard.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
# The Verifier sends no CORS headers, so the Vite dev proxy forwards /api/* to Fly.
$env:DASHBOARD_VERIFIER_TARGET = "https://agentpay-verifier.fly.dev"
$env:DASHBOARD_SCORER_TARGET = "https://agentpay-scorer.fly.dev"
# api.avax-test.network rate-limits busy IPs; publicnode is steadier for the browser reads.
$env:VITE_RPC_URL = "https://avalanche-fuji-c-chain-rpc.publicnode.com"
pnpm --filter @agentpay/core build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm --filter @agentpay/dashboard dev
