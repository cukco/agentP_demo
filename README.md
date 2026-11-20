# AgentPay — không đạt thì không trả, cho AI agent

**Nhóm GlobalHost · BK Fintech Hackday S15 · chạy thật trên Avalanche Fuji**

AgentPay cho AI agent tự trả tiền khi gọi API trả phí (x402), nhưng **chỉ trả cho kết quả đạt kiểm định** và **luôn nằm trong luật chi tiêu do con người đặt trên chain**.

- **Ký quỹ theo phiên:** khóa USDC một lần, mỗi request trả bằng Voucher ký off-chain. 18 request chỉ cần 3 giao dịch (~0,66M gas, ít hơn ~93% so với ký quỹ từng lệnh).
- **Kiểm định từng kết quả:** Verifier kiểm mọi phản hồi (ví dụ so giá với Chainlink) và ký Receipt. PASS mới tính tiền, FAIL là 0 đồng; Keeper tự chốt phiên và hoàn phần thừa.
- **Luật chi tiêu on-chain:** hạn mức mỗi phiên, mỗi ngày, điểm uy tín tối thiểu của bên bán, nút dừng khẩn cấp. Agent không tự nới được, kể cả khi bị prompt injection.
- **Uy tín ERC-8004:** mỗi phiên ghi feedback on-chain; Scorer chấm điểm 0–100 để agent chọn bên bán đáng tin.
- **Mọi AI dùng được qua MCP:** Claude, Cursor, VS Code Copilot, Gemini CLI, Codex CLI…

## Bản demo đang chạy

