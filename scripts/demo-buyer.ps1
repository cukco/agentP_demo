# Demo video: Buyer CLI (scenes 3-7) against the hosted Fly services. Keep this terminal private:
# it prints a one-time approval link.
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/demo-buyer.ps1              # real take: buyer-main, approve, 18 calls + policy scene
#   powershell -ExecutionPolicy Bypass -File scripts/demo-buyer.ps1 -Rehearsal   # same flow with the rehearsal MetaMask wallet
#   powershell -ExecutionPolicy Bypass -File scripts/demo-buyer.ps1 -Mode auto   # no MetaMask (buyer-auto)
#   ... -Scenario injection   (scene 7 only)    ... -Scenario paid   (scenes 3-6 only)    ... -Build   (rebuild first)
param(
  [ValidateSet("approve", "auto")] [string]$Mode = "approve",
  [ValidateSet("all", "paid", "injection")] [string]$Scenario = "all",
  [switch]$Rehearsal,
  [switch]$Build
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
function Read-DotEnv([string]$name) {
  $line = Get-Content .env | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if (-not $line) { throw "Missing $name in .env" }
  return $line.Substring($name.Length + 1).Trim()
}
# Values set here win over .env (node --env-file never overrides existing variables).
$env:FUJI_RPC_URL_1 = "https://avalanche-fuji-c-chain-rpc.publicnode.com"
if ($Rehearsal) {
  $env:BUYER_MAIN_ADDRESS = Read-DotEnv "REHEARSAL_ADDRESS"
  Write-Host "Rehearsal: MetaMask must use $($env:BUYER_MAIN_ADDRESS) (import REHEARSAL_PRIVATE_KEY from .env)."
} elseif ($Mode -eq "approve") {
  Write-Host "Real take: MetaMask must use buyer-main $(Read-DotEnv 'BUYER_MAIN_ADDRESS')."
}
if ($Build -or -not (Test-Path demo/buyer-agent/dist/index.js)) {
  pnpm --filter "@agentpay-demo/buyer-agent..." build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$checkBuyer = if ($Mode -eq "auto") { Read-DotEnv "BUYER_AUTO_ADDRESS" } elseif ($Rehearsal) { $env:BUYER_MAIN_ADDRESS } else { Read-DotEnv "BUYER_MAIN_ADDRESS" }
$checkArgs = @("--buyer", $checkBuyer)
if ($Scenario -eq "injection") { $checkArgs += "--skip-daily" }   # scene 7 never uses the daily allowance
pnpm --filter @agentpay/e2e demo:check -- @checkArgs
if ($LASTEXITCODE -ne 0) { Write-Host "Pre-flight failed; fix the red lines above before recording."; exit 1 }
pnpm --filter @agentpay-demo/buyer-agent start -- --mode $Mode --calls 18 --scenario $Scenario
