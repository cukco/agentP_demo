import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("documents explicit script dispatch for registerBuyer because pnpm reserves setup", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toMatch(/^pnpm --filter @agentpay\/buyer run setup \$admin \$policy\r?$/m);
  expect(readme).not.toMatch(/^pnpm --filter @agentpay\/buyer setup(?:\s|$)/m);
});
