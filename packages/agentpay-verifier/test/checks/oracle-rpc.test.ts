import { expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  fallback,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { createOracleReader } from "../../src/checks/oracle.js";
const feed = "0x0000000000000000000000000000000000000001" as const;
const check = {
  id: "oracle",
  type: "oracle-deviation" as const,
  field: "/price",
  maxDeviationBps: 200,
  oracle: { kind: "chainlink" as const, chainId: 43114, feed },
};
it("falls back to the second RPC and fails when neither RPC is available", async () => {
  let fallbackCalls = 0;
  const bad = custom(
    {
      request: async () => {
        throw new Error("offline");
      },
    },
    { retryCount: 0 },
  );
  const good = custom(
    {
      request: async ({ method, params }) => {
        fallbackCalls++;
        if (method === "eth_chainId") return "0xa86a";
        if (method === "eth_call") {
          const data = (params as [{ data: string }])[0].data;
          return data === "0x313ce567"
            ? encodeAbiParameters(parseAbiParameters("uint8"), [8])
            : encodeAbiParameters(
                parseAbiParameters("uint80,int256,uint256,uint256,uint80"),
                [20n, 2500000000n, 100n, 100n, 20n],
              );
        }
        throw new Error("Unexpected RPC");
      },
    },
    { retryCount: 0 },
  );
  const read = createOracleReader(
    createPublicClient({ transport: fallback([bad, good], { retryCount: 0 }) }),
  );
  expect(await read(check)).toMatchObject({
    answer: 2500000000n,
    decimals: 8,
    roundId: 20n,
  });
  expect(fallbackCalls).toBeGreaterThanOrEqual(3);
  await expect(
    createOracleReader(
      createPublicClient({
        transport: fallback([bad, bad], { retryCount: 0 }),
      }),
    )(check),
  ).rejects.toThrow();
});
