import { timingSafeEqual } from "node:crypto";
import { LIMITS, type VerificationSpec } from "@agentpay/core";
import { createAgentPaySeller, type SellerOptions } from "@agentpay/seller";
import { Hono } from "hono";
import { FAULT_PATH, PRICE_PATH, PRICE_PER_REQUEST, priceSpec, quotePrice, type ReadQuote } from "./price.js";

export interface PriceSellerOptions extends Omit<SellerOptions, "terms" | "spec" | "pricePerRequest"> {
  verifier: VerificationSpec["verifier"];
  readQuote: ReadQuote;
  faultToken: string;
}

export function createApp(deps: PriceSellerOptions) {
  if (!deps.faultToken) throw new Error("Demo fault token is required");
  const authorization = Buffer.from(`Bearer ${deps.faultToken}`);
  const sdk = createAgentPaySeller({ ...deps, spec: priceSpec(deps.verifier), pricePerRequest: PRICE_PER_REQUEST,
    terms: { minCap: LIMITS.MIN_CAP, maxCap: LIMITS.MAX_CAP, defaultExpirySec: 3600, maxExpirySec: LIMITS.MAX_EXPIRY,
      deliveryDeadlineSec: 10, challengeWindowSec: 30 },
  });
  const app = new Hono();
  let fault = false;
  app.onError((_error, c) => c.json({ error: "Seller request failed" }, 500));
  app.get("/health", c => c.json({ status: "ok" }));
  app.post(FAULT_PATH, async c => {
    const supplied = Buffer.from(c.req.header("authorization") ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) return c.text("Denied", 403);
    const body: unknown = await c.req.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || !("on" in body) || typeof body.on !== "boolean") {
      return c.json({ error: "Expected a boolean on field" }, 400);
    }
    fault = body.on;
    return c.json({ on: fault });
  });
  app.use(PRICE_PATH, sdk.middleware());
  app.get(PRICE_PATH, async c => {
    try {
      const quote = await deps.readQuote();
      const timestamp = deps.clock();
      return c.json({ symbol: "AVAX", price: quotePrice(quote, timestamp, fault), timestamp });
    } catch {
      return c.json({ error: "Chainlink quote unavailable" }, 503);
    }
  });
  return Object.assign(app, { stop: sdk.stop });
}
