import { DEPLOYMENTS } from "../packages/agentpay-core/dist/index.js";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { resolve, join } from "node:path";
// Parse dotenv as data; do not execute it as shell code or log its contents.
const config = {
  ...parseEnv(await readFile(resolve(process.argv[2] ?? ".env"), "utf8")),
  ...process.env,
};
config.AGENTPAY_ESCROW ??= DEPLOYMENTS.fuji.escrow;
if (
  config.AGENTPAY_ESCROW.toLowerCase() === DEPLOYMENTS.fuji.escrow.toLowerCase()
)
  config.AGENTPAY_ESCROW_START_BLOCK ??= String(DEPLOYMENTS.fuji.deployBlock);
const state = resolve(config.AGENTPAY_RUNTIME_DIR ?? ".agentpay-runtime");
await mkdir(state, { recursive: true, mode: 0o700 });
const baseNames = [
  "FUJI_RPC_URL_1",
  "FUJI_RPC_URL_2",
  "AGENTPAY_ESCROW",
  "AGENTPAY_ESCROW_START_BLOCK",
];
const services = [
  {
    name: "verifier",
    port: 8787,
    file: "index.js",
    required: [
      "VERIFIER_PRIVATE_KEY",
      "AVAX_MAINNET_RPC_URL_1",
      "AVAX_MAINNET_RPC_URL_2",
    ],
    optional: ["VERIFIER_ALLOW_PRIVATE_SELLERS"],
    extra: { VERIFIER_DB: join(state, "verifier.db") },
  },
  {
    name: "facilitator",
    port: 8786,
    file: "index.js",
    required: ["FACILITATOR_PRIVATE_KEY"],
    optional: [],
    extra: {},
  },
  {
    name: "scorer",
    port: 8788,
    file: "index.js",
    required: ["SCORER_PRIVATE_KEY"],
    optional: ["SELLER_AGENT_ID", "SELLER_ENDPOINT", "ATTACKER_ADDRESS"],
    extra: { SCORER_DB: join(state, "scorer.db") },
  },
  {
    name: "keeper",
    file: "main.js",
    required: ["KEEPER_PRIVATE_KEY"],
    optional: ["KEEPER_INTERVAL_MS"],
    extra: {
      KEEPER_STATE: join(state, "keeper-state.json"),
      KEEPER_FROM_BLOCK: config.AGENTPAY_ESCROW_START_BLOCK,
    },
  },
];
const missing = [
  ...new Set(
    [...baseNames, ...services.flatMap((s) => s.required)].filter(
      (key) => !config[key],
    ),
  ),
];
if (missing.length)
  throw new Error("Missing service configuration: " + missing.join(", "));
if (!config.VERIFIER_BODY_KEY) {
  const keyPath = join(state, "body-key");
  try {
    config.VERIFIER_BODY_KEY = (await readFile(keyPath, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await readFile(join(state, "verifier.db"));
      throw new Error(
        "Existing verifier.db requires its original VERIFIER_BODY_KEY",
      );
    } catch (dbError) {
      if (dbError.code !== "ENOENT") throw dbError;
    }
    config.VERIFIER_BODY_KEY = randomBytes(32).toString("hex");
    await writeFile(keyPath, config.VERIFIER_BODY_KEY, {
      mode: 0o600,
      flag: "wx",
    });
  }
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  timer.unref();
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
for (const service of services) {
  const env = Object.fromEntries(
    [...baseNames, ...service.required, ...service.optional]
      .filter((k) => config[k] !== undefined)
      .map((k) => [k, config[k]]),
  );
  Object.assign(env, {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    HOST: config.HOST ?? "127.0.0.1",
    ...service.extra,
  });
  if (service.port) env.PORT = String(service.port);
  if (service.name === "verifier")
    env.VERIFIER_BODY_KEY = config.VERIFIER_BODY_KEY;
  const child = spawn(
    process.execPath,
    [`packages/agentpay-${service.name}/dist/${service.file}`],
    { env, stdio: "inherit" },
  );
  children.push(child);
  child.once("error", () => {
    console.error(
      JSON.stringify({ event: "service_start_failed", service: service.name }),
    );
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(
        JSON.stringify({
          event: "service_stopped",
          service: service.name,
          code,
        }),
      );
      stop(code || 1);
    }
  });
}
console.log(
  JSON.stringify({
    event: "stack_started",
    verifier: "http://127.0.0.1:8787",
    facilitator: "http://127.0.0.1:8786",
    scorer: "http://127.0.0.1:8788",
  }),
);
