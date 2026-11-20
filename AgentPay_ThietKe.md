# AgentPay — Ghi chú thiết kế

> Bổ sung cho `AgentPay_TomTat.docx`. Cập nhật: 2026-11-12. MVP: Avalanche Fuji, hạn 30/11/2026.
> Từ 2026-11-12 dùng **ký quỹ theo phiên** (`AgentPay_SystemDesign.md` §4). Các quyết định đã chốt nằm ở `AgentPay_SystemDesign.md` §12; nếu file này khác thì theo §12. Từ 2026-11-17 bỏ Policy Wallet, chỉ hỗ trợ ví EOA với luật người mua trong Escrow (D1).

---

## A. Điểm uy tín khởi đầu (cold-start)

**Vấn đề:** hạ tầng mới nên bên bán chưa có lịch sử giao dịch qua AgentPay → điểm = 0 → bị luật người mua (`minScore`) chặn → không bao giờ có giao dịch đầu tiên.

**Giải pháp:** cộng sẵn *điểm tham khảo* từ dữ liệu bên ngoài, có trần và nhạt dần khi có dữ liệu thật.

### A1. Nguồn tham khảo (MVP làm 3 nguồn đầu)

| # | Nguồn | Đo gì | Vai trò |
|---|---|---|---|
| 1 | Lịch sử nhận USDC của ví `payTo` trên **mainnet** (Avalanche C-Chain + Base; **Routescan** không cần key, Glacier dự phòng. Etherscan V2 không có Avalanche ở gói miễn phí) | Số ví trả tiền **khác nhau**, tổng tiền, khoảng thời gian | Cộng điểm (nguồn mạnh nhất) |
| 2 | AgentPay tự kiểm tra endpoint (gọi thử định kỳ, mua thử vài cent) | Còn sống, đúng schema, độ trễ | Cộng điểm |
| 3 | Danh sách OFAC SDN + ví lừa đảo/drainer | Ví có bị gắn cờ | **Chỉ trừ / chặn** |
| 4 | ERC-8004 trên chain khác (cùng địa chỉ `0x8004…` trên mọi mainnet) | Feedback sẵn có | Cộng ít (sau MVP) |
| 5 | PayCrow Reputation (Base) | Ký quỹ hoàn thành / dispute | Cộng (sau MVP) |
| 6 | Coinbase Verifications (EAS, Base) | Chủ ví đã KYC | Chống sybil (sau MVP) |

MVP ký quỹ chạy trên Fuji nhưng **đọc dữ liệu tham khảo từ mainnet** (chỉ đọc, không tốn phí). Mỗi nguồn tự khai báo chain nó đọc — không hardcode chain (bài học từ lỗi của PayCrow).

### A2. Luật

1. **Trần:** điểm tham khảo tối đa **40/100**.
2. **Nhạt dần:** `điểm = (k·điểm_tham_khảo + n·điểm_thật) / (k + n)`, với `n` = số giao dịch thật qua AgentPay, `k ≈ 5–10`.
3. **Tín hiệu xấu không bị trung bình hóa:** dính OFAC / lừa đảo → chặn ngay.
4. **Chứng minh sở hữu:** bên bán ký thông điệp chứng minh kiểm soát ví ở chain nguồn và ví trên Avalanche. Không ký → không được tính dữ liệu chain đó.
5. **Chống tự trả cho mình:** chỉ đếm ví trả tiền khác nhau; loại ví được chính bên bán nạp tiền; loại giao dịch quá nhỏ.
6. **Minh bạch:** dashboard tách "điểm tham khảo (nguồn…)" và "điểm thật (n giao dịch)".

### A3. Luật mua mặc định (luật người mua trong Escrow)

```
Đã đăng ký ERC-8004 + điểm ≥ minScore (mặc định 30) → được mở phiên, cap bình thường (≤ $20)
Đã đăng ký, điểm < minScore                          → chặn (MVP); sau MVP: phiên nhỏ cho bên bán chỉ có điểm tham khảo (cap ≤ $1, ≤ $1/ngày)
Chưa đăng ký (chỉ có link)                          → chặn
```

Không có đường trả thẳng qua AgentPay (D2): phiên quá nhỏ thì SDK gợi ý dùng scheme `exact` thông thường.

**Chống mạo danh:** chỉ coi là "đã đăng ký" khi
- `payTo` trong phản hồi 402 **trùng** ví nhận tiền khai trong ERC-8004, **và**
- tên miền của URL **nằm trong** danh sách endpoint của file đăng ký ERC-8004.

---

## B. Kiểm định (verification)

### B1. Nguyên tắc

