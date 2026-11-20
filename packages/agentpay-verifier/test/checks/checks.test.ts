import { describe, expect, it } from "vitest";
import {
  bodyHash,
  Outcome,
  ReasonCode,
  validateSpec,
  type Check,
  type VerificationSpec,
} from "@agentpay/core";
import { createCheckRunner } from "../../src/checks/runner.js";
import { equals } from "../../src/checks/equals.js";
import { range } from "../../src/checks/range.js";
import { freshness } from "../../src/checks/freshness.js";
import { jsonSchema } from "../../src/checks/jsonSchema.js";
import { fixed8, oracle } from "../../src/checks/oracle.js";
import type { OracleSnapshot } from "../../src/checks/types.js";
const address = "0x0000000000000000000000000000000000000001" as const;
const at = 1800000000n;
const schema: Check = {
  id: "shape",
  type: "json-schema",
  schema: {
    type: "object",
    required: ["price"],
    properties: { price: { type: "number" } },
  },
};
const fresh: Check = {
  id: "age",
  type: "freshness",
  field: "/timestamp",
  unit: "unix-s",
  maxAgeSec: 60,
};
const price: Extract<Check, { type: "oracle-deviation" }> = {
  id: "oracle",
  type: "oracle-deviation",
  field: "/price",
  maxDeviationBps: 200,
  oracle: { kind: "chainlink", chainId: 43114, feed: address },
};
const spec = (checks: Check[]): VerificationSpec => ({
  specVersion: "agentpay-verify/0.2",
  serviceType: "json-data",
  verifier: { address, endpoint: "https://verifier.example" },
  delivery: { contentType: "application/json", maxBytes: 1024 },
  checks: [schema, ...checks],
  passRule: "all",
});
const body = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const snapshot: OracleSnapshot = {
  chainId: 43114,
  feed: address,
  roundId: 20n,
  answeredInRound: 20n,
  answer: 2500000000n,
  decimals: 8,
  updatedAt: at - 30n,
};

describe("pure checks", () => {
  it("equals preserves JSON types and decodes JSON Pointer escapes and arrays", () => {
    const value = { "a/b": { "~": [1, { x: true }] } };
    expect(equals(value, "/a~1b/~0/0", 1)).toBe(true);
    expect(equals(value, "/a~1b/~0/0", "1")).toBe(false);
    expect(equals(value, "/a~1b/~0/1", { x: true })).toBe(true);
    expect(equals(value, "/constructor", 1)).toBe(false);
    expect(equals(value, "/a~1b/~0/01", { x: true })).toBe(false);
  });
  it("range includes boundaries and rejects strings and missing values", () => {
    expect(range({ n: 1 }, "/n", 1, 2)).toBe(true);
    expect(range({ n: 2 }, "/n", 1, 2)).toBe(true);
    expect(range({ n: 3 }, "/n", 1, 2)).toBe(false);
    expect(range({ n: "1" }, "/n", 1, 2)).toBe(false);
  });
  it("freshness uses saved receivedAt, handles milliseconds and future tolerance", () => {
    expect(freshness({ t: Number(at) + 4 }, "/t", "unix-s", 60, at)).toBe(true);
    expect(freshness({ t: Number(at) + 6 }, "/t", "unix-s", 60, at)).toBe(
      false,
    );
    expect(freshness({ t: Number(at) - 61 }, "/t", "unix-s", 60, at)).toBe(
      false,
    );
    expect(
      freshness({ t: Number(at) * 1000 - 60000 }, "/t", "unix-ms", 60, at),
    ).toBe(true);
  });
  it("AJV uses RE2 on hostile patterns, after warm-up", () => {
    const s = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", pattern: "^(a+)+$" } },
    };
    expect(jsonSchema({ name: "aaa" }, s)).toBe(true);
    const start = performance.now();
    expect(jsonSchema({ name: "a".repeat(50) + "!" }, s)).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });
  it("oracle math uses bigint, exact threshold and evidence", () => {
    expect(fixed8(1e-7)).toBe(10n);
    expect(fixed8(1.234567899)).toBe(123456789n);
    expect(oracle({ price: 25.5 }, price, at, snapshot).outcome).toBe(
      Outcome.PASS,
    );
    expect(oracle({ price: 25.75 }, price, at, snapshot).reasonCode).toBe(14);
    expect(oracle({ price: "25" }, price, at, snapshot).reasonCode).toBe(14);
    expect(
      oracle({ price: 25 }, price, at, { ...snapshot, updatedAt: at - 7200n })
        .reasonCode,
    ).toBe(20);
    expect(
      oracle({ price: 25 }, price, at, { ...snapshot, answer: 0n }).reasonCode,
    ).toBe(20);
    expect(
      oracle({ price: 25 }, price, at, { ...snapshot, answeredInRound: 19n })
        .reasonCode,
    ).toBe(20);
  });
});

