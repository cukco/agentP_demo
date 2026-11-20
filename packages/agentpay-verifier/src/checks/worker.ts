import { parentPort } from "node:worker_threads";
import { ReasonCode, type Check } from "@agentpay/core";
import { jsonSchema } from "./jsonSchema.js";
import { equals } from "./equals.js";
import { range } from "./range.js";
import { freshness } from "./freshness.js";
import { hashMatch } from "./hashMatch.js";
import { oracle } from "./oracle.js";
import { result, unavailable, type OracleSnapshot } from "./types.js";
parentPort!.on(
  "message",
  ({
    check,
    body,
    receivedAt,
    snapshot,
  }: {
    check: Check;
    body: Uint8Array;
    receivedAt: bigint;
    snapshot?: OracleSnapshot;
  }) => {
    try {
      if (check.type === "hash-match")
        return parentPort!.postMessage(
          result(
            hashMatch(body, check.expectedHash),
            ReasonCode.CHECK_HASH_MATCH,
          ),
        );
      let json: unknown;
      try {
        json = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      } catch {
        return parentPort!.postMessage(result(false, ReasonCode.BAD_CONTENT));
      }
      switch (check.type) {
        case "json-schema":
          parentPort!.postMessage(
            result(
              jsonSchema(json, check.schema),
              ReasonCode.CHECK_JSON_SCHEMA,
            ),
          );
          break;
        case "equals":
          parentPort!.postMessage(
            result(
              equals(json, check.field, check.value),
              ReasonCode.CHECK_EQUALS,
            ),
          );
          break;
        case "range":
          parentPort!.postMessage(
            result(
              range(json, check.field, check.min, check.max),
              ReasonCode.CHECK_RANGE,
            ),
          );
          break;
        case "freshness":
          parentPort!.postMessage(
            result(
              freshness(
                json,
                check.field,
                check.unit,
                check.maxAgeSec,
                receivedAt,
              ),
              ReasonCode.CHECK_FRESHNESS,
            ),
          );
          break;
        case "oracle-deviation":
          parentPort!.postMessage(
            snapshot
              ? oracle(json, check, receivedAt, snapshot)
              : unavailable(ReasonCode.ORACLE_UNAVAILABLE),
          );
          break;
      }
    } catch {
      parentPort!.postMessage(unavailable());
    }
  },
);
parentPort!.postMessage("ready");
