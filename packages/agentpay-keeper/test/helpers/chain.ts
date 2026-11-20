/**
 * Test chain for keeper (and later E2E): spawns anvil, deploys mocks + BuyerRules + AgentPaySessionEscrow from
 * contracts/out (run `forge build` in contracts/ first), and offers helpers to open / close / challenge sessions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  http,
  keccak256,
  parseSignature,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry as foundryBase } from "viem/chains";
import { defineChain } from "viem";

// Chain object follows the anvil chain id chosen in startChain (set before any client is created).
let foundry = foundryBase as ReturnType<typeof defineChain>;
import {
  TYPES,
  agentPayDomain,
  agentPaySessionEscrowAbi,
  openNonce,
  scorerDomain,
  sessionId as computeSessionId,
  usdcDomain,
  type OpenParams,
} from "@agentpay/core";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../../contracts/out");

// Well-known anvil dev keys (public, test only)
export const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  verifier: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  scorer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  keeper: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const satisfies Record<string, Hex>;

export const AGENT_ID = 12n;
export const PRICE = 10_000n;
export const CAP = 1_000_000n;
export const SPEC = keccak256(toHex("spec"));

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> };
}

function artifact(file: string, name: string): Artifact {
  const p = join(OUT, file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p} — run \`forge build\` in contracts/`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function link(a: Artifact, libs: Record<string, Address>): Hex {
  let code = a.bytecode.object.slice(2);
  for (const [, byName] of Object.entries(a.bytecode.linkReferences)) {
    for (const [name, refs] of Object.entries(byName)) {
      const addr = libs[name];
      if (!addr) throw new Error(`no address for library ${name}`);
      for (const { start, length } of refs) {
        code = code.slice(0, start * 2) + addr.slice(2).toLowerCase() + code.slice((start + length) * 2);
      }
    }
  }
  return `0x${code}`;
}

function anvilBin(): string {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const local = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
  return existsSync(local) ? local : "anvil";
}

export interface TestChain {
  rpc: string;
  publicClient: PublicClient;
  accounts: Record<keyof typeof KEYS, PrivateKeyAccount>;
  escrow: Address;
  usdc: Address;
  stop(): Promise<void>;
  wallet(who: keyof typeof KEYS, transport?: ReturnType<typeof custom>): ReturnType<typeof walletFor>;
  now(): Promise<bigint>;
  advance(seconds: number): Promise<void>;
  open(overrides?: Partial<OpenParams>): Promise<bigint>;
  close(sid: bigint, lastSeq: number, pass: number, fail: number): Promise<void>;
  challengeByBuyer(sid: bigint): Promise<void>;
  state(sid: bigint): Promise<number>;
}

function walletFor(rpc: string, account: PrivateKeyAccount, transport?: ReturnType<typeof custom>) {
  return createWalletClient({ chain: foundry, transport: transport ?? http(rpc), account });
}

/** chainId 43113 lets services that hard-code Fuji (e.g. the Facilitator's USDC domain) run against anvil. */
export async function startChain(opts: { chainId?: number } = {}): Promise<TestChain> {
  const anvilChainId = opts.chainId ?? 31337;
  foundry = defineChain({ ...foundryBase, id: anvilChainId });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpc = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(anvilBin(), ["--port", String(port), "--silent", "--chain-id", String(anvilChainId)], {
    stdio: "ignore",
  });
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpc) });
  const accounts = Object.fromEntries(
    Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)]),
  ) as TestChain["accounts"];
  const owner = walletFor(rpc, accounts.owner);

  async function deploy(a: Artifact, args: unknown[] = [], libs: Record<string, Address> = {}): Promise<Address> {
    const hash = await owner.deployContract({ abi: a.abi, bytecode: link(a, libs), args });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  }
  async function write(addr: Address, abi: Abi, fn: string, args: unknown[], who = owner) {
    const hash = await who.writeContract({ address: addr, abi, functionName: fn, args, chain: foundry, account: who.account });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
  }

  const usdcA = artifact("MockUSDC3009.sol", "MockUSDC3009");
  const repA = artifact("Mock8004.sol", "MockReputation8004");
  const idA = artifact("Mock8004.sol", "MockIdentity8004");
  const libA = artifact("BuyerRules.sol", "BuyerRules");
  const escA = artifact("AgentPaySessionEscrow.sol", "AgentPaySessionEscrow");

  const usdc = await deploy(usdcA);
  const rep = await deploy(repA);
  const idr = await deploy(idA);
  const lib = await deploy(libA);
  const escrow = await deploy(
    escA,
    [usdc, idr, rep, accounts.owner.address, accounts.scorer.address, accounts.owner.address, accounts.owner.address, 40_000n, 50],
    { BuyerRules: lib },
  );
  await write(escrow, agentPaySessionEscrowAbi as Abi, "addVerifier", [accounts.verifier.address, 1_000_000_000n]);
  await write(idr, idA.abi, "setAgentWallet", [AGENT_ID, accounts.seller.address]);
  await write(usdc, usdcA.abi, "mint", [accounts.buyer.address, 1_000_000_000n]);

  const chainId = await publicClient.getChainId();
  let saltN = 0n;

  const now = async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

  async function authFor(from: PrivateKeyAccount, value: bigint, nonce: Hex, validBefore: bigint) {
    const sig = await from.signTypedData({
      domain: usdcDomain(chainId, usdc),
      types: TYPES.ReceiveWithAuthorization,
      primaryType: "ReceiveWithAuthorization",
      message: { from: from.address, to: escrow, value, validAfter: 0n, validBefore, nonce },
    });
    const { v, r, s } = parseSignature(sig);
    return { from: from.address, value, validAfter: 0n, validBefore, nonce, v: Number(v), r, s };
  }

  const chain: TestChain = {
    rpc,
    publicClient,
    accounts,
    escrow,
    usdc,
    async stop() {
      proc.kill();
    },
    wallet: (who, transport) => walletFor(rpc, accounts[who], transport),
    now,
    async advance(seconds) {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    },
    async open(overrides = {}) {
      const t = await now();
      const p: OpenParams = {
        seller: accounts.seller.address,
        sellerAgentId: AGENT_ID,
        verifier: accounts.verifier.address,
        voucherSigner: accounts.buyer.address,
        specHash: SPEC,
        cap: CAP,
        pricePerRequest: PRICE,
        expiry: t + 3_600n,
        deliveryDeadlineSec: 10,
        challengeWindowSec: 60,
        ...overrides,
      };
      const salt = keccak256(toHex(`salt-${++saltN}-${port}`));
      const nonce = openNonce(p, salt);
      const att = { agentId: AGENT_ID, wallet: accounts.seller.address, score: 80, flags: 0, validUntil: t + 3_000n };
      const attSig = await accounts.scorer.signTypedData({
        domain: scorerDomain(chainId, escrow),
        types: TYPES.ScoreAttestation,
        primaryType: "ScoreAttestation",
        message: att,
      });
      const auth = await authFor(accounts.buyer, p.cap, nonce, t + 120n);
      await write(escrow, agentPaySessionEscrowAbi as Abi, "openWithAuthorization", [p, salt, auth, att, attSig]);
      return computeSessionId(accounts.buyer.address, nonce);
    },
    async close(sid, lastSeq, pass, fail) {
      const domain = agentPayDomain(chainId, escrow);
      const voucher = { sessionId: sid, seq: lastSeq, cumulativeAmount: BigInt(lastSeq) * PRICE, requestHash: SPEC };
      const vs = await accounts.buyer.signTypedData({ domain, types: TYPES.Voucher, primaryType: "Voucher", message: voucher });
      const verdict = {
        sessionId: sid,
        specHash: SPEC,
        lastSeq,
        passCount: pass,
        failCount: fail,
        inconclusiveCount: 0,
        passedAmount: BigInt(pass) * PRICE,
        receiptsRoot: SPEC,
        closedAt: await now(),
      };
      const ds = await accounts.verifier.signTypedData({
        domain,
        types: TYPES.SessionVerdict,
        primaryType: "SessionVerdict",
        message: verdict,
      });
      await write(escrow, agentPaySessionEscrowAbi as Abi, "closeSession", [sid, voucher, vs, verdict, ds], walletFor(rpc, accounts.verifier));
    },
    async challengeByBuyer(sid) {
      const bond = (await publicClient.readContract({
        address: escrow,
        abi: agentPaySessionEscrowAbi,
        functionName: "requiredBond",
        args: [sid, accounts.buyer.address],
      })) as bigint;
      const auth = await authFor(accounts.buyer, bond, keccak256(toHex(`bond-${sid}`)), (await now()) + 120n);
      await write(escrow, agentPaySessionEscrowAbi as Abi, "challenge", [sid, 1, auth], walletFor(rpc, accounts.buyer));
    },
    async state(sid) {
      const s = await publicClient.readContract({
        address: escrow,
        abi: agentPaySessionEscrowAbi,
        functionName: "getSession",
        args: [sid],
      });
      return s.state;
    },
  };
  return chain;
}
