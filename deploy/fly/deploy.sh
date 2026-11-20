#!/usr/bin/env bash
# B8 on Fly.io (region Singapore by default), using the B backend images (deploy/fly/Dockerfile):
#   <prefix>-verifier     Verifier 8787 (volume /data) + Keeper process
#   <prefix>-facilitator  Facilitator 8786
#   <prefix>-scorer       Scorer 8788 (volume /data)
# Secrets come from an env file and are piped to `fly secrets import` (never on the command line or in the image).
#
# Usage: bash deploy/fly/deploy.sh [path/to/.env] [prefix]   defaults: ./.env, agentpay
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep /data paths as written
FLY=${FLY:-flyctl}
command -v "$FLY" >/dev/null 2>&1 || FLY="$HOME/.fly/bin/flyctl"
ENV_FILE=${1:-.env}
PREFIX=${2:-agentpay}
REGION=${FLY_REGION:-sin}

set -a; . "$ENV_FILE"; set +a
"$FLY" auth whoami >/dev/null || { echo "Run: flyctl auth login"; exit 1; }

secrets() {
  local app=$1; shift
  for name in "$@"; do
    local optional=0
    [[ $name == \?* ]] && { optional=1; name=${name#\?}; }
    if [ -z "${!name:-}" ]; then
      [ $optional = 1 ] && continue
      echo "Missing $name in $ENV_FILE"; exit 1
    fi
    printf '%s=%s\n' "$name" "${!name}"
  done | "$FLY" secrets import -a "$app" --stage >/dev/null
  echo "secrets staged for $app"
}
volume() {
  "$FLY" volumes list -a "$1" 2>/dev/null | grep -q "$2" ||
    "$FLY" volumes create "$2" -a "$1" --region "$REGION" --size 1 --yes
}
deploy() {
  "$FLY" status -a "$1" >/dev/null 2>&1 || "$FLY" apps create "$1"
}

RPC=(AGENTPAY_ESCROW FUJI_RPC_URL_1 FUJI_RPC_URL_2 ?AGENTPAY_ESCROW_START_BLOCK)
for service in verifier facilitator scorer; do deploy "$PREFIX-$service"; done
secrets "$PREFIX-verifier" "${RPC[@]}" VERIFIER_PRIVATE_KEY VERIFIER_BODY_KEY KEEPER_PRIVATE_KEY AVAX_MAINNET_RPC_URL_1 AVAX_MAINNET_RPC_URL_2
secrets "$PREFIX-facilitator" "${RPC[@]}" FACILITATOR_PRIVATE_KEY
secrets "$PREFIX-scorer" "${RPC[@]}" SCORER_PRIVATE_KEY ?SELLER_AGENT_ID ?SELLER_ENDPOINT ?ATTACKER_ADDRESS
volume "$PREFIX-verifier" verifier_data
volume "$PREFIX-scorer" scorer_data

for service in verifier facilitator scorer; do
  "$FLY" deploy . -a "$PREFIX-$service" -c "deploy/fly/$service.toml" --dockerfile deploy/fly/Dockerfile \
    --primary-region "$REGION" --ha=false --remote-only
done

VERIFIER_URL="https://$PREFIX-verifier.fly.dev/v1"
FACILITATOR_URL="https://$PREFIX-facilitator.fly.dev"
SCORER_URL="https://$PREFIX-scorer.fly.dev"
echo
echo "Verifier:    $(curl -s "$VERIFIER_URL/health")"
echo "Facilitator: $(curl -s "$FACILITATOR_URL/supported")"
echo "Scorer:      $(curl -s "$SCORER_URL/v1/health")"
echo
echo "VERIFIER_URL=$VERIFIER_URL"
echo "FACILITATOR_URL=$FACILITATOR_URL"
echo "SCORER_URL=$SCORER_URL"