describe("bounded worker runner", () => {
  it.each([
    [{ id: "eq", type: "equals", field: "/price", value: 25 }, 26, 11],
    [{ id: "rng", type: "range", field: "/price", min: 24, max: 26 }, 27, 12],
    [fresh, 25, 13],
  ] as [Check, number, number][])(
    "returns the first failed check %#",
    async (check, value, code) => {
      const run = createCheckRunner();
      const res = await run({
        spec: spec([check]),
        body: body({ price: value, timestamp: Number(at) - 61 }),
        contentType: "application/json",
        receivedAt: at,
      });
      expect(res).toMatchObject({ outcome: Outcome.FAIL, reasonCode: code });
    },
  );
  it("supports successful JSON checks and schema failure", async () => {
    const run = createCheckRunner();
    const input = {
      spec: spec([fresh]),
      body: body({ price: 25, timestamp: Number(at) }),
      contentType: "application/json; charset=utf-8",
      receivedAt: at,
    };
    expect((await run(input)).outcome).toBe(1);
    expect(
      (await run({ ...input, body: body({ price: "25" }) })).reasonCode,
    ).toBe(10);
    expect((await run({ ...input, body: body("no") })).reasonCode).toBe(10);
    expect(
      (await run({ ...input, body: new TextEncoder().encode("not json") }))
        .reasonCode,
    ).toBe(5);
  });
  it("hash-match compares original bytes", async () => {
    const bytes = Uint8Array.of(0, 255, 128, 13, 10);
    const s = {
      ...spec([]),
      serviceType: "file" as const,
      delivery: {
        contentType: "application/octet-stream" as const,
        maxBytes: 1024,
      },
      checks: [
        {
          id: "hash",
          type: "hash-match" as const,
          expectedHash: bodyHash(bytes),
        },
      ],
    };
    const run = createCheckRunner();
    expect(
      (
        await run({
          spec: s,
          body: bytes,
          contentType: "application/octet-stream",
          receivedAt: at,
        })
      ).outcome,
    ).toBe(1);
    expect(
      (
        await run({
          spec: s,
          body: bytes.slice(1),
          contentType: "application/octet-stream",
          receivedAt: at,
        })
      ).reasonCode,
    ).toBe(15);
  });
  it("replays saved oracle evidence without querying current data", async () => {
    let reads = 0;
    const run = createCheckRunner({
      oracle: async () => {
        reads++;
        return snapshot;
      },
    });
    const input = {
      spec: { ...spec([fresh, price]), serviceType: "price-feed" as const },
      body: body({ price: 25, timestamp: Number(at) }),
      contentType: "application/json",
      receivedAt: at,
    };
    const first = await run(input);
    expect(first.outcome).toBe(1);
    expect(reads).toBe(1);
    const replay = await createCheckRunner({
      oracle: async () => {
        throw new Error("must not fetch");
      },
    })(input, first.oracle);
    expect(replay).toEqual(first);
    expect(
      (
        await createCheckRunner({
          oracle: async () => {
            throw new Error("offline");
          },
        })(input)
      ).reasonCode,
    ).toBe(20);
  });
  it("terminates worker/request and bounds concurrency", async () => {
    const input = {
      spec: spec([]),
      body: body({ price: 1 }),
      contentType: "application/json",
      receivedAt: at,
    };
    const run = createCheckRunner({ requestTimeoutMs: 1 });
    expect((await run(input)).reasonCode).toBe(21);
    expect(
      (await createCheckRunner({ maxConcurrent: 0 })(input)).reasonCode,
    ).toBe(21);
  });
  it("bounds slow oracle requests", async () => {
    const run = createCheckRunner({ oracle: () => new Promise(() => {}) });
    const started = performance.now();
    const res = await run({
      spec: spec([price]),
      body: body({ price: 25 }),
      contentType: "application/json",
      receivedAt: at,
    });
    expect(res.reasonCode).toBe(20);
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it("rejects overlarge, external-ref and deeply nested specs before executing", () => {
    for (const schema of [
      { type: "string", description: "x".repeat(9000) },
      { $ref: "https://bad.example/schema" },
    ])
      expect(
        validateSpec(spec([{ id: "bad", type: "json-schema", schema }])).ok,
      ).toBe(false);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { properties: { next: deep } };
    expect(
      validateSpec(spec([{ id: "bad", type: "json-schema", schema: deep }])).ok,
    ).toBe(false);
  });
});
