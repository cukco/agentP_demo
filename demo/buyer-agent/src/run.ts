import { BuyerReceiptError, BuyerSessionPolicyError, type AgentPayBuyer } from "@agentpay/buyer";
import { Outcome, ReasonCode, ROUTES, type SessionStatusResponse, type VerifyResponse } from "@agentpay/core";
import { FAULT_PATH, type PriceResponse } from "@agentpay-demo/seller-avax-price";
import { formatUnits } from "viem";

const ONE_USDC = 1_000_000n;
const TWENTY_USDC = 20_000_000n;

export function faultSwitch(sellerUrl: string, token: string, fetcher: typeof fetch = fetch) {
  const url = new URL(FAULT_PATH, sellerUrl);
  return async (on: boolean) => {
    const response = await fetcher(url, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ on }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.json()).on !== on) throw new Error("Seller fault switch failed");
  };
}

export async function runPaidDemo(deps: {
  buyer: AgentPayBuyer;
  sellerUrl: string;
  calls: number;
  setFault: (on: boolean) => Promise<void>;
  waitForSettlement: (sessionId: string) => Promise<void>;
  referencePrice?: () => number | undefined;
  /** Called right before request 1, e.g. to open the Verifier's mainnet oracle connections. */
  warmUp?: () => Promise<void>;
  log: (text: string) => void;
}): Promise<string> {
  const { buyer, sellerUrl, calls, setFault, log } = deps;
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > 18) throw new Error("Expected 1–18 demo calls");
  await setFault(false);
  const sessionId = await buyer.openSession(sellerUrl, { cap: ONE_USDC, expirySec: 3600 });
  log(`Opened session ${sessionId} with a 1 USDC cap`);
  await deps.warmUp?.().catch(() => {});
  let faulted = false;
  let seq = 0;
  try {
    for (let call = 1; call <= calls; call++) {
      if (call === 16) {
        faulted = true;
        await setFault(true);
        log("Seller fault enabled: quote is now 20% above Chainlink");
      }
      for (let attempt = 0; ; attempt++) {
        seq++;
        try {
          const { receipt, response } = await buyer.fetchWithReceipt(sellerUrl, undefined, ONE_USDC);
          if (!receipt || receipt.sessionId !== sessionId || receipt.seq !== seq || receipt.outcome !== Outcome.PASS ||
              receipt.reasonCode !== ReasonCode.PASS || call > 15) throw new Error(`Unexpected Receipt at request ${seq}`);
          const price = (await response.json() as PriceResponse).price;
          const reference = deps.referencePrice?.();
          log(`#${call} PASS · AVAX/USD ${price}${reference === undefined ? "" : ` · Chainlink ${reference}`} · ${formatUnits(BigInt(receipt.amount), 6)} USDC`);
          break;
        } catch (error) {
          if (!(error instanceof BuyerReceiptError)) throw error;
          const receipt = error.receipt.message;
          if (receipt.sessionId !== sessionId || receipt.seq !== seq || BigInt(receipt.amount) !== 0n) throw error;
          // The Verifier could not read Chainlink in time: INCONCLUSIVE is never charged, so ask again.
          if (receipt.outcome === Outcome.INCONCLUSIVE && receipt.reasonCode === ReasonCode.ORACLE_UNAVAILABLE && attempt < 3) {
            log(`#${call} INCONCLUSIVE · Chainlink chậm · 0 USDC · thử lại`);
            continue;
          }
          if (call <= 15 || receipt.outcome !== Outcome.FAIL || receipt.reasonCode !== ReasonCode.CHECK_ORACLE_DEVIATION) throw error;
          log(`#${call} FAIL · ORACLE_DEVIATION · 0 USDC`);
          break;
        }
      }
    }
  } finally {
    if (faulted) await setFault(false);
  }
  if (calls === 18) await deps.waitForSettlement(sessionId);
  return sessionId;
}

/** Ask the real Facilitator to simulate opening; this demo transport never submits settlement. */
export function verifyOnlyTransport(facilitatorUrl: string, fetcher: typeof fetch = fetch): typeof fetch {
  const root = facilitatorUrl.replace(/\/+$/, "");
  const settle = new URL(root + ROUTES.facilitator.settle()).href;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== settle) return fetcher(request);
    const response = await fetcher(root + ROUTES.facilitator.verify(), {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: await request.text(), signal: request.signal,
    });
    if (!response.ok) throw new Error("Could not simulate session on Facilitator");
    const payload = await response.json() as VerifyResponse;
    return Response.json({ success: false, errorReason: payload.isValid ? "UNEXPECTED_POLICY_PASS" : payload.invalidReason });
  };
}

export async function runInjection(deps: {
  buyer: AgentPayBuyer;
  sellerUrl: string;
  lowScoreSellerUrl: string;
  log: (text: string) => void;
}) {
  async function attempt(url: string, cap: bigint, code: BuyerSessionPolicyError["code"]) {
    try {
      await deps.buyer.openSession(url, { cap, expirySec: 3600 });
    } catch (error) {
      if (!(error instanceof BuyerSessionPolicyError) || error.code !== code) throw error;
      deps.log(`Policy rejected ${formatUnits(cap, 6)} USDC: ${code}`);
      return;
    }
    throw new Error(`Expected policy rejection: ${code}`);
  }
  await attempt(deps.sellerUrl, TWENTY_USDC, "OverPerSession");
  await attempt(deps.lowScoreSellerUrl, ONE_USDC, "BadScore");
}
