# AgentPay — System Design v0.3

> MVP trên **Avalanche Fuji**, hạn **30/11/2026** (BK Fintech Hackday S15). Cập nhật: 2026-11-17.
> Tài liệu đi kèm: `AgentPay_VerificationSpec.md` (định dạng Spec, chữ ký, mã lỗi), `AgentPay_ThietKe.md` (điểm uy tín khởi đầu, nguyên tắc kiểm định), `reports/Xác minh kỹ thuật AgentPay.md` (nguồn của các số liệu kỹ thuật), `AgentPay_TomTat.docx` (ý tưởng ban đầu).
> Ký hiệu: **[cần xác minh]** = giả định chưa kiểm tra · **D#** = quyết định đã chốt (§12) · **Q#** = câu hỏi kỹ thuật (§13) · **V#**, **S#** = lỗ hổng (§11).
>
> **Cập nhật 2026-11-17 (v0.4):** người mua có **hai chế độ** (§3.3, D37): *Tự động* (ví riêng của agent) và *Duyệt* (ví chính trong MetaMask, người duyệt mỗi phiên, agent chỉ cầm khóa tạm `voucherSigner`). Thêm `voucherSigner` vào tham số phiên, `nonce` và struct `Session`.
>
> **Cập nhật 2026-11-17 (v0.3.1):** đưa cách xử lý mọi lỗ hổng cần cho MVP vào thiết kế thành cơ chế cụ thể (§5, §6, §7) và kèm danh sách test (§11.0). Sửa thêm 4 lỗ của chính thiết kế: mạo danh `agentId` ở contract (V15), không đủ tiền trừ `sessionFee` (S11), bên bán đóng phiên sớm bằng checkpoint (S10), phiên kẹt ở CHALLENGED (S12). Quyết định mới D30–D36.
>
> **Thay đổi so với v0.2:** bỏ Policy Wallet (gói Secure) khỏi dự án, chỉ còn một đường mở phiên cho ví EOA; thêm mục "Cài đặt an toàn cho EOA" (§3.5); sắp xếp lại toàn bộ tài liệu, gộp thiết kế phiên (§14 cũ) vào phần chính; thống nhất tên `registerBuyer` và `maxPerSession`. Công nghệ và logic không đổi.

## Mục lục

1. Tổng quan
2. Thuật ngữ
3. Kiến trúc tổng thể
4. Mô hình ký quỹ theo phiên
5. Thành phần chi tiết
6. Luồng hoạt động
7. Máy trạng thái của phiên
8. Mô hình dữ liệu
9. Kinh tế: phí, gas, tiền cọc
10. Mô hình tin cậy
11. Lỗ hổng và rủi ro
12. Quyết định đã chốt
13. Xác minh kỹ thuật và câu hỏi còn mở
14. Phạm vi MVP, kế hoạch và demo
15. Tái sử dụng từ PayCrow

Phụ lục A. Số đo gas của mô hình cũ (một lệnh = một escrow)
Phụ lục B. Lộ trình sau MVP

---

## 1. Tổng quan

### 1.1 Bài toán

AI agent trả tiền cho API qua x402: trả trước, nhận dữ liệu sau. Dữ liệu sai thì vẫn mất tiền. Ký quỹ (escrow) giải được việc này, nhưng mỗi lệnh ký quỹ tốn khoảng 500k gas (~$0,03), lớn hơn nhiều so với giá một request (vài cent) (Phụ lục A). Ngoài ra agent có thể bị lừa (prompt injection) trả tiền cho bên bán xấu.

### 1.2 Ý tưởng

1. **Ký quỹ theo phiên:** người mua khóa một khoản `cap` một lần cho một bên bán. Mỗi request chỉ là một chữ ký off-chain. Cả phiên chỉ tốn 2–3 giao dịch on-chain.
2. **Không đạt thì không trả:** Verifier kiểm từng request theo Spec đã khóa on-chain lúc mở phiên. Bên bán chỉ nhận tiền các request PASS.
3. **Hạn mức cho ví EOA:** luật chi tiêu nằm trong contract escrow, agent bị lừa cũng không vượt được, mà người dùng không phải đổi ví. Hai chế độ: agent tự chủ với ví riêng, hoặc người dùng giữ ví chính trong MetaMask và duyệt mỗi phiên một lần, agent chỉ cầm khóa tạm của phiên.
4. **Uy tín ERC-8004:** mỗi phiên ghi một feedback lên registry ERC-8004 chính thức, dùng để lọc bên bán ở lần sau.

Thông điệp khác biệt (D28): *"Kiểm định tự động bằng Spec khóa on-chain + thanh toán vi mô theo phiên + hạn mức cho EOA."*

### 1.3 Mục tiêu

| # | Mục tiêu | Đo bằng |
|---|---|---|
| G1 | Agent chỉ tiêu tiền trong luật chủ agent đặt | Không phiên nào vượt hạn mức hoặc mở với bên bán bị cấm |
| G2 | Không đạt thì không trả, kể cả request vài cent | Request FAIL không bị tính tiền; phần chưa dùng của phiên về người mua, không cần người can thiệp |
| G3 | Bên bán được bảo vệ | Tiền đã khóa trong phiên thì người mua không tự rút được; request PASS → tiền về bên bán |
| G4 | Uy tín phản ánh giao dịch có tiền thật | Mỗi feedback uy tín gắn với một `sessionId` trên chain |
| G5 | Tương thích x402 | Dùng định dạng x402 v2 (402, `PAYMENT-SIGNATURE`, `extensions`); mô hình phiên bám theo scheme `batch-settlement` của x402 |

### 1.4 Không làm trong MVP

- Không giữ tiền thay người dùng ngoài contract (non-custodial).
- Không kiểm định chất lượng chủ quan (bản dịch, tóm tắt).
- Không validator phi tập trung, không TEE.
- Không ví hợp đồng riêng (Policy Wallet đã bỏ, D1). Không trả thẳng qua AgentPay (D2).
- Không mainnet, không tiền thật, không VND hay fiat.

---

## 2. Thuật ngữ

| Từ | Nghĩa |
|---|---|
| **Người mua (buyer)** | Ví **EOA** trả tiền của phiên: ví riêng của agent (chế độ Tự động) hoặc ví chính của người dùng (chế độ Duyệt) |
| **Chế độ Tự động / Duyệt** | Hai cách dùng của người mua (§3.3). Tự động: agent tự ký mọi thứ bằng ví riêng. Duyệt: người bấm duyệt mở phiên trong MetaMask, agent chỉ ký Voucher bằng khóa tạm |
| **`voucherSigner`** | Địa chỉ được ký Voucher của một phiên, chốt lúc mở phiên. Chế độ Tự động: chính ví agent. Chế độ Duyệt: **khóa tạm** SDK tạo riêng cho phiên |
| **Chủ agent** | Người sở hữu agent. Đặt luật chi tiêu qua một ví **admin** riêng (ví dụ MetaMask), khác khóa của agent |
| **Luật người mua** (`BuyerPolicy`) | Hạn mức của một EOA, lưu trong contract escrow: tối đa mỗi phiên, tối đa mỗi ngày, điểm tối thiểu của bên bán, danh sách bên bán được phép, nút dừng |
| **Bên bán (seller)** | Dịch vụ thu tiền qua x402, có danh tính ERC-8004 (`agentId`) |
| **Escrow** | Contract ký quỹ theo phiên `AgentPaySessionEscrow` |
| **Phiên (session)** | Người mua khóa `cap` USDC cho **một bên bán + một Verifier + một Spec**, dùng cho nhiều request tới khi đóng |
| **Spec** | `verificationSpec`: bộ luật kiểm định, mã băm (`specHash`) được khóa vào phiên lúc mở |
| **Voucher** | Chữ ký off-chain của người mua cho mỗi request, ghi tổng tiền **cộng dồn** |
| **Delivery** | Chữ ký của bên bán lên dữ liệu đã giao cho một request |
| **Receipt** | Kết quả PASS / FAIL / INCONCLUSIVE có chữ ký của Verifier cho từng request (off-chain) |
| **SessionVerdict** | Kết quả tổng của cả phiên do Verifier ký, nộp lên chain khi đóng phiên |
| **Verifier** | Dịch vụ làm relay giữa hai bên, kiểm định và ký Receipt, SessionVerdict |
| **VerifierRegistry** | Danh sách Verifier đã duyệt, nằm trong Escrow |
| **Facilitator** | Server x402 gửi chữ ký mở phiên lên chain và trả gas |
| **Keeper** | Bot gọi `finalize()` / `refund()` khi tới hạn |
| **Scorer** | Dịch vụ tính điểm uy tín (điểm thật + điểm tham khảo), ký score attestation |
| **Guardian** | Ví riêng có quyền `revokeVerifier` và `pause` toàn hệ thống (D21) |

---

## 3. Kiến trúc tổng thể

### 3.1 Sơ đồ

```
                         ┌──────────────────────── OFF-CHAIN ────────────────────────┐
                         │                                                            │
  ┌──────────────┐       │   ┌────────────┐   ┌────────────┐   ┌──────────────────┐  │
  │ Agent người  │──402──┼──►│ Seller SDK │   │ Facilitator│   │ Verifier (relay) │  │
  │ mua (EOA)    │◄──────┼───│ (bên bán)  │──►│ x402-bridge│   │ + kho body       │  │
  │ + Buyer SDK  │       │   └────────────┘   └─────┬──────┘   └────────┬─────────┘  │
  │ / MCP server │───────┼─────── request + Voucher ┼───────────────────►│            │
  └──────────────┘       │   ┌────────────┐   ┌─────┴──────┐   ┌────────┴─────────┐  │
  ┌──────────────┐       │   │ Dashboard  │   │ Keeper bot │   │ Scorer + Probe   │  │
  │ Chủ agent    │───────┼──►│ (ví admin) │   │            │   │ (đọc mainnet)    │  │
  └──────────────┘       │   └─────┬──────┘   └─────┬──────┘   └────────┬─────────┘  │
                         └─────────┼────────────────┼───────────────────┼────────────┘
                                   ▼                ▼                   ▼
  ┌──────────────────────────────── ON-CHAIN (Avalanche Fuji) ─────────────────────────┐
  │   USDC (Circle) ◄──► AgentPaySessionEscrow ──► ERC-8004 Reputation (có sẵn)         │
  │                      ├─ luật người mua (BuyerPolicy)    ERC-8004 Identity (có sẵn)  │
  │                      └─ VerifierRegistry                                            │
  └─────────────────────────────────────────────────────────────────────────────────────┘
        Chỉ đọc: Avalanche mainnet + Base mainnet (lịch sử USDC), Chainlink AVAX/USD mainnet
```

**On-chain chỉ có một contract của AgentPay.** USDC và ERC-8004 là contract có sẵn.

### 3.2 Cách người mua dùng AgentPay

Chỉ có một đường on-chain: **ví EOA, mở phiên qua facilitator.**

1. **Một lần:** gọi `registerBuyer(admin, policy)` bằng ví sẽ trả tiền. Từ đó chỉ ví admin sửa được luật (§5.1.2).
2. **Mở phiên:** ví trả tiền ký **một** chữ ký EIP-3009 `receiveWithAuthorization` cho `cap`, trong đó chỉ định **`voucherSigner`**: khóa sẽ ký Voucher của phiên này. Facilitator gọi `openWithAuthorization`. Escrow kiểm luật người mua và kéo USDC vào trong cùng giao dịch.
3. **Mỗi request:** `voucherSigner` ký **Voucher** off-chain, gửi qua Verifier. Không có giao dịch on-chain.
4. **Đóng phiên:** Verifier nộp Voucher mới nhất + SessionVerdict. Keeper chốt và chia tiền.

Người mua chỉ cần vài request thì SDK gợi ý trả bằng scheme `exact` thông thường, không qua AgentPay (D2).

### 3.3 Hai chế độ của người mua (D37)

Hai chế độ khác nhau ở chỗ **ai ký mở phiên** và **ai ký Voucher**. Contract chỉ có một luồng; chế độ chỉ là cách Buyer SDK điền `voucherSigner`.

| | **Chế độ Tự động** (agent tự chủ) | **Chế độ Duyệt** (người duyệt mỗi phiên) |
|---|---|---|
| Ví trả tiền | **Ví riêng của agent** (EOA mới). Chủ chuyển ít USDC từ ví chính sang | **Ví chính của người dùng** (MetaMask, kết nối qua trình duyệt hoặc WalletConnect). Không chuyển tiền đi đâu |
| Ai ký mở phiên | Khóa ví agent, nằm trong MCP server, tự ký | **Người bấm duyệt trong MetaMask**, mỗi phiên một lần |
| `voucherSigner` | Chính ví agent | **Khóa tạm** do SDK tạo cho riêng phiên đó, chỉ nằm trong bộ nhớ, hết phiên thì bỏ |
| Agent cầm khóa gì | Khóa ví agent (tiêu được mọi thứ trong ví đó) | Chỉ khóa tạm (chỉ ký được Voucher trong phiên, chỉ trả cho đúng bên bán của phiên) |
| Lộ khóa thì mất tối đa | Số dư trong ví agent | `cap − sessionFee` của một phiên, và chỉ cho các request PASS |
| Cần AVAX | Không (facilitator trả gas mở phiên); `registerBuyer` cần chút AVAX một lần | Như bên trái |
| Hợp với | Agent chạy 24/7, không có người trông | Agent làm theo lần ("viết báo cáo này đi"), người dùng muốn giữ ví chính trong MetaMask |
| Luật người mua (`registerBuyer`) | **Bắt buộc** (lớp chặn duy nhất khi agent bị lừa) | **Khuyến nghị** (người đã duyệt từng phiên, luật là lớp thứ hai) |

**Trang duyệt (chế độ Duyệt).** Khi cần mở phiên, Buyer SDK mở một trang trên máy người dùng (`localhost`, do SDK phục vụ). Trang hiện rõ: bên bán (tên, `agentId`, điểm uy tín, tên miền), giá mỗi request, `cap`, `expiry`, tóm tắt Spec, Verifier. Người dùng bấm "Duyệt" thì MetaMask hiện chữ ký EIP-3009 (người nhận = Escrow AgentPay, số tiền = `cap`). Lưu ý MetaMask chỉ hiện "trả $5 cho Escrow", không hiện bên bán vì bên bán nằm trong `nonce` đã băm; vì vậy trang duyệt phải hiện tham số đã giải mã, và luật người mua vẫn chặn bên bán không đạt (V-BLIND).

### 3.4 Vì sao chỉ dùng EOA

- Phần lớn agent hiện dùng ví EOA. Bắt đổi sang ví hợp đồng sẽ chặn đường tiếp cận người dùng.
- Luật người mua nằm trong Escrow nên vẫn có hạn mức **bắt buộc** trên chain cho mọi khoản trả qua AgentPay, mà không phải đổi ví.
- Policy Wallet (ví hợp đồng giữ tiền) đã bỏ khỏi dự án (D1, 2026-11-17) để dồn thời gian cho phần lõi. Hỗ trợ smart account nằm trong lộ trình (Phụ lục B).

**Giới hạn phải nói rõ:** ví EOA không có code, ai giữ khóa thì ký được mọi giao dịch. Luật người mua chỉ chặn tiền **đi qua AgentPay**.
- **Chế độ Tự động:** kẻ có khóa ví agent, hoặc agent có sẵn công cụ chuyển tiền tự do, vẫn `transfer` USDC thẳng đi nơi khác được. Luật của AgentPay **chống agent bị lừa khi trả qua AgentPay, không chống mất khóa**. Phần còn lại được giảm bằng cách cài đặt ở §3.5.
- **Chế độ Duyệt:** agent **không bao giờ cầm khóa ví chính**, nên không `transfer` thẳng được. Đây là cách AgentPay lấp điểm yếu trên mà không cần ví hợp đồng. Đánh đổi: mỗi phiên cần một lần người bấm duyệt.

