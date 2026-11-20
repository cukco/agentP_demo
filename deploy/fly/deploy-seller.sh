#!/usr/bin/env bash
# Deploy the demo AVAX seller (demo/seller-avax-price) to Fly.io. Needs a tree that contains c/sdk-lead.
# Usage: bash deploy/fly/deploy-seller.sh [path/to/.env] [prefix]   defaults: ./.env, agentpay
set -euo pipefail
cd "$(dirname "$0")/../.."
FLY=${FLY:-flyctl}
command -v "$FLY" >/dev/null 2>&1 || FLY="$HOME/.fly/bin/flyctl"
ENV_FILE=${1:-.env}
APP="${2:-agentpay}-seller"
REGION=${FLY_REGION:-sin}
set -a; . "$ENV_FILE"; set +a
# The demo seller uses a single Fuji RPC (no fallback): prefer the backup (publicnode), which rate-limits less.
FUJI_RPC_URL_1=${FUJI_RPC_URL_2:-$FUJI_RPC_URL_1}
"$FLY" status -a "$APP" >/dev/null 2>&1 || "$FLY" apps create "$APP"
for name in SELLER_PRIVATE_KEY SELLER_AGENT_ID DEMO_FAULT_TOKEN AGENTPAY_ESCROW VERIFIER_ADDRESS FUJI_RPC_URL_1 AVAX_MAINNET_RPC_URL_1; do
  [ -n "${!name:-}" ] || { echo "Missing $name in $ENV_FILE"; exit 1; }
  printf '%s=%s\n' "$name" "${!name}"
done | "$FLY" secrets import -a "$APP" --stage >/dev/null
"$FLY" deploy . -a "$APP" -c deploy/fly/seller.toml --dockerfile deploy/fly/Dockerfile.seller \
  --primary-region "$REGION" --ha=false --remote-only
echo "Seller health: $(curl -s "https://$APP.fly.dev/health")"
echo "SELLER_URL=https://$APP.fly.dev/v1/price/AVAX"
