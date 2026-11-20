import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parsePaymentRequired, validateSpec, validateTerms, ZERO_HASH } from "../src/index.js";

// Exercise the published examples directly, substituting only their address placeholders.
const doc = readFileSync(new URL("../../../AgentPay_VerificationSpec.md", import.meta.url), "utf8");
const examples = [...doc.matchAll(/^```json\r?\n([\s\S]*?)\r?\n```/gm)];
const address = "0x" + "11".repeat(20);
const spec = JSON.parse(examples[1]![1]!.replace("0xVERIFIER_SIGNER", address));
const payment = JSON.parse(examples[0]![1]!.replace(/0x(?:SESSION_ESCROW_CONTRACT|SELLER_WALLET)/g, address));
payment.extensions.agentpay.verificationSpec = spec;
const [accept] = payment.accepts;
const terms = payment.extensions.agentpay.session;

it("accepts the published price-feed, json-data and file minima", () => {
  expect(validateSpec(spec)).toEqual({ ok: true });
  expect(validateSpec({ ...spec, serviceType: "json-data", checks: [spec.checks[0]] })).toEqual({ ok: true });
  expect(validateSpec({ ...spec, serviceType: "file", checks: [{ type: "hash-match", id: "file", expectedHash: ZERO_HASH }] })).toEqual({ ok: true });
});
const schema = (schema: unknown) => ({ type: "json-schema", id: "schema", schema });
it.each([
  ["version", { specVersion: "0.1" }], ["service", { serviceType: "other" }], ["rule", { passRule: "any" }],
  ["zero checks", { checks: [] }], ["17 checks", { checks: Array(17).fill(spec.checks[0]) }],
  ["duplicate ids", { checks: [...spec.checks, spec.checks[0]] }], ["unknown type", { checks: [{ type: "custom", id: "x" }] }],
  ["UTF-8 size", { extra: "界".repeat(3000) }],
  ["depth", { extra: Array.from({ length: 33 }).reduce(o => ({ o }), {}) }],
  ["external ref", { checks: [schema({ properties: { x: { $ref: "another.json#/x" } } }), ...spec.checks.slice(1)] }],
  ["body limit", { delivery: { ...spec.delivery, maxBytes: 1048577 } }],
  ["price schema absent", { checks: spec.checks.slice(1) }],
  ["freshness", { checks: spec.checks.map((c: any) => c.type === "freshness" ? { ...c, maxAgeSec: 301 } : c) }],
  ["deviation", { checks: spec.checks.map((c: any) => c.type === "oracle-deviation" ? { ...c, maxDeviationBps: 501 } : c) }],
  ["empty required", { serviceType: "json-data", checks: [schema({ required: [] })] }],
  ["missing file hash", { serviceType: "file" }],
  ["missing equals value", { checks: [...spec.checks, { type: "equals", field: "/x", id: "x" }] }],
  ["malformed pointer", { checks: [...spec.checks, { type: "range", field: "x", id: "x" }] }],
])("rejects invalid spec: %s", (_, patch) => {
  expect(validateSpec({ ...spec, ...patch as object }).ok).toBe(false);
});

it("selects agentpay-session in mixed offers and preserves the exact spec", () => {
  const exactSpec = { ...spec, vendor: { label: "keep" } };
  const body = { ...payment, accepts: [{ scheme: "exact" }, accept],
    extensions: { agentpay: { ...payment.extensions.agentpay, verificationSpec: exactSpec } } };
  expect(parsePaymentRequired(JSON.stringify(body))).toEqual({ ...body, accepts: [accept] });
  expect(() => parsePaymentRequired({ ...body, accepts: [] })).toThrow("UNSUPPORTED_SCHEME");
  expect(() => parsePaymentRequired({ ...body, accepts: [{ ...accept, amount: 10000 }] })).toThrow();
  expect(() => parsePaymentRequired({ ...body, x402Version: 1 })).toThrow();
});
it.each([
  { pricePerRequest: "9999" }, { pricePerRequest: "1e4" }, { chainId: 1 }, { contract: "0x" + "22".repeat(20) },
  { minCap: "499999" }, { maxCap: "20000001" }, { minCap: "1000000", maxCap: "999999" },
  { deliveryDeadlineSec: 0 }, { deliveryDeadlineSec: 301 }, { defaultExpirySec: 86401 },
])("rejects invalid session terms %j", patch => {
  expect(validateTerms({ ...terms, ...patch }, accept).ok).toBe(false);
});
it("accepts inclusive cap and delivery limits", () => {
  for (const deliveryDeadlineSec of [1, 300]) expect(validateTerms({ ...terms, deliveryDeadlineSec }, accept)).toEqual({ ok: true });
});