### 3.5 Cài đặt an toàn cho chế độ Tự động

Khuyến nghị cho người dùng, ghi trong README của Buyer SDK. Đây là cách cài đặt, blockchain không ép được. Chế độ Duyệt không cần các bước này vì agent không cầm khóa ví.

| # | Khuyến nghị | Chống được |
|---|---|---|
| 1 | **Chỉ cấp tool của AgentPay cho agent.** Không cài thêm bộ tool ví đa năng có hàm `transfer(to, amount)` (ví dụ các action chuyển tiền của AgentKit, GOAT SDK) | Agent bị prompt injection gọi `transfer` thẳng, vượt qua Escrow |
| 2 | **Agent không cầm khóa.** Khóa EOA nằm trong tiến trình MCP server của AgentPay (hoặc dịch vụ ký riêng). Agent chỉ gọi tool, không đọc được file khóa, không chạy được script ký | Agent có quyền chạy code tự viết script ký giao dịch |
| 3 | **Chỉ để ít tiền trong ví agent.** Chủ giữ tiền ở ví riêng, nạp dần cho ví agent (bằng tay hoặc script) | Lộ khóa: mất tối đa số dư nhỏ trong ví |

Khi thuyết trình: *"AgentPay kiểm soát mọi khoản trả qua x402. Muốn agent không bao giờ cầm khóa ví chính thì dùng chế độ Duyệt: bấm duyệt một lần mỗi phiên trong MetaMask, agent chỉ có khóa tạm của phiên đó. Agent chạy tự động 24/7 thì dùng ví riêng có ít tiền, chỉ cấp tool AgentPay. Smart account có hạn mức nằm trong lộ trình."*

---

## 4. Mô hình ký quỹ theo phiên

### 4.1 Ý tưởng

Một **phiên** = người mua khóa `cap` (ví dụ $5) cho **một bên bán, một Verifier, một Spec**, dùng trong thời hạn `expiry`.
- **On-chain:** 2–3 giao dịch cho cả phiên: mở, đóng, chốt (có thể gộp đóng và chốt).
- **Off-chain:** mỗi request là một Voucher của người mua và một Receipt của Verifier.
- Cuối phiên, Verifier ký **một SessionVerdict**: bên bán nhận tổng tiền các request **PASS**, phần còn lại về người mua.

Đây là **kênh thanh toán một chiều** (payment channel) có thêm kiểm định: Voucher mang số tiền cộng dồn, nên chỉ cần Voucher mới nhất. Một lệnh lớn đơn lẻ (ví dụ $15) là một phiên có một request, nên contract chỉ có **một kiểu ký quỹ**.

Mô hình này bám theo scheme `batch-settlement` của x402 (nạp một lần, voucher cộng dồn, hoàn phần dư), và thêm phần kiểm định mà `batch-settlement` không có (Q25).

### 4.2 Chữ ký (EIP-712, domain `AgentPay` / `0.2`)

Domain có `chainId` và `verifyingContract`. Định dạng chi tiết và cách băm ở Spec §5–6.

```
Voucher(                    // voucherSigner của phiên ký, gửi kèm mỗi request
  uint256 sessionId,
  uint32  seq,              // tăng đúng 1, bắt đầu từ 1
  uint128 cumulativeAmount, // = seq × pricePerRequest, ≤ cap − sessionFee
  bytes32 requestHash       // keccak256(method, url, body) của request seq
)

Delivery(                   // bên bán ký khi giao dữ liệu
  uint256 sessionId, uint32 seq, bytes32 requestHash, bytes32 bodyHash, bytes32 specHash
)

Receipt(                    // Verifier ký sau mỗi request, gửi cho cả hai bên (off-chain)
  uint256 sessionId, uint32 seq, bytes32 requestHash, bytes32 bodyHash,
  uint8 outcome, uint16 reasonCode, uint128 amount,
  uint64  receivedAt,       // lúc Verifier nhận body (đo hạn giao, kiểm freshness)
  bytes32 evidenceHash      // keccak256(abi.encode(feed, roundId, answer, updatedAt)) của oracle đã dùng; 0 nếu không dùng oracle
)                           // receivedAt + evidenceHash cho phép kiểm định lại đúng như lúc đầu khi khiếu nại (V-TIME)

ScoreAttestation(           // Scorer ký; domain riêng {name "AgentPay Scorer", version "0.2", chainId, verifyingContract = Escrow}
  uint256 agentId,
  address wallet,           // ví nhận tiền của agentId (đã đối chiếu với file đăng ký ERC-8004)
  uint16  score,            // 0–100
  uint16  flags,            // bit 0 = chỉ có điểm tham khảo; bit 1 = bị gắn cờ OFAC/lừa đảo
  uint64  validUntil        // ≤ 1 giờ kể từ lúc ký
)

SessionVerdict(             // Verifier ký khi đóng phiên (và bản tạm mỗi 20 request)
  uint256 sessionId,
  bytes32 specHash,
  uint32  lastSeq,          // phải bằng seq của Voucher nộp kèm
  uint32  passCount, uint32 failCount, uint32 inconclusiveCount,
  uint128 passedAmount,     // tổng amount các Receipt PASS
  bytes32 receiptsRoot,     // Merkle root của các Receipt, để đối chiếu và khiếu nại
  uint64  closedAt
)
```

**Nonce mở phiên** (ràng buộc chữ ký EIP-3009 với đúng tham số phiên):
```
nonce = keccak256(abi.encode(seller, sellerAgentId, verifier, voucherSigner, specHash, cap,
                             pricePerRequest, expiry, deliveryDeadlineSec, challengeWindowSec, salt))
```

### 4.3 Bất biến

- Bên bán không bao giờ nhận quá số người mua đã ký trong Voucher, kể cả khi Verifier gian lận: `passedAmount ≤ cumulativeAmount ≤ cap − sessionFee`.
- Phần trừ `sessionFee` luôn đủ: tiền dùng được trong phiên là `cap − sessionFee`, nên kể cả khi mọi request PASS, phần hoàn của người mua vẫn ≥ 0 (§5.1.5).
- Tổng tiền ra = `cap` (bên bán + người mua + phí). Không có tiền kẹt lại.
- Chỉ `voucherSigner` của phiên ký được Voucher. `voucherSigner` nằm trong `nonce` mà ví trả tiền đã ký, nên không ai thay được.
- `sellerAgentId` luôn được ràng buộc với ví `seller` lúc mở phiên (§5.1.2), nên feedback uy tín không bao giờ ghi nhầm sang agent khác.
- Uy tín chỉ đổi khi có SessionVerdict ký số (hoặc bằng chứng equivocation).
- Verifier được chốt theo từng phiên lúc mở. Admin đổi Verifier mặc định không ảnh hưởng phiên cũ.

### 4.4 Khi nào đóng phiên

- Người mua báo dừng.
- Hết `cap` hoặc hết `expiry` (mặc định 1 giờ, tối đa 24 giờ, D7).
- **3 lần FAIL liên tiếp** (D8): Verifier tự đóng để bảo vệ người mua.

Người mua ký Voucher **trước** khi nhận dữ liệu (bên bán yên tâm). Người mua vẫn được bảo vệ vì chỉ request PASS mới tính vào `passedAmount`.

---

## 5. Thành phần chi tiết

### 5.1 `AgentPaySessionEscrow` (on-chain)

**Trách nhiệm:** giữ USDC của phiên, ràng buộc phiên với Spec và Verifier, kiểm luật người mua, nhận SessionVerdict, khoảng chờ khiếu nại, chia tiền, ghi uy tín, quản lý VerifierRegistry.

#### 5.1.1 Hàm của phiên

| Hàm | Ai gọi | Làm gì |
|---|---|---|
| `openWithAuthorization(params, salt, auth, scoreAtt, attSig)` | Facilitator | `sessionId = uint256(keccak256(abi.encode(auth.from, nonce)))` (F1). Theo thứ tự: (1) hệ thống không `pause`; (2) tính lại `nonce` (§4.2), khớp `auth.nonce`; (3) `auth.validBefore ≤ now + MAX_AUTH_TTL` (10 phút, V9); (4) `params.verifier` ACTIVE (không thì revert `UnknownVerifier`) và `inFlight + cap ≤ maxInFlight`; (5) `cap` trong [$0,50; $20] và `cap > sessionFee`; `expiry ≤ now + 24 giờ`; (6) **ràng buộc bên bán** bằng `scoreAtt` (§5.1.2, luôn bắt buộc); (7) luật người mua với `cap`; (8) `USDC.receiveWithAuthorization(cap)`; (9) chốt `sessionFee`, `feeBps` hiện hành và `voucherSigner` (≠ 0) vào phiên; tạo phiên OPEN, `inFlight += cap` |
| `closeSession(sessionId, voucher, buyerSig, verdict, verifierSig)` | Verifier của phiên; bên bán chỉ khi `now ≥ expiry` | Kiểm chữ ký Voucher của `session.voucherSigner` và chữ ký Verifier; Verifier chưa bị thu hồi; `verdict.specHash == session.specHash`; `verdict.lastSeq == voucher.seq`; `passedAmount ≤ cumulativeAmount ≤ cap − sessionFee`; `cumulativeAmount = seq × giá`, `passedAmount = passCount × giá`, `pass + fail + inconclusive ≤ lastSeq` (F2); `now ≤ expiry + VERDICT_GRACE` (không thì revert `VerdictTooLate`). Người gọi không phải Verifier mà `now < expiry` → revert `TooEarly` (S10). `challengeWindow = 0` thì chốt luôn, không thì sang CLOSING |
| `closeEmpty(sessionId, verdict, verifierSig)` | Bất kỳ ai | Verdict ký với `lastSeq = 0` → hoàn toàn bộ, không thu phí, không đổi uy tín. Dùng khi người mua bỏ đi trước request đầu tiên (V9) |
| `challenge(sessionId, reasonCode, bondAuth)` | Chỉ người mua hoặc bên bán của phiên | Trong khoảng chờ; cọc trả bằng EIP-3009 `receiveWithAuthorization` (`bondAuth.from` phải là người mua hoặc bên bán), mức cọc ở §9.5 → CHALLENGED, `resolveDeadline = now + RESOLVE_TIMEOUT` (24 giờ) |
| `resolveChallenge(sessionId, passCount, failCount, upheld)` | Arbiter (MVP: nhóm, D4) | Trước `resolveDeadline`. `passedAmount = passCount × pricePerRequest` ≤ `cumulativeAmount`. `upheld = true` → trả cọc cho người khiếu nại; `false` → cọc về bên còn lại (§6.8) → SETTLED, chia tiền và ghi feedback như `finalize` (F3) |
| `expireChallenge(sessionId)` | Bất kỳ ai | Quá `resolveDeadline` mà Arbiter chưa xử lý → hoàn người mua toàn bộ `cap`, trả lại cọc cho người khiếu nại, không thu phí, không đổi uy tín (Q12) → REFUNDED |
| `proveEquivocation(sessionId, delivA, sigA, delivB, sigB)` (`seq` nằm trong Delivery, F9) | Bất kỳ ai | Phiên OPEN hoặc CLOSING. Hai Delivery hợp lệ của bên bán cho cùng `(sessionId, seq)` nhưng khác `bodyHash` → hoàn người mua toàn bộ, không thu phí, feedback −100 (V3) → REFUNDED |
| `finalize(sessionId)` | Bất kỳ ai (thường là Keeper) | Hết khoảng chờ → chuyển thẳng `passedAmount − sellerFee` cho bên bán và `cap − passedAmount − sessionFee` cho người mua (push; lỗi chuyển thì ghi `withdrawable`, V19); ghi **một** feedback ERC-8004 → SETTLED |
| `refund(sessionId)` | Bất kỳ ai | Quá `expiry + VERDICT_GRACE` mà chưa đóng → hoàn 100% `cap`, không thu phí, **không đổi uy tín** → REFUNDED |
| `withdraw(to)` | Người có `withdrawable` | Rút về địa chỉ `to` bất kỳ do chính người nhận chọn, để ví bị Circle blacklist vẫn lấy được tiền về ví khác (V19) |
| `topUp(sessionId, auth)` | Facilitator | Nạp thêm vào `cap`. **Sau MVP** |

Mọi đường kết thúc phiên (SETTLED, REFUNDED) đều trừ `inFlightByVerifier[verifier] -= cap`. Mọi hàm chuyển tiền dùng `nonReentrant` (bản transient) và theo thứ tự kiểm tra → ghi trạng thái → chuyển tiền (V-RE).

#### 5.1.2 Luật người mua (hạn mức cho EOA)

**Hai lớp kiểm tra:**

| Lớp | Ở đâu | Kiểm gì | Bắt buộc được không |
|---|---|---|---|
| 1. Mềm | Buyer SDK / MCP, **trước khi ký** | Mọi luật | Không: agent không dùng SDK là bỏ qua được |
| 2. Cứng | `openWithAuthorization`, **trong cùng giao dịch** | Luật của `from`, áp lên `cap` của phiên | Có, nhưng chỉ cho tiền đi qua AgentPay (§3.4) |

`from` không giả được: USDC chỉ chấp nhận chữ ký EIP-3009 của chính `from`, và Escrow đọc luật của đúng `from` đó.

**Ai được đặt luật.** Không cho chính khóa của agent sửa luật, nếu không agent bị lừa sẽ tự nới hạn mức.
- Script cài đặt (không phải agent) dùng khóa EOA gọi `registerBuyer(admin, policy)` **một lần**. `admin` là ví riêng của chủ agent.
- Sau đó **chỉ `admin`** sửa được luật, đổi được `admin`, bấm dừng. Admin có thể ký EIP-712 cho dashboard gửi lên, nên không cần có AVAX.
- **Siết thì có hiệu lực ngay; nới thì chờ 24 giờ** (timelock). Nếu khóa admin bị lộ, chủ agent vẫn còn thời gian phát hiện.
- EOA chưa đăng ký thì dùng luật mặc định của contract: chỉ giới hạn `cap` ≤ $20. Luật mua mặc định chi tiết hơn (`AgentPay_ThietKe.md` A3) là luật **mềm** của Buyer SDK. Vì vậy hướng dẫn cài đặt bắt buộc bước `registerBuyer` (§6.2): không đăng ký thì không có lớp chặn cứng trước prompt injection.

**Ràng buộc bên bán (luôn bắt buộc, kể cả khi `minScore = 0`).** Nếu không kiểm, ai cũng mở được phiên trả tiền cho ví của mình nhưng khai `sellerAgentId` của một agent khác. Khi đó feedback sẽ ghi vào agent bị mạo danh: hạ điểm đối thủ bằng cách cố tình FAIL, hoặc thổi điểm cho agent mình (V15). Escrow kiểm `scoreAtt`:
- chữ ký đúng `scorerSigner` (địa chỉ do admin đặt), domain đúng chain và Escrow;
- `att.agentId == params.sellerAgentId` và `att.wallet == params.seller`;
- `now ≤ att.validUntil ≤ now + MAX_ATTEST_TTL` (1 giờ, V-SC);
- `flags` bit 1 (bị gắn cờ) = 0;
- `minScore > 0` thì thêm `att.score ≥ minScore` (không thì revert `BadScore`).

