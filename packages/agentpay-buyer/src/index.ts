// Scaffold. Interfaces are frozen in @agentpay/core (types, eip712, hash, api). See AgentPay_SystemDesign.md.
export const COMPONENT = "@agentpay/buyer" as const;
export * from "./buyer.js";
export * from "./store.js";
export * from "./watcher.js";
export { BuyerReceiptError } from "./request.js";
export { BuyerSessionPolicyError } from "./open.js";
export { BuyerApprovalError, type ApprovalCode } from "./approve/server.js";
