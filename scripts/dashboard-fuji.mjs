// `pnpm agentpay:dashboard`: run the Dashboard against the hosted Fuji services (any OS), then open http://127.0.0.1:5173.
import { spawn } from "node:child_process";
const env = {
  ...process.env,
  DASHBOARD_VERIFIER_TARGET: process.env.DASHBOARD_VERIFIER_TARGET ?? "https://agentpay-verifier.fly.dev",
  DASHBOARD_SCORER_TARGET: process.env.DASHBOARD_SCORER_TARGET ?? "https://agentpay-scorer.fly.dev",
  VITE_RPC_URL: process.env.VITE_RPC_URL ?? "https://avalanche-fuji-c-chain-rpc.publicnode.com",
};
const child = spawn("pnpm --filter @agentpay/dashboard dev", { env, stdio: "inherit", shell: true });
child.on("exit", code => process.exit(code ?? 0));
