import { CHAIN_ID, TYPES, agentPayDomain, usdcDomain } from "@agentpay/core";
import { formatUnits, getTypesForEIP712Domain, isAddressEqual, parseUnits, type Address } from "viem";
import { checkParams, type ApprovalParams, type OpenReview } from "./params.js";

interface Ethereum {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}
class ReviewError extends Error {}
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const fields = document.querySelector("dl")!;
const specPanel = document.querySelector("details")!;
const spec = document.querySelector("pre")!;
const status = document.querySelector("[role=status]")!;
const approve = document.querySelector<HTMLButtonElement>("#approve")!;
const deny = document.querySelector<HTMLButtonElement>("#deny")!;
const authorization = { Authorization: `Bearer ${token}` };

function values(review: ApprovalParams): Record<string, string> {
  const base = { Wallet: review.buyer, Escrow: review.escrow, Network: "Avalanche Fuji (43113)" };
  if (review.kind === "close") return { Session: review.sessionId, ...base };
  const p = review.params;
  return {
    Seller: p.seller, "Agent ID": p.sellerAgentId, "Reputation score": String(review.score), Domain: review.domain,
    "Price (USDC)": formatUnits(BigInt(p.pricePerRequest), 6), "Cap (USDC)": formatUnits(BigInt(p.cap), 6),
    "Protection fee (USDC)": formatUnits(BigInt(review.fee), 6), "Expiry (UTC)": new Date(Number(p.expiry) * 1000).toISOString(),
    Verifier: p.verifier, "Verifier endpoint": review.spec.verifier.endpoint, "Voucher signer": p.voucherSigner,
    "Delivery deadline (seconds)": String(p.deliveryDeadlineSec), "Challenge window (seconds)": String(p.challengeWindowSec),
    "USDC contract": review.asset, ...base,
  };
}

function shown(label: string): string {
  return [...fields.querySelectorAll("dd")].find(term => term.dataset.field === label)?.textContent ?? "";
}

function readOpen(review: OpenReview) {
  return {
    salt: review.salt, spec: JSON.parse(spec.textContent!),
    params: { ...review.params,
      seller: shown("Seller") as Address, sellerAgentId: shown("Agent ID"), verifier: shown("Verifier") as Address,
      voucherSigner: shown("Voucher signer") as Address, cap: parseUnits(shown("Cap (USDC)"), 6).toString(),
      pricePerRequest: parseUnits(shown("Price (USDC)"), 6).toString(),
      expiry: BigInt(Date.parse(shown("Expiry (UTC)")) / 1000).toString(),
      deliveryDeadlineSec: Number(shown("Delivery deadline (seconds)")), challengeWindowSec: Number(shown("Challenge window (seconds)")),
    },
  };
}

function check(review: ApprovalParams): boolean {
  try {
    return review.chainId === CHAIN_ID.fuji && Object.entries(values(review)).every(([label, value]) => shown(label) === value) &&
      (review.kind === "close" || checkParams(readOpen(review), review.nonce));
  } catch {
    return false;
  }
}

async function getParams() {
  const result = await fetch("/params", { headers: authorization });
  if (!result.ok) throw new ReviewError("Approval is unavailable or has expired.");
  return await result.json() as ApprovalParams;
}

async function submit(payload: object) {
  const result = await fetch("/signature", {
    method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!result.ok) throw new ReviewError("AgentPay rejected the approval response.");
}

async function main() {
  const review = await getParams();
  const opening = review.kind === "open";
  document.querySelector("h1")!.textContent = opening ? "Review AgentPay session" : "Close AgentPay session";
  approve.textContent = opening ? "Approve in MetaMask" : "Confirm close in MetaMask";
  for (const [label, value] of Object.entries(values(review))) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    description.dataset.field = label;
    fields.append(term, description);
  }
  if (opening) {
    specPanel.hidden = false;
    specPanel.querySelector("summary")!.textContent =
      `Verification spec · ${review.spec.serviceType} · ${review.spec.checks.map(check => check.type).join(", ")}`;
    spec.textContent = JSON.stringify(review.spec, null, 2);
  }

  approve.disabled = deny.disabled = false;
  deny.onclick = async () => {
    approve.disabled = deny.disabled = true;
    try {
      await submit({ rejected: true });
      status.textContent = "Approval declined.";
    } catch {
      status.textContent = "Approval is unavailable or has expired.";
    }
  };
  approve.onclick = async () => {
    approve.disabled = deny.disabled = true;
    try {
      if (!check(review)) throw new ReviewError("Displayed terms changed. AgentPay blocked signing.");
      const wallet = (window as Window & { ethereum?: Ethereum }).ethereum;
      if (!wallet) throw new ReviewError("Open this page in a browser with MetaMask.");
      const accounts = await wallet.request({ method: "eth_requestAccounts" }) as Address[];
      if (!accounts[0] || !isAddressEqual(accounts[0], review.buyer)) throw new ReviewError("Select the expected wallet in MetaMask.");
      const fuji = `0x${CHAIN_ID.fuji.toString(16)}`;
      if (await wallet.request({ method: "eth_chainId" }) !== fuji) {
        await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: fuji }] });
        if (await wallet.request({ method: "eth_chainId" }) !== fuji) throw new ReviewError("Switch MetaMask to Avalanche Fuji.");
      }
      const current = await getParams();
      if (!check(current) || current.kind !== review.kind ||
          (current.kind === "open" && review.kind === "open" && current.nonce !== review.nonce)) {
        throw new ReviewError("Displayed terms changed. AgentPay blocked signing.");
      }
      const domain = current.kind === "open"
        ? usdcDomain(current.chainId, current.asset) : agentPayDomain(current.chainId, current.escrow);
      const typed = current.kind === "open" ? {
        types: TYPES.ReceiveWithAuthorization, primaryType: "ReceiveWithAuthorization",
        message: { from: current.buyer, to: current.escrow, value: readOpen(current).params.cap,
          validAfter: "0", validBefore: current.validBefore, nonce: current.nonce },
      } : {
        types: TYPES.CloseRequest, primaryType: "CloseRequest",
        message: { sessionId: shown("Session"), deadline: current.validBefore },
      };
      const signature = await wallet.request({ method: "eth_signTypedData_v4", params: [current.buyer, JSON.stringify({
        ...typed, domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }), ...typed.types },
      })] });
      await submit({ signature, validBefore: current.validBefore });
      status.textContent = "Signature sent to AgentPay. You can close this tab.";
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === 4001) {
        await submit({ rejected: true }).catch(() => {});
        status.textContent = "Approval declined in MetaMask.";
      } else {
        status.textContent = error instanceof ReviewError ? error.message : "MetaMask did not complete approval. Check the wallet and Fuji network.";
        approve.disabled = deny.disabled = false;
      }
    }
  };
}

void main().catch(() => { status.textContent = "Approval link is invalid or has expired."; });
