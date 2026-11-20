import { describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "@agentpay/core";

describe("@agentpay/dashboard scaffold", () => {
  it("links @agentpay/core", () => {
    expect(DEPLOYMENTS.fuji.chainId).toBe(43113);
  });
});