Scorer chỉ ký `wallet` khi `wallet` trùng ví nhận tiền khai trong file đăng ký ERC-8004 của `agentId`. **Thêm (F4, Q-ID đã giải):** Escrow đọc on-chain `IdentityRegistry.getMetadata(agentId, "agentWallet")` và revert `IdentityWalletMismatch` nếu khác `params.seller`. Attestation vẫn bắt buộc cho điểm và cờ.

**Hạn mức theo ngày dùng "token bucket":** hạn mức hồi lại đều theo thời gian (`dailyCap / 24 giờ`). Chỉ cần 2 biến lưu trữ, không bị lỗi ranh giới ngày (V18).

```solidity
struct BuyerPolicy {
    address admin;
    uint128 maxPerSession;
    uint128 dailyCap;
    uint16  minScore;          // 0 = không kiểm
    bool    paused;
    bool    sellerAllowlistOn;
}
struct Bucket { uint128 available; uint64 lastUpdate; }
struct PendingLoosen { BuyerPolicy p; uint64 effectiveAt; }

mapping(address => BuyerPolicy) public buyerPolicy;
mapping(address => Bucket)      public bucket;
mapping(address => PendingLoosen) public pending;
mapping(address => mapping(uint256 => bool)) public sellerAllowed; // buyer => agentId

function _checkAndConsume(address buyer, uint128 amount, uint256 sellerAgentId,
                          ScoreAttestation calldata att) internal {
    BuyerPolicy memory p = buyerPolicy[buyer];
    // _bindSeller(att, seller, sellerAgentId) đã chạy trước hàm này (luôn bắt buộc)
    if (p.admin == address(0)) {                 // chưa đăng ký → luật mặc định
        if (amount > DEFAULT_MAX_PER_SESSION) revert OverPerSession();
        return;
    }
    if (p.paused) revert BuyerPaused();
    if (amount > p.maxPerSession) revert OverPerSession();
    if (p.sellerAllowlistOn && !sellerAllowed[buyer][sellerAgentId]) revert SellerNotAllowed();
    if (p.minScore > 0 && att.score < p.minScore) revert BadScore();

    Bucket storage b = bucket[buyer];
    uint256 refill = uint256(p.dailyCap) * (block.timestamp - b.lastUpdate) / 1 days;
    uint256 avail  = _min(p.dailyCap, b.available + refill);
    if (amount > avail) revert OverDailyCap();
    b.available  = uint128(avail - amount);
    b.lastUpdate = uint64(block.timestamp);
    emit BuyerSpend(buyer, amount, b.available);
}
```

**Hàm quản lý:** `registerBuyer` (gọi một lần, `msg.sender` = EOA), `tighten(policy)` (admin, có hiệu lực ngay, kẹp `available` xuống), `proposeLoosen(policy)` + `applyLoosen()` (sau 24 giờ; `cancelLoosen()` hủy được), `pauseBuyer(buyer)` (admin hoặc chính ví người mua, có hiệu lực ngay) / bỏ dừng = `proposeLoosen` với `paused = false` (chờ 24 giờ), `setSellerAllowed` (thêm bên bán = nới, chờ 24 giờ rồi `applySellerAllowed`; bớt = siết, ngay), `proposeAdmin` / `applyAdmin` / `cancelAdmin` (chờ 24 giờ). Các hàm `apply...` ai cũng gọi được khi đã hết thời gian chờ. Hàm nào của admin cũng có bản `...BySig` (EIP-712, `nonce` = `adminNonces[buyer]` tăng dần, có `deadline`) (F6).

Phân loại "siết / nới" phải đúng cho **từng trường**, không thì kẻ có khóa admin né được timelock (V-ADM). Mọi thay đổi phát sự kiện `PolicyTightened`, `LoosenProposed`, `LoosenApplied`, `BuyerPaused` để dashboard cảnh báo ngay.

**Quy tắc nhỏ:**
- Phần tiền hoàn của phiên **không** được cộng lại vào hạn mức ngày (D16). Hạn mức bị trừ đủ `cap` lúc mở phiên.
- Bên bán: kiểm `sellerAgentId` khớp ví nhận tiền trong ERC-8004 Identity. MVP: Scorer ký kèm trong attestation; kiểm trực tiếp trên chain nếu Identity Registry v2.0.0 có hàm đọc ví phù hợp **[cần xác minh khi code]**.
- Chữ ký EIP-3009 bị từ chối vì vượt hạn mức vẫn còn hiệu lực tới `validBefore`. Giữ `validBefore` ngắn (≤ 2 phút) để chữ ký đó không bị dùng lại khi hạn mức đã hồi.

#### 5.1.3 VerifierRegistry (chống lộ khóa Verifier, V1)

| Hàm | Ai gọi | Làm gì |
|---|---|---|
| `addVerifier(addr, maxInFlight)` | Admin (sau MVP: có timelock) | Đưa Verifier vào danh sách đã duyệt, đặt trần tiền đang chờ |
| `revokeVerifier(addr)` | Admin hoặc guardian, **có hiệu lực ngay** | Từ chối mọi chữ ký của khóa này: không mở phiên mới, không nhận `closeSession`. Phiên đang mở chờ hết hạn rồi `refund` toàn bộ cho người mua, không đổi uy tín bên bán |
| `pauseSystem()` / `unpauseSystem()` | Admin hoặc guardian / chỉ admin | Dừng mở phiên mới trên toàn hệ thống (vẫn cho `refund`). Đổi tên để không trùng `pauseBuyer` (F7) |

Đổi khóa = `addVerifier(khóa mới)` rồi `revokeVerifier(khóa cũ)`. Phiên cũ không chuyển sang khóa mới được.

#### 5.1.4 Ràng buộc và sự kiện

- `cap` mỗi phiên: **$0,50 – $20** (D6). `expiry`: mặc định 1 giờ, tối đa 24 giờ (D7).
- `maxInFlightPerVerifier` = $1.000 trên testnet (D12): giới hạn thiệt hại nếu khóa Verifier bị lộ.
- Phí: xem §5.1.5.
- **Kích thước (EIP-170):** phần quản lý luật người mua nằm trong library `BuyerRules` (hàm `external`, gọi bằng DELEGATECALL nên storage, `msg.sender` và event vẫn là của Escrow), cùng `optimizer_runs = 1`. Escrow còn 23,9 KB, dưới giới hạn 24 KB. Storage của phiên được xếp gọn (§9.3); interface không đổi.
- Biên dịch với `evm_version = "cancun"`: C-Chain có EIP-1153, PUSH0, MCOPY, **không** có EIP-7702 (Q3). Dùng `ReentrancyGuardTransient`.
- Sự kiện: `SessionOpened`, `SessionClosed`, `Challenged`, `ChallengeExpired`, `EquivocationProven`, `Resolved`, `Settled`, `Refunded`, `VerifierAdded`, `VerifierRevoked`, `BuyerSpend`, `PolicyTightened`, `LoosenProposed`, `LoosenApplied`, `BuyerPaused`, `FeeChanged`.

**Hằng số của contract** (D30–D33):

| Hằng số | Giá trị | Chống |
|---|---|---|
| `MAX_AUTH_TTL` | 10 phút | Chữ ký mở phiên sống lâu, facilitator gửi muộn (V9) |
| `MAX_ATTEST_TTL` | 1 giờ | Score attestation cũ hoặc do khóa Scorer bị lộ ký từ trước (V-SC) |
| `RESOLVE_TIMEOUT` | 24 giờ | Phiên kẹt ở CHALLENGED nếu Arbiter không xử lý (Q12) |
| `VERDICT_GRACE` | 10 phút | Tranh chấp `refund` / `closeSession` (§7) |
| `LOOSEN_DELAY` | 24 giờ | Lộ khóa admin của người mua (V-ADM) |
| `MAX_SESSION_FEE` | $0,10 | Admin tăng phí bất ngờ (V26) |
| `MAX_FEE_BPS` | 100 (1%) | Như trên |

#### 5.1.5 Phí và làm tròn

- `sessionFee` (D13) và `feeBps` (D14, 50 = 0,5%) là biến admin đổi được, nhưng **không vượt** `MAX_SESSION_FEE` / `MAX_FEE_BPS`, và được **chốt vào phiên lúc mở**. Đổi phí chỉ áp cho phiên mở sau đó (V26). Buyer SDK đọc `sessionFee()` từ contract trước khi ký và từ chối nếu khác số đã hiển thị.
- **Tiền dùng được trong phiên = `cap − sessionFee`.** Voucher chỉ hợp lệ khi `cumulativeAmount ≤ cap − sessionFee`. Nếu không có ràng buộc này, phiên dùng hết `cap` sẽ không còn gì để trừ phí (S11).
- `sellerFee = passedAmount × feeBps / 10000`, làm tròn **xuống** (lợi cho bên bán, chênh tối đa 1 đơn vị nhỏ nhất của USDC).
- Khi chốt: bên bán nhận `passedAmount − sellerFee`; người mua nhận `cap − passedAmount − sessionFee`; AgentPay nhận `sessionFee + sellerFee`. Tổng đúng bằng `cap` (test bất biến này với số rất nhỏ, V-RE).
- `refund`, `closeEmpty`, `expireChallenge`, `proveEquivocation`: hoàn 100% `cap`, không thu phí.
- Phí tích lũy trong `feesAccrued`, admin rút về ví quỹ. Không dùng chung với `withdrawable` của người dùng.

### 5.2 Facilitator (off-chain, sửa `packages/x402-bridge` của PayCrow)

- Phải tự chạy (D3): facilitator công khai trên Avalanche (Ultravioleta, PayAI, thirdweb) chỉ hỗ trợ scheme `exact`, Coinbase CDP không hỗ trợ Avalanche, x402-rs chỉ có `exact` (Q6).
- Endpoint chuẩn x402 v2: `/verify`, `/settle`, `/supported` (khai `agentpay-session` trên `eip155:43113`).
- `/settle` khi mở phiên: gọi `Escrow.openWithAuthorization`, trả về `sessionId`. Facilitator trả gas.
- Mở phiên phải xảy ra **trước** request đầu tiên (x402 thường thì làm việc xong mới settle).
- Voucher của từng request **không đi qua facilitator**: Seller SDK và Verifier tự kiểm.
- EIP-712 domain của USDC: `{name: "USD Coin", version: "2"}` (không phải "USDC", Q1). Fuji USDC `0x5425890298aed601595a70AB815c96711a31Bc65` phải khai báo tay vì SDK x402 không có sẵn cho Fuji.
- Mức tin cậy: **không lấy được tiền** (nonce đã ràng buộc tham số, và `receiveWithAuthorization` bắt người gọi phải là Escrow), nhưng có thể **từ chối hoặc trì hoãn** mở phiên (V9).

### 5.3 Verifier (off-chain)

- **Relay** (D18): `POST /v1/sessions/{sessionId}/requests` nhận request + Voucher của người mua, chuyển cho bên bán, nhận body + Delivery, kiểm định, trả về body + Receipt cho người mua và Receipt cho bên bán. Vì đứng giữa nên Verifier luôn có Voucher mới nhất và thấy mọi bản Delivery.
- **Mỗi request:** kiểm Voucher (đúng `voucherSigner` của phiên, `seq`, cộng dồn ≤ `cap − sessionFee`), kiểm chữ ký Delivery, kiểm `deliveryDeadlineSec` (tính từ lúc nhận Voucher, D17), chạy các kiểm tra trong Spec, ký Receipt.
- Bên bán không giao trong hạn → Receipt **FAIL, mã `LATE`, `bodyHash = 0`**, request đó không tính tiền.
- **Đóng phiên:** 3 FAIL liên tiếp, người mua báo dừng, hết `cap` hoặc hết `expiry` → ký SessionVerdict, gọi `closeSession` (Verifier trả gas).
- **Bắt buộc đóng mọi phiên trước `expiry + VERDICT_GRACE`** (10 phút, D10). Theo dõi mọi sự kiện `SessionOpened`, cảnh báo khi sắp trễ hạn.
- **Checkpoint:** ký SessionVerdict tạm mỗi 20 request (D11) và gửi cho bên bán, để bên bán tự đóng phiên được nếu Verifier sập (S5).
- **Ghi lại mọi bản Delivery.** Hai bản hợp lệ cho cùng `(sessionId, seq)` mà khác `bodyHash` → tự gọi `proveEquivocation`.
- **Đóng phiên theo yêu cầu người mua:** `POST /v1/sessions/{sessionId}/close`, người mua ký EIP-712 `CloseRequest(sessionId, deadline)`. Verifier gọi `closeSession` (có request) hoặc `closeEmpty` (chưa có request, V9) trong vòng 1 phút.
- Lưu body tới khi phiên kết thúc + **7 ngày** (D19) để phục vụ khiếu nại, sau đó xóa (V23). Body mã hóa AES-256-GCM khi lưu, khóa nằm ngoài cơ sở dữ liệu (biến môi trường ở MVP). Job xóa chạy mỗi ngày. Không ghi body vào log. Body tối đa 1 MB (D20).
- **Oracle** (V7): Chainlink AVAX/USD **mainnet** `0x0A77230d17318075983913bC2145DB16C7366156` (D22), đọc qua 2 RPC mainnet (chính + dự phòng). `updatedAt` cũ hơn `maxOracleAgeSec` (mặc định 1 giờ, Spec §5; chỉnh lại sau Q5b) hoặc cả hai RPC lỗi → Receipt **INCONCLUSIVE** (mã 20), không phải FAIL, nên bên bán không bị trừ điểm oan. Ghi `roundId`, `answer`, `updatedAt` vào `evidenceHash` của Receipt.
- **Giới hạn tài nguyên** (V24):

  | Giới hạn | Giá trị MVP |
  |---|---|
  | Body | ≤ `maxBytes` của Spec, tối đa 1 MB; đọc theo luồng, cắt khi vượt |
  | Schema | ≤ 8 KB, không `$ref` ra ngoài, độ sâu lồng ≤ 32 |
  | `pattern` | Chỉ chạy bằng RE2 (không có backtracking, nên không bị ReDoS) |
  | Thời gian | ≤ 500 ms mỗi kiểm tra, ≤ 2 giây cho mọi kiểm tra của một request; quá → INCONCLUSIVE mã 21 |
  | Tốc độ | ≤ 10 request/giây mỗi phiên; ≤ 20 phiên OPEN mỗi người mua |
  | Spec lúc mở phiên | Từ chối Spec không có đủ kiểm tra tối thiểu theo `serviceType` (Spec §7.2, V5) |
- Khóa ký: MVP lưu trong biến môi trường hoặc file; đúng ra nên dùng KMS. Ghi log mọi chữ ký để phát hiện chữ ký lạ.
- **Cảnh báo bất thường:** tỉ lệ PASS của một bên bán tăng vọt, bên bán mới nhận tiền dồn dập, có `closeSession` mà Verifier không gửi → báo nhóm để `revokeVerifier`.

### 5.4 Uy tín: ERC-8004 + Scorer

**On-chain: dùng ERC-8004 v2.0.0 có sẵn** (Q4, đã kiểm on-chain), không tự triển khai:

| Registry | Fuji (43113) | Avalanche mainnet (43114) |
|---|---|---|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

- Escrow gọi `giveFeedback(agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`. **Không cần `feedbackAuth`** của bên bán; client được ghi là địa chỉ Escrow.
- **Một feedback mỗi phiên** (D23): `value` = tỉ lệ PASS 0–100 (`valueDecimals = 0`), `tag1 = "agentpay"`, `tag2 = "session"`, `feedbackHash = keccak256(sessionId, receiptsRoot)`.
- FAIL ≥ 50% số request → thêm feedback thứ hai `value = -50`, `tag2 = "fail-heavy"` (D24, F5). Equivocation → `value = -100`, `tag2 = "equivocation"`.
- Phiên `refund` hoặc không có request → **không ghi feedback**. Request INCONCLUSIVE không tính vào tỉ lệ.
- Đọc điểm: `getSummary(agentId, [địa chỉ Escrow], "agentpay", "")`. Registry bắt buộc truyền danh sách client, nên chỉ đếm feedback do Escrow ghi, không bị feedback giả từ ví khác làm nhiễu.

