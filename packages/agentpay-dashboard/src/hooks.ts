import { useEffect, useState } from "react";
import type { Address } from "viem";

export function useWallet() {
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [error, setError] = useState("");
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;
    const accounts = (a: string[]) => setAccount(a[0] as Address | undefined);
    const chain = (id: string) => setChainId(Number(id));
    void provider.request({ method: "eth_accounts" }).then(accounts).catch(() => {});
    void provider.request({ method: "eth_chainId" }).then(chain).catch(() => {});
    provider.on("accountsChanged", accounts); provider.on("chainChanged", chain);
    return () => { provider.removeListener("accountsChanged", accounts); provider.removeListener("chainChanged", chain); };
  }, []);
  async function connect() {
    try {
      setError("");
      if (!window.ethereum) throw new Error("Cài MetaMask hoặc mở bằng trình duyệt có ví EVM.");
      const addresses = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(addresses[0]);
      const id = Number(await window.ethereum.request({ method: "eth_chainId" }));
      setChainId(id);
      if (id !== 43113) {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa869" }] });
        setChainId(Number(await window.ethereum.request({ method: "eth_chainId" })));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Không thể kết nối ví."); }
  }
  return { account, chainId, connect, error };
}
export function useNow() {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(timer); }, []);
  return now;
}
