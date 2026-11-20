import { describe, expect, it } from "vitest";
import { AGENTPAY_VERSION } from "@agentpay/core";
import { COMPONENT } from "../src/index.js";

describe("@agentpay/buyer scaffold", () => {
  it("links @agentpay/core", () => {
    expect(AGENTPAY_VERSION).toBe("0.2");
    expect(COMPONENT).toBe("@agentpay/buyer");
  });
});
