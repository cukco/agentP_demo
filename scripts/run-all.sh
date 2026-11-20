#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  pnpm --filter @agentpay/verifier... --filter @agentpay/facilitator... --filter @agentpay/scorer... --filter @agentpay/keeper... build
fi
exec node scripts/run-services.mjs "${1:-.env}"
