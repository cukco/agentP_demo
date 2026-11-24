import { useEffect, useMemo, useState } from "react";
import type { ChainEvent, DashboardClient } from "../client.js";
import { useNow } from "../hooks.js";
import { money, short } from "../model.js";
import { EVENT_LABEL, STATE_LABEL, ago, daily, sessionsFrom, totalsFrom, type SessionRow } from "../summary.js";

const REPO = "https://github.com/cukco/agentP_demo";

export function Overview({ client, openSession, go }: { client: DashboardClient; openSession: (id: string) => void; go: (tab: string) => void }) {
  const [events, setEvents] = useState<ChainEvent[]>();
  const [error, setError] = useState("");
  const now = useNow();
  useEffect(() => {
    let active = true, busy = false;
    async function poll() {
      if (busy) return; busy = true;
      try { const logs = await client.events(); if (active) { setEvents([...logs]); setError(""); } }
      catch { if (active) setError("Không tải được dữ liệu trên chain. Kiểm tra RPC."); }
      finally { busy = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 4000);
    return () => { active = false; clearInterval(timer); };
  }, [client]);
  const rows = useMemo(() => sessionsFrom(events ?? []), [events]);
  const totals = useMemo(() => totalsFrom(rows, events ?? []), [rows, events]);
  const chart = useMemo(() => daily(rows, Date.now() / 1000), [rows]);
  const latest = useMemo(() => (events ?? []).slice().sort((a, b) => a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1).slice(0, 10), [events]);
  const passRate = totals.requests ? Math.round(totals.pass / totals.requests * 1000) / 10 : 0;
  const loading = !events;
  const explorer = (hash: string) => client.config.local ? undefined : `https://testnet.snowtrace.io/tx/${hash}`;

  return <section className="overview">
    <div className="hero">
      <div className="hero-copy">
        <p className="eyebrow">x402 · Ký quỹ theo phiên · Avalanche</p>
        <h1>AI agent chỉ trả tiền<br />cho kết quả <em>đạt</em>.</h1>
        <p className="lead">AgentPay khóa USDC một lần cho cả phiên, kiểm định từng phản hồi và chỉ trả cho request PASS. Mọi khoản chi nằm trong luật do con người đặt trên chain, agent không tự nới được.</p>
        <div className="hero-actions">
          <button onClick={() => go("live")}>Xem phiên trực tiếp</button>
          <button className="secondary" onClick={() => go("rules")}>Đặt luật cho agent</button>
          <a className="text-link" href={REPO} target="_blank" rel="noreferrer">Cài MCP cho AI của bạn ↗</a>
        </div>
      </div>
      <Flow />
    </div>

    {error && <p role="alert" className="error">{error}</p>}

    <div className="stats kpis">
      <Kpi label="Phiên đã mở" value={loading ? undefined : totals.sessions.toLocaleString("vi-VN")} note={loading ? "" : `${totals.open} đang mở · ${totals.buyers} người mua`} />
      <Kpi label="Request đã kiểm định" value={loading ? undefined : totals.requests.toLocaleString("vi-VN")} note={loading ? "" : `chỉ ${totals.transactions} giao dịch on-chain`} />
      <Kpi label="Tỷ lệ PASS" value={loading ? undefined : `${passRate.toLocaleString("vi-VN")}%`} note={loading ? "" : `${totals.fail + totals.inconclusive} request không bị tính tiền`} tone="good" />
      <Kpi label="Đã trả bên bán" value={loading ? undefined : money(totals.toSeller)} note={loading ? "" : `${money(totals.toBuyer)} hoàn về người mua`} />
    </div>

    <div className="columns overview-grid">
      <article className="card">
        <div className="card-head"><h2>Request theo ngày</h2><span className="legend"><i className="lg-pass" />PASS<i className="lg-fail" />Không tính tiền</span></div>
        <Chart data={chart} />
      </article>
      <article className="card">
        <div className="card-head"><h2>Vì sao an toàn</h2></div>
        <ul className="pillars">
          <li><b>01</b><div><strong>Không đạt thì không trả</strong><p>Verifier kiểm từng phản hồi (ví dụ so giá với Chainlink) và ký Receipt. FAIL là 0 đồng.</p></div></li>
          <li><b>02</b><div><strong>Luật chi tiêu on-chain</strong><p>Hạn mức phiên, hạn mức ngày, điểm uy tín tối thiểu. Siết ngay, nới phải chờ 24 giờ.</p></div></li>
          <li><b>03</b><div><strong>Uy tín ERC-8004</strong><p>Mỗi phiên ghi feedback on-chain. Bên bán điểm thấp bị chặn trước khi mất đồng nào.</p></div></li>
        </ul>
      </article>
    </div>

    <div className="columns overview-grid">
      <article className="card flush">
        <div className="card-head pad"><h2>Phiên mới nhất</h2><button className="link" onClick={() => go("live")}>Theo dõi trực tiếp →</button></div>
        <SessionList rows={rows.slice(0, 8)} now={now} loading={loading} open={openSession} />
      </article>
      <article className="card flush">
        <div className="card-head pad"><h2>Sự kiện trên chain</h2><span className="live-dot"><span className="dot" />Tự cập nhật</span></div>
        <ol className="feed">
          {loading && Array.from({ length: 6 }, (_, i) => <li key={i} className="skeleton-row"><span /><span /></li>)}
          {latest.map(e => {
            const url = explorer(e.hash);
            return <li key={`${e.hash}:${e.index}`}>
              <span className={`tag tag-${e.name}`}>{EVENT_LABEL[e.name] ?? e.name}</span>
              <span className="feed-detail">{detail(e)}</span>
              <span className="feed-time">{url ? <a href={url} target="_blank" rel="noreferrer">{ago(e.time, now)} ↗</a> : ago(e.time, now)}</span>
            </li>;
          })}
        </ol>
      </article>
    </div>
  </section>;
}

function detail(e: ChainEvent) {
  const a = e.args;
  switch (e.name) {
    case "SessionOpened": return `Khóa ${money(String(a.cap))} · bên bán #${a.sellerAgentId}`;
    case "SessionClosed": return `${a.passCount} PASS · ${a.failCount} FAIL`;
    case "Settled": return `Bên bán ${money(String(a.toSeller))} · hoàn ${money(String(a.toBuyer))}`;
    case "Refunded": return `Hoàn ${money(String(a.amount))}`;
    case "FeedbackGiven": return `Agent #${a.agentId} · ${a.ok ? "tốt" : "xấu"}`;
    case "BuyerSpend": return `${short(String(a.buyer))} · ${money(String(a.amount))}`;
    case "BuyerRegistered": return `${short(String(a.buyer))}`;
    default: return a.buyer ? short(String(a.buyer)) : a.sessionId ? `Phiên ${short(String(a.sessionId))}` : "";
  }
}

function Kpi({ label, value, note, tone }: { label: string; value?: string; note: string; tone?: "good" }) {
  return <article><span>{label}</span>{value === undefined ? <strong className="skeleton">&nbsp;</strong> : <strong className={tone}>{value}</strong>}<small>{note}</small></article>;
}

export function StateBadge({ state }: { state: SessionRow["state"] }) {
  return <span className={`badge badge-${state.toLowerCase()}`}>{STATE_LABEL[state]}</span>;
}

function SessionList({ rows, now, loading, open }: { rows: SessionRow[]; now: number; loading: boolean; open: (id: string) => void }) {
  if (loading) return <ol className="feed">{Array.from({ length: 6 }, (_, i) => <li key={i} className="skeleton-row"><span /><span /></li>)}</ol>;
  if (!rows.length) return <p className="pad">Chưa có phiên nào.</p>;
  return <div className="table-wrap flat"><table className="clickable"><thead><tr><th>Phiên</th><th>Trạng thái</th><th>Kết quả</th><th>Hạn mức</th><th>Thời gian</th></tr></thead>
    <tbody>{rows.map(r => <tr key={r.id} onClick={() => open(r.id)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter") open(r.id); }}>
      <td><span className="sid">{short(r.id)}</span><small>{short(r.buyer)} → #{r.agentId}</small></td>
      <td><StateBadge state={r.state} /></td>
      <td>{r.state === "OPEN" ? <span className="muted-text">đang chạy</span> : <><span className="good">{r.pass}✓</span> <span className="bad">{r.fail + r.inconclusive}✗</span></>}</td>
      <td>{money(r.cap)}</td>
      <td className="muted-text">{ago(r.openedAt, now)}</td>
    </tr>)}</tbody></table></div>;
}

function Chart({ data }: { data: { day: Date; pass: number; fail: number }[] }) {
  const max = Math.max(4, ...data.map(d => d.pass + d.fail));
  const W = 560, H = 180, gap = 8, bw = (W - gap * (data.length - 1)) / data.length;
  return <svg className="chart" viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Số request PASS và không tính tiền theo ngày">
    {[0.25, 0.5, 0.75, 1].map(f => <line key={f} x1="0" x2={W} y1={H - H * f} y2={H - H * f} className="grid" />)}
    {data.map((d, i) => {
      const x = i * (bw + gap), hp = H * d.pass / max, hf = H * d.fail / max;
      const label = d.day.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
      return <g key={i}>
        <title>{`${label}: ${d.pass} PASS, ${d.fail} không tính tiền`}</title>
        {d.pass > 0 && <rect x={x} y={H - hp} width={bw} height={hp} className="bar-pass" />}
        {d.fail > 0 && <rect x={x} y={H - hp - hf} width={bw} height={hf} className="bar-fail" />}
        {d.pass + d.fail === 0 && <rect x={x} y={H - 2} width={bw} height={2} className="bar-empty" />}
        {(i % 2 === data.length % 2 || i === data.length - 1) && <text x={x + bw / 2} y={H + 16} textAnchor="middle">{label}</text>}
      </g>;
    })}
  </svg>;
}

/** Animated money flow: agent → escrow → seller → verifier → keeper. */
function Flow() {
  const nodes = [
    { x: 40, y: 60, t: "AI agent", s: "ký Voucher" },
    { x: 200, y: 60, t: "Escrow", s: "khóa USDC" },
    { x: 360, y: 60, t: "Bên bán", s: "trả dữ liệu" },
    { x: 360, y: 190, t: "Verifier", s: "PASS / FAIL" },
    { x: 200, y: 190, t: "Keeper", s: "chốt tiền" },
    { x: 40, y: 190, t: "Ví bạn", s: "nhận tiền dư" },
  ];
  const path = "M90 85 H410 V215 H90";
  return <div className="flow" aria-hidden="true">
    <svg viewBox="0 0 450 260">
      <path d={path} className="flow-line" />
      <circle r="5" className="flow-dot"><animateMotion dur="5s" repeatCount="indefinite" path={path} /></circle>
      <circle r="5" className="flow-dot flow-dot-2"><animateMotion dur="5s" begin="-2.5s" repeatCount="indefinite" path={path} /></circle>
      {nodes.map((n, i) => <g key={n.t} transform={`translate(${n.x} ${n.y})`}>
        <rect width="100" height="50" rx="2" className={i === 1 ? "flow-node flow-node-key" : "flow-node"} />
        <text x="50" y="22" textAnchor="middle" className="flow-title">{n.t}</text>
        <text x="50" y="38" textAnchor="middle" className="flow-sub">{n.s}</text>
      </g>)}
    </svg>
  </div>;
}
