import { expect, it } from "vitest";
import { contractRevertReason } from "../src/errors.js";

it("preserves known revert names from another viem constructor/module instance", () => {
  class ForeignRevert extends Error {
    name = "ContractFunctionRevertedError";
    data = { errorName: "BuyerIsPaused" };
  }
  expect(contractRevertReason(new Error("outer", { cause: new ForeignRevert() }))).toBe("BuyerIsPaused");
});
it("does not expose arbitrary upstream data and terminates cyclic causes", () => {
  expect(contractRevertReason({ name: "ContractFunctionRevertedError", data: { errorName: "secret-rpc-message" } })).toBeUndefined();
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  expect(contractRevertReason(cycle)).toBeUndefined();
});