1. **Luật kiểm định được chốt trước khi khóa tiền.** Phản hồi 402 của bên bán khai `verificationSpec` (schema, hạn giao, luật riêng). Mã băm của spec được lưu vào phiên lúc mở → không bên nào đổi luật trong suốt phiên. Mọi request trong phiên đều được kiểm theo cùng spec.
2. **Chỉ kiểm tra điều khách quan, máy kiểm được.** Chất lượng chủ quan (dịch hay, tóm tắt đúng ý) để sau MVP.
3. **Bên bán ký vào kết quả mình giao** → người mua không thể bịa ra dữ liệu xấu để đòi hoàn tiền; bên bán không thể chối đã giao gì.

Định dạng chi tiết của spec: xem `AgentPay_VerificationSpec.md`.

### B2. Luồng (theo phiên)

```
1. Phiên OPEN (lưu: specHash, verifier, cap, giá mỗi request, expiry)
2. Mỗi request: người mua gửi kèm Voucher (chữ ký, tổng tiền cộng dồn)
3. Bên bán trả kết quả + chữ ký Delivery(sessionId, seq, requestHash, keccak256(body))
4. Verifier (đứng giữa, chuyển tiếp dữ liệu) kiểm tra:
      a. chữ ký bên bán hợp lệ, keccak256(body) khớp
      b. giao trong hạn của request
      c. body khớp JSON Schema trong spec
      d. luật riêng theo loại dịch vụ (xem B3)
5. Verifier ký Receipt PASS/FAIL cho request đó (off-chain), gửi cho hai bên.
   Buyer SDK tự kiểm lại; kết quả khác → dừng phiên, khiếu nại
6. Đóng phiên (người mua dừng / hết cap / hết hạn / 3 FAIL liên tiếp):
   Verifier ký SessionVerdict → closeSession lên chain → mở khoảng chờ khiếu nại
7. Hết khoảng chờ → ai cũng gọi finalize():
      bên bán nhận tổng tiền các request PASS (trừ 0,5%)
      người mua nhận phần còn lại (trừ phí bảo vệ mỗi phiên)
      1 feedback ERC-8004 cho cả phiên = tỉ lệ PASS
   Quá hạn không ai đóng phiên → refund() → hoàn toàn bộ, không đổi uy tín
```

### B3. Luật riêng cho dịch vụ demo (bán giá AVAX)

| Kiểm tra | Điều kiện đạt |
|---|---|
| Định dạng | Có `symbol`, `price` (số > 0), `timestamp` |
| Độ tươi | `now − timestamp ≤ 60 giây` |
| Hợp lý | Lệch so với Chainlink AVAX/USD **trên mainnet** (`0x0A77230d17318075983913bC2145DB16C7366156`) ≤ 2% |
| Độ trễ | Giao trong ≤ 10 giây kể từ khi Verifier nhận request |

Kịch bản demo lỗi: bên bán trả giá lệch 20% → 3 request FAIL liên tiếp → phiên tự đóng → bên bán chỉ nhận tiền các request PASS, người mua được hoàn phần còn lại (xem `AgentPay_SystemDesign.md` §14.5).

### B4. Mức kiểm định theo giai đoạn

| Mức | Cách | Giai đoạn |
|---|---|---|
| Contract tự kiểm | Hạn giao, khớp mã băm đã cam kết | MVP |
| Verifier của AgentPay | B2 + B3, khóa ký riêng, luật công khai | MVP |
| Validator có đặt cọc | Đăng ký Validation Registry (ERC-8004), 3 validator theo đa số, sai thì mất cọc | Sau hackathon |
| LLM-judge cho dịch vụ chủ quan | Nhiều model chấm, chỉ dùng kèm validator có cọc | Sau hackathon |
| TEE | Phần cứng chứng nhận code kiểm định | Dài hạn |

### B5. Rủi ro đã biết

- **Verifier tập trung (MVP):** lộ khóa = ký bừa. Hạn chế: bên bán không nhận quá số người mua đã ký trong Voucher; chỉ dùng Verifier đã duyệt (VerifierRegistry); người mua tự kiểm lại; trần tiền đang chờ; thu hồi khóa; khoảng chờ khiếu nại (V1).
- **Hàng số đã giao trước kiểm định:** người mua đã có dữ liệu dù kết quả `fail`. Hạn chế: luật khách quan; phiên tự đóng sau 3 FAIL liên tiếp; uy tín người mua (sau MVP).
- **Spec do bên bán đặt:** bên bán có thể đặt spec quá lỏng. Hạn chế: Buyer SDK yêu cầu spec tối thiểu theo loại dịch vụ (Spec §7.2).
