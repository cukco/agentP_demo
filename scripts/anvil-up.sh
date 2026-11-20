#!/usr/bin/env bash
# Starts anvil as a fork of Fuji (real USDC + ERC-8004) and deploys AgentPay into it.
# Writes deployments/local.json. Usage: scripts/anvil-up.sh   (Ctrl+C stops anvil)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$ROOT/.env"; set +a
export PATH="$HOME/.foundry/bin:$PATH"
PORT="${ANVIL_PORT:-8545}"

anvil --fork-url "$FUJI_RPC_URL_1" --port "$PORT" --chain-id 43113 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break
  sleep 0.5
done

cd "$ROOT/contracts"
DEPLOYMENT_NAME=local forge script script/DeployAgentPay.s.sol --rpc-url "http://127.0.0.1:$PORT" --broadcast --skip-simulation >/dev/null
echo "AgentPay deployed on anvil fork: $(cat "$ROOT/deployments/local.json")"
echo "RPC: http://127.0.0.1:$PORT  (Ctrl+C to stop)"
wait $ANVIL_PID
