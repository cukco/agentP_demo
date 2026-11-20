import { z } from "zod";
export const uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((value) => BigInt(value) < 2n ** 256n);
const hash = z
  .string()
  .regex(/^0x[\da-fA-F]{64}$/)
  .transform((value) => value as `0x${string}`);
const sig = z
  .string()
  .regex(/^0x[\da-fA-F]{130}$/)
  .transform((value) => value as `0x${string}`);
export const relaySchema = z
  .object({
    voucher: z
      .object({
        message: z
          .object({
            sessionId: uint,
            seq: z.number().int().min(1).max(4294967295),
            cumulativeAmount: uint,
            requestHash: hash,
          })
          .strict(),
        signature: sig,
      })
      .strict(),
    request: z
      .object({
        method: z.enum([
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ]),
        url: z.string().url().max(8192),
        headers: z
          .record(z.string().max(8192))
          .refine((h) => Object.keys(h).length <= 64)
          .optional(),
        bodyBase64: z
          .string()
          .max(1398104)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          )
          .optional(),
      })
      .strict(),
  })
  .strict();
export const closeSchema = z
  .object({
    closeRequest: z
      .object({
        message: z.object({ sessionId: uint, deadline: uint }).strict(),
        signature: sig,
      })
      .strict(),
  })
  .strict();
export const deliverySchema = z
  .object({
    message: z
      .object({
        sessionId: uint,
        seq: z.number().int().min(1).max(4294967295),
        requestHash: hash,
        bodyHash: hash,
        specHash: hash,
      })
      .strict(),
    signature: sig,
  })
  .strict();