**Off-chain, Scorer:**
- `score = (k·tham_khảo + n·thật) / (k + n)`, trần điểm tham khảo 40, k = 5–10 (`AgentPay_ThietKe.md` A2); Scorer dùng **k = 5** (2026-11-19, trước là 8), `n` = số người mua khác nhau. Bên bán không có dữ liệu ngoài cần ~3 người mua tốt để đạt `minScore` 30. Điểm thật trọng số theo `log(passedAmount)`, có trần cho mỗi người mua (D23).
- Nguồn tham khảo MVP: lịch sử nhận USDC của `payTo` trên mainnet (qua **Routescan**, không cần key; Glacier dự phòng; Etherscan V2 không có Avalanche ở gói miễn phí, Q8); kết quả Probe; danh sách OFAC và ví lừa đảo.
- **Ký score attestation** (`ScoreAttestation`, §4.2) hạn tối đa 1 giờ. Escrow **luôn** xác minh khi mở phiên (ràng buộc `agentId` ↔ ví, §5.1.2), kiểm thêm điểm nếu `minScore > 0`. Chỉ ký `wallet` khi trùng ví nhận tiền trong file đăng ký ERC-8004; gắn cờ bit 1 nếu ví nằm trong danh sách OFAC/lừa đảo.
- **Chống thổi điểm trong MVP** (V13):
  - Điểm thật là **trung bình theo người mua**: trước tiên lấy trung bình các phiên của từng người mua, rồi mới lấy trung bình giữa các người mua. 50 phiên của cùng một ví chỉ tính như 1 phiếu.
  - Chỉ tính phiên có `passedAmount ≥ $0,10` (phiên quá nhỏ không đáng tin).
  - Mỗi người mua có trọng số tối đa bằng nhau (trần mỗi người mua, D23); trọng số trong trần theo `log(passedAmount)`.
  - Bỏ người mua chính là ví `seller` hoặc ví đã chứng minh sở hữu của bên bán.
  - Dashboard hiện số **người mua khác nhau** bên cạnh điểm.
  - Sau MVP: loại ví được bên bán nạp tiền, trọng số theo tuổi ví và uy tín người mua.
- **Probe:** gọi thử endpoint của bên bán theo chu kỳ, kiểm 402 và Spec có hợp lệ không; thỉnh thoảng mua thử.
- `minScore` mặc định = **30** (D25, đổi 2026-11-19), **thấp hơn** trần điểm tham khảo (40): bên bán uy tín ở nền tảng khác (lịch sử nhận USDC mainnet đã chứng minh sở hữu + Probe) mở được phiên đầu tiên mà không cần dữ liệu AgentPay (chống cold start, `AgentPay_ThietKe.md` A). Bên bán không có dữ liệu ngoài (điểm 0) hoặc chỉ có Probe (5) vẫn bị chặn. Cờ `REFERENCE_ONLY` chưa được contract dùng; làn "phiên nhỏ cho bên bán chỉ có điểm tham khảo" (A3) để sau MVP.

### 5.5 Seller SDK (middleware cho bên bán)

- Tạo phản hồi 402 scheme `agentpay-session` có `extensions.agentpay` (thông số phiên + Spec, Spec §2).
- Mở phiên: chuyển chữ ký EIP-3009 cho facilitator `/settle`. Đọc thông số phiên một lần rồi lưu lại.
- **Mỗi request: kiểm Voucher** trước khi làm việc: đúng chữ ký `voucherSigner` của phiên (đọc từ sự kiện `SessionOpened`), `seq` tăng đúng 1, `cumulativeAmount = seq × giá` và ≤ `cap − sessionFee`, phiên chưa hết hạn. Không đạt → từ chối. **Đây là phần thêm việc nhiều nhất** so với PayCrow.
- Trả body kèm chữ ký Delivery.
- Lưu Voucher mới nhất, Receipt và checkpoint SessionVerdict; tự gọi `closeSession` được nếu Verifier không đóng.

### 5.6 Buyer SDK / MCP server

- Đọc 402; dùng phiên đang mở với bên bán đó nếu còn, không thì mở phiên mới (chọn `cap`, `expiry`). Chỉ ký EIP-3009 ngay trước khi cần, với `validBefore = now + 2 phút`. Mở phiên thất bại hoặc người dùng hủy → gọi `cancelAuthorization` để chữ ký đó không dùng được nữa (V9).
- **Kiểm Spec trước khi trả** (Spec §7.2): phiên bản, loại kiểm tra, Verifier, Escrow, ERC-8004 khớp `payTo` và tên miền, Spec tối thiểu.
- **Chỉ mở phiên với Verifier ACTIVE trong VerifierRegistry.** Từ chối 402 ghi Verifier lạ, kể cả khi contract cũng sẽ chặn (V1).
- Mỗi request: ký Voucher (`seq` tăng 1, `cumulativeAmount = seq × giá ≤ cap − sessionFee`), gửi qua Verifier. Nhận body + Receipt: kiểm chữ ký Delivery và Receipt, kiểm `bodyHash` khớp body nhận được, lưu làm bằng chứng. Không nhận Receipt trong `deliveryDeadlineSec` + 5 giây → ngừng ký Voucher mới và yêu cầu đóng phiên.
- **Tự kiểm lại:** chạy lại các kiểm tra của Spec trên body nhận được. Mình thấy FAIL mà Receipt ghi PASS → dừng phiên, lưu bằng chứng, khiếu nại trong khoảng chờ (V1).
- Theo dõi SessionVerdict trên chain, đối chiếu với các Receipt đã lưu.
- Đóng phiên khi xong việc (báo cho Verifier), không để tiền bị khóa tới hết `expiry`.
- **Chế độ** cấu hình bằng `mode: "auto" | "approve"` (§3.3):
  - `auto`: giữ khóa ví agent **bên trong** tiến trình MCP server; `voucherSigner` = ví agent; chỉ cung cấp tool của AgentPay cho agent (§3.5).
  - `approve`: không giữ khóa ví nào. Mỗi phiên: tạo khóa tạm ngẫu nhiên **trong bộ nhớ** (không ghi ra đĩa, không đưa cho agent), mở trang duyệt `localhost`, nhận chữ ký EIP-3009 từ MetaMask (EIP-1193 hoặc WalletConnect), rồi ký Voucher bằng khóa tạm. Hết phiên thì xóa khóa tạm. Người dùng từ chối hoặc 5 phút không duyệt → báo lỗi cho agent, không mở phiên.
  - Trang duyệt hiện tham số đã giải mã từ `nonce` (bên bán, `agentId`, điểm, tên miền, giá, `cap`, `expiry`, Verifier, tóm tắt Spec) và tự tính lại `nonce` để đối chiếu với thứ MetaMask sắp ký (V-BLIND).
- Cung cấp MCP tools cho Claude và AgentKit (giữ ưu điểm của PayCrow).

### 5.7 Keeper bot

- Theo dõi sự kiện, gọi `finalize(sessionId)` khi hết khoảng chờ, `refund(sessionId)` khi quá `expiry + VERDICT_GRACE`.
- Ai cũng gọi được, nên nếu Keeper chết thì bên bán (muốn nhận tiền) hoặc người mua (muốn hoàn tiền) vẫn tự gọi được (V25).

### 5.8 Dashboard

- Chủ agent (đăng nhập bằng ví admin): đặt và siết luật người mua, đề xuất nới luật, xem chi tiêu, **nút dừng** (`pause` luật người mua), cảnh báo.
- **Cảnh báo bắt buộc trong MVP:** có `LoosenProposed` hoặc `setAdmin` đang chờ (kèm nút `cancelLoosen`, V-ADM); chi tiêu trong 1 giờ vượt 50% `dailyCap`; phiên mở với bên bán chưa từng dùng (V16).
- Màn demo: dòng thời gian của phiên, bộ đếm PASS/FAIL theo từng request, số dư hai bên, điểm uy tín thay đổi theo thời gian thực.

---

## 6. Luồng hoạt động

### 6.1 Đăng ký bên bán

```
1. Seller đăng ký ERC-8004 Identity (registry có sẵn trên Fuji) → agentId
   file đăng ký ghi: ví nhận tiền, danh sách endpoint (tên miền)
2. Ký thông điệp chứng minh sở hữu ví mainnet (để Scorer tính điểm tham khảo)
3. Cài Seller SDK, khai giá mỗi request + Spec cho từng endpoint
4. Probe chạy lần đầu → Scorer có điểm tham khảo (≤ 40)
```
Không cần cấp quyền feedback cho Escrow: ERC-8004 v2.0.0 đã bỏ `feedbackAuth` (Q4).

### 6.2 Chuẩn bị ví người mua

```
Chế độ Tự động:
1. Tạo một EOA mới cho agent; khóa đặt trong MCP server của AgentPay
2. Script cài đặt (không phải agent) dùng khóa đó gọi registerBuyer(admin, policy)   ← bắt buộc
   (không đăng ký thì contract chỉ chặn cap > $20, không có minScore / dailyCap)
3. Chủ chuyển ít USDC từ ví chính sang ví agent (§3.5); agent chỉ được cấp tool AgentPay

Chế độ Duyệt:
1. Cài Buyer SDK / MCP server với mode = "approve"; không cần tạo ví mới
2. (Khuyến nghị) kết nối MetaMask ở dashboard, gọi registerBuyer(admin, policy) cho ví chính
3. USDC vẫn nằm trong ví chính; không chuyển đi đâu
```

### 6.3 Mở phiên

```
Buyer               Seller+SDK          Facilitator          Escrow (chain)
  │── GET /price ──────►│                    │                     │
  │◄── 402 agentpay-session + spec ──│       │                     │
  │ kiểm spec + Verifier ACTIVE + điểm bên bán; chọn cap ($1), expiry (1 giờ)
  │ Tự động: ví agent ký luôn │ Duyệt: trang duyệt → người bấm → MetaMask ký
  │ receiveWithAuthorization(to = Escrow, value = cap, nonce = hash(params + voucherSigner, salt))
  │── PAYMENT-SIGNATURE ►│── /settle ───────►│── openWithAuthorization ►│ kiểm luật người mua,
  │                      │                    │                     │ kéo USDC → OPEN
  │◄──────────── sessionId ───────────────────│                     │
```

### 6.4 Request trong phiên, kết quả PASS

```
Buyer                    Verifier (relay)              Seller
  │── request #n + Voucher(seq n, cum n×$0,01) ──►│               │
  │                         │── chuyển tiếp ──────────────────►│ kiểm Voucher
  │                         │◄── body + Delivery ──────────────│
  │                         │ kiểm Delivery, hạn giao, chạy Spec → PASS
  │◄── body + Receipt(PASS) │── Receipt ──────────────────────►│
  │ tự chạy lại Spec: khớp → tiếp tục
```
Không có giao dịch on-chain nào. Lặp lại cho mỗi request.

### 6.5 FAIL và tự đóng phiên (màn demo chính)

```
Seller trả giá lệch 20% → Verifier: oracle-deviation lỗi (mã 14) → Receipt FAIL, request không tính tiền
→ 3 FAIL liên tiếp → Verifier ký SessionVerdict (15 PASS, 3 FAIL, passedAmount $0,15)
→ closeSession → CLOSING → hết khoảng chờ (demo: 30 giây) → Keeper finalize → SETTLED
→ bên bán nhận $0,15 − 0,5%; người mua nhận $0,85 − sessionFee; 1 feedback ERC-8004 (83% PASS)
```

### 6.6 Bên bán không giao, hoặc không ai đóng phiên

```
Trường hợp 1: bên bán không giao một request (Verifier vẫn hoạt động)
→ hết deliveryDeadlineSec → Receipt FAIL (mã LATE, bodyHash = 0), request không tính tiền
→ phiên tiếp tục, hoặc tự đóng nếu đủ 3 FAIL liên tiếp

Trường hợp 2: không ai đóng phiên (Verifier sập và bên bán không có checkpoint)
OPEN → quá expiry + VERDICT_GRACE → closeSession bị khóa → chỉ còn refund()
     → bất kỳ ai gọi refund() → REFUNDED: hoàn 100% cap, uy tín không đổi
```
Bên bán được bảo vệ khỏi trường hợp 2 bằng checkpoint mỗi 20 request (D11): có checkpoint thì bên bán tự gọi `closeSession` được trong khoảng **[`expiry`, `expiry + VERDICT_GRACE`]**. Bên bán không được đóng sớm hơn `expiry`, để không cắt ngang phiên đang chạy bằng một checkpoint cũ (S10). Seller SDK đặt lịch tự nộp checkpoint mới nhất ngay sau `expiry` nếu phiên vẫn OPEN.

### 6.7 INCONCLUSIVE

```
Oracle lỗi → Verifier thử lại trong deliveryDeadlineSec → Receipt INCONCLUSIVE
→ request không tính tiền, không tính vào tỉ lệ PASS/FAIL của bên bán
```

### 6.8 Khiếu nại

```
CLOSING → người mua hoặc bên bán: challenge(reasonCode, bondAuth) → CHALLENGED, hạn xử lý 24 giờ
→ Arbiter (MVP: nhóm, D4) kiểm định lại bằng body + Receipt đã lưu,
  dùng đúng receivedAt và dữ liệu oracle trong evidenceHash (V-TIME)
→ resolveChallenge(passCount, failCount đúng, upheld) → SETTLED:
     khiếu nại đúng: sửa passedAmount, trả cọc cho bên khiếu nại
     khiếu nại sai : giữ kết quả, cọc → bên còn lại
→ quá 24 giờ mà Arbiter chưa xử lý → bất kỳ ai gọi expireChallenge()
     → REFUNDED: hoàn người mua 100% cap, trả cọc cho bên khiếu nại, không đổi uy tín (Q12)
```
Mã lý do khiếu nại (MVP): `1` Receipt FAIL nhưng Verdict tính PASS; `2` Verdict thiếu request đã có Receipt PASS (bên bán khiếu nại); `3` tự kiểm lại của người mua khác Receipt; `9` khác.
Bằng chứng mạnh nhất của người mua: Receipt có chữ ký Verifier ghi FAIL, trong khi SessionVerdict tính request đó là PASS (S1).

### 6.9 Bên bán gửi hai bản khác nhau (equivocation)

```
Verifier hoặc người mua có 2 chữ ký Delivery của bên bán cho cùng (sessionId, seq), khác bodyHash
→ proveEquivocation() → REFUNDED ngay (hoàn toàn bộ cap), feedback −100, không cần Arbiter
```

### 6.10 Lộ khóa của agent

```
Chế độ Duyệt: kẻ gian chỉ có khóa tạm của phiên đang mở
  → ký thêm Voucher, nhưng chỉ trả cho đúng bên bán của phiên, chỉ request PASS mới mất tiền
  → mất tối đa cap − sessionFee của phiên đó; không mở được phiên mới (cần MetaMask duyệt);
    không đụng được ví chính

Chế độ Tự động:
Admin thấy cảnh báo → pauseBuyer() luật người mua (qua dashboard) → không mở được phiên mới qua AgentPay
Thiệt hại qua AgentPay tối đa = tiền trong các phiên đang mở
                                (chỉ trả cho đúng bên bán của phiên, chỉ request PASS)
                              + phần hạn mức ngày còn lại tới lúc pause
```
Chế độ Tự động không chặn được kẻ gian `transfer` USDC thẳng khỏi ví agent (§3.4). Thiệt hại phần này giới hạn bởi số dư trong ví (§3.5, khuyến nghị 3).

