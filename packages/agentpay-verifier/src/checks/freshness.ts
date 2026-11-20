import { pointer } from "./pointer.js";
export function freshness(
  body: unknown,
  field: string,
  unit: "unix-s" | "unix-ms",
  maxAgeSec: number,
  receivedAt: bigint,
): boolean {
  const value = pointer(body, field);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  const scale = unit === "unix-ms" ? 1000n : 1n;
  const at = BigInt(value),
    received = receivedAt * scale;
  return (
    at <= received + 5n * scale && received - at <= BigInt(maxAgeSec) * scale
  );
}
