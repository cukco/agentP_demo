# AgentPay — `verificationSpec` v0.2 (bản nháp)

> Cập nhật 2026-11-12: chuyển sang **ký quỹ theo phiên** (`AgentPay_SystemDesign.md` §4) và điền các giá trị đã xác minh (`reports/Xác minh kỹ thuật AgentPay.md`). Từ 2026-11-17 chỉ hỗ trợ ví EOA (Policy Wallet đã bỏ, SystemDesign D1).
> Bản v0.1 (một lệnh = một escrow) đã bị thay. Phần bộ luật kiểm định (§3, §5) giữ nguyên; đổi phần thanh toán, chữ ký và luồng (§2, §4.1, §6, §7, §8).
> Các chỗ đánh dấu **[cần xác minh]** phải kiểm tra lại trước khi code.

## 1. Mục đích

`verificationSpec` là **bộ luật kiểm định** mà bên bán khai trong phản hồi HTTP 402. Nó quyết định kết quả giao của **mỗi request** như thế nào thì được tính là "đạt".

Ba yêu cầu thiết kế:
1. **Chốt trước khi khóa tiền:** mã băm của spec được gắn vào chữ ký mở phiên của người mua và lưu trong phiên. Không bên nào sửa được trong suốt phiên.
2. **Máy kiểm được, kết quả xác định:** cùng dữ liệu, cùng spec → mọi verifier (và Buyer SDK tự kiểm lại) cho cùng kết quả, trừ các kiểm tra phụ thuộc thời gian/oracle (§8).
3. **Fail-closed:** người mua gặp spec lạ (phiên bản lạ, loại kiểm tra lạ, verifier không có trong VerifierRegistry) → **không mở phiên**.

---

## 2. Vị trí trong phản hồi 402

