import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentPayBuyer, createFileBuyerStore, type BuyerOptions, type BuyerStore } from "@agentpay/buyer";
import { CHAIN_ID, DEPLOYMENTS, LIMITS, Outcome, SessionState, ZERO_ADDRESS, agentPaySessionEscrowAbi, bodyHash } from "@agentpay/core";
import { decryptKeystore } from "@ethersproject/json-wallets";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, isAddress, isAddressEqual, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { createAgentPayMcp, parseUsd, type BuyerStatus } from "./server.js";

const usdcAbi = parseAbi(["function usdc() view returns (address)"]);

export function createBuyerStatus(options: {
  publicClient: BuyerOptions["publicClient"];
  buyer: Address;
  escrow: Address;
  chainId: number;
  store: BuyerStore;
}): (id?: string) => Promise<BuyerStatus> {
  const { publicClient, buyer, escrow, chainId, store } = options;
  return async id => {
    const [asset, policy, saved] = await Promise.all([
      publicClient.readContract({ address: escrow, abi: usdcAbi, functionName: "usdc" }),
      publicClient.readContract({ address: escrow, abi: agentPaySessionEscrowAbi, functionName: "buyerPolicy", args: [buyer] }),
      id === undefined ? store.list() : store.get(id).then(value => value ? [value] : []),
    ]);
    const owned = saved.filter(session => isAddressEqual(session.buyer, buyer) &&
      session.payment.extensions.agentpay.session.chainId === chainId &&
      isAddressEqual(session.payment.extensions.agentpay.session.contract, escrow));
    const [balance, sessions] = await Promise.all([
      publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [buyer] }),
      Promise.all(owned.map(async session => {
        const chain = await publicClient.readContract({
          address: escrow, abi: agentPaySessionEscrowAbi, functionName: "getSession", args: [BigInt(session.id)],
        });
        if (!isAddressEqual(chain.buyer, buyer) || (id === undefined && chain.state !== SessionState.OPEN)) return undefined;
        const authorized = BigInt(session.requests.at(-1)?.voucher.message.cumulativeAmount ?? 0);
        const used = authorized > chain.cumulativeAmount ? authorized : chain.cumulativeAmount;
        return { sessionId: session.id, state: SessionState[chain.state] ?? "UNKNOWN", expiry: chain.expiry.toString(),
          capUsdc: formatUnits(chain.cap, 6), usedUsdc: formatUnits(used, 6) };
      })),
    ]);
    const registered = !isAddressEqual(policy.admin, ZERO_ADDRESS);
    return { balanceUsdc: formatUnits(balance, 6), sessions: sessions.filter(session => session !== undefined), policy: {
      admin: policy.admin, maxPerSessionUsdc: formatUnits(registered ? policy.maxPerSession : LIMITS.DEFAULT_MAX_PER_SESSION, 6),
      dailyCapUsdc: formatUnits(policy.dailyCap, 6), minScore: policy.minScore, paused: policy.paused,
      sellerAllowlistOn: policy.sellerAllowlistOn,
    } };
  };
}

async function credentials(env: NodeJS.ProcessEnv) {
  const path = env.AGENTPAY_KEYSTORE_PATH;
  if (path && env.AGENTPAY_AGENT_KEY) throw new Error("Select one credential source");
  const password = env.AGENTPAY_KEYSTORE_PASSWORD;
  const key = path ? (await decryptKeystore(await readFile(path, "utf8"), password ?? "")).privateKey : env.AGENTPAY_AGENT_KEY;
  if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("Agent credential missing or invalid");
  const raw = key.slice(2);
  const bytes = Buffer.from(raw, "hex");
  const secrets = [key, raw, key.toLowerCase(), raw.toLowerCase(), key.toUpperCase(), "0x" + raw.toUpperCase(), raw.toUpperCase(),
    bytes.toString("base64"), bytes.toString("base64url"), password];
  if (path) {
    for (const variant of [path, resolve(path)]) {
      secrets.push(variant, variant.replaceAll("\\", "/"), pathToFileURL(variant).href);
    }
  }
  return { account: privateKeyToAccount(key as Address), redact: secrets.filter((value): value is string => Boolean(value)) };
}

function amount(value: string): bigint {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value) || Number(value) <= 0) throw new Error("Invalid USDC limit");
  return parseUsd(value);
}

const supportsFile: NonNullable<BuyerOptions["supportsSpec"]> = spec =>
  spec.serviceType === "file" && spec.checks.length > 0 && spec.checks.every(check => check.type === "hash-match");

const fileChecks: BuyerOptions["checks"] = ({ spec, body, contentType }) => {
  const hash = bodyHash(body);
  return supportsFile(spec) && contentType.split(";", 1)[0]?.toLowerCase() === spec.delivery.contentType &&
    spec.checks.every(check => check.type === "hash-match" && check.expectedHash.toLowerCase() === hash)
    ? Outcome.PASS : Outcome.FAIL;
};

export async function createAgentPayMcpFromEnv(env: NodeJS.ProcessEnv, clock: () => number) {
  const { account, redact } = await credentials(env);
  const escrow = env.AGENTPAY_ESCROW ?? DEPLOYMENTS.fuji.escrow;
  const rpc = env.FUJI_RPC_URL_1;
  const facilitatorUrl = env.FACILITATOR_URL;
  const scorerUrl = env.SCORER_URL;
  if (!isAddress(escrow) || !rpc || !facilitatorUrl || !scorerUrl) throw new Error("AgentPay connection settings missing");
  const transport = http(rpc);
  const chain = avalancheFuji;
  const publicClient = createPublicClient({ chain, transport });
  if (await publicClient.getChainId() !== CHAIN_ID.fuji) throw new Error("RPC chain is not Fuji");
  const walletClient = createWalletClient({ account, chain, transport });
  const store = createFileBuyerStore(env.AGENTPAY_SESSION_DIR);
  const adapter = env.AGENTPAY_CHECKS_MODULE
    ? await import(pathToFileURL(resolve(env.AGENTPAY_CHECKS_MODULE)).href) as { checks: BuyerOptions["checks"]; supportsSpec?: BuyerOptions["supportsSpec"] }
    : { checks: fileChecks, supportsSpec: supportsFile };
  if (typeof adapter.checks !== "function") throw new Error("Missing checks adapter export");
  const buyer = createAgentPayBuyer({ mode: "auto", chainId: chain.id, account, publicClient, walletClient, trustedEscrows: [escrow],
    facilitatorUrl, scorerUrl, clock, store, checks: adapter.checks, supportsSpec: adapter.supportsSpec,
    defaultCap: amount(env.AGENTPAY_DEFAULT_CAP_USD ?? "1"), defaultExpirySec: 3600,
    softPolicy: { maxPerSession: amount(env.AGENTPAY_MAX_CAP_USD ?? "1"), maxPricePerRequest: amount(env.AGENTPAY_MAX_PRICE_USD ?? "0.01") },
  });
  return createAgentPayMcp({ buyer, redact, status: createBuyerStatus({ publicClient, buyer: account.address, escrow, chainId: chain.id, store }) });
}
