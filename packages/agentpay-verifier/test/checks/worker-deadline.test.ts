import { expect, it, vi } from "vitest";
import { bodyHash, type VerificationSpec } from "@agentpay/core";
const state = vi.hoisted(() => ({ exited: false }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(
        _path: unknown,
        options: import("node:worker_threads").WorkerOptions,
      ) {
        super(
          `const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>{const until=Date.now()+1000;while(Date.now()<until){};parentPort.postMessage({outcome:1,reasonCode:0});});parentPort.postMessage('ready');`,
          { ...options, eval: true },
        );
        this.once("exit", () => {
          state.exited = true;
        });
      }
    },
  };
});
import { createCheckRunner } from "../../src/checks/runner.js";
it("terminates an actual CPU-bound worker at the 500 ms per-check deadline", async () => {
  const body = Buffer.from("x"),
    spec: VerificationSpec = {
      specVersion: "agentpay-verify/0.2",
      serviceType: "file",
      passRule: "all",
      verifier: {
        address: "0x0000000000000000000000000000000000000001",
        endpoint: "https://example.com",
      },
      delivery: { contentType: "application/octet-stream", maxBytes: 1024 },
      checks: [
        { id: "hash", type: "hash-match", expectedHash: bodyHash(body) },
      ],
    };
  let eventLoopResponsive = false;
  setTimeout(() => {
    eventLoopResponsive = true;
  }, 50);
  const result = await createCheckRunner()({
    spec,
    body,
    contentType: "application/octet-stream",
    receivedAt: 1800000000n,
  });
  expect(result).toMatchObject({ outcome: 3, reasonCode: 21 });
  expect(state.exited).toBe(true);
  expect(eventLoopResponsive).toBe(true);
});
