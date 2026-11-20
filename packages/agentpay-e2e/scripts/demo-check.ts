/**
 * Pre-recording check for the Fuji demo video. Read-only except one call that turns the
 * seller fault switch OFF (the demo turns it on at request 16 and off again at the end).
 * Usage: pnpm --filter @agentpay/e2e demo:check [--buyer 0x...] [--skip-daily]   (default buyer: BUYER_MAIN_ADDRESS)
 * --skip-daily: scene 7 only (policy rejections never touch the daily allowance).
 */
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createPublicClient, fallback, formatEther, formatUnits, http, isAddress, parseAbi, zeroAddress, type Address } from "viem";
import { avalancheFuji } from "viem/chains";
import { DEPLOYMENTS, LIMITS, agentPaySessionEscrowAbi } from "@agentpay/core";

const fileEnv = await readFile(new URL("../../../.env", import.meta.url), "utf8").then(parseEnv).catch(() => ({}));
const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
const arg = process.argv.indexOf("--buyer");
const buyer = (arg > 0 ? process.argv[arg + 1] : env.BUYER_MAIN_ADDRESS) as Address | undefined;

const d = DEPLOYMENTS.fuji;
const client = createPublicClient({
  chain: avalancheFuji,
  transport: fallback([env.FUJI_RPC_URL_2, env.FUJI_RPC_URL_1].filter((u): u is string => Boolean(u)).map(u => http(u, { timeout: 10_000 }))),
});
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const rows: { ok: boolean; item: string; detail: string }[] = [];
const check = async (item: string, run: () => Promise<[boolean, string]>) => {
  try {
    const [ok, detail] = await run();
    rows.push({ ok, item, detail });
  } catch (error) {
    rows.push({ ok: false, item, detail: (error as Error).message.split("\n")[0]!.slice(0, 120) });
  }
};
const get = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json().catch(() => undefined) as any, ms: 0 };
};
const usdc = (a: Address) => client.readContract({ address: d.usdc, abi: erc20, functionName: "balanceOf", args: [a] });
const avax = (a: Address) => client.getBalance({ address: a });
const policy = (a: Address) => client.readContract({ address: d.escrow, abi: agentPaySessionEscrowAbi, functionName: "buyerPolicy", args: [a] });