Spec nằm trong `extensions.agentpay` của phản hồi `PaymentRequired` (x402 v2). Scheme là `agentpay-session`.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://seller.example/v1/price/AVAX" },
  "accepts": [
    {
      "scheme": "agentpay-session",
      "network": "eip155:43113",
      "asset": "0x5425890298aed601595a70AB815c96711a31Bc65",
      "amount": "10000",
      "payTo": "0xSESSION_ESCROW_CONTRACT",
      "maxTimeoutSeconds": 120,
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ],
  "extensions": {
    "agentpay": {
      "version": "0.2",
      "session": {
        "contract": "0xSESSION_ESCROW_CONTRACT",
        "chainId": 43113,
        "seller": "0xSELLER_WALLET",
        "sellerAgentId": "12",
        "pricePerRequest": "10000",
        "minCap": "500000",
        "maxCap": "20000000",
        "defaultExpirySec": 3600,
        "maxExpirySec": 86400,
        "deliveryDeadlineSec": 10,
        "challengeWindowSec": 300
      },
      "verificationSpec": { "...": "xem §3" }
    }
  }
}
```

- `asset`: USDC trên Fuji `0x5425890298aed601595a70AB815c96711a31Bc65` (FiatTokenV2_2, **đã xác minh on-chain**). Mainnet: `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`.
- `extra`: EIP-712 domain của USDC là `{name: "USD Coin", version: "2"}`. **Không dùng `"USDC"`** (đó là `symbol()`), ký với tên sai thì chữ ký không hợp lệ.
- `amount` = **giá mỗi request**, tính bằng đơn vị nhỏ nhất (6 chữ số thập phân): `10000` = $0,01. Số tiền khóa khi mở phiên là `cap`, do người mua chọn trong `[minCap, maxCap]`.
- `payTo` là **hợp đồng ký quỹ theo phiên**, không phải ví bên bán. Ví bên bán nằm ở `session.seller`.
- `sellerAgentId` dùng để tra ERC-8004 và chống mạo danh (`AgentPay_ThietKe.md` mục A3).

**Tương thích x402:** x402 đã có scheme `batch-settlement` (nạp một lần, voucher cộng dồn, quyết toán theo lô) nhưng **không có kiểm định**. `agentpay-session` cố ý dùng cùng mô hình (nạp bằng `receiveWithAuthorization`, voucher cộng dồn) và thêm Verifier. Có dùng lại được contract của `batch-settlement` hay không còn phụ thuộc vào việc bên bán có tự `claim()` được mà không cần Verifier (xem §9). Facilitator công khai trên Avalanche chỉ hỗ trợ `exact`, nên AgentPay tự chạy facilitator.

---

## 3. Ví dụ đầy đủ: dịch vụ bán giá AVAX (demo)

```json
{
  "specVersion": "agentpay-verify/0.2",
  "serviceType": "price-feed",
  "verifier": {
    "address": "0xVERIFIER_SIGNER",
    "endpoint": "https://verify.agentpay.example/v1"
  },
  "delivery": {
    "contentType": "application/json",
    "maxBytes": 65536
  },
  "checks": [
    {
      "id": "schema",
      "type": "json-schema",
      "schema": {
        "type": "object",
        "required": ["symbol", "price", "timestamp"],
        "properties": {
          "symbol":    { "type": "string" },
          "price":     { "type": "number", "exclusiveMinimum": 0 },
          "timestamp": { "type": "integer" }
        }
      }
    },
    { "id": "symbol", "type": "equals", "field": "/symbol", "value": "AVAX" },
    { "id": "fresh",  "type": "freshness", "field": "/timestamp", "unit": "unix-s", "maxAgeSec": 60 },
    {
      "id": "oracle",
      "type": "oracle-deviation",
      "field": "/price",
      "oracle": { "kind": "chainlink", "chainId": 43114, "feed": "0x0A77230d17318075983913bC2145DB16C7366156" },
      "maxDeviationBps": 200
    }
  ],
  "passRule": "all"
}
```

Oracle: dùng feed AVAX/USD trên **mainnet** (`0x0A77230d17318075983913bC2145DB16C7366156`, 8 decimals) theo D22, vì feed testnet không có cam kết cập nhật. Feed Fuji `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD` chỉ dùng khi chạy thử. Heartbeat và ngưỡng lệch của feed **[cần xác minh]** trên data.chain.link.

---

## 4. Tham chiếu các trường

### 4.1 `extensions.agentpay.session`

| Trường | Kiểu | Bắt buộc | Ý nghĩa | Giới hạn |
|---|---|---|---|---|
| `contract` | address | ✓ | Hợp đồng `AgentPaySessionEscrow` | Phải nằm trong danh sách contract người mua tin |
| `chainId` | number | ✓ | Chain của ký quỹ | Phải khớp `accepts[].network` |
| `seller` | address | ✓ | Ví nhận tiền các request PASS | Phải trùng ví khai trong ERC-8004 |
| `sellerAgentId` | string | ✓ | agentId trong ERC-8004 | — |
| `pricePerRequest` | string (uint) | ✓ | Giá mỗi request | = `accepts[].amount` |
| `minCap`, `maxCap` | string (uint) | ✓ | Khoảng `cap` bên bán chấp nhận | Trong $0,50 – $20 (D6) |
| `defaultExpirySec`, `maxExpirySec` | number | ✓ | Thời hạn phiên | Mặc định 3600, tối đa 86400 (D7) |
| `deliveryDeadlineSec` | number | ✓ | Thời gian tối đa để giao **mỗi request**, tính từ lúc Verifier nhận Voucher của request đó | 1–300 |
| `challengeWindowSec` | number | ✓ | Khoảng chờ khiếu nại sau khi đóng phiên | 30–60 trên testnet khi demo; 300–86400 khi chạy thật (D9) |

### 4.2 `verificationSpec`

| Trường | Kiểu | Bắt buộc | Ý nghĩa |
|---|---|---|---|
| `specVersion` | string | ✓ | Luôn là `"agentpay-verify/0.2"` ở bản này |
| `serviceType` | string | ✓ | Loại dịch vụ, dùng cho luật spec tối thiểu (§7.2). MVP: `price-feed`, `json-data`, `file` |
| `verifier.address` | address | ✓ | Khóa ký Receipt và SessionVerdict. Phải **ACTIVE trong VerifierRegistry** của contract |
| `verifier.endpoint` | URL | ✓ | Gốc API của Verifier (relay request/body, nộp Delivery) |
| `delivery.contentType` | string | ✓ | MVP: `application/json` hoặc `application/octet-stream` |
| `delivery.maxBytes` | number | ✓ | Kích thước tối đa của body mỗi request. Tối đa 1 MB (D20) |
| `checks` | array | ✓ | 1–16 kiểm tra, xem §5 |
| `passRule` | string | ✓ | MVP chỉ có `"all"`: mọi kiểm tra đều phải đạt |

---

## 5. Danh mục loại kiểm tra (MVP)

Mọi kiểm tra có `id` (chuỗi, duy nhất trong spec) và `type`. `field` là **JSON Pointer** (RFC 6901), ví dụ `/price`, `/data/0/value`. Các kiểm tra chạy trên **từng request** trong phiên.

| `type` | Tham số | Đạt khi | Mã lỗi |
|---|---|---|---|
| `json-schema` | `schema` | Body hợp lệ theo schema | 10 |
| `equals` | `field`, `value` | Giá trị tại `field` bằng đúng `value` (so sánh kiểu và giá trị) | 11 |
| `range` | `field`, `min?`, `max?` | Số tại `field` nằm trong `[min, max]` | 12 |
| `freshness` | `field`, `unit` (`unix-s`/`unix-ms`), `maxAgeSec` | `thời_điểm_verifier_nhận − field ≤ maxAgeSec`, và `field` không ở tương lai quá 5 giây | 13 |
| `oracle-deviation` | `field`, `oracle{kind, chainId, feed}`, `maxDeviationBps` | `|field − oracle| / oracle ≤ maxDeviationBps / 10000` | 14 |
| `hash-match` | `expectedHash` (bytes32) | `keccak256(body thô) == expectedHash` (dùng cho file đã biết trước) | 15 |

Ràng buộc với `json-schema`:
- Chỉ dùng tập con của **draft 2020-12**.
- **Không** cho `$ref` tới URL bên ngoài, để tránh việc verifier bị lừa tải trang lạ (SSRF) và để kết quả không phụ thuộc vào mạng.
- Schema tối đa 8 KB; `pattern` chỉ chạy bằng engine RE2 (V24).

`oracle-deviation`: MVP chỉ hỗ trợ `kind: "chainlink"`. Verifier đọc `latestRoundData()` và chuẩn hóa theo `decimals()` của feed. Nếu dữ liệu oracle cũ hơn ngưỡng cấu hình (mặc định 1 giờ) thì kết quả là **không kết luận được** (§8).

---

## 6. Băm và chữ ký

### 6.1 Mã băm

| Tên | Cách tính |
|---|---|
| `specHash` | `keccak256(UTF-8(JCS(verificationSpec)))`. JCS = RFC 8785 (chuẩn hóa JSON: sắp xếp khóa, bỏ khoảng trắng) |
| `bodyHash` | `keccak256(byte thô của body)`. **Không** parse JSON rồi stringify lại (đây là lỗi hash-lock của PayCrow) |
| `requestHash` | `keccak256(abi.encode(method, url, keccak256(request body)))` |
| `receiptsRoot` | Merkle root (keccak256, cặp đã sắp xếp) của `keccak256(abi.encode(Receipt))` theo thứ tự `seq` |

### 6.2 Gắn spec vào chữ ký mở phiên

Người mua ký EIP-3009 `receiveWithAuthorization(from, to=sessionEscrow, value=cap, validAfter, validBefore, nonce, v, r, s)` trên USDC (domain `{"USD Coin", "2", chainId, USDC}`), với:

```
nonce = keccak256(abi.encode(
    seller, sellerAgentId, verifier.address, voucherSigner, specHash,
    cap, pricePerRequest, expiry, deliveryDeadlineSec, challengeWindowSec, salt
))
```

- Facilitator gửi cả tham số lẫn `salt` lên `openWithAuthorization`. Contract **tính lại `nonce`** và từ chối nếu không khớp, nên facilitator hay bên bán **không đổi được spec, Verifier, `voucherSigner`, giá hay thời hạn**.
- `voucherSigner`: khóa được ký Voucher của phiên. Chế độ Tự động: chính ví trả tiền (`from`). Chế độ Duyệt: khóa tạm do Buyer SDK tạo riêng cho phiên, ví chính duyệt qua MetaMask (SystemDesign §3.3).
- `receiveWithAuthorization` bắt người gọi phải là người nhận (`to`), nên không ai front-run được chữ ký (đã kiểm on-chain trên Fuji).

### 6.3 EIP-712 của AgentPay

Domain: `{ name: "AgentPay", version: "0.2", chainId, verifyingContract: session.contract }`

```
Voucher(uint256 sessionId, uint32 seq, uint128 cumulativeAmount, bytes32 requestHash)
    ký bởi: session.voucherSigner (ví agent ở chế độ Tự động, khóa tạm ở chế độ Duyệt)
    cumulativeAmount = seq × pricePerRequest (MVP giá cố định), ≤ cap − sessionFee
    (sessionFee đọc từ contract lúc mở phiên và được chốt vào phiên, SystemDesign §5.1.5)

