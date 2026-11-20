import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export { createApp } from "./app.js";
export { openDatabase } from "./db.js";
export { walletLinkAuthorizationMessage } from "./proof.js";
export { createChain } from "./chain.js";
export const COMPONENT = "@agentpay/scorer" as const;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { startScorer } = await import("./server.js");
  startScorer(process.env);
}
