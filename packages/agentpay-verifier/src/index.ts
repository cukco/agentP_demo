import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startVerifier } from "./server.js";

export { createApp } from "./app.js";
export const COMPONENT = "@agentpay/verifier" as const;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startVerifier(process.env);
}