Delivery(uint256 sessionId, uint32 seq, bytes32 requestHash, bytes32 bodyHash, bytes32 specHash)
    ký bởi: session.seller

Receipt(uint256 sessionId, uint32 seq, bytes32 requestHash, bytes32 bodyHash,
        uint8 outcome, uint16 reasonCode, uint128 amount,
        uint64 receivedAt, bytes32 evidenceHash)
    ký bởi: verifier.address — off-chain, gửi cho cả người mua và bên bán
    outcome: 1 = PASS, 2 = FAIL, 3 = INCONCLUSIVE
    receivedAt: lúc Verifier nhận body (unix giây)
    evidenceHash: keccak256(abi.encode(feed, roundId, answer, updatedAt)) của oracle đã dùng; 0x0 nếu không dùng oracle

ScoreAttestation(uint256 agentId, address wallet, uint16 score, uint16 flags, uint64 validUntil)
    ký bởi: Scorer — domain { name: "AgentPay Scorer", version: "0.2", chainId, verifyingContract: session.contract }
    Escrow luôn kiểm khi mở phiên: agentId == sellerAgentId, wallet == seller, còn hạn, ≤ 1 giờ

SessionVerdict(uint256 sessionId, bytes32 specHash, uint32 lastSeq,
               uint32 passCount, uint32 failCount, uint32 inconclusiveCount,
               uint128 passedAmount, bytes32 receiptsRoot, uint64 closedAt)
    ký bởi: verifier.address — nộp lên chain qua closeSession
    Bản tạm (checkpoint) ký mỗi 20 request (D11), gửi cho bên bán