### 6.11 Cập nhật điểm uy tín

```
Sự kiện Settled / EquivocationProven → Escrow ghi ERC-8004 (client = Escrow)
→ Scorer đọc getSummary(agentId, [Escrow]) + sự kiện, tính lại → attestation mới
Probe chạy định kỳ → cập nhật phần tham khảo
```

---

## 7. Máy trạng thái của phiên

```
              openWithAuthorization()
   NONE ─────────────────► OPEN ──── (request off-chain: Voucher + Receipt, không đổi trạng thái)
                             │
        closeSession()       │       quá expiry + grace, chưa đóng (refund)
     ┌───────────────────────┼──────────────────────────────┐
     ▼                       │ proveEquivocation()          ▼
  CLOSING ───────────────────┼─────────────────────────► REFUNDED
   │     │                   │                              ▲
   │     │ challenge()       └──────────────────────────────┤
   │     ▼                                                  │
   │  CHALLENGED ── resolveChallenge() ──► SETTLED          │
   │     └──────── expireChallenge() ─────────┼────────────►│
   │                                          ▲             │
   └── finalize() ────────────────────────────┘             │
       (closeEmpty: phiên không có request) ────────────────┘
```

| Từ | Sang | Hàm | Điều kiện |
|---|---|---|---|
| NONE | OPEN | `openWithAuthorization` | Đủ 9 bước kiểm ở §5.1.1 (nonce, hạn chữ ký, Verifier, trần tiền đang chờ, giới hạn `cap`, ràng buộc bên bán, luật người mua) |
| OPEN | CLOSING | `closeSession` | Chữ ký Voucher + SessionVerdict hợp lệ; `specHash`, `lastSeq` khớp; `passedAmount ≤ cumulativeAmount ≤ cap − sessionFee`; Verifier chưa bị thu hồi; người gọi là Verifier, hoặc `now ≥ expiry`; `now ≤ expiry + VERDICT_GRACE`. `challengeWindow = 0` thì sang thẳng SETTLED |
| OPEN | REFUNDED | `closeEmpty` | Verdict có `lastSeq = 0` |
| OPEN | REFUNDED | `refund` | `now > expiry + VERDICT_GRACE`; uy tín không đổi |
| OPEN / CLOSING | REFUNDED | `proveEquivocation` | Hai Delivery hợp lệ cho cùng `(sessionId, seq)`, khác `bodyHash` |
| CLOSING | CHALLENGED | `challenge` | `now ≤ challengeEnd`; người gọi là người mua hoặc bên bán; đủ tiền cọc |
| CLOSING | SETTLED | `finalize` | `now > challengeEnd` |
| CHALLENGED | SETTLED | `resolveChallenge` | Chỉ Arbiter, `now ≤ resolveDeadline` |
| CHALLENGED | REFUNDED | `expireChallenge` | `now > resolveDeadline` |

**Đóng phiên muộn:** sau mốc `expiry + VERDICT_GRACE`, trạng thái vẫn là OPEN cho tới khi có người gọi `refund()`, vì contract không tự đổi trạng thái khi hết giờ. Nếu `closeSession` không kiểm thời gian, trong khoảng này sẽ có hai giao dịch cùng hợp lệ (`refund` và `closeSession`), giao dịch nào vào block trước thì thắng, nên kết quả phụ thuộc thứ tự giao dịch và có thể bị chen ngang (front-running). → `closeSession` revert `VerdictTooLate` sau mốc này. Từ đó chỉ còn `refund()`, gọi lúc nào cũng cho cùng một kết quả.

---

## 8. Mô hình dữ liệu

### 8.1 On-chain

```solidity
struct Session {
    address buyer;              // EOA trả tiền (ví agent hoặc ví chính)
    address voucherSigner;      // khóa được ký Voucher của phiên (chốt lúc mở)
    address seller;
    uint256 sellerAgentId;
    address verifier;           // chốt theo từng phiên
    bytes32 specHash;
    uint128 cap;
    uint128 pricePerRequest;
    uint64  openedAt;
    uint64  expiry;
    uint32  deliveryDeadlineSec;
    uint32  challengeWindowSec;
    uint64  challengeEnd;
    uint128 sessionFee;         // chốt lúc mở (§5.1.5)
    uint16  feeBps;             // chốt lúc mở
    uint128 cumulativeAmount;   // từ Voucher nộp khi đóng
    uint128 passedAmount;       // từ SessionVerdict
    uint32  passCount; uint32 failCount; uint32 inconclusiveCount;
    bytes32 receiptsRoot;
    State   state;              // NONE, OPEN, CLOSING, CHALLENGED, SETTLED, REFUNDED
    address challenger;
    uint128 challengeBond;
    uint64  resolveDeadline;    // challenge + RESOLVE_TIMEOUT
}
mapping(address => VerifierInfo) public verifiers;       // active, maxInFlight
mapping(address => uint256) public inFlightByVerifier;
mapping(address => uint256) public withdrawable;          // chỉ dùng khi chuyển thẳng bị lỗi
uint256 public feesAccrued;
address public scorerSigner;  address public arbiter;  address public guardian;
uint128 public sessionFee;    uint16  public feeBps;   bool    public paused;
// + BuyerPolicy / Bucket / PendingLoosen / sellerAllowed (§5.1.2)
```
Tối ưu sau: chỉ lưu mã băm của phần tham số không đổi, giảm khoảng 80–90k gas khi mở phiên (§9.4).

### 8.2 Off-chain

| Bảng | Trường chính | Thuộc |
|---|---|---|
| `sessions` | sessionId, buyer, voucherSigner, seller, cap, expiry, trạng thái, Voucher mới nhất | Verifier |
| `requests` | sessionId, seq, requestHash, voucherSig, bodyHash, body (mã hóa), deliverySig, receivedAt | Verifier |
| `receipts` | sessionId, seq, outcome, reasonCode, amount, receivedAt, evidenceHash, oracle (feed, roundId, answer, updatedAt), sig | Verifier (gửi cho cả hai bên) |
| `session_verdicts` | sessionId, bản tạm/bản cuối, passedAmount, receiptsRoot, sig, txHash | Verifier |
| `sellers` | agentId, payTo, domains, mainnetWallets (đã chứng minh), lastProbe | Scorer |
| `score_inputs` | agentId, source, value, observedAt | Scorer |
| `attestations` | agentId, score, flags, validUntil, sig | Scorer |
| `buyer_events` | buyer, cap, sessionId, policy change, at | Dashboard |

---

## 9. Kinh tế: phí, gas, tiền cọc

### 9.1 Mô hình phí (D13–D14)

Phí % không đủ bù gas khi phiên có tổng giá trị nhỏ (§9.3), nên dùng hai phần:
- **Phí bảo vệ cố định mỗi phiên** `sessionFee` $0,03–0,05, **người mua trả**, trừ vào phần hoàn lại. Đây là "phí bảo hiểm": không đạt thì không mất tiền mua. Con số cụ thể chốt sau khi đo gas phiên.
- **0,5% trên `passedAmount`**, trừ vào phần của bên bán (như PayCrow).
- Phiên `refund` thì hoàn 100%, không thu phí.

Ví dụ: phiên $5 gồm 500 request × $0,01, tất cả PASS: người mua trả $5 + $0,04; bên bán nhận $4,975; AgentPay thu $0,065, gas khoảng $0,035 → **có lời**. Phiên rất nhỏ (tổng < ~$0,50) thì phí cố định chiếm tỉ lệ lớn, nên SDK gợi ý trả bằng `exact` (D2).

### 9.2 Ai trả gas (D15)

| Giao dịch | Người trả | Bù lại bằng |
|---|---|---|
| `registerBuyer` | Người mua (một lần) | — |
| `openWithAuthorization` | Facilitator | `sessionFee` + 0,5% |
| `closeSession` | Verifier | `sessionFee` + 0,5% |
| `finalize` / `refund` | Keeper | `sessionFee` + 0,5% |
| `withdraw` | Người nhận | — (chỉ khi chuyển thẳng bị lỗi) |
| Request trong phiên | Không ai | Off-chain, không tốn gas |

### 9.3 Gas của một phiên (**đã đo** 2026-11-18)

Đo bằng `gasUsed` của giao dịch thật trên **Fuji** (USDC Circle, ERC-8004 thật), phiên có khoảng chờ khiếu nại (3 giao dịch). "Phiên đầu" có thêm chi phí ghi lần đầu (Escrow lần đầu nhận USDC, ERC-8004 lần đầu thấy client, `feesAccrued` lần đầu khác 0); "phiên bình thường" là phiên thứ 2 trở đi.

| Giao dịch | Bản đầu (phiên đầu) | **Sau tối ưu (phiên bình thường)** |
|---|---|---|
| `openWithAuthorization` | 407k | **302k** |
| `closeSession` | 143k | **111k** |
| `finalize` | 330k | **204k** |
| **Cả phiên** | 880k (phiên bình thường ~780k) | **617k** |

**Gas bị tính trên Fuji (đo 2026-11-19):** Fuji tính tối thiểu **một nửa gas limit** của giao dịch. Verifier và Keeper từng đặt limit cố định 1M (estimateGas bỏ sót feedback ERC-8004 nằm trong try/catch), nên đóng và chốt mỗi giao dịch bị tính 500k, cả phiên 1,30M. Đã hạ limit: `closeSession`/`closeEmpty` 300k, `proveEquivocation` 500k, `finalize` 400k → cả phiên **656k** (mở 302k, đóng 150k, chốt 204k), feedback vẫn được ghi.

**Gas đi đâu** (đo bằng trace trên fork, bản đầu): phần lớn nhất là **Escrow tự lưu dữ liệu phiên** (~36% lúc mở + ~24% lúc đóng/chốt, mỗi ô storage mới tốn 22,1k), sau đó là feedback ERC-8004 (~106k, 14%), USDC (~96k, 12%), phí cơ bản + calldata (~12%), kiểm chữ ký + đọc Identity + luật người mua (~3%).

**Đã tối ưu** (không đổi interface): xếp gọn storage của phiên từ 10 ô xuống 6 ô lúc mở (`sellerAgentId` lưu 96 bit cùng ô với `seller`, id lớn hơn bị từ chối), không lưu `cumulativeAmount` / `passedAmount` (tính lại từ `lastSeq` / `passCount` × giá, F2). Đã cân nhắc nhưng **không làm**: xóa storage khi kết thúc để được hoàn gas (lợi ~15k nhưng mất dữ liệu trên chain).

**Đã cân nhắc và giữ nguyên (2026-11-18):** bỏ feedback ERC-8004 cho phiên có PASS < $0,10 sẽ tiết kiệm ~106k với phiên nhỏ, nhưng nhóm quyết định **giữ feedback cho mọi phiên** (D23 không đổi) để mọi phiên có tiền thật đều để lại dấu vết uy tín on-chain.

Quy ra tiền ở giá gas mainnet 7,5 gwei (đã đọc on-chain 2026-11-18): 617k × 7,5 gwei = **0,0046 AVAX/phiên** ≈ $0,030 (AVAX $6,5) – $0,051 (AVAX $11). Với `sessionFee` $0,05 + 0,5% phí bên bán: phiên nhỏ hòa vốn ở AVAX $11, phiên lớn có lời.

Chia cho N request: 100 request → khoảng 6k gas/request; 1.000 request → khoảng 0,6k. So với mô hình cũ: 18 request ≈ 18 × 503k ≈ 9M gas, theo phiên ≈ 0,62M (**rẻ hơn ~14 lần**).

**Quy ra tiền:** base fee mainnet sàn 7,5 gwei (ACP-283), AVAX $6,5–11. Gas đo trên Fuji giống mainnet nhưng giá gas Fuji gần như bằng 0 (Q7), nên đo **số gas** trên Fuji hoặc fork rồi nhân với giá mainnet.

### 9.4 Cách tiết kiệm gas còn dùng được

| Cách | Tiết kiệm | Trạng thái |
|---|---|---|
| **Trả thẳng, lỗi thì mới chuyển sang rút** (push, fallback pull) | ~25–30k (bỏ giao dịch `withdraw`) | **Có trong MVP** |
| `ReentrancyGuardTransient` (EIP-1153) | ~2–5k mỗi hàm | **Có trong MVP** |
| Bỏ xác minh score attestation khi `minScore = 0`; rút gọn calldata | ~5–10k | Có trong MVP |
| Chỉ lưu mã băm tham số phiên (1 slot), các hàm sau gửi lại tham số qua calldata | ~80–90k ở bước mở | Sau MVP (dashboard phải đọc từ event) |
| Gộp `closeSession` / `finalize` nhiều phiên vào một giao dịch | ~21k + một phần mỗi phiên | Sau MVP |
| Số dư trả trước dùng cho nhiều bên bán, quyết toán định kỳ bằng Merkle root | Chi phí theo số lần quyết toán | Lộ trình (Phụ lục B) |

### 9.5 Tiền cọc khiếu nại

- `bond = max(10% × số tiền tranh chấp, $0,10)` (Q13, D34). Số tiền tranh chấp: người mua khiếu nại = `passedAmount`; bên bán khiếu nại = `cumulativeAmount − passedAmount`.
- Trả bằng EIP-3009 `receiveWithAuthorization` kèm theo `challenge` (một giao dịch, không cần `approve`).
- Đủ lớn để không ai khiếu nại bừa (V11), đủ nhỏ để người bị hại vẫn dám khiếu nại.
- Khiếu nại sai: cọc về bên còn lại. Khiếu nại đúng hoặc Arbiter quá hạn: trả lại cọc.
- MVP: Arbiter là nhóm, cọc chủ yếu mang tính minh họa (D4).

---

## 10. Mô hình tin cậy

| Thành phần | Nếu gian lận thì làm được gì | Không làm được gì |
|---|---|---|
| **Verifier (MVP: nhóm)** | Ký PASS cho bên bán xấu, hoặc FAIL bừa (hại bên bán), trong giới hạn Voucher người mua đã ký và trần tiền đang chờ | Đổi Spec, đổi người nhận tiền, lấy tiền ra ví riêng |
| **Arbiter (MVP: nhóm)** | Quyết sai các vụ khiếu nại | Can thiệp phiên không có khiếu nại |
| **Facilitator** | Từ chối hoặc trì hoãn mở phiên | Đổi tham số, lấy tiền |
| **Scorer** | Cho điểm sai → người mua mở phiên với bên bán xấu | Vượt hạn mức của người mua |
| **Admin contract** | Đổi phí, Verifier mặc định, arbiter (nên có timelock) | Đổi Verifier của phiên đã mở |
| **Bên bán** | Đặt Spec lỏng, giao dữ liệu "đúng định dạng nhưng vô dụng" | Nhận tiền cho request FAIL; nhận quá số người mua đã ký; chối dữ liệu đã ký |
| **Người mua** | Khiếu nại bừa (mất cọc); dùng dữ liệu dù FAIL | Đòi hoàn tiền khi PASS; giả dữ liệu xấu |
| **Agent của người mua** | Chế độ Tự động: bị lừa chuyển tiền thẳng nếu có tool `transfer` hoặc cầm khóa (§3.4). Chế độ Duyệt: chỉ ký thêm Voucher trong phiên đã được duyệt | Mở phiên vượt luật người mua; tự nới luật; ở chế độ Duyệt: mở phiên không có người duyệt, đụng tới ví chính |

