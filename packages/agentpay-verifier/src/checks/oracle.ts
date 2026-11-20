import { evidenceHash, ReasonCode } from "@agentpay/core";
import { isAddressEqual, parseAbi, type PublicClient } from "viem";
import { pointer } from "./pointer.js";
import {
  result,
  unavailable,
  type OracleCheck,
  type OracleReader,
  type OracleSnapshot,
} from "./types.js";
const abi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);
export function createOracleReader(
  client: Pick<PublicClient, "readContract" | "getChainId">,
): OracleReader {
  return async (check) => {
    if ((await client.getChainId()) !== check.oracle.chainId)
      throw new Error("Oracle chain mismatch");
    const [decimals, round] = await Promise.all([
      client.readContract({
        address: check.oracle.feed,
        abi,
        functionName: "decimals",
      }),
      client.readContract({
        address: check.oracle.feed,
        abi,
        functionName: "latestRoundData",
      }),
    ]);
    return {
      chainId: check.oracle.chainId,
      feed: check.oracle.feed,
      decimals,
      roundId: round[0],
      answer: round[1],
      updatedAt: round[3],
      answeredInRound: round[4],
    };
  };
}
/** Converts a finite JSON number to a fixed 8 decimal bigint, truncating sub-unit digits. */
export function fixed8(value: unknown): bigint | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  const [mantissa, exp = "0"] = String(value).toLowerCase().split("e");
  const [whole, frac = ""] = mantissa.split(".");
  const digits = BigInt(whole + frac),
    power = 8 + Number(exp) - frac.length;
  return power >= 0
    ? digits * 10n ** BigInt(power)
    : digits / 10n ** BigInt(-power);
}
export function oracle(
  body: unknown,
  check: OracleCheck,
  receivedAt: bigint,
  snapshot: OracleSnapshot,
) {
  const s = snapshot;
  if (
    s.chainId !== check.oracle.chainId ||
    !isAddressEqual(s.feed, check.oracle.feed) ||
    s.decimals < 0 ||
    s.decimals > 36 ||
    !Number.isInteger(s.decimals) ||
    s.answer <= 0n ||
    s.roundId <= 0n ||
    s.answeredInRound < s.roundId ||
    s.updatedAt <= 0n ||
    s.updatedAt > receivedAt + 5n ||
    receivedAt - s.updatedAt > BigInt(check.maxOracleAgeSec ?? 3600)
  )
    return unavailable(ReasonCode.ORACLE_UNAVAILABLE);
  const price = fixed8(pointer(body, check.field));
  const reference =
    s.decimals <= 8
      ? s.answer * 10n ** BigInt(8 - s.decimals)
      : s.answer / 10n ** BigInt(s.decimals - 8);
  if (reference <= 0n) return unavailable(ReasonCode.ORACLE_UNAVAILABLE);
  const difference =
    price === undefined
      ? undefined
      : price >= reference
        ? price - reference
        : reference - price;
  return {
    ...result(
      difference !== undefined &&
        difference * 10000n <= BigInt(check.maxDeviationBps) * reference,
      ReasonCode.CHECK_ORACLE_DEVIATION,
    ),
    evidenceHash: evidenceHash(s.feed, s.roundId, s.answer, s.updatedAt),
  };
}
