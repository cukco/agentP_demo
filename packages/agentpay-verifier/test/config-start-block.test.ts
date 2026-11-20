import { describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "@agentpay/core";
import { loadConfig } from "../src/config.js";

const base = {
  VERIFIER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  FUJI_RPC_URL_1: "https://fuji.example",
  FUJI_RPC_URL_2: "https://fuji-backup.example",
  AVAX_MAINNET_RPC_URL_1: "https://mainnet.example",
  AVAX_MAINNET_RPC_URL_2: "https://mainnet-backup.example",
  VERIFIER_BODY_KEY: "ff".repeat(32),
};

describe("Verifier start block", () => {
  it("defaults to the Fuji deployment block for the deployed escrow (no missed sessions on first run)", () => {
    const cfg = loadConfig({ ...base, AGENTPAY_ESCROW: DEPLOYMENTS.fuji.escrow.toLowerCase() });
    expect(cfg.startBlock).toBe(DEPLOYMENTS.fuji.deployBlock);
  });

  it("explicit AGENTPAY_ESCROW_START_BLOCK wins", () => {
    const cfg = loadConfig({ ...base, AGENTPAY_ESCROW: DEPLOYMENTS.fuji.escrow, AGENTPAY_ESCROW_START_BLOCK: "123" });
    expect(cfg.startBlock).toBe(123n);
  });

  it("unknown escrow keeps the old behaviour (start at chain tip)", () => {
    const cfg = loadConfig({ ...base, AGENTPAY_ESCROW: `0x${"ab".repeat(20)}` });
    expect(cfg.startBlock).toBeUndefined();
  });

  it("oracle RPC timeout defaults to 180 ms, is configurable and stays inside the 500 ms check budget", () => {
    const escrow = DEPLOYMENTS.fuji.escrow;
    expect(loadConfig({ ...base, AGENTPAY_ESCROW: escrow }).oracleTimeoutMs).toBe(180);
    expect(loadConfig({ ...base, AGENTPAY_ESCROW: escrow, VERIFIER_ORACLE_RPC_TIMEOUT_MS: "400" }).oracleTimeoutMs).toBe(400);
    expect(() => loadConfig({ ...base, AGENTPAY_ESCROW: escrow, VERIFIER_ORACLE_RPC_TIMEOUT_MS: "600" })).toThrow("VERIFIER_ORACLE_RPC_TIMEOUT_MS");
  });
});
