import { useEffect, useRef, useState, type ReactNode } from "react";
import { createClient, loadConfig } from "../client.js";
import { sessionsFrom, totalsFrom, type Totals } from "../summary.js";

const APP = import.meta.env.DEV ? "/" : "/app";
const REPO = "https://github.com/cukco/agentP_demo";
const ESCROW = "0xEbBE6E2cCE97a6C2Cb93563936b5846481C942ac";

function Mark({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" fill="#e84142" /><path d="M12 5 19 12 12 19 5 12Z" fill="none" stroke="#fff" strokeWidth="2" /><path d="M12 9.5 14.5 12 12 14.5 9.5 12Z" fill="#fff" /></svg>;
}

/** Fade sections in as they scroll into view (content stays visible without JS or with reduced motion). */
function useReveal() {
  useEffect(() => {
    const items = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) { items.forEach(i => i.classList.add("in")); return; }
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
    items.forEach(i => io.observe(i));
    return () => io.disconnect();
  }, []);
}

function useLiveTotals() {
  const [totals, setTotals] = useState<Totals>();
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const client = createClient(await loadConfig());
        const events = await client.events();
        if (active) setTotals(totalsFrom(sessionsFrom(events), events));
      } catch { /* landing page still works with the static numbers */ }
    })();
    return () => { active = false; };
  }, []);
  return totals;
}

/** Counts up to `value` once visible. */
function Count({ value, decimals = 0, suffix = "" }: { value?: number; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (value === undefined) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(value); return; }
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => { const k = Math.min(1, (t - start) / 1200); setShown(value * (1 - (1 - k) ** 3)); if (k < 1) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    });
    if (ref.current) io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [value]);
  return <span ref={ref}>{value === undefined ? "—" : shown.toLocaleString("vi-VN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{value === undefined ? "" : suffix}</span>;
}

const LINES: { t: string; c?: string; d?: number }[] = [
  { t: "› Mua giá AVAX 18 lần từ agentpay-seller, tính trung bình", c: "prompt", d: 900 },
  { t: "agentpay_open_session  khóa 1.00 USDC · #306 điểm 51", c: "sys", d: 700 },
  { t: "#01  PASS  $6.72   khớp Chainlink   0.01 USDC", c: "pass" },
  { t: "#02  PASS  $6.71   khớp Chainlink   0.01 USDC", c: "pass" },
  { t: "#03  PASS  $6.72   khớp Chainlink   0.01 USDC", c: "pass" },
  { t: "  ⋮", c: "dim" },
  { t: "#15  PASS  $6.73   khớp Chainlink   0.01 USDC", c: "pass" },
  { t: "#16  FAIL  $8.91   lệch 32%         0.00 USDC", c: "fail" },
  { t: "#17  FAIL  $8.91   lệch 32%         0.00 USDC", c: "fail" },
  { t: "› Mở phiên 20 USDC", c: "prompt", d: 800 },
  { t: "✗ Blocked by on-chain buyer rules · OverPerSession", c: "fail", d: 700 },
  { t: "agentpay_close_session  Keeper chốt: bên bán 0.15 · hoàn 0.80", c: "sys" },
];

function Terminal() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(LINES.length); return; }
    const delay = n >= LINES.length ? 4200 : LINES[n]?.d ?? 360;
    const timer = setTimeout(() => setN(v => v >= LINES.length ? 0 : v + 1), delay);
    return () => clearTimeout(timer);
  }, [n]);
  return <div className="term" aria-label="Ví dụ AI agent mua dữ liệu qua AgentPay">
    <div className="term-bar"><i /><i /><i /><span>claude · agentpay MCP · Avalanche Fuji</span></div>
    <pre>{LINES.slice(0, n).map((l, i) => <div key={i} className={`ln ${l.c ?? ""}`}>{l.t}</div>)}<span className="caret" /></pre>
  </div>;
}

function Section({ id, eyebrow, title, intro, children }: { id: string; eyebrow: string; title: ReactNode; intro?: string; children: ReactNode }) {
  return <section id={id} className="sec">
    <div className="wrap">
      <div className="sec-head reveal"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{intro && <p className="intro">{intro}</p>}</div>
      {children}
    </div>
  </section>;
}

