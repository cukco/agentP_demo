# C8 · Demo AVAX trên AgentPay

## Chuẩn bị trước M4/H48

Build contract và các package một lần từ gốc repo. `pnpm --filter @agentpay-demo/buyer-agent... build` build cả hai demo và SDK. Chuẩn bị chung một deployment Fuji với Seller, Verifier relay, Facilitator, Scorer và Keeper. Seller và Buyer cần cùng Spec, `VERIFIER_URL`, `VERIFIER_ADDRESS` và `AGENTPAY_ESCROW`. Với Anvil dùng chain ID `43113` và địa chỉ Escrow/USDC của deployment local.

Điền môi trường qua shell hoặc `.env` ở gốc repo. Seller dùng `SELLER_PRIVATE_KEY`, `SELLER_AGENT_ID`, `FUJI_RPC_URL_1`, `AVAX_MAINNET_RPC_URL_1` và `DEMO_FAULT_TOKEN`. Buyer dùng `SELLER_URL` đầy đủ đến `/v1/price/AVAX`, cùng token công tắc lỗi, `FACILITATOR_URL`, `SCORER_URL`, RPC và `BUYER_MAIN_ADDRESS`. Màn chính sách dùng `LOW_SCORE_SELLER_URL` và `BUYER_AUTO_PRIVATE_KEY`. Seller mặc định bind `127.0.0.1:4021`. Nếu Verifier chạy trên máy khác, cấu hình `HOST` và URL Seller mà Verifier truy cập được. Domain của cả hai Seller phải khớp hồ sơ ERC-8004.

Chuẩn bị trước luật Buyer, ví `buyer-main` trên Fuji, ví auto có AVAX và USDC, cùng Verifier đã active. Với ngưỡng mặc định `minScore = 30`, Seller đạt từ 30 điểm qua điều kiện điểm. Dùng Seller dưới 30 điểm cho ca `BadScore`. Với màn 1, D thực hiện `registerBuyer` trên dashboard theo §14.5. Phiên demo dùng cap 1 USDC, giá 0,01 USDC/request và cửa sổ khiếu nại 30 giây.

Agent 306 có khoảng 45–51 điểm trên Fuji (tháng 11/2026). Khi chạy demo, dùng điểm hiện tại từ Scorer để chọn Seller.

## Hai lệnh chạy

Chạy ở hai terminal từ gốc repo. Giữ terminal Buyer riêng tư vì nó hiển thị liên kết duyệt dùng một lần.

```powershell
pnpm --filter @agentpay-demo/seller-avax-price start
pnpm --filter @agentpay-demo/buyer-agent start -- --mode approve --calls 18 --scenario all
```

Dùng `--scenario injection --mode auto` để chạy riêng màn chính sách. Hai yêu cầu được mô phỏng qua `/verify` của Facilitator và không đến `/settle`. Buyer gửi giao dịch hủy authorization đã ký theo luồng auto, vì vậy ví auto cần AVAX trả gas. Không có USDC bị khóa nếu mô phỏng bị từ chối.

| Màn §14.5 | Nội dung để D chiếu |
|---|---|
| 0 | Slide vấn đề về x402 và chi phí ký quỹ từng request. |
| 1 | Dashboard đặt luật EOA 5 USDC/phiên, 10 USDC/ngày và `minScore = 30`. Buyer CLI đọc luật từ Escrow. |
| 2 | Mở liên kết ở terminal Buyer, đối chiếu cap 1 USDC rồi ký một lần trong MetaMask. Buyer in session ID. |
| 3 | Terminal và dashboard hiện 15 Receipt PASS, giá Seller, giá Chainlink kiểm lại và 0,01 USDC mỗi request. |
| 4 | Buyer bật công tắc lệch +20% từ request 16. Ba Receipt kế tiếp là `ORACLE_DEVIATION`, giá trị 0 USDC. Terminal chờ Verifier đóng và Keeper finalize. |
| 5 | Terminal in hash giao dịch mở, đóng và finalize, tiền Seller nhận, Buyer hoàn và phí. Event `FeedbackGiven` xác nhận feedback ERC-8004 đã ghi. Dashboard của D hiển thị điểm cập nhật. |
| 6 | Kịch bản auto mô phỏng cap 20 USDC và Seller dưới 30 điểm. Kết quả tương ứng `OverPerSession` và `BadScore`. |
| 7 | Terminal in gas đo từ receipt của các giao dịch phiên và giá trị tham chiếu `18 × 503.000 gas` theo SystemDesign. |

## Diễn tập H48–H50

Sau khi `forge build` trong `contracts/`, chạy test với `anvil` trong PATH hoặc `ANVIL_BIN` trỏ đến executable:

```powershell
pnpm --filter @agentpay-demo/buyer-agent... build
pnpm --filter @agentpay-demo/buyer-agent --filter @agentpay-demo/seller-avax-price test
```

Bài diễn tập Anvil local dùng hai demo, Buyer/Seller SDK, Facilitator và Escrow thật. Chainlink, Scorer, Verifier relay và phê duyệt ví dùng fixture. Kịch bản kiểm giá 25 thành 30, 15 PASS và 3 FAIL, tự đóng, `finalize`, feedback, số dư và hai mã từ chối policy. Lượt tích hợp M4 còn cần dashboard của D, service relay và Scorer của nhóm, Keeper đang chạy và lượt duyệt MetaMask thật. Khi diễn tập trên fork, ghi rõ môi trường trong video.