```

---

## 7. Luồng và kiểm tra theo từng bên

### 7.1 Luồng

```
1. Người mua GET resource → 402 kèm extensions.agentpay (scheme agentpay-session)
2. Người mua kiểm tra spec và phiên (§7.2). Không đạt → dừng
3. Người mua chọn cap, expiry, voucherSigner; ký receiveWithAuthorization (nonce như §6.2)
      chế độ Duyệt: người dùng duyệt trên trang localhost của SDK rồi ký trong MetaMask
4. Facilitator gọi openWithAuthorization → phiên OPEN → trả về sessionId
5. Mỗi request seq = 1, 2, ...:
   a. Người mua gửi request qua Verifier (relay) kèm header
         PAYMENT-SIGNATURE: Voucher(sessionId, seq, cumulativeAmount, requestHash) + chữ ký
   b. Bên bán kiểm Voucher: chữ ký đúng voucherSigner của phiên (từ sự kiện SessionOpened), seq tăng đúng 1,
      cumulativeAmount = seq × giá và ≤ cap − sessionFee → không đạt thì trả 402 / từ chối
   c. Bên bán trả body + Delivery(sessionId, seq, requestHash, bodyHash, specHash)
   d. Verifier:
         - Delivery đúng chữ ký bên bán, bodyHash khớp               → lỗi 1, 2
         - giao trong deliveryDeadlineSec kể từ lúc nhận Voucher      → lỗi 3
         - kích thước, contentType                                    → lỗi 4, 5
         - chạy lần lượt checks; dừng ở kiểm tra lỗi đầu tiên        → lỗi 10–15
         - ký Receipt, gửi body + Receipt cho người mua, Receipt cho bên bán
   e. Buyer SDK tự chạy lại checks trên body. Khác Receipt → dừng phiên, lưu bằng chứng
6. Đóng phiên khi: người mua báo dừng / hết cap / hết expiry / 3 FAIL liên tiếp (D8)
7. Verifier ký SessionVerdict, gọi closeSession(Voucher mới nhất, SessionVerdict)
8. Hết challengeWindowSec → Keeper gọi finalize():
      bên bán nhận passedAmount − 0,5%; người mua nhận cap − passedAmount − sessionFee;
      ghi 1 feedback ERC-8004 cho cả phiên