**Nói thẳng khi thuyết trình:** MVP vẫn tin vào nhóm ở ba vai trò Verifier, Arbiter và Scorer. Điểm khác so với "trả tiền thẳng" là các vai trò này **bị giới hạn bởi contract**: có trần tiền, luật được chốt trước, có bằng chứng ký số. Ngoài ra đã có lộ trình phi tập trung hóa dần (Phụ lục B).

---

## 11. Lỗ hổng và rủi ro

Mức độ: 🔴 nghiêm trọng · 🟠 cao · 🟡 trung bình · ⚪ thấp. "MVP" = phải xử lý trước demo.

### 11.0 Danh sách xử lý trong MVP

> **Trạng thái 2026-11-17:** chưa có code. Mọi dòng dưới đây đã có **cơ chế cụ thể trong thiết kế**, và chỉ coi là xong khi test ở cột cuối chạy qua. Cột "Test" là kế hoạch test Foundry (contract) hoặc test tích hợp (off-chain).

**Contract (`AgentPaySessionEscrow`)**

| # | Thiết kế ở | Test chứng minh |
|---|---|---|
| V1 | §5.1.1 bước (4), §5.1.3 | Verifier lạ → `UnknownVerifier`; vượt `maxInFlight` → revert; `revokeVerifier` xong thì `closeSession` của khóa cũ revert, phiên `refund` đủ `cap` |
| V3 | §5.1.1 `proveEquivocation` | Hai Delivery khác `bodyHash` cùng `(sessionId, seq)` → REFUNDED, người mua nhận đủ `cap`, feedback −100; hai Delivery giống nhau → revert |
| V9 | §5.1.1 bước (3), `closeEmpty` | `validBefore > now + 10 phút` → revert; `closeEmpty` hoàn đủ, không thu phí |
| V15 | §5.1.2 ràng buộc bên bán | `att.wallet ≠ seller` hoặc `att.agentId ≠ sellerAgentId` → revert; attestation hết hạn / quá 1 giờ / sai chữ ký / bị gắn cờ → revert |
| V16, V-PROMPT | §5.1.2 | Vượt `maxPerSession` → `OverPerSession`; vượt bucket → `OverDailyCap`; điểm thấp → `BadScore`; đang `pause` → `BuyerPaused` |
| V18 | §5.1.2 token bucket | Tiêu hết hạn mức lúc 23:59, thử lại 00:01 → revert; sau 12 giờ hồi đúng một nửa |
| V19 | §5.1.1 `finalize`, `withdraw(to)` | Mock USDC chặn ví bên bán → `finalize` không revert, tiền vào `withdrawable`; `withdraw(to)` về ví khác thành công |
| V21, S3 | §4.2 | Voucher / Verdict của phiên khác, chain khác, contract khác → revert |
| V-TEMP | §4.3, §5.1.1 | Voucher ký bằng khóa khác `voucherSigner` (kể cả khóa ví trả tiền khi đang dùng khóa tạm) → revert; đổi `voucherSigner` trong tham số → `nonce` không khớp → revert; `voucherSigner = 0` → revert |
| V26 | §5.1.4, §5.1.5 | Đặt phí vượt `MAX_SESSION_FEE` / `MAX_FEE_BPS` → revert; đổi phí không ảnh hưởng phiên đang mở |
| V-ADM | §5.1.2 hàm quản lý | Nới luật / `unpause` / thêm bên bán / `setAdmin` trước 24 giờ → revert; siết thì có hiệu lực ngay; `...BySig` dùng lại chữ ký → revert |
| V-ID, S2, S4 | §5.1.1 `closeSession` | `lastSeq ≠ voucher.seq` → revert; `cumulativeAmount > cap − sessionFee` → revert; `passedAmount > cumulativeAmount` → revert |
| V-RE | §5.1.1, §5.1.5 | Fuzz: tổng tiền ra luôn bằng `cap` với mọi `cap`, `passedAmount`, phí; reentrancy qua token giả → revert |
| S10 | §5.1.1 `closeSession` | Bên bán gọi trước `expiry` → `TooEarly`; sau `expiry` với checkpoint hợp lệ → thành công |
| S11 | §5.1.5 | Phiên dùng hết `cap − sessionFee`, tất cả PASS → người mua nhận đúng 0, AgentPay nhận đủ phí |
| S12 | §5.1.1 `expireChallenge` | Quá 24 giờ sau `challenge` → `expireChallenge` hoàn đủ `cap` + trả cọc; `resolveChallenge` sau hạn → revert |
| §7 | `VerdictTooLate` | `closeSession` sau `expiry + VERDICT_GRACE` → revert; chỉ còn `refund` |

**Off-chain (Verifier, SDK, Scorer)**

| # | Thiết kế ở | Test chứng minh |
|---|---|---|
| V1 (3) | §5.6 tự kiểm lại | Verifier giả ký PASS cho body sai → Buyer SDK dừng phiên, gọi `challenge` |
| V4 | §5.3 relay | Người mua chỉ nhận body qua Verifier; `bodyHash` của body nhận được khớp Receipt |
| V5 | §5.3, Spec §7.2 | 402 có Spec `price-feed` thiếu `oracle-deviation` → SDK và Verifier đều từ chối |
| V7 | §5.3 oracle | RPC chính chết → dùng RPC dự phòng; giá cũ hơn `maxOracleAgeSec` → INCONCLUSIVE, không phải FAIL |
| V13 | §5.4 chống thổi điểm | 50 phiên của 1 ví → điểm chỉ tính 1 phiếu; phiên < $0,10 không tính |
| V23 | §5.3 lưu trữ | Body trong DB là bản mã hóa; quá 7 ngày bị xóa; log không chứa body |
| V24 | §5.3 giới hạn tài nguyên | Body 2 MB → cắt, FAIL `TOO_LARGE`; regex gây ReDoS chạy RE2 không treo; kiểm tra quá 500 ms → INCONCLUSIVE |
| V-TIME | §4.2 Receipt | Kiểm định lại một request cũ bằng `receivedAt` + `evidenceHash` → cùng kết quả |
| S5 | §5.5, §6.6 | Tắt Verifier giữa phiên → bên bán nộp checkpoint sau `expiry`, nhận đúng tiền các request PASS tới checkpoint |
| V-TOOL | §3.5 | README có mục cài đặt an toàn; MCP server không lộ khóa qua tool nào |
| V-TEMP | §5.6 chế độ `approve` | Khóa tạm không xuất hiện trên đĩa, trong log hay trong kết quả tool trả cho agent; hết phiên thì bị xóa khỏi bộ nhớ |
| V-BLIND | §3.3 trang duyệt | Trang duyệt tính lại `nonce` từ tham số hiện trên trang; tham số bị sửa → `nonce` khác → trang chặn, không gọi MetaMask |

**Không phải code:** V-HACK và V29 → ban tổ chức đã chấp nhận (D36). V5, V6, V-DIG, V8, V13 (phần còn lại), V16 (`transfer` thẳng), V23, V30, S9 và việc nhóm giữ vai Verifier / Arbiter / Scorer **vẫn còn rủi ro**, phải nói thẳng khi thuyết trình (§10).

### 11.1 Contract và tiền

| # | Lỗ hổng | Mức | Kịch bản | Cách giảm | Khi nào |
|---|---|---|---|---|---|
| V1 | **Lộ khóa Verifier** | 🔴 | Kẻ gian ký PASS cho mọi phiên có bên bán là đồng bọn; ký FAIL cho bên bán trung thực; hoặc không ký gì (mọi phiên hết hạn → hoàn tiền). **Không** lấy được tiền của phiên có bên bán khác, **không** giả được Voucher | (1) Giới hạn bởi Voucher (§4.3). (2) Chỉ chấp nhận Verifier đã duyệt (VerifierRegistry), vì nếu bên bán tự chọn Verifier thì tương đương đã có khóa. (3) Người mua tự kiểm lại và khiếu nại. (4) Trần tiền đang chờ; khoảng chờ khiếu nại; `pauseSystem()` + `revokeVerifier`. (5) Theo dõi bất thường. (6) Sau MVP: KMS/HSM, nhiều Verifier ký 2/3, Verifier đặt cọc | MVP: (1)–(4); sau: (5)(6) |
| V19 | **USDC blacklist** | 🟠 | Circle chặn ví bên bán → chuyển tiền bị revert → `finalize` kẹt | Push có fallback pull (`withdrawable`); `withdraw(to)` rút về địa chỉ khác | MVP |
| V26 | **Quyền admin** | 🟠 | Admin đổi arbiter hoặc phí bất ngờ | Verifier và phí chốt theo từng phiên; trần phí cứng `MAX_SESSION_FEE`, `MAX_FEE_BPS`; timelock cho thay đổi admin | MVP (chốt theo phiên, trần phí), sau (timelock) |
| V9 | **Facilitator giữ chữ ký rồi gửi muộn** | 🟡 | Phiên được mở khi người mua đã bỏ đi → khóa tiền vô ích tới hết `expiry` | SDK đặt `validBefore` = 2 phút, contract từ chối quá 10 phút; SDK gọi `cancelAuthorization` khi hủy; người mua yêu cầu Verifier `closeEmpty` | MVP |
| V21 | **Dùng lại Voucher, Receipt, SessionVerdict hoặc Delivery** | 🟡 | Dùng chữ ký của phiên này cho phiên khác, chain khác | EIP-712 domain có `chainId` + `verifyingContract`; mọi struct có `sessionId` (+ `seq`, `specHash`, `bodyHash`) | MVP |
| V-ID | **Dùng một Voucher cho nhiều request** | 🟡 | Người mua gửi lại cùng Voucher để lấy thêm dữ liệu | `seq` tăng đúng 1 và `cumulativeAmount = seq × giá`; Voucher gắn `requestHash` | MVP |
| V-RE | Reentrancy, làm tròn phí | ⚪ | — | `nonReentrant`, checks-effects-interactions; test làm tròn với số nhỏ | MVP |

### 11.2 Phiên

| # | Rủi ro | Xử lý |
|---|---|---|
| S1 | Verifier + bên bán thông đồng, khai mọi request đều PASS | Bị chặn trên bởi Voucher. Người mua có Receipt từng request: Receipt FAIL mà `receiptsRoot` ghi PASS → bằng chứng Verifier gian lận (sau MVP: `proveReceiptMismatch` với Merkle proof, Q28). Trần `maxInFlightPerVerifier` vẫn áp |
| S2 | Bên bán nộp Voucher cũ (số nhỏ hơn) | Không có lợi cho bên bán. Contract bắt `lastSeq == voucher.seq` |
| S3 | Phát lại Voucher sang phiên khác hoặc contract khác | Có `sessionId` + EIP-712 domain |
| S4 | Người mua ký Voucher vượt `cap` | Bên bán từ chối phục vụ. Contract revert nếu `cumulativeAmount > cap − sessionFee` |
| S5 | Verifier không đóng phiên → bên bán mất tiền các request đã PASS | Checkpoint mỗi 20 request (D11), bên bán tự nộp `closeSession`. Quá hạn mà không ai đóng mới hoàn người mua |
| S6 | Tiền bị khóa lâu | `expiry` tối đa 24 giờ; người mua đóng sớm được bất cứ lúc nào |
| S7 | Hạn mức ngày bị trừ hết `cap` dù chỉ dùng một phần | MVP: trừ `cap` lúc mở phiên, không cộng lại phần hoàn (D16). Có thể xem lại sau MVP |
| S9 | Verifier nằm trên đường đi của mọi request (độ trễ, điểm lỗi duy nhất) | Đánh đổi của thiết kế relay (D18); sau MVP cho nhiều Verifier |
| S10 | Bên bán dùng checkpoint cũ để đóng phiên sớm, cắt ngang phiên đang chạy | Bên bán chỉ được `closeSession` khi `now ≥ expiry`; trước đó chỉ Verifier đóng được |
| S11 | Mọi request PASS và dùng hết `cap` → không còn tiền để trừ `sessionFee` | Tiền dùng được = `cap − sessionFee`; Voucher vượt mức này không hợp lệ (§5.1.5) |
| S12 | Arbiter không xử lý → phiên kẹt mãi ở CHALLENGED | `expireChallenge` sau 24 giờ: hoàn người mua, trả cọc, không đổi uy tín |

### 11.3 Kiểm định

| # | Lỗ hổng | Mức | Kịch bản | Cách giảm | Khi nào |
|---|---|---|---|---|---|
| V3 | **Bên bán gửi hai bản khác nhau (equivocation)** | 🔴 | Gửi người mua dữ liệu rác, gửi Verifier dữ liệu tốt → PASS | Verifier làm relay nên người mua nhận **đúng bản** Verifier đã kiểm; người mua tự kiểm lại; hai Delivery khác `bodyHash` cho cùng `(sessionId, seq)` → `proveEquivocation` → hoàn tiền + phạt | MVP |
| V4 | **Bên bán nộp cho Verifier nhưng không giao cho người mua** | 🔴 | PASS nhưng người mua không có gì | Verifier làm relay (D18): người mua nhận body từ chính Verifier cùng với Receipt | MVP |
| V5 | **Spec quá lỏng** | 🟠 | Spec chỉ kiểm `type: object` → dữ liệu rác vẫn PASS | Spec tối thiểu theo `serviceType`; người mua fail-closed | MVP |
| V6 | **Đúng định dạng nhưng vô dụng** | 🟠 | `json-data` chỉ kiểm schema: giá trị bịa vẫn qua | Kiểm tra theo miền dữ liệu (oracle, range); chỉ ký quỹ dịch vụ kiểm được; nói rõ giới hạn | Nói khi thuyết trình |
| V7 | **Oracle Chainlink trên Fuji cập nhật thưa hoặc ngừng** | 🟠 | Hàng loạt INCONCLUSIVE, demo hỏng | Verifier đọc feed **mainnet** (D22); fallback sang nguồn thứ hai | MVP **[cần xác minh heartbeat]** |
| V8 | **Thời gian giao tính theo lúc Verifier nhận** | 🟡 | Verifier sập hoặc chậm → bên bán bị tính LATE oan | `commitDelivery` on-chain (tùy chọn); LATE do Verifier sập thì cho INCONCLUSIVE | Sau MVP |
| V24 | **DoS Verifier** | 🟡 | Body lớn, schema phức tạp, regex gây treo (ReDoS) | `maxBytes`, giới hạn độ sâu và kích thước schema, cấm `pattern` hoặc dùng RE2, timeout từng kiểm tra, giới hạn tốc độ | MVP |
| V-TIME | **Kiểm định lại khi khiếu nại cho kết quả khác** | 🟡 | `freshness` / `oracle` phụ thuộc thời điểm | Lưu `receivedAt` và block oracle đã dùng trong Receipt; kiểm lại dùng đúng các giá trị đó | MVP |
| V-DIG | **Hàng số đã giao trước khi kiểm định** | 🟡 | FAIL nhưng người mua vẫn giữ dữ liệu | Luật khách quan, người mua không giả được FAIL (V3 bảo đảm); uy tín người mua (sau MVP) | Nói rõ |

### 11.4 Uy tín

