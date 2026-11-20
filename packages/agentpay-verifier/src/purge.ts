import { VERIFIER_LIMITS } from "@agentpay/core";
import type { VerifierDatabase } from "./db.js";

export function purgeBodies(db: VerifierDatabase, clock: () => number): number {
  return db.purgeBodies(clock() - VERIFIER_LIMITS.BODY_RETENTION_DAYS * 86_400);
}