```

Người mua ký Voucher **trước** khi nhận dữ liệu (bên bán yên tâm có tiền), nhưng chỉ request PASS mới được tính vào `passedAmount` (người mua được bảo vệ).

### 7.2 Người mua kiểm tra spec trước khi mở phiên

Từ chối nếu bất kỳ điều nào sau đây sai:
1. `specVersion` được hỗ trợ; mọi `checks[].type` đều có trong §5.
2. `verifier.address` **ACTIVE trong VerifierRegistry** (đọc từ contract).
3. `session.contract` nằm trong danh sách contract được tin.
4. `session.seller` và tên miền của resource khớp với đăng ký ERC-8004 của `sellerAgentId`.
5. Giá, `cap`, thời hạn, kích thước nằm trong giới hạn ở §4 và trong luật người mua (`maxPerSession` áp lên `cap`).
6. **Spec tối thiểu theo loại dịch vụ**, để bên bán không đặt luật quá lỏng:

| `serviceType` | Bắt buộc phải có |
|---|---|
| `price-feed` | `json-schema` + `freshness` (≤ 300 s) + `oracle-deviation` (≤ 500 bps) |
| `json-data` | `json-schema` có `required` không rỗng |
| `file` | `hash-match` |

---

## 8. Kết quả và mã lỗi

Áp cho **từng request** (trong Receipt). Uy tín tính **một lần mỗi phiên** từ tổng các Receipt (D23–D24).

| Mã | Tên | Kết quả của request | Tính vào |
|---|---|---|---|
| 0 | `PASS` | Tính tiền cho bên bán | `passCount`, `passedAmount` |
| 1 | `BAD_SELLER_SIG` | Không nhận bản nộp (không phải bằng chứng hợp lệ) | — |
| 2 | `HASH_MISMATCH` | Không nhận bản nộp | — |
| 3 | `LATE` | FAIL, không tính tiền | `failCount` |
| 4 | `TOO_LARGE` | FAIL | `failCount` |
| 5 | `BAD_CONTENT` (sai contentType / không phải JSON) | FAIL | `failCount` |
| 10–15 | Lỗi kiểm tra theo §5 | FAIL | `failCount` |
| 20 | `ORACLE_UNAVAILABLE` | INCONCLUSIVE, không tính tiền | `inconclusiveCount` |
| 21 | `VERIFIER_ERROR` | INCONCLUSIVE | `inconclusiveCount` |

- Mã 1–2: dữ liệu được nộp không chứng minh được là do bên bán giao. Verifier chờ bản hợp lệ cho tới hết `deliveryDeadlineSec`; không có thì ký Receipt `FAIL`, mã 3 (`LATE`), `bodyHash = 0x0`.
- **INCONCLUSIVE:** verifier thử lại (ví dụ đọc oracle lại) trong `deliveryDeadlineSec`. Vẫn không kết luận được thì ký Receipt `INCONCLUSIVE`: request không tính tiền, **không** tính vào tỉ lệ PASS/FAIL của bên bán.
- **Uy tín mỗi phiên:** giá trị = `passCount / (passCount + failCount)` × 100, trọng số theo `log(passedAmount)`. FAIL ≥ 50% → thêm điểm âm nặng. Phiên không có request nào hoặc phiên hết hạn mà không được đóng (`refund`) → **không đổi uy tín** (thiếu Verdict là lỗi của Verifier).
- Contract từ chối `closeSession` sau `expiry + VERDICT_GRACE` (10 phút, D10). Lúc đó chỉ còn `refund()`: hoàn 100% `cap` cho người mua.

---

## 9. Câu hỏi còn mở

1. **Dùng lại contract `batch-settlement` của x402?** Phải đọc `x402BatchSettlement.sol`: nếu bên bán (`receiver`) tự `claim()` được mà không cần `receiverAuthorizer` (Verifier) thì không dùng lại được, giữ contract riêng `AgentPaySessionEscrow` và chỉ làm định dạng Voucher tương thích.
2. **Đo thời gian giao:** MVP dùng thời điểm Verifier nhận (D17). Verifier sập thì bên bán bị tính trễ oan. Phương án sau MVP: bên bán ghi `bodyHash` lên chain.
3. ~~`freshness` và `oracle-deviation` phụ thuộc thời gian~~ **Đã giải:** Receipt mang `receivedAt` và `evidenceHash` (§6.3), kiểm định lại dùng đúng các giá trị này.
4. **Giá thay đổi theo request** (ví dụ theo kích thước dữ liệu): MVP dùng giá cố định `pricePerRequest`. Giá động cần thêm `amount` vào Voucher.
5. **Heartbeat / ngưỡng lệch của feed Chainlink** trên Avalanche **[cần xác minh]**.
