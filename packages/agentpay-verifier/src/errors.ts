import type { ApiErrorCode } from "@agentpay/core";
export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: 400 | 401 | 404 | 409 | 429 | 502 | 503 = 400,
  ) {
    super(message);
  }
}
