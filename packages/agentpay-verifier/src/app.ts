import {
  CHAIN_ID,
  type ApiError,
  fromWire,
  toWire,
  type CloseRequest,
  type HealthResponse,
} from "@agentpay/core";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "./errors.js";
import { relaySchema, closeSchema, uint } from "./validation.js";
import type { VerifierRuntime } from "./runtime.js";
import { Hono } from "hono";
import type { Address } from "viem";
import type { ChainAdapter } from "./chain.js";
import type { VerifierDatabase } from "./db.js";

interface Dependencies {
  runtime?: VerifierRuntime;
  db: VerifierDatabase;
  signer: { address: Address };
  chain: ChainAdapter;
  clock: () => number;
  config: { escrow: Address };
}

export function createApp({
  db,
  signer,
  chain,
  clock,
  config,
  runtime,
}: Dependencies) {
  const app = new Hono();
  app.use(
    "*",
    bodyLimit({
      maxSize: 1_500_000,
      onError: (c) =>
        c.json(
          { error: { code: "BAD_REQUEST", message: "Request too large" } },
          413,
        ),
    }),
  );
  app.onError((error, context) =>
    error instanceof HttpError
      ? context.json<ApiError>(
          { error: { code: error.code, message: error.message } },
          error.status,
        )
      : context.json<ApiError>(
          {
            error: {
              code: "INTERNAL",
              message: "Verifier could not process the request",
            },
          },
          500,
        ),
  );
  app.use("/v1/sessions/:id/*", async (c, next) => {
    if (!uint.safeParse(c.req.param("id")).success)
      throw new HttpError("BAD_REQUEST", "Invalid session ID");
    await next();
  });
  app.post("/v1/sessions/:id/requests", async (c) => {
    if (!runtime)
      throw new HttpError("INTERNAL", "Relay is not configured", 503);
    const input = relaySchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      throw new HttpError("BAD_REQUEST", "Malformed relay request");
    return c.json(
      await runtime.relay(
        BigInt(c.req.param("id")),
        input.data as import("@agentpay/core").RelayRequest,
      ),
    );
  });
  app.post("/v1/sessions/:id/close", async (c) => {
    if (!runtime)
      throw new HttpError("INTERNAL", "Closer is not configured", 503);
    const input = closeSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      throw new HttpError("BAD_REQUEST", "Malformed close request");
    return c.json(
      await runtime.requestClose(BigInt(c.req.param("id")), {
        message: fromWire<CloseRequest>(
          "CloseRequest",
          input.data.closeRequest.message,
        ),
        signature: input.data.closeRequest.signature as `0x${string}`,
      }),
    );
  });
  app.get("/v1/sessions/:id/receipts", (c) => {
    const id = BigInt(c.req.param("id")),
      from = c.req.query("fromSeq") ?? "1";
    if (
      !/^\d{1,10}$/.test(from) ||
      Number(from) < 1 ||
      Number(from) > 4294967295
    )
      throw new HttpError("BAD_REQUEST", "Invalid fromSeq");
    if (!db.session(id))
      throw new HttpError("SESSION_NOT_FOUND", "Unknown session", 404);
    return c.json({
      sessionId: id.toString(),
      receipts: toWire(db.receipts(id, Number(from))),
    });
  });
  app.get("/v1/sessions/:id/checkpoint", (c) => {
    const id = BigInt(c.req.param("id")),
      verdict = db.verdict(id, "checkpoint");
    if (!verdict)
      throw new HttpError(
        "SESSION_NOT_FOUND",
        "Checkpoint is not available",
        404,
      );
    const voucher = db.voucher(id, verdict.message.lastSeq);
    if (!voucher) throw new Error("Checkpoint voucher missing");
    return c.json({
      sessionId: id.toString(),
      verdict: toWire(verdict),
      voucher: toWire(voucher),
    });
  });
  app.get("/v1/health", async (context) => {
    const rpc = await chain.health();
    const ok = rpc.fuji && rpc.mainnet.some(Boolean);
    return context.json<HealthResponse>(
      {
        ok,
        verifier: signer.address,
        chainId: CHAIN_ID.fuji,
        escrow: config.escrow,
        rpc,
      },
      ok ? 200 : 503,
    );
  });
  app.get("/v1/sessions/:id", async (context) => {
    const raw = context.req.param("id");
    if (!/^\d{1,78}$/.test(raw) || BigInt(raw) >= 2n ** 256n) {
      return context.json<ApiError>(
        { error: { code: "BAD_REQUEST", message: "Invalid session ID" } },
        400,
      );
    }
    const id = BigInt(raw);
    const session = await chain.getSession(id);
    if (!session) {
      return context.json<ApiError>(
        { error: { code: "SESSION_NOT_FOUND", message: "Unknown session" } },
        404,
      );
    }
    db.saveSession(id, session, clock());
    const state = (
      ["OPEN", "CLOSING", "CHALLENGED", "SETTLED", "REFUNDED"] as const
    )[session.state - 1];
    if (!state) throw new Error("Unknown session state");
    const row = db.session(id);
    return context.json({
      sessionId: id.toString(),
      state: state === "OPEN" && db.runtime(id)?.closing ? "CLOSING" : state,
      buyer: session.buyer,
      seller: session.seller,
      voucherSigner: session.voucherSigner,
      lastSeq: row?.last_seq ?? 0,
      passCount: row?.pass ?? 0,
      failCount: row?.fail ?? 0,
      inconclusiveCount: row?.inconclusive ?? 0,
      passedAmount: row?.passed_amount ?? "0",
      cumulativeAmount: row?.cumulative ?? "0",
      failStreak: row?.fail_streak ?? 0,
      expiry: session.expiry.toString(),
      closeTxHash: row?.close_tx ?? undefined,
    });
  });
  return app;
}
