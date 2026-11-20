# AgentPay — Chốt giao diện (H0–H3)

**Trạng thái: ĐÃ CHỐT 2026-11-18** (nhóm duyệt toàn bộ F1–F14, ghi là D38 trong SystemDesign §12). Từ giờ giao diện **đóng băng**: mọi thay đổi sau H3 phải qua PR có A và C review, và phải chạy lại `pnpm --filter @agentpay/core gen:vectors`.

## 1. Đã có gì

| Phần | File | Chủ |
|---|---|---|
| Interface contract: struct, enum, event, error, toàn bộ hàm | `contracts/src/interfaces/IAgentPaySessionEscrow.sol` | A |
| Hằng số on-chain | `contracts/src/libraries/AgentPayConstants.sol` | A |
| Typehash EIP-712 + hàm băm | `contracts/src/libraries/AgentPayHashes.sol` | A |
| USDC EIP-3009, ERC-8004 | `contracts/src/interfaces/IFiatTokenV2.sol`, `IERC8004.sol` | A |
| Kiểu TS, hằng số, EIP-712, hàm băm, Merkle | `packages/agentpay-core/src/{types,constants,eip712,hash}.ts` | C |
| API HTTP Verifier / Facilitator / Scorer, header, mã lỗi | `packages/agentpay-core/src/api.ts` | B |
| Định dạng JSON (bigint ↔ chuỗi) | `packages/agentpay-core/src/wire.ts` | C |
| ABI (sinh tự động từ interface) | `packages/agentpay-core/src/abi.ts` — `pnpm --filter @agentpay/core gen:abi` | A → C |
| Vector đối chiếu TS ↔ Solidity | `packages/agentpay-core/vectors/freeze.json` + `contracts/test/AgentPayFreeze.t.sol` | A + C |
| Khung 10 package + 2 demo + dashboard, CI | `packages/agentpay-*`, `demo/*`, `.github/workflows/ci.yml` | Mọi người |

Đã chạy: `forge test` 228/228 xanh (223 test PayCrow cũ + 5 test chốt giao diện); `pnpm turbo run test` 24/24 task xanh. Vector khớp 100%: 14 typehash, `nonce`, `sessionId`, `requestHash`, digest của Voucher, SessionVerdict, ScoreAttestation, Policy.

## 2. Điểm cần nhóm duyệt

Các điểm SystemDesign chưa nói rõ, hoặc mình đề xuất khác đi. Duyệt xong thì A cập nhật lại SystemDesign.

| # | Đề xuất | Lý do |
|---|---|---|
| F1 | `sessionId = uint256(keccak256(abi.encode(buyer, nonce)))` | Biết trước khi giao dịch được mined; người khác không chiếm trước được `sessionId` bằng cách dùng cùng `nonce` |
| F2 | `closeSession` kiểm thêm `cumulativeAmount == seq × giá`, `passedAmount == passCount × giá`, `pass + fail + inconclusive ≤ lastSeq` | Giá cố định trong MVP, nên chặn được Verdict tự mâu thuẫn |
| F3 | `resolveChallenge(sessionId, passCount, failCount, upheld)` thay cho `(sessionId, passedAmount)` | Số tiền suy ra từ số lượt; feedback tính lại đúng; `upheld` nói rõ cọc trả cho ai |
| F4 | **Q-ID đã có câu trả lời:** Identity Registry trên Fuji có `getMetadata(agentId, "agentWallet")` trả về ví nhận tiền (kiểm trên agent 1–3). Đề xuất Escrow kiểm thêm on-chain (`IdentityWalletMismatch`), vẫn bắt buộc `ScoreAttestation` cho điểm và cờ | Ràng buộc `agentId` ↔ ví không còn phụ thuộc chỉ vào khóa Scorer. Tốn thêm khoảng 10k gas |
| F5 | D24 "điểm âm nặng" = feedback thứ hai `value = -50`, `tag2 = "fail-heavy"` | SystemDesign chưa có con số |
| F6 | Luật người mua: `unpause` = `proposeLoosen` với `paused = false`; `pauseBuyer` gọi được bởi admin **hoặc chính ví người mua**; `apply...` ai cũng gọi được sau 24 giờ; `adminNonces` tăng dần theo từng người mua; `setAdmin` thành `proposeAdmin` / `applyAdmin` / `cancelAdmin` | Gọn, đủ các trường hợp siết/nới ở §5.1.2 |
| F7 | Dừng toàn hệ thống đổi tên thành `pauseSystem` / `unpauseSystem` | Tránh trùng tên với `pauseBuyer` |
| F8 | Lá Merkle của `receiptsRoot` = EIP-712 struct hash của Receipt; cặp sắp xếp; nút lẻ đưa thẳng lên | Contract kiểm được bằng OpenZeppelin `MerkleProof` |
| F9 | `proveEquivocation(sessionId, a, sigA, b, sigB)`: bỏ tham số `seq` riêng | `seq` đã nằm trong Delivery |
| F10 | `openWithAuthorization(params, salt, auth, att, attSig)`; contract kiểm `auth.nonce` và `auth.value == cap` trước khi gọi USDC | Báo lỗi rõ (`NonceMismatch`, `AuthValueMismatch`) thay cho lỗi chung của USDC |
| F11 | Relay trả body dạng base64 trong JSON (`RelayResponse`); Voucher đi trong header `PAYMENT-SIGNATURE`; Delivery đi trong header `X-AgentPay-Delivery` | Giữ nguyên từng byte để `bodyHash` khớp |
| F12 | `requestHash`: method viết hoa, URL tuyệt đối đúng như người mua gửi | Hai bên băm ra cùng một kết quả |
| F13 | On-chain chặn `deliveryDeadlineSec` trong [1, 300] và `challengeWindowSec` trong [0, 86400] | Spec §4.1 |
| F14 | `sessionFee` mặc định $0,04 (`40000`), chỉ là số tạm cho tới khi đo gas ở H24 (D13) | — |

## 3. Cách làm việc sau khi chốt

- Làm trên nhánh riêng tách từ `build` (`a/escrow`, `b/verifier`, `c/core-hash`, `d/scorer`...) rồi mở PR vào `build`. CI phải xanh mới được merge.
- Sửa interface thì làm theo thứ tự: `forge build` → `pnpm --filter @agentpay/core gen:abi` → `gen:vectors` → `forge test` → `pnpm test`.
- Trong lúc chưa có contract thật, các package dùng mock dựng từ `abi.ts` và `api.ts`.
