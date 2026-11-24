import { useEffect, useRef, useState } from "react";
import { createClient, loadConfig, type DashboardClient } from "./client.js";
import { useWallet } from "./hooks.js";
import { Rules } from "./pages/Rules.js";
import { Live } from "./pages/Live.js";
import { Overview } from "./pages/Overview.js";
import { short } from "./model.js";
import "./style.css";

type Theme = "light" | "dark";
const TABS = [["overview", "Tổng quan"], ["live", "Theo dõi phiên"], ["rules", "Luật người mua"]] as const;
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
  const [tab, setTab] = useState(() => location.hash.slice(1) || "overview");
  const [session, setSession] = useState<string>();
  useEffect(() => { history.replaceState(null, "", `#${tab}`); }, [tab]);
  function openSession(id: string) { setSession(id); setTab("live"); window.scrollTo(0, 0); }
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
      <a href="#overview" className="brand" onClick={e => { e.preventDefault(); setTab("overview"); }}><Mark /><span>AgentPay</span><span className="brand-tag">Fuji</span></a>
      <span className="divider" />
      <nav aria-label="Trang chính">
        {TABS.map(([key, label]) => <button key={key} className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
      <div className="header-right">
        <span className="network"><span className="dot" />{client?.config.local ? "Anvil cục bộ" : "Avalanche Fuji"}</span>
        <button className="theme" onClick={toggleTheme} aria-label={dark ? "Giao diện sáng" : "Giao diện tối"} title={dark ? "Giao diện sáng" : "Giao diện tối"}>
          {dark
            ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></svg>}
        </button>
        {wallet.account ? <WalletMenu account={wallet.account} wrongChain={wallet.chainId !== 43113} onSwitch={() => void wallet.switchAccount()} onFuji={() => void wallet.connect()} onDisconnect={() => void wallet.disconnect()} />
          : <button className="wallet" onClick={() => void wallet.connect()}>Kết nối ví</button>}
      </div>
    </header>
    <main>
      {(error || wallet.error) && <p role="alert" className="error">{error || wallet.error}</p>}
      {wallet.account && wallet.chainId !== 43113 && <div role="alert" className="warning">Ví đang ở mạng khác. Chuyển sang Fuji để gửi giao dịch.<button onClick={() => void wallet.connect()}>Chuyển mạng Fuji</button></div>}
      {client && tab === "overview" && <Overview client={client} openSession={openSession} go={setTab} />}
      {client && tab === "rules" && <Rules client={client} account={wallet.account} enabled={wallet.chainId === 43113} />}
      {client && tab === "live" && <Live key={session ?? "follow"} client={client} account={wallet.account} enabled={wallet.chainId === 43113} initial={session} />}
      {!client && !error && <p role="status">Đang kết nối Avalanche Fuji…</p>}
    </main>
    <footer><span>AgentPay · Nhóm GlobalHost · BK Fintech Hackday S15</span><span>Escrow {client ? (client.config.local ? short(client.config.escrow) : <a href={`https://testnet.snowtrace.io/address/${client.config.escrow}`} target="_blank" rel="noreferrer">{short(client.config.escrow)}</a>) : "…"} · Chain 43113 · USDC</span></footer>
  </div>;
}

function WalletMenu({ account, wrongChain, onSwitch, onFuji, onDisconnect }: { account: string; wrongChain: boolean; onSwitch: () => void; onFuji: () => void; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  async function copy() {
    try { await navigator.clipboard.writeText(account); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }
  return <div className="wallet-menu" ref={ref}>
    <button className="wallet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <span className={wrongChain ? "dot dot-warn" : "dot"} />{short(account)}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
    {open && <div className="menu" role="menu">
      <div className="menu-head"><span>Ví đang kết nối</span><code>{account}</code></div>
      <button role="menuitem" onClick={() => void copy()}>{copied ? "Đã sao chép ✓" : "Sao chép địa chỉ"}</button>
      <a role="menuitem" href={`https://testnet.snowtrace.io/address/${account}`} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Xem trên Snowtrace ↗</a>
      {wrongChain && <button role="menuitem" onClick={pick(onFuji)}>Chuyển sang mạng Fuji</button>}
      <button role="menuitem" onClick={pick(onSwitch)}>Đổi ví khác</button>
      <button role="menuitem" className="menu-danger" onClick={pick(onDisconnect)}>Ngắt kết nối</button>
    </div>}
  </div>;
}
