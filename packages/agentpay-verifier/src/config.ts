import { DEPLOYMENTS } from "@agentpay/core";
import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Expected HTTP(S) URL");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const configSchema = z.object({
  VERIFIER_PRIVATE_KEY: bytes32,
  FUJI_RPC_URL_1: httpUrl,
  FUJI_RPC_URL_2: httpUrl,
  AVAX_MAINNET_RPC_URL_1: httpUrl,
  AVAX_MAINNET_RPC_URL_2: httpUrl,
  AGENTPAY_ESCROW: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .refine((value) => !/^0x0{40}$/.test(value)),
  AGENTPAY_ESCROW_START_BLOCK: z.string().regex(/^\d+$/).optional(),
  VERIFIER_BODY_KEY: z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$/),
  VERIFIER_ALLOW_PRIVATE_SELLERS: z.enum(["true", "false"]).default("false"),
  VERIFIER_DB: z.string().min(1).default("./verifier.db"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // Per-RPC timeout for Chainlink reads; must leave room inside the 500 ms check budget.
  VERIFIER_ORACLE_RPC_TIMEOUT_MS: z.coerce.number().int().min(50).max(450).default(180),
});

export function loadConfig(env: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      "Missing or invalid Verifier configuration: " +
        parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
    );
  }
  const data = parsed.data;
  return {
    allowPrivate: data.VERIFIER_ALLOW_PRIVATE_SELLERS === "true",
    privateKey: data.VERIFIER_PRIVATE_KEY as `0x${string}`,
    fuji: [data.FUJI_RPC_URL_1, data.FUJI_RPC_URL_2] as const,
    mainnet: [
      data.AVAX_MAINNET_RPC_URL_1,
      data.AVAX_MAINNET_RPC_URL_2,
    ] as const,
    escrow: data.AGENTPAY_ESCROW as `0x${string}`,
    startBlock:
      data.AGENTPAY_ESCROW_START_BLOCK !== undefined
        ? BigInt(data.AGENTPAY_ESCROW_START_BLOCK)
        : defaultStartBlock(data.AGENTPAY_ESCROW),
    bodyKey: Buffer.from(data.VERIFIER_BODY_KEY.replace(/^0x/, ""), "hex"),
    databasePath: data.VERIFIER_DB,
    port: data.PORT,
    host: data.HOST,
    oracleTimeoutMs: data.VERIFIER_ORACLE_RPC_TIMEOUT_MS,
  };
}

/**
 * Without an explicit start block, index from the known Fuji deployment block so sessions opened before the
 * Verifier's first run are not skipped. Unknown escrow addresses fall back to the chain tip (sync.ts).
 */
export function defaultStartBlock(escrow: string): bigint | undefined {
  const fuji = DEPLOYMENTS.fuji;
  return escrow.toLowerCase() === fuji.escrow.toLowerCase()
    ? fuji.deployBlock
    : undefined;
}
