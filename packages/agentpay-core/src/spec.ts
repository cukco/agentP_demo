import { isAddress, type Address } from "viem";
import { z } from "zod";
import { AGENTPAY_VERSION, LIMITS, SCHEME, SPEC_VERSION, USDC_DOMAIN, VERIFIER_LIMITS } from "./constants.js";
import type { PaymentRequired, VerificationSpec } from "./types.js";

type Validation = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Validation => ({ ok: false, reason });
const address = z.custom<Address>(value => typeof value === "string" && isAddress(value, { strict: false }));
const uint = z.string().regex(/^\d+$/).max(78);
const seconds = z.number().int().safe().nonnegative();
const url = z.string().url().regex(/^https?:\/\//i);
const field = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);
const id = z.string().min(1);
const checks = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("json-schema"), schema: z.record(z.unknown()) }),
  z.object({ id, type: z.literal("equals"), field, value: z.unknown() }),
  z.object({ id, type: z.literal("range"), field, min: z.number().finite().optional(), max: z.number().finite().optional() }),
  z.object({ id, type: z.literal("freshness"), field, unit: z.enum(["unix-s", "unix-ms"]), maxAgeSec: seconds }),
  z.object({ id, type: z.literal("oracle-deviation"), field, maxDeviationBps: seconds, maxOracleAgeSec: seconds.optional(),
    oracle: z.object({ kind: z.literal("chainlink"), chainId: seconds.positive(), feed: address }) }),
  z.object({ id, type: z.literal("hash-match"), expectedHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
]);

const specShape = z.object({
  specVersion: z.literal(SPEC_VERSION), serviceType: z.enum(["price-feed", "json-data", "file"]),
  verifier: z.object({ address, endpoint: url }),
  delivery: z.object({ contentType: z.enum(["application/json", "application/octet-stream"]),
    maxBytes: seconds.positive().max(VERIFIER_LIMITS.MAX_BODY_BYTES) }),
  checks: z.array(checks).min(1).max(16), passRule: z.literal("all"),
});

// Bound nesting before serializing. Cycles also terminate at the depth limit.
function inspectJson(value: unknown, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) return;
  if (depth > VERIFIER_LIMITS.MAX_SCHEMA_DEPTH) throw new Error("Spec exceeds the depth limit");
  if (typeof value !== "object" || !(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)) throw new Error("Spec must contain only JSON values");
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && !(typeof child === "string" && child.startsWith("#"))) throw new Error("External $ref");
    inspectJson(child, depth + 1);
  }
}

export function validateSpec(value: unknown): Validation {
  try {
    inspectJson(value, 1);
    if (new TextEncoder().encode(JSON.stringify(value)).length > VERIFIER_LIMITS.MAX_SCHEMA_BYTES) return fail("Spec exceeds 8 KiB");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid JSON");
  }
  const result = specShape.safeParse(value);
  if (!result.success) return fail(result.error.issues[0]!.path.join(".") + " is invalid");
  const { checks, serviceType } = result.data;
  if (new Set(checks.map(c => c.id)).size !== checks.length) return fail("Duplicate check id");
  for (const c of checks) {
    if (c.type === "equals" && c.value === undefined) return fail("equals requires a value");
    if (c.type === "range" && c.min !== undefined && c.max !== undefined && c.min > c.max) return fail("Invalid range");
  }
  if (serviceType === "price-feed" && !(checks.some(c => c.type === "json-schema") &&
    checks.some(c => c.type === "freshness" && c.maxAgeSec <= 300) &&
    checks.some(c => c.type === "oracle-deviation" && c.maxDeviationBps <= 500))) return fail("Missing minimum price-feed checks");
  if (serviceType === "json-data" && !checks.some(c => c.type === "json-schema" && Array.isArray(c.schema.required) &&
    c.schema.required.length > 0 && c.schema.required.every(key => typeof key === "string"))) return fail("json-data needs required fields");
  if (serviceType === "file" && !checks.some(c => c.type === "hash-match")) return fail("file needs hash-match");
  return { ok: true };
}

const session = z.object({
  contract: address, chainId: seconds.positive(), seller: address, sellerAgentId: uint, pricePerRequest: uint,
  minCap: uint, maxCap: uint, defaultExpirySec: seconds.positive(), maxExpirySec: seconds.positive().max(LIMITS.MAX_EXPIRY),
  deliveryDeadlineSec: seconds.min(LIMITS.MIN_DELIVERY_DEADLINE).max(LIMITS.MAX_DELIVERY_DEADLINE),
  challengeWindowSec: seconds.max(LIMITS.MAX_CHALLENGE_WINDOW),
});
const offer = z.object({
  scheme: z.literal(SCHEME), network: z.string().regex(/^eip155:[1-9]\d*$/), asset: address, amount: uint, payTo: address,
  maxTimeoutSeconds: seconds.positive(), extra: z.object({ name: z.literal(USDC_DOMAIN.name), version: z.literal(USDC_DOMAIN.version) }),
});

export function validateTerms(terms: unknown, accepts: unknown): Validation {
  const t = session.safeParse(terms);
  const a = offer.safeParse(accepts);
  if (!t.success || !a.success) return fail("Malformed session terms or payment offer");
  const { pricePerRequest, contract, chainId, minCap, maxCap, defaultExpirySec, maxExpirySec } = t.data;
  if (BigInt(pricePerRequest) === 0n || BigInt(pricePerRequest) !== BigInt(a.data.amount)) return fail("Price mismatch or zero");
  if (contract.toLowerCase() !== a.data.payTo.toLowerCase()) return fail("payTo must be the escrow");
  if (a.data.network !== `eip155:${chainId}`) return fail("Network mismatch");
  if (BigInt(minCap) < LIMITS.MIN_CAP || BigInt(maxCap) > LIMITS.MAX_CAP || BigInt(minCap) > BigInt(maxCap)) return fail("Invalid cap range");
  if (defaultExpirySec > maxExpirySec) return fail("Invalid expiry range");
  return { ok: true };
}

const envelope = z.object({
  x402Version: z.literal(2), resource: z.object({ url }), accepts: z.array(z.unknown()),
  extensions: z.object({ agentpay: z.object({ version: z.literal(AGENTPAY_VERSION), session,
    // Preserve the exact spec, including extension fields, for JCS hashing.
    verificationSpec: z.custom<VerificationSpec>(value => validateSpec(value).ok) }) }),
});

export function parsePaymentRequired(json: unknown): PaymentRequired {
  const parsed = envelope.parse(typeof json === "string" ? JSON.parse(json) : json);
  const selected = parsed.accepts.find(item => typeof item === "object" && item !== null && "scheme" in item && item.scheme === SCHEME);
  if (!selected) throw new Error("UNSUPPORTED_SCHEME");
  const accepted = offer.parse(selected);
  const terms = validateTerms(parsed.extensions.agentpay.session, accepted);
  if (!terms.ok) throw new Error(terms.reason);
  return { ...parsed, accepts: [accepted] };
}
