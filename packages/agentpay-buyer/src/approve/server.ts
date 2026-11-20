import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { TYPES, VERIFIER_LIMITS, usdcDomain, verifyCloseRequest } from "@agentpay/core";
import { isAddressEqual, recoverTypedDataAddress, type Hex } from "viem";
import { Hono, type Context, type Next } from "hono";
import type { ApprovalParams, ApprovalReview } from "./params.js";

export type ApprovalCode = "APPROVAL_TIMEOUT" | "APPROVAL_REJECTED" | "APPROVAL_INVALID" | "APPROVAL_UNAVAILABLE";

export class BuyerApprovalError extends Error {
  constructor(readonly code: ApprovalCode) {
    super(code);
    this.name = "BuyerApprovalError";
  }
}

async function verifyApproval(review: ApprovalReview, signature: Hex, deadline: bigint) {
  if (review.kind === "close") {
    return verifyCloseRequest(review.chainId, review.escrow, {
      message: { sessionId: BigInt(review.sessionId), deadline }, signature,
    }, review.buyer);
  }
  const signer = await recoverTypedDataAddress({
    domain: usdcDomain(review.chainId, review.asset), types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization", message: {
      from: review.buyer, to: review.escrow, value: BigInt(review.params.cap),
      validAfter: 0n, validBefore: deadline, nonce: review.nonce,
    }, signature,
  });
  return isAddressEqual(signer, review.buyer);
}

export async function requestApproval(
  review: ApprovalReview,
  options: { clock: () => number; onApprovalUrl: (url: string) => void | Promise<void> },
): Promise<{ signature: Hex; deadline: bigint }> {
  const html = await readFile(new URL("../../dist/approve/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  if (!script) throw new BuyerApprovalError("APPROVAL_UNAVAILABLE");
  const scriptHash = createHash("sha256").update(script).digest("base64");
  const token = randomBytes(32).toString("hex");
  const app = new Hono();
  const timeout = VERIFIER_LIMITS.APPROVAL_TIMEOUT_SEC * 1000;
  const lifetime = review.kind === "open" ? 120n : BigInt(VERIFIER_LIMITS.CLOSE_REQUEST_SLA_SEC);
  let server: ReturnType<typeof serve> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin = "";
  let used = false;
  let expired = false;
  let lastDeadline: bigint | undefined;

  return new Promise((resolve, reject) => {
    function finish(error: BuyerApprovalError | undefined, result?: { signature: Hex; deadline: bigint }) {
      if (expired) return;
      expired = true;
      clearTimeout(timer);
      server?.close();
      if (error) reject(error);
      else resolve(result!);
    }
    app.onError((_error, c) => {
      finish(new BuyerApprovalError("APPROVAL_UNAVAILABLE"));
      return c.text("Approval unavailable", 500);
    });
    app.use("*", async (c, next) => {
      if (!origin || c.req.header("host") !== new URL(origin).host) return c.text("Denied", 403);
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Frame-Options", "DENY");
      c.header("Content-Security-Policy", `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      await next();
    });
    app.get("/", c => c.html(html));
    app.use("/params", authorize);
    app.use("/signature", authorize);
    async function authorize(c: Context, next: Next) {
      const value = /^Bearer ([a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!value ||
          !timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(token, "hex"))) return c.text("Denied", 403);
      if (used || expired) return c.text("Approval already completed", 410);
      await next();
    }
    app.get("/params", c => {
      const now = BigInt(options.clock());
      if (review.kind === "open" && BigInt(review.params.expiry) <= now) {
        finish(new BuyerApprovalError("APPROVAL_INVALID"));
        return c.text("Session terms expired", 410);
      }
      lastDeadline = now + lifetime;
      return c.json<ApprovalParams>({ ...review, validBefore: lastDeadline.toString() });
    });
    app.post("/signature", async c => {
      if (c.req.header("origin") !== origin || c.req.header("content-type") !== "application/json") return c.text("Denied", 403);
      const length = c.req.header("content-length");
      if (length && Number(length) > 512) return c.text("Invalid response", 400);
      const data = await c.req.json<{ rejected?: boolean; signature?: Hex; validBefore?: string }>().catch(() => null);
      if (used || expired) return c.text("Approval already completed", 410);
      if (!data || (data.rejected !== true && (!data.signature || !/^0x[0-9a-f]{130}$/i.test(data.signature) ||
          !lastDeadline || data.validBefore !== lastDeadline.toString()))) return c.text("Invalid response", 400);
      used = true;
      if (data.rejected === true) {
        finish(new BuyerApprovalError("APPROVAL_REJECTED"));
        return c.json({ ok: true });
      }
      const deadline = lastDeadline!;
      try {
        const now = BigInt(options.clock());
        if (deadline <= now || deadline > now + lifetime || !await verifyApproval(review, data.signature!, deadline)) {
          throw new BuyerApprovalError("APPROVAL_INVALID");
        }
        if (expired) return c.text("Approval expired", 410);
        finish(undefined, { signature: data.signature!, deadline });
        return c.json({ ok: true });
      } catch {
        finish(new BuyerApprovalError("APPROVAL_INVALID"));
        return c.text("Signature does not match the review", 400);
      }
    });

    timer = setTimeout(() => finish(new BuyerApprovalError("APPROVAL_TIMEOUT")), timeout);
    try {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) => {
        origin = `http://127.0.0.1:${port}`;
        Promise.resolve().then(() => options.onApprovalUrl(`${origin}/#${token}`))
          .catch(() => finish(new BuyerApprovalError("APPROVAL_UNAVAILABLE")));
      });
      server.once("error", () => finish(new BuyerApprovalError("APPROVAL_UNAVAILABLE")));
    } catch {
      finish(new BuyerApprovalError("APPROVAL_UNAVAILABLE"));
    }
  });
}