await check("Fuji RPC", async () => [(await client.getChainId()) === 43113, `chain ${await client.getChainId()}`]);
await check(".env Escrow", async () => [env.AGENTPAY_ESCROW?.toLowerCase() === d.escrow.toLowerCase(), env.AGENTPAY_ESCROW ?? "missing"]);
await check("Verifier health", async () => {
  const { status, body } = await get(`${env.VERIFIER_URL}/health`);
  return [status === 200 && body?.ok && body.rpc?.fuji && body.rpc?.mainnet?.every(Boolean), `HTTP ${status} · rpc ${JSON.stringify(body?.rpc)}`];
});
await check("Facilitator /supported", async () => {
  const { status, body } = await get(`${env.FACILITATOR_URL}/supported`);
  return [status === 200 && JSON.stringify(body).includes("agentpay-session"), `HTTP ${status}`];
});
for (const [name, id, wantHigh] of [["Seller 306 score", "306", true], ["Low seller 337 score", env.LOW_SELLER_AGENT_ID ?? "337", false]] as const) {
  await check(name, async () => {
    const t = Date.now();
    const { body } = await get(`${env.SCORER_URL}/v1/score/${id}`);
    const ok = wantHigh ? body.score >= 30 : body.score < 30;
    return [ok, `score ${body.score} (needs ${wantHigh ? "≥" : "<"} 30) · ${Date.now() - t} ms`];
  });
}
await check("Scorer attestation speed", async () => {
  const t = Date.now();
  const { status } = await get(`${env.SCORER_URL}/v1/attestation/306?wallet=${env.SELLER_ADDRESS}`);
  const ms = Date.now() - t;
  return [status === 200 && ms < 5000, `HTTP ${status} · ${ms} ms (Buyer waits up to 10 s)`];
});
for (const [name, url] of [["Seller 306 402", env.SELLER_URL], ["Low seller 402", env.LOW_SCORE_SELLER_URL]] as const) {
  await check(name, async () => {
    const { status, body } = await get(url!);
    const terms = body?.accepts?.[0]?.extra?.agentpay ?? body?.extensions?.agentpay;
    const https = String(body?.resource?.url ?? "").startsWith("https://");
    const verifier = JSON.stringify(body).includes(String(env.VERIFIER_URL));
    return [status === 402 && https && verifier, `HTTP ${status} · https ${https} · Fly Verifier in spec ${verifier}${terms ? "" : ""}`];
  });
}
await check("Seller fault switch OFF", async () => {
  const { status, body } = await get(new URL("/admin/fault", env.SELLER_URL).href, {
    method: "POST", headers: { authorization: `Bearer ${env.DEMO_FAULT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ on: false }),
  });
  return [status === 200 && body?.on === false, `HTTP ${status} · on=${body?.on}`];
});
await check("Session fee", async () => {
  const fee = await client.readContract({ address: d.escrow, abi: parseAbi(["function sessionFee() view returns (uint128)"]), functionName: "sessionFee" });
  return [fee === 50_000n, `${formatUnits(fee, 6)} USDC (video lines assume 0.05)`];
});
if (buyer && isAddress(buyer)) {
  await check(`MetaMask buyer ${buyer.slice(0, 8)}… funds`, async () => {
    const [u, a] = await Promise.all([usdc(buyer), avax(buyer)]);
    return [u >= 1_000_000n && a >= 10n ** 16n, `${formatUnits(u, 6)} USDC · ${formatEther(a).slice(0, 6)} AVAX (needs ≥ 1 USDC, ≥ 0.01 AVAX)`];
  });
  await check(`MetaMask buyer rules (scene 2)`, async () => {
    const p = await policy(buyer);
    if (p.admin === zeroAddress) return [true, "not registered yet → register $5 · $10 · 30 on the Dashboard in scene 2"];
    const ok = p.maxPerSession >= 1_000_000n && p.minScore <= 45 && !p.paused;
    return [ok, `registered: ${formatUnits(p.maxPerSession, 6)}/session · ${formatUnits(p.dailyCap, 6)}/day · minScore ${p.minScore}${p.paused ? " · PAUSED" : ""} → skip registering in scene 2`];
  });
  if (!process.argv.includes("--skip-daily")) await check(`MetaMask buyer daily allowance`, async () => {
    // Every take locks the 1 USDC cap from the daily bucket, even though most of it is refunded.
    const left = await client.readContract({ address: d.escrow, abi: agentPaySessionEscrowAbi, functionName: "availableDaily", args: [buyer] });
    const registered = (await policy(buyer)).admin !== zeroAddress;
    return [!registered || left >= 1_000_000n, registered
      ? `${formatUnits(left, 6)} USDC left today → ~${left / 1_000_000n} more take(s)`
      : "full 10 USDC/day after registering (~9 takes)"];
  });
} else rows.push({ ok: false, item: "MetaMask buyer", detail: "set BUYER_MAIN_ADDRESS or pass --buyer 0x..." });
await check("buyer-auto (scene 7) rules + funds", async () => {
  const a = env.BUYER_AUTO_ADDRESS as Address;
  const [p, u, g] = await Promise.all([policy(a), usdc(a), avax(a)]);
  const ok = p.admin !== zeroAddress && p.maxPerSession < LIMITS.DEFAULT_MAX_PER_SESSION && p.minScore >= 30 && g >= 10n ** 16n;
  return [ok, `${formatUnits(p.maxPerSession, 6)}/session · minScore ${p.minScore} · ${formatUnits(u, 6)} USDC · ${formatEther(g).slice(0, 6)} AVAX`];
});
for (const name of ["VERIFIER", "FACILITATOR", "KEEPER", "SELLER"]) {
  await check(`${name.toLowerCase()} gas`, async () => {
    const g = await avax(env[`${name}_ADDRESS`] as Address);
    return [g >= 3n * 10n ** 16n, `${formatEther(g).slice(0, 6)} AVAX (needs ≥ 0.03)`];
  });
}

const width = Math.max(...rows.map(r => r.item.length));
for (const r of rows) console.log(`${r.ok ? "✅" : "❌"} ${r.item.padEnd(width)}  ${r.detail}`);
const failed = rows.filter(r => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed — fix before recording.` : "\nAll checks passed — ready to record.");
process.exitCode = failed ? 1 : 0;
