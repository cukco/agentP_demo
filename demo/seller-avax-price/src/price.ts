import {
  CHAIN_ID, CHAINLINK_AVAX_USD_MAINNET, Outcome, ReasonCode, VERIFIER_LIMITS, specHash,
  type VerificationSpec,
} from "@agentpay/core";
import { formatUnits, parseAbi, type PublicClient } from "viem";

export const PRICE_PATH = "/v1/price/AVAX";
export const FAULT_PATH = "/admin/fault";
export const PRICE_PER_REQUEST = 10_000n;
const PRICE_AGE_SEC = 60;
const DEVIATION_BPS = 200;
const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

export interface Quote { answer: bigint; decimals: number; updatedAt: bigint }
export type ReadQuote = () => Promise<Quote>;

export function createPriceReader(client: Pick<PublicClient, "readContract">): ReadQuote {
  const address = CHAINLINK_AVAX_USD_MAINNET;
  let decimals: Promise<number> | undefined;
  return async () => {
    decimals ??= client.readContract({ address, abi, functionName: "decimals" }).catch(error => {
      decimals = undefined;
      throw error;
    });
    const [[roundId, answer, , updatedAt, answeredInRound], scale] = await Promise.all([
      client.readContract({ address, abi, functionName: "latestRoundData" }), decimals,
    ]);
    if (answeredInRound < roundId) throw new Error("Incomplete Chainlink round");
    return { answer, decimals: scale, updatedAt };
  };
}

export function quotePrice(quote: Quote, clock: number, fault = false): number {
  const age = BigInt(clock) - quote.updatedAt;
  if (quote.answer <= 0n || quote.updatedAt <= 0n || age < -BigInt(VERIFIER_LIMITS.FUTURE_TOLERANCE_SEC) ||
      age > BigInt(VERIFIER_LIMITS.DEFAULT_MAX_ORACLE_AGE_SEC) || !Number.isInteger(quote.decimals) ||
      quote.decimals < 0 || quote.decimals > 36) throw new Error("Chainlink quote unavailable");
  const price = Number(formatUnits(fault ? quote.answer * 120n : quote.answer, quote.decimals + (fault ? 2 : 0)));
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid Chainlink price");
  return price;
}

export function priceSpec(verifier: VerificationSpec["verifier"]): VerificationSpec {
  return {
    specVersion: "agentpay-verify/0.2", serviceType: "price-feed", verifier,
    delivery: { contentType: "application/json", maxBytes: 65_536 }, passRule: "all",
    checks: [
      { id: "schema", type: "json-schema", schema: {
        type: "object", required: ["symbol", "price", "timestamp"], properties: {
          symbol: { type: "string" }, price: { type: "number", exclusiveMinimum: 0 }, timestamp: { type: "integer" },
        },
      } },
      { id: "symbol", type: "equals", field: "/symbol", value: "AVAX" },
      { id: "fresh", type: "freshness", field: "/timestamp", unit: "unix-s", maxAgeSec: PRICE_AGE_SEC },
      { id: "oracle", type: "oracle-deviation", field: "/price",
        oracle: { kind: "chainlink", chainId: CHAIN_ID.avalanche, feed: CHAINLINK_AVAX_USD_MAINNET },
        maxDeviationBps: DEVIATION_BPS,
      },
    ],
  };
}

export interface PriceResponse { symbol: string; price: number; timestamp: number }

export async function checkPrice(input: { body: Uint8Array; contentType: string; receivedAt: bigint }, read: ReadQuote, clock: () => number) {
  const { body, contentType, receivedAt } = input;
  if (body.length > 65_536) return { outcome: Outcome.FAIL, reasonCode: ReasonCode.TOO_LARGE };
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return { outcome: Outcome.FAIL, reasonCode: ReasonCode.BAD_CONTENT };
  }
  let data: PriceResponse;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { outcome: Outcome.FAIL, reasonCode: ReasonCode.BAD_CONTENT };
  }
  if (!data || typeof data.symbol !== "string" || !Number.isFinite(data.price) || data.price <= 0 || !Number.isSafeInteger(data.timestamp)) {
    return { outcome: Outcome.FAIL, reasonCode: ReasonCode.CHECK_JSON_SCHEMA };
  }
  if (data.symbol !== "AVAX") return { outcome: Outcome.FAIL, reasonCode: ReasonCode.CHECK_EQUALS };
  const age = receivedAt - BigInt(data.timestamp);
  if (age > BigInt(PRICE_AGE_SEC) || age < -BigInt(VERIFIER_LIMITS.FUTURE_TOLERANCE_SEC)) {
    return { outcome: Outcome.FAIL, reasonCode: ReasonCode.CHECK_FRESHNESS };
  }
  let reference: number;
  try {
    reference = quotePrice(await read(), clock());
  } catch {
    return { outcome: Outcome.INCONCLUSIVE, reasonCode: ReasonCode.ORACLE_UNAVAILABLE };
  }
  const deviation = Math.abs(data.price - reference) * 10_000 / reference;
  return deviation > DEVIATION_BPS + 1e-9
    ? { outcome: Outcome.FAIL, reasonCode: ReasonCode.CHECK_ORACLE_DEVIATION, reference }
    : { outcome: Outcome.PASS, reasonCode: ReasonCode.PASS, reference };
}

export function createPriceChecks(verifier: VerificationSpec["verifier"], read: ReadQuote, clock: () => number,
  onReference?: (reference: number | undefined) => void) {
  const expected = specHash(priceSpec(verifier));
  return {
    supportsSpec: (spec: VerificationSpec) => specHash(spec) === expected,
    checks: async (input: Parameters<typeof checkPrice>[0]) => {
      const result = await checkPrice(input, read, clock);
      onReference?.(result.reference);
      return result.outcome;
    },
  };
}
