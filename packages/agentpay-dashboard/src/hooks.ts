import { useEffect, useState } from "react";
import type { Address } from "viem";

const OFF = "agentpay-wallet-off";
const FUJI = { chainId: "0xa869", chainName: "Avalanche Fuji C-Chain", nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: ["https://avalanche-fuji-c-chain-rpc.publicnode.com"], blockExplorerUrls: ["https://testnet.snowtrace.io"] };
function remembered(off: boolean) { try { if (off) localStorage.setItem(OFF, "1"); else localStorage.removeItem(OFF); } catch { /* per-viewer only */ } }
function isOff() { try { return localStorage.getItem(OFF) === "1"; } catch { return false; } }

export function useWallet() {
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [error, setError] = useState("");
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;
    // After "Ngắt kết nối" the site ignores the wallet until the user connects again.
    const accounts = (a: string[]) => setAccount(isOff() ? undefined : a[0] as Address | undefined);
    const chain = (id: string) => setChainId(Number(id));
    void provider.request({ method: "eth_accounts" }).then(accounts).catch(() => {});
    void provider.request({ method: "eth_chainId" }).then(chain).catch(() => {});
    provider.on("accountsChanged", accounts); provider.on("chainChanged", chain);
    return () => { provider.removeListener("accountsChanged", accounts); provider.removeListener("chainChanged", chain); };
  }, []);
  async function toFuji() {
    const provider = window.ethereum!;
    const id = Number(await provider.request({ method: "eth_chainId" }));
    setChainId(id);
    if (id === 43113) return;
    try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: FUJI.chainId }] }); }
    catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await provider.request({ method: "wallet_addEthereumChain", params: [FUJI] } as never);
    }
    setChainId(Number(await provider.request({ method: "eth_chainId" })));
  }
  async function connect() {
    try {
      setError("");
      if (!window.ethereum) throw new Error("Cài MetaMask hoặc mở bằng trình duyệt có ví EVM.");
      const addresses = await window.ethereum.request({ method: "eth_requestAccounts" });
      remembered(false); setAccount(addresses[0]);
      await toFuji();
    } catch (e) { setError(e instanceof Error ? e.message : "Không thể kết nối ví."); }
  }
  /** Ask the wallet to pick accounts again (MetaMask shows its account chooser). */
  async function switchAccount() {
    try {
      setError("");
      if (!window.ethereum) throw new Error("Cài MetaMask hoặc mở bằng trình duyệt có ví EVM.");
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] } as never);
      const addresses = await window.ethereum.request({ method: "eth_accounts" });
      remembered(false); setAccount(addresses[0]);
      await toFuji();
    } catch (e) {
      if ((e as { code?: number }).code === 4001) return; // user closed the chooser
      setError(e instanceof Error ? e.message : "Không đổi được ví.");
    }
  }
  async function disconnect() {
    remembered(true); setAccount(undefined); setError("");
    try { await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as never); }
    catch { /* older wallets: the local flag above is enough */ }
  }
  return { account, chainId, connect, switchAccount, disconnect, error };
}
export function useNow() {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(timer); }, []);
  return now;
}
