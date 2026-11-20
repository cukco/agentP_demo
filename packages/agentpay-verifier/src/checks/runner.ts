import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import {
  Outcome,
  ReasonCode,
  VERIFIER_LIMITS,
  validateSpec,
} from "@agentpay/core";
import {
  result,
  unavailable,
  type CheckInput,
  type CheckResult,
  type OracleReader,
  type OracleSnapshot,
} from "./types.js";
export interface RunnerOptions {
  oracle?: OracleReader;
  maxConcurrent?: number;
  checkTimeoutMs?: number;
  requestTimeoutMs?: number;
}
function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Check timeout")),
      Math.max(1, ms),
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
/** Each request has an isolated worker, bounded concurrency, per-check and total deadlines. */
export function createCheckRunner(options: RunnerOptions = {}) {
  let running = 0;
  const perCheck = Math.min(
    options.checkTimeoutMs ?? 500,
    VERIFIER_LIMITS.CHECK_TIMEOUT_MS,
  );
  const total = Math.min(
    options.requestTimeoutMs ?? 2000,
    VERIFIER_LIMITS.REQUEST_CHECKS_TIMEOUT_MS,
  );
  return async (
    input: CheckInput,
    savedOracle?: OracleSnapshot[],
  ): Promise<CheckResult> => {
    if (!validateSpec(input.spec).ok)
      throw new Error("Invalid verification spec");
    if (input.body.byteLength > input.spec.delivery.maxBytes)
      return result(false, ReasonCode.TOO_LARGE);
    if (
      input.contentType.split(";", 1)[0].trim().toLowerCase() !==
      input.spec.delivery.contentType
    )
      return result(false, ReasonCode.BAD_CONTENT);
    if (running >= (options.maxConcurrent ?? 4)) return unavailable();
    running++;
    const end = performance.now() + total,
      observations: OracleSnapshot[] = [];
    let worker: Worker | undefined;
    let last = result(true, ReasonCode.PASS);
    try {
      let path = new URL("./worker.cjs", import.meta.url);
      if (!existsSync(path))
        path = new URL("../../dist/checks/worker.cjs", import.meta.url);
      worker = new Worker(path, {
        execArgv: [], // Bundled JS must not inherit CLI loaders or --input-type.
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
      });
      const next = () =>
        new Promise<CheckResult | "ready">((resolve, reject) => {
          const clean = () => {
            worker!.off("message", message);
            worker!.off("error", error);
            worker!.off("exit", exit);
          };
          const message = (value: CheckResult | "ready") => {
            clean();
            resolve(value);
          };
          const error = (err: Error) => {
            clean();
            reject(err);
          };
          const exit = () => {
            clean();
            reject(new Error("Worker stopped"));
          };
          worker!.once("message", message);
          worker!.once("error", error);
          worker!.once("exit", exit);
        });
      if ((await timeout(next(), end - performance.now())) !== "ready")
        return unavailable();
      for (const check of input.spec.checks) {
        const checkEnd = Math.min(end, performance.now() + perCheck);
        let snapshot: OracleSnapshot | undefined;
        if (check.type === "oracle-deviation") {
          try {
            snapshot = savedOracle?.find(
              (s) =>
                (s.checkId === undefined || s.checkId === check.id) &&
                s.chainId === check.oracle.chainId &&
                s.feed.toLowerCase() === check.oracle.feed.toLowerCase(),
            );
            if (savedOracle && !snapshot)
              throw new Error("Missing saved oracle evidence");
            snapshot ??= await timeout(
              options.oracle
                ? options.oracle(check)
                : Promise.reject(new Error("No oracle")),
              checkEnd - performance.now(),
            );
            if (!snapshot) throw new Error("Missing oracle observation");
            observations.push({ ...snapshot, checkId: check.id });
          } catch {
            return {
              ...unavailable(ReasonCode.ORACLE_UNAVAILABLE),
              oracle: observations,
            };
          }
        }
        const response = next();
        worker.postMessage({
          check,
          body: input.body,
          receivedAt: input.receivedAt,
          snapshot,
        });
        const value = await timeout(response, checkEnd - performance.now());
        if (value === "ready") throw new Error("Unexpected worker message");
        if (snapshot || value.outcome !== Outcome.PASS) last = value;
        if (value.outcome !== Outcome.PASS)
          return { ...value, oracle: observations };
      }
      return { ...last, oracle: observations };
    } catch {
      return { ...unavailable(), oracle: observations };
    } finally {
      if (worker) await worker.terminate();
      running--;
    }
  };
}