export function Site() {
  useReveal();
  const live = useLiveTotals();
  const [menu, setMenu] = useState(false);
  const passRate = live?.requests ? live.pass / live.requests * 100 : undefined;
  const nav = [["#van-de", "Vấn đề"], ["#cach-hoat-dong", "Cách hoạt động"], ["#tinh-nang", "Tính năng"], ["#so-lieu", "Số liệu"], ["#bat-dau", "Bắt đầu"]];

  return <>
    <header className="top">
      <div className="wrap top-in">
        <a href="#" className="logo"><Mark /><span>AgentPay</span></a>
        <nav className={menu ? "open" : ""} aria-label="Mục lục">
          {nav.map(([h, t]) => <a key={h} href={h} onClick={() => setMenu(false)}>{t}</a>)}
        </nav>
        <div className="top-cta">
          <a className="gh" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a className="btn btn-red" href={APP}>Mở Dashboard</a>
          <button className="burger" aria-label="Mở menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}><span /><span /></button>
        </div>
      </div>
    </header>

    <main>
      <section className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-grid" aria-hidden="true" />
        <div className="wrap hero-in">
          <div className="hero-copy">
            <h1>Autopay for AI agents.<br /><span className="red">Guarded on-chain.</span></h1>
            <p className="lead">Khi AI agent gọi API trả phí qua x402, tiền đi ngay, kể cả khi kết quả sai. AgentPay giữ tiền trong một phiên ký quỹ, kiểm từng kết quả rồi mới trả. Hạn mức do bạn đặt trên chain, agent không tự sửa được.</p>
            <div className="cta">
              <a className="btn btn-red btn-lg" href={APP}>Xem trực tiếp trên Fuji →</a>
              <a className="btn btn-ghost btn-lg" href="#bat-dau">Cài cho AI của bạn</a>
            </div>
            <ul className="chips"><li>Avalanche</li><li>x402</li><li>ERC-8004</li><li>Chainlink</li><li>MCP</li></ul>
          </div>
          <Terminal />
        </div>
        <div className="wrap ticker reveal">
          <div><strong><Count value={live?.sessions} /></strong><span>phiên đã chạy trên Fuji</span></div>
          <div><strong><Count value={live?.requests} /></strong><span>request đã kiểm định</span></div>
          <div><strong><Count value={passRate} decimals={1} suffix="%" /></strong><span>tỷ lệ PASS</span></div>
          <div><strong>93%</strong><span>ít gas hơn so với trả từng lệnh</span></div>
        </div>
      </section>

      <Section id="van-de" eyebrow="01 · Vấn đề" title={<>Cho AI cầm ví thì<br />lo nhất là chuyện gì?</>}
        intro="x402 cho phép agent tự trả tiền mỗi lần gọi API. Dùng thì tiện, nhưng có ba chỗ mà một ví bình thường không xử lý được.">
        <div className="cards3">
          {[
            ["Trả rồi mới biết dữ liệu sai", "Agent trả ngay lúc gọi. API có trả về giá sai hay dữ liệu bịa thì tiền cũng đã đi rồi, không đòi lại được."],
            ["Bị dụ tiêu quá tay", "Một đoạn chữ giấu trong trang web có thể bảo agent chi thêm. Nếu giới hạn chi tiêu nằm ngay trong agent thì agent sửa được luôn cả giới hạn."],
            ["Phí gas đắt hơn món hàng", "Mỗi lần gọi là một giao dịch on-chain, có khi tiền gas còn cao hơn tiền dữ liệu. Mà agent cũng chẳng biết bên bán nào đáng tin."],
          ].map(([h, p], i) => <article key={h} className="card reveal" style={{ transitionDelay: `${i * 90}ms` }}><span className="num">0{i + 1}</span><h3>{h}</h3><p>{p}</p></article>)}
        </div>
      </Section>

      <Section id="cach-hoat-dong" eyebrow="02 · Cách hoạt động" title={<>Mở một phiên,<br />gọi bao nhiêu lần cũng được</>}>
        <ol className="steps">
          {[
            ["Mở phiên", "Agent khóa một khoản USDC vào Escrow. Trước khi nhận tiền, Escrow xem luật bạn đặt và điểm uy tín của bên bán.", "1 giao dịch"],
            ["Gọi API", "Mỗi lần gọi, agent ký một Voucher ngay trên máy. Không mất gas, không phải chờ block.", "off-chain"],
            ["Kiểm định", "Verifier kiểm từng phản hồi, ví dụ so giá với Chainlink, rồi ký Receipt PASS hoặc FAIL.", "< 800 ms"],
            ["Chốt tiền", "Đóng phiên xong, Keeper trả tiền các lượt PASS cho bên bán, hoàn phần còn lại về ví và ghi điểm uy tín lên chain.", "2 giao dịch"],
          ].map(([h, p, tag], i) => <li key={h} className="step reveal" style={{ transitionDelay: `${i * 90}ms` }}>
            <span className="step-n">{String(i + 1).padStart(2, "0")}</span><h3>{h}</h3><p>{p}</p><em>{tag}</em>
          </li>)}
        </ol>
      </Section>

      <Section id="tinh-nang" eyebrow="03 · Tính năng" title={<>Bạn đặt luật,<br />agent làm theo</>}>
        <div className="bento">
          <article className="tile tile-big reveal">
            <h3>Luật chi tiêu on-chain</h3>
            <p>Bạn chọn mỗi phiên tối đa bao nhiêu, mỗi ngày bao nhiêu, và chỉ mua của bên bán từ bao nhiêu điểm trở lên. Siết lại thì có hiệu lực ngay. Nới ra thì phải đợi 24 giờ, nên lỡ có ai lén nới, bạn vẫn kịp hủy.</p>
            <div className="rules">
              <div><span>Mỗi phiên</span><b>≤ 5 USDC</b></div><div><span>Mỗi ngày</span><b>≤ 10 USDC</b></div>
              <div><span>Điểm bên bán</span><b>≥ 30</b></div><div><span>Nới luật</span><b>chờ 24h</b></div>
            </div>
          </article>
          <article className="tile reveal"><h3>Không đạt thì không trả</h3><p>Lượt FAIL hay INCONCLUSIVE đều không mất tiền. Các Receipt được gom vào một Merkle root trên chain, ai muốn kiểm lại cũng được.</p></article>
          <article className="tile reveal"><h3>Uy tín ERC-8004</h3><p>Sau mỗi phiên, kết quả được ghi lên chain. Bên bán thấp hơn điểm bạn đặt thì Escrow từ chối luôn, agent chưa kịp mất đồng nào.</p></article>
          <article className="tile reveal"><h3>Dùng với AI bạn đang có</h3><p>Có sẵn MCP server cho Claude, Cursor, Copilot, Gemini CLI và Codex CLI. Cài mất chừng 5 phút.</p></article>
          <article className="tile reveal"><h3>Có chỗ để khiếu nại</h3><p>Cả hai bên đều khiếu nại được trong một khoảng thời gian, có đặt cọc để tránh spam. Ai ký hai kết quả khác nhau cho cùng một lượt sẽ bị bắt lỗi ngay trên chain.</p></article>
        </div>
      </Section>

      <Section id="so-sanh" eyebrow="04 · So sánh" title="So với x402 thông thường">
        <div className="compare reveal" role="table">
          <div className="row head" role="row"><span role="columnheader" /><span role="columnheader">x402 thường</span><span role="columnheader" className="red">AgentPay</span></div>
          {[
            ["Khi nào trả tiền", "Trước khi biết kết quả", "Chỉ khi kết quả đạt"],
            ["Gọi 18 lần", "18 giao dịch", "3 giao dịch, ít hơn khoảng 93% gas"],
            ["Giới hạn chi tiêu", "Không có", "Theo phiên, theo ngày, có nút dừng"],
            ["Khi bị prompt injection", "Agent muốn chi bao nhiêu cũng được", "Escrow chặn lại"],
            ["Bên bán có đáng tin không", "Không biết", "Có điểm uy tín ERC-8004"],
          ].map(([k, a, b]) => <div className="row" role="row" key={k}><span role="cell">{k}</span><span role="cell" className="no">{a}</span><span role="cell" className="yes">{b}</span></div>)}
        </div>
      </Section>

      <Section id="so-lieu" eyebrow="05 · Đã chạy thật" title={<>Đang chạy thật<br />trên Avalanche Fuji</>}>
        <div className="metrics">
          {[
            [<Count key="a" value={410} />, "test hợp đồng", "Phủ 99,5–100% code, test fuzz chạy 10.000 lần"],
            [<span key="b">673 ms</span>, "Verifier p95", "Đo trên máy chủ thật, mục tiêu dưới 800 ms"],
            [<Count key="c" value={live?.transactions} />, "giao dịch on-chain", "từ lúc bắt đầu chạy demo tới giờ"],
            [<span key="d">$0,05</span>, "phí mỗi phiên", "Cộng 0,5% số tiền bên bán nhận, gọi nhiều hay ít cũng vậy"],
          ].map(([v, h, p], i) => <div key={i} className="metric reveal"><strong>{v}</strong><h3>{h}</h3><p>{p}</p></div>)}
        </div>
        <div className="live-cta reveal">
          <div><span className="pulse" /> Escrow đã verify trên Snowtrace · <a href={`https://testnet.snowtrace.io/address/${ESCROW}`} target="_blank" rel="noreferrer"><code>{ESCROW.slice(0, 10)}…{ESCROW.slice(-6)}</code> ↗</a></div>
          <a className="btn btn-red" href={APP}>Mở Dashboard trực tiếp →</a>
        </div>
      </Section>

      <Section id="bat-dau" eyebrow="06 · Bắt đầu" title="Thử với AI của bạn"
        intro="Các dịch vụ phía sau đều đang chạy sẵn. Bạn chỉ cần một ví test có 1 USDC trên Fuji.">
        <div className="start">
          <pre className="code reveal"><span className="c"># 1. Cài (khoảng 5 phút)</span>{"\n"}git clone {REPO}.git agentpay{"\n"}cd agentpay && pnpm install && pnpm agentpay:build{"\n"}pnpm agentpay:wallet   <span className="c"># tạo ví agent, in cấu hình MCP</span>{"\n\n"}<span className="c"># 2. Nối vào Claude Code (hoặc Cursor, Copilot, Gemini…)</span>{"\n"}claude mcp add agentpay -- node /…/dist/mcp.js{"\n\n"}<span className="c"># 3. Đặt luật cho agent</span>{"\n"}pnpm agentpay:rules -- --admin 0xVÍ_CỦA_BẠN --per-session 5</pre>
          <div className="start-side reveal">
            <h3>Cài xong thì nhắn cho AI:</h3>
            <blockquote>“Dùng agentpay mua giá AVAX 3 lần, tính trung bình và tổng tiền đã trả.”</blockquote>
            <p>Mỗi lần gọi tốn 0,01 USDC, và giá nào cũng được so với Chainlink trước khi tính tiền.</p>
            <a className="btn btn-ghost" href={`${REPO}/blob/main/docs/MCP.md`} target="_blank" rel="noreferrer">Hướng dẫn đầy đủ ↗</a>
          </div>
        </div>
      </Section>

    </main>

    <footer className="foot">
      <div className="wrap foot-in">
        <a href="#" className="logo"><Mark size={20} /><span>AgentPay</span></a>
        <span>Bản demo trên testnet, không dùng tiền thật. Mã nguồn MIT, phát triển từ PayCrow.</span>
        <div><a href={APP}>Dashboard</a><a href={REPO} target="_blank" rel="noreferrer">GitHub</a><a href={`https://testnet.snowtrace.io/address/${ESCROW}`} target="_blank" rel="noreferrer">Snowtrace</a></div>
      </div>
    </footer>
  </>;
}
