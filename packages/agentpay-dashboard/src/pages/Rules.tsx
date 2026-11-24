import { useEffect, useRef, useState } from "react";
import { isAddress, zeroAddress, type Address } from "viem";
import { type BuyerState, type ChainEvent, type DashboardClient } from "../client.js";
import { PolicyForm } from "../components/PolicyForm.js";
import { countdown, isTighter, money, short } from "../model.js";
import { useNow } from "../hooks.js";

export function Rules({ client, account, enabled }: { client: DashboardClient; account?: Address; enabled: boolean }) {
  const [input, setInput] = useState(account ?? "");
  const [buyer, setBuyer] = useState<Address | undefined>(account);
  const [state, setState] = useState<BuyerState>();
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState("");
  const [version, setVersion] = useState(0);
  const [adminInput, setAdminInput] = useState(account ?? "");
  const [agent, setAgent] = useState("");
  const [newAdmin, setNewAdmin] = useState("");
  const now = useNow();
  // Follow the connected wallet unless the user typed a different address.
  const lastAccount = useRef(account);
  useEffect(() => {
    const prev = lastAccount.current; lastAccount.current = account;
    if (!account) return;
    if (!buyer || buyer.toLowerCase() === prev?.toLowerCase()) { setBuyer(account); setInput(account); setAdminInput(account); setHash(""); setError(""); }
  }, [account, buyer]);
  useEffect(() => {
    if (!buyer) return;
    let active = true, inFlight = false;
    async function refresh() {
      if (inFlight) return; inFlight = true;
      try {
        // Show balances and rules as soon as they are read; the event history scan is slower.
        const s = await client.buyer(buyer!);
        if (active) setState(s);
        const logs = await client.events();
        if (active) setEvents(logs);
      } catch (e) { if (active) { setState(undefined); setError(e instanceof Error ? e.message : "Không đọc được luật."); } }
      finally { inFlight = false; }
    }
    setState(undefined); void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [client, buyer, version]);
  const registered = state && state.policy.admin !== zeroAddress;
  const isAdmin = !!account && !!state && account.toLowerCase() === state.policy.admin.toLowerCase();
  const isBuyer = !!account && !!buyer && account.toLowerCase() === buyer.toLowerCase();
  async function send(name: string, args: unknown[]) {
    if (!account || !enabled || busy) return;
    setBusy(true); setError(""); setHash("");
    try { setHash(await client.send(account, name, args)); setVersion(v => v + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Giao dịch thất bại."); }
    finally { setBusy(false); }
  }
  const logs = events.filter(e => String(e.args.buyer ?? "").toLowerCase() === buyer?.toLowerCase());
  const spent = logs.filter(e => e.name === "BuyerSpend" && now - e.time < 3600).reduce((s, e) => s + BigInt(String(e.args.amount ?? 0)), 0n);
  const validAgent = /^\d{1,78}$/.test(agent) && BigInt(agent) < 2n ** 256n;
  return <section>
    <div className="section-title"><div><p className="eyebrow">QUYỀN KIỂM SOÁT CỦA BẠN</p><h1>Luật người mua</h1><p>Đặt giới hạn trước khi agent bắt đầu chi tiêu.</p></div></div>
    <form className="address-form" onSubmit={e => { e.preventDefault(); if (isAddress(input, { strict: false })) { setBuyer(input); setHash(""); } else setError("Địa chỉ ví không hợp lệ."); }}>
      <label>Ví người mua<input value={input} onChange={e => setInput(e.target.value)} placeholder="0x…" required /></label><button className="secondary">Xem luật</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {busy && <p role="status">Đang chờ ví xác nhận và giao dịch hoàn tất…</p>}
    {hash && <p role="status">Giao dịch thành công {client.config.local ? short(hash) : <a href={`https://testnet.snowtrace.io/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)} ↗</a>}</p>}
    {!state && buyer && !error && <p role="status">Đang đọc dữ liệu trên chain…</p>}
    {state && <>
      <div className="stats"><article><span>USDC trong ví</span><strong>{money(state.balance)}</strong></article><article><span>Còn có thể chi hôm nay</span><strong>{registered ? money(state.available) : "Chưa đặt luật"}</strong></article><article><span>Trạng thái</span><strong className={state.policy.paused ? "bad" : "good"}>{state.policy.paused ? "Đang dừng" : registered ? "Đang hoạt động" : "Chưa đăng ký"}</strong></article></div>
      {state.loosen.effectiveAt > 0n && <div role="alert" className="warning"><strong>Đang chờ nới luật</strong><p>{countdown(state.loosen.effectiveAt, now)} · Hạn phiên mới {money(state.loosen.policy.maxPerSession)} · Hạn ngày {money(state.loosen.policy.dailyCap)}</p>
        {isAdmin && <button disabled={!enabled || busy} onClick={() => void send("cancelLoosen", [buyer])}>Hủy nới luật</button>}
        {Number(state.loosen.effectiveAt) <= now && <button disabled={!enabled || busy} onClick={() => void send("applyLoosen", [buyer])}>Áp dụng nới luật</button>}</div>}
      {state.admin.effectiveAt > 0n && <div role="alert" className="warning"><strong>Đang chờ đổi admin</strong><p>{short(state.admin.newAdmin)} · {countdown(state.admin.effectiveAt, now)}</p>
        {isAdmin && <button disabled={!enabled || busy} onClick={() => void send("cancelAdmin", [buyer])}>Hủy đổi admin</button>}
        {Number(state.admin.effectiveAt) <= now && <button disabled={!enabled || busy} onClick={() => void send("applyAdmin", [buyer])}>Áp dụng admin</button>}</div>}
      {registered && spent * 2n > state.policy.dailyCap && <div role="alert" className="warning">Đã chi {money(spent)} trong 1 giờ — vượt 50% hạn ngày.</div>}
      <div className="columns"><article className="card"><h2>{registered ? "Điều chỉnh giới hạn" : "Đăng ký luật cho ví"}</h2>
        {registered && <p>Admin: <code>{short(state.policy.admin)}</code> · Hạn phiên {money(state.policy.maxPerSession)} · Điểm ≥ {state.policy.minScore}</p>}
        {!registered && isBuyer && <label>Ví admin<input value={adminInput} onChange={e => setAdminInput(e.target.value)} /></label>}
        {(isAdmin || (!registered && isBuyer)) ? <PolicyForm key={`${buyer}:${version}`} current={registered ? state.policy : undefined} disabled={!enabled || busy}
          submit={async p => { if (!registered) { if (!isAddress(adminInput, { strict: false }) || adminInput === zeroAddress) throw new Error("Admin phải là địa chỉ ví hợp lệ."); await send("registerBuyer", [adminInput, p]); }
            else await send(isTighter(state.policy, p) ? "tighten" : "proposeLoosen", [buyer, p]); }} /> : <p>Kết nối ví {registered ? "admin" : "người mua"} để thay đổi luật.</p>}
      </article><article className="card"><h2>Kiểm soát khẩn cấp</h2><p>Dừng mua có hiệu lực ngay. Mở lại phải chờ 24 giờ.</p>
        <button className="danger" disabled={!enabled || busy || !(isAdmin || isBuyer) || !registered || state.policy.paused} onClick={() => void send("pauseBuyer", [buyer])}>Dừng người mua</button>
        {isAdmin && <><hr /><h3>Danh sách bên bán</h3><label>Agent ID<input value={agent} onChange={e => setAgent(e.target.value)} inputMode="numeric" /></label><div className="actions">
          <button disabled={!enabled || busy || !validAgent} onClick={() => void send("setSellerAllowed", [buyer, BigInt(agent), true])}>Đề xuất cho phép (24h)</button>
          <button className="secondary" disabled={!enabled || busy || !validAgent} onClick={() => void send("setSellerAllowed", [buyer, BigInt(agent), false])}>Bỏ cho phép</button>
          <button className="secondary" disabled={!enabled || busy || !validAgent} onClick={() => void send("applySellerAllowed", [buyer, BigInt(agent)])}>Áp dụng bên bán</button>
          <button className="secondary" disabled={!enabled || busy || !validAgent} onClick={() => void send("cancelSellerAllowed", [buyer, BigInt(agent)])}>Hủy đề xuất bên bán</button></div>
          <hr /><h3>Đổi admin</h3><label>Admin mới<input value={newAdmin} onChange={e => setNewAdmin(e.target.value)} /></label><button disabled={!enabled || busy || !isAddress(newAdmin, { strict: false }) || newAdmin === zeroAddress} onClick={() => void send("proposeAdmin", [buyer, newAdmin])}>Đề xuất đổi admin (24h)</button></>}
      </article></div>
      <article className="card"><h2>Lịch sử</h2>{!logs.length ? <p>Chưa có sự kiện cho ví này.</p> : <div className="table-wrap"><table><thead><tr><th>Thời gian</th><th>Sự kiện</th><th>Giao dịch</th></tr></thead><tbody>{logs.slice().reverse().map(e => <tr key={`${e.hash}:${e.index}`}><td>{new Date(e.time * 1000).toLocaleString("vi-VN")}</td><td>{e.name}</td><td>{client.config.local ? short(e.hash) : <a href={`https://testnet.snowtrace.io/tx/${e.hash}`} target="_blank" rel="noreferrer">{short(e.hash)} ↗</a>}</td></tr>)}</tbody></table></div>}</article>
    </>}
  </section>;
}
