import { useEffect, useState } from "react";
import { createClient, loadConfig, type DashboardClient } from "./client.js";
import { useWallet } from "./hooks.js";
import { Rules } from "./pages/Rules.js";
import { Live } from "./pages/Live.js";
import { short } from "./model.js";
import "./style.css";

type Theme = "light" | "dark";
function savedTheme(): Theme | undefined {
  try { const v = localStorage.getItem("agentpay-theme"); return v === "light" || v === "dark" ? v : undefined; } catch { return undefined; }
}
function systemTheme(): Theme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function Mark() {
  return <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" fill="#e84142" /><path d="M12 5 19 12 12 19 5 12Z" fill="none" stroke="#fff" strokeWidth="2" /><path d="M12 9.5 14.5 12 12 14.5 9.5 12Z" fill="#fff" /></svg>;
}

export function App() {
  const [client, setClient] = useState<DashboardClient>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState("rules");
  const [theme, setTheme] = useState<Theme | undefined>(savedTheme);
  const wallet = useWallet();
  useEffect(() => { void loadConfig().then(c => setClient(createClient(c))).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (theme) document.documentElement.dataset.theme = theme; }, [theme]);
  function toggleTheme() {
    const next: Theme = (theme ?? systemTheme()) === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("agentpay-theme", next); } catch { /* per-viewer convenience only */ }
  }
  const dark = (theme ?? systemTheme()) === "dark";
  return <div className="frame">
    <header>
      <a href="#" className="brand"><Mark /><span>AgentPay</span><span className="brand-tag">Fuji</span></a>
      <span className="divider" />
      <nav aria-label="Trang chính">
        <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>Luật người mua</button>
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>Theo dõi phiên</button>
      </nav>
      <div className="header-right">
        <span className="network"><span className="dot" />{client?.config.local ? "Anvil cục bộ" : "Avalanche Fuji"}</span>
        <button className="theme" onClick={toggleTheme} aria-label={dark ? "Giao diện sáng" : "Giao diện tối"} title={dark ? "Giao diện sáng" : "Giao diện tối"}>
          {dark
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></svg>}
        </button>
        <button className="wallet" onClick={() => void wallet.connect()}>{wallet.account ? short(wallet.account) : "Kết nối ví"}</button>
      </div>
    </header>
    <main>
      {(error || wallet.error) && <p role="alert" className="error">{error || wallet.error}</p>}
      {wallet.account && wallet.chainId !== 43113 && <div role="alert" className="warning">Ví đang ở mạng khác. Chuyển sang Fuji để gửi giao dịch.<button onClick={() => void wallet.connect()}>Chuyển mạng Fuji</button></div>}
      {client && (tab === "rules" ? <Rules client={client} account={wallet.account} enabled={wallet.chainId === 43113} /> : <Live client={client} account={wallet.account} enabled={wallet.chainId === 43113} />)}
    </main>
    <footer><span>AgentPay v0.2 · Escrow {client ? short(client.config.escrow) : "…"}</span><span>Chain 43113 · USDC · Mỗi giao dịch đều cần ví xác nhận</span></footer>
  </div>;
}
