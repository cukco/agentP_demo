import { agentPaySessionEscrowAbi } from "@agentpay/core";

const known = new Set<string>(agentPaySessionEscrowAbi.filter(item => item.type === "error").map(item => item.name));

/** pnpm peer contexts can load multiple viem constructors in the same process. */
export function contractRevertReason(error: unknown): string | undefined {
  const seen = new Set<object>();
  let cause = error;
  while (cause && typeof cause === "object" && !seen.has(cause) && seen.size < 16) {
    seen.add(cause);
    const node = cause as { name?: unknown; data?: { errorName?: unknown }; cause?: unknown };
    const name = node.data?.errorName;
    if (node.name === "ContractFunctionRevertedError" && typeof name === "string" && known.has(name)) return name;
    cause = node.cause;
  }
  return undefined;
}