| | |
|---|---|
| Seller AVAX (agent ERC-8004 #306) | `https://agentpay-seller.fly.dev/v1/price/AVAX` |
| Seller điểm thấp (#337, để thấy `BadScore`) | `https://agentpay-low-seller.fly.dev/v1/price/AVAX` |
| Verifier (+ Keeper) · Facilitator · Scorer | `https://agentpay-verifier.fly.dev/v1` · `https://agentpay-facilitator.fly.dev` · `https://agentpay-scorer.fly.dev` |
| Escrow (đã verify) | [`0xEbBE6E2cCE97a6C2Cb93563936b5846481C942ac`](https://testnet.snowtrace.io/address/0xEbBE6E2cCE97a6C2Cb93563936b5846481C942ac) |

Gọi Seller không kèm thanh toán sẽ nhận HTTP 402 có Spec kiểm định.

## Bắt đầu nhanh (5 phút, không cần Foundry hay `.env`)

Cần Git, Node.js 22.13+, pnpm 10 (`npm i -g pnpm@10`).

**1. Cài và tạo ví agent**

```bash
git clone https://github.com/cukco/agentP_demo.git agentpay && cd agentpay
pnpm install --frozen-lockfile
pnpm agentpay:build
pnpm agentpay:wallet     # tạo ví agent (lưu ở ~/.agentpay/agent-wallet.key, chỉ dùng testnet), in địa chỉ ví
```

**2. Nạp tiền test cho ví agent**
- **USDC ≥ 1** tại [faucet.circle.com](https://faucet.circle.com) (chọn Avalanche Fuji) — để agent trả tiền.
- **~0,01 AVAX** tại [faucet Fuji](https://build.avax.network/console/primary-network/faucet) — chỉ cần nếu đặt luật ở bước 3.

```bash
pnpm agentpay:check      # phải ra "Sẵn sàng"
```

**3. Con người đặt luật chi tiêu cho agent (khuyên dùng)**

```bash
pnpm agentpay:rules -- --admin 0xVÍ_CỦA_BẠN --per-session 5 --daily 10 --min-score 30
pnpm agentpay:rules      # xem luật hiện tại
```

| Tham số | Ý nghĩa |
|---|---|
| `--admin` | Ví của bạn (MetaMask), **khác ví agent**. Chỉ ví admin được sửa luật về sau. |
| `--per-session` | Tối đa USDC mỗi phiên (≤ 20) |
| `--daily` | Tối đa USDC mỗi 24 giờ |
| `--min-score` | Điểm uy tín tối thiểu của bên bán (0–100) |

Chưa đặt luật thì Escrow chỉ áp luật mặc định (tối đa 20 USDC/phiên, không kiểm điểm uy tín). Muốn đặt luật bằng MetaMask thay vì terminal: xem [docs/MCP.md](docs/MCP.md#4-con-người-đặt-luật-cho-agent).

**4. Nối vào AI và thử**

```bash
claude mcp add agentpay -- node <đường dẫn mcp.js mà agentpay:wallet in ra>
claude
```

- *"Dùng agentpay mua giá AVAX từ https://agentpay-seller.fly.dev/v1/price/AVAX và cho tôi xem receipt"* → Receipt **PASS**, 0,01 USDC.
- *"Mua từ https://agentpay-low-seller.fly.dev/v1/price/AVAX"* → bị luật chặn: `rule: BadScore`, không mất đồng nào.
- *"Đóng phiên agentpay và kiểm tra ví"* → Keeper chốt, phần thừa hoàn về ví.

Cấu hình cho Cursor, VS Code Copilot, Gemini CLI, Codex CLI: [docs/MCP.md](docs/MCP.md#2-nối-vào-ai).

**5. Theo dõi và quản lý trên Dashboard**

```bash
pnpm agentpay:dashboard  # mở http://127.0.0.1:5173
```

- **Luật người mua:** nhập địa chỉ ví agent → Xem luật. Kết nối **ví admin** để **siết luật** (hiệu lực ngay), **đề xuất nới luật** (áp dụng sau 24 giờ) hoặc **dừng người mua** khẩn cấp.
- **Theo dõi phiên:** chọn session ID → từng request PASS/FAIL, số dư hai bên, điểm uy tín bên bán, giao dịch on-chain có link Snowtrace.

## Cách hoạt động

```
Agent ──402──▶ Seller            (báo giá + Spec kiểm định)
Agent ──mở phiên──▶ Escrow        (kiểm luật người mua + điểm uy tín, khóa USDC)
Agent ──Voucher──▶ Verifier ──▶ Seller ──▶ Verifier kiểm ──▶ Receipt PASS/FAIL
Verifier đóng phiên ──▶ cửa sổ khiếu nại ──▶ Keeper chốt: Seller nhận phần PASS, Agent được hoàn phần dư, feedback ERC-8004
```

Chi tiết thiết kế: [AgentPay_SystemDesign.md](AgentPay_SystemDesign.md) · định dạng 402 và Spec: [AgentPay_VerificationSpec.md](AgentPay_VerificationSpec.md).

## Dành cho nhà phát triển: build và test toàn bộ

Cần Git, Node.js 22.13 trở lên, pnpm 10.30.3 và Foundry 1.9.0. Thêm `forge` và `anvil` vào PATH. Playwright cần Chromium hoặc một bản Chrome/Edge đã cài.

Repo này là bản công khai của AgentPay, chụp từ tag `v0.1.0-demo` (không kèm lịch sử commit và khóa ví). Chạy các lệnh sau bằng PowerShell.

```powershell
git clone https://github.com/cukco/agentP_demo.git agentpay
Set-Location agentpay
git submodule update --init --recursive
git clone --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std contracts/lib/forge-std
pnpm install --frozen-lockfile
forge build --root contracts
pnpm --filter @agentpay-demo/buyer-agent... --filter @agentpay/mcp... build
```

Clone `forge-std` ở lần thiết lập đầu tiên. Trên Windows có thể dùng `pnpm.cmd` nếu PowerShell chặn `pnpm.ps1`. Dùng `ANVIL_BIN` nếu Anvil nằm ngoài PATH. Các bài test SDK khởi tạo ví và Escrow Anvil riêng. Chạy các bộ kiểm thử Seller, Buyer, MCP và demo.

```powershell
pnpm --filter @agentpay/core --filter @agentpay/seller --filter @agentpay/buyer --filter @agentpay/mcp --filter @agentpay-demo/seller-avax-price --filter @agentpay-demo/buyer-agent test
```

Để kiểm riêng trang duyệt bằng trình duyệt, xem [lệnh Playwright của Buyer](packages/agentpay-buyer/README.md#bàn-giao-h40-cho-d). Để chạy hai process demo với môi trường đã cấu hình, xem [kịch bản AVAX](demo/README.md).

Tự chạy Buyer hoặc E2E trên Fuji với ví riêng: `Copy-Item .env.example .env`, điền khóa ví test, rồi `pnpm --filter @agentpay/e2e test:fuji` ([E2E](packages/agentpay-e2e/README.md)) hoặc demo ở [kịch bản AVAX](demo/README.md).

## Tích hợp SDK

- [Seller trong 5 dòng với Hono](packages/agentpay-seller/README.md).
- [Buyer `auto`, `approve`, đăng ký chính sách và cài đặt an toàn](packages/agentpay-buyer/README.md).
- [MCP cho mọi AI: cài trong 5 phút](docs/MCP.md) · [chi tiết tool MCP](packages/agentpay-mcp/README.md).

## Dựa trên PayCrow (MIT)

AgentPay kế thừa PayCrow của Miguel Castellano. Các contract PayCrow gốc nằm trong `contracts/src/PayCrow*.sol` và giữ nguyên thông báo SPDX MIT. Các package PayCrow gốc tiếp tục khai báo MIT trong metadata. [Mã nguồn PayCrow](https://github.com/michu5696/paycrow) · [Thông báo giấy phép của tác giả](https://dev.to/michu5696/add-escrow-protection-to-any-x402-agent-payment-in-5-minutes-1n0b)
