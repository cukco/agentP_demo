import { useEffect, useState } from "react";
import { Outcome, type ReceiptsResponse, type ScoreResponse, type SessionStatusResponse } from "@agentpay/core";
import type { BuyerState, ChainEvent, DashboardClient } from "../client.js";
import type { Address } from "viem";
import { money, short } from "../model.js";

export function Live({ client, account, enabled }: { client: DashboardClient; account?: Address; enabled: boolean }) {
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [input, setInput] = useState("");
  const [id, setId] = useState("");
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
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  const opened = events.filter(e => e.name === "SessionOpened");
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
  return <section><p className="eyebrow">DÒNG TIỀN CÓ THỂ KIỂM CHỨNG</p><h1>Theo dõi phiên</h1><p>Kết quả kiểm định, tiền trong ví và lịch sử giao dịch.</p>
    <form className="address-form" onSubmit={e => { e.preventDefault(); if (/^\d{1,78}$/.test(input) && BigInt(input) < 2n ** 256n) { setId(BigInt(input).toString()); setError(""); } else setError("Session ID không hợp lệ."); }}>
      <label>Session ID<input value={input} onChange={e => setInput(e.target.value)} list="sessions" placeholder="Chọn hoặc nhập mã phiên" required /></label>
      <datalist id="sessions">{opened.map(e => <option key={String(e.args.sessionId)} value={String(e.args.sessionId)} />)}</datalist><button>Xem phiên</button>
    </form>
    {error && <p role="alert" className="error">{error}{updated && ` Dữ liệu dưới đây được cập nhật lần cuối lúc ${updated}.`}</p>}
    {transactionError && <p role="alert" className="error">{transactionError}</p>}
    {buyerState && buyerState.loosen.effectiveAt > 0n && <div role="alert" className="warning">Người mua đang có đề xuất nới luật. {admin && <button disabled={!enabled || sending} onClick={() => void cancel("cancelLoosen")}>Hủy nới luật</button>}</div>}
    {buyerState && buyerState.admin.effectiveAt > 0n && <div role="alert" className="warning">Người mua đang có đề xuất đổi admin. {admin && <button disabled={!enabled || sending} onClick={() => void cancel("cancelAdmin")}>Hủy đổi admin</button>}</div>}
    {!id && <article className="card empty"><h2>Chọn một phiên để bắt đầu</h2><p>Các phiên trên Escrow hiện tại sẽ xuất hiện trong danh sách.</p></article>}
    {firstSeller && status?.state === "OPEN" && <div role="alert" className="warning">Phiên đầu tiên của người mua với bên bán này. Theo dõi kết quả trước khi tăng hạn mức.</div>}
    {status && <><div className="live-header"><span className="pill">{status.state}</span><span>Cập nhật {updated}</span></div>
      <div className="stats outcomes"><article><span>PASS</span><strong className="good">{status.passCount}</strong></article><article><span>FAIL</span><strong className="bad">{status.failCount}</strong></article><article><span>INCONCLUSIVE</span><strong className="muted">{status.inconclusiveCount}</strong></article></div>
      <div className="columns"><article className="card"><h2>Tiền trong ví</h2><dl><dt>Người mua · {short(status.buyer)}</dt><dd>{balances ? money(balances[0]) : "—"}</dd><dt>Bên bán · {short(status.seller)}</dt><dd>{balances ? money(balances[1]) : "—"}</dd><dt>Giá trị PASS</dt><dd>{money(status.passedAmount)}</dd></dl></article>
        <article className="card"><h2>Uy tín bên bán</h2>{score ? <><div className="score">{score.score}<small>/100</small></div><p>{score.distinctBuyers} người mua khác nhau · {score.sessions} phiên được tính</p><p>Tham khảo {score.referenceScore.toFixed(1)} · Thực tế {score.realScore?.toFixed(1) ?? "Chưa có"}</p>{!!(score.flags & 2) && <p className="bad">Bên bán bị gắn cờ chặn</p>}{!!(score.flags & 1) && <p>Hiện chỉ có điểm tham khảo.</p>}</> : <p>Chưa đọc được điểm từ Scorer.</p>}</article></div>
      <article className="card"><h2>Dòng thời gian trên chain</h2><ol className="timeline">{timeline.map(e => <li key={`${e.hash}:${e.index}`}><span>{new Date(e.time * 1000).toLocaleTimeString("vi-VN")}</span><strong>{e.name}</strong>{client.config.local ? <code>{short(e.hash)}</code> : <a href={`https://testnet.snowtrace.io/tx/${e.hash}`} target="_blank" rel="noreferrer">Xem giao dịch ↗</a>}</li>)}</ol></article>
      <article className="card"><h2>Từng request</h2><div className="table-wrap"><table><thead><tr><th>Request</th><th>Kết quả</th><th>Giá trị</th><th>Thời gian</th></tr></thead><tbody>{receipts?.receipts.map(r => <tr key={r.message.seq}><td>#{r.message.seq}</td><td className={r.message.outcome === Outcome.PASS ? "good" : r.message.outcome === Outcome.FAIL ? "bad" : "muted"}>{Outcome[r.message.outcome] ?? "Không rõ"}</td><td>{money(r.message.amount)}</td><td>{new Date(Number(r.message.receivedAt) * 1000).toLocaleTimeString("vi-VN")}</td></tr>)}</tbody></table></div>{!receipts?.receipts.length && <p>Chưa có receipt.</p>}</article>
    </>}
  </section>;
}
