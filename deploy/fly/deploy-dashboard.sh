#!/usr/bin/env bash
# Build the Dashboard for the hosted Fuji services and deploy it to Fly.io (no secrets needed).
# Usage: bash deploy/fly/deploy-dashboard.sh [app]   default: agentpay-dashboard
set -euo pipefail
cd "$(dirname "$0")/../.."
FLY=${FLY:-flyctl}
command -v "$FLY" >/dev/null 2>&1 || FLY="$HOME/.fly/bin/flyctl"
APP=${1:-agentpay-dashboard}
VITE_RPC_URL=${VITE_RPC_URL:-https://avalanche-fuji-c-chain-rpc.publicnode.com} pnpm --filter @agentpay/dashboard build
STAGE=packages/agentpay-dashboard/dist-fly; rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -r packages/agentpay-dashboard/dist packages/agentpay-dashboard/server.mjs "$STAGE/"
cp deploy/fly/Dockerfile.dashboard "$STAGE/Dockerfile"
"$FLY" status -a "$APP" >/dev/null 2>&1 || "$FLY" apps create "$APP"
"$FLY" deploy "$STAGE" -a "$APP" -c "$PWD/deploy/fly/dashboard.toml" --ha=false --remote-only
rm -rf "$STAGE"
echo "Dashboard: https://$APP.fly.dev"
