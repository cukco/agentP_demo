# B backend — vận hành và bàn giao

## Chạy local

Node >=22.13, pnpm 10.30.3. Dùng các ví Fuji đã được cấu hình trong `.env`;
không đưa `.env` vào commit/image. Chạy từ root:

```sh
./scripts/run-all.sh /absolute/path/to/.env
```

Script build và chạy Verifier 8787, Facilitator 8786, Scorer 8788, Keeper.
Ctrl-C dừng cả nhóm; một service chết thì cả nhóm dừng để không demo với stack lỗi.
Mỗi tiến trình chỉ nhận khóa của vai trò đó. Mặc định chỉ lắng nghe loopback.
`AGENTPAY_RUNTIME_DIR` mặc định `.agentpay-runtime/`; giữ thư mục này qua lần chạy.
Khóa mã hóa body được tạo một lần tại `body-key` (0600) nếu chưa cung cấp
`VERIFIER_BODY_KEY`. Không xóa/đổi khóa khi còn DB; backup DB cùng khóa, tách khỏi Git.

Kiểm tra:

```sh
curl --fail http://127.0.0.1:8787/v1/health
curl --fail http://127.0.0.1:8786/supported
curl --fail http://127.0.0.1:8788/v1/health
```

Keeper không có HTTP endpoint. Kiểm tra process và JSON log của chu kỳ quét chain.
Verifier phát một dòng JSON cho mỗi receipt gồm `sessionId`, `seq`, `outcome`,
`reasonCode`, `sellerMs`, `verifierMs`, `totalMs`; không chứa body/header/khóa.
Bật `VERIFIER_ALLOW_PRIVATE_SELLERS=true` **chỉ cho demo local** khi Seller ở loopback.
Cấu hình Seller bằng `VERIFIER_URL=http://127.0.0.1:8787`; Buyer dùng thêm
`FACILITATOR_URL=http://127.0.0.1:8786`, `SCORER_URL=http://127.0.0.1:8788`.

## Triển khai VM (chuẩn bị sẵn, tạm hoãn theo yêu cầu người dùng)

Dùng `deploy/agentpay/env.example` làm mẫu cho env nằm ngoài repo (chmod 600).
Trỏ ba DNS hostname đến VM. Điền địa chỉ escrow/start block từ `DEPLOYMENTS.fuji`,
khóa đúng vai trò và `VERIFIER_BODY_KEY` riêng. Chạy:

```sh
docker compose --env-file /secure/agentpay.env -f deploy/agentpay/compose.yml up -d --build
docker compose --env-file /secure/agentpay.env -f deploy/agentpay/compose.yml ps
```

Một image cho bốn service; Caddy cấp HTTPS cho ba endpoint. Chỉ mở 80/443;
không publish cổng SQLite hoặc service nội bộ. Verifier, Scorer và Keeper có
volume riêng. Khởi động lại bằng `restart` giữ dữ liệu. Không dùng `down -v`
trừ khi chủ động muốn xóa toàn bộ dữ liệu. Chỉ chạy **một Verifier replica** trên
mỗi DB. Backup khi đã dừng service (gồm SQLite WAL/SHM nếu còn), bảo quản khóa mã hóa.

Trong lúc quay: kiểm health trước, theo dõi `close_retry`, `equivocation_retry`
và `expiry_close_overdue`; giữ AVAX gas cho Verifier/Facilitator/Keeper. Không tự
chuyển sang local khi các phiên public còn OPEN: hãy dùng cùng DB/khóa hoặc để
Seller/Keeper thực hiện đường khôi phục. Không sửa endpoint của spec cho phiên cũ
vì sẽ đổi specHash; thay endpoint chỉ áp dụng khi mở phiên mới.

Public hosting được tạm bỏ qua theo xác nhận của người dùng; cấu hình sẵn không
đồng nghĩa đã deploy hoặc đã được máy ngoài truy cập thành công.

## Kiểm thử và bằng chứng

```sh
pnpm --filter @agentpay/e2e exec playwright install chromium
pnpm --filter @agentpay/e2e... build
forge build --root contracts
pnpm --filter @agentpay/e2e test:anvil
```

Bộ test có 10 kịch bản D và 2 ca B6 bổ sung (đóng rỗng đồng thời, đóng trước hạn).
Muốn chạy smoke test có giao dịch **Fuji testnet**, dùng các ví demo đã cấp token,
khởi động stack local và bật `VERIFIER_ALLOW_PRIVATE_SELLERS=true`, rồi:

```sh
FUJI_WRITE_TEST=1 FUJI_REPORT=/absolute/path/fuji-smoke.json \
  pnpm --filter @agentpay/e2e exec tsx scripts/fuji-backend-smoke.ts /absolute/path/.env
```

Smoke này dùng Seller SDK dạng file để kiểm chữ ký/hash, Buyer ở auto mode,
Scorer/Facilitator/Verifier/Keeper thật, USDC và registry Fuji thật. Cap 1 USDC test;
15 PASS + 3 FAIL. Phí lấy từ snapshot phiên trên chain; deployment Fuji hiện có
phí phiên 0,05 USDC test, khác mặc định Anvil 0,04. Không đổi policy hay metadata
của ví/agent. Trước lần mở phiên đầu, đợi Scorer hoàn tất quét lịch sử (gọi endpoint
score); RPC dự phòng xử lý giới hạn range của RPC chính. Những lần sau chỉ quét
lại tail 64 block và phần mới, vẫn đối chiếu count với registry trước khi ký.

`verifierMs = totalMs − sellerMs`; `sellerMs` bao gồm cả việc lấy 402 Spec lần đầu
(`discoveryMs`) và delivery có thanh toán. Mẫu benchmark có cả request đầu tiên;
không loại request chậm khỏi p95. Kết quả local/Fuji là phép đo trên một máy và RPC
cụ thể, không phải cam kết SLA cho hạ tầng public chưa triển khai.

Đo trên bản đang chạy (Fly, vùng `sin`) từ chính log `relay` của Verifier:

```sh
flyctl logs -a agentpay-verifier --no-tail | node scripts/latency-report.mjs          # bảng p50/p95/max
flyctl logs -a agentpay-verifier --no-tail | node scripts/latency-report.mjs --json   # cho slide 5
```

Script bỏ dòng trùng `(sessionId, seq)` và không loại request chậm. `flyctl logs --no-tail`
chỉ trả phần log gần nhất, nên chạy ngay sau một lượt E2E Fuji.
