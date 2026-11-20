import { useState, type FormEvent } from "react";
import { formatUnits } from "viem";
import { DEFAULTS, type PolicyParams } from "@agentpay/core";
import { isTighter, parseMoney } from "../model.js";

export function PolicyForm({ current, disabled, submit }: { current?: PolicyParams; disabled: boolean; submit: (p: PolicyParams) => Promise<void> }) {
  const [cap, setCap] = useState(current ? formatUnits(current.maxPerSession, 6) : "1");
  const [daily, setDaily] = useState(current ? formatUnits(current.dailyCap, 6) : "5");
  const [score, setScore] = useState(String(current?.minScore ?? DEFAULTS.MIN_SCORE));
  const [paused, setPaused] = useState(current?.paused ?? false);
  const [allowlist, setAllowlist] = useState(current?.sellerAllowlistOn ?? false);
  const [error, setError] = useState("");
  function policy(): PolicyParams {
    const p = { maxPerSession: parseMoney(cap), dailyCap: parseMoney(daily), minScore: Number(score), paused, sellerAllowlistOn: allowlist };
    if (p.maxPerSession <= 0n || p.maxPerSession > 20000000n || p.dailyCap <= 0n || !/^\d+$/.test(score) || p.minScore > 100)
      throw new Error("Hạn mỗi phiên phải > 0 và ≤ $20; hạn ngày > 0; điểm từ 0 đến 100.");
    return p;
  }
  let label = "Đăng ký luật";
  try { if (current) label = isTighter(current, policy()) ? "Siết luật ngay" : "Đề xuất nới luật (24 giờ)"; } catch { /* validate on submit */ }
  async function onSubmit(e: FormEvent) {
    e.preventDefault(); setError("");
    try { await submit(policy()); } catch (e) { setError(e instanceof Error ? e.message : "Không thể gửi luật."); }
  }
  return <form onSubmit={onSubmit} className="form-grid">
    <label>Hạn mỗi phiên (USDC)<input value={cap} onChange={e => setCap(e.target.value)} inputMode="decimal" required /></label>
    <label>Hạn mỗi 24 giờ (USDC)<input value={daily} onChange={e => setDaily(e.target.value)} inputMode="decimal" required /></label>
    <label>Điểm tối thiểu<input value={score} onChange={e => setScore(e.target.value)} inputMode="numeric" required /></label>
    <label className="check"><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />Tạm dừng mua</label>
    <label className="check"><input type="checkbox" checked={allowlist} onChange={e => setAllowlist(e.target.checked)} />Chỉ mua từ danh sách cho phép</label>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={disabled} type="submit">{label}</button>
  </form>;
}
