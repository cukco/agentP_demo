/** JSON wire format: bigint <-> decimal string. Parsing is per struct, so unrelated string fields are never touched. */

export type Wire<T> = T extends bigint
  ? string
  : T extends Array<infer U>
    ? Array<Wire<U>>
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export function toWire<T>(value: T): Wire<T> {
  if (typeof value === "bigint") return value.toString() as Wire<T>;
  if (Array.isArray(value)) return value.map(toWire) as Wire<T>;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWire(v);
    return out as Wire<T>;
  }
  return value as Wire<T>;
}

/** bigint fields (uint >= 64 bits) of every struct that travels on the wire. */
export const BIGINT_FIELDS = {
  OpenParams: ["sellerAgentId", "cap", "pricePerRequest", "expiry"],
  Authorization: ["value", "validAfter", "validBefore"],
  Voucher: ["sessionId", "cumulativeAmount"],
  Delivery: ["sessionId"],
  Receipt: ["sessionId", "amount", "receivedAt"],
  SessionVerdict: ["sessionId", "passedAmount", "closedAt"],
  ScoreAttestation: ["agentId", "validUntil"],
  CloseRequest: ["sessionId", "deadline"],
  PolicyParams: ["maxPerSession", "dailyCap"],
} as const;

export type WireStruct = keyof typeof BIGINT_FIELDS;

export function fromWire<T>(struct: WireStruct, value: Wire<T>): T {
  const fields = new Set<string>(BIGINT_FIELDS[struct]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (fields.has(k)) {
      if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`fromWire(${struct}): ${k} must be a decimal string`);
      out[k] = BigInt(v);
    } else {
      out[k] = v;
    }
  }
  for (const f of fields) if (!(f in out)) throw new Error(`fromWire(${struct}): missing ${f}`);
  return out as T;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(toWire(value)), "utf8").toString("base64");
}

export function decodeHeaderJson<T = unknown>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}