| # | Lỗ hổng | Mức | Kịch bản | Cách giảm | Khi nào |
|---|---|---|---|---|---|
| V13 | **Tự mua của mình để thổi điểm (wash trading)** | 🔴 | Bên bán tạo 50 ví mua, mỗi ví mở một phiên nhỏ toàn PASS → 50 feedback tốt với chi phí ~50 × (`sessionFee` + gas) | Đếm **người mua khác nhau**; trần điểm mỗi người mua; trọng số theo tuổi và uy tín người mua; loại ví được bên bán nạp tiền; trọng số theo số tiền; điểm nhạt dần | MVP (đếm người mua khác nhau, trần mỗi người mua) |
| V14 | **Thổi điểm tham khảo trên mainnet** | 🟠 | Tự chuyển USDC giữa các ví vào `payTo` | Như V13 + trần 40 + bắt buộc chứng minh sở hữu ví | MVP |
| V15 | **Mạo danh** | 🟠 | Link lạ khai `agentId` của bên uy tín để được tin; hoặc mở phiên với `agentId` của đối thủ rồi cố tình FAIL để hạ điểm họ | SDK: `payTo` phải trùng ví ERC-8004, tên miền phải có trong file đăng ký. Contract: luôn kiểm `ScoreAttestation` ràng buộc `agentId` ↔ ví `seller` (§5.1.2) | MVP |
| V-SC | **Scorer bị lộ khóa hoặc sai** | 🟠 | Ký điểm cao cho bên bán xấu | Hạn attestation ngắn; luật người mua vẫn giữ hạn mức; admin bật allowlist bên bán | MVP (hạn ngắn) |
| V-NEG | **Hạ điểm đối thủ** | ⚪ | Người mua muốn làm FAIL bên bán | Không làm được: Receipt dựa trên dữ liệu bên bán đã ký. Cách duy nhất là khiếu nại bừa, và sẽ mất cọc | — |

### 11.5 Khóa và hạn mức của người mua

| # | Lỗ hổng | Mức | Kịch bản | Cách giảm | Khi nào |
|---|---|---|---|---|---|
| V16 | **Lộ khóa ví agent (chế độ Tự động)** | 🟠 | Kẻ gian ký thêm Voucher trong phiên đang mở, mở phiên mới với bên bán đồng bọn có điểm đủ, hoặc `transfer` thẳng USDC | Qua AgentPay: `cap` nhỏ, `dailyCap`, `minScore` > 40, chỉ request PASS mới mất tiền, admin `pause`. Ngoài AgentPay: chỉ để ít tiền trong ví (§3.5). Muốn chặn hẳn: dùng chế độ Duyệt | MVP |
| V-TEMP | **Lộ khóa tạm (chế độ Duyệt)** | 🟡 | Kẻ gian ký thêm Voucher trong phiên đó | Chỉ trả cho đúng bên bán của phiên, chỉ request PASS mới mất tiền, tối đa `cap − sessionFee`. Không mở được phiên mới, không đụng ví chính. Khóa chỉ trong bộ nhớ, xóa khi hết phiên | MVP |
| V-BLIND | **Ký mù trong MetaMask (chế độ Duyệt)** | 🟡 | MetaMask chỉ hiện "trả `cap` cho Escrow", không hiện bên bán (nằm trong `nonce`). Agent bị lừa hoặc trang giả xin duyệt phiên với bên bán đồng bọn | Trang duyệt của SDK hiện tham số đã giải mã và tự kiểm `nonce`; luật người mua (`minScore`, allowlist) vẫn chặn bên bán không đạt; mất tối đa `cap`, chỉ cho request PASS. Sau MVP: EIP-712 riêng của AgentPay để MetaMask hiện đủ tham số | MVP |
| V-PROMPT | **Prompt injection vào agent** | 🟠 | Phản hồi API chứa lệnh "hãy trả $20 cho X" | Luật người mua nằm trong contract, agent bị lừa không mở được phiên vượt luật (màn 6 của demo). Agent chỉ có tool AgentPay, không cầm khóa (§3.5) | MVP + nói khi thuyết trình |
| V-TOOL | **Agent có tool chuyển tiền tự do** | 🟠 | Người dùng cài thêm bộ tool ví có `transfer`; agent bị lừa gọi thẳng, Escrow không thấy | Khuyến nghị §3.5 trong README; Buyer SDK cảnh báo khi phát hiện tool ví khác **[nếu làm được]** | MVP (tài liệu) |
| V18 | **Ranh giới ngày** | ⚪ | Tiêu 23:59 và 00:01 → gấp đôi hạn mức | Token bucket 24 giờ | MVP |
| V-ADM | **Lộ khóa admin của người mua** | 🟡 | Kẻ gian nới luật | Nới luật chờ 24 giờ, dashboard cảnh báo khi có `proposeLoosen`; siết luật có hiệu lực ngay | MVP |

V17 (ERC-1271) và V-OWN (mất khóa owner của Policy Wallet) đã bỏ cùng Policy Wallet.

### 11.6 Vận hành, pháp lý, riêng tư

| # | Rủi ro | Mức | Ghi chú |
|---|---|---|---|
| V23 | **Verifier thấy mọi dữ liệu người mua đã mua** | 🟡 | Vấn đề riêng tư, và có thể vi phạm điều khoản của bên bán dữ liệu. Lưu ngắn hạn (7 ngày), mã hóa khi lưu |
| V25 | **Keeper chết** | ⚪ | Ai cũng gọi `finalize` / `refund` được; bên bán có động lực gọi |
| V30 | **Độ trễ** | 🟡 | Mở phiên tốn một giao dịch (~2 giây) trước request đầu tiên; các request sau đi vòng qua Verifier và chờ kiểm định → thêm vài trăm ms mỗi request. Đặt `maxTimeoutSeconds` hợp lý; mở phiên trước khi cần |
| V29 | **Pháp lý** | 🟡 | Arbiter quyết định dòng tiền nên có thể bị coi là bên trung gian giữ tiền. **Ban tổ chức đã chấp nhận cho phạm vi cuộc thi** (D36, testnet, không tiền thật). Trước khi chạy mainnet với tiền thật vẫn phải xin tư vấn pháp lý |
| V-HACK | **Luật hackathon về code có sẵn** | ⚪ | **Ban tổ chức đã chấp nhận** dùng lại code PayCrow (D36). Vẫn phải giữ LICENSE MIT và ghi nguồn trong bài nộp (§15) |
| V-DEP | **Phụ thuộc testnet** | 🟡 | Faucet, RPC công khai, feed oracle trên testnet có thể chập chờn → RPC dự phòng và **video quay sẵn** |

---

## 12. Quyết định đã chốt

> Bảng này là nguồn chuẩn cho phạm vi và tham số MVP. Muốn đổi thì sửa ở đây trước. Chốt ngày 2026-11-12, D1–D2 sửa ngày 2026-11-17.

**A. Phạm vi MVP**
| # | Quyết định |
|---|---|
| D1 | **Bỏ Policy Wallet** khỏi dự án (2026-11-17). Chỉ hỗ trợ ví EOA với luật người mua trong Escrow; kèm hướng dẫn cài đặt an toàn (§3.5). Smart account để lộ trình |
| D2 | **Không** có đường trả thẳng qua AgentPay. Phiên quá nhỏ thì SDK gợi ý dùng scheme `exact` thông thường |
| D3 | Facilitator: sửa `packages/x402-bridge` của PayCrow (TypeScript), thêm scheme `agentpay-session` |
| D4 | Khiếu nại: có hàm `challenge` / `resolveChallenge`, nhóm tự làm Arbiter, tiền cọc chỉ mang tính minh họa |
| D5 | Demo: phiên $1, 15 lần PASS → bên bán chuyển sang chế độ lỗi → 3 FAIL liên tiếp → phiên tự đóng, cộng màn chặn prompt injection bằng hạn mức (§14.5) |

**B. Tham số phiên**
| # | Quyết định |
|---|---|
| D6 | `cap` mỗi phiên: **$0,50 – $20** |
| D7 | `expiry`: mặc định **1 giờ**, tối đa **24 giờ** |
| D8 | **K = 3** lần FAIL liên tiếp thì Verifier tự đóng phiên |
| D9 | `challengeWindow`: **30–60 giây** khi demo trên testnet, **5 phút** khi chạy thật |
| D10 | `VERDICT_GRACE` = **10 phút** |
| D11 | Verifier ký SessionVerdict tạm (checkpoint) **mỗi 20 request** |
| D12 | `maxInFlightPerVerifier` = **$1.000** trên testnet |

**C. Phí và gas**
| # | Quyết định |
|---|---|
| D13 | `sessionFee` = **$0,03–0,05** mỗi phiên, **người mua trả**, trừ vào phần hoàn lại (chốt con số sau khi đo gas phiên) |
| D14 | Thêm **0,5%** trên `passedAmount`, trừ vào phần bên bán |
| D15 | Gas: Facilitator trả bước mở, Verifier trả bước đóng, Keeper trả bước chốt; tất cả bù từ phí |
| D16 | Phần tiền hoàn **không** được cộng lại vào hạn mức ngày |

**D. Kiểm định và Verifier**
| # | Quyết định |
|---|---|
| D17 | Thời gian giao đo bằng **giờ Verifier nhận**; ghi rõ là rủi ro (V8) |
| D18 | Verifier **làm relay** dữ liệu; lưu ngắn hạn, mã hóa |
| D19 | Giữ body **7 ngày** sau khi phiên kết thúc rồi xóa |
| D20 | Body tối đa **1 MB**; lớn hơn để sau MVP |
| D21 | **Guardian** (quyền `revokeVerifier`, `pause`) là một ví riêng của trưởng nhóm, khác ví admin |
| D22 | Dữ liệu demo: **giá AVAX/USD**, so với Chainlink **mainnet** |

**E. Uy tín**
| # | Quyết định |
|---|---|
| D23 | Feedback mỗi phiên = tỉ lệ PASS (0–100), trọng số theo `log(passedAmount)`, có trần cho mỗi người mua |
| D24 | Điểm âm nặng khi FAIL ≥ 50% số request trong phiên |
| D25 | `minScore` mặc định = **30** (2026-11-19, trước là 50): dưới trần điểm tham khảo 40 để bên bán uy tín ở nền tảng khác vượt được cold start; chỉ là mặc định của SDK/Dashboard, contract không đổi |
| D26 | Uy tín của người mua: để sau MVP |

**F. Sản phẩm (cho slide)**
| # | Quyết định |
|---|---|
| D27 | Khách hàng đầu tiên: **bên mua** (agent dev). Bên bán dùng SDK miễn phí |
| D28 | Thông điệp khác biệt: "Kiểm định tự động bằng Spec khóa on-chain + thanh toán vi mô theo phiên + hạn mức cho EOA" |
| D29 | Gói doanh nghiệp: dashboard nhiều agent, Verifier riêng, luật nâng cao; giá chưa chốt (Q22) |

**G. Tham số an toàn (thêm 2026-11-17, khi đưa cách xử lý lỗ hổng vào thiết kế)**
| # | Quyết định |
|---|---|
| D30 | `MAX_AUTH_TTL` = **10 phút** (SDK dùng 2 phút); `MAX_ATTEST_TTL` = **1 giờ** |
| D31 | Ràng buộc `agentId` ↔ ví bên bán bằng `ScoreAttestation` là **bắt buộc** với mọi phiên |
| D32 | Tiền dùng được trong phiên = `cap − sessionFee`; phí chốt theo phiên; trần cứng `MAX_SESSION_FEE` = $0,10, `MAX_FEE_BPS` = 1% |
| D33 | Bên bán chỉ tự đóng phiên bằng checkpoint khi `now ≥ expiry` |
| D34 | Khiếu nại: cọc `max(10% số tiền tranh chấp, $0,10)` trả bằng EIP-3009; Arbiter có **24 giờ**, quá hạn thì `expireChallenge` hoàn người mua (thay Q12, Q13) |
| D35 | Giới hạn Verifier: body ≤ 1 MB, schema ≤ 8 KB, RE2, 500 ms mỗi kiểm tra, 10 request/giây mỗi phiên, 20 phiên OPEN mỗi người mua; oracle cũ hoặc RPC lỗi → INCONCLUSIVE |
| D36 | Ban tổ chức đã chấp nhận (2026-11-17): dùng lại code PayCrow (MIT, ghi nguồn) và việc nhóm làm Arbiter trong MVP (thay Q-HACK) |
| D37 | **Hai chế độ người mua** (2026-11-17): *Tự động* (ví riêng của agent, `voucherSigner` = ví agent) và *Duyệt* (ví chính trong MetaMask, người duyệt mỗi phiên, `voucherSigner` = khóa tạm). Cả hai cùng một contract, chỉ khác cách SDK điền `voucherSigner` (§3.3) |
| D38 | **Chốt giao diện H3** (2026-11-18): duyệt F1–F14 trong `INTERFACE_FREEZE.md` (`sessionId`, kiểm chặt Verdict, `resolveChallenge` theo số lượt, kiểm ví on-chain qua ERC-8004 Identity, D24 = −50, luật người mua chi tiết, `pauseSystem`, lá Merkle, định dạng wire). Nguồn chuẩn: `contracts/src/interfaces/IAgentPaySessionEscrow.sol` và `packages/agentpay-core` |

Các câu hỏi cũ đã được thay bằng quyết định: Q9 → D1, Q10 → D17, Q11 → D15, Q14 → D18, Q15 → D9, Q16 → D23, Q17 → D25, Q18 → D26, Q19 → D14, Q20 → trường `requestHash` trong Voucher, Q21 → D27, Q23 → D28, Q24 → ký quỹ theo phiên + D13, Q26 → D16, Q27 → D13, Q12 và Q13 → D34.

---

## 13. Xác minh kỹ thuật và câu hỏi còn mở

### 13.1 Kết quả xác minh (2026-11-12)

Chi tiết và nguồn: `reports/Xác minh kỹ thuật AgentPay.md`.

| # | Câu hỏi | Kết quả | Ảnh hưởng |
|---|---|---|---|
| Q1 | USDC trên Fuji | `0x5425890298aed601595a70AB815c96711a31Bc65`, FiatTokenV2_2; domain `{name: "USD Coin", version: "2"}` (**không phải "USDC"**); có `receiveWithAuthorization` / `transferWithAuthorization` / `cancelAuthorization`; `receiveWithAuthorization` bắt caller = payee (đã kiểm on-chain) | Mở phiên chạy được như thiết kế |
| Q2 | Chữ ký ERC-1271 | Có overload `bytes signature` trên cả Fuji và mainnet; chưa test end-to-end | Không cần cho MVP (chỉ EOA). Liên quan khi hỗ trợ smart account (Phụ lục B) |
| Q3 | EIP-7702, EIP-1153 | **Không có EIP-7702** (type-4 bị từ chối, ACP-209 mới "Proposed"). **Có EIP-1153**, PUSH0, MCOPY | Không gắn code vào EOA được. Dùng `ReentrancyGuardTransient`; ghim `evm_version = "cancun"` |
| Q4 | ERC-8004 | v2.0.0 đã có sẵn trên Fuji và mainnet (địa chỉ ở §5.4). `giveFeedback(...)` **không cần `feedbackAuth`**. `getSummary` lọc theo danh sách client | Không phải tự deploy. Escrow gọi `giveFeedback` trực tiếp; dùng cố định một `valueDecimals` và một tag |
| Q5 | Chainlink AVAX/USD | Mainnet `0x0A77230d17318075983913bC2145DB16C7366156`, Fuji `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD`, 8 decimals, đều đang cập nhật. **Heartbeat/deviation chưa xác minh** | Giới hạn độ cũ để cấu hình được; Verifier đọc feed mainnet |
| Q6 | Facilitator, scheme mới | x402-rs có Fuji nhưng chỉ `exact`. Facilitator công khai trên Avalanche chỉ `exact`; CDP không hỗ trợ Avalanche. Repo chính đã chuyển sang `x402-foundation/x402`; scheme mới thêm qua PR vào `specs/schemes/` | Phải tự host facilitator (D3) |
| Q7 | Gas trên Fuji | Số gas giống mainnet; giá thì không (Fuji ~10–160 wei, mainnet sàn 7,5 gwei theo ACP-283) | Đo số gas trên Fuji/fork, nhân giá mainnet |
| Q8 | API lịch sử giao dịch | Etherscan V2: Avalanche chỉ có ở gói trả phí. **Routescan** dùng được không cần key (2 req/s, 10k/ngày). Glacier dự phòng | Scorer dùng Routescan |
| Q25 | Scheme trả theo lô của x402 | Có **`batch-settlement`**: nạp một lần qua `receiveWithAuthorization`, voucher cộng dồn, claim theo lô, hoàn phần dư; contract merge 2026-05-15, chạy trên CDP (Base…), **chưa có trên Avalanche**. Không có kiểm định: bên bán lấy quá là "trust violation, not a protocol violation" | Bám theo mô hình `batch-settlement` (§4.1) |

