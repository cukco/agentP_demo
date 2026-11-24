import { useEffect, useState } from "react";
import { Outcome, type ReceiptsResponse, type ScoreResponse, type SessionStatusResponse } from "@agentpay/core";
import type { BuyerState, ChainEvent, DashboardClient } from "../client.js";
import type { Address } from "viem";
import { money, short } from "../model.js";
import { StateBadge } from "./Overview.js";
import { EVENT_LABEL, sessionsFrom } from "../summary.js";

export function Live({ client, account, enabled, initial }: { client: DashboardClient; account?: Address; enabled: boolean; initial?: string }) {
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [input, setInput] = useState(initial ?? "");
  const [id, setId] = useState(initial ?? "");
  const [follow, setFollow] = useState(!initial);
  const [status, setStatus] = useState<SessionStatusResponse>();
  const [receipts, setReceipts] = useState<ReceiptsResponse>();
  const [score, setScore] = useState<ScoreResponse>();
  const [balances, setBalances] = useState<[bigint, bigint]>();
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const [buyerState, setBuyerState] = useState<BuyerState>();
  const [sending, setSending] = useState(false);
  const [transactionError, setTransactionError] = useState("");
  useEffect(() => {
    let active = true, busy = false;
    async function poll() {
      if (busy) return; busy = true;
      try { const logs = await client.events(); if (active) setEvents(logs); }
      catch { if (active) setError("Không tải được sự kiện trên chain. Kiểm tra RPC."); }
      finally { busy = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  const opened = events.filter(e => e.name === "SessionOpened");
  const newest = opened.length ? sessionsFrom(events)[0]?.id : undefined;
  useEffect(() => { if (follow && newest && newest !== id) { setId(newest); setInput(newest); } }, [follow, newest, id]);
  const opening = opened.find(e => String(e.args.sessionId) === id);
  useEffect(() => {
    setStatus(undefined); setReceipts(undefined); setBalances(undefined); setScore(undefined); setUpdated(""); setBuyerState(undefined);
    if (!id) return;
    let active = true, busy = false, scoreAt = 0;
    const abort = new AbortController();
    async function json<T>(url: string): Promise<T> {
      const r = await fetch(url, { signal: abort.signal });
      if (!r.ok) throw new Error(`Dịch vụ trả lỗi ${r.status}. Chưa có dữ liệu xác minh cho phiên này.`);
      return r.json();
    }
    async function poll() {
      if (busy) return; busy = true;
      try {
        const [s, rs] = await Promise.all([
          json<SessionStatusResponse>(`${client.config.verifier}/v1/sessions/${id}`),
          json<ReceiptsResponse>(`${client.config.verifier}/v1/sessions/${id}/receipts?fromSeq=1`),
        ]);
        const [buyer, sellerBalance] = await Promise.all([client.buyer(s.buyer), client.balance(s.seller)]);
        if (!active) return;
        setStatus(s); setReceipts(rs); setBalances([buyer.balance, sellerBalance]); setBuyerState(buyer); setError(""); setUpdated(new Date().toLocaleTimeString("vi-VN"));
        if (opening && Date.now() - scoreAt > 10000) {
          const sc = await json<ScoreResponse>(`${client.config.scorer}/v1/score/${opening.args.sellerAgentId}`);
          if (active) setScore(sc); scoreAt = Date.now();
        }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Không đọc được phiên."); }
      finally { busy = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); abort.abort(); };
  }, [client, id, opening?.args.sellerAgentId]);
  const firstSeller = opening && !opened.some(e => (e.block < opening.block || (e.block === opening.block && e.index < opening.index)) &&
    String(e.args.buyer).toLowerCase() === String(opening.args.buyer).toLowerCase() &&
    String(e.args.seller).toLowerCase() === String(opening.args.seller).toLowerCase());
  const timeline = events.filter(e => String(e.args.sessionId) === id);
  const admin = account?.toLowerCase() === buyerState?.policy.admin.toLowerCase();
  async function cancel(name: "cancelLoosen" | "cancelAdmin") {
    if (!account || !status || !enabled || !admin || sending) return;
    setSending(true); setTransactionError("");
    try { await client.send(account, name, [status.buyer]); }
    catch (e) { setTransactionError(e instanceof Error ? e.message : "Không hủy được đề xuất."); }
    finally { setSending(false); }
  }
  return <section><div className="section-title"><div><p className="eyebrow">Dòng tiền có thể kiểm chứng</p><h1>Theo dõi phiên</h1><p>Kết quả kiểm định từng request, tiền trong ví và giao dịch trên chain, cập nhật mỗi giây.</p></div>
    <label className="check follow"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />Tự bám phiên mới nhất</label></div>
    <form className="address-form" onSubmit={e => { e.preventDefault(); if (/^\d{1,78}$/.test(input) && BigInt(input) < 2n ** 256n) { setId(BigInt(input).toString()); setFollow(false); setError(""); } else setError("Session ID không hợp lệ."); }}>
      <label>Session ID<input value={input} onChange={e => setInput(e.target.value)} list="sessions" placeholder="Chọn hoặc nhập mã phiên" required /></label>
      <datalist id="sessions">{opened.map(e => <option key={String(e.args.sessionId)} value={String(e.args.sessionId)} />)}</datalist><button>Xem phiên</button>
    </form>
    {error && <p role="alert" className="error">{error}{updated && ` Dữ liệu dưới đây được cập nhật lần cuối lúc ${updated}.`}</p>}
    {transactionError && <p role="alert" className="error">{transactionError}</p>}
    {buyerState && buyerState.loosen.effectiveAt > 0n && <div role="alert" className="warning">Người mua đang có đề xuất nới luật. {admin && <button disabled={!enabled || sending} onClick={() => void cancel("cancelLoosen")}>Hủy nới luật</button>}</div>}
    {buyerState && buyerState.admin.effectiveAt > 0n && <div role="alert" className="warning">Người mua đang có đề xuất đổi admin. {admin && <button disabled={!enabled || sending} onClick={() => void cancel("cancelAdmin")}>Hủy đổi admin</button>}</div>}
    {!id && <article className="card empty"><h2>{events.length ? "Chọn một phiên để bắt đầu" : "Đang đọc các phiên trên Escrow…"}</h2><p>Khi AI agent mở phiên mới, màn này tự chuyển sang phiên đó.</p></article>}
    {firstSeller && status?.state === "OPEN" && <div role="alert" className="warning">Phiên đầu tiên của người mua với bên bán này. Theo dõi kết quả trước khi tăng hạn mức.</div>}
    {status && <><div className="live-header"><div className="live-id"><StateBadge state={status.state} /><code title={id}>Phiên {short(id)}</code>{opening && <span>Bên bán #{String(opening.args.sellerAgentId)}</span>}</div><span><span className="dot" /> Cập nhật {updated}</span></div>
      {opening && <Meter used={BigInt(status.cumulativeAmount)} passed={BigInt(status.passedAmount)} cap={BigInt(String(opening.args.cap))} price={BigInt(String(opening.args.pricePerRequest))} />}
      <div className="stats outcomes"><article><span>PASS</span><strong className="good">{status.passCount}</strong></article><article><span>FAIL</span><strong className="bad">{status.failCount}</strong></article><article><span>INCONCLUSIVE</span><strong className="muted">{status.inconclusiveCount}</strong></article></div>
      <div className="columns"><article className="card"><h2>Tiền trong ví</h2><dl><dt>Người mua · {short(status.buyer)}</dt><dd>{balances ? money(balances[0]) : "—"}</dd><dt>Bên bán · {short(status.seller)}</dt><dd>{balances ? money(balances[1]) : "—"}</dd><dt>Giá trị PASS</dt><dd>{money(status.passedAmount)}</dd></dl></article>
        <article className="card"><h2>Uy tín bên bán</h2>{score ? <><div className="score">{score.score}<small>/100</small></div><p>{score.distinctBuyers} người mua khác nhau · {score.sessions} phiên được tính</p><p>Tham khảo {score.referenceScore.toFixed(1)} · Thực tế {score.realScore?.toFixed(1) ?? "Chưa có"}</p>{!!(score.flags & 2) && <p className="bad">Bên bán bị gắn cờ chặn</p>}{!!(score.flags & 1) && <p>Hiện chỉ có điểm tham khảo.</p>}</> : <p>Chưa đọc được điểm từ Scorer.</p>}</article></div>
      <article className="card"><h2>Dòng thời gian trên chain</h2><ol className="timeline">{timeline.map(e => <li key={`${e.hash}:${e.index}`}><span>{new Date(e.time * 1000).toLocaleTimeString("vi-VN")}</span><span className={`tag tag-${e.name}`}>{EVENT_LABEL[e.name] ?? e.name}</span>{client.config.local ? <code>{short(e.hash)}</code> : <a href={`https://testnet.snowtrace.io/tx/${e.hash}`} target="_blank" rel="noreferrer">Xem giao dịch ↗</a>}</li>)}</ol></article>
      <article className="card"><h2>Từng request</h2><div className="table-wrap"><table><thead><tr><th>Request</th><th>Kết quả</th><th>Giá trị</th><th>Thời gian</th></tr></thead><tbody>{receipts?.receipts.slice().reverse().map(r => <tr key={r.message.seq} className="enter"><td>#{r.message.seq}</td><td><span className={`badge badge-${r.message.outcome === Outcome.PASS ? "pass" : r.message.outcome === Outcome.FAIL ? "fail" : "inconclusive"}`}>{Outcome[r.message.outcome] ?? "Không rõ"}</span></td><td>{r.message.outcome === Outcome.PASS ? money(r.message.amount) : <span className="muted-text">$0.00</span>}</td><td>{new Date(Number(r.message.receivedAt) * 1000).toLocaleTimeString("vi-VN")}</td></tr>)}</tbody></table></div>{!receipts?.receipts.length && <p>Chưa có receipt.</p>}</article>
    </>}
  </section>;
}

function Meter({ used, passed, cap, price }: { used: bigint; passed: bigint; cap: bigint; price: bigint }) {
  const pct = (v: bigint) => cap > 0n ? Math.min(100, Number(v * 10000n / cap) / 100) : 0;
  return <div className="meter-card">
    <div className="meter-head"><span>Hạn mức phiên</span><strong>{money(passed)} <small>tính tiền</small> · {money(used)} <small>đã ký</small> / {money(cap)}</strong></div>
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(used)} aria-label="Hạn mức phiên đã dùng">
      <span className="meter-signed" style={{ width: `${pct(used)}%` }} /><span className="meter-passed" style={{ width: `${pct(passed)}%` }} />
    </div>
    <p>{money(price)} mỗi request · còn {cap > used && price > 0n ? ((cap - used) / price).toString() : "0"} request trước khi chạm hạn mức</p>
  </div>;
}