### 13.2 Còn mở

| # | Câu hỏi | Đề xuất / việc cần làm | Hạn |
|---|---|---|---|
| Q25b | Bên bán có tự `claim()` trong `x402BatchSettlement.sol` mà không cần `receiverAuthorizer` (Verifier) không? | Đọc contract. Tự claim được → không dùng lại được, giữ contract riêng và chỉ làm định dạng tương thích | Tuần 1 |
| Q5b | Heartbeat và ngưỡng lệch của feed AVAX/USD mainnet | Tra data.chain.link, đặt giới hạn độ cũ theo đó | Trước khi code Verifier |
| Q7b | Con số `sessionFee` cụ thể | Đo gas một phiên trên fork, chốt trong khoảng D13 | Tuần 1 |
| ~~Q-ID~~ | ~~Identity Registry có hàm đọc ví nhận tiền của `agentId` không~~ | **Đã giải 2026-11-18:** có `getMetadata(agentId, "agentWallet")` (kiểm trên Fuji, agent 1–3). Dùng ở F4 | — |
| Q28 | Receipt từng request có cần đưa lên chain khi khiếu nại không? | MVP: chỉ lưu off-chain + `receiptsRoot`; hàm khiếu nại theo Merkle proof để sau | — |
| Q22 | Gói doanh nghiệp giá bao nhiêu? | Chưa cần cho MVP | Slide |

---

## 14. Phạm vi MVP, kế hoạch và demo

### 14.1 Phải có

- `AgentPaySessionEscrow`: `openWithAuthorization` (9 bước kiểm, gồm ràng buộc bên bán), luật người mua (`registerBuyer`, `tighten`, `proposeLoosen`/`applyLoosen`/`cancelLoosen`, `pause`, bản `...BySig`), `closeSession`, `closeEmpty`, `finalize` (push, lỗi thì pull), `withdraw(to)`, `refund`, `proveEquivocation`, `challenge`/`resolveChallenge`/`expireChallenge`, phí chốt theo phiên có trần, trần tiền đang chờ, VerifierRegistry.
- **Toàn bộ test ở §11.0** chạy qua (Foundry cho contract, test tích hợp cho off-chain).
- Facilitator: sửa `packages/x402-bridge` (D3), scheme `agentpay-session` trên Fuji.
- Voucher / Delivery / Receipt / SessionVerdict trong Buyer SDK, Seller SDK và Verifier.
- Verifier: relay, 4 loại kiểm tra (`json-schema`, `equals`, `freshness`, `oracle-deviation`), ký Receipt và SessionVerdict, tự đóng phiên sau 3 FAIL, checkpoint.
- Buyer SDK tự kiểm lại body theo Spec và khiếu nại khi kết quả khác Receipt.
- ERC-8004 Identity + Reputation **có sẵn** trên Fuji; Escrow ghi một feedback mỗi phiên.
- 1 agent bán giá AVAX (có chế độ "trả lỗi"), 1 agent mua.
- Dashboard: dòng thời gian phiên, bộ đếm PASS/FAIL, điểm uy tín, nút dừng luật người mua.
- Buyer SDK / MCP có **cả hai chế độ** (§3.3): `auto` và `approve`, kèm trang duyệt `localhost` kết nối MetaMask.
- README Buyer SDK có mục "Cài đặt an toàn cho chế độ Tự động" (§3.5) và hướng dẫn chọn chế độ.

### 14.2 Nên có

- Scorer với 1 nguồn tham khảo (lịch sử USDC trên mainnet) + score attestation.
- Keeper bot.
- MCP server cho người mua, giữ khóa bên trong.

### 14.3 Để sau (chỉ nói trên slide)

Xem Phụ lục B.

### 14.4 Kế hoạch theo tuần

| Tuần | Ngày | Việc |
|---|---|---|
| 1 | 11/11 – 17/11 | ~~Xác minh Q1–Q8, Q25~~ (đã xong). Đọc `x402BatchSettlement.sol` (Q25b). Viết `AgentPaySessionEscrow` + luật người mua + VerifierRegistry + **test contract ở §11.0**. Đo gas một phiên trên fork, chốt `sessionFee` |
| 2 | 18/11 – 24/11 | Facilitator (sửa x402-bridge). Verifier (relay, Receipt, SessionVerdict, giới hạn tài nguyên, mã hóa body). Seller SDK (kiểm Voucher, checkpoint). Buyer SDK/MCP (ký Voucher, tự kiểm lại, khiếu nại; chế độ `auto` trước). Scorer ký attestation có `wallet`. Agent bán giá AVAX + agent mua. Chạy được luồng §6.3 → §6.5 trên Fuji. **Test off-chain ở §11.0** |
| 3 | 25/11 – 30/11 | Chế độ `approve` + trang duyệt MetaMask. Dashboard. Scorer tối giản. README cài đặt an toàn. **Quay video demo trước 28/11.** Slide |

### 14.5 Kịch bản demo (khoảng 3 phút)

Dashboard chiếu song song: dòng thời gian phiên, bộ đếm PASS/FAIL, số dư hai bên, điểm uy tín.

| # | Thời gian | Màn | Khán giả thấy gì |
|---|---|---|---|
| 0 | 0:00–0:20 | **Vấn đề:** agent trả tiền cho API qua x402, nhận dữ liệu sai vẫn mất tiền; trả vài cent mỗi lần thì không ai làm ký quỹ được vì gas | Một slide |
| 1 | 0:20–0:40 | **Đặt luật cho ví EOA:** người dùng kết nối MetaMask ở dashboard, gọi `registerBuyer`: tối đa $5 mỗi phiên, $10/ngày, `minScore` 50 | Giao dịch trên Snowtrace Fuji; ví vẫn là EOA thường, không đổi ví |
| 2 | 0:40–1:00 | **Mở phiên $1 (chế độ Duyệt):** agent gọi `/price`, nhận 402 `agentpay-session`, SDK kiểm Verifier đã duyệt + điểm bên bán, mở trang duyệt; người dùng bấm **một lần** trong MetaMask; facilitator gọi `openWithAuthorization` | Trang duyệt hiện bên bán, giá, `cap`; 1 popup MetaMask, 1 giao dịch; $1 bị khóa trong contract; agent chỉ giữ khóa tạm |
| 3 | 1:00–1:40 | **Thanh toán vi mô:** agent gọi giá AVAX **15 lần**, mỗi lần $0,01, mỗi lần chỉ một Voucher ký off-chain | Bộ đếm PASS chạy 1 → 15, **không có giao dịch on-chain nào**; mỗi Receipt hiện giá so với Chainlink |
| 4 | 1:40–2:10 | **Không đạt thì không trả:** bên bán bật chế độ lỗi (giá lệch 20%) → 3 FAIL liên tiếp (`ORACLE_DEVIATION`) → Verifier tự đóng phiên | FAIL đỏ ×3; Verifier gửi `closeSession`; Keeper `finalize` |
| 5 | 2:10–2:30 | **Chia tiền:** bên bán nhận $0,15 − 0,5%; người mua được hoàn $0,85 − `sessionFee`; điểm uy tín bên bán cập nhật (15/18 PASS) | Số dư hai ví thay đổi; 1 feedback ERC-8004; cả phiên chỉ ~3 giao dịch cho 18 request |
| 6 | 2:30–2:50 | **Chặn prompt injection (chế độ Tự động):** agent chạy một mình bị lừa đòi mở phiên $20 với bên bán điểm thấp → contract revert `OverPerSession` / `BadScore` | Giao dịch bị từ chối; tiền không đi đâu |
| 7 | 2:50–3:00 | **Kết:** 18 request theo kiểu cũ ≈ 18 × 503k gas; theo phiên ≈ 500k | Một dòng số liệu + lộ trình |

**Dự phòng:**
- Quay video cả kịch bản trước **28/11** (testnet có thể chập chờn).
- Chuẩn bị sẵn ví đã `registerBuyer`, bên bán đã đăng ký ERC-8004, Verifier đã `addVerifier`.
- `challengeWindow` = 30 giây (D9) để bước 4 → 5 không phải chờ lâu.
- Nếu còn thời gian hỏi đáp: demo admin bấm `pauseBuyer` luật người mua từ dashboard → agent không mở được phiên mới.
- Câu hỏi dễ gặp: "Agent gọi thẳng `transfer` thì sao?" → trả lời theo §3.3–3.5: dùng chế độ Duyệt thì agent không cầm khóa ví.

---

## 15. Tái sử dụng từ PayCrow

| Thành phần AgentPay | Lấy từ PayCrow | Phải sửa |
|---|---|---|
| `AgentPaySessionEscrow` | `contracts/src/PayCrowEscrow.sol` (fee, limits, test) | Đổi sang phiên: Voucher + SessionVerdict, CLOSING/CHALLENGED, equivocation, VerifierRegistry, trần tiền đang chờ, push có fallback pull, luật người mua |
| Khoảng chờ khiếu nại | `contracts/src/PayCrowEvaluator.sol` (grace period, challenge) | Gộp vào Escrow |
| Mở phiên bằng EIP-3009 | `contracts/src/PayCrowEscrowRouter.sol` | Gộp vào Escrow; `transferWithAuthorization` → `receiveWithAuthorization`; kiểm nonce = hash(params) |
| Verifier | `packages/verification` (AJV schema) | Băm byte thô (sửa lỗi hash-lock); thêm `freshness`, `oracle-deviation`; relay; ký Receipt / SessionVerdict |
| Buyer SDK / MCP | `packages/mcp-server` | Đổi chain; mở/đóng phiên; ký Voucher; tự kiểm lại; giữ khóa trong server |
| Seller SDK | `packages/trust/src/middleware.ts` (`paycrowRequired`) | Tạo 402 `agentpay-session` + Spec; kiểm Voucher; ký Delivery |
| Scorer | `packages/trust/src/engine.ts` + `sources/` | **Sửa lỗi viết cứng mainnet** (`sources/erc8004.ts`, `sources/base-chain.ts`); thêm trần tham khảo, nhạt dần, chống wash trading |
| Facilitator | `packages/x402-bridge` | Thêm scheme `agentpay-session` trên Fuji (D3) |

PayCrow theo giấy phép MIT (tác giả Miguel Castellano): giữ thông báo bản quyền và ghi nguồn trong bài nộp.

---

## Phụ lục A. Số đo gas của mô hình cũ (một lệnh = một escrow)

> Đây là số đo của thiết kế v0.1, giữ lại làm mốc và làm lý do chuyển sang ký quỹ theo phiên. Số của phiên ở §9.3 được ước tính từ bảng này.

**Cách đo (2026-11-12):** `anvil` fork Avalanche mainnet tại block 100.084.994, USDC thật của Circle. Deploy prototype `AgentPayEscrowProto` (`receiveWithAuthorization`, luật người mua có token bucket và score attestation, Verdict EIP-712, pull payment, ghi feedback vào registry ERC-8004 giả lập). Chạy luồng thật bằng `forge script --broadcast`, đọc `gasUsed` trong receipt. Số này đã gồm 21k gas cố định, calldata và slot lưu trữ mới. Mã benchmark nằm ở thư mục scratchpad của phiên làm việc (`gasbench/`), chưa đưa vào repo.

| Giao dịch | Lần đầu | Lặp lại | Ghi chú |
|---|---|---|---|
| `registerBuyer` | 89.6k | — | Một lần cho mỗi EOA |
| `fundWithAuthorization` | 282.6k | **248.4k** | Gồm kiểm luật người mua + xác minh score attestation |
| `submitVerdict` | 70.6k | **70.5k** | |
| `finalize`, PASS | 249.4k | **133.5k** | Lần đầu: lần đầu ghi feedback cho agent |
| `finalize`, FAIL | — | 145.2k | |
| `refund` (không có Verdict) | — | 58.2k | |
| `withdraw` | 67.5k | **50.4k** | |
| **Tổng một lệnh PASS** | **670k** | **503k** | Không tính `withdraw`: 603k / 452k |

So sánh PayCrow trên cùng fork: `settleToEscrow` 318k / 284k, `release` 356k / 140k → tổng 674k / 424k.

**Quy ra tiền** (base fee 7,5 gwei; AVAX $6,5–11): lệnh lặp lại 503k gas ≈ **$0,025–0,041**, hòa vốn với phí 0,5% khi lệnh ≥ **$5–8**. Lệnh $0,02–0,05 sẽ lỗ hàng trăm lần nếu ký quỹ từng lệnh → chọn ký quỹ theo phiên.

**Giới hạn của số đo:** prototype chưa audit, chưa có khiếu nại hay equivocation; registry ERC-8004 là bản giả lập (bản thật lưu chuỗi tag/URI, có thể tốn hơn); giá gas lấy tại một thời điểm. Phải đo lại khi có `AgentPaySessionEscrow` và registry thật.

---

## Phụ lục B. Lộ trình sau MVP

| Hạng mục | Nội dung |
|---|---|
| **Smart account có hạn mức** | Hỗ trợ ví Safe / ERC-4337 có module hạn mức chi, để chặn được cả `transfer` thẳng (thứ EOA không chặn được). Ví hợp đồng phải **tự gọi** Escrow (thêm hàm kiểu `openFromContract` dùng `transferFrom`), không ký EIP-3009 qua ERC-1271, vì `isValidSignature` là hàm `view`, không ghi được số đã tiêu → ký nhiều chữ ký song song sẽ vượt hạn mức |
| Ví lưu khóa có policy | Tích hợp dịch vụ ký có luật (Turnkey, Privy, Coinbase CDP Server Wallet…) **[cần xác minh hỗ trợ Avalanche]** |
| EIP-7702 | Khi C-Chain hỗ trợ (ACP-209), cho EOA gắn code. Lưu ý: USDC vẫn kiểm chữ ký EIP-3009 bằng khóa EOA, nên ai giữ khóa vẫn ký được |
| Số dư trả trước nhiều bên bán | Người mua nạp một lần dùng cho nhiều bên bán; Verifier gộp kết quả, đăng Merkle root định kỳ; chi phí theo số lần quyết toán |
| Phi tập trung hóa kiểm định | Nhiều Verifier ký 2/3, Verifier đặt cọc, validator có cọc, LLM-judge, TEE; KMS/HSM cho khóa Verifier |
| Khiếu nại đầy đủ | Arbiter độc lập, cọc thật, `proveReceiptMismatch` bằng Merkle proof (Q28) |
| Uy tín người mua | Hạn chế khiếu nại bừa (D26) |
| `topUp` phiên, `commitDelivery` on-chain | Nạp thêm vào phiên đang mở; ghi `bodyHash` lên chain để đo thời gian giao không phụ thuộc Verifier (V8) |
| Chain L1 riêng | Chỉ đưa lên slide: gas gần bằng 0, nhưng USDC native và bên bán x402 đều ở C-Chain |
